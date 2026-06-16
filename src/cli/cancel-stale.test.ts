import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { createLiveOspexAdapter, type CancelOnchainResult, type Hex, type OspexAdapter, type Signer } from '../ospex/index.js';
import { STATE_LOCK_FILE, StateLockError, StateStore, emptyMakerState, type MakerCommitmentRecord, type MakerSignedPayload, type MakerState, type StateLock, type StateLockIdentity } from '../state/index.js';
import { CancelStaleRefused, cancelStaleExitCode, runCancelStale, type CancelStaleReport } from './cancel-stale.js';

// ── harness ──────────────────────────────────────────────────────────────────

let stateDir: string;
let logDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ospex-mm-cancel-stale-state-'));
  logDir = mkdtempSync(join(tmpdir(), 'ospex-mm-cancel-stale-log-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Fixed clock so `staleAfterSeconds` math is deterministic. */
const T0 = 1_900_000_000;

// Deliberately MIXED-CASE (checksummed-style, as a real `signer.getAddress()` returns) so the
// maker stamp + the maker-scoped state-loss match both exercise the telemetry layer's
// lowercase-normalization — a live maker that didn't match its own lowercased logs would
// silently break the scope.
const SIGNER_ADDRESS = '0xaBcDeF0123456789AbCdEf0123456789aBcDeF01' as Hex;

function fakeSigner(): Signer {
  return {
    getAddress: () => Promise.resolve(SIGNER_ADDRESS),
    signTypedData: () => Promise.resolve('0xsig' as Hex),
    signTransaction: () => Promise.resolve('0xtx' as Hex),
  };
}

/** A config in live posture with a keystore path that's never actually decrypted (the deps inject a fake signer). */
function liveConfig(overrides: Record<string, unknown> = {}): Config {
  const keystorePath = join(stateDir, 'ks.json');
  writeFileSync(keystorePath, '{}', 'utf8'); // never decrypted — `unlockSigner` is faked
  return parseConfig({
    rpcUrl: 'http://localhost:8545',
    telemetry: { logDir },
    state: { dir: stateDir },
    mode: { dryRun: false },
    wallet: { keystorePath },
    killSwitchFile: join(stateDir, 'KILL'),
    ...overrides,
  });
}

/** A signed adapter whose `cancelCommitmentOffchain` resolves and `cancelCommitmentOnchain` rejects loudly by default. Tests override per spy as needed. */
function liveAdapter(config: Config, signer: Signer): OspexAdapter {
  const adapter = createLiveOspexAdapter(config, signer);
  vi.spyOn(adapter, 'cancelCommitmentOffchain').mockResolvedValue();
  vi.spyOn(adapter, 'cancelCommitmentOnchain').mockRejectedValue(new Error('cancelCommitmentOnchain not stubbed for this test'));
  return adapter;
}

/**
 * Synthesize a structurally-valid {@link MakerSignedPayload} for `hash` (own-state
 * SSE plan §M6) — used in tests that exercise the present-payload cancel
 * dispatch. The bigint-encoded fields are decimal strings; content matches the
 * fixture record's protocol-tuple defaults closely enough that an SDK
 * `cancelOnchainSigned` call would hash back consistently in a real harness.
 * The MM's cancel paths just pass the payload through, so fidelity beyond
 * structural validity isn't exercised here.
 */
function stubSignedPayload(hash: string): MakerSignedPayload {
  return {
    commitmentHash: hash,
    commitment: {
      maker: '0x'.padEnd(42, 'a'),
      contestId: '1',
      scorer: '0xscorer',
      lineTicks: 0,
      positionType: 0,
      oddsTick: 200,
      riskAmount: '100',
      nonce: '1',
      expiry: '2000000000',
    },
    signature: '0x' + 'cc'.repeat(65),
  };
}

/**
 * Build a maker-commitment record at `postedAtUnixSec`; everything else
 * defaulted. M6/A — defaults to `signedPayloadStatus: 'present'` with a
 * synthesized {@link stubSignedPayload}, mirroring the M6/A submit path
 * (every live submit captures the canonical bundle). Tests that exercise
 * the migration / blocked-missing-payload path override `signedPayloadStatus`
 * to `'missing-legacy'` AND drop the `signedPayload` field.
 */
function rec(hash: string, postedAtUnixSec: number, overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'A',
    homeTeam: 'B',
    scorer: '0xscorer',
    makerSide: 'away',
    oddsTick: 200,
    riskAmountWei6: '100',
    filledRiskWei6: '0',
    signedPayloadStatus: 'present',
    signedPayload: stubSignedPayload(hash),
    lifecycle: 'visibleOpen',
    expiryUnixSec: postedAtUnixSec + 600,
    postedAtUnixSec,
    updatedAtUnixSec: postedAtUnixSec,
    // Phase 2 PR1 — fills[] defaults empty (poll-path cancel-stale doesn't append).
    fills: [],
    ...overrides,
  };
}

/** Persist a state pre-seeded with `records` to the temp state dir so `runCancelStale` can load it. */
function seedState(records: MakerCommitmentRecord[], overrides: Partial<MakerState> = {}): void {
  const state: MakerState = {
    ...emptyMakerState(),
    commitments: Object.fromEntries(records.map((r) => [r.hash, r])),
    ...overrides,
  };
  StateStore.at(stateDir).flush(state);
}

/** Read the NDJSON event-log for `runId` and return parsed lines. */
function readEvents(runId: string): { kind: string; [k: string]: unknown }[] {
  const path = join(logDir, `run-${runId}.ndjson`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string });
}

/** Common deps WITHOUT `hasPriorTelemetry` — so the real maker-scoped `eventLogsExist` runs against the temp `logDir` (the field is omitted, not set to `undefined`, per `exactOptionalPropertyTypes`). */
const baseDepsRealTelemetry = (): Parameters<typeof runCancelStale>[1] => ({
  unlockSigner: () => Promise.resolve(fakeSigner()),
  createLiveAdapter: liveAdapter,
  env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' },
  now: () => T0,
  makeRunId: () => 'cs-run',
  log: () => {},
});

/** Common deps — fixed clock, fake signer unlock, silenced log, no prior telemetry by default (injected fake). */
const baseDeps = (): Parameters<typeof runCancelStale>[1] => ({
  ...baseDepsRealTelemetry(),
  hasPriorTelemetry: () => false,
});

// ── refusals (preconditions) ─────────────────────────────────────────────────

describe('runCancelStale — refusals', () => {
  it('config.mode.dryRun=true → CancelStaleRefused; no signer unlock attempted', async () => {
    const unlockSigner = vi.fn();
    await expect(runCancelStale(
      { config: liveConfig({ mode: { dryRun: true } }), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/mode\.dryRun=true/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('no wallet.keystorePath → CancelStaleRefused', async () => {
    const cfg = parseConfig({
      rpcUrl: 'http://localhost:8545',
      telemetry: { logDir },
      state: { dir: stateDir },
      mode: { dryRun: false },
      killSwitchFile: join(stateDir, 'KILL'),
    });
    await expect(runCancelStale({ config: cfg, authoritative: false, ignoreMissingState: false }, baseDeps())).rejects.toMatchObject({
      name: 'CancelStaleRefused',
      message: expect.stringMatching(/keystorePath/) as unknown,
    });
  });

  it('env unset and prompt rejects (no TTY) → CancelStaleRefused with a clear hint about OSPEX_KEYSTORE_PASSPHRASE', async () => {
    const promptPassphrase = vi.fn(() => Promise.reject(new Error('stdin is not a TTY')));
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), env: {}, promptPassphrase },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/OSPEX_KEYSTORE_PASSPHRASE/) as unknown });
  });

  it('corrupt state file → CancelStaleRefused (operator must fix it first; we refuse to write blind); refuses BEFORE signer unlock', async () => {
    writeFileSync(join(stateDir, 'maker-state.json'), 'not valid json', 'utf8');
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/corrupt state/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled(); // refused before the (expensive) scrypt unlock
  });

  it('bad passphrase (unlock throws) → plain Error, not CancelStaleRefused (operational failure, surfaces as "cancel-stale failed: …")', async () => {
    const err = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner: () => Promise.reject(new Error('invalid password')) },
    ).then(() => null, (e: unknown): Error => e as Error);
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(CancelStaleRefused);
    expect(err!.message).toMatch(/invalid password/);
  });
});

// ── state.dir single-process lock (DESIGN §12 — shares run --live's lock) ─────

describe('runCancelStale — state.dir lock', () => {
  it('acquires the lock with the config/run identity (process label reflects --authoritative) and releases it', async () => {
    seedState([]); // a loaded-but-empty state so the command runs to completion
    const release = vi.fn();
    const acquireStateLock = vi.fn((_dir: string, _identity: StateLockIdentity): StateLock => ({ path: join(stateDir, STATE_LOCK_FILE), release }));
    await runCancelStale(
      { config: liveConfig(), configPath: '/etc/ospex-mm.yaml', authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), acquireStateLock },
    );
    expect(acquireStateLock).toHaveBeenCalledWith(stateDir, { maker: null, configPath: '/etc/ospex-mm.yaml', runId: 'cs-run', process: 'cancel-stale --authoritative' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a held lock (StateLockError) is surfaced as CancelStaleRefused — before the signer unlock, with no event log opened', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    const acquireStateLock = vi.fn(() => {
      throw new StateLockError('refusing to start: an MM is already running against this state.dir (pid 7 …).');
    });
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner, acquireStateLock },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/already running against this state\.dir/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled(); // refused before the (expensive) scrypt unlock
    expect(existsSync(join(logDir, 'run-cs-run.ndjson'))).toBe(false); // never opened the log / touched state
  });

  it('the real lock is taken + released across a run — a second cancel-stale succeeds, no lock left behind', async () => {
    seedState([]);
    await runCancelStale({ config: liveConfig(), authoritative: false, ignoreMissingState: false }, baseDeps());
    expect(existsSync(join(stateDir, STATE_LOCK_FILE))).toBe(false); // released
    await runCancelStale({ config: liveConfig(), authoritative: false, ignoreMissingState: false }, { ...baseDeps(), makeRunId: () => 'cs-run-2' });
    expect(existsSync(join(stateDir, STATE_LOCK_FILE))).toBe(false);
  });
});

// ── boot-time state-loss fail-safe (DESIGN §12 / Hermes review-PR30 blocker #2) ─

describe('runCancelStale — state-loss fail-safe', () => {
  it('fresh state + prior telemetry exists → CancelStaleRefused (the prior softCancelled set is gone — refusing protects the state-loss signal a subsequent run --live boot needs); unlocks once to resolve the maker for the scoped check; no state file written', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner, hasPriorTelemetry: () => true },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/--ignore-missing-state/) as unknown });
    // The state-loss check is scoped to THIS maker (so a sibling sharing telemetry.logDir
    // doesn't false-trip it), and a Foundry keystore only reveals the maker after the
    // unlock — so the signer IS unlocked once before the scoped check (matches the runner).
    expect(unlockSigner).toHaveBeenCalledTimes(1);
    // Crucial — must NOT have written an empty state file (that would erase the state-loss signal for the next runner boot).
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false);
  });

  it('fresh state + prior telemetry + --ignore-missing-state → proceeds (operator attestation lifts the hold; behaves like a genuine empty-state run)', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: true },
      { ...baseDeps(), unlockSigner, hasPriorTelemetry: () => true },
    );
    expect(unlockSigner).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ inspected: 0, errored: 0 });
    // With no prior state file and no records touched, we STILL must not flush a blank state (would erase the state-loss signal next boot).
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false);
  });

  it('fresh state + no prior telemetry → proceeds (genuine first run; nothing to do); does NOT write an empty state file', async () => {
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      baseDeps(), // hasPriorTelemetry: () => false
    );
    expect(report).toMatchObject({ inspected: 0, offchainCancelled: 0, runId: 'cs-run' });
    // The state file is NOT created on a fresh+no-prior-telemetry run — flushing one would not be harmful, but skipping it is the simpler invariant: a no-op cancel-stale leaves the state directory untouched.
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false);
  });

  it('loaded state + no stale records → flushes the (unchanged) state file (no signal-erasure risk; the file already existed)', async () => {
    seedState([rec('0xaa', T0 - 30)]); // not stale (30s old, staleAfterSeconds default 90)
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      baseDeps(),
    );
    expect(report).toMatchObject({ inspected: 0 });
    // The state file existed before and after; flushing refreshes lastFlushedAt.
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true);
  });

  it('dry-run synthetic hash in loaded state → CancelStaleRefused (mirrors the runner\'s live-mode ctor refusal); no signer unlock', async () => {
    seedState([rec('dry:run-1:0', T0 - 200)]);
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/dry-run synthetic commitment/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('fresh state + a SIBLING maker\'s run log in a shared telemetry.logDir → does NOT trip the hold (per-instance scope, via the REAL eventLogsExist); proceeds as a genuine first run', async () => {
    // The core of the Hermes blocker: a DIFFERENT maker's prior run log sharing this
    // telemetry.logDir must not force THIS fresh instance into the state-loss hold (that
    // would train operators to reach for --ignore-missing-state, defeating the fail-safe).
    // `hasPriorTelemetry: undefined` drops the injected fake so the real maker-scoped
    // eventLogsExist runs against the temp logDir; the fake signer's maker is SIGNER_ADDRESS.
    writeFileSync(
      join(logDir, 'run-sibling.ndjson'),
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', runId: 'sibling', maker: '0x1111111111111111111111111111111111111111', kind: 'tick-start' })}\n`,
      'utf8',
    );
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      baseDepsRealTelemetry(),
    );
    expect(report).toMatchObject({ inspected: 0, runId: 'cs-run' });
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false);
  });

  it('fresh state + THIS maker\'s own prior run log in telemetry.logDir → trips the hold (a genuine state loss for this wallet still holds)', async () => {
    // The other side of the scope: a prior run log for the SAME wallet, with the state
    // file gone, IS a real state loss (the prior softCancelled set is lost) → must hold.
    writeFileSync(
      join(logDir, 'run-prior.ndjson'),
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', runId: 'prior', maker: SIGNER_ADDRESS, kind: 'tick-start' })}\n`,
      'utf8',
    );
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      baseDepsRealTelemetry(),
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/--ignore-missing-state/) as unknown });
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false);
  });

  it('stamps every emitted telemetry line with the maker wallet (a shared telemetry.logDir is attributable per instance)', async () => {
    seedState([rec('0xstale', T0 - 200)]); // stale visibleOpen → off-chain cancelled → emits a soft-cancel line
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      baseDeps(),
    );
    expect(report.offchainCancelled).toBe(1);
    const lines = readEvents('cs-run');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.maker).toBe(SIGNER_ADDRESS.toLowerCase());
    }
  });
});

// ── happy paths — off-chain leg only ─────────────────────────────────────────

describe('runCancelStale — off-chain leg (default, no --authoritative)', () => {
  it('cancels every stale visibleOpen record off-chain; emits soft-cancel reason:"stale"; reclassifies to softCancelled; flushes state', async () => {
    seedState([
      rec('0xaa', T0 - 200), // stale: posted 200s ago, staleAfterSeconds default 90
      rec('0xbb', T0 - 200),
      rec('0xcc', T0 - 30), //  not stale: only 30s old
    ]);
    const adapterRef: { current: OspexAdapter | null } = { current: null };
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      const a = liveAdapter(cfg, signer);
      adapterRef.current = a;
      return a;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 2, offchainCancelled: 2, offchainSkippedAlready: 0, onchainCancelled: 0, gasDenied: 0, errored: 0, gasPolWei: '0' });
    expect(adapterRef.current!.cancelCommitmentOffchain).toHaveBeenCalledTimes(2);
    const events = readEvents('cs-run').filter((e) => e.kind === 'soft-cancel');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.reason === 'stale')).toBe(true);
    // State reflects the lifecycle changes.
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xaa']!.lifecycle).toBe('softCancelled');
    expect(state.commitments['0xbb']!.lifecycle).toBe('softCancelled');
    expect(state.commitments['0xcc']!.lifecycle).toBe('visibleOpen');
  });

  it('already-softCancelled stale records are counted in offchainSkippedAlready (the off-chain DELETE is a no-op for them) — no soft-cancel event emitted', async () => {
    seedState([
      rec('0xaa', T0 - 200, { lifecycle: 'softCancelled' }),
      rec('0xbb', T0 - 200), // visibleOpen — will be cancelled
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 2, offchainCancelled: 1, offchainSkippedAlready: 1, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).toHaveBeenCalledTimes(1);
    expect(captured!.cancelCommitmentOffchain).toHaveBeenCalledWith('0xbb');
    const events = readEvents('cs-run');
    expect(events.filter((e) => e.kind === 'soft-cancel')).toHaveLength(1);
  });

  it('a RECOVERED soft-cancel (softCancelled with filledRiskWei6 > 0 — soft-cancelled then matched on chain) is skipped off-chain like any softCancelled; lifecycle + the matched portion preserved', async () => {
    // PR2 keeps a soft-cancel that matched on chain as `softCancelled` with a converged filledRiskWei6 > 0.
    // cancel-stale must skip it off-chain (it's already off-book, and an off-chain DELETE would 409 on the matched
    // commitment) and not lose the matched portion. (Every other softCancelled test uses filledRiskWei6 '0'.)
    seedState([rec('0xrsc', T0 - 200, { lifecycle: 'softCancelled', filledRiskWei6: '60', riskAmountWei6: '100' })]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 0, offchainSkippedAlready: 1, offchainSkippedPartial: 0, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled(); // already off-book — no DELETE attempted (a matched commitment would 409)
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xrsc']!.lifecycle).toBe('softCancelled'); // unchanged — the latent remainder rides to expiry (or --authoritative)
    expect(state.commitments['0xrsc']!.filledRiskWei6).toBe('60'); // the matched portion is preserved (untouched)
    expect(readEvents('cs-run').filter((e) => e.kind === 'soft-cancel')).toHaveLength(0); // not re-soft-cancelled
  });

  it('stale partiallyFilled records are SKIPPED off-chain (the API rejects a DELETE once matched) — counted in offchainSkippedPartial, lifecycle + filledRiskWei6 preserved', async () => {
    seedState([
      rec('0xpf', T0 - 200, { lifecycle: 'partiallyFilled', filledRiskWei6: '50', riskAmountWei6: '100' }),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 0, offchainSkippedPartial: 1, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled(); // off-chain DELETE never attempted for a matched commitment
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xpf']!.lifecycle).toBe('partiallyFilled'); // left in place — rides to expiry (or --authoritative on-chain cancel)
    expect(state.commitments['0xpf']!.filledRiskWei6).toBe('50'); // preserved (untouched)
    const events = readEvents('cs-run');
    expect(events.filter((e) => e.kind === 'soft-cancel')).toHaveLength(0); // not soft-cancelled
  });

  it('off-chain throw → counted in errored; lifecycle unchanged; emits error phase:"cancel"; continues to next record', async () => {
    seedState([
      rec('0xaa', T0 - 200),
      rec('0xbb', T0 - 200),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOffchain')
        .mockRejectedValueOnce(new Error('api 500'))
        .mockResolvedValue();
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 2, offchainCancelled: 1, errored: 1 });
    const events = readEvents('cs-run');
    expect(events.filter((e) => e.kind === 'error' && e.phase === 'cancel')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'soft-cancel')).toHaveLength(1);
    // The 0xaa record's lifecycle is unchanged (the cancel didn't land).
    expect(StateStore.at(stateDir).load().state.commitments['0xaa']!.lifecycle).toBe('visibleOpen');
    // The 0xbb record was cancelled and reclassified.
    expect(StateStore.at(stateDir).load().state.commitments['0xbb']!.lifecycle).toBe('softCancelled');
  });

  it('terminal lifecycles (filled / expired / authoritativelyInvalidated) are excluded from the stale set', async () => {
    seedState([
      rec('0xfi', T0 - 200, { lifecycle: 'filled', filledRiskWei6: '100' }),
      rec('0xex', T0 - 200, { lifecycle: 'expired' }),
      rec('0xai', T0 - 200, { lifecycle: 'authoritativelyInvalidated' }),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 0, offchainCancelled: 0, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled();
  });

  it('a non-terminal record already past expiry + grace is excluded from the stale set (dead on chain — nothing matchable to invalidate); a still-live stale record on the same run is still swept', async () => {
    // 0xexp: visibleOpen, posted T0-700 → expiry (postedAt+600) = T0-100, which is past
    //   now (T0) + the default orders.expiryReleaseGraceSeconds (60): isExpiredForRelease(T0-100, T0, 60)
    //   === true → excluded from the sweep (the runner's ageOut reclassifies it `expired` next tick).
    // 0xlive: visibleOpen, posted T0-200 → expiry T0+400, still in the future → swept as usual.
    seedState([
      rec('0xexp', T0 - 700),
      rec('0xlive', T0 - 200),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    // Only the still-live record is inspected + cancelled; the already-expired one never enters the set.
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 1, errored: 0, blockedMissingPayload: 0 });
    expect(captured!.cancelCommitmentOffchain).toHaveBeenCalledTimes(1);
    expect(captured!.cancelCommitmentOffchain).toHaveBeenCalledWith('0xlive');
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xexp']!.lifecycle).toBe('visibleOpen'); // untouched — no off-chain DELETE / gas spent
    expect(state.commitments['0xlive']!.lifecycle).toBe('softCancelled');
  });
});

// ── --authoritative — on-chain leg ───────────────────────────────────────────

describe('runCancelStale — --authoritative (on-chain leg)', () => {
  /** Fake `cancelCommitmentOnchain` resolution — small gas spend per call. */
  const onchainOk = (txHash: string): CancelOnchainResult => ({
    txHash: txHash as Hex,
    commitmentHash: '0xdeadbeef' as Hex,
    receipt: { gasUsed: 100_000n, effectiveGasPrice: 30_000_000_000n } as unknown as CancelOnchainResult['receipt'],
  });

  it('off-chain + on-chain land per record; lifecycles → authoritativelyInvalidated; emits soft-cancel + onchain-cancel; accumulates gas into dailyCounters', async () => {
    seedState([
      rec('0xaa', T0 - 200),
      rec('0xbb', T0 - 200),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain')
        .mockResolvedValueOnce(onchainOk('0xtxA'))
        .mockResolvedValueOnce(onchainOk('0xtxB'));
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 2, offchainCancelled: 2, onchainCancelled: 2, gasDenied: 0, errored: 0 });
    // Each call: gasUsed × effectiveGasPrice = 100_000 × 30 gwei = 3e15 wei = 0.003 POL; two calls = 6e15.
    expect(report.gasPolWei).toBe('6000000000000000');

    const events = readEvents('cs-run');
    expect(events.filter((e) => e.kind === 'soft-cancel')).toHaveLength(2);
    const onchainEvents = events.filter((e) => e.kind === 'onchain-cancel');
    expect(onchainEvents).toHaveLength(2);
    expect(onchainEvents.map((e) => e.txHash).sort()).toEqual(['0xtxA', '0xtxB']);

    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xaa']!.lifecycle).toBe('authoritativelyInvalidated');
    expect(state.commitments['0xbb']!.lifecycle).toBe('authoritativelyInvalidated');
    // dailyCounters has the accumulated gas (UTC date = 2030-04-15 for T0 = 1_900_000_000).
    const today = new Date(T0 * 1000).toISOString().slice(0, 10);
    expect(state.dailyCounters[today]?.gasPolWei).toBe('6000000000000000');
  });

  it('--authoritative + an already-softCancelled stale record → off-chain is skipped, on-chain still runs (record → authoritativelyInvalidated)', async () => {
    seedState([rec('0xaa', T0 - 200, { lifecycle: 'softCancelled' })]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain').mockResolvedValueOnce(onchainOk('0xtx'));
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 0, offchainSkippedAlready: 1, onchainCancelled: 1, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled();
    // M6/A — the default fixture has `signedPayloadStatus: 'present'`, so
    // dispatch routes through the canonical signed-payload path (`{ signedCommitment }`).
    expect(captured!.cancelCommitmentOnchain).toHaveBeenCalledWith(
      expect.objectContaining({ signedCommitment: expect.objectContaining({ commitmentHash: '0xaa' }) }),
    );
    expect(StateStore.at(stateDir).load().state.commitments['0xaa']!.lifecycle).toBe('authoritativelyInvalidated');
  });

  it('--authoritative + a RECOVERED soft-cancel (softCancelled, filledRiskWei6 > 0) → off-chain skipped → on-chain cancel kills the still-matchable remainder → authoritativelyInvalidated; matched portion preserved', async () => {
    seedState([rec('0xrsc', T0 - 200, { lifecycle: 'softCancelled', filledRiskWei6: '60', riskAmountWei6: '100' })]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain').mockResolvedValueOnce(onchainOk('0xtx'));
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 0, offchainSkippedAlready: 1, onchainCancelled: 1, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled(); // already off-book
    // M6/A — present payload → signed-cancel path (the captured bundle works
    // for book-hidden softCancelled rows; the public-fetch fallback would
    // be refused via M2 redaction).
    expect(captured!.cancelCommitmentOnchain).toHaveBeenCalledWith(
      expect.objectContaining({ signedCommitment: expect.objectContaining({ commitmentHash: '0xrsc' }) }),
    );
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xrsc']!.lifecycle).toBe('authoritativelyInvalidated');
    expect(state.commitments['0xrsc']!.filledRiskWei6).toBe('60'); // the matched portion is preserved
  });

  it('--authoritative + a stale partiallyFilled record → SKIPPED off-chain (rejected once matched) → on-chain → authoritativelyInvalidated; filledRiskWei6 preserved', async () => {
    seedState([rec('0xpf', T0 - 200, { lifecycle: 'partiallyFilled', filledRiskWei6: '40', riskAmountWei6: '100' })]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain').mockResolvedValueOnce(onchainOk('0xtx'));
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 0, offchainSkippedPartial: 1, onchainCancelled: 1, errored: 0 });
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled(); // off-chain DELETE never attempted for the matched commitment
    // M6/A — present payload → signed-cancel path; the partiallyFilled remainder is killed authoritatively.
    expect(captured!.cancelCommitmentOnchain).toHaveBeenCalledWith(
      expect.objectContaining({ signedCommitment: expect.objectContaining({ commitmentHash: '0xpf' }) }),
    );
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xpf']!.lifecycle).toBe('authoritativelyInvalidated');
    expect(state.commitments['0xpf']!.filledRiskWei6).toBe('40');
  });

  it('--authoritative + on-chain throw → counted in errored; lifecycle stays at softCancelled; continues to next record', async () => {
    seedState([
      rec('0xaa', T0 - 200),
      rec('0xbb', T0 - 200),
    ]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain')
        .mockRejectedValueOnce(new Error('revert: nonce-too-low'))
        .mockResolvedValueOnce(onchainOk('0xtxB'));
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    expect(report).toMatchObject({ inspected: 2, offchainCancelled: 2, onchainCancelled: 1, errored: 1 });
    const events = readEvents('cs-run');
    expect(events.filter((e) => e.kind === 'error' && e.phase === 'onchain-cancel')).toHaveLength(1);
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xaa']!.lifecycle).toBe('softCancelled'); // off-chain step landed; on-chain failed; stays at the post-off-chain state
    expect(state.commitments['0xbb']!.lifecycle).toBe('authoritativelyInvalidated');
  });

  // ── M6/A pre-pass regression (Hermes #63) ──────────────────────────────────
  // A pre-M6/A record (`signedPayloadStatus: 'missing-legacy'`) that's still
  // `visibleOpen` must be on-chain-cancelled BEFORE the off-chain leg DELETEs
  // it from the book. Without the pre-pass, the off-chain DELETE flips
  // `book_visible: false`, the SDK's later `cancelOnchain({ hash })` refuses
  // via M2 redaction, and the record bricks into BLOCKED.
  it('--authoritative + missing-legacy + visibleOpen → on-chain { hash } cancel runs in the PRE-PASS (before off-chain), record → authoritativelyInvalidated, off-chain DELETE never called', async () => {
    const legacy = rec('0xlegacy', T0 - 200, { signedPayloadStatus: 'missing-legacy' });
    delete legacy.signedPayload; // validator: 'missing-legacy' MUST not carry a payload
    seedState([legacy]);
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain').mockResolvedValueOnce({
        txHash: '0xprepasstx' as Hex,
        commitmentHash: '0xlegacy' as Hex,
        receipt: { gasUsed: 100_000n, effectiveGasPrice: 30_000_000_000n } as unknown as CancelOnchainResult['receipt'],
      });
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );

    expect(report).toMatchObject({ inspected: 1, onchainCancelled: 1, blockedMissingPayload: 0, gasDenied: 0, errored: 0 });
    // Off-chain DELETE was NEVER called — the pre-pass authoritatively invalidated the record FIRST.
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled();
    expect(report.offchainCancelled).toBe(0);
    // The on-chain cancel went through the `{ hash }` discriminant (not `{ signedCommitment }`)
    // because the record has no captured bundle — that's the whole migration-fallback point.
    expect(captured!.cancelCommitmentOnchain).toHaveBeenCalledWith({ hash: '0xlegacy' });
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xlegacy']!.lifecycle).toBe('authoritativelyInvalidated');
    // The blocked-missing-payload event must NOT fire — the pre-pass intercepted the record BEFORE it could brick.
    expect(readEvents('cs-run').some((e) => e.kind === 'cancel-blocked-missing-payload')).toBe(false);
  });

  // Hermes #63 round 2: if pre-pass gas-denies on the FIRST candidate, every
  // OTHER missing-legacy + visibleOpen candidate must still get its off-chain
  // skip — otherwise the off-chain DELETE bricks them. The fix pre-populates
  // the touched set with ALL candidates upfront (not just attempted ones).
  it("--authoritative + TWO missing-legacy + visibleOpen + pre-pass gas-denied → BOTH records stay visibleOpen (touched-set protects later candidates too), off-chain DELETE never runs on either", async () => {
    const legacyA = rec('0xaaa', T0 - 200, { signedPayloadStatus: 'missing-legacy' });
    delete legacyA.signedPayload;
    const legacyB = rec('0xbbb', T0 - 200, { signedPayloadStatus: 'missing-legacy' });
    delete legacyB.signedPayload;
    seedState([legacyA, legacyB], {
      // Already at the daily cap so canSpendGas (mayUseReserve:true) denies on the FIRST attempt.
      dailyCounters: { [new Date(T0 * 1000).toISOString().slice(0, 10)]: { gasPolWei: '2000000000000000000', feeUsdcWei6: '0' } },
    });
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );

    // Pre-pass denied → cancel-stale exits before any on-chain cancel lands. Both
    // records stay visibleOpen — neither was off-chain-hidden, so a future run
    // (after the operator tops up POL) can still recover via the regular { hash }
    // path while they're still visible.
    expect(captured!.cancelCommitmentOnchain).not.toHaveBeenCalled();
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled();
    expect(report.onchainCancelled).toBe(0);
    expect(report.offchainCancelled).toBe(0);
    // Two denial events: one from the pre-pass first candidate, one from the
    // regular on-chain leg's first candidate (the regular leg doesn't skip
    // touched records — it preserves transient-throw retry semantics, see the
    // sibling test below). Both denials report the same gas state truthfully.
    expect(report.gasDenied).toBe(2);
    expect(report.blockedMissingPayload).toBe(0);
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xaaa']!.lifecycle).toBe('visibleOpen');
    expect(state.commitments['0xbbb']!.lifecycle).toBe('visibleOpen'); // ← THE KEY ASSERTION: NOT softCancelled, not bricked
  });

  it("--authoritative + missing-legacy + visibleOpen + pre-pass on-chain THROW → record stays visibleOpen (touched-set skip), regular on-chain leg retries via dispatch, off-chain DELETE never runs", async () => {
    const legacy = rec('0xlegacy', T0 - 200, { signedPayloadStatus: 'missing-legacy' });
    delete legacy.signedPayload;
    seedState([legacy]);
    let captured: OspexAdapter | null = null;
    let cancelCallCount = 0;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      vi.spyOn(captured, 'cancelCommitmentOnchain').mockImplementation(async () => {
        cancelCallCount += 1;
        if (cancelCallCount === 1) throw new Error('RPC blip');
        return {
          txHash: '0xretrytx' as Hex,
          commitmentHash: '0xlegacy' as Hex,
          receipt: { gasUsed: 100_000n, effectiveGasPrice: 30_000_000_000n } as unknown as CancelOnchainResult['receipt'],
        };
      });
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );

    // Pre-pass: cancel attempt #1 threw → counted in errored. The record was added to the touched
    // set BEFORE the attempt, so the off-chain DELETE skips it (preserves the migration fallback).
    // The regular on-chain leg then dispatches the still-`visibleOpen` record → `use-hash` →
    // attempt #2 succeeds → authoritativelyInvalidated.
    expect(cancelCallCount).toBe(2);
    expect(captured!.cancelCommitmentOffchain).not.toHaveBeenCalled(); // touched-skip preserved visibleOpen for the retry
    expect(report.errored).toBe(1); // pre-pass throw counted
    expect(report.onchainCancelled).toBe(1); // retry landed
    expect(StateStore.at(stateDir).load().state.commitments['0xlegacy']!.lifecycle).toBe('authoritativelyInvalidated');
  });

  it('--authoritative + gas-budget denial → emits candidate gas-budget-blocks-onchain-cancel and BREAKS the loop (subsequent records remain at softCancelled, today\'s spend only grows)', async () => {
    seedState([
      rec('0xaa', T0 - 200),
      rec('0xbb', T0 - 200),
    ], {
      // Pre-seed today's gas spend at the daily cap so canSpendGas (mayUseReserve:true) denies on the FIRST record.
      dailyCounters: { [new Date(T0 * 1000).toISOString().slice(0, 10)]: { gasPolWei: '2000000000000000000', feeUsdcWei6: '0' } }, // 2 POL, default cap is 1 POL
    });
    let captured: OspexAdapter | null = null;
    const createLiveAdapter = (cfg: Config, signer: Signer): OspexAdapter => {
      captured = liveAdapter(cfg, signer);
      return captured;
    };
    const report = await runCancelStale(
      { config: liveConfig(), authoritative: true, ignoreMissingState: false },
      { ...baseDeps(), createLiveAdapter },
    );
    // Off-chain still happened for both records.
    expect(report.offchainCancelled).toBe(2);
    // The on-chain loop denied immediately (gasDenied=1), broke, and never reached the second record.
    expect(report.gasDenied).toBe(1);
    expect(report.onchainCancelled).toBe(0);
    expect(captured!.cancelCommitmentOnchain).not.toHaveBeenCalled();
    const events = readEvents('cs-run');
    const denial = events.filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(denial).toHaveLength(1);
  });
});

// ── exit code policy (Hermes review-PR30 non-blocker hardening) ──────────────

describe('cancelStaleExitCode', () => {
  const baseReport: CancelStaleReport = {
    inspected: 0, offchainCancelled: 0, offchainSkippedAlready: 0, offchainSkippedPartial: 0, onchainCancelled: 0,
    gasDenied: 0, blockedMissingPayload: 0, errored: 0, gasPolWei: '0', runId: 'r',
  };
  it('clean run → 0', () => {
    expect(cancelStaleExitCode(baseReport)).toBe(0);
    expect(cancelStaleExitCode({ ...baseReport, inspected: 3, offchainCancelled: 3 })).toBe(0);
  });
  it('any errored → 1 (per-record write failed; automation needs to detect the incomplete cleanup)', () => {
    expect(cancelStaleExitCode({ ...baseReport, errored: 1 })).toBe(1);
  });
  it('any gasDenied → 1 (the on-chain leg stopped before completing)', () => {
    expect(cancelStaleExitCode({ ...baseReport, gasDenied: 1 })).toBe(1);
  });
});
