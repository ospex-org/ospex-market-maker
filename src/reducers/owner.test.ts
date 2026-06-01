import { describe, expect, it } from 'vitest';

import type { Fill, OwnerCommitment, PositionStatusEvent } from '../ospex/index.js';
import { emptyMakerState } from '../state/index.js';

import {
  emptyOwnStateShadow,
  projectOwnerCommitment,
  projectOwnerPosition,
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
  type OwnStateShadow,
} from './index.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const OUR_ADDR = '0x9999999999999999999999999999999999999999';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';

function ownerCommitment(overrides: Partial<OwnerCommitment> = {}): OwnerCommitment {
  return {
    ownerAuthorized: true,
    visibility: 'visible',
    redacted: false,
    commitmentHash: '0xabc',
    maker: OUR_ADDR,
    contestId: '1',
    scorer: '0xscorer',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '250000',
    filledRiskAmount: '0',
    remainingRiskAmount: '250000',
    nonce: '1',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: null,
    signature: null,
    status: 'open',
    storedStatus: 'open',
    source: 'sse',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    speculationId: null,
    sport: 'baseball_mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    updatedAtUnixSec: 1735689600,
    signedPayload: null,
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    speculationId: 'spec-1',
    contestId: 'contest-1',
    commitmentHash: '0xabc',
    maker: OUR_ADDR,
    taker: OTHER_ADDR,
    makerPositionType: 0,
    takerPositionType: 1,
    makerRiskAmount: '50000',
    takerRiskAmount: '75000',
    makerRiskUSDC: 0.05,
    takerRiskUSDC: 0.075,
    oddsTick: 250,
    filledAt: '2025-01-01T00:00:00.000Z',
    contestStarted: false,
    txHash: '0xtx1',
    logIndex: 0,
    ...overrides,
  };
}

function positionEvent(overrides: Partial<PositionStatusEvent> = {}): PositionStatusEvent {
  return {
    address: OUR_ADDR,
    speculationId: 'spec-1',
    positionType: 0,
    status: 'pendingSettle',
    sourceUpdatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── emptyOwnStateShadow + identity guards ────────────────────────────────────

describe('emptyOwnStateShadow', () => {
  it('returns a fresh non-ready shadow with empty maps and zero timestamps', () => {
    const shadow = emptyOwnStateShadow();
    expect(shadow.ready).toBe(false);
    expect(shadow.healthy).toBe(true);
    expect(shadow.commitments).toEqual({});
    expect(shadow.positions).toEqual({});
    expect(shadow.pendingBaseline).toBeNull();
    expect(shadow.positionsTruncated).toBe(false);
    expect(shadow.lastStatus).toBeNull();
    expect(shadow.lastError).toBeNull();
  });

  it('returns a distinct object per call (no shared mutable state)', () => {
    const a = emptyOwnStateShadow();
    const b = emptyOwnStateShadow();
    expect(a).not.toBe(b);
    expect(a.commitments).not.toBe(b.commitments);
    expect(a.positions).not.toBe(b.positions);
  });
});

// ── projection helpers ───────────────────────────────────────────────────────

describe('projectOwnerCommitment — lifecycle routing', () => {
  it('FULL fill (filledRiskAmount >= riskAmount) → filled', () => {
    const c = projectOwnerCommitment(ownerCommitment({ filledRiskAmount: '250000', riskAmount: '250000' }));
    expect(c.lifecycle).toBe('filled');
  });

  it('AUTH storedStatus=cancelled → authoritativelyInvalidated', () => {
    const c = projectOwnerCommitment(ownerCommitment({ storedStatus: 'cancelled' }));
    expect(c.lifecycle).toBe('authoritativelyInvalidated');
  });

  it('AUTH nonceInvalidated → authoritativelyInvalidated (regardless of status)', () => {
    const c = projectOwnerCommitment(ownerCommitment({ nonceInvalidated: true, status: 'open' }));
    expect(c.lifecycle).toBe('authoritativelyInvalidated');
  });

  it('status=expired (no AUTH) → expired', () => {
    const c = projectOwnerCommitment(ownerCommitment({ status: 'expired' }));
    expect(c.lifecycle).toBe('expired');
  });

  it('status=cancelled (no AUTH, hidden) → softCancelled', () => {
    const c = projectOwnerCommitment(ownerCommitment({ status: 'cancelled' }));
    expect(c.lifecycle).toBe('softCancelled');
  });

  it('status=open + filled=0 → visibleOpen', () => {
    const c = projectOwnerCommitment(ownerCommitment({ status: 'open', filledRiskAmount: '0' }));
    expect(c.lifecycle).toBe('visibleOpen');
  });

  it('status=open + filled>0 → partiallyFilled', () => {
    const c = projectOwnerCommitment(ownerCommitment({ status: 'open', filledRiskAmount: '100000' }));
    expect(c.lifecycle).toBe('partiallyFilled');
  });

  it('null expiry → expiryUnixSec=0 (defensive)', () => {
    const c = projectOwnerCommitment(ownerCommitment({ expiry: null }));
    expect(c.expiryUnixSec).toBe(0);
  });
});

describe('projectOwnerPosition', () => {
  it('positionType 0 → away', () => {
    const p = projectOwnerPosition({ positionId: 'p1', speculationId: 'spec-1', positionType: 0, team: 'NYM', opponent: 'LAD', market: 'moneyline', oddsDecimal: 2.5, riskAmountUSDC: 0.1, profitAmountUSDC: 0.15, contestId: '1', sport: 'baseball_mlb', awayTeam: 'NYM', homeTeam: 'LAD', riskAmountWei6: '100000', counterpartyRiskWei6: '150000', updatedAtUnixSec: 1735689600, status: 'active' });
    expect(p.side).toBe('away');
    expect(p.riskAmountWei6).toBe('100000');
    expect(p.status).toBe('active');
  });

  it('positionType 1 → home', () => {
    const p = projectOwnerPosition({ positionId: 'p1', speculationId: 'spec-1', positionType: 1, team: 'LAD', opponent: 'NYM', market: 'moneyline', oddsDecimal: 1.8, riskAmountUSDC: 0.05, profitAmountUSDC: 0.04, contestId: '1', sport: 'baseball_mlb', awayTeam: 'NYM', homeTeam: 'LAD', riskAmountWei6: '50000', counterpartyRiskWei6: '40000', updatedAtUnixSec: 1735689600, status: 'claimable', result: 'won', estimatedPayoutUSDC: 0.09, estimatedPayoutWei6: '90000' });
    expect(p.side).toBe('home');
    expect(p.status).toBe('claimable');
  });
});

// ── reduceOwnerCommitmentObservation ─────────────────────────────────────────

describe('reduceOwnerCommitmentObservation', () => {
  it('inserts a previously-unseen commitment into the shadow', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerCommitmentObservation(shadow, ownerCommitment({ commitmentHash: '0xnew' }), 1);
    expect(descriptors).toEqual([]);
    expect(shadow.commitments['0xnew']).toBeDefined();
    expect(shadow.commitments['0xnew']?.lifecycle).toBe('visibleOpen');
  });

  it('replaces an existing commitment when a delta event arrives (e.g. fill cumulative grew)', () => {
    const shadow = emptyOwnStateShadow();
    shadow.commitments['0xabc'] = projectOwnerCommitment(ownerCommitment());
    reduceOwnerCommitmentObservation(shadow, ownerCommitment({ filledRiskAmount: '100000' }), 1);
    expect(shadow.commitments['0xabc']?.filledRiskWei6).toBe('100000');
    expect(shadow.commitments['0xabc']?.lifecycle).toBe('partiallyFilled');
  });

  it('does NOT mutate shadow positions (blocker 5)', () => {
    const shadow = emptyOwnStateShadow();
    reduceOwnerCommitmentObservation(shadow, ownerCommitment({ filledRiskAmount: '100000' }), 1);
    expect(shadow.positions).toEqual({});
  });

  it('idempotent on no-change: re-applying the same event produces byte-identical state', () => {
    const shadow = emptyOwnStateShadow();
    reduceOwnerCommitmentObservation(shadow, ownerCommitment(), 1);
    const snap = JSON.parse(JSON.stringify(shadow));
    reduceOwnerCommitmentObservation(shadow, ownerCommitment(), 2);
    expect(JSON.parse(JSON.stringify(shadow))).toEqual(snap);
  });
});

// ── reduceOwnerFill ──────────────────────────────────────────────────────────

describe('reduceOwnerFill — maker side (ourAddress matches fill.maker)', () => {
  it('extends maker-side position but does NOT touch commitment.filledRiskWei6 (that\'s reduceOwnerCommitmentObservation\'s job — avoids double-count)', () => {
    const shadow = emptyOwnStateShadow();
    shadow.commitments['0xabc'] = projectOwnerCommitment(ownerCommitment({ filledRiskAmount: '50000' }));
    const beforeCommitmentFill = shadow.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(shadow, fill(), dedup, OUR_ADDR, 1);
    expect(descriptors).toEqual([]);
    // Commitment cumulative UNCHANGED — the onCommitment event for the same
    // on-chain Match is what advances it. Double-applying would over-count.
    expect(shadow.commitments['0xabc']?.filledRiskWei6).toBe(beforeCommitmentFill);
    expect(shadow.positions['spec-1:away']).toMatchObject({
      speculationId: 'spec-1',
      side: 'away',
      riskAmountWei6: '50000',
      status: 'active',
    });
    expect(dedup.size).toBe(1);
  });

  it('dedup: same (txHash, logIndex) twice → second is a no-op', () => {
    const shadow = emptyOwnStateShadow();
    shadow.commitments['0xabc'] = projectOwnerCommitment(ownerCommitment());
    const dedup = new Set<string>();
    reduceOwnerFill(shadow, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 1);
    const snap = JSON.parse(JSON.stringify(shadow));
    reduceOwnerFill(shadow, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 2);
    expect(JSON.parse(JSON.stringify(shadow))).toEqual(snap);
  });

  it('different (txHash, logIndex) → position accumulates each fill (commitment cumulative still untouched)', () => {
    const shadow = emptyOwnStateShadow();
    shadow.commitments['0xabc'] = projectOwnerCommitment(ownerCommitment());
    const before = shadow.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    reduceOwnerFill(shadow, fill({ txHash: '0xa', logIndex: 0, makerRiskAmount: '30000' }), dedup, OUR_ADDR, 1);
    reduceOwnerFill(shadow, fill({ txHash: '0xa', logIndex: 1, makerRiskAmount: '20000' }), dedup, OUR_ADDR, 2);
    expect(shadow.positions['spec-1:away']?.riskAmountWei6).toBe('50000');
    expect(shadow.commitments['0xabc']?.filledRiskWei6).toBe(before);
  });

  it('commitment not in shadow (race vs onCommitment) → still creates position; commitment cumulative will be set by the upcoming onCommitment', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerFill(shadow, fill(), new Set<string>(), OUR_ADDR, 1);
    expect(descriptors).toEqual([]);
    expect(shadow.commitments['0xabc']).toBeUndefined();
    expect(shadow.positions['spec-1:away']).toBeDefined();
  });
});

describe('reduceOwnerFill — taker side (ourAddress matches fill.taker)', () => {
  it('extends taker-side position; does NOT touch commitment (we don\'t track other peoples\' commitments)', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerFill(shadow, fill({ maker: OTHER_ADDR, taker: OUR_ADDR }), new Set<string>(), OUR_ADDR, 1);
    expect(descriptors).toEqual([]);
    expect(shadow.commitments).toEqual({});
    expect(shadow.positions['spec-1:home']).toMatchObject({
      side: 'home',
      riskAmountWei6: '75000', // takerRiskAmount
      status: 'active',
    });
  });
});

describe('reduceOwnerFill — neither side matches (anomaly)', () => {
  it('emits OwnerFillForeignAddress error and does NOT mutate', () => {
    const shadow = emptyOwnStateShadow();
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(shadow, fill({ maker: '0xother1', taker: '0xother2' }), dedup, OUR_ADDR, 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerFillForeignAddress');
    }
    expect(shadow.positions).toEqual({});
    expect(shadow.commitments).toEqual({});
    // Dedup set IS still updated — a future re-delivery of the same anomalous
    // fill should be a no-op (idempotent on the error path too).
    expect(dedup.size).toBe(1);
  });
});

// ── reduceOwnerPositionStatus ────────────────────────────────────────────────

describe('reduceOwnerPositionStatus — mapping + transitions', () => {
  function shadowWith(status: OwnStateShadow['positions'][string]['status']): OwnStateShadow {
    const s = emptyOwnStateShadow();
    s.positions['spec-1:away'] = { speculationId: 'spec-1', side: 'away', riskAmountWei6: '50000', status };
    return s;
  }

  it('forward transition active → pendingSettle updates status', () => {
    const shadow = shadowWith('active');
    const descriptors = reduceOwnerPositionStatus(shadow, positionEvent({ status: 'pendingSettle' }), 1);
    expect(descriptors).toEqual([]);
    expect(shadow.positions['spec-1:away']?.status).toBe('pendingSettle');
  });

  it('settledLost → claimed (terminal-lost projection)', () => {
    const shadow = shadowWith('claimable');
    reduceOwnerPositionStatus(shadow, positionEvent({ status: 'settledLost' }), 1);
    expect(shadow.positions['spec-1:away']?.status).toBe('claimed');
  });

  it('void → claimed (voided projection)', () => {
    const shadow = shadowWith('pendingSettle');
    reduceOwnerPositionStatus(shadow, positionEvent({ status: 'void' }), 1);
    expect(shadow.positions['spec-1:away']?.status).toBe('claimed');
  });

  it('backwards transition claimable → active emits OwnerBackwardsPositionTransition and refuses', () => {
    const shadow = shadowWith('claimable');
    const descriptors = reduceOwnerPositionStatus(shadow, positionEvent({ status: 'active' }), 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerBackwardsPositionTransition');
    }
    expect(shadow.positions['spec-1:away']?.status).toBe('claimable'); // unchanged
  });

  it('unknown position → emits OwnerPositionStatusForUnknownPosition; does NOT insert', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerPositionStatus(shadow, positionEvent({ status: 'active' }), 1);
    expect(descriptors).toHaveLength(1);
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerPositionStatusForUnknownPosition');
    }
    expect(shadow.positions).toEqual({});
  });

  it('idempotent on no-status-change', () => {
    const shadow = shadowWith('pendingSettle');
    const snap = JSON.parse(JSON.stringify(shadow));
    reduceOwnerPositionStatus(shadow, positionEvent({ status: 'pendingSettle' }), 1);
    expect(JSON.parse(JSON.stringify(shadow))).toEqual(snap);
  });
});

// ── source-confusion compile-time guard ──────────────────────────────────────

describe('source-confusion compile-time guard (typed boundary between MakerState and OwnStateShadow)', () => {
  // The body parameters are SDK-typed now (PR4b), so the cross-target call has
  // BOTH a target-type error AND a body-type error if we pass `{}`. The
  // `@ts-expect-error` directive suppresses any error on the next line — as
  // long as there IS at least one error, the test passes. The architectural
  // contract is still that MakerState is not assignable to OwnStateShadow.
  it('forbids passing MakerState to reduceOwnerCommitmentObservation', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerCommitmentObservation(state, ownerCommitment(), 1);
  });

  it('forbids passing MakerState to reduceOwnerFill', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
  });

  it('forbids passing MakerState to reduceOwnerPositionStatus', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerPositionStatus(state, positionEvent(), 1);
  });
});
