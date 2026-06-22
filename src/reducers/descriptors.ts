/**
 * Reducer descriptor union — every side-effect a reducer can request, expressed as
 * pure data. The runner's `applyDescriptors(descriptors, source)` translates them
 * into telemetry emits + market dirtying + orchestrator-level signals
 * (`pastExpiryLookupFailed`, `softCancelledProbeFailed`).
 *
 * Reducers MUTATE their state target in-place; descriptors carry the
 * not-yet-applied IO + signal effects. This keeps reducers deterministic +
 * unit-testable while preserving the runner's existing emit / dirty side-effects.
 */

import type { MakerSide } from '../state/index.js';

export interface FillEventPayload {
  source: 'commitment-diff' | 'softcancel-recovery' | 'position-poll' | 'own-state-stream';
  commitmentHash?: string;
  positionId?: string;
  speculationId: string;
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  takerSide?: MakerSide;
  makerSide: MakerSide;
  positionType: 0 | 1;
  makerOddsTick?: number;
  newFillWei6: string;
  filledRiskWei6?: string;
  cumulativeRiskWei6?: string;
  partial?: boolean;
  /** The fill's market — `'spread'` | `'total'`; OMITTED for moneyline (the unmarked default — see telemetry `marketTag`), so `summarize` buckets it as `moneyline`. From the originating commitment. */
  market?: 'spread' | 'total';
  /**
   * The maker's ESTIMATED protocol creation-fee share (USDC wei6 decimal string) for THIS fill —
   * present ONLY on the first matched fill of one of the MM's own seed legs, OMITTED otherwise
   * (every existing-speculation match, all moneyline non-seed). A **conservative estimate**, not
   * a realized-fee record: the protocol charges the fee only when a fill lazily CREATES the
   * speculation, which the MM can't observe from own-state, so it assumes its seed's first match
   * created it — exact for a sole seeder, an over-estimate when another maker raced to create the
   * speculation first. Additive (the NDJSON line is byte-identical when absent — every
   * seeding-off / moneyline-only run). The runner records it into `dailyCounters.feeUsdcWei6` and
   * `summarize` sums it into `totalFeeUsdcWei6`.
   */
  feeUsdcWei6?: string;
}

export interface ExpireEventPayload {
  commitmentHash: string;
  speculationId: string;
  contestId: string;
  makerSide: MakerSide;
  oddsTick: number;
}

export interface PositionTransitionEventPayload {
  positionId: string;
  speculationId: string;
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  makerSide: MakerSide;
  positionType: 0 | 1;
  fromStatus: string;
  toStatus: string;
  result?: 'won' | 'push' | 'void';
  predictedWinSide?: 'away' | 'home' | 'over' | 'under' | 'push';
}

export interface ErrorEventPayload {
  class: string;
  detail: string;
  phase: string;
  commitmentHash?: string;
  speculationId?: string;
}

/**
 * An own-state SSE `fill` event arrived for a `commitmentHash` the canonical
 * `MakerState` has no record of (own-state SSE plan §7.2). The canonical fill
 * reducer refuses to materialize an orphan position (a fill alone carries no
 * sport/team identity — that lives on the originating commitment), so it emits
 * this signal instead. The runner translates it into `unknown-own-fill`
 * telemetry + sets the audit-divergence posting hold + requests a cursor-less
 * cold restart (re-snapshot) so a fresh baseline either includes the commitment
 * — and the fill is re-delivered and matches — or it never lands (the correct
 * terminal state for that data inconsistency).
 */
export interface UnknownOwnFillPayload {
  commitmentHash: string;
  speculationId: string;
  txHash: string;
  logIndex: number;
}

export type ReducerDescriptor =
  | { kind: 'emit-fill'; payload: FillEventPayload }
  | { kind: 'emit-expire'; payload: ExpireEventPayload }
  | { kind: 'emit-position-transition'; payload: PositionTransitionEventPayload }
  | { kind: 'emit-error'; payload: ErrorEventPayload }
  | { kind: 'mark-dirty'; contestId: string }
  | { kind: 'signal-past-expiry-lookup-failed' }
  | { kind: 'signal-softcancel-probe-failed' }
  | { kind: 'signal-unknown-own-fill'; payload: UnknownOwnFillPayload };

export interface ApplyDescriptorsResult {
  pastExpiryLookupFailed: boolean;
  softCancelledProbeFailed: boolean;
  /** An own-state `fill` referenced a commitment not in canonical state (§7.2) — the orphan was NOT applied; the runner froze cursor promotion + requested recovery. */
  unknownOwnFill: boolean;
}
