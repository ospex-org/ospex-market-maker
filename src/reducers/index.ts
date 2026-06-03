/**
 * Source-aware reducers — Phase 2 PR2 architectural boundary (`phase2-plan.md` § PR2).
 *
 * Each reducer mutates an explicit target — either canonical `MakerState` (poll-source,
 * the source of truth for trading writes) OR `OwnStateShadow` (owner/SSE-source, a
 * projection consumed by the PR5 comparator for divergence telemetry). The split is
 * typed: passing the wrong target is a compile-time error. See
 * `phase2-pr2-transition-table.md` for the exhaustive poll-side transition table this
 * module preserves.
 *
 * Owner-side reducers ship as signatures + stub bodies in PR2; their real
 * implementations land in PR4 alongside the SSE adapter wrapper. Stub bodies
 * intentionally return `[]` and do not mutate their target — PR3 wires them through
 * `applyDescriptors(_, 'owner')` so the type contract is exercised end-to-end before
 * any real owner-side behaviour exists.
 */

export type {
  ReducerDescriptor,
  FillEventPayload,
  ExpireEventPayload,
  PositionTransitionEventPayload,
  ErrorEventPayload,
  ApplyDescriptorsResult,
} from './descriptors.js';

export {
  reducePolledCommitmentObservation,
  reducePolledSoftCancelledObservation,
  reducePolledPositionObservation,
} from './poll.js';
export type {
  PolledCommitmentObservation,
  PolledPositionInput,
  ReducerConfig,
} from './poll.js';

export {
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
  emptyOwnStateSession,
} from './owner.js';
export type {
  OwnStateSession,
  OwnStateTransportStatus,
  OwnerCommitmentBody,
  OwnerFillBody,
  OwnerPositionStatusBody,
} from './owner.js';

export {
  mapOwnerCommitmentToMaker,
  mapOwnerPositionToMaker,
  mapPositionStatusEventToMaker,
  deriveCommitmentLifecycle,
  mapPositionLifecycleToMaker,
  OwnerMappingError,
} from './owner-mapping.js';
