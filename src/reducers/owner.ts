/**
 * Owner (SSE-source) reducer signatures + `OwnStateShadow` projection type.
 *
 * **Phase 2 PR2 ships SIGNATURES + stub bodies only.** Real implementations land
 * in PR4b alongside the dedup-set construction (PR4a wires the SSE adapter +
 * baseline projection + lifecycle invariant but leaves these reducers as
 * stubs). The signatures are declared here so PR3's wakeable runner can
 * type-check against the `OwnStateShadow` target without waiting for the
 * implementations — the typed separation between canonical (`MakerState`)
 * and shadow (`OwnStateShadow`) targets IS the architectural contract
 * Hermes asked for in `phase2-feedback.md` blocker 5: only `reduceOwnerFill`
 * mutates shadow positions, only `reduceOwnerCommitmentObservation` converges
 * lifecycle/cumulative on shadow commitments. The type system forbids
 * crossing the two state surfaces.
 *
 * Stubs return `[]` and DO NOT mutate the shadow — PR3 wires them through
 * `applyDescriptors(_, 'owner')` so the runner exercises the descriptor
 * pipeline end-to-end before any real owner-side behavior exists. PR4a's
 * `onReady` IS now wired and atomically swaps `pendingBaseline` into the
 * shadow's commitments/positions; PR4b will wire per-event delta application
 * via these reducer bodies.
 */

import type { MakerPositionStatus, MakerSide } from '../state/index.js';

import type { ReducerDescriptor } from './descriptors.js';

/** A commitment as projected from the SSE `commitment` event body. PR4a projects snapshot pages into this shape via `projectOwnerCommitment`; PR4b's per-event reducer will use it for delta application. */
export interface ShadowCommitment {
  hash: string;
  lifecycle: 'visibleOpen' | 'softCancelled' | 'partiallyFilled' | 'filled' | 'expired' | 'authoritativelyInvalidated';
  filledRiskWei6: string;
  riskAmountWei6: string;
  expiryUnixSec: number;
}

/** A position as projected from the SSE `position-status` event body. PR4a projects snapshot pages via `projectOwnerPosition`; PR4b's per-event reducer will use it for delta application. */
export interface ShadowPosition {
  speculationId: string;
  side: MakerSide;
  riskAmountWei6: string;
  status: MakerPositionStatus;
}

/** Transport-level status delivered by the SDK's `onStatus` handler. */
export type ShadowTransportStatus = 'connected' | 'reconnecting' | 'degraded' | 'resync';

/**
 * Projection of canonical state built from the SSE stream. Distinct object identity
 * from `MakerState` (the typed contract): passing `state: MakerState` into an
 * `OwnStateShadow`-targeted reducer is a TypeScript error. See
 * `src/reducers/owner.test.ts` for the compile-time guard.
 *
 * Phase 2: process-lifetime (no disk persistence — cold restart re-snapshots
 * cleanly; `MakerCommitmentRecord.fills[]` from PR1 covers in-process replay
 * dedup). Shape extended in PR4a for `lastStatus` / `lastError` (transport
 * health surface for PR5 comparator preconditions).
 */
export interface OwnStateShadow {
  /** `false` until `onReady` fires (the snapshot has fully baselined), or while a resync is pending. */
  ready: boolean;
  /** `false` on queue overflow, transport-stale, or token-refresh failure. PR5 comparator preconditions check this. */
  healthy: boolean;
  /** Hash → projected commitment. PR4a's `onReady` swaps the baseline in; PR4b will apply per-commitment-event deltas. */
  commitments: Record<string, ShadowCommitment>;
  /** `${speculationId}:${side}` → projected position. PR4a's `onReady` swaps the baseline in; PR4b will apply per-position-status-event deltas. */
  positions: Record<string, ShadowPosition>;
  /**
   * Snapshot pages accumulated before `onReady` fires; merged into
   * `{commitments, positions}` on ready. Stays `null` between resyncs.
   * `truncated` tracks the LATEST page's flag (clears as paging completes).
   * `positionsTruncated` is OR-latched across pages: once any page reports
   * the actionable-positions cap was hit, it stays true through the swap so
   * the comparator can read the explicit incompleteness signal (Hermes #68
   * review — the SDK guarantees a `degraded` status when positions truncate
   * but the runner doesn't rely on event ordering).
   */
  pendingBaseline: {
    commitments: Record<string, ShadowCommitment>;
    positions: Record<string, ShadowPosition>;
    truncated: boolean;
    positionsTruncated: boolean;
  } | null;
  /** Last frame timestamp — used by the transport-fresh check (own-state-sse-plan §2.6). */
  lastEventAtMs: number;
  lastHeartbeatAtMs: number;
  lastReadyAtMs: number;
  /** Latest snapshot's `truncated` flag, surfaced for visibility — flips false on the final page. */
  truncated: boolean;
  /**
   * `true` when the latest baseline reported the actionable-positions cap was
   * hit (SDK's `OwnerStateSnapshot.positionsTruncated`). PR5 comparator
   * reads this as one of the `healthy` derivation inputs: a truncated
   * positions set means the shadow's `positions` map is incomplete and the
   * comparator MUST NOT mark a missing position as divergent. Stays true
   * across `onReady` swaps until a fresh non-truncated baseline lands.
   */
  positionsTruncated: boolean;
  /**
   * Last transport status reported by the SDK's `onStatus` handler. `null`
   * until the first status fires (post-boot). Used by the PR5 comparator
   * alongside `healthy` + `ready` to decide whether to suppress divergence
   * telemetry.
   */
  lastStatus: ShadowTransportStatus | null;
  /**
   * Last transport error reported by the SDK's `onError` handler. `null`
   * until an error fires; cleared when the next `onStatus: 'connected'`
   * fires. Carries the error class + detail string; reasons surfaced by
   * `OspexStreamError` map to the typed field.
   */
  lastError: { class: string; detail: string; reason: string; recordedAtMs: number } | null;
}

/** Owner commitment-body event shape — finalized in PR4b against the SDK's `ownState.subscribe` body types. */
export interface OwnerCommitmentBody {
  // intentionally empty in PR2 — PR4b reads the SDK's exported types and pins fields
  readonly _placeholder?: never;
}

/** Owner fill-body event shape — finalized in PR4b. Carries `(txHash, logIndex)` for the dedup-set lookup. */
export interface OwnerFillBody {
  readonly _placeholder?: never;
}

/** Owner position-status-body event shape — finalized in PR4b. */
export interface OwnerPositionStatusBody {
  readonly _placeholder?: never;
}

/**
 * Owner commitment reducer — converges shadow commitment lifecycle / cumulative
 * fill from the SSE commitment-body event. **Never mutates shadow positions**
 * (blocker 5: position bumps from cumulative deltas would double-count
 * `reduceOwnerFill`'s fill-event-driven path).
 *
 * PR2 stub: returns `[]`, does not touch `target`. PR4b lands the implementation.
 */
export function reduceOwnerCommitmentObservation(
  _target: OwnStateShadow,
  _body: OwnerCommitmentBody,
  _now: number,
): ReducerDescriptor[] {
  return [];
}

/**
 * Owner fill reducer — the EXCLUSIVE mutator of shadow positions for the owner
 * path. Dedupes `(txHash, logIndex)` against `dedupSet` (shared with
 * `MakerCommitmentRecord.fills[]` per PR1's restart-safety model).
 *
 * PR2 stub: returns `[]`, does not touch `target` or `dedupSet`. PR4b lands the
 * implementation.
 */
export function reduceOwnerFill(
  _target: OwnStateShadow,
  _body: OwnerFillBody,
  _dedupSet: Set<string>,
  _now: number,
): ReducerDescriptor[] {
  return [];
}

/**
 * Owner position-status reducer — updates shadow position status only.
 *
 * PR2 stub: returns `[]`, does not touch `target`. PR4b lands the implementation.
 */
export function reduceOwnerPositionStatus(
  _target: OwnStateShadow,
  _body: OwnerPositionStatusBody,
  _now: number,
): ReducerDescriptor[] {
  return [];
}

/**
 * Construct an empty `OwnStateShadow` — the value the runner starts with before
 * any SSE event arrives. PR3 owns the construction site; PR4a wires the SDK
 * subscription that drives transitions out of this state.
 */
export function emptyOwnStateShadow(): OwnStateShadow {
  return {
    ready: false,
    healthy: true,
    commitments: {},
    positions: {},
    pendingBaseline: null,
    lastEventAtMs: 0,
    lastHeartbeatAtMs: 0,
    lastReadyAtMs: 0,
    truncated: false,
    positionsTruncated: false,
    lastStatus: null,
    lastError: null,
  };
}
