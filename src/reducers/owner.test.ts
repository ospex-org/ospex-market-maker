import { describe, expect, it } from 'vitest';

import type { Fill, OwnerCommitment, PositionStatusEvent } from '../ospex/index.js';
import {
  emptyMakerState,
  type MakerPositionRecord,
  type MakerPositionStatus,
} from '../state/index.js';

import {
  mapOwnerCommitmentToMaker,
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
} from './index.js';

// These reducers now write canonical `MakerState` directly (Phase 3 PR3b — the
// own-state SSE SOURCE FLIP). They project the SDK's owner payloads via the pure
// PR3a mappers (`mapOwner{Commitment,Position}ToMaker` /
// `mapPositionStatusEventToMaker`) and emit the same `mark-dirty` / `emit-fill`
// / `emit-position-transition` descriptors the poll reducers emit. The pure
// mapping logic (lifecycle routing, side derivation, terminal preservation) is
// covered in `owner-mapping.test.ts`; this file covers the reducers' STATE
// EFFECTS + descriptor emission against a `MakerState` target.

// ── fixtures ─────────────────────────────────────────────────────────────────

const OUR_ADDR = '0x9999999999999999999999999999999999999999';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';

/** A fully-populated, mappable `OwnerCommitment` (enriched per PR0b — mirrors owner-mapping.test.ts). */
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
    speculationId: 'spec-1',
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

/** A canonical `MakerPositionRecord` for `(spec-1, away)` at the given status. */
function makerPosition(status: MakerPositionStatus): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: '1',
    sport: 'baseball_mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    side: 'away',
    riskAmountWei6: '50000',
    counterpartyRiskWei6: '75000',
    status,
    updatedAtUnixSec: 1735689600,
  };
}

// ── reduceOwnerCommitmentObservation (canonical: writes MakerState.commitments) ─

describe('reduceOwnerCommitmentObservation', () => {
  it('inserts a previously-unseen commitment into canonical state', () => {
    const state = emptyMakerState();
    const descriptors = reduceOwnerCommitmentObservation(state, ownerCommitment({ commitmentHash: '0xnew' }));
    // visibleOpen is a lifecycle CHANGE from "no record" → mark-dirty
    expect(descriptors).toEqual([{ kind: 'mark-dirty', contestId: '1' }]);
    expect(state.commitments['0xnew']).toBeDefined();
    expect(state.commitments['0xnew']?.lifecycle).toBe('visibleOpen');
  });

  it('replaces an existing commitment when a delta event arrives, PRESERVING the observed fills[]', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    // simulate a fill having been observed against this commitment first
    state.commitments['0xabc']!.fills = [{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }];
    reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '100000' }));
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe('100000');
    expect(state.commitments['0xabc']?.lifecycle).toBe('partiallyFilled');
    // the replace must NOT wipe the SSE-fill audit/dedup array
    expect(state.commitments['0xabc']?.fills).toEqual([{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }]);
  });

  it('emits mark-dirty ONLY on a lifecycle change', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ filledRiskAmount: '100000' })); // partiallyFilled
    // same lifecycle (still partiallyFilled), only the cumulative grew → no mark-dirty
    const same = reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '120000' }));
    expect(same).toEqual([]);
    // now a real lifecycle move (partiallyFilled → filled) → mark-dirty
    const changed = reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '250000' }));
    expect(changed).toEqual([{ kind: 'mark-dirty', contestId: '1' }]);
    expect(state.commitments['0xabc']?.lifecycle).toBe('filled');
  });

  it('does NOT mutate state.positions', () => {
    const state = emptyMakerState();
    reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '100000' }));
    expect(state.positions).toEqual({});
  });

  it('throws OwnerMappingError on missing metadata (the runner drain catch handles it; reducers do NOT catch)', () => {
    const state = emptyMakerState();
    expect(() => reduceOwnerCommitmentObservation(state, ownerCommitment({ speculationId: null }))).toThrow();
    // state untouched on a throw
    expect(state.commitments).toEqual({});
  });
});

// ── reduceOwnerFill (canonical: writes MakerState.positions + commitment.fills[]) ─

describe('reduceOwnerFill — maker side (ourAddress matches fill.maker)', () => {
  it('creates the maker-side position with identity from the sibling commitment + appends commitment.fills[] + emits emit-fill{source:own-state-stream} + mark-dirty', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ filledRiskAmount: '50000' }));
    const beforeCommitmentFill = state.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill(), dedup, OUR_ADDR, 1);

    // mark-dirty + emit-fill
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toEqual({ kind: 'mark-dirty', contestId: '1' });
    const fillDesc = descriptors[1];
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') {
      expect(fillDesc.payload.source).toBe('own-state-stream');
      expect(fillDesc.payload.makerSide).toBe('away');
      expect(fillDesc.payload.takerSide).toBe('home');
      expect(fillDesc.payload.newFillWei6).toBe('50000');
      expect(fillDesc.payload.cumulativeRiskWei6).toBe('50000');
      // identity resolved from the sibling commitment (a Fill carries no sport/teams)
      expect(fillDesc.payload.sport).toBe('baseball_mlb');
      expect(fillDesc.payload.awayTeam).toBe('NYM');
      expect(fillDesc.payload.homeTeam).toBe('LAD');
    }

    // position created with the commitment's denormalized identity
    expect(state.positions['spec-1:away']).toMatchObject({
      speculationId: 'spec-1',
      contestId: '1',
      sport: 'baseball_mlb',
      awayTeam: 'NYM',
      homeTeam: 'LAD',
      side: 'away',
      riskAmountWei6: '50000', // our (maker) risk
      counterpartyRiskWei6: '75000', // taker risk
      status: 'active',
    });
    // commitment.fills[] appended, but commitment.filledRiskWei6 UNCHANGED
    // (that bump is owned by reduceOwnerCommitmentObservation — avoids double-count).
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe(beforeCommitmentFill);
    expect(state.commitments['0xabc']?.fills).toEqual([{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }]);
    expect(dedup.size).toBe(1);
  });

  it('dedup: same (txHash, logIndex) twice → second is a no-op', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const dedup = new Set<string>();
    reduceOwnerFill(state, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 1);
    const snap = JSON.parse(JSON.stringify(state));
    const descriptors = reduceOwnerFill(state, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 2);
    expect(descriptors).toEqual([]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(snap);
  });

  it('different (txHash, logIndex) → position accumulates each fill; commitment cumulative still untouched', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const before = state.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 0, makerRiskAmount: '30000', takerRiskAmount: '0' }), dedup, OUR_ADDR, 1);
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 1, makerRiskAmount: '20000', takerRiskAmount: '0' }), dedup, OUR_ADDR, 2);
    expect(state.positions['spec-1:away']?.riskAmountWei6).toBe('50000');
    expect(state.commitments['0xabc']?.fills).toHaveLength(2);
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe(before);
  });
});

describe('reduceOwnerFill — taker side (ourAddress matches fill.taker)', () => {
  it('creates the taker-side position from the sibling commitment identity (our risk = takerRiskAmount, side = home)', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const descriptors = reduceOwnerFill(state, fill({ maker: OTHER_ADDR, taker: OUR_ADDR }), new Set<string>(), OUR_ADDR, 1);
    expect(descriptors).toHaveLength(2);
    expect(state.positions['spec-1:home']).toMatchObject({
      side: 'home', // takerPositionType 1 → home
      riskAmountWei6: '75000', // our (taker) risk
      counterpartyRiskWei6: '50000', // maker risk
      status: 'active',
    });
  });
});

describe('reduceOwnerFill — neither side matches (anomaly)', () => {
  it('emits OwnerFillForeignAddress error, does NOT mutate, but IS deduped', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill({ maker: '0xother1', taker: '0xother2' }), dedup, OUR_ADDR, 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerFillForeignAddress');
    }
    expect(state.positions).toEqual({});
    expect(state.commitments['0xabc']?.fills).toEqual([]);
    // Dedup set IS still updated — a re-delivery of the anomalous fill is a no-op.
    expect(dedup.size).toBe(1);
  });
});

describe('reduceOwnerFill — §7.2 unknown-own-fill (commitmentHash not in canonical state)', () => {
  it('returns a single signal-unknown-own-fill descriptor, mutates NOTHING, and is NOT deduped', () => {
    const state = emptyMakerState();
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill(), dedup, OUR_ADDR, 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('signal-unknown-own-fill');
    if (descriptors[0]?.kind === 'signal-unknown-own-fill') {
      expect(descriptors[0].payload).toEqual({
        commitmentHash: '0xabc',
        speculationId: 'spec-1',
        txHash: '0xtx1',
        logIndex: 0,
      });
    }
    // no position materialized — a Fill carries no sport/team identity (own-state SSE plan §7.2)
    expect(state.positions).toEqual({});
    expect(state.commitments).toEqual({});
    // NOT deduped — the cursor-less cold restart re-snapshots past it
    expect(dedup.size).toBe(0);
  });
});

// ── reduceOwnerPositionStatus (canonical: writes MakerState.positions) ──────────

describe('reduceOwnerPositionStatus — mapping + transitions', () => {
  function stateWith(status: MakerPositionStatus) {
    const state = emptyMakerState();
    state.positions['spec-1:away'] = makerPosition(status);
    return state;
  }

  it('forward transition active → pendingSettle updates status + emits emit-position-transition', () => {
    const state = stateWith('active');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'pendingSettle' }));
    expect(descriptors).toHaveLength(1);
    const desc = descriptors[0];
    expect(desc?.kind).toBe('emit-position-transition');
    if (desc?.kind === 'emit-position-transition') {
      expect(desc.payload.fromStatus).toBe('active');
      expect(desc.payload.toStatus).toBe('pendingSettle');
      expect(desc.payload.makerSide).toBe('away');
    }
    expect(state.positions['spec-1:away']?.status).toBe('pendingSettle');
  });

  // KEY INVERSION vs the old shadow tests: settledLost/void are now PRESERVED as
  // distinct terminals (own-state plan A7), NOT collapsed to 'claimed'.
  it('settledLost is PRESERVED as settledLost (NOT collapsed to claimed)', () => {
    const state = stateWith('claimable');
    reduceOwnerPositionStatus(state, positionEvent({ status: 'settledLost', result: 'lost' }));
    expect(state.positions['spec-1:away']?.status).toBe('settledLost');
  });

  it('void is PRESERVED as void (NOT collapsed to claimed)', () => {
    const state = stateWith('pendingSettle');
    reduceOwnerPositionStatus(state, positionEvent({ status: 'void', result: 'void' }));
    expect(state.positions['spec-1:away']?.status).toBe('void');
  });

  it('backwards transition claimable → active emits OwnerBackwardsPositionTransition and refuses', () => {
    const state = stateWith('claimable');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'active' }));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerBackwardsPositionTransition');
    }
    expect(state.positions['spec-1:away']?.status).toBe('claimable'); // unchanged
  });

  it('unknown position → emits OwnerPositionStatusForUnknownPosition; does NOT insert', () => {
    const state = emptyMakerState();
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'active' }));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerPositionStatusForUnknownPosition');
    }
    expect(state.positions).toEqual({});
  });

  it('idempotent on no-status-change (no descriptor, state byte-identical apart from updatedAt)', () => {
    const state = stateWith('pendingSettle');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'pendingSettle' }));
    expect(descriptors).toEqual([]);
    expect(state.positions['spec-1:away']?.status).toBe('pendingSettle');
  });
});
