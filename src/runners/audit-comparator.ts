/**
 * Audit-vs-canonical comparator (own-state SSE plan §2.5.4 / §6.3; inverted at
 * Phase 3 PR3b's source flip).
 *
 * Pure function comparing the CANONICAL `MakerState` (SSE-derived, the trading
 * source of truth post-flip) against the AUDIT `MakerState` (poll-derived, the
 * slower cross-check). Produces an aggregated `divergence` telemetry payload OR
 * `null` if no emit-worthy divergence exists this tick. The runner gates the
 * CALL via {@link shouldRunAuditComparator}; this module only handles detection
 * + aggregation + tolerance-window suppression.
 *
 * **Pre-flip history:** this was `compareShadowVsCanonical(canonical=poll,
 * shadow=SSE)` — the poll was canonical and the SSE was the audit-only shadow.
 * PR3b inverted the roles, so both operands are now real `MakerState` (the audit
 * side is no longer a narrow shadow projection).
 *
 * **Read-only on both inputs.** No mutation.
 *
 * **Tolerance window**: a divergence is SUPPRESSED while EITHER the canonical
 * (SSE) last observation OR the audit (poll) last observation is within
 * `toleranceMs` — both sources see the same on-chain truth at slightly different
 * walltimes; tolerance suppresses transient skew. **But persistent mismatch is
 * NEVER hidden**: a divergence aged >= `toleranceMs` since first observation is
 * emitted regardless of source-side freshness.
 *
 * **Tracker**: caller-owned `Map<key, TrackedDivergence>`. Newly-detected
 * divergences get `firstObservedAtMs = now`; persisting ones keep theirs;
 * cleared ones are removed.
 */

import { isTerminalPositionStatus, type CommitmentLifecycle, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';

/** The divergence field vocabulary (own-state-sse-plan §6.3, inverted at PR3b). */
export type DivergenceField =
  | 'commitment-lifecycle' // both sides have the hash; lifecycle differs
  | 'commitment-filled' // both sides have the hash; filledRiskWei6 differs
  | 'position-status' // both sides have the position; status differs
  | 'position-risk' // both sides have the position; riskAmountWei6 differs
  | 'missing-in-audit' // canonical (SSE) has it; audit (poll) doesn't
  | 'missing-in-canonical'; // audit (poll) has it; canonical (SSE) doesn't

/** A divergence observation — what the comparator detected for one row + field. */
export interface DivergenceExample {
  field: DivergenceField;
  /** Identifying key: commitmentHash for commitment fields, `${speculationId}:${side}` for position fields. */
  key: string;
  /** Canonical (SSE) value (string, number, or null when missing). */
  canonical: string | number | null;
  /** Audit (poll) value (string, number, or null when missing). */
  audit: string | number | null;
}

/** Per-tracked-divergence persistent state — keyed by `${field}:${key}`. */
export interface TrackedDivergence {
  firstObservedAtMs: number;
  field: DivergenceField;
  key: string;
  canonical: string | number | null;
  audit: string | number | null;
}

/** Aggregated divergence payload returned by the comparator (= `divergence` event payload). */
export interface DivergenceEventPayload {
  /** Total emit-worthy divergences this tick. */
  count: number;
  /** Per-field histogram of `count`. */
  byField: Partial<Record<DivergenceField, number>>;
  /** Up to 5 examples across all fields — operator-facing detail without per-row spam. */
  examples: DivergenceExample[];
  /** Last canonical-side (SSE) event timestamp (ms) at decision time — diagnostic for tolerance debugging. */
  streamObservedAt: number;
  /** Last audit-side (poll) observation timestamp (ms) at decision time — diagnostic for tolerance debugging. */
  pollObservedAt: number;
  /** Age (ms) of the oldest currently-emit-worthy divergence — `now - min(firstObservedAtMs)`. */
  sinceMs: number;
}

const EXAMPLES_PER_TICK = 5;

/** Build the canonical divergence key — used by both the tracker and the dedup-on-emit logic. */
function divergenceKey(field: DivergenceField, identifyingKey: string): string {
  return `${field}:${identifyingKey}`;
}

/**
 * Is the commitment lifecycle terminal? Terminal commitments are pruned from
 * `MakerState` after the retention window (`pruneTerminalCommitments`) on BOTH
 * sides, but at independent times — so a terminal commitment present on only one
 * side is expected pruning drift, not real divergence. The comparator exempts
 * both directions symmetrically (Hermes #70 round 2).
 */
function isTerminalCommitmentLifecycle(lifecycle: string): boolean {
  return lifecycle === 'filled' || lifecycle === 'expired' || lifecycle === 'authoritativelyInvalidated';
}

/**
 * The comparator's main entry point. Walks both states' commitments + positions,
 * updates the tracker, decides which divergences to emit per the tolerance rules,
 * and returns an aggregated payload OR `null` for "nothing to emit".
 *
 * @param canonical         canonical state (SSE-derived) — read-only
 * @param audit             audit state (poll-derived) — read-only
 * @param tracker           caller-owned Map of persisting divergences
 * @param now               wall-clock ms (typically `Date.now()`)
 * @param toleranceMs       suppression window (config.ownState.divergenceToleranceMs)
 * @param canonicalObsAtMs  ms timestamp of the last SSE event applied to canonical
 * @param auditObsAtMs      ms timestamp of the last audit-poll completion
 */
export function compareAuditVsCanonical(
  canonical: MakerState,
  audit: MakerState,
  tracker: Map<string, TrackedDivergence>,
  now: number,
  toleranceMs: number,
  canonicalObsAtMs: number,
  auditObsAtMs: number,
): DivergenceEventPayload | null {
  const detected = new Map<string, { observation: DivergenceExample }>();

  // ── commitment divergences ──────────────────────────────────────────────
  const allCommitmentHashes = new Set<string>([
    ...Object.keys(canonical.commitments),
    ...Object.keys(audit.commitments),
  ]);
  for (const hash of allCommitmentHashes) {
    const canonicalRow: MakerCommitmentRecord | undefined = canonical.commitments[hash];
    const auditRow: MakerCommitmentRecord | undefined = audit.commitments[hash];
    if (canonicalRow !== undefined && auditRow === undefined) {
      // Canonical (SSE) has it; audit (poll) doesn't. EXEMPT terminal: terminal
      // commitments are pruned at independent times on each side — expected drift.
      if (isTerminalCommitmentLifecycle(canonicalRow.lifecycle)) continue;
      const key = divergenceKey('missing-in-audit', hash);
      detected.set(key, { observation: { field: 'missing-in-audit', key: hash, canonical: canonicalRow.lifecycle, audit: null } });
    } else if (canonicalRow === undefined && auditRow !== undefined) {
      // Audit (poll) has it; canonical (SSE) doesn't. SYMMETRIC terminal exemption
      // (Hermes #70 round 2) — same pruning-drift, other direction.
      if (isTerminalCommitmentLifecycle(auditRow.lifecycle)) continue;
      const key = divergenceKey('missing-in-canonical', hash);
      detected.set(key, { observation: { field: 'missing-in-canonical', key: hash, canonical: null, audit: auditRow.lifecycle } });
    } else if (canonicalRow !== undefined && auditRow !== undefined) {
      if (canonicalRow.lifecycle !== (auditRow.lifecycle as CommitmentLifecycle)) {
        const key = divergenceKey('commitment-lifecycle', hash);
        detected.set(key, { observation: { field: 'commitment-lifecycle', key: hash, canonical: canonicalRow.lifecycle, audit: auditRow.lifecycle } });
      }
      if (canonicalRow.filledRiskWei6 !== auditRow.filledRiskWei6) {
        const key = divergenceKey('commitment-filled', hash);
        detected.set(key, { observation: { field: 'commitment-filled', key: hash, canonical: canonicalRow.filledRiskWei6, audit: auditRow.filledRiskWei6 } });
      }
    }
  }

  // ── position divergences ────────────────────────────────────────────────
  const allPositionKeys = new Set<string>([
    ...Object.keys(canonical.positions),
    ...Object.keys(audit.positions),
  ]);
  for (const posKey of allPositionKeys) {
    const canonicalRow: MakerPositionRecord | undefined = canonical.positions[posKey];
    const auditRow: MakerPositionRecord | undefined = audit.positions[posKey];
    if (canonicalRow !== undefined && auditRow === undefined) {
      // Terminal canonical positions (claimed / settledLost / void) carry no live
      // exposure and the audit (poll) path never produces those buckets, so a
      // terminal-only-canonical position is expected drift, not divergence.
      if (isTerminalPositionStatus(canonicalRow.status)) continue;
      const key = divergenceKey('missing-in-audit', posKey);
      detected.set(key, { observation: { field: 'missing-in-audit', key: posKey, canonical: canonicalRow.status, audit: null } });
    } else if (canonicalRow === undefined && auditRow !== undefined) {
      const key = divergenceKey('missing-in-canonical', posKey);
      detected.set(key, { observation: { field: 'missing-in-canonical', key: posKey, canonical: null, audit: auditRow.status } });
    } else if (canonicalRow !== undefined && auditRow !== undefined) {
      // A terminal canonical position is settled — the audit (poll) path can
      // never reach `claimed`/`settledLost`/`void` (it only produces
      // active/pendingSettle/claimable), so its lagging view of a settled
      // position is expected, not divergence. Exempt status + risk both.
      if (isTerminalPositionStatus(canonicalRow.status)) continue;
      if (canonicalRow.status !== auditRow.status) {
        const key = divergenceKey('position-status', posKey);
        detected.set(key, { observation: { field: 'position-status', key: posKey, canonical: canonicalRow.status, audit: auditRow.status } });
      }
      if (canonicalRow.riskAmountWei6 !== auditRow.riskAmountWei6) {
        const key = divergenceKey('position-risk', posKey);
        detected.set(key, { observation: { field: 'position-risk', key: posKey, canonical: canonicalRow.riskAmountWei6, audit: auditRow.riskAmountWei6 } });
      }
    }
  }

  // ── update tracker ──────────────────────────────────────────────────────
  for (const [k, d] of detected) {
    const existing = tracker.get(k);
    if (existing === undefined) {
      tracker.set(k, {
        firstObservedAtMs: now,
        field: d.observation.field,
        key: d.observation.key,
        canonical: d.observation.canonical,
        audit: d.observation.audit,
      });
    } else {
      // Update the observed values so the emitted example reflects the LATEST
      // divergence (not the original) — useful for "what's the current state?".
      existing.canonical = d.observation.canonical;
      existing.audit = d.observation.audit;
    }
  }
  // Remove cleared divergences from the tracker.
  for (const k of [...tracker.keys()]) {
    if (!detected.has(k)) tracker.delete(k);
  }

  // ── decide emit per the tolerance rules ─────────────────────────────────
  // Suppress if EITHER side's last observation is within toleranceMs;
  // BUT persistent divergence (age >= toleranceMs) overrides suppression.
  const canonicalObsAge = canonicalObsAtMs === 0 ? Infinity : now - canonicalObsAtMs;
  const auditObsAge = auditObsAtMs === 0 ? Infinity : now - auditObsAtMs;
  const eitherSideFresh = canonicalObsAge < toleranceMs || auditObsAge < toleranceMs;

  const emitWorthy: TrackedDivergence[] = [];
  for (const tracked of tracker.values()) {
    const age = now - tracked.firstObservedAtMs;
    const persistent = age >= toleranceMs;
    if (persistent || !eitherSideFresh) emitWorthy.push(tracked);
  }
  if (emitWorthy.length === 0) return null;

  // ── aggregate ───────────────────────────────────────────────────────────
  const byField: Partial<Record<DivergenceField, number>> = {};
  for (const d of emitWorthy) {
    byField[d.field] = (byField[d.field] ?? 0) + 1;
  }
  const examples: DivergenceExample[] = emitWorthy.slice(0, EXAMPLES_PER_TICK).map((d) => ({
    field: d.field,
    key: d.key,
    canonical: d.canonical,
    audit: d.audit,
  }));
  const oldestFirstObs = Math.min(...emitWorthy.map((d) => d.firstObservedAtMs));
  const sinceMs = now - oldestFirstObs;

  return {
    count: emitWorthy.length,
    byField,
    examples,
    streamObservedAt: canonicalObsAtMs,
    pollObservedAt: auditObsAtMs,
    sinceMs,
  };
}
