/**
 * Source-aware reducers. Both the poll-source (`reducePolled*`) and the
 * owner/SSE-source (`reduceOwner*`) reducers mutate a `MakerState` target +
 * return IO descriptors. Post Phase-3 PR3b source flip: when `ownState.subscribe`
 * is true the SSE stream is the CANONICAL writer (the owner reducers write
 * `this.state` via the PR3a `mapOwner*ToMaker` mappers) and the poll path is a
 * best-effort AUDIT over `this.auditState` (compared by `compareAuditVsCanonical`);
 * in backout (`subscribe:false`) the poll path is the canonical writer and the
 * SSE is dormant. See `phase2-pr2-transition-table.md` for the poll-side
 * transition table this module preserves.
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
