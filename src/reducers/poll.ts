/**
 * Poll-source reducers — pure (in the "no IO" sense; they DO mutate their target
 * `MakerState` in-place) functions that translate one polled observation into the
 * canonical state mutations + IO descriptors the orchestrator should apply.
 *
 * Behavior is preserved verbatim from `detectFills` / `reconcileSoftCancelledFills` /
 * `pollPositionStatus` / `syncPolledPosition` — see `phase2-pr2-transition-table.md`
 * for the per-row table this module reproduces and the runner-source citations.
 */

import type { Commitment } from '../ospex/index.js';
import { isExpiredForRelease } from '../orders/index.js';
import { oppositeSide, positionTypeForSide } from '../pricing/index.js';
import type {
  CommitmentLifecycle,
  MakerCommitmentRecord,
  MakerPositionRecord,
  MakerPositionStatus,
  MakerSide,
  MakerState,
  MarketType,
} from '../state/index.js';

import type { ReducerDescriptor } from './descriptors.js';

export interface ReducerConfig {
  /** `config.orders.expiryReleaseGraceSeconds` — passed through to `isExpiredForRelease`. */
  expiryReleaseGraceSeconds: number;
}

/**
 * One commitment the poll path observed. The orchestrator's IO layer
 * (`listOpenCommitments` + per-disappeared `getCommitment`) decides which variant
 * each record falls into; the reducer routes from the variant + the record's
 * current lifecycle / clock state.
 */
export type PolledCommitmentObservation =
  | { kind: 'still-listed'; record: MakerCommitmentRecord; apiCommitment: Commitment }
  | { kind: 'disappeared'; record: MakerCommitmentRecord; apiCommitment: Commitment }
  | { kind: 'disappeared-lookup-failed'; record: MakerCommitmentRecord; err: unknown };

/** One polled position from `getPositionStatus`. */
export interface PolledPositionInput {
  positionId: string;
  speculationId: string;
  positionType: 0 | 1;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

// ── private helpers (shared between detectFills + soft-cancel + position paths) ──

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positionStatusRank(s: MakerPositionStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'pendingSettle': return 1;
    case 'claimable': return 2;
    // Terminal triple at the top rank. The poll path only ever produces the
    // first four (the API has no settledLost/void bucket); the last two arms
    // exist for exhaustiveness over the extended MakerPositionStatus.
    case 'claimed': return 3;
    case 'settledLost': return 3;
    case 'void': return 3;
  }
}

/**
 * Extend a `MakerPositionRecord` for `(speculationId, makerSide)` by `deltaWei6` of
 * the maker's filled risk — the position-side bump that `applyFillToRecord` couples
 * to a commitment-record fill. Counterparty risk derives from the commitment's
 * `oddsTick`: `delta × (oddsTick − 100) / 100` is the taker's stake on the other
 * side, which is the maker's winnings if their side wins.
 *
 * Soft-cancel convergence DOES NOT call this — `pollPositionStatus` owns position
 * convergence for the soft-cancel-then-matched path; double-extending here would
 * double-count.
 */
function extendPositionFromCommitmentFill(
  state: MakerState,
  record: MakerCommitmentRecord,
  deltaWei6: bigint,
  now: number,
): void {
  const key = `${record.speculationId}:${record.makerSide}`;
  const counterpartyDelta = (deltaWei6 * BigInt(record.oddsTick - 100)) / 100n;
  const existing = state.positions[key];
  if (existing === undefined) {
    state.positions[key] = {
      speculationId: record.speculationId,
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      marketType: record.marketType, // from the originating commitment
      lineTicks: record.lineTicks,
      side: record.makerSide,
      riskAmountWei6: deltaWei6.toString(),
      counterpartyRiskWei6: counterpartyDelta.toString(),
      status: 'active',
      updatedAtUnixSec: now,
    };
  } else {
    existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + deltaWei6).toString();
    existing.counterpartyRiskWei6 = (BigInt(existing.counterpartyRiskWei6) + counterpartyDelta).toString();
    existing.updatedAtUnixSec = now;
  }
}

/**
 * Apply a fill delta to a commitment record and extend the matching position —
 * the inline equivalent of the runner's former `applyFill` private method. Routes
 * through `extendPositionFromCommitmentFill` for the position bump. Emits one
 * `mark-dirty` + one `emit-fill {source: 'commitment-diff'}` when `delta > 0n`;
 * always reclassifies the record's lifecycle to `finalLifecycle` (re-stamping
 * `updatedAtUnixSec` on a change). `partial` is `true` iff `finalLifecycle ===
 * 'partiallyFilled'`.
 */
function applyFillToRecord(
  state: MakerState,
  record: MakerCommitmentRecord,
  deltaWei6: bigint,
  now: number,
  finalLifecycle: CommitmentLifecycle,
  descriptors: ReducerDescriptor[],
): void {
  if (deltaWei6 > 0n) {
    record.filledRiskWei6 = (BigInt(record.filledRiskWei6) + deltaWei6).toString();
    extendPositionFromCommitmentFill(state, record, deltaWei6, now);
    descriptors.push({ kind: 'mark-dirty', contestId: record.contestId });
    descriptors.push({
      kind: 'emit-fill',
      payload: {
        source: 'commitment-diff',
        commitmentHash: record.hash,
        speculationId: record.speculationId,
        contestId: record.contestId,
        sport: record.sport,
        awayTeam: record.awayTeam,
        homeTeam: record.homeTeam,
        takerSide: oppositeSide(record.makerSide),
        makerSide: record.makerSide,
        positionType: positionTypeForSide(record.makerSide),
        makerOddsTick: record.oddsTick,
        newFillWei6: deltaWei6.toString(),
        filledRiskWei6: record.filledRiskWei6,
        partial: finalLifecycle === 'partiallyFilled',
      },
    });
  }
  if (record.lifecycle !== finalLifecycle) {
    record.lifecycle = finalLifecycle;
    record.updatedAtUnixSec = now;
  }
}

/**
 * Converge ONE commitment record's `filledRiskWei6` up to an authoritative on-chain
 * cumulative — commitment-only, **no position mutation** (the soft-cancel-then-matched
 * position is `pollPositionStatus`'s job — extending here would double-count).
 * No-op when `apiCumulativeWei6 <= localFilled` (idempotent; never decrease). Clamps
 * to the commitment's risk (with an `emit-error {SoftCancelledOverFillClamp}` for
 * the API-anomaly over-fill case — `apiCumulativeWei6 > record.riskAmountWei6`).
 * Reclassifies the lifecycle off the CLAMPED amount, never the API status: a
 * book-hidden commitment with unfilled remainder STAYS `softCancelled`.
 */
function convergeSoftCancelledCumulative(
  record: MakerCommitmentRecord,
  apiCumulativeWei6: bigint,
  now: number,
  descriptors: ReducerDescriptor[],
): void {
  const localFilled = BigInt(record.filledRiskWei6);
  if (apiCumulativeWei6 <= localFilled) return;
  const risk = BigInt(record.riskAmountWei6);
  if (apiCumulativeWei6 > risk) {
    descriptors.push({
      kind: 'emit-error',
      payload: {
        class: 'SoftCancelledOverFillClamp',
        detail: `getCommitment cumulative filledRiskAmount (${apiCumulativeWei6.toString()}) exceeds the commitment's riskAmountWei6 (${record.riskAmountWei6}) — clamping to risk`,
        phase: 'softcancel-recovery',
        commitmentHash: record.hash,
      },
    });
  }
  const clamped = apiCumulativeWei6 > risk ? risk : apiCumulativeWei6;
  const newFill = clamped - localFilled;
  record.filledRiskWei6 = clamped.toString();
  const finalLifecycle: CommitmentLifecycle = clamped >= risk ? 'filled' : 'softCancelled';
  if (record.lifecycle !== finalLifecycle) record.lifecycle = finalLifecycle;
  record.updatedAtUnixSec = now;
  descriptors.push({ kind: 'mark-dirty', contestId: record.contestId });
  descriptors.push({
    kind: 'emit-fill',
    payload: {
      source: 'softcancel-recovery',
      commitmentHash: record.hash,
      speculationId: record.speculationId,
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      takerSide: oppositeSide(record.makerSide),
      makerSide: record.makerSide,
      positionType: positionTypeForSide(record.makerSide),
      makerOddsTick: record.oddsTick,
      newFillWei6: newFill.toString(),
      filledRiskWei6: record.filledRiskWei6,
      partial: finalLifecycle !== 'filled',
    },
  });
}

// ── exported reducers ────────────────────────────────────────────────────────

/**
 * Reduce one polled commitment observation into state mutations + descriptors —
 * the full transition table in `phase2-pr2-transition-table.md` §1. Mutates the
 * record + matching position in `state`; emits descriptors for the orchestrator
 * to translate into telemetry / market-dirtying / past-expiry-lookup signalling.
 *
 * The caller (`detectFills`) is responsible for restricting input to records with
 * lifecycle `{visibleOpen, partiallyFilled}`; the reducer does NOT re-filter.
 * Past-local-expiry records ARE included (a fill that landed just before expiry
 * must be classified before ageOut terminalizes the record).
 */
export function reducePolledCommitmentObservation(
  state: MakerState,
  observation: PolledCommitmentObservation,
  now: number,
  config: ReducerConfig,
): ReducerDescriptor[] {
  const descriptors: ReducerDescriptor[] = [];
  const grace = config.expiryReleaseGraceSeconds;

  if (observation.kind === 'disappeared-lookup-failed') {
    const { record, err } = observation;
    descriptors.push({
      kind: 'emit-error',
      payload: {
        class: errClass(err),
        detail: errMessage(err),
        phase: 'fill-detection-lookup',
        commitmentHash: record.hash,
      },
    });
    if (isExpiredForRelease(record.expiryUnixSec, now, grace)) {
      descriptors.push({ kind: 'signal-past-expiry-lookup-failed' });
    }
    return descriptors;
  }

  const { record, apiCommitment } = observation;
  const apiFilled = BigInt(apiCommitment.filledRiskAmount);
  const localFilled = BigInt(record.filledRiskWei6);
  const delta = apiFilled > localFilled ? apiFilled - localFilled : 0n;
  const riskWei6 = BigInt(record.riskAmountWei6);

  if (observation.kind === 'still-listed') {
    if (delta <= 0n) return descriptors;
    applyFillToRecord(state, record, delta, now, 'partiallyFilled', descriptors);
    return descriptors;
  }

  // observation.kind === 'disappeared'
  const FULL = apiFilled >= riskWei6;
  const AUTH = apiCommitment.storedStatus === 'cancelled' || apiCommitment.nonceInvalidated;

  switch (apiCommitment.status) {
    case 'filled': {
      applyFillToRecord(state, record, delta, now, 'filled', descriptors);
      break;
    }
    case 'expired': {
      if (FULL) {
        applyFillToRecord(state, record, delta, now, 'filled', descriptors);
      } else if (AUTH) {
        applyFillToRecord(state, record, delta, now, 'authoritativelyInvalidated', descriptors);
      } else if (isExpiredForRelease(record.expiryUnixSec, now, grace)) {
        applyFillToRecord(state, record, delta, now, 'expired', descriptors);
        descriptors.push({
          kind: 'emit-expire',
          payload: {
            commitmentHash: record.hash,
            speculationId: record.speculationId,
            contestId: record.contestId,
            makerSide: record.makerSide,
            oddsTick: record.oddsTick,
          },
        });
      } else if (delta > 0n) {
        applyFillToRecord(state, record, delta, now, 'partiallyFilled', descriptors);
      }
      break;
    }
    case 'cancelled': {
      if (AUTH) {
        applyFillToRecord(state, record, delta, now, 'authoritativelyInvalidated', descriptors);
      } else {
        // Inline soft-cancel-style convergence — commitment-only, no position mutation
        // (preserves runner.ts:2150 behavior). After convergence: if the record is
        // still not softCancelled or filled (i.e. delta was 0 and converge early-
        // returned without reclassifying), flip it to softCancelled so the next tick
        // doesn't re-trap this always-"disappeared" book-hidden row.
        convergeSoftCancelledCumulative(record, apiFilled, now, descriptors);
        if (record.lifecycle !== 'softCancelled' && record.lifecycle !== 'filled') {
          record.lifecycle = 'softCancelled';
          record.updatedAtUnixSec = now;
        }
      }
      break;
    }
    default: {
      // status is 'open' / 'partially_filled' yet the commitment dropped from listing —
      // pre-effective-status fallback. Routes off authoritative signals + local clock.
      if (FULL) {
        applyFillToRecord(state, record, delta, now, 'filled', descriptors);
      } else if (apiCommitment.nonceInvalidated) {
        applyFillToRecord(state, record, delta, now, 'authoritativelyInvalidated', descriptors);
      } else if (isExpiredForRelease(record.expiryUnixSec, now, grace)) {
        applyFillToRecord(state, record, delta, now, 'expired', descriptors);
        descriptors.push({
          kind: 'emit-expire',
          payload: {
            commitmentHash: record.hash,
            speculationId: record.speculationId,
            contestId: record.contestId,
            makerSide: record.makerSide,
            oddsTick: record.oddsTick,
          },
        });
      } else if (record.expiryUnixSec <= now) {
        if (delta > 0n) applyFillToRecord(state, record, delta, now, 'partiallyFilled', descriptors);
      } else {
        descriptors.push({
          kind: 'emit-error',
          payload: {
            class: 'UnexpectedFillStatus',
            detail: `disappeared commitment ${record.hash} has status "${apiCommitment.status}"`,
            phase: 'fill-detection',
            commitmentHash: record.hash,
          },
        });
      }
      break;
    }
  }
  return descriptors;
}

/**
 * Reduce one polled soft-cancelled observation — `reconcileSoftCancelledFills`'s
 * per-record probe outcome. Caller restricts to records with lifecycle
 * `'softCancelled'`. Commitment-only, no position mutation.
 *
 * Variants:
 *  - `{kind: 'probed', apiCumulativeWei6}` — `getCommitment` returned a cumulative;
 *    converge per `convergeSoftCancelledCumulative`.
 *  - `{kind: 'probe-failed', err}` — `getCommitment` threw; emit error + signal
 *    `softCancelledProbeFailed` so the tick fails closed (`reconcileMarkets` /
 *    `ageOut` are skipped — see runner.ts:2312 docstring).
 */
export function reducePolledSoftCancelledObservation(
  _state: MakerState,
  observation:
    | { kind: 'probed'; record: MakerCommitmentRecord; apiCumulativeWei6: bigint }
    | { kind: 'probe-failed'; record: MakerCommitmentRecord; err: unknown },
  now: number,
): ReducerDescriptor[] {
  const descriptors: ReducerDescriptor[] = [];
  if (observation.kind === 'probe-failed') {
    descriptors.push({
      kind: 'emit-error',
      payload: {
        class: 'SoftCancelledProbeFailed',
        detail: errMessage(observation.err),
        phase: 'softcancel-recovery',
        commitmentHash: observation.record.hash,
      },
    });
    descriptors.push({ kind: 'signal-softcancel-probe-failed' });
    return descriptors;
  }
  convergeSoftCancelledCumulative(observation.record, observation.apiCumulativeWei6, now, descriptors);
  return descriptors;
}

/**
 * Reduce one polled position from `getPositionStatus`. Caller iterates the three
 * API buckets and tags each call with `apiStatus` ∈ {'active' | 'pendingSettle' |
 * 'claimable'}, the `result` / `predictedWinSide` fields where the bucket carries
 * them. The 1:1 bucket→`MakerPositionStatus` mapping is preserved.
 *
 * Routing precedence: backwards-transition guard → context lookup → apply.
 * `PositionWithoutCommitment` errors when a brand-new position can't be tied to a
 * local commitment on `(speculationId, makerSide)` (the long-running case is
 * handled by carrying the existing record's denormalized context — pruning
 * filled commitments after about an hour shouldn't strand the position).
 */
export function reducePolledPositionObservation(
  state: MakerState,
  apiStatus: 'active' | 'pendingSettle' | 'claimable',
  p: PolledPositionInput,
  result: 'won' | 'push' | 'void' | undefined,
  predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push' | undefined,
  now: number,
): ReducerDescriptor[] {
  const descriptors: ReducerDescriptor[] = [];
  const apiRiskWei6 = BigInt(Math.round(p.riskAmountUSDC * 1_000_000));
  const apiCounterpartyWei6 = BigInt(Math.round(p.profitAmountUSDC * 1_000_000));
  const side: MakerSide = p.positionType === 0 ? 'away' : 'home';
  const key = `${p.speculationId}:${side}`;
  const existing = state.positions[key];
  const localRiskWei6 = existing !== undefined ? BigInt(existing.riskAmountWei6) : 0n;
  const riskGrew = apiRiskWei6 > localRiskWei6;
  const statusChanged = existing !== undefined && existing.status !== apiStatus;
  const resultChanged = existing !== undefined && result !== undefined && existing.result !== result;

  if (existing !== undefined && !riskGrew && !statusChanged && !resultChanged) return descriptors;
  if (existing === undefined && !riskGrew) return descriptors;

  // Backwards-transition guard runs BEFORE the context lookup — a corrupted state
  // shouldn't trigger a spurious PositionWithoutCommitment.
  if (
    existing !== undefined &&
    statusChanged &&
    positionStatusRank(apiStatus) < positionStatusRank(existing.status)
  ) {
    descriptors.push({
      kind: 'emit-error',
      payload: {
        class: 'BackwardsPositionTransition',
        detail: `getPositionStatus reports (${p.speculationId}, ${side}) in bucket '${apiStatus}' but local state has it as '${existing.status}' — refusing to revert`,
        phase: 'position-poll',
        speculationId: p.speculationId,
      },
    });
    return descriptors;
  }

  let context: { contestId: string; sport: string; awayTeam: string; homeTeam: string; marketType: MarketType; lineTicks: number };
  if (existing !== undefined) {
    context = {
      contestId: existing.contestId,
      sport: existing.sport,
      awayTeam: existing.awayTeam,
      homeTeam: existing.homeTeam,
      marketType: existing.marketType,
      lineTicks: existing.lineTicks,
    };
  } else {
    const sourceCommitment = Object.values(state.commitments).find(
      (r) => r.speculationId === p.speculationId && r.makerSide === side,
    );
    if (sourceCommitment === undefined) {
      descriptors.push({
        kind: 'emit-error',
        payload: {
          class: 'PositionWithoutCommitment',
          detail: `getPositionStatus reports a position on (${p.speculationId}, ${side}) but no local commitment with that (speculationId, makerSide) is present — refusing to create an incomplete MakerPositionRecord`,
          phase: 'position-poll',
          speculationId: p.speculationId,
        },
      });
      return descriptors;
    }
    context = {
      contestId: sourceCommitment.contestId,
      sport: sourceCommitment.sport,
      awayTeam: sourceCommitment.awayTeam,
      homeTeam: sourceCommitment.homeTeam,
      marketType: sourceCommitment.marketType,
      lineTicks: sourceCommitment.lineTicks,
    };
  }

  const delta = riskGrew ? apiRiskWei6 - localRiskWei6 : 0n;
  const counterpartyDelta =
    existing !== undefined ? apiCounterpartyWei6 - BigInt(existing.counterpartyRiskWei6) : apiCounterpartyWei6;
  const fromStatus: MakerPositionStatus | undefined = existing?.status;

  if (existing === undefined) {
    const fresh: MakerPositionRecord = {
      speculationId: p.speculationId,
      contestId: context.contestId,
      sport: context.sport,
      awayTeam: context.awayTeam,
      homeTeam: context.homeTeam,
      marketType: context.marketType,
      lineTicks: context.lineTicks,
      side,
      riskAmountWei6: delta.toString(),
      counterpartyRiskWei6: counterpartyDelta > 0n ? counterpartyDelta.toString() : '0',
      status: apiStatus,
      updatedAtUnixSec: now,
    };
    if (result !== undefined) fresh.result = result;
    state.positions[key] = fresh;
  } else {
    if (riskGrew) {
      existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + delta).toString();
      if (counterpartyDelta > 0n) {
        existing.counterpartyRiskWei6 = (BigInt(existing.counterpartyRiskWei6) + counterpartyDelta).toString();
      }
    }
    if (statusChanged) existing.status = apiStatus;
    if (result !== undefined) existing.result = result;
    existing.updatedAtUnixSec = now;
  }

  if (riskGrew) {
    descriptors.push({ kind: 'mark-dirty', contestId: context.contestId });
    descriptors.push({
      kind: 'emit-fill',
      payload: {
        source: 'position-poll',
        positionId: p.positionId,
        speculationId: p.speculationId,
        contestId: context.contestId,
        sport: context.sport,
        awayTeam: context.awayTeam,
        homeTeam: context.homeTeam,
        makerSide: side,
        positionType: p.positionType,
        newFillWei6: delta.toString(),
        cumulativeRiskWei6: (localRiskWei6 + delta).toString(),
      },
    });
  }
  if (existing !== undefined && statusChanged) {
    const payload = {
      positionId: p.positionId,
      speculationId: p.speculationId,
      contestId: context.contestId,
      sport: context.sport,
      awayTeam: context.awayTeam,
      homeTeam: context.homeTeam,
      makerSide: side,
      positionType: p.positionType,
      fromStatus: fromStatus as MakerPositionStatus,
      toStatus: apiStatus,
      ...(result !== undefined ? { result } : {}),
      ...(predictedWinSide !== undefined ? { predictedWinSide } : {}),
    };
    descriptors.push({ kind: 'emit-position-transition', payload });
  }
  return descriptors;
}
