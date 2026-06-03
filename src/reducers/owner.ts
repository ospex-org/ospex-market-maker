/**
 * Owner (SSE-source) reducers + the `OwnStateSession` transport struct
 * (own-state SSE plan §7, Phase 3 PR3b — the SOURCE FLIP).
 *
 * Before PR3b the owner reducers wrote a narrow audit-only `OwnStateShadow` and
 * the POLL path was canonical. PR3b inverts that: when `ownState.subscribe` is
 * true the SSE stream is the CANONICAL writer of `MakerState` and the poll path
 * is demoted to a slower AUDIT source (compared via `compareAuditVsCanonical`).
 * So these reducers now write `MakerState` directly, via the pure PR3a mappers
 * in `owner-mapping.ts` (`mapOwner{Commitment,Position}ToMaker` /
 * `mapPositionStatusEventToMaker`), and emit the same `mark-dirty` /
 * `emit-fill` / `emit-position-transition` descriptors the poll reducers emit
 * so observability + market re-quoting are preserved.
 *
 * Layering of effects:
 *   - The mappers FAIL CLOSED — a payload missing required metadata throws
 *     `OwnerMappingError`; the runner's drain catch turns that into an
 *     `owner-mapping-failed` telemetry event and skips the row (cursor
 *     promotion freezes past it). These reducers therefore do NOT catch — they
 *     let the mapper throw.
 *   - A `fill` for a `commitmentHash` not in canonical state can't be
 *     materialized (a `Fill` carries no sport/team identity — that lives on the
 *     originating commitment). `reduceOwnerFill` emits `signal-unknown-own-fill`
 *     (own-state SSE plan §7.2) and leaves state untouched; the runner recovers
 *     via a cursor-less cold restart.
 *
 * Position identity: a canonical `MakerPositionRecord` needs full denormalized
 * identity (`contestId`/`sport`/`awayTeam`/`homeTeam`). The snapshot baseline
 * supplies it via `mapOwnerPositionToMaker`; a `fill`-created position resolves
 * it from the sibling commitment record (mirrors the poll path's
 * `extendPositionFromCommitmentFill`).
 */

import type { Fill, OwnerCommitment, PositionStatusEvent } from '../ospex/index.js';
import { oppositeSide } from '../pricing/index.js';
import {
  fillDedupKey,
  type MakerCommitmentRecord,
  type MakerPositionRecord,
  type MakerPositionStatus,
  type MakerSide,
  type MakerState,
} from '../state/index.js';
import {
  mapOwnerCommitmentToMaker,
  mapPositionStatusEventToMaker,
} from './owner-mapping.js';

import type { ReducerDescriptor } from './descriptors.js';

/** Transport-level status delivered by the SDK's `onStatus` handler. */
export type OwnStateTransportStatus = 'connected' | 'reconnecting' | 'degraded' | 'resync';

/**
 * SSE-connection / transport + baseline-accumulation state for the own-state
 * stream. Distinct from the canonical book (`MakerState.commitments` /
 * `.positions`), which the SSE reducers now write directly: this struct holds
 * ONLY the connection-health bits the §5 health gate reads + the in-flight
 * snapshot baseline that `onReady` atomically swaps into `MakerState`.
 *
 * Process-lifetime (no disk persistence — cold restart re-snapshots cleanly;
 * `MakerState.ownStateCursor` + `MakerCommitmentRecord.fills[]` cover resume +
 * in-process replay dedup).
 */
export interface OwnStateSession {
  /** `false` until `onReady` fires (the snapshot has fully baselined), or while a resync is pending. */
  ready: boolean;
  /**
   * Instantaneous EDGE-latch health MIRROR, re-derived by the runner's
   * `recomputeOwnStateHealth()` at every latch-mutation site (Phase 3 PR2). The
   * conjunction of the EVENT-DRIVEN §5 latches — `ready`, `lastStatus ===
   * 'connected'`, `!streamOverflowDegraded`, `!positionsTruncated`,
   * `lastError.reason !== 'fatal'`, `!tokenRefreshFailureInFlight`. It excludes
   * the TIME-dependent latches (`transportFresh`, the recovery hold) evaluated
   * at read time, and the POSTING-only latches (`indexerLagDegraded`,
   * `auditDivergenceUnresolved`). The factory default is `false`.
   */
  healthy: boolean;
  /**
   * Snapshot pages accumulated (as CANONICAL records) before `onReady` fires;
   * swapped into `MakerState.commitments` / `.positions` on ready. Stays `null`
   * between resyncs. `truncated` tracks the latest page's flag;
   * `positionsTruncated` is OR-latched across pages (Hermes #68).
   */
  pendingBaseline: {
    commitments: Record<string, MakerCommitmentRecord>;
    positions: Record<string, MakerPositionRecord>;
    truncated: boolean;
    positionsTruncated: boolean;
  } | null;
  /** Last frame timestamp (ms) — used by the transport-fresh check (own-state-sse-plan §2.6). */
  lastEventAtMs: number;
  lastHeartbeatAtMs: number;
  lastReadyAtMs: number;
  /** Latest baseline's `truncated` flag, surfaced for visibility — flips false on the final page. */
  truncated: boolean;
  /**
   * `true` when the latest baseline reported the actionable-positions cap was
   * hit (SDK's `OwnerStateSnapshot.positionsTruncated`). A composite-`healthy`
   * input: a truncated positions set means the SSE-derived positions are
   * incomplete. Stays true across `onReady` swaps until a fresh non-truncated
   * baseline lands.
   */
  positionsTruncated: boolean;
  /** Last transport status from `onStatus`. `null` until the first status fires. */
  lastStatus: OwnStateTransportStatus | null;
  /** Last transport error from `onError`. `null` until an error fires; cleared on the next `connected`. */
  lastError: { class: string; detail: string; reason: string; recordedAtMs: number } | null;
}

/** Owner commitment-body event shape — the SDK's `OwnerCommitment`. */
export type OwnerCommitmentBody = OwnerCommitment;
/** Owner fill-body event shape — the SDK's `Fill`. Dedup key is `(txHash, logIndex)`. */
export type OwnerFillBody = Fill;
/** Owner position-status-body event shape — the SDK's `PositionStatusEvent`. */
export type OwnerPositionStatusBody = PositionStatusEvent;

/**
 * Strict forward-only ordering of `MakerPositionStatus` — used by
 * {@link reduceOwnerPositionStatus} to reject backwards transitions. Mirrors the
 * poll-side `positionStatusRank` in `src/reducers/poll.ts`. The terminal triple
 * (`claimed` / `settledLost` / `void`) shares the top rank.
 */
function positionStatusRank(s: MakerPositionStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'pendingSettle': return 1;
    case 'claimable': return 2;
    case 'claimed': return 3;
    case 'settledLost': return 3;
    case 'void': return 3;
  }
}

// ── reducers (canonical: target MakerState) ────────────────────────────────────

/**
 * Apply one SSE `commitment` delta to canonical {@link MakerState}. Projects the
 * SDK's `OwnerCommitment` via {@link mapOwnerCommitmentToMaker} (which throws
 * `OwnerMappingError` on missing metadata — the runner's drain catch handles it)
 * and inserts/replaces `state.commitments[hash]`.
 *
 * **Preserves the existing record's `fills[]`** across the replace: the mapper
 * sets `fills: []`, but the SSE-fill audit/dedup array is owned by
 * {@link reduceOwnerFill}; a commitment delta (e.g. a `filledRiskWei6` bump)
 * must not wipe it. **Never mutates `state.positions`** (positions are owned by
 * the fill + position-status reducers — bumping them here would double-count).
 *
 * Emits `mark-dirty` on a lifecycle change so the affected market re-reconciles
 * (e.g. a now-`filled` commitment frees the side to re-quote) — mirrors the
 * poll path's `applyFillToRecord`.
 */
export function reduceOwnerCommitmentObservation(
  state: MakerState,
  body: OwnerCommitment,
): ReducerDescriptor[] {
  const mapped = mapOwnerCommitmentToMaker(body);
  const existing = state.commitments[body.commitmentHash];
  if (existing !== undefined) mapped.fills = existing.fills;
  const lifecycleChanged = existing === undefined || existing.lifecycle !== mapped.lifecycle;
  state.commitments[body.commitmentHash] = mapped;
  return lifecycleChanged ? [{ kind: 'mark-dirty', contestId: mapped.contestId }] : [];
}

/**
 * Apply one SSE `fill` delta to canonical {@link MakerState}. Dedupes against
 * `(txHash, logIndex)` via {@link fillDedupKey}.
 *
 * Order (rejection above dispatch):
 *   1. dedup — a re-delivered fill is a no-op.
 *   2. owner-scope guard — a fill matching neither maker nor taker emits
 *      `OwnerFillForeignAddress` (deduped — the owner-scoped subscription makes
 *      this an anomaly that shouldn't recur).
 *   3. §7.2 unknown-own-fill — a `commitmentHash` not in `state.commitments`
 *      can't be materialized (no contest identity on a `Fill`). Emit
 *      `signal-unknown-own-fill` and leave state untouched; the runner recovers
 *      via a cursor-less cold restart whose fresh snapshot reconciles. **Not
 *      deduped** — but the cold restart re-snapshots past it, so it won't recur.
 *      (Taker fills route here too — the matched commitment isn't ours; the MM
 *      never takes, so this is a self-healing defensive path.)
 *
 * On apply: resolves position identity from the sibling commitment (`Fill` lacks
 * `sport`/teams), creates/extends the maker-side `MakerPositionRecord`
 * (accumulating own + counterparty risk), appends to the commitment's `fills[]`,
 * and emits `mark-dirty` + `emit-fill {source: 'own-state-stream'}`. **Does NOT
 * touch the commitment's `filledRiskWei6`** — that bump is owned by
 * {@link reduceOwnerCommitmentObservation} (the indexer fires both events for
 * the same on-chain Match; touching it here too would double-count).
 */
export function reduceOwnerFill(
  state: MakerState,
  body: Fill,
  dedupSet: Set<string>,
  ourAddress: string,
  now: number,
): ReducerDescriptor[] {
  const key = fillDedupKey(body.txHash, body.logIndex);
  if (dedupSet.has(key)) return []; // already applied — idempotent on resume/catchup

  const lowerAddress = ourAddress.toLowerCase();
  const isMaker = body.maker.toLowerCase() === lowerAddress;
  const isTaker = body.taker.toLowerCase() === lowerAddress;
  if (!isMaker && !isTaker) {
    dedupSet.add(key); // anomaly — record it so a re-delivery doesn't re-spam
    return [{
      kind: 'emit-error',
      payload: {
        class: 'OwnerFillForeignAddress',
        detail: `fill ${body.txHash}:${body.logIndex} has neither maker (${body.maker}) nor taker (${body.taker}) matching our address (${lowerAddress})`,
        phase: 'own-state-stream',
      },
    }];
  }

  // §7.2 unknown-own-fill gate — ABOVE any state mutation, NOT deduped.
  const commitment = state.commitments[body.commitmentHash];
  if (commitment === undefined) {
    return [{
      kind: 'signal-unknown-own-fill',
      payload: {
        commitmentHash: body.commitmentHash,
        speculationId: body.speculationId,
        txHash: body.txHash,
        logIndex: body.logIndex,
      },
    }];
  }

  dedupSet.add(key);

  const ourPositionType: 0 | 1 = isMaker ? body.makerPositionType : body.takerPositionType;
  const ourRiskAmount = isMaker ? body.makerRiskAmount : body.takerRiskAmount;
  const counterpartyRiskAmount = isMaker ? body.takerRiskAmount : body.makerRiskAmount;
  const side: MakerSide = ourPositionType === 0 ? 'away' : 'home';
  const fillRisk = BigInt(ourRiskAmount);
  const counterpartyRisk = BigInt(counterpartyRiskAmount);

  const posKey = `${body.speculationId}:${side}`;
  const existing = state.positions[posKey];
  if (existing === undefined) {
    state.positions[posKey] = {
      speculationId: body.speculationId,
      contestId: commitment.contestId,
      sport: commitment.sport,
      awayTeam: commitment.awayTeam,
      homeTeam: commitment.homeTeam,
      side,
      riskAmountWei6: fillRisk.toString(),
      counterpartyRiskWei6: counterpartyRisk.toString(),
      status: 'active', // a position created by a fill is `active` until pendingSettle
      updatedAtUnixSec: now,
    };
  } else {
    existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + fillRisk).toString();
    existing.counterpartyRiskWei6 = (BigInt(existing.counterpartyRiskWei6) + counterpartyRisk).toString();
    existing.updatedAtUnixSec = now;
  }

  // Append to the commitment's observed-fills array (dedup seed + audit). Does
  // NOT touch commitment.filledRiskWei6 (owned by the commitment observation).
  commitment.fills.push({ txHash: body.txHash, logIndex: body.logIndex, amountWei6: fillRisk.toString(), ts: now });

  const cumulativeRiskWei6 = state.positions[posKey]!.riskAmountWei6;
  return [
    { kind: 'mark-dirty', contestId: commitment.contestId },
    {
      kind: 'emit-fill',
      payload: {
        source: 'own-state-stream',
        commitmentHash: body.commitmentHash,
        speculationId: body.speculationId,
        contestId: commitment.contestId,
        sport: commitment.sport,
        awayTeam: commitment.awayTeam,
        homeTeam: commitment.homeTeam,
        takerSide: oppositeSide(side),
        makerSide: side,
        positionType: ourPositionType,
        makerOddsTick: commitment.oddsTick,
        newFillWei6: fillRisk.toString(),
        cumulativeRiskWei6,
      },
    },
  ];
}

/**
 * Apply one SSE `positionStatus` delta to canonical {@link MakerState}. Advances
 * `status` / `result` / `updatedAtUnixSec` of the existing record via the pure
 * {@link mapPositionStatusEventToMaker} (which throws `OwnerMappingError` on an
 * unparseable timestamp — the runner's drain catch handles it).
 *
 * Forward-only: a backwards transition emits `OwnerBackwardsPositionTransition`
 * and is refused (mirrors the poll-side guard). An event for an unknown
 * position emits `OwnerPositionStatusForUnknownPosition` and skips — a
 * `positionStatus` event carries no identity, so the record can't be
 * materialized here; the next `fill` (or a rebaseline snapshot) creates it.
 *
 * Emits `emit-position-transition` on a real status change so the summary
 * walker / scorecard sees the lifecycle move (mirrors the poll path).
 */
export function reduceOwnerPositionStatus(
  state: MakerState,
  body: PositionStatusEvent,
): ReducerDescriptor[] {
  const side: MakerSide = body.positionType === 0 ? 'away' : 'home';
  const key = `${body.speculationId}:${side}`;
  const existing = state.positions[key];
  if (existing === undefined) {
    return [{
      kind: 'emit-error',
      payload: {
        class: 'OwnerPositionStatusForUnknownPosition',
        detail: `position-status event for (${body.speculationId}, ${side}) → '${body.status}' but no canonical position exists; the next fill or rebaseline will materialize it`,
        phase: 'own-state-stream',
        speculationId: body.speculationId,
      },
    }];
  }
  const updated = mapPositionStatusEventToMaker(existing, body);
  if (positionStatusRank(updated.status) < positionStatusRank(existing.status)) {
    return [{
      kind: 'emit-error',
      payload: {
        class: 'OwnerBackwardsPositionTransition',
        detail: `position-status event reports (${body.speculationId}, ${side}) as '${body.status}' (→ '${updated.status}') but canonical has it at '${existing.status}' — refusing to revert`,
        phase: 'own-state-stream',
        speculationId: body.speculationId,
      },
    }];
  }
  const fromStatus = existing.status;
  const statusChanged = fromStatus !== updated.status;
  state.positions[key] = updated;
  if (!statusChanged) return [];
  return [{
    kind: 'emit-position-transition',
    payload: {
      positionId: `${body.speculationId}:${side}`,
      speculationId: body.speculationId,
      contestId: updated.contestId,
      sport: updated.sport,
      awayTeam: updated.awayTeam,
      homeTeam: updated.homeTeam,
      makerSide: side,
      positionType: body.positionType,
      fromStatus,
      toStatus: updated.status,
      ...(updated.result !== undefined ? { result: updated.result } : {}),
    },
  }];
}

/**
 * Construct an empty {@link OwnStateSession} — the value the runner starts with
 * before any SSE event arrives.
 */
export function emptyOwnStateSession(): OwnStateSession {
  return {
    ready: false,
    healthy: false,
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
