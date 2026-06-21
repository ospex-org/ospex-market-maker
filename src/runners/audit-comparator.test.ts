import { describe, expect, it } from 'vitest';

import { emptyMakerState, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';

import { compareAuditVsCanonical, type TrackedDivergence } from './audit-comparator.js';

const NOW = 1_900_000_000_000;
const TOLERANCE = 5000;
const FRESH = NOW - 100; // < TOLERANCE — fresh
const SETTLED = NOW - 10_000; // > TOLERANCE — settled

// ── fixtures ─────────────────────────────────────────────────────────────────
//
// Post-flip (Phase 3 PR3b) BOTH operands are full `MakerState`. The canonical
// (SSE-derived) and audit (poll-derived) books each hold real
// MakerCommitmentRecord / MakerPositionRecord rows — there is no narrow shadow
// projection anymore. `canonical*` / `audit*` builders below produce the same
// record shape; they're named per role for readability at the call sites.

function makerCommitment(overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  const hash = overrides.hash ?? '0xabc';
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    marketType: 'moneyline',
    lineTicks: 0,
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

function makerPosition(overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
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

// ── identity / no-divergence ─────────────────────────────────────────────────

describe('compareAuditVsCanonical — identical states', () => {
  it('returns null when both sides have the same commitment + position', () => {
    const canonical = stateWithCommitment(makerCommitment());
    canonical.positions['spec-1:away'] = makerPosition();
    const audit = stateWithCommitment(makerCommitment());
    audit.positions['spec-1:away'] = makerPosition();
    const tracker = new Map<string, TrackedDivergence>();
    expect(compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
    expect(tracker.size).toBe(0);
  });

  it('returns null when both sides are empty', () => {
    expect(compareAuditVsCanonical(emptyMakerState(), emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
  });
});

// ── single-field divergences ────────────────────────────────────────────────

describe('compareAuditVsCanonical — commitment field divergences', () => {
  it('lifecycle differs → commitment-lifecycle', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    // First call — divergence first observed at NOW (firstObservedAt). Both sides
    // have stale observations (SETTLED) so suppression check `eitherSideFresh` is
    // false → emit-worthy immediately.
    const payload = compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload).not.toBeNull();
    expect(payload?.count).toBe(1);
    expect(payload?.byField['commitment-lifecycle']).toBe(1);
    expect(payload?.examples[0]).toMatchObject({
      field: 'commitment-lifecycle',
      key: '0xabc',
      canonical: 'partiallyFilled',
      audit: 'visibleOpen',
    });
  });

  it('filledRiskWei6 differs → commitment-filled', () => {
    const canonical = stateWithCommitment(makerCommitment({ filledRiskWei6: '100000' }));
    const audit = stateWithCommitment(makerCommitment({ filledRiskWei6: '50000' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['commitment-filled']).toBe(1);
    // Value-level assertion — a regression swapping canonical/audit in the payload
    // would still satisfy the byField count, so pin the exact example values.
    expect(payload?.examples[0]).toMatchObject({
      field: 'commitment-filled',
      key: '0xabc',
      canonical: '100000',
      audit: '50000',
    });
  });

  it('lifecycle AND filledRiskWei6 differ → both reported (count=2)', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled', filledRiskWei6: '100000' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen', filledRiskWei6: '50000' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.count).toBe(2);
    expect(payload?.byField['commitment-lifecycle']).toBe(1);
    expect(payload?.byField['commitment-filled']).toBe(1);
  });
});

describe('compareAuditVsCanonical — position field divergences', () => {
  it('status differs → position-status', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'pendingSettle' }));
    const audit = stateWithPosition('spec-1:away', makerPosition({ status: 'active' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['position-status']).toBe(1);
    // Value-level assertion — guards against a canonical/audit swap in the payload.
    expect(payload?.examples[0]).toMatchObject({
      field: 'position-status',
      key: 'spec-1:away',
      canonical: 'pendingSettle',
      audit: 'active',
    });
  });

  it('riskAmountWei6 differs → position-risk', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ riskAmountWei6: '200000' }));
    const audit = stateWithPosition('spec-1:away', makerPosition({ riskAmountWei6: '100000' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['position-risk']).toBe(1);
    // Value-level assertion — guards against a canonical/audit swap in the payload.
    expect(payload?.examples[0]).toMatchObject({
      field: 'position-risk',
      key: 'spec-1:away',
      canonical: '200000',
      audit: '100000',
    });
  });

  // Post-flip, the audit (poll) path never produces the terminal triple
  // (claimed/settledLost/void) — only the canonical (SSE) mapper does, and it
  // keeps them DISTINCT. A terminal canonical position carries no live exposure,
  // so the comparator EXEMPTS it from the both-present comparison entirely (no
  // shadowEquivalentStatus collapse exists anymore). Any audit-side value — a
  // lagging `active`/`pendingSettle`, or a row missing on the audit side — is
  // expected drift, not divergence.
  it('terminal canonical position (settledLost) vs a lagging audit value → NO divergence (terminal exempt from both-present)', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'settledLost' }));
    const audit = stateWithPosition('spec-1:away', makerPosition({ status: 'active' }));
    expect(compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
  });

  it('terminal canonical position (void) vs a lagging audit value → NO divergence (terminal exempt from both-present)', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'void' }));
    const audit = stateWithPosition('spec-1:away', makerPosition({ status: 'pendingSettle' }));
    expect(compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
  });

  it('terminal canonical position (settledLost) missing on the audit side → NO divergence (terminal exempt from missing-in-audit)', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'settledLost' }));
    expect(compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
  });

  // A NON-terminal canonical status mismatch is still a real divergence — the
  // terminal exemption must not over-swallow live-exposure positions.
  it('non-terminal canonical status (pendingSettle) vs audit active → STILL reports position-status', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'pendingSettle' }));
    const audit = stateWithPosition('spec-1:away', makerPosition({ status: 'active' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['position-status']).toBe(1);
  });
});

// ── missing-side divergences ────────────────────────────────────────────────

describe('compareAuditVsCanonical — missing-side', () => {
  it('canonical(SSE)-only NON-TERMINAL commitment → missing-in-audit', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const payload = compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['missing-in-audit']).toBe(1);
  });

  it('canonical(SSE)-only TERMINAL commitment → NOT reported (expected pruning drift)', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'filled' }));
    const payload = compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload).toBeNull();
  });

  it('audit(poll)-only NON-TERMINAL commitment → missing-in-canonical', () => {
    const audit = stateWithCommitment(makerCommitment());
    const payload = compareAuditVsCanonical(emptyMakerState(), audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['missing-in-canonical']).toBe(1);
  });

  it('audit(poll)-only TERMINAL commitment → NOT reported (Hermes #70 round 2 — symmetric to canonical-only terminal exemption)', () => {
    // Long-running stream scenario: a commitment terminates (filled/expired/
    // authoritativelyInvalidated). Each side's pruneTerminalCommitments deletes
    // it after the retention window (~1 hour) at independent times. Without the
    // symmetric exemption this would be reported as persistent
    // missing-in-canonical divergence forever, poisoning the Phase 2 soak signal.
    for (const lifecycle of ['filled', 'expired', 'authoritativelyInvalidated'] as const) {
      const audit = stateWithCommitment(makerCommitment({ lifecycle }));
      const payload = compareAuditVsCanonical(emptyMakerState(), audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
      expect(payload, `expected no divergence for audit-only ${lifecycle}`).toBeNull();
    }
  });

  it('canonical(SSE)-only CLAIMED position → NOT reported (terminal drift)', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'claimed' }));
    expect(compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED)).toBeNull();
  });

  it('canonical(SSE)-only SETTLEDLOST / VOID position → NOT reported (terminal drift, same as claimed)', () => {
    for (const status of ['settledLost', 'void'] as const) {
      const canonical = stateWithPosition('spec-1:away', makerPosition({ status }));
      expect(compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED), `expected no divergence for canonical-only ${status}`).toBeNull();
    }
  });

  it('canonical(SSE)-only ACTIVE position → missing-in-audit', () => {
    const canonical = stateWithPosition('spec-1:away', makerPosition({ status: 'active' }));
    const payload = compareAuditVsCanonical(canonical, emptyMakerState(), new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['missing-in-audit']).toBe(1);
  });

  it('audit(poll)-only ACTIVE position → missing-in-canonical', () => {
    const audit = stateWithPosition('spec-1:away', makerPosition({ status: 'active' }));
    const payload = compareAuditVsCanonical(emptyMakerState(), audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.byField['missing-in-canonical']).toBe(1);
  });
});

// ── tolerance window ────────────────────────────────────────────────────────

describe('compareAuditVsCanonical — tolerance window', () => {
  it('SUPPRESSES a fresh divergence when the canonical (SSE) side\'s last observation is within toleranceMs', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    // canonical (SSE) obs fresh → suppress; audit obs settled.
    expect(compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, FRESH, SETTLED)).toBeNull();
    // Divergence IS tracked (so it can persist past tolerance) even though suppressed.
    expect(tracker.size).toBe(1);
  });

  it('SUPPRESSES when the audit (poll) side is fresh too', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    // canonical obs settled, audit obs fresh → suppress.
    expect(compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, FRESH)).toBeNull();
  });

  it('EMITS when both sides have settled (older than toleranceMs)', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload).not.toBeNull();
  });

  it('persistent mismatch (age >= toleranceMs) is EMITTED regardless of source-side freshness', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));

    const tracker = new Map<string, TrackedDivergence>();
    // First detection: suppressed (canonical side fresh + new).
    expect(compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, FRESH, SETTLED)).toBeNull();
    // Re-detection past the tolerance window — even though the canonical side is
    // still "fresh" relative to laterNow, the divergence has aged past TOLERANCE.
    const laterNow = NOW + TOLERANCE + 1;
    const payload = compareAuditVsCanonical(canonical, audit, tracker, laterNow, TOLERANCE, laterNow - 100 /* still fresh */, laterNow - 100);
    expect(payload).not.toBeNull();
    expect(payload?.count).toBe(1);
  });
});

// ── tracker lifecycle ────────────────────────────────────────────────────────

describe('compareAuditVsCanonical — tracker lifecycle', () => {
  it('cleared divergence is removed from the tracker on the next pass', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, SETTLED, SETTLED);
    expect(tracker.size).toBe(1);
    // Resolve the divergence — both sides agree now.
    audit.commitments['0xabc']!.lifecycle = 'partiallyFilled';
    const payload = compareAuditVsCanonical(canonical, audit, tracker, NOW + 100, TOLERANCE, SETTLED, SETTLED);
    expect(payload).toBeNull();
    expect(tracker.size).toBe(0); // cleared
  });

  it('persisting divergence keeps its original firstObservedAtMs', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    const tracker = new Map<string, TrackedDivergence>();
    compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, SETTLED, SETTLED);
    const firstObs = [...tracker.values()][0]?.firstObservedAtMs;
    compareAuditVsCanonical(canonical, audit, tracker, NOW + 1000, TOLERANCE, SETTLED, SETTLED);
    expect([...tracker.values()][0]?.firstObservedAtMs).toBe(firstObs);
  });

  it('sinceMs reports the age of the OLDEST currently-emit-worthy divergence', () => {
    const canonical = stateWithCommitment(makerCommitment({ lifecycle: 'partiallyFilled' }));
    canonical.positions['spec-1:away'] = makerPosition({ status: 'pendingSettle' });
    const audit = stateWithCommitment(makerCommitment({ lifecycle: 'visibleOpen' }));
    audit.positions['spec-1:away'] = makerPosition({ status: 'active' });
    const tracker = new Map<string, TrackedDivergence>();
    // Pass 1 at NOW — both divergences first observed at NOW.
    compareAuditVsCanonical(canonical, audit, tracker, NOW, TOLERANCE, SETTLED, SETTLED);
    // Pass 2 at NOW + 3000 — both still divergent, ages 3000ms.
    const payload = compareAuditVsCanonical(canonical, audit, tracker, NOW + 3000, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.sinceMs).toBe(3000);
  });
});

// ── aggregation ──────────────────────────────────────────────────────────────

describe('compareAuditVsCanonical — aggregation', () => {
  it('many divergences in one pass → single payload with count=N, examples ≤ 5', () => {
    const canonical = emptyMakerState();
    const audit = emptyMakerState();
    for (let i = 0; i < 10; i++) {
      const hash = `0x${i.toString().padStart(40, '0')}`;
      canonical.commitments[hash] = makerCommitment({ hash, lifecycle: 'partiallyFilled' });
      audit.commitments[hash] = makerCommitment({ hash, lifecycle: 'visibleOpen' });
    }
    const payload = compareAuditVsCanonical(canonical, audit, new Map(), NOW, TOLERANCE, SETTLED, SETTLED);
    expect(payload?.count).toBe(10);
    expect(payload?.byField['commitment-lifecycle']).toBe(10);
    expect(payload?.examples.length).toBe(5);
  });
});
