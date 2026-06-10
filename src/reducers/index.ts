/**
 * Source-aware reducers. Both the audit-probe (`reducePolled*`) and the
 * owner/SSE-source (`reduceOwner*`) reducers mutate a `MakerState` target +
 * return IO descriptors. The SSE stream is the CANONICAL writer (the owner
 * reducers write `this.state` via the PR3a `mapOwner*ToMaker` mappers); the
 * `reducePolled*` reducers run as a best-effort AUDIT over `this.auditState`
 * (compared by `compareAuditVsCanonical`). The pre-OS-Phase-4 poll-canonical
 * backout is retired.
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
