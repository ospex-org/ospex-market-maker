/**
 * Shadow-vs-canonical comparator (Phase 2 PR5 — own-state-sse-plan §2.5.4 / §6.3).
 *
 * Pure function comparing `MakerState` (canonical, poll-derived) against
 * `OwnStateShadow` (SSE-derived) at PR4b-or-later steady-state. Produces an
 * aggregated `divergence` telemetry payload OR `null` if no emit-worthy
 * divergence exists this tick. The runner gates the CALL via
 * {@link shouldCompareShadow}; this module only handles detection +
 * aggregation + tolerance-window suppression.
 *
 * **Phase 2 contract**: read-only on both inputs. No mutation; this is the
 * Phase 2 shadow-only invariant's audit pass.
 *
 * **Tolerance window**: a divergence is SUPPRESSED while EITHER the
 * shadow-side last observation OR the poll-side last observation is within
 * `toleranceMs` — both sources see the same on-chain truth at slightly
 * different walltimes; tolerance suppresses transient skew. **But persistent
 * mismatch is NEVER hidden**: a divergence aged >= `toleranceMs` since first
 * observation is emitted regardless of source-side freshness.
 *
 * **Tracker**: caller-owned `Map<key, TrackedDivergence>`. On each call:
 *   - Newly-detected divergences get added with `firstObservedAtMs = now`.
 *   - Persisting divergences keep their original `firstObservedAtMs`.
 *   - Cleared divergences (not detected this pass) are removed.
 *
 * Per `phase2-plan.md` § PR5: only commitment / position field divergences
 * + missing-side cases are reported. The `unknown-own-fill` field is
 * reserved for PR4b's owner-fill reducer when it sees a fill for a hash
 * neither side tracks; not part of this comparator pass.
 */

import { isTerminalPositionStatus, type CommitmentLifecycle, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';
import type { OwnStateShadow, ShadowCommitment, ShadowPosition } from '../reducers/index.js';

/** The divergence field vocabulary (own-state-sse-plan §6.3). */
export type DivergenceField =
  | 'commitment-lifecycle' // both sides have the hash; lifecycle differs
  | 'commitment-filled' // both sides have the hash; filledRiskWei6 differs
  | 'position-status' // both sides have the position; status differs
  | 'position-risk' // both sides have the position; riskAmountWei6 differs
  | 'missing-in-stream' // canonical has it; shadow doesn't
  | 'missing-in-poll'; // shadow has it; canonical doesn't

/** A divergence observation — what the comparator detected for one row + field. */
export interface DivergenceExample {
  field: DivergenceField;
  /** Identifying key: commitmentHash for commitment fields, `${speculationId}:${side}` for position fields. */
  key: string;
  /** Canonical value (string, number, or null when missing). */
  canonical: string | number | null;
  /** Shadow value (string, number, or null when missing). */
  shadow: string | number | null;
}

/** Per-tracked-divergence persistent state — keyed by `${field}:${key}`. */
export interface TrackedDivergence {
  firstObservedAtMs: number;
  field: DivergenceField;
  key: string;
  canonical: string | number | null;
  shadow: string | number | null;
}

/** Aggregated divergence payload returned by the comparator (= `divergence` event payload). */
export interface DivergenceEventPayload {
  /** Total emit-worthy divergences this tick. */
  count: number;
  /** Per-field histogram of `count`. */
  byField: Partial<Record<DivergenceField, number>>;
  /** Up to 5 examples across all fields — operator-facing detail without per-row spam. */
  examples: DivergenceExample[];
  /** Last shadow-side event timestamp (ms) at decision time — diagnostic for tolerance debugging. */
  streamObservedAt: number;
  /** Last poll-side observation timestamp (ms) at decision time — diagnostic for tolerance debugging. */
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
 * canonical `MakerState` after the retention window (`pruneTerminalCommitments`)
 * and the SSE reducer does NOT auto-drop them in Phase 2 — so canonical-only
 * AND shadow-only terminal commitments are both expected lifecycle drift, not
 * real divergence. The comparator exempts both directions symmetrically
 * (Hermes #70 round 2 — shadow-only side was the missing one).
 */
function isTerminalCommitmentLifecycle(lifecycle: string): boolean {
  return lifecycle === 'filled' || lifecycle === 'expired' || lifecycle === 'authoritativelyInvalidated';
}

/**
 * The comparator's main entry point. Walks both states' commitments + positions,
 * updates the tracker, decides which divergences to emit per the tolerance rules,
 * and returns an aggregated payload OR `null` for "nothing to emit".
 *
 * @param state           canonical state (poll-derived) — read-only
 * @param shadow          SSE-derived shadow — read-only
 * @param tracker         caller-owned Map of persisting divergences
 * @param now             wall-clock ms (typically `Date.now()`)
 * @param toleranceMs     suppression window (config.ownState.divergenceToleranceMs)
 * @param lastPollObsAtMs ms timestamp of the last poll-tick completion
 */
export function compareShadowVsCanonical(
  state: MakerState,
  shadow: OwnStateShadow,
  tracker: Map<string, TrackedDivergence>,
  now: number,
  toleranceMs: number,
  lastPollObsAtMs: number,
): DivergenceEventPayload | null {
  const detected = new Map<string, { observation: DivergenceExample }>();

  // ── commitment divergences ──────────────────────────────────────────────
  const allCommitmentHashes = new Set<string>([
    ...Object.keys(state.commitments),
    ...Object.keys(shadow.commitments),
  ]);
  for (const hash of allCommitmentHashes) {
    const canonical: MakerCommitmentRecord | undefined = state.commitments[hash];
    const shadowRow: ShadowCommitment | undefined = shadow.commitments[hash];
    if (canonical !== undefined && shadowRow === undefined) {
      // Canonical has it; shadow doesn't. EXEMPT terminal-only-canonical: the
      // SSE reducer doesn't preserve terminal commitments and the poll path
      // retains them for the retention window — expected drift, not divergence.
      if (isTerminalCommitmentLifecycle(canonical.lifecycle)) continue;
      const key = divergenceKey('missing-in-stream', hash);
      detected.set(key, { observation: { field: 'missing-in-stream', key: hash, canonical: canonical.lifecycle, shadow: null } });
    } else if (canonical === undefined && shadowRow !== undefined) {
      // Shadow has it; canonical doesn't. SYMMETRIC EXEMPTION (Hermes #70
      // round 2): the SSE reducer doesn't auto-drop terminal commitments and
      // canonical prunes them after the retention window — terminal-only-shadow
      // is the same expected drift as terminal-only-canonical, just in the
      // other direction. Without this, a long-running stream would report
      // every filled/expired commitment as persistent `missing-in-poll`
      // divergence ~1 hour after it terminated, poisoning the soak signal.
      if (isTerminalCommitmentLifecycle(shadowRow.lifecycle)) continue;
      const key = divergenceKey('missing-in-poll', hash);
      detected.set(key, { observation: { field: 'missing-in-poll', key: hash, canonical: null, shadow: shadowRow.lifecycle } });
    } else if (canonical !== undefined && shadowRow !== undefined) {
      if (canonical.lifecycle !== (shadowRow.lifecycle as CommitmentLifecycle)) {
        const key = divergenceKey('commitment-lifecycle', hash);
        detected.set(key, { observation: { field: 'commitment-lifecycle', key: hash, canonical: canonical.lifecycle, shadow: shadowRow.lifecycle } });
      }
      if (canonical.filledRiskWei6 !== shadowRow.filledRiskWei6) {
        const key = divergenceKey('commitment-filled', hash);
        detected.set(key, { observation: { field: 'commitment-filled', key: hash, canonical: canonical.filledRiskWei6, shadow: shadowRow.filledRiskWei6 } });
      }
    }
  }

  // ── position divergences ────────────────────────────────────────────────
  const allPositionKeys = new Set<string>([
    ...Object.keys(state.positions),
    ...Object.keys(shadow.positions),
  ]);
  for (const posKey of allPositionKeys) {
    const canonical: MakerPositionRecord | undefined = state.positions[posKey];
    const shadowRow: ShadowPosition | undefined = shadow.positions[posKey];
    if (canonical !== undefined && shadowRow === undefined) {
      // Terminal positions (claimed / settledLost / void) may have been pruned
      // shadow-side; the SSE position-status reducer is forward-only and a
      // terminal-then-cleared shadow is plausible. Skip terminal-only-canonical.
      // (In Phase 2 canonical is poll-written, so only `claimed` occurs; the
      // shared predicate keeps this correct when PR3b's canonical mapper starts
      // producing settledLost / void.)
      if (isTerminalPositionStatus(canonical.status)) continue;
      const key = divergenceKey('missing-in-stream', posKey);
      detected.set(key, { observation: { field: 'missing-in-stream', key: posKey, canonical: canonical.status, shadow: null } });
    } else if (canonical === undefined && shadowRow !== undefined) {
      const key = divergenceKey('missing-in-poll', posKey);
      detected.set(key, { observation: { field: 'missing-in-poll', key: posKey, canonical: null, shadow: shadowRow.status } });
    } else if (canonical !== undefined && shadowRow !== undefined) {
      if (canonical.status !== shadowRow.status) {
        const key = divergenceKey('position-status', posKey);
        detected.set(key, { observation: { field: 'position-status', key: posKey, canonical: canonical.status, shadow: shadowRow.status } });
      }
      if (canonical.riskAmountWei6 !== shadowRow.riskAmountWei6) {
        const key = divergenceKey('position-risk', posKey);
        detected.set(key, { observation: { field: 'position-risk', key: posKey, canonical: canonical.riskAmountWei6, shadow: shadowRow.riskAmountWei6 } });
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
        shadow: d.observation.shadow,
      });
    } else {
      // Update the observed values so the emitted example reflects the LATEST
      // divergence (not the original) — useful for "what's the current state?".
      existing.canonical = d.observation.canonical;
      existing.shadow = d.observation.shadow;
    }
  }
  // Remove cleared divergences from the tracker.
  for (const k of [...tracker.keys()]) {
    if (!detected.has(k)) tracker.delete(k);
  }

  // ── decide emit per the tolerance rules ─────────────────────────────────
  // Suppress if EITHER side's last observation is within toleranceMs;
  // BUT persistent divergence (age >= toleranceMs) overrides suppression.
  const streamObsAge = shadow.lastEventAtMs === 0 ? Infinity : now - shadow.lastEventAtMs;
  const pollObsAge = lastPollObsAtMs === 0 ? Infinity : now - lastPollObsAtMs;
  const eitherSideFresh = streamObsAge < toleranceMs || pollObsAge < toleranceMs;

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
    shadow: d.shadow,
  }));
  const oldestFirstObs = Math.min(...emitWorthy.map((d) => d.firstObservedAtMs));
  const sinceMs = now - oldestFirstObs;

  return {
    count: emitWorthy.length,
    byField,
    examples,
    streamObservedAt: shadow.lastEventAtMs,
    pollObservedAt: lastPollObsAtMs,
    sinceMs,
  };
}
