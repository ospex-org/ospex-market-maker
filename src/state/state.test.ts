import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import {
  assessStateLoss,
  COMMITMENT_LIFECYCLE_STATES,
  dispatchCancel,
  emptyMakerState,
  fillDedupKey,
  isTerminalPositionStatus,
  MAKER_POSITION_STATUSES,
  StateStore,
  TERMINAL_POSITION_STATUSES,
  toMakerSignedPayload,
  toSdkSignedPayload,
  type MakerCommitmentFill,
  type MakerCommitmentRecord,
  type MakerPositionRecord,
  type MakerSignedPayload,
  type MakerState,
} from './index.js';
import type { SignedCommitmentPayload } from '@ospex/sdk';

const STATE_FILE = 'maker-state.json';
const STATE_TMP = 'maker-state.json.tmp';

function commitment(overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  return {
    hash: '0xabc',
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    marketType: 'moneyline',
    lineTicks: 0,
    makerSide: 'away',
    oddsTick: 191,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    lifecycle: 'softCancelled',
    expiryUnixSec: 1_900_000_000,
    postedAtUnixSec: 1_899_999_880,
    updatedAtUnixSec: 1_899_999_900,
    // M6/A — default fixtures are 'missing-legacy' (no payload captured).
    // Tests that exercise the present-payload path override this field along
    // with `signedPayload`.
    signedPayloadStatus: 'missing-legacy',
    // Phase 2 PR1 — fills[] defaults empty; tests that exercise fill history
    // override with explicit entries.
    fills: [],
    ...overrides,
  };
}

function position(overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    marketType: 'moneyline',
    lineTicks: 0,
    side: 'away',
    riskAmountWei6: '250000',
    counterpartyRiskWei6: '150000',
    status: 'active',
    updatedAtUnixSec: 1_899_999_950,
    ...overrides,
  };
}

function stateWith(partial: Partial<MakerState> = {}): MakerState {
  return { ...emptyMakerState(), ...partial };
}

describe('StateStore.load', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports `fresh` (and an empty state) when no state file exists', () => {
    const { state, status } = StateStore.at(dir).load();
    expect(status).toEqual({ kind: 'fresh' });
    expect(state).toEqual(emptyMakerState());
  });

  it('round-trips a flushed state (commitments + positions) and reports `loaded`', () => {
    const store = StateStore.at(dir);
    const c = commitment();
    const p = position();
    store.flush(stateWith({ lastRunId: 'r1', commitments: { [c.hash]: c }, positions: { 'spec-1:away': p }, pnl: { realizedUsdcWei6: '-5', unrealizedUsdcWei6: '12', asOfUnixSec: 100 } }));

    const { state, status } = store.load();
    expect(status).toEqual({ kind: 'loaded' });
    expect(state.lastRunId).toBe('r1');
    expect(state.commitments['0xabc']).toEqual(c);
    expect(state.commitments['0xabc']?.sport).toBe('mlb');
    expect(state.positions['spec-1:away']).toEqual(p);
    expect(state.pnl).toEqual({ realizedUsdcWei6: '-5', unrealizedUsdcWei6: '12', asOfUnixSec: 100 });
    expect(typeof state.lastFlushedAt).toBe('string');
    expect(new Date(state.lastFlushedAt as string).getTime()).not.toBeNaN();
  });

  it('flushes atomically — no `.tmp` left behind, and the dir is created if missing', () => {
    const nested = join(dir, 'deep', 'state');
    const store = StateStore.at(nested);
    store.flush(emptyMakerState());
    expect(existsSync(join(nested, STATE_FILE))).toBe(true);
    expect(existsSync(join(nested, STATE_TMP))).toBe(false);
  });

  it('treats a non-JSON state file as `lost` (fail closed — never trust a garbled cache)', () => {
    writeFileSync(join(dir, STATE_FILE), '{ this is not json', 'utf8');
    const { status } = StateStore.at(dir).load();
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/not valid JSON/);
  });

  it('treats an unsupported state version as `lost`', () => {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...emptyMakerState(), version: 99 }), 'utf8');
    const { status } = StateStore.at(dir).load();
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/version/);
  });

  it('treats a state file missing a top-level section as `lost`', () => {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: 1 }), 'utf8');
    const { status } = StateStore.at(dir).load();
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/commitments/);
  });

  it('treats a malformed commitment record as `lost` (bad makerSide / out-of-range oddsTick / risk-not-a-decimal-string / filled>risk / hash≠key)', () => {
    const at = StateStore.at(dir);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ makerSide: 'sideways' as unknown as 'away' }) } })), 'utf8');
    let status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/makerSide/);

    // oddsTick below the protocol's MIN_ODDS (101) — out of the uint16 tick range
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ oddsTick: 50 }) } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/oddsTick/);

    // a number (or a hex string) where a decimal wei6 string is required
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ riskAmountWei6: 250000 as unknown as string }) } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/decimal string/);

    // a fill larger than the commitment is impossible — fail closed (a still-live such record would silently undercount latent exposure)
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ riskAmountWei6: '100000', filledRiskWei6: '200000' }) } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/exceeds riskAmountWei6/);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ hash: '0xdifferent' }) } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/does not match its key/);
  });

  it('treats a malformed position record as `lost` (bad side / missing team metadata)', () => {
    const at = StateStore.at(dir);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ positions: { 'spec-1:away': position({ side: 'sideways' as unknown as 'away' }) } })), 'utf8');
    let status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/side/);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ positions: { 'spec-1:away': { ...position(), homeTeam: undefined as unknown as string } } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/sport \/ awayTeam \/ homeTeam/);
  });

  it('treats an empty speculationId (the risk-engine group key) as `lost` — commitment and position', () => {
    const at = StateStore.at(dir);

    const c = commitment();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { [c.hash]: { ...c, speculationId: '' } } })), 'utf8');
    let status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/speculationId must be non-empty/);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ positions: { 'spec-1:away': { ...position(), speculationId: '' } } })), 'utf8');
    status = at.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/speculationId must be non-empty/);
  });

  it('a well-formed soft-cancelled commitment survives the round trip', () => {
    const store = StateStore.at(dir);
    const c = commitment({ lifecycle: 'softCancelled', riskAmountWei6: '100', filledRiskWei6: '0' });
    store.flush(stateWith({ commitments: { [c.hash]: c } }));
    const { state, status } = store.load();
    expect(status.kind).toBe('loaded');
    expect(state.commitments[c.hash]?.lifecycle).toBe('softCancelled');
    expect(state.commitments[c.hash]?.riskAmountWei6).toBe('100');
  });

  it('commitment marketType / lineTicks: a spread record round-trips, a pre-field record migrates to moneyline/0, an unknown marketType is `lost`', () => {
    const store = StateStore.at(dir);
    // (1) a non-moneyline record round-trips losslessly.
    const spread = commitment({ marketType: 'spread', lineTicks: -15 });
    store.flush(stateWith({ commitments: { [spread.hash]: spread } }));
    let loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.commitments[spread.hash]).toMatchObject({ marketType: 'spread', lineTicks: -15 });

    // (2) migration: a record from a pre-this-field state file (neither key present) loads
    //     as moneyline / 0 — every legacy record is moneyline — and is NOT `lost`.
    const legacy: Record<string, unknown> = { ...commitment() };
    delete legacy.marketType;
    delete legacy.lineTicks;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': legacy as unknown as MakerCommitmentRecord } })), 'utf8');
    loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.commitments['0xabc']).toMatchObject({ marketType: 'moneyline', lineTicks: 0 });

    // (3) an unknown marketType fails closed.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ marketType: 'parlay' as unknown as 'moneyline' }) } })), 'utf8');
    let status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/marketType/);

    // (4) a non-integer lineTicks fails closed too (the line is an integer tick count).
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ lineTicks: 1.5 }) } })), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/lineTicks/);

    // (5) the migration is PAIRED: a half-written record (exactly one of the two fields) is
    //     rejected rather than normalized to an inconsistent shape (spread/0 or moneyline/-15).
    const marketTypeOnly: Record<string, unknown> = { ...commitment({ marketType: 'spread', lineTicks: -15 }) };
    delete marketTypeOnly.lineTicks;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': marketTypeOnly as unknown as MakerCommitmentRecord } })), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/present together/);

    const lineTicksOnly: Record<string, unknown> = { ...commitment({ marketType: 'spread', lineTicks: -15 }) };
    delete lineTicksOnly.marketType;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': lineTicksOnly as unknown as MakerCommitmentRecord } })), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/present together/);

    // (6) moneyline has no line — a moneyline record with a non-zero lineTicks is inconsistent → lost.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ commitments: { '0xabc': commitment({ marketType: 'moneyline', lineTicks: -15 }) } })), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/moneyline/);
  });

  it('position marketType / lineTicks: a spread position round-trips, a pre-field record migrates to moneyline/0, a half-written one is `lost` (shared paired validator)', () => {
    const store = StateStore.at(dir);
    const spread = position({ marketType: 'spread', lineTicks: -15 });
    store.flush(stateWith({ positions: { 'spec-1:away': spread } }));
    let loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.positions['spec-1:away']).toMatchObject({ marketType: 'spread', lineTicks: -15 });

    // migration: neither field → moneyline / 0 (the same paired validator the commitments use).
    const legacy: Record<string, unknown> = { ...position() };
    delete legacy.marketType;
    delete legacy.lineTicks;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ positions: { 'spec-1:away': legacy as unknown as MakerPositionRecord } })), 'utf8');
    loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.positions['spec-1:away']).toMatchObject({ marketType: 'moneyline', lineTicks: 0 });

    // a half-written position (one of the pair) fails closed.
    const partial: Record<string, unknown> = { ...position({ marketType: 'spread', lineTicks: -15 }) };
    delete partial.lineTicks;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(stateWith({ positions: { 'spec-1:away': partial as unknown as MakerPositionRecord } })), 'utf8');
    const status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/present together/);
  });

  it('seedFeeBySpecKey: a populated map round-trips, a pre-field/pre-hashes state migrates, a malformed entry is `lost`', () => {
    const store = StateStore.at(dir);
    // (1) a populated map (with the bound seed-leg `hashes`) round-trips losslessly.
    store.flush(stateWith({ seedFeeBySpecKey: { 'seed:1:spread:-15': { feeUsdcWei6: '250000', charged: false, hashes: ['0xaa', '0xbb'] }, 'seed:2:total:75': { feeUsdcWei6: '250000', charged: true, hashes: ['0xcc'] } } }));
    let loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.seedFeeBySpecKey['seed:1:spread:-15']).toEqual({ feeUsdcWei6: '250000', charged: false, hashes: ['0xaa', '0xbb'] });
    expect(loaded.state.seedFeeBySpecKey['seed:2:total:75']).toEqual({ feeUsdcWei6: '250000', charged: true, hashes: ['0xcc'] });

    // (1b) a persisted entry predating the `hashes` field migrates to `hashes: []` (a marker
    //      with no bound leg can never charge — the conservative direction) and is NOT `lost`.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...stateWith({}), seedFeeBySpecKey: { 'seed:1:spread:-15': { feeUsdcWei6: '250000', charged: false } } }), 'utf8');
    loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.seedFeeBySpecKey['seed:1:spread:-15']).toEqual({ feeUsdcWei6: '250000', charged: false, hashes: [] });

    // (2) migration: a state file predating the field (no `seedFeeBySpecKey` key) loads with
    //     `{}` — no seeds tracked is the conservative default — and is NOT `lost`.
    const legacy: Record<string, unknown> = { ...stateWith({}) };
    delete legacy.seedFeeBySpecKey;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(legacy), 'utf8');
    loaded = store.load();
    expect(loaded.status.kind).toBe('loaded');
    expect(loaded.state.seedFeeBySpecKey).toEqual({});

    // (3) a malformed amount fails closed (money-tracking field — never trust a corrupt shape).
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...stateWith({}), seedFeeBySpecKey: { 'seed:1:spread:-15': { feeUsdcWei6: 'oops', charged: false } } }), 'utf8');
    let status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/seedFeeBySpecKey/);

    // (4) a non-boolean `charged` fails closed.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...stateWith({}), seedFeeBySpecKey: { 'seed:1:spread:-15': { feeUsdcWei6: '250000', charged: 'yes' } } }), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/seedFeeBySpecKey/);

    // (5) a non-object `seedFeeBySpecKey` value fails closed.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...stateWith({}), seedFeeBySpecKey: 'nope' }), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/seedFeeBySpecKey/);

    // (6) a malformed `hashes` (not a string[]) fails closed.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...stateWith({}), seedFeeBySpecKey: { 'seed:1:spread:-15': { feeUsdcWei6: '250000', charged: false, hashes: [1, 2] } } }), 'utf8');
    status = store.load().status;
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/seedFeeBySpecKey/);
  });

  // ── sensitive state hardening (own-state SSE plan §M6/B) ────────────────────
  //
  // The state blob now carries the maker's signed EIP-712 commitment payloads
  // (M6/A), so the on-disk file is created at 0o600 (owner read/write only)
  // from birth via O_WRONLY|O_CREAT|O_EXCL — not chmod'd after the fact. The
  // POSIX rename preserves the mode, so the live `maker-state.json` lands at
  // 0o600. Windows: mode bits don't map to ACLs — the test checks file
  // existence only; the actual ACL hardening on Windows is the operator's
  // responsibility via the parent directory (OPERATOR_SAFETY.md).
  it('flush writes the state file with mode 0o600 on POSIX (owner read/write only)', () => {
    const store = StateStore.at(dir);
    store.flush(emptyMakerState());
    const stats = statSync(store.statePath);
    if (platform === 'win32') {
      // On Windows, file mode bits don't carry the same meaning — just confirm
      // the file exists. The directory-ACL hardening is the operator's job.
      expect(existsSync(store.statePath)).toBe(true);
    } else {
      // The mode's bottom 9 bits are the perm bits. Mask out the file-type bits.
      // 0o777 mask isolates owner / group / other rwx bits.
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  // Hermes PR #64 round 1: pre-existing temp file with permissive mode must
  // NOT survive into the live state. The old chmod-after-write flow would
  // truncate the existing temp file (preserving its old mode) and then chmod
  // (or silently fail to). The new flow unlinks the stale temp first so the
  // O_EXCL create lands a fresh inode at 0o600.
  it('unlinks a stale temp file before fresh create — pre-existing 0o644 temp does not leak through (POSIX)', () => {
    if (platform === 'win32') return; // mode bits don't map; the leak path doesn't apply
    const store = StateStore.at(dir);
    // Pre-create the temp file at a permissive mode (simulating a prior crash
    // that left maker-state.json.tmp behind).
    writeFileSync(join(dir, STATE_TMP), '{"version":1}', { encoding: 'utf8', mode: 0o644 });
    expect(statSync(join(dir, STATE_TMP)).mode & 0o777).toBe(0o644);
    // Flush should unlink the stale temp + recreate at 0o600.
    store.flush(emptyMakerState());
    // The temp should be gone (renamed into statePath) and the live file at 0o600.
    expect(existsSync(join(dir, STATE_TMP))).toBe(false);
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
  });
});

// ── legacy ownStateCursor tolerance ──────────────────────────────────────────
//
// The retired `ownStateCursor` field (the pre-cold-restart-retirement resume
// cursor) may still appear in legacy state files. Like any other unknown key it
// must be TOLERATED — loaded state simply does not carry it, and crucially a
// legacy file carrying one must never mark the state `lost` (the fail-closed
// posture protects the under-countable soft-cancelled set, DESIGN §12, which a
// stale cursor has no bearing on).
describe('legacy ownStateCursor tolerance (own-state polling retirement, part 2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-cursor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a legacy state file carrying ownStateCursor loads clean (key ignored, state NOT lost, full state intact)', () => {
    const c = commitment();
    const p = position();
    const legacy = JSON.parse(
      JSON.stringify(stateWith({ lastRunId: 'r1', commitments: { [c.hash]: c }, positions: { 'spec-1:away': p } })),
    ) as Record<string, unknown>;
    legacy.ownStateCursor = 'evt-000123'; // the retired field, as an old flush would have written it
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(legacy), 'utf8');
    const { state, status } = StateStore.at(dir).load();
    expect(status.kind).toBe('loaded'); // NOT 'lost'
    expect('ownStateCursor' in state).toBe(false); // the key is simply not picked up
    expect(state.lastRunId).toBe('r1');
    expect(state.commitments['0xabc']).toEqual(c); // the rest of the state survives intact
  });

  it('a flushed state file no longer contains an ownStateCursor key', () => {
    const store = StateStore.at(dir);
    store.flush(stateWith({ lastRunId: 'r2' }));
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>;
    expect('ownStateCursor' in raw).toBe(false);
  });
});

describe('assessStateLoss (the boot-time fail-safe — DESIGN §12)', () => {
  const base = { hasPriorTelemetry: false, ignoreMissingStateOverride: false, expirySeconds: 120 };

  it('a clean load never holds quoting', () => {
    expect(assessStateLoss({ kind: 'loaded' }, base).holdQuoting).toBe(false);
    expect(assessStateLoss({ kind: 'loaded' }, { ...base, hasPriorTelemetry: true }).holdQuoting).toBe(false);
  });

  it('no state + no prior telemetry = genuine first run — does not hold quoting', () => {
    const a = assessStateLoss({ kind: 'fresh' }, base);
    expect(a.holdQuoting).toBe(false);
    expect(a.suggestedWaitSeconds).toBeUndefined();
    expect(a.reason).toMatch(/genuine first run/);
  });

  it('no state but prior telemetry = state loss — holds quoting, suggesting a one-expiry-window wait', () => {
    const a = assessStateLoss({ kind: 'fresh' }, { ...base, hasPriorTelemetry: true });
    expect(a.holdQuoting).toBe(true);
    expect(a.suggestedWaitSeconds).toBe(120);
    expect(a.reason).toMatch(/blank slate/);
  });

  it('a corrupt state file holds quoting regardless of prior telemetry', () => {
    for (const hasPriorTelemetry of [false, true]) {
      const a = assessStateLoss({ kind: 'lost', reason: 'bad json' }, { ...base, hasPriorTelemetry });
      expect(a.holdQuoting).toBe(true);
      expect(a.suggestedWaitSeconds).toBe(120);
      expect(a.reason).toMatch(/blank slate/);
    }
  });

  it('--ignore-missing-state lifts the hold on a missing-but-prior-run state and on a corrupt one', () => {
    const a1 = assessStateLoss({ kind: 'fresh' }, { ...base, hasPriorTelemetry: true, ignoreMissingStateOverride: true });
    expect(a1.holdQuoting).toBe(false);
    expect(a1.suggestedWaitSeconds).toBeUndefined();
    expect(a1.reason).toMatch(/ignore-missing-state/);

    const a2 = assessStateLoss({ kind: 'lost', reason: 'bad json' }, { ...base, ignoreMissingStateOverride: true });
    expect(a2.holdQuoting).toBe(false);
    expect(a2.reason).toMatch(/ignore-missing-state/);
  });
});

describe('vocabulary', () => {
  it('COMMITMENT_LIFECYCLE_STATES covers the DESIGN §9 states', () => {
    for (const s of ['visibleOpen', 'softCancelled', 'partiallyFilled', 'filled', 'expired', 'authoritativelyInvalidated'] as const) {
      expect(COMMITMENT_LIFECYCLE_STATES).toContain(s);
    }
  });
});

// ── M6/A: signedPayload persistence + dispatch ──────────────────────────────

function makerSignedPayload(hash: string): MakerSignedPayload {
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

function sdkSignedPayload(hash: string): SignedCommitmentPayload {
  return {
    commitmentHash: hash as `0x${string}`,
    commitment: {
      maker: '0x'.padEnd(42, 'a') as `0x${string}`,
      contestId: 1n,
      scorer: '0xscorer' as `0x${string}`,
      lineTicks: 0,
      positionType: 0,
      oddsTick: 200,
      riskAmount: 100n,
      nonce: 1n,
      expiry: 2_000_000_000n,
    },
    signature: ('0x' + 'cc'.repeat(65)) as `0x${string}`,
  };
}

describe('toMakerSignedPayload / toSdkSignedPayload roundtrip', () => {
  it('SDK → maker → SDK preserves every field (bigints decimal-string-encoded on the wire, but the roundtrip is lossless)', () => {
    const sdk = sdkSignedPayload('0xabc');
    const maker = toMakerSignedPayload(sdk);
    // Wire shape: bigints became strings.
    expect(maker.commitment.contestId).toBe('1');
    expect(maker.commitment.riskAmount).toBe('100');
    expect(maker.commitment.nonce).toBe('1');
    expect(maker.commitment.expiry).toBe('2000000000');
    // Other fields pass through.
    expect(maker.commitmentHash).toBe(sdk.commitmentHash);
    expect(maker.signature).toBe(sdk.signature);
    expect(maker.commitment.maker).toBe(sdk.commitment.maker);

    // Roundtrip: maker → SDK restores bigints exactly.
    const roundtripped = toSdkSignedPayload(maker);
    expect(roundtripped).toEqual(sdk);
  });
});

describe('dispatchCancel (own-state SSE plan §M6)', () => {
  it("'present' → use-signed-payload path with the SDK-canonical bigint shape", () => {
    const rec = commitment({ signedPayloadStatus: 'present', signedPayload: makerSignedPayload('0xabc'), lifecycle: 'visibleOpen' });
    const d = dispatchCancel(rec);
    expect(d.kind).toBe('use-signed-payload');
    if (d.kind === 'use-signed-payload') {
      expect(d.payload.commitmentHash).toBe('0xabc');
      // bigints, not strings — the SDK canonical shape.
      expect(typeof d.payload.commitment.contestId).toBe('bigint');
      expect(d.payload.commitment.riskAmount).toBe(100n);
    }
  });

  it("'missing-legacy' + visible lifecycle → use-hash path (SDK fetches via public API + reconstructs)", () => {
    for (const lc of ['visibleOpen', 'partiallyFilled'] as const) {
      const rec = commitment({ hash: '0xvis', signedPayloadStatus: 'missing-legacy', lifecycle: lc });
      const d = dispatchCancel(rec);
      expect(d.kind).toBe('use-hash');
      if (d.kind === 'use-hash') expect(d.hash).toBe('0xvis');
    }
  });

  it("'missing-legacy' + softCancelled → blocked-missing-payload (no public payload, no local bundle)", () => {
    const rec = commitment({ signedPayloadStatus: 'missing-legacy', lifecycle: 'softCancelled' });
    const d = dispatchCancel(rec);
    expect(d.kind).toBe('blocked-missing-payload');
  });

  it("'present' + softCancelled → still use-signed-payload (the canonical M6/A path for book-hidden cancel)", () => {
    const rec = commitment({ hash: '0xhid', signedPayloadStatus: 'present', signedPayload: makerSignedPayload('0xhid'), lifecycle: 'softCancelled' });
    const d = dispatchCancel(rec);
    expect(d.kind).toBe('use-signed-payload');
  });
});

describe('StateStore — signedPayload validator (own-state SSE plan §M6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mm-state-m6a-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function persistAndLoad(record: unknown): ReturnType<StateStore['load']> {
    const blob = {
      version: 1,
      lastRunId: null,
      commitments: { '0xabc': record },
      positions: {},
      pnl: { realizedUsdcWei6: '0', unrealizedUsdcWei6: '0', asOfUnixSec: 0 },
      dailyCounters: {},
      lastFlushedAt: null,
    };
    writeFileSync(join(dir, 'maker-state.json'), JSON.stringify(blob), 'utf8');
    return StateStore.at(dir).load();
  }

  it('a pre-M6/A record (no signedPayloadStatus, no signedPayload) loads as "missing-legacy" (migration path)', () => {
    const legacy = {
      hash: '0xabc', speculationId: 'spec-1', contestId: 'contest-1', sport: 'mlb',
      awayTeam: 'NYM', homeTeam: 'LAD', scorer: '0xscorer', makerSide: 'away',
      oddsTick: 191, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen',
      expiryUnixSec: 1_900_000_000, postedAtUnixSec: 1_899_999_880, updatedAtUnixSec: 1_899_999_900,
    };
    const { state, status } = persistAndLoad(legacy);
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('missing-legacy');
    expect(state.commitments['0xabc']?.signedPayload).toBeUndefined();
  });

  it("status: 'present' + valid signedPayload that matches the record hash loads cleanly", () => {
    const rec = commitment({ signedPayloadStatus: 'present', signedPayload: makerSignedPayload('0xabc') });
    const { state, status } = persistAndLoad(rec);
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.signedPayload?.commitmentHash).toBe('0xabc');
  });

  it("status: 'present' WITHOUT signedPayload → state is 'lost' (internal inconsistency)", () => {
    const broken = { ...commitment({}), signedPayloadStatus: 'present' };
    const { status } = persistAndLoad(broken);
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/signedPayloadStatus is "present" but signedPayload is missing/);
  });

  it("status: 'missing-legacy' WITH signedPayload → state is 'lost' (would hide the bundle from cancel paths)", () => {
    const broken = { ...commitment({}), signedPayloadStatus: 'missing-legacy', signedPayload: makerSignedPayload('0xabc') };
    const { status } = persistAndLoad(broken);
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/internal inconsistency/);
  });

  it('signedPayload.commitmentHash mismatch with record hash → state is "lost" (defends against marking the wrong on-chain slot)', () => {
    const drift = commitment({ signedPayloadStatus: 'present', signedPayload: makerSignedPayload('0xdifferent') });
    const { status } = persistAndLoad(drift);
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/signedPayload\.commitmentHash/);
  });

  it('malformed signedPayload (non-decimal contestId) → state is "lost"', () => {
    const sp = makerSignedPayload('0xabc');
    const broken = commitment({ signedPayloadStatus: 'present', signedPayload: { ...sp, commitment: { ...sp.commitment, contestId: 'not-a-number' } } });
    const { status } = persistAndLoad(broken);
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/contestId/);
  });

  it('roundtrip: flush a "present" record then load — signedPayload survives unchanged', () => {
    const store = StateStore.at(dir);
    const s = emptyMakerState();
    s.commitments['0xabc'] = commitment({ signedPayloadStatus: 'present', signedPayload: makerSignedPayload('0xabc') });
    store.flush(s);
    const { state, status } = store.load();
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('present');
    expect(state.commitments['0xabc']?.signedPayload).toEqual(makerSignedPayload('0xabc'));
  });
});

// ── fills history (append-only audit/history) ──────────────────────────────
//
// The `fills` field on a `MakerCommitmentRecord` is the append-only history of
// on-chain Match log events observed for that commitment — an audit/history
// record. The runtime owner-fill dedup set is keyed on `(txHash, logIndex)` and
// is NOT reconstructed from these entries (own-state-sse-plan §2.5.3's proposed
// cold-start boot-seed was removed as dead-in-practice; restart-safety is the
// snapshot-subsumes path). The poll path NEVER appends to it — only the SSE
// `fill` reducer (Phase 2 PR4) populates it.
describe('fills history validator (append-only audit/history)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-fills-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fill(over: Partial<MakerCommitmentFill> = {}): MakerCommitmentFill {
    return { txHash: '0x' + '11'.repeat(32), logIndex: 0, amountWei6: '50000', ts: 1_900_000_000, ...over };
  }

  function persistAndLoad(record: unknown): ReturnType<StateStore['load']> {
    const s = emptyMakerState();
    s.commitments['0xabc'] = record as MakerCommitmentRecord;
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...s, version: 1, lastFlushedAt: null }), 'utf8');
    return StateStore.at(dir).load();
  }

  it('a record with no `fills` field loads with fills: [] (legacy migration)', () => {
    // Build a record-shaped object WITHOUT the fills field — simulating a
    // pre-PR1 state file. Strip the field via JSON round-trip.
    const c = commitment();
    const raw = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    delete raw.fills;
    expect(raw.fills).toBeUndefined();
    const { state, status } = persistAndLoad(raw);
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.fills).toEqual([]);
  });

  it('a record with an explicit empty fills: [] loads identically', () => {
    const { state, status } = persistAndLoad(commitment({ fills: [] }));
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.fills).toEqual([]);
  });

  it('a record with multiple fills survives a flush + load roundtrip in arrival order', () => {
    const store = StateStore.at(dir);
    const fills: MakerCommitmentFill[] = [
      fill({ txHash: '0xaa', logIndex: 0, amountWei6: '10000', ts: 1_900_000_100 }),
      fill({ txHash: '0xaa', logIndex: 5, amountWei6: '5000', ts: 1_900_000_200 }),
      fill({ txHash: '0xbb', logIndex: 0, amountWei6: '30000', ts: 1_900_000_300 }),
    ];
    const s = emptyMakerState();
    s.commitments['0xabc'] = commitment({ fills });
    store.flush(s);
    const { state, status } = store.load();
    expect(status.kind).toBe('loaded');
    expect(state.commitments['0xabc']?.fills).toEqual(fills);
  });

  it('rejects a non-array `fills` field → state is "lost"', () => {
    const { status } = persistAndLoad(commitment({ fills: 'not-an-array' as unknown as MakerCommitmentFill[] }));
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/fills/);
  });

  it('rejects a fill element with non-string txHash → state is "lost"', () => {
    const { status } = persistAndLoad(commitment({ fills: [{ ...fill(), txHash: 42 as unknown as string }] }));
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/txHash/);
  });

  it('rejects a fill element with negative or non-integer logIndex → state is "lost"', () => {
    const { status: a } = persistAndLoad(commitment({ fills: [{ ...fill(), logIndex: -1 }] }));
    expect(a.kind).toBe('lost');
    if (a.kind === 'lost') expect(a.reason).toMatch(/logIndex/);

    const { status: b } = persistAndLoad(commitment({ fills: [{ ...fill(), logIndex: 1.5 }] }));
    expect(b.kind).toBe('lost');
    if (b.kind === 'lost') expect(b.reason).toMatch(/logIndex/);
  });

  it('rejects a fill element with non-decimal-string amountWei6 → state is "lost"', () => {
    const { status: a } = persistAndLoad(commitment({ fills: [{ ...fill(), amountWei6: 100 as unknown as string }] }));
    expect(a.kind).toBe('lost');
    if (a.kind === 'lost') expect(a.reason).toMatch(/amountWei6/);

    const { status: b } = persistAndLoad(commitment({ fills: [{ ...fill(), amountWei6: '-50' }] }));
    expect(b.kind).toBe('lost');
    if (b.kind === 'lost') expect(b.reason).toMatch(/amountWei6/);

    const { status: c } = persistAndLoad(commitment({ fills: [{ ...fill(), amountWei6: '0050' }] }));
    expect(c.kind).toBe('lost');
    if (c.kind === 'lost') expect(c.reason).toMatch(/amountWei6/);
  });

  it('rejects a fill element with negative or non-integer ts → state is "lost"', () => {
    const { status: a } = persistAndLoad(commitment({ fills: [{ ...fill(), ts: -1 }] }));
    expect(a.kind).toBe('lost');
    if (a.kind === 'lost') expect(a.reason).toMatch(/ts/);

    const { status: b } = persistAndLoad(commitment({ fills: [{ ...fill(), ts: 1.5 }] }));
    expect(b.kind).toBe('lost');
    if (b.kind === 'lost') expect(b.reason).toMatch(/ts/);
  });

  it('rejects a fill element that is not a plain object → state is "lost"', () => {
    const { status } = persistAndLoad(commitment({ fills: ['not-an-object' as unknown as MakerCommitmentFill] }));
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/fills\[0\]/);
  });

  it('the index of a malformed fill is surfaced in the reason (locating the bad entry)', () => {
    const fills: MakerCommitmentFill[] = [fill(), fill({ logIndex: 1 }), { ...fill(), logIndex: -3 }];
    const { status } = persistAndLoad(commitment({ fills }));
    expect(status.kind).toBe('lost');
    if (status.kind === 'lost') expect(status.reason).toMatch(/fills\[2\]/);
  });
});

describe('fillDedupKey (Phase 2 PR1)', () => {
  it('produces `${txHash}:${logIndex}` for the canonical dedup key', () => {
    expect(fillDedupKey('0xabc', 0)).toBe('0xabc:0');
    expect(fillDedupKey('0xdeadbeef', 7)).toBe('0xdeadbeef:7');
  });

  it('different (txHash, logIndex) pairs produce different keys (collision check)', () => {
    expect(fillDedupKey('0xabc', 0)).not.toBe(fillDedupKey('0xabc', 1));
    expect(fillDedupKey('0xabc', 0)).not.toBe(fillDedupKey('0xabd', 0));
  });

  it('order matters — same hash and index in different order would be a different key', () => {
    // Sanity check that the key format is unambiguous even if someone confuses
    // the arg order; this would NOT compile-error today, so the test acts as a
    // documentation pin.
    expect(fillDedupKey('0xabc', 5)).toBe('0xabc:5');
    expect(fillDedupKey('0xabc', 5)).not.toBe('5:0xabc');
  });
});

describe('isTerminalPositionStatus / TERMINAL_POSITION_STATUSES', () => {
  it('treats claimed / settledLost / void as terminal (zero live exposure)', () => {
    expect(isTerminalPositionStatus('claimed')).toBe(true);
    expect(isTerminalPositionStatus('settledLost')).toBe(true);
    expect(isTerminalPositionStatus('void')).toBe(true);
  });

  it('treats active / pendingSettle / claimable as non-terminal (still carry exposure)', () => {
    expect(isTerminalPositionStatus('active')).toBe(false);
    expect(isTerminalPositionStatus('pendingSettle')).toBe(false);
    expect(isTerminalPositionStatus('claimable')).toBe(false);
  });

  it('the terminal set partitions MAKER_POSITION_STATUSES exactly (no status is unclassified)', () => {
    const terminal = MAKER_POSITION_STATUSES.filter((s) => TERMINAL_POSITION_STATUSES.has(s));
    const nonTerminal = MAKER_POSITION_STATUSES.filter((s) => !TERMINAL_POSITION_STATUSES.has(s));
    expect(new Set([...terminal, ...nonTerminal])).toEqual(new Set(MAKER_POSITION_STATUSES));
    expect(terminal).toEqual(['claimed', 'settledLost', 'void']);
    expect(nonTerminal).toEqual(['active', 'pendingSettle', 'claimable']);
  });
});
