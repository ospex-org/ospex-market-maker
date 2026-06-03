/**
 * Owner (SSE-source) reducer implementations + projection helpers +
 * `OwnStateShadow` type (Phase 2 PR4b).
 *
 * Architectural contract from Hermes review of `phase2-feedback.md` blocker 5:
 * only `reduceOwnerFill` mutates shadow positions; `reduceOwnerCommitmentObservation`
 * converges lifecycle/cumulative on shadow commitments but NEVER touches positions
 * (would double-count `reduceOwnerFill`'s fill-event-driven path). The type
 * system forbids crossing the canonical `MakerState` and shadow `OwnStateShadow`
 * surfaces — see `src/reducers/owner.test.ts` for the compile-time guard.
 *
 * Layering:
 *   PR2 — signatures + empty stub bodies + compile-time source-confusion guards.
 *   PR3 — wakeable runner + queue infra; stubs drain to no-op.
 *   PR4a — adapter wiring + handlers + snapshot baseline accumulation + atomic
 *          swap on `onReady` + `projectOwner*` helpers (originally inline in
 *          the runner; moved here in PR4b so the per-event reducers can reuse).
 *   PR4b — REAL reducer bodies (this PR): per-event delta application after
 *          `onReady` lands the baseline. Idempotent on no-change; fills dedupe
 *          via `(txHash, logIndex)` against the runner's process-lifetime
 *          dedup-set.
 *
 * Phase 2 shadow-only invariant: ALL writes here target `OwnStateShadow`.
 * No canonical `MakerState` writes — Phase 3 cutover flips the source.
 */

import type { Fill, OwnerCommitment, OwnerPosition, PositionLifecycle, PositionStatusEvent } from '../ospex/index.js';
import { fillDedupKey, type MakerPositionStatus, type MakerSide } from '../state/index.js';

import type { ReducerDescriptor } from './descriptors.js';

/** A commitment as projected from the SSE `commitment` event body. PR4a projects snapshot pages into this shape via `projectOwnerCommitment`; PR4b's `reduceOwnerCommitmentObservation` re-projects on every delta event. */
export interface ShadowCommitment {
  hash: string;
  lifecycle: 'visibleOpen' | 'softCancelled' | 'partiallyFilled' | 'filled' | 'expired' | 'authoritativelyInvalidated';
  filledRiskWei6: string;
  riskAmountWei6: string;
  expiryUnixSec: number;
}

/** A position as projected from the SSE snapshot positions. PR4a projects snapshot pages via `projectOwnerPosition`; PR4b's per-event reducers update incrementally. */
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
 * dedup). Shape extended in PR4a for `lastStatus` / `lastError` + Hermes #68
 * round-2 `positionsTruncated`.
 */
export interface OwnStateShadow {
  /** `false` until `onReady` fires (the snapshot has fully baselined), or while a resync is pending. */
  ready: boolean;
  /**
   * Instantaneous EDGE-latch health MIRROR, re-derived by the runner's
   * `recomputeOwnStateHealth()` at every latch-mutation site (Phase 3 PR2). It is
   * the conjunction of the EVENT-DRIVEN (non-time-dependent) §5 latches — `ready`
   * (a durable baseline is swapped in), `lastStatus === 'connected'`,
   * `!streamOverflowDegraded`, `!positionsTruncated`, `lastError.reason !==
   * 'fatal'`, and `!tokenRefreshFailureInFlight` (latch 7, PR2b).
   *
   * It deliberately does NOT include the TIME-dependent latches, which decay with
   * no SDK event and so cannot live as a stored bit: latch 2 `transportFresh`
   * (PR2b — a frame within `staleMaxMs`) and the recovery hold (latch 8). Both are
   * evaluated at READ time in the runner: the divergence comparator gates on
   * `instantOwnStateHealthy()` (this mirror AND `transportFresh`), while only the
   * posting gate `ownStateHealthy()` additionally applies the recovery hold.
   *
   * Nor does it include the POSTING-only latches now wired into `ownStateHealthy()`
   * — latch 6 `indexerLagDegraded` (PR2c-i) and latch 5 `auditDivergenceUnresolved`
   * (PR2c-ii). Those are posting-safety signals, not shadow-freshness ones; latch 5
   * in particular MUST stay out of this mirror because the comparator reads the
   * mirror (via `instantOwnStateHealthy`) AND produces latch 5 — folding it in would
   * self-deadlock the very comparison that clears it.
   *
   * The factory default is `false` — a fresh, never-baselined shadow (`ready:
   * false`, `lastStatus: null`) is not healthy, matching what the conjunction
   * derives. The runner's `recomputeOwnStateHealth()` keeps it in sync from the
   * first latch mutation on.
   */
  healthy: boolean;
  /** Hash → projected commitment. PR4a's `onReady` swaps the baseline in; PR4b applies per-commitment-event deltas via `reduceOwnerCommitmentObservation`. */
  commitments: Record<string, ShadowCommitment>;
  /** `${speculationId}:${side}` → projected position. PR4a's `onReady` swaps the baseline in; PR4b applies per-position-status-event deltas via `reduceOwnerPositionStatus` and per-fill mutations via `reduceOwnerFill`. */
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

/** Owner commitment-body event shape. PR4b aliases the SDK's `OwnerCommitment` directly. */
export type OwnerCommitmentBody = OwnerCommitment;
/** Owner fill-body event shape. PR4b aliases the SDK's `Fill` directly. Dedup key is `(txHash, logIndex)`. */
export type OwnerFillBody = Fill;
/** Owner position-status-body event shape. PR4b aliases the SDK's `PositionStatusEvent` directly. */
export type OwnerPositionStatusBody = PositionStatusEvent;

// ── projection helpers (moved from src/runners/index.ts in PR4b) ──────────────

/**
 * Project an SDK `OwnerCommitment` (the owner-auth maker view delivered via
 * SSE) to the shadow's narrow `ShadowCommitment` shape. The projection maps
 * the SDK's effective `status` + signals to a `CommitmentLifecycle` matching
 * the canonical (`MakerCommitmentRecord`) lifecycle vocabulary so the PR5
 * comparator can compare apples to apples.
 *
 * Lifecycle routing precedence (mirrors the poll-side
 * `reducePolledCommitmentObservation`):
 *   - FULL fill (`filledRiskAmount >= riskAmount`) → `'filled'`.
 *   - AUTH (`storedStatus === 'cancelled'` || `nonceInvalidated`) → `'authoritativelyInvalidated'`.
 *   - Effective `'expired'` → `'expired'`.
 *   - Effective `'cancelled'` (book-hidden but not AUTH) → `'softCancelled'`.
 *   - Effective `'filled'` (cumulative not at risk yet — unusual; trust the API) → `'filled'`.
 *   - Effective `'open'` or `'partially_filled'` with `filledRiskAmount > 0` → `'partiallyFilled'`.
 *   - Effective `'open'` → `'visibleOpen'`.
 */
export function projectOwnerCommitment(c: OwnerCommitment): ShadowCommitment {
  const filled = BigInt(c.filledRiskAmount);
  const risk = BigInt(c.riskAmount);
  let lifecycle: ShadowCommitment['lifecycle'];
  if (filled >= risk) {
    lifecycle = 'filled';
  } else if (c.storedStatus === 'cancelled' || c.nonceInvalidated) {
    lifecycle = 'authoritativelyInvalidated';
  } else if (c.status === 'expired') {
    lifecycle = 'expired';
  } else if (c.status === 'cancelled') {
    lifecycle = 'softCancelled';
  } else if (c.status === 'filled') {
    lifecycle = 'filled';
  } else if (filled > 0n) {
    lifecycle = 'partiallyFilled';
  } else {
    lifecycle = 'visibleOpen';
  }
  // OwnerCommitment.expiry is ISO-8601 string or null. Convert to unix seconds;
  // null → 0 (defensive — the comparator's expiry check will not match canonical).
  const expiryUnixSec = c.expiry === null ? 0 : Math.floor(new Date(c.expiry).getTime() / 1000);
  return {
    hash: c.commitmentHash,
    lifecycle,
    filledRiskWei6: c.filledRiskAmount,
    riskAmountWei6: c.riskAmount,
    expiryUnixSec,
  };
}

/**
 * Project an SDK `OwnerPosition` (from a snapshot page) to the shadow's
 * `ShadowPosition`. `positionType` 0=away, 1=home (canonical Ospex
 * protocol mapping). Returns the projection; the SDK's `OwnerPosition`
 * discriminator excludes `settledLost` / `void`, so the status maps 1:1
 * to `MakerPositionStatus` for the four states the snapshot carries.
 */
export function projectOwnerPosition(p: OwnerPosition): ShadowPosition {
  const side: MakerSide = p.positionType === 0 ? 'away' : 'home';
  return {
    speculationId: p.speculationId,
    side,
    riskAmountWei6: Math.round(p.riskAmountUSDC * 1_000_000).toString(),
    status: p.status,
  };
}

/**
 * Strict forward-only ordering of `MakerPositionStatus` — used by
 * `reduceOwnerPositionStatus` to reject backwards transitions (e.g. a
 * `claimable` shadow position being reported back in `active`). Mirrors
 * the poll-side `positionStatusRank` in `src/reducers/poll.ts`.
 */
function positionStatusRank(s: MakerPositionStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'pendingSettle': return 1;
    case 'claimable': return 2;
    // The terminal triple share the top rank — no forward transition leaves any
    // of them. The shadow collapses settledLost/void → claimed, so those two
    // arms are unreachable here; they exist for exhaustiveness over the extended
    // MakerPositionStatus.
    case 'claimed': return 3;
    case 'settledLost': return 3;
    case 'void': return 3;
  }
}

/**
 * Map the SDK's wider `PositionLifecycle` enum to the narrower
 * `MakerPositionStatus` the shadow tracks. The SDK enum includes terminal
 * `'settledLost'` and `'void'` states that the snapshot's `OwnerPosition`
 * discriminator drops (zero-payout rows); the SSE stream's `positionStatus`
 * events emit those transitions explicitly so consumers close local
 * lifecycle cleanly. Both terminal-but-not-claimed states collapse to
 * `'claimed'` for shadow purposes — the position is settled and there's
 * nothing further to act on.
 */
function mapPositionLifecycle(s: PositionLifecycle): MakerPositionStatus {
  switch (s) {
    case 'active': return 'active';
    case 'pendingSettle': return 'pendingSettle';
    case 'claimable': return 'claimable';
    case 'claimed': return 'claimed';
    case 'settledLost': return 'claimed';
    case 'void': return 'claimed';
  }
}

// ── reducers ──────────────────────────────────────────────────────────────────

/**
 * Apply one SSE `commitment` delta event to the shadow. Re-projects the SDK's
 * `OwnerCommitment` via {@link projectOwnerCommitment} and inserts/replaces in
 * `target.commitments[commitmentHash]`. **Never mutates `target.positions`**
 * (blocker 5: position bumps from cumulative deltas would double-count
 * `reduceOwnerFill`'s fill-event-driven path).
 *
 * Idempotent on no-change — a re-emitted event for the same on-chain state
 * produces the same projection; the replace is byte-identical.
 *
 * Phase 2 invariant: writes target `OwnStateShadow` only. The type system
 * forbids passing `MakerState` (compile-time guard in `owner.test.ts`).
 */
export function reduceOwnerCommitmentObservation(
  target: OwnStateShadow,
  body: OwnerCommitment,
  _now: number,
): ReducerDescriptor[] {
  target.commitments[body.commitmentHash] = projectOwnerCommitment(body);
  return [];
}

/**
 * Apply one SSE `fill` delta event to the shadow. Dedupes against
 * `(txHash, logIndex)` via {@link fillDedupKey} — a re-delivered fill from
 * an SDK resume/catchup is a runtime no-op.
 *
 * **Maker side (`body.maker === ourAddress`)**: extends the maker-side
 * position's `riskAmountWei6`. **Does NOT touch the commitment's
 * `filledRiskWei6`** — that bump comes from `reduceOwnerCommitmentObservation`
 * (which the indexer fires for the same on-chain Match). Updating it here
 * too would double-count the cumulative when both events fire (their
 * orderings are independent across SSE).
 *
 * **Taker side (`body.taker === ourAddress`)**: extends the taker-side
 * position only. The MM doesn't take in Phase 2 — this branch is defensive.
 *
 * **Neither side ours**: emits an `OwnerFillForeignAddress` error descriptor.
 * The SSE subscription is owner-scoped so this shouldn't happen; if it does,
 * surface the anomaly rather than silently mis-applying.
 *
 * Phase 2 invariant — this reducer is the SOLE shadow-position mutator on the
 * owner side (blocker 5).
 */
export function reduceOwnerFill(
  target: OwnStateShadow,
  body: Fill,
  dedupSet: Set<string>,
  ourAddress: string,
  _now: number,
): ReducerDescriptor[] {
  const key = fillDedupKey(body.txHash, body.logIndex);
  if (dedupSet.has(key)) return []; // already applied — idempotent on resume/catchup
  dedupSet.add(key);

  const descriptors: ReducerDescriptor[] = [];
  const lowerAddress = ourAddress.toLowerCase();
  const isMaker = body.maker.toLowerCase() === lowerAddress;
  const isTaker = body.taker.toLowerCase() === lowerAddress;

  if (!isMaker && !isTaker) {
    // Anomaly — fill is for an address neither side matches. SDK subscription
    // is owner-scoped, so this shouldn't fire; emit + skip.
    descriptors.push({
      kind: 'emit-error',
      payload: {
        class: 'OwnerFillForeignAddress',
        detail: `fill ${body.txHash}:${body.logIndex} has neither maker (${body.maker}) nor taker (${body.taker}) matching our address (${lowerAddress})`,
        phase: 'own-state-stream',
      },
    });
    return descriptors;
  }

  const ourPositionType: 0 | 1 = isMaker ? body.makerPositionType : body.takerPositionType;
  const ourRiskAmount: string = isMaker ? body.makerRiskAmount : body.takerRiskAmount;
  const side: MakerSide = ourPositionType === 0 ? 'away' : 'home';

  // Update / insert shadow position on our side.
  // (Commitment cumulative is owned by `reduceOwnerCommitmentObservation` —
  // see the JSDoc above; touching `c.filledRiskWei6` here would double-count
  // when both events fire for the same on-chain Match.)
  const posKey = `${body.speculationId}:${side}`;
  const existing = target.positions[posKey];
  if (existing === undefined) {
    target.positions[posKey] = {
      speculationId: body.speculationId,
      side,
      riskAmountWei6: ourRiskAmount,
      status: 'active', // a position created by a fill is `active` until pendingSettle
    };
  } else {
    existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + BigInt(ourRiskAmount)).toString();
  }
  return descriptors;
}

/**
 * Apply one SSE `positionStatus` delta event to the shadow. Updates only
 * `target.positions[key].status` — does NOT touch `riskAmountWei6` (positions
 * are created/extended by `reduceOwnerFill` from the fill stream).
 *
 * Forward-only: a backwards transition (e.g. a `claimable` shadow reported
 * back in `active`) emits an `OwnerBackwardsPositionTransition` error and is
 * refused. Mirrors the poll-side guard in `reducePolledPositionObservation`.
 *
 * Unknown-position events (no shadow entry for the `(speculationId, side)`
 * key) emit `OwnerPositionStatusForUnknownPosition` and skip — the position
 * will be materialized by the next `reduceOwnerFill` for that speculation
 * (which carries enough fields to construct the row).
 */
export function reduceOwnerPositionStatus(
  target: OwnStateShadow,
  body: PositionStatusEvent,
  _now: number,
): ReducerDescriptor[] {
  const side: MakerSide = body.positionType === 0 ? 'away' : 'home';
  const key = `${body.speculationId}:${side}`;
  const existing = target.positions[key];
  const mappedStatus = mapPositionLifecycle(body.status);
  if (existing === undefined) {
    return [{
      kind: 'emit-error',
      payload: {
        class: 'OwnerPositionStatusForUnknownPosition',
        detail: `position-status event for (${body.speculationId}, ${side}) → '${body.status}' but no shadow position exists; the next fill will materialize it`,
        phase: 'own-state-stream',
        speculationId: body.speculationId,
      },
    }];
  }
  if (positionStatusRank(mappedStatus) < positionStatusRank(existing.status)) {
    return [{
      kind: 'emit-error',
      payload: {
        class: 'OwnerBackwardsPositionTransition',
        detail: `position-status event reports (${body.speculationId}, ${side}) as '${body.status}' (→ '${mappedStatus}') but shadow has it at '${existing.status}' — refusing to revert`,
        phase: 'own-state-stream',
        speculationId: body.speculationId,
      },
    }];
  }
  existing.status = mappedStatus;
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
    healthy: false,
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
