import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { createLiveOspexAdapter, type CancelOnchainResult, type Hex, type OspexAdapter, type Signer } from '../ospex/index.js';
import { StateStore, emptyMakerState, type MakerCommitmentRecord, type MakerState } from '../state/index.js';
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

const SIGNER_ADDRESS = '0x9999999999999999999999999999999999999999' as Hex;

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

/** Build a maker-commitment record at `postedAtUnixSec`; everything else defaulted. */
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
    lifecycle: 'visibleOpen',
    expiryUnixSec: postedAtUnixSec + 600,
    postedAtUnixSec,
    updatedAtUnixSec: postedAtUnixSec,
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

/** Common deps — fixed clock, fake signer unlock, silenced log, no prior telemetry by default. */
const baseDeps = (): Parameters<typeof runCancelStale>[1] => ({
  unlockSigner: () => Promise.resolve(fakeSigner()),
  createLiveAdapter: liveAdapter,
  env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' },
  now: () => T0,
  makeRunId: () => 'cs-run',
  hasPriorTelemetry: () => false,
  log: () => {},
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

// ── boot-time state-loss fail-safe (DESIGN §12 / Hermes review-PR30 blocker #2) ─

describe('runCancelStale — state-loss fail-safe', () => {
  it('fresh state + prior telemetry exists → CancelStaleRefused (the prior softCancelled set is gone — refusing protects the state-loss signal a subsequent run --live boot needs); no signer unlock attempted; no state file written', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    await expect(runCancelStale(
      { config: liveConfig(), authoritative: false, ignoreMissingState: false },
      { ...baseDeps(), unlockSigner, hasPriorTelemetry: () => true },
    )).rejects.toMatchObject({ name: 'CancelStaleRefused', message: expect.stringMatching(/--ignore-missing-state/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
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

  it('stale partiallyFilled records are included — pulled off-chain, reclassified to softCancelled, filledRiskWei6 preserved (Hermes review-PR30 blocker #1)', async () => {
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
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 1 });
    expect(captured!.cancelCommitmentOffchain).toHaveBeenCalledWith('0xpf');
    const state = StateStore.at(stateDir).load().state;
    expect(state.commitments['0xpf']!.lifecycle).toBe('softCancelled');
    // Crucial: the partial-fill record's filledRiskWei6 must be preserved across the lifecycle stamp.
    expect(state.commitments['0xpf']!.filledRiskWei6).toBe('50');
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
    expect(captured!.cancelCommitmentOnchain).toHaveBeenCalledWith('0xaa');
    expect(StateStore.at(stateDir).load().state.commitments['0xaa']!.lifecycle).toBe('authoritativelyInvalidated');
  });

  it('--authoritative + a stale partiallyFilled record → off-chain → softCancelled → on-chain → authoritativelyInvalidated; filledRiskWei6 preserved through both stamps (Hermes review-PR30 blocker #1)', async () => {
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
    expect(report).toMatchObject({ inspected: 1, offchainCancelled: 1, onchainCancelled: 1, errored: 0 });
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
    inspected: 0, offchainCancelled: 0, offchainSkippedAlready: 0, onchainCancelled: 0,
    gasDenied: 0, errored: 0, gasPolWei: '0', runId: 'r',
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
