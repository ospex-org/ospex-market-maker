/**
 * Wakeable-sleep primitive for the runner loop (Phase 2 PR3 — own-state-sse-plan
 * §2.5.1). Lets an external signal (SSE event arrived → events queued for shadow
 * convergence) interrupt the runner's between-tick wait WITHOUT shortening the
 * canonical poll cadence. The plan invariant (Phase 2): a wake interrupts the
 * sleep but does NOT push the poll deadline back, does NOT run `tick()`, and
 * does NOT alter quote timing.
 *
 * Two-dimensional state (per `[[feedback_explicit_model_when_patching_stalls]]`):
 *
 *   `waiting: boolean` — is a `beginWait()` in flight, NOT yet ended?
 *   `pending: boolean` — has a wake fired since the last consumption?
 *
 * `pending` is set by `wake()` regardless of `waiting` and cleared by:
 *   1. `beginWait()` Path B (consumes the latched wake by returning an
 *      already-aborted signal — used for the "wake fired between waits" case),
 *   2. `endWait()` (the consumer's post-race observation of `wakeSig.aborted`
 *      IS the wake consumption — clear so the next wait starts fresh),
 *   3. `clearPending()` (explicit consumption — used by the runner AFTER the
 *      shadow-drain has covered any wakes that arrived during the debounce
 *      window OUTSIDE the begin/endWait pair, so the next iteration doesn't
 *      re-trigger the wake path on stale signals).
 *
 * Because the consumer's post-race check reads `wakeSig.aborted` synchronously
 * (the AbortSignal's `aborted` getter reflects the abort even if its listeners
 * haven't run yet), a wake firing during a wait is ALWAYS observable on the
 * post-race check, regardless of `Promise.race`'s winner. So `endWait` can
 * safely clear `pending` — no wake is lost.
 *
 * State transitions:
 *
 *   action           | waiting          | pending
 *   -----------------|------------------|--------
 *   wake             | (unchanged)      | → true (if waiting + controller is set, also aborts controller)
 *   beginWait Path A | → true           | (unchanged — was false, stays false; fresh controller)
 *   beginWait Path B | (unchanged false)| → false (consumed; signal returned already-aborted, no controller)
 *   endWait          | → false          | → false (consumer's race observation is the consumption)
 *
 * The signal returned by `beginWait` is consumed externally via
 * `AbortSignal.aborted` checks; the runner doesn't await it directly. Instead
 * the runner uses `Promise.race([deps.sleep(ms, killSignal), wakeWatcher])`
 * where `wakeWatcher` resolves when the WakeSignal's current signal aborts.
 *
 * `WakeSignal` is a STATEFUL primitive — there's exactly one instance per
 * runner. Multiple producers (SSE handlers in PR4) call `wake()` concurrently;
 * the consumer (the runner loop) is the single `beginWait` / `endWait` pair.
 */
export class WakeSignal {
  private waiting = false;
  private pending = false;
  private controller: AbortController | null = null;

  /**
   * Signal that the consumer should wake up. If a wait is in progress, aborts
   * its current signal. Regardless of waiting state, latches `pending` so the
   * NEXT `beginWait` returns immediately if the abort lost the race to a
   * near-simultaneous sleep-timer fire.
   *
   * Multiple wake() calls between waits collapse to a single pending: SSE
   * bursts of N events still produce only ONE wake-outcome (the consumer's
   * drain pass handles the queue contents — coalescing is by design).
   */
  wake(): void {
    this.pending = true;
    if (this.waiting && this.controller !== null) {
      this.controller.abort();
    }
  }

  /**
   * Begin a new wait period. Returns an `AbortSignal` that aborts when `wake()`
   * fires. If a wake is already pending, consumes the pending flag and returns
   * an ALREADY-ABORTED signal — the consumer should treat its `Promise.race`
   * as having woken immediately (no actual sleep needed).
   *
   * Throws if called twice without an intervening `endWait` (state machine
   * violation — the consumer is the single owner of the wait cycle).
   */
  beginWait(): AbortSignal {
    if (this.waiting) {
      throw new Error('WakeSignal.beginWait called while a previous wait is still active — call endWait first');
    }
    if (this.pending) {
      // Path B: consume the pending wake — return an immediately-aborted signal,
      // do NOT enter `waiting` (the consumer will return from its race instantly,
      // call `endWait`, and start a fresh wait).
      this.pending = false;
      const ac = new AbortController();
      ac.abort();
      return ac.signal;
    }
    // Path A: fresh wait.
    this.controller = new AbortController();
    this.waiting = true;
    return this.controller.signal;
  }

  /**
   * End the current wait period. The consumer MUST call this exactly once per
   * `beginWait` Path A; for Path B (pending consumed) it's also safe to call
   * (no-op). Clears `pending` — the consumer's post-race observation of
   * `wakeSig.aborted` IS the wake consumption (see class doc comment).
   */
  endWait(): void {
    this.waiting = false;
    this.controller = null;
    this.pending = false;
  }

  /**
   * Explicitly clear the pending wake flag — used by the runner AFTER the
   * shadow-drain has covered any wakes that arrived OUTSIDE the begin/endWait
   * pair (e.g. during the debounce window). Without this, a wake fired during
   * the debounce stays latched and the next `beginWait` returns aborted,
   * triggering a redundant second debounce + drain even though that drain has
   * no events to process. Under a sustained-burst SSE producer the redundant
   * debounces compound, postponing the poll-deadline outcome — the Phase 2
   * cadence-preservation contract requires that the wait NOT slip forward
   * indefinitely, so the runner explicitly consumes wakes it has already
   * drained.
   *
   * Idempotent — safe to call when no wake is pending.
   */
  clearPending(): void {
    this.pending = false;
  }

  /** Diagnostic read for tests — NOT part of the runner's call surface. */
  inspectState(): 'idle' | 'pending' | 'waiting' {
    if (this.waiting) return 'waiting';
    if (this.pending) return 'pending';
    return 'idle';
  }
}
