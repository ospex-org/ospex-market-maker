import { describe, expect, it } from 'vitest';

import { WakeSignal } from './wake-signal.js';

describe('WakeSignal — state machine', () => {
  it('starts in idle', () => {
    const ws = new WakeSignal();
    expect(ws.inspectState()).toBe('idle');
  });

  it('wake() before beginWait latches pending; next beginWait returns aborted signal', () => {
    const ws = new WakeSignal();
    ws.wake();
    expect(ws.inspectState()).toBe('pending');
    const sig = ws.beginWait();
    expect(sig.aborted).toBe(true);
    expect(ws.inspectState()).toBe('idle');
  });

  it('beginWait without prior wake returns a NOT-aborted signal; subsequent wake aborts it, state stays "waiting" until endWait', () => {
    const ws = new WakeSignal();
    const sig = ws.beginWait();
    expect(sig.aborted).toBe(false);
    expect(ws.inspectState()).toBe('waiting');
    ws.wake();
    expect(sig.aborted).toBe(true);
    // `waiting` still holds (the consumer's race hasn't finished) even though
    // pending is now latched — inspectState reports the dominant `waiting` flag.
    expect(ws.inspectState()).toBe('waiting');
    ws.endWait();
    // After endWait the wake is treated as consumed (the consumer's post-race
    // check on `sig.aborted` IS the consumption): state returns to idle.
    expect(ws.inspectState()).toBe('idle');
  });

  it('multiple wake() calls between waits collapse to one pending (idempotent latch)', () => {
    const ws = new WakeSignal();
    ws.wake();
    ws.wake();
    ws.wake();
    expect(ws.inspectState()).toBe('pending');
    const sig = ws.beginWait();
    expect(sig.aborted).toBe(true);
    expect(ws.inspectState()).toBe('idle');
  });

  it('endWait clears pending — the consumer\'s race observation IS the consumption', () => {
    const ws = new WakeSignal();
    const sig1 = ws.beginWait();
    ws.wake();
    expect(sig1.aborted).toBe(true);
    ws.endWait();
    expect(ws.inspectState()).toBe('idle');
    const sig2 = ws.beginWait();
    expect(sig2.aborted).toBe(false); // fresh wait, no spurious wake
  });

  it('wake fired BETWEEN waits latches pending for the next beginWait (the between-waits case)', () => {
    const ws = new WakeSignal();
    const sig1 = ws.beginWait();
    expect(sig1.aborted).toBe(false);
    ws.endWait();
    ws.wake();
    expect(ws.inspectState()).toBe('pending');
    const sig2 = ws.beginWait();
    expect(sig2.aborted).toBe(true);
    expect(ws.inspectState()).toBe('idle');
  });

  it('endWait after a clean wait (no wake fired) returns to idle', () => {
    const ws = new WakeSignal();
    ws.beginWait();
    ws.endWait();
    expect(ws.inspectState()).toBe('idle');
  });

  it('beginWait throws if called twice without an intervening endWait', () => {
    const ws = new WakeSignal();
    ws.beginWait();
    expect(() => ws.beginWait()).toThrow(/beginWait called while a previous wait is still active/);
  });

  it('endWait is idempotent on idle (defensive — kill-before-beginWait path)', () => {
    const ws = new WakeSignal();
    expect(() => ws.endWait()).not.toThrow();
    expect(ws.inspectState()).toBe('idle');
  });

  it('full lifecycle: idle → wait → wake → endWait → wait again → endWait → idle', () => {
    const ws = new WakeSignal();
    const sig1 = ws.beginWait();
    expect(sig1.aborted).toBe(false);
    ws.wake();
    expect(sig1.aborted).toBe(true);
    ws.endWait();
    expect(ws.inspectState()).toBe('idle'); // consumed
    const sig2 = ws.beginWait();
    expect(sig2.aborted).toBe(false); // fresh wait
    ws.endWait();
    expect(ws.inspectState()).toBe('idle');
  });
});
