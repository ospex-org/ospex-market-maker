import { describe, expect, it } from 'vitest';

import { emptyOwnStateShadow, type OwnStateShadow, type ShadowCommitment, type ShadowPosition } from '../reducers/index.js';
import { emptyMakerState, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';

import { compareShadowVsCanonical, type TrackedDivergence } from './shadow-comparator.js';

const NOW = 1_900_000_000_000;
const TOLERANCE = 5000;
const FRESH = NOW - 100; // < TOLERANCE — fresh
const SETTLED = NOW - 10_000; // > TOLERANCE — settled

// ── fixtures ─────────────────────────────────────────────────────────────────

function shadowCommitment(overrides: Partial<ShadowCommitment> = {}): ShadowCommitment {
  return {
    hash: '0xabc',
    lifecycle: 'visibleOpen',
    filledRiskWei6: '0',
    riskAmountWei6: '250000',
    expiryUnixSec: 1_900_001_000,
    ...overrides,
  };
}

function shadowPosition(overrides: Partial<ShadowPosition> = {}): ShadowPosition {
  return {
    speculationId: 'spec-1',
    side: 'away',
    riskAmountWei6: '100000',
    status: 'active',
    ...overrides,
  };
}

function canonicalCommitment(overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  const hash = overrides.hash ?? '0xabc';
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    makerSide: 'away',
    oddsTick: 250,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    signedPayloadStatus: 'missing-legacy',
    lifecycle: 'visibleOpen',
    expiryUnixSec: 1_900_001_000,
    postedAtUnixSec: 1_899_999_000,
    updatedAtUnixSec: 1_899_999_000,
    fills: [],
    ...overrides,
  };
}

function canonicalPosition(overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    side: 'away',
    riskAmountWei6: '100000',
    counterpartyRiskWei6: '150000',
    status: 'active',
    updatedAtUnixSec: 1_899_999_000,
    ...overrides,
  };
}

function stateWithCommitment(c: MakerCommitmentRecord): MakerState {
  const s = emptyMakerState();
  s.commitments[c.hash] = c;
  return s;
}

function stateWithPosition(key: string, p: MakerPositionRecord): MakerState {
  const s = emptyMakerState();
  s.positions[key] = p;
  return s;
}

function shadowWithCommitment(c: ShadowCommitment): OwnStateShadow {
  const s = emptyOwnStateShadow();
  s.commitments[c.hash] = c;
  s.lastEventAtMs = SETTLED;
  return s;
}

function shadowWithPosition(key: string, p: ShadowPosition): OwnStateShadow {
  const s = emptyOwnStateShadow();
  s.positions[key] = p;
  s.lastEventAtMs = SETTLED;
  return s;
}

// ── identity / no-divergence ─────────────────────────────────────────────────

describe('compareShadowVsCanonical — identical states', () => {
  it('returns null when both sides have the same commitment + position', () => {
    const state = stateWithCommitment(canonicalCommitment());
    state.positions['spec-1:away'] = canonicalPosition();
    const shadow = shadowWithCommitment(shadowCommitment());
    shadow.positions['spec-1:away'] = shadowPosition();
    const tracker = new Map<string, TrackedDivergence>();
    expect(compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED)).toBeNull();
    expect(tracker.size).toBe(0);
  });

  it('returns null when both sides are empty', () => {
    expect(compareShadowVsCanonical(emptyMakerState(), emptyOwnStateShadow(), new Map(), NOW, TOLERANCE, SETTLED)).toBeNull();
  });
});

// ── single-field divergences ────────────────────────────────────────────────

describe('compareShadowVsCanonical — commitment field divergences', () => {
  it('lifecycle differs → commitment-lifecycle', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    // First call — divergence first observed at NOW (firstObservedAt). Both sides
    // have stale observations (SETTLED) so suppression check `eitherFresh` is false
    // → emit-worthy immediately.
    const payload = compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED);
    expect(payload).not.toBeNull();
    expect(payload?.count).toBe(1);
    expect(payload?.byField['commitment-lifecycle']).toBe(1);
    expect(payload?.examples[0]).toMatchObject({
      field: 'commitment-lifecycle',
      key: '0xabc',
      canonical: 'partiallyFilled',
      shadow: 'visibleOpen',
    });
  });

  it('filledRiskWei6 differs → commitment-filled', () => {
    const state = stateWithCommitment(canonicalCommitment({ filledRiskWei6: '100000' }));
    const shadow = shadowWithCommitment(shadowCommitment({ filledRiskWei6: '50000' }));
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['commitment-filled']).toBe(1);
  });

  it('lifecycle AND filledRiskWei6 differ → both reported (count=2)', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled', filledRiskWei6: '100000' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen', filledRiskWei6: '50000' }));
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.count).toBe(2);
    expect(payload?.byField['commitment-lifecycle']).toBe(1);
    expect(payload?.byField['commitment-filled']).toBe(1);
  });
});

describe('compareShadowVsCanonical — position field divergences', () => {
  it('status differs → position-status', () => {
    const state = stateWithPosition('spec-1:away', canonicalPosition({ status: 'pendingSettle' }));
    const shadow = shadowWithPosition('spec-1:away', shadowPosition({ status: 'active' }));
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['position-status']).toBe(1);
  });

  it('riskAmountWei6 differs → position-risk', () => {
    const state = stateWithPosition('spec-1:away', canonicalPosition({ riskAmountWei6: '200000' }));
    const shadow = shadowWithPosition('spec-1:away', shadowPosition({ riskAmountWei6: '100000' }));
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['position-risk']).toBe(1);
  });
});

// ── missing-side divergences ────────────────────────────────────────────────

describe('compareShadowVsCanonical — missing-side', () => {
  it('canonical-only NON-TERMINAL commitment → missing-in-stream', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'visibleOpen' }));
    const payload = compareShadowVsCanonical(state, emptyOwnStateShadow(), new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['missing-in-stream']).toBe(1);
  });

  it('canonical-only TERMINAL commitment → NOT reported (expected drift)', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'filled' }));
    const payload = compareShadowVsCanonical(state, emptyOwnStateShadow(), new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload).toBeNull();
  });

  it('shadow-only commitment → missing-in-poll', () => {
    const shadow = shadowWithCommitment(shadowCommitment());
    const payload = compareShadowVsCanonical(emptyMakerState(), shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['missing-in-poll']).toBe(1);
  });

  it('canonical-only CLAIMED position → NOT reported (terminal drift)', () => {
    const state = stateWithPosition('spec-1:away', canonicalPosition({ status: 'claimed' }));
    expect(compareShadowVsCanonical(state, emptyOwnStateShadow(), new Map(), NOW, TOLERANCE, SETTLED)).toBeNull();
  });

  it('canonical-only ACTIVE position → missing-in-stream', () => {
    const state = stateWithPosition('spec-1:away', canonicalPosition({ status: 'active' }));
    const payload = compareShadowVsCanonical(state, emptyOwnStateShadow(), new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.byField['missing-in-stream']).toBe(1);
  });
});

// ── tolerance window ────────────────────────────────────────────────────────

describe('compareShadowVsCanonical — tolerance window', () => {
  it('SUPPRESSES a fresh divergence when EITHER side\'s last observation is within toleranceMs', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    shadow.lastEventAtMs = FRESH; // stream fresh → suppress
    const tracker = new Map<string, TrackedDivergence>();
    expect(compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED)).toBeNull();
    // Divergence IS tracked (so it can persist past tolerance) even though suppressed.
    expect(tracker.size).toBe(1);
  });

  it('SUPPRESSES when poll side is fresh too', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    shadow.lastEventAtMs = SETTLED;
    expect(compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, FRESH /* lastPoll fresh */)).toBeNull();
  });

  it('EMITS when both sides have settled (older than toleranceMs)', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    shadow.lastEventAtMs = SETTLED;
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload).not.toBeNull();
  });

  it('persistent mismatch (age >= toleranceMs) is EMITTED regardless of source-side freshness', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    shadow.lastEventAtMs = FRESH; // stream-side fresh — would normally suppress

    const tracker = new Map<string, TrackedDivergence>();
    // First detection: suppressed (fresh + new).
    expect(compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED)).toBeNull();
    // Re-detection past the tolerance window — even though stream is still
    // "fresh" relative to laterNow, the divergence has aged past TOLERANCE.
    const laterNow = NOW + TOLERANCE + 1;
    shadow.lastEventAtMs = laterNow - 100; // still fresh
    const payload = compareShadowVsCanonical(state, shadow, tracker, laterNow, TOLERANCE, laterNow - 100);
    expect(payload).not.toBeNull();
    expect(payload?.count).toBe(1);
  });
});

// ── tracker lifecycle ────────────────────────────────────────────────────────

describe('compareShadowVsCanonical — tracker lifecycle', () => {
  it('cleared divergence is removed from the tracker on the next pass', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED);
    expect(tracker.size).toBe(1);
    // Resolve the divergence — both sides agree now.
    shadow.commitments['0xabc']!.lifecycle = 'partiallyFilled';
    const payload = compareShadowVsCanonical(state, shadow, tracker, NOW + 100, TOLERANCE, SETTLED);
    expect(payload).toBeNull();
    expect(tracker.size).toBe(0); // cleared
  });

  it('persisting divergence keeps its original firstObservedAtMs', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED);
    const firstObs = [...tracker.values()][0]?.firstObservedAtMs;
    compareShadowVsCanonical(state, shadow, tracker, NOW + 1000, TOLERANCE, SETTLED);
    expect([...tracker.values()][0]?.firstObservedAtMs).toBe(firstObs);
  });

  it('sinceMs reports the age of the OLDEST currently-emit-worthy divergence', () => {
    const state = stateWithCommitment(canonicalCommitment({ lifecycle: 'partiallyFilled' }));
    state.positions['spec-1:away'] = canonicalPosition({ status: 'pendingSettle' });
    const shadow = shadowWithCommitment(shadowCommitment({ lifecycle: 'visibleOpen' }));
    shadow.positions['spec-1:away'] = shadowPosition({ status: 'active' });
    const tracker = new Map<string, TrackedDivergence>();
    // Pass 1 at NOW — both divergences first observed at NOW.
    compareShadowVsCanonical(state, shadow, tracker, NOW, TOLERANCE, SETTLED);
    // Pass 2 at NOW + 3000 — both still divergent, ages 3000ms.
    const payload = compareShadowVsCanonical(state, shadow, tracker, NOW + 3000, TOLERANCE, SETTLED);
    expect(payload?.sinceMs).toBe(3000);
  });
});

// ── aggregation ──────────────────────────────────────────────────────────────

describe('compareShadowVsCanonical — aggregation', () => {
  it('many divergences in one pass → single payload with count=N, examples ≤ 5', () => {
    const state = emptyMakerState();
    const shadow = emptyOwnStateShadow();
    shadow.lastEventAtMs = SETTLED;
    for (let i = 0; i < 10; i++) {
      const hash = `0x${i.toString().padStart(40, '0')}`;
      state.commitments[hash] = canonicalCommitment({ hash, lifecycle: 'partiallyFilled' });
      shadow.commitments[hash] = shadowCommitment({ hash, lifecycle: 'visibleOpen' });
    }
    const payload = compareShadowVsCanonical(state, shadow, new Map(), NOW, TOLERANCE, SETTLED);
    expect(payload?.count).toBe(10);
    expect(payload?.byField['commitment-lifecycle']).toBe(10);
    expect(payload?.examples.length).toBe(5);
  });
});
