/**
 * Bounded buffer for own-state SSE events arriving between drains
 * (own-state-sse-plan §2.5.2). Phase 2 PR3 ships the queue infrastructure; PR4
 * wires the SSE adapter handlers that produce the events. Reducers (PR2 stubs
 * → PR4 implementations) consume the events at drain time.
 *
 * **Overflow semantics — telemetry only (Phase 2).** When the queue is full
 * and another event arrives, the NEW event is dropped and an overflow flag is
 * latched. The next `drain()` reports `overflowed: true` once; the runner's
 * `drainShadow` translates that into `stream-health-degraded {reason:
 * 'queue-overflow'}` + (conditionally) `stream-would-hold {reason, exposureWei6}`
 * telemetry, sets `shadow.healthy = false`, and continues — it does NOT alter
 * canonical trading state, does NOT set `fundingHold`, does NOT trigger
 * `fundingCancelSweep`. That's the Phase 2 shadow-only contract (`phase2-plan.md`
 * § Phase 2 contract). Phase 3 cutover will harden the response.
 *
 * Bound: {@link OWN_STATE_QUEUE_MAX} = 10_000 events. At 1-event-per-fill, this
 * is ~10k filled commitments of buffer before degradation — far above any
 * realistic Phase 2 SSE burst. The bound exists to prevent unbounded
 * memory growth if the consumer (the runner loop) stalls.
 */

/** Maximum events the queue holds before overflow (spec §2.5.2). */
export const OWN_STATE_QUEUE_MAX = 10_000;

/**
 * One SSE event the queue carries. PR4 will narrow `kind` to a discriminated
 * union over the SDK's actual `ownState.subscribe` body types; PR3 keeps it
 * permissive so the queue infrastructure is testable in isolation.
 */
export interface OwnStateEvent {
  /** The SSE handler tag: `'commitment'` | `'fill'` | `'position-status'` (PR4). */
  kind: string;
  /** The handler body — PR4 narrows this against the SDK's exported types. */
  body: unknown;
  /** Wall-clock arrival time (ms since epoch) — used by transport-fresh checks (§2.6). */
  arrivedAtMs: number;
}

export interface DrainResult {
  events: OwnStateEvent[];
  /**
   * True if at least one event was DROPPED since the previous drain
   * (`enqueue` returned `'overflow'`). The flag latches between drains so
   * a burst that overflows mid-buffer is reported on the NEXT drain.
   * `drain()` clears the flag.
   */
  overflowed: boolean;
}

export class OwnStateQueue {
  private buf: OwnStateEvent[] = [];
  private overflowedSinceLastDrain = false;
  private readonly max: number;

  constructor(max: number = OWN_STATE_QUEUE_MAX) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`OwnStateQueue max must be a positive integer, got ${max}`);
    }
    this.max = max;
  }

  /**
   * Append `event` to the buffer. Returns `'enqueued'` on success, `'overflow'`
   * if the buffer was at capacity — in which case the event is DROPPED and the
   * `overflowedSinceLastDrain` flag is latched for the next drain.
   */
  enqueue(event: OwnStateEvent): 'enqueued' | 'overflow' {
    if (this.buf.length >= this.max) {
      this.overflowedSinceLastDrain = true;
      return 'overflow';
    }
    this.buf.push(event);
    return 'enqueued';
  }

  /**
   * Atomically remove all queued events (in arrival order) and reset the
   * overflow flag. The runner calls this from `drainShadow` at every wake +
   * twice per `tick` (per `phase2-plan.md` § "Drain placement").
   */
  drain(): DrainResult {
    const events = this.buf;
    const overflowed = this.overflowedSinceLastDrain;
    this.buf = [];
    this.overflowedSinceLastDrain = false;
    return { events, overflowed };
  }

  /** Diagnostic — current buffer occupancy. Not part of the runner's loop logic. */
  get size(): number {
    return this.buf.length;
  }

  /** Diagnostic — exposes max for tests / divergence-telemetry payloads. */
  get capacity(): number {
    return this.max;
  }
}
