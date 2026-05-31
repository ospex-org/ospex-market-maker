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
  source: 'commitment-diff' | 'softcancel-recovery' | 'position-poll';
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

export type ReducerDescriptor =
  | { kind: 'emit-fill'; payload: FillEventPayload }
  | { kind: 'emit-expire'; payload: ExpireEventPayload }
  | { kind: 'emit-position-transition'; payload: PositionTransitionEventPayload }
  | { kind: 'emit-error'; payload: ErrorEventPayload }
  | { kind: 'mark-dirty'; contestId: string }
  | { kind: 'signal-past-expiry-lookup-failed' }
  | { kind: 'signal-softcancel-probe-failed' };

export interface ApplyDescriptorsResult {
  pastExpiryLookupFailed: boolean;
  softCancelledProbeFailed: boolean;
}
