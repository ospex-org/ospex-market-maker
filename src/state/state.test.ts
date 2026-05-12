import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessStateLoss,
  COMMITMENT_LIFECYCLE_STATES,
  emptyMakerState,
  StateStore,
  type MakerCommitmentRecord,
  type MakerPositionRecord,
  type MakerState,
} from './index.js';

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
    makerSide: 'away',
    oddsTick: 191,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    lifecycle: 'softCancelled',
    expiryUnixSec: 1_900_000_000,
    postedAtUnixSec: 1_899_999_880,
    updatedAtUnixSec: 1_899_999_900,
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

  it('a well-formed soft-cancelled commitment survives the round trip', () => {
    const store = StateStore.at(dir);
    const c = commitment({ lifecycle: 'softCancelled', riskAmountWei6: '100', filledRiskWei6: '0' });
    store.flush(stateWith({ commitments: { [c.hash]: c } }));
    const { state, status } = store.load();
    expect(status.kind).toBe('loaded');
    expect(state.commitments[c.hash]?.lifecycle).toBe('softCancelled');
    expect(state.commitments[c.hash]?.riskAmountWei6).toBe('100');
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
