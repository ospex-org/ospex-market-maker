/**
 * Owner (SSE-source) reducer signatures + `OwnStateShadow` projection type.
 *
 * **Phase 2 PR2 ships SIGNATURES + stub bodies only.** Real implementations land
 * in PR4 alongside the SSE adapter wrapper (`subscribeOwnState`). The signatures
 * are declared here so PR3's wakeable runner can type-check against the
 * `OwnStateShadow` target without waiting for the implementations — the typed
 * separation between canonical (`MakerState`) and shadow (`OwnStateShadow`)
 * targets IS the architectural contract Hermes asked for in `phase2-feedback.md`
 * blocker 5: only `reduceOwnerFill` mutates shadow positions, only
 * `reduceOwnerCommitmentObservation` converges lifecycle/cumulative on shadow
 * commitments. The type system forbids crossing the two state surfaces.
 *
 * Stubs return `[]` and DO NOT mutate the shadow — PR3 wires them through
 * `applyDescriptors(_, 'owner')` so the runner exercises the descriptor pipeline
 * end-to-end before any real owner-side behavior exists. The shadow stays
 * `ready: false` throughout Phase 2 until PR4 lands `onReady`.
 */

import type { MakerPositionStatus, MakerSide } from '../state/index.js';

import type { ReducerDescriptor } from './descriptors.js';

/** A commitment as projected from the SSE `commitment` event body — finalized in PR4. */
export interface ShadowCommitment {
  hash: string;
  lifecycle: 'visibleOpen' | 'softCancelled' | 'partiallyFilled' | 'filled' | 'expired' | 'authoritativelyInvalidated';
  filledRiskWei6: string;
  riskAmountWei6: string;
  expiryUnixSec: number;
}

/** A position as projected from the SSE `position-status` event body — finalized in PR4. */
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
  /** Hash → projected commitment. PR4 reduces commitment-body events into this. */
  commitments: Record<string, ShadowCommitment>;
  /** `${speculationId}:${side}` → projected position. PR4 reduces position-status events into this. */
  positions: Record<string, ShadowPosition>;
  /**
   * Snapshot pages accumulated before `onReady` fires; merged into
   * `{commitments, positions}` on ready. Stays `null` between resyncs.
   */
  pendingBaseline: {
    commitments: Record<string, ShadowCommitment>;
    positions: Record<string, ShadowPosition>;
    truncated: boolean;
  } | null;
  /** Last frame timestamp — used by the transport-fresh check (own-state-sse-plan §2.6). */
  lastEventAtMs: number;
  lastHeartbeatAtMs: number;
  lastReadyAtMs: number;
  /** Surfaced from the latest snapshot (`PR4` `onReady`). */
  truncated: boolean;
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

/** Owner commitment-body event shape — finalized in PR4 against the SDK's `ownState.subscribe` body types. */
export interface OwnerCommitmentBody {
  // intentionally empty in PR2 — PR4 reads the SDK's exported types and pins fields
  readonly _placeholder?: never;
}

/** Owner fill-body event shape — finalized in PR4. Carries `(txHash, logIndex)` for the dedup-set lookup. */
export interface OwnerFillBody {
  readonly _placeholder?: never;
}

/** Owner position-status-body event shape — finalized in PR4. */
export interface OwnerPositionStatusBody {
  readonly _placeholder?: never;
}

/**
 * Owner commitment reducer — converges shadow commitment lifecycle / cumulative
 * fill from the SSE commitment-body event. **Never mutates shadow positions**
 * (blocker 5: position bumps from cumulative deltas would double-count
 * `reduceOwnerFill`'s fill-event-driven path).
 *
 * PR2 stub: returns `[]`, does not touch `target`. PR4 lands the implementation.
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
 * PR2 stub: returns `[]`, does not touch `target` or `dedupSet`. PR4 lands the
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
 * PR2 stub: returns `[]`, does not touch `target`. PR4 lands the implementation.
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
 * any SSE event arrives. PR3 owns the construction site; PR4 wires the SDK
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
    lastStatus: null,
    lastError: null,
  };
}
