import { describe, expect, it } from 'vitest';

import type { Commitment, PublicVisibleCommitment } from '../ospex/index.js';
import { emptyMakerState, type MakerCommitmentRecord, type MakerSide, type MakerState } from '../state/index.js';

import {
  reducePolledCommitmentObservation,
  reducePolledPositionObservation,
  reducePolledSoftCancelledObservation,
  type PolledCommitmentObservation,
  type PolledPositionInput,
} from './index.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_900_000_000;
const REDUCER_CONFIG = { expiryReleaseGraceSeconds: 60 };

function makerState(overrides: { commitments?: Record<string, MakerCommitmentRecord>; positions?: MakerState['positions'] } = {}): MakerState {
  const s = emptyMakerState();
  if (overrides.commitments) s.commitments = overrides.commitments;
  if (overrides.positions) s.positions = overrides.positions;
  return s;
}

function commitmentRecord(overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  const hash = overrides.hash ?? '0xabc';
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    makerSide: 'away' as MakerSide,
    oddsTick: 250,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    signedPayloadStatus: 'present',
    signedPayload: {
      commitmentHash: hash,
      commitment: {
        maker: '0x'.padEnd(42, 'a'),
        contestId: '1',
        scorer: '0xscorer',
        lineTicks: 0,
        positionType: 0,
        oddsTick: 250,
        riskAmount: '250000',
        nonce: '1',
        expiry: String(NOW + 100),
      },
      signature: '0x' + 'cc'.repeat(65),
    },
    lifecycle: 'visibleOpen',
    expiryUnixSec: NOW + 100,
    postedAtUnixSec: NOW - 10,
    updatedAtUnixSec: NOW - 10,
    fills: [],
    ...overrides,
  };
}

function visibleCommitment(overrides: Partial<PublicVisibleCommitment> = {}): Commitment {
  return {
    commitmentHash: '0xabc',
    maker: '0xmaker',
    speculationId: 'spec-1',
    contestId: 'contest-1',
    scorer: '0xscorer',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    riskAmount: '250000',
    filledRiskAmount: '0',
    nonce: '1',
    expiry: String(NOW + 100),
    status: 'open',
    storedStatus: 'open',
    nonceInvalidated: false,
    isLive: true,
    redacted: false,
    ...overrides,
  } as unknown as Commitment;
}

// ── reducePolledCommitmentObservation ────────────────────────────────────────

describe('reducePolledCommitmentObservation — still-listed', () => {
  it('emits no descriptors when apiFilled === localFilled (idempotent no-op)', () => {
    const record = commitmentRecord({ filledRiskWei6: '100000' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const observation: PolledCommitmentObservation = {
      kind: 'still-listed',
      record,
      apiCommitment: visibleCommitment({ filledRiskAmount: '100000' }),
    };
    const descriptors = reducePolledCommitmentObservation(state, observation, NOW, REDUCER_CONFIG);
    expect(descriptors).toEqual([]);
    expect(record.filledRiskWei6).toBe('100000');
    expect(record.lifecycle).toBe('visibleOpen');
  });

  it('partial bump on still-listed: mutates record + position + emits mark-dirty + emit-fill partial:true', () => {
    const record = commitmentRecord({ filledRiskWei6: '0' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const observation: PolledCommitmentObservation = {
      kind: 'still-listed',
      record,
      apiCommitment: visibleCommitment({ filledRiskAmount: '50000' }),
    };
    const descriptors = reducePolledCommitmentObservation(state, observation, NOW, REDUCER_CONFIG);
    expect(record.filledRiskWei6).toBe('50000');
    expect(record.lifecycle).toBe('partiallyFilled');
    expect(state.positions['spec-1:away']).toBeDefined();
    const dirty = descriptors.find((d) => d.kind === 'mark-dirty');
    expect(dirty).toEqual({ kind: 'mark-dirty', contestId: 'contest-1' });
    const fill = descriptors.find((d) => d.kind === 'emit-fill');
    expect(fill?.kind).toBe('emit-fill');
    if (fill?.kind === 'emit-fill') {
      expect(fill.payload.source).toBe('commitment-diff');
      expect(fill.payload.partial).toBe(true);
      expect(fill.payload.newFillWei6).toBe('50000');
    }
  });
});

describe('reducePolledCommitmentObservation — idempotency (apply twice = no-op the 2nd time)', () => {
  it('still-listed: re-applying the same apiCommitment after a fill produces no descriptors and no further mutation', () => {
    const record = commitmentRecord({ filledRiskWei6: '0' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const observation: PolledCommitmentObservation = {
      kind: 'still-listed',
      record,
      apiCommitment: visibleCommitment({ filledRiskAmount: '75000' }),
    };
    const first = reducePolledCommitmentObservation(state, observation, NOW, REDUCER_CONFIG);
    expect(first.length).toBeGreaterThan(0);
    const snapshotFilled = record.filledRiskWei6;
    const snapshotPosition = state.positions['spec-1:away']?.riskAmountWei6;
    const second = reducePolledCommitmentObservation(state, observation, NOW + 1, REDUCER_CONFIG);
    expect(second).toEqual([]);
    expect(record.filledRiskWei6).toBe(snapshotFilled);
    expect(state.positions['spec-1:away']?.riskAmountWei6).toBe(snapshotPosition);
  });

  it("disappeared 'filled' with full cumulative: re-applying terminalizes once; second call no-ops", () => {
    const record = commitmentRecord({ filledRiskWei6: '0' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const observation: PolledCommitmentObservation = {
      kind: 'disappeared',
      record,
      apiCommitment: visibleCommitment({ filledRiskAmount: '250000', status: 'filled', storedStatus: 'filled' }),
    };
    const first = reducePolledCommitmentObservation(state, observation, NOW, REDUCER_CONFIG);
    expect(record.lifecycle).toBe('filled');
    expect(record.filledRiskWei6).toBe('250000');
    expect(first.some((d) => d.kind === 'emit-fill')).toBe(true);
    const second = reducePolledCommitmentObservation(state, observation, NOW + 1, REDUCER_CONFIG);
    expect(second).toEqual([]);
  });
});

describe('reducePolledCommitmentObservation — disappeared transitions (table §1b)', () => {
  it("status:'filled' → applies delta + terminalizes (1b-i)", () => {
    const record = commitmentRecord({ filledRiskWei6: '100000' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'filled', storedStatus: 'filled', filledRiskAmount: '250000' }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('filled');
    expect(record.filledRiskWei6).toBe('250000');
    expect(descriptors.some((d) => d.kind === 'emit-fill')).toBe(true);
    expect(descriptors.some((d) => d.kind === 'mark-dirty')).toBe(true);
  });

  it("status:'expired' with AUTH (storedStatus:'cancelled') routes to authoritativelyInvalidated, not expired (1b-ii precedence)", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', expiryUnixSec: NOW - 200 });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'expired', storedStatus: 'cancelled', filledRiskAmount: '0' }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('authoritativelyInvalidated');
    expect(descriptors.find((d) => d.kind === 'emit-expire')).toBeUndefined();
  });

  it("status:'expired' inside grace + delta > 0 stays partiallyFilled (1b-ii table row 4)", () => {
    // expiry was 30s ago, grace 60 — still inside grace
    const record = commitmentRecord({ filledRiskWei6: '0', expiryUnixSec: NOW - 30 });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'expired', storedStatus: 'open', filledRiskAmount: '50000' }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('partiallyFilled');
    expect(record.filledRiskWei6).toBe('50000');
    expect(descriptors.find((d) => d.kind === 'emit-expire')).toBeUndefined();
  });

  it("status:'cancelled' !AUTH converges commitment-only + flips to softCancelled (1b-iii !AUTH branch)", () => {
    const record = commitmentRecord({ filledRiskWei6: '0' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'cancelled', storedStatus: 'open', filledRiskAmount: '0', nonceInvalidated: false }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('softCancelled');
    // No position mutation on the cancelled-!AUTH path (delta=0 ⇒ no mark-dirty / emit-fill)
    expect(state.positions['spec-1:away']).toBeUndefined();
    expect(descriptors.find((d) => d.kind === 'emit-fill')).toBeUndefined();
  });

  it("default branch FULL cumulative on raw 'open' status terminalizes filled (1b-iv table row 1)", () => {
    // status='open' (pre-effective-status fallback) + apiFilled >= risk = authoritative full fill
    const record = commitmentRecord({ filledRiskWei6: '0' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'open', storedStatus: 'open', filledRiskAmount: '250000' }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('filled');
    expect(descriptors.some((d) => d.kind === 'emit-fill')).toBe(true);
  });

  it("default branch unexpected: future-expiry + non-invalidated + raw 'open' emits UnexpectedFillStatus, no mutation (1b-iv table row 6)", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', expiryUnixSec: NOW + 1000 });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared', record, apiCommitment: visibleCommitment({ status: 'open', storedStatus: 'open', filledRiskAmount: '0', nonceInvalidated: false }) },
      NOW,
      REDUCER_CONFIG,
    );
    expect(record.lifecycle).toBe('visibleOpen');
    expect(descriptors.length).toBe(1);
    const first = descriptors[0];
    expect(first?.kind).toBe('emit-error');
    if (first?.kind === 'emit-error') {
      expect(first.payload.class).toBe('UnexpectedFillStatus');
    }
  });
});

describe('reducePolledCommitmentObservation — lookup failed', () => {
  it('past-expiry + lookup failure emits error + signal-past-expiry-lookup-failed', () => {
    const record = commitmentRecord({ filledRiskWei6: '0', expiryUnixSec: NOW - 200 });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared-lookup-failed', record, err: new Error('500') },
      NOW,
      REDUCER_CONFIG,
    );
    expect(descriptors.length).toBe(2);
    expect(descriptors[0]?.kind).toBe('emit-error');
    expect(descriptors[1]?.kind).toBe('signal-past-expiry-lookup-failed');
  });

  it('future-expiry + lookup failure emits error only (no fail-closed signal)', () => {
    const record = commitmentRecord({ filledRiskWei6: '0', expiryUnixSec: NOW + 1000 });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledCommitmentObservation(
      state,
      { kind: 'disappeared-lookup-failed', record, err: new Error('500') },
      NOW,
      REDUCER_CONFIG,
    );
    expect(descriptors.length).toBe(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
  });
});

// ── reducePolledSoftCancelledObservation ─────────────────────────────────────

describe('reducePolledSoftCancelledObservation', () => {
  it("zero cumulative on softCancelled → no descriptors, no mutation (idempotent)", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', lifecycle: 'softCancelled' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledSoftCancelledObservation(state, { kind: 'probed', record, apiCumulativeWei6: 0n }, NOW);
    expect(descriptors).toEqual([]);
    expect(record.lifecycle).toBe('softCancelled');
    expect(record.filledRiskWei6).toBe('0');
  });

  it("partial cumulative stays softCancelled, no position mutation, emits fill softcancel-recovery partial:true", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', lifecycle: 'softCancelled' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledSoftCancelledObservation(state, { kind: 'probed', record, apiCumulativeWei6: 100000n }, NOW);
    expect(record.lifecycle).toBe('softCancelled');
    expect(record.filledRiskWei6).toBe('100000');
    expect(state.positions['spec-1:away']).toBeUndefined();
    const fill = descriptors.find((d) => d.kind === 'emit-fill');
    expect(fill?.kind).toBe('emit-fill');
    if (fill?.kind === 'emit-fill') {
      expect(fill.payload.source).toBe('softcancel-recovery');
      expect(fill.payload.partial).toBe(true);
    }
  });

  it("over-fill clamps to risk and emits SoftCancelledOverFillClamp error before the fill", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', lifecycle: 'softCancelled', riskAmountWei6: '250000' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledSoftCancelledObservation(state, { kind: 'probed', record, apiCumulativeWei6: 999999n }, NOW);
    expect(record.filledRiskWei6).toBe('250000');
    expect(record.lifecycle).toBe('filled');
    const errIdx = descriptors.findIndex((d) => d.kind === 'emit-error');
    const fillIdx = descriptors.findIndex((d) => d.kind === 'emit-fill');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeGreaterThan(errIdx);
  });

  it("probe failure emits SoftCancelledProbeFailed + signal-softcancel-probe-failed; no mutation", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', lifecycle: 'softCancelled' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledSoftCancelledObservation(state, { kind: 'probe-failed', record, err: new Error('429') }, NOW);
    expect(record.lifecycle).toBe('softCancelled');
    expect(record.filledRiskWei6).toBe('0');
    expect(descriptors.some((d) => d.kind === 'emit-error')).toBe(true);
    expect(descriptors.some((d) => d.kind === 'signal-softcancel-probe-failed')).toBe(true);
  });

  it("idempotency: re-applying the same cumulative is a no-op after the first apply", () => {
    const record = commitmentRecord({ filledRiskWei6: '0', lifecycle: 'softCancelled' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const first = reducePolledSoftCancelledObservation(state, { kind: 'probed', record, apiCumulativeWei6: 100000n }, NOW);
    expect(first.length).toBeGreaterThan(0);
    const second = reducePolledSoftCancelledObservation(state, { kind: 'probed', record, apiCumulativeWei6: 100000n }, NOW + 1);
    expect(second).toEqual([]);
  });
});

// ── reducePolledPositionObservation ──────────────────────────────────────────

describe('reducePolledPositionObservation', () => {
  function p(overrides: Partial<PolledPositionInput> = {}): PolledPositionInput {
    return {
      positionId: 'pos-1',
      speculationId: 'spec-1',
      positionType: 0,
      riskAmountUSDC: 0.1,
      profitAmountUSDC: 0.15,
      ...overrides,
    };
  }

  it('new position + existing source commitment creates record + emits position-poll fill (no transition at birth)', () => {
    const record = commitmentRecord({ lifecycle: 'softCancelled' });
    const state = makerState({ commitments: { [record.hash]: record } });
    const descriptors = reducePolledPositionObservation(state, 'active', p(), undefined, undefined, NOW);
    expect(state.positions['spec-1:away']?.status).toBe('active');
    expect(descriptors.some((d) => d.kind === 'emit-fill' && d.payload.source === 'position-poll')).toBe(true);
    expect(descriptors.some((d) => d.kind === 'emit-position-transition')).toBe(false);
  });

  it('PositionWithoutCommitment when no source commitment exists; no mutation', () => {
    const state = makerState();
    const descriptors = reducePolledPositionObservation(state, 'active', p(), undefined, undefined, NOW);
    expect(state.positions['spec-1:away']).toBeUndefined();
    const err = descriptors.find((d) => d.kind === 'emit-error');
    expect(err?.kind).toBe('emit-error');
    if (err?.kind === 'emit-error') {
      expect(err.payload.class).toBe('PositionWithoutCommitment');
    }
  });

  it('BackwardsPositionTransition refused (claimable → active); no mutation', () => {
    const record = commitmentRecord();
    const state = makerState({
      commitments: { [record.hash]: record },
      positions: {
        'spec-1:away': {
          speculationId: 'spec-1',
          contestId: 'contest-1',
          sport: 'mlb',
          awayTeam: 'NYM',
          homeTeam: 'LAD',
          side: 'away',
          riskAmountWei6: '100000',
          counterpartyRiskWei6: '150000',
          status: 'claimable',
          updatedAtUnixSec: NOW - 10,
        },
      },
    });
    const descriptors = reducePolledPositionObservation(state, 'active', p({ riskAmountUSDC: 0.1 }), undefined, undefined, NOW);
    expect(state.positions['spec-1:away']?.status).toBe('claimable');
    const err = descriptors.find((d) => d.kind === 'emit-error');
    expect(err?.kind).toBe('emit-error');
    if (err?.kind === 'emit-error') {
      expect(err.payload.class).toBe('BackwardsPositionTransition');
    }
  });

  it('forward status transition emits position-transition (active → pendingSettle)', () => {
    const record = commitmentRecord();
    const state = makerState({
      commitments: { [record.hash]: record },
      positions: {
        'spec-1:away': {
          speculationId: 'spec-1',
          contestId: 'contest-1',
          sport: 'mlb',
          awayTeam: 'NYM',
          homeTeam: 'LAD',
          side: 'away',
          riskAmountWei6: '100000',
          counterpartyRiskWei6: '150000',
          status: 'active',
          updatedAtUnixSec: NOW - 10,
        },
      },
    });
    const descriptors = reducePolledPositionObservation(state, 'pendingSettle', p({ riskAmountUSDC: 0.1 }), 'won', 'home', NOW);
    expect(state.positions['spec-1:away']?.status).toBe('pendingSettle');
    expect(state.positions['spec-1:away']?.result).toBe('won');
    const tr = descriptors.find((d) => d.kind === 'emit-position-transition');
    expect(tr?.kind).toBe('emit-position-transition');
    if (tr?.kind === 'emit-position-transition') {
      expect(tr.payload.fromStatus).toBe('active');
      expect(tr.payload.toStatus).toBe('pendingSettle');
      expect(tr.payload.result).toBe('won');
      expect(tr.payload.predictedWinSide).toBe('home');
    }
  });

  it('idempotent on no-change: same observation twice = no descriptors the 2nd time', () => {
    const record = commitmentRecord();
    const state = makerState({ commitments: { [record.hash]: record } });
    const first = reducePolledPositionObservation(state, 'active', p(), undefined, undefined, NOW);
    expect(first.length).toBeGreaterThan(0);
    const second = reducePolledPositionObservation(state, 'active', p(), undefined, undefined, NOW + 1);
    expect(second).toEqual([]);
  });
});
