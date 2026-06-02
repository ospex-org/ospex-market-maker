import { describe, expect, it } from 'vitest';

import { OWN_STATE_QUEUE_MAX, OwnStateEvent, OwnStateQueue } from './own-state-queue.js';

function ev(kind: string, n: number): OwnStateEvent {
  return { kind, body: { n }, arrivedAtMs: n, cursor: `evt-${n}` };
}

describe('OwnStateQueue', () => {
  it('exposes the spec constant 10_000', () => {
    expect(OWN_STATE_QUEUE_MAX).toBe(10_000);
  });

  it('enqueue → drain preserves arrival order', () => {
    const q = new OwnStateQueue();
    expect(q.enqueue(ev('a', 1))).toBe('enqueued');
    expect(q.enqueue(ev('b', 2))).toBe('enqueued');
    expect(q.enqueue(ev('c', 3))).toBe('enqueued');
    const drained = q.drain();
    expect(drained.events.map((e) => (e.body as { n: number }).n)).toEqual([1, 2, 3]);
    expect(drained.overflowed).toBe(false);
  });

  it('fills exactly to max → no overflow', () => {
    const q = new OwnStateQueue(3);
    expect(q.enqueue(ev('a', 1))).toBe('enqueued');
    expect(q.enqueue(ev('b', 2))).toBe('enqueued');
    expect(q.enqueue(ev('c', 3))).toBe('enqueued');
    expect(q.size).toBe(3);
    const drained = q.drain();
    expect(drained.overflowed).toBe(false);
    expect(drained.events).toHaveLength(3);
  });

  it('max+1 → overflow return + new event dropped', () => {
    const q = new OwnStateQueue(3);
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    q.enqueue(ev('c', 3));
    expect(q.enqueue(ev('d', 4))).toBe('overflow');
    expect(q.size).toBe(3); // buffer length unchanged — the new arrival was dropped
    const drained = q.drain();
    expect(drained.overflowed).toBe(true);
    expect(drained.events.map((e) => (e.body as { n: number }).n)).toEqual([1, 2, 3]); // pre-overflow contents preserved
  });

  it('drain resets the overflow flag', () => {
    const q = new OwnStateQueue(2);
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    q.enqueue(ev('c', 3)); // overflow
    const first = q.drain();
    expect(first.overflowed).toBe(true);
    const second = q.drain();
    expect(second.overflowed).toBe(false);
    expect(second.events).toEqual([]);
  });

  it('multiple overflows between drains still report overflowed:true once on next drain', () => {
    const q = new OwnStateQueue(2);
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    expect(q.enqueue(ev('c', 3))).toBe('overflow');
    expect(q.enqueue(ev('d', 4))).toBe('overflow');
    expect(q.enqueue(ev('e', 5))).toBe('overflow');
    const drained = q.drain();
    expect(drained.overflowed).toBe(true);
    expect(drained.events.map((e) => (e.body as { n: number }).n)).toEqual([1, 2]);
  });

  it('drain followed by enqueue → new events present, overflow flag fresh', () => {
    const q = new OwnStateQueue(2);
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    q.enqueue(ev('c', 3));
    q.drain();
    expect(q.size).toBe(0);
    q.enqueue(ev('d', 4));
    const drained = q.drain();
    expect(drained.overflowed).toBe(false);
    expect(drained.events.map((e) => (e.body as { n: number }).n)).toEqual([4]);
  });

  it('constructor rejects non-positive-integer max', () => {
    expect(() => new OwnStateQueue(0)).toThrow();
    expect(() => new OwnStateQueue(-1)).toThrow();
    expect(() => new OwnStateQueue(1.5)).toThrow();
  });

  it('capacity getter exposes the constructor argument (for divergence-telemetry payloads)', () => {
    expect(new OwnStateQueue().capacity).toBe(OWN_STATE_QUEUE_MAX);
    expect(new OwnStateQueue(42).capacity).toBe(42);
  });

  // ── clear() — used by the runner on onStatus('resync') (Hermes #69) ───

  it('clear() drops queued events WITHOUT yielding them to a drain — next drain sees an empty queue', () => {
    const q = new OwnStateQueue();
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    expect(q.size).toBe(2);
    q.clear();
    expect(q.size).toBe(0);
    const drained = q.drain();
    expect(drained.events).toEqual([]);
    expect(drained.overflowed).toBe(false);
  });

  it('clear() resets the overflow flag — a post-clear drain does NOT report a stale overflow', () => {
    const q = new OwnStateQueue(2);
    q.enqueue(ev('a', 1));
    q.enqueue(ev('b', 2));
    expect(q.enqueue(ev('c', 3))).toBe('overflow');
    q.clear();
    const drained = q.drain();
    expect(drained.overflowed).toBe(false);
    expect(drained.events).toEqual([]);
  });

  it('clear() is idempotent on an empty queue', () => {
    const q = new OwnStateQueue();
    expect(() => q.clear()).not.toThrow();
    expect(q.size).toBe(0);
  });
});
