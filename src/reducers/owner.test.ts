import { describe, expect, it } from 'vitest';

import { emptyMakerState } from '../state/index.js';

import {
  emptyOwnStateShadow,
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
} from './index.js';

describe('emptyOwnStateShadow', () => {
  it('returns a fresh non-ready shadow with empty maps and zero timestamps', () => {
    const shadow = emptyOwnStateShadow();
    expect(shadow.ready).toBe(false);
    expect(shadow.healthy).toBe(true);
    expect(shadow.commitments).toEqual({});
    expect(shadow.positions).toEqual({});
    expect(shadow.pendingBaseline).toBeNull();
    expect(shadow.lastEventAtMs).toBe(0);
    expect(shadow.lastHeartbeatAtMs).toBe(0);
    expect(shadow.lastReadyAtMs).toBe(0);
    expect(shadow.truncated).toBe(false);
  });

  it('returns a distinct object per call (no shared mutable state)', () => {
    const a = emptyOwnStateShadow();
    const b = emptyOwnStateShadow();
    expect(a).not.toBe(b);
    expect(a.commitments).not.toBe(b.commitments);
    expect(a.positions).not.toBe(b.positions);
  });
});

describe('owner reducer stubs (Phase 2 PR2 — bodies land in PR4)', () => {
  it('reduceOwnerCommitmentObservation returns [] and does not mutate the shadow', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerCommitmentObservation(shadow, {}, 1);
    expect(descriptors).toEqual([]);
    expect(shadow).toEqual(emptyOwnStateShadow());
  });

  it('reduceOwnerFill returns [] and does not mutate the shadow or dedup set', () => {
    const shadow = emptyOwnStateShadow();
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(shadow, {}, dedup, 1);
    expect(descriptors).toEqual([]);
    expect(shadow).toEqual(emptyOwnStateShadow());
    expect(dedup.size).toBe(0);
  });

  it('reduceOwnerPositionStatus returns [] and does not mutate the shadow', () => {
    const shadow = emptyOwnStateShadow();
    const descriptors = reduceOwnerPositionStatus(shadow, {}, 1);
    expect(descriptors).toEqual([]);
    expect(shadow).toEqual(emptyOwnStateShadow());
  });
});

describe('source-confusion compile-time guard (typed boundary between MakerState and OwnStateShadow)', () => {
  // These cases assert that the type system forbids passing the wrong target into
  // each owner-side reducer. They are NOT runtime assertions — the `@ts-expect-error`
  // directives below FAIL the build if the cross-type call ever becomes legal.
  // Per `phase2-plan.md` § PR2: "reduceOwnerFill(this.state, ...) MUST be a
  // TypeScript error (target-type mismatch)."
  it('forbids passing MakerState to reduceOwnerCommitmentObservation', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerCommitmentObservation(state, {}, 1);
  });

  it('forbids passing MakerState to reduceOwnerFill', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerFill(state, {}, new Set<string>(), 1);
  });

  it('forbids passing MakerState to reduceOwnerPositionStatus', () => {
    const state = emptyMakerState();
    // @ts-expect-error MakerState is not assignable to OwnStateShadow
    reduceOwnerPositionStatus(state, {}, 1);
  });
});
