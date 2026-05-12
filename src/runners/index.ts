/**
 * The runner — the event loop (DESIGN §3, §8). One `Runner` per process, mode set
 * by `config.mode.dryRun`. This module is the loop's *machinery*: the boot path
 * (state load + the boot-time state-loss fail-safe — DESIGN §12), the kill-switch (a
 * file at `config.killSwitchFile`, or a SIGTERM / SIGINT → a graceful shutdown), the
 * tick loop, age-out of expired tracked commitments, the per-tick state flush, and
 * an interruptible sleep clamped to the `pollIntervalMs` floor.
 *
 * What's still a TODO follow-up (so the loop's machinery lands on a reviewed
 * foundation first): discovery + odds subscriptions (tick step 2 — DESIGN §10), the
 * per-market reconcile (tick step 3 — `buildDesiredQuote` → `reconcileBook` →
 * `would-*` telemetry + state mutation, respecting the boot-time hold), and
 * fill-detection (tick step 4).
 *
 * No `@ospex/sdk` import — all chain/API access goes through the `OspexAdapter`. The
 * clock, sleep, kill-switch probe, and OS-signal registration are injectable
 * (`RunnerDeps`) so the loop is unit-testable: run a bounded number of ticks; drive
 * shutdown via the kill probe or a simulated signal.
 */

import { existsSync } from 'node:fs';

import { POLL_INTERVAL_FLOOR_MS, type Config } from '../config/index.js';
import type { OspexAdapter } from '../ospex/index.js';
import { assessStateLoss, type MakerState, type StateLossAssessment, type StateStore } from '../state/index.js';
import { EventLog, eventLogsExist } from '../telemetry/index.js';

// ── injectable seams (the defaults are the real impls; tests override) ───────

export interface RunnerDeps {
  /** Wall clock — unix seconds. Default: `Math.floor(Date.now() / 1000)`. */
  now: () => number;
  /** Sleep `ms`, resolving early if `signal` aborts. Default: {@link interruptibleSleep}. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Does the kill-switch file exist right now? Default: `existsSync(config.killSwitchFile)`. */
  killFileExists: () => boolean;
  /**
   * Register OS shutdown-signal handlers (SIGTERM / SIGINT) — `onSignal` is invoked
   * once when either arrives; the returned function unregisters them. Default:
   * `process.once(...)` (a second signal then takes Node's default — immediate
   * termination — which is the right "I said stop" escalation). Tests pass a fake
   * that captures `onSignal` (to simulate a signal) and returns a no-op unregister.
   */
  registerShutdownSignals: (onSignal: () => void) => () => void;
  /** Human-readable diagnostic line (boot banner, clamp warning, hold reason — *not* the telemetry log). Default: a line to `process.stderr`. */
  log: (line: string) => void;
}

export interface RunnerOptions {
  config: Config;
  adapter: OspexAdapter;
  stateStore: StateStore;
  /**
   * This run's id — filename-safe; see `newRunId()`. The constructor reads
   * `eventLogsExist(config.telemetry.logDir)` *before* opening this run's event-log
   * file, so the boot fail-safe's `hasPriorTelemetry` flag isn't fooled by this
   * run's own (empty) file.
   */
  runId: string;
  /**
   * `--ignore-missing-state` — the operator attests that no prior run left an open /
   * soft-cancelled commitment that could still match on chain. Default `false`;
   * setting it lifts the boot-time hold (DESIGN §12).
   */
  ignoreMissingState?: boolean;
  /** Run at most this many ticks, then return (for tests). Default: undefined — run until killed. */
  maxTicks?: number;
  /** Override any of the injectable seams; the rest use the real impls. */
  deps?: Partial<RunnerDeps>;
}

const defaultNow = (): number => Math.floor(Date.now() / 1000);

const defaultLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const defaultRegisterShutdownSignals = (onSignal: () => void): (() => void) => {
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
};

/** Sleep `ms`, resolving immediately if `signal` is already aborted, or as soon as it aborts. */
export function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── the runner ────────────────────────────────────────────────────────────────

type ShutdownReason = 'kill-file' | 'signal';

export class Runner {
  readonly config: Config;
  /** The boot-time state-loss assessment (DESIGN §12), computed in the constructor — `holdQuoting`, the reason, and (when holding) `suggestedWaitSeconds`. */
  readonly bootAssessment: StateLossAssessment;

  private readonly adapter: OspexAdapter;
  private readonly stateStore: StateStore;
  private readonly eventLog: EventLog;
  private readonly maxTicks: number | undefined;
  private readonly deps: RunnerDeps;

  private state: MakerState;
  /**
   * Unix-seconds deadline before which the (TODO) per-market reconcile step must
   * not post — the boot fail-safe (DESIGN §12). `null` = no hold; a finite value =
   * hold until then; `Number.POSITIVE_INFINITY` = hold indefinitely (only if
   * `assessStateLoss` ever omits `suggestedWaitSeconds` while holding, which it
   * doesn't — belt and suspenders). Set at boot; read via `isHoldingQuoting()`.
   */
  private readonly holdQuotingUntil: number | null;
  private shutdownReason: ShutdownReason | null = null;
  private readonly abortController = new AbortController();

  constructor(opts: RunnerOptions) {
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.stateStore = opts.stateStore;
    this.maxTicks = opts.maxTicks;
    this.deps = {
      now: opts.deps?.now ?? defaultNow,
      sleep: opts.deps?.sleep ?? interruptibleSleep,
      killFileExists: opts.deps?.killFileExists ?? (() => existsSync(this.config.killSwitchFile)),
      registerShutdownSignals: opts.deps?.registerShutdownSignals ?? defaultRegisterShutdownSignals,
      log: opts.deps?.log ?? defaultLog,
    };

    // Read hasPriorTelemetry BEFORE this run's own (empty) event-log file would be
    // counted — so check first, then open the log.
    const hasPriorTelemetry = eventLogsExist(this.config.telemetry.logDir);
    this.eventLog = EventLog.open(this.config.telemetry.logDir, opts.runId);

    this.deps.log(`[runner] starting run ${opts.runId} — chain ${this.adapter.chainId}, api ${this.adapter.apiUrl}, mode ${this.config.mode.dryRun ? 'dry-run' : 'live'}`);

    if (this.config.pollIntervalMs < POLL_INTERVAL_FLOOR_MS) {
      this.deps.log(`[runner] pollIntervalMs=${this.config.pollIntervalMs}ms is below the ${POLL_INTERVAL_FLOOR_MS}ms floor — clamping to ${POLL_INTERVAL_FLOOR_MS}ms`);
    }

    const { state, status } = this.stateStore.load();
    this.state = state;
    this.bootAssessment = assessStateLoss(status, {
      hasPriorTelemetry,
      ignoreMissingStateOverride: opts.ignoreMissingState ?? false,
      expirySeconds: this.config.orders.expirySeconds,
    });
    if (this.bootAssessment.holdQuoting) {
      this.deps.log(`[runner] holding quoting at boot: ${this.bootAssessment.reason}`);
      this.holdQuotingUntil = this.bootAssessment.suggestedWaitSeconds !== undefined ? this.deps.now() + this.bootAssessment.suggestedWaitSeconds : Number.POSITIVE_INFINITY;
    } else {
      this.holdQuotingUntil = null;
    }
  }

  /** Is the boot-time fail-safe still holding quoting right now (DESIGN §12)? The (TODO) reconcile step skips while this is true; surfaced for diagnostics. */
  isHoldingQuoting(): boolean {
    return this.holdQuotingUntil !== null && this.deps.now() < this.holdQuotingUntil;
  }

  /** True once a shutdown has been requested (kill-switch file or an OS signal). */
  private get stopRequested(): boolean {
    return this.shutdownReason !== null;
  }

  private requestShutdown(reason: ShutdownReason): void {
    if (this.shutdownReason === null) this.shutdownReason = reason; // first reason wins
    this.abortController.abort(); // interrupt an in-flight sleep
  }

  private sleepMs(): number {
    return Math.max(this.config.pollIntervalMs, POLL_INTERVAL_FLOOR_MS);
  }

  /**
   * The event loop: `{ kill-check → tick → stop-check → sleep }` until killed or
   * `maxTicks` is reached. On shutdown (kill-switch file or SIGTERM/SIGINT) emits a
   * `kill` event and does a final state flush. (In dry-run there's nothing posted to
   * pull on shutdown; live mode's `killCancelOnChain` path is Phase 3.) Single-use —
   * call once. The kill *file* is checked at the top of each iteration, so it's
   * acted on within one poll interval; a *signal* aborts the in-flight sleep, so
   * it's acted on after the current tick.
   */
  async run(): Promise<void> {
    const unregister = this.deps.registerShutdownSignals(() => this.requestShutdown('signal'));
    let ticks = 0;
    try {
      while (!this.stopRequested) {
        if (this.deps.killFileExists()) {
          this.requestShutdown('kill-file');
          break;
        }
        ticks += 1;
        await this.tick(ticks);
        if (this.stopRequested) break;
        if (this.maxTicks !== undefined && ticks >= this.maxTicks) break;
        await this.deps.sleep(this.sleepMs(), this.abortController.signal);
      }
    } finally {
      unregister();
      if (this.shutdownReason !== null) this.eventLog.emit('kill', { reason: this.shutdownReason, ticks });
      // Each tick already flushes; this final flush only matters when a shutdown
      // fires before any tick (kill file present at startup) — persist the loaded
      // state (idempotent atomic write).
      this.stateStore.flush(this.state);
    }
  }

  /** One iteration: discovery → per-market reconcile → fill-detection → age-out → flush. (The first three are TODO follow-ups; only age-out + flush are wired in this PR.) */
  private async tick(tick: number): Promise<void> {
    this.eventLog.emit('tick-start', { tick });
    try {
      // TODO(PR 4b): discovery — adapter.listContests(filters) ≤ marketSelection.maxTrackedContests; per contest confirm an open moneyline speculation (else `candidate` w/ skipReason no-open-speculation); adapter.subscribeOdds for new tracked markets ≤ odds.maxRealtimeChannels (snapshot-first via adapter.getOddsSnapshot); unsubscribe started / out-of-window contests; the Realtime guardrails (DESIGN §10) — backoff+jitter on reconnect, channel-error → market degraded, dirty-event coalescing, bootstrap-retry.
      // TODO(PR 4c): per-market reconcile — for each dirty / newly-tracked market, skip while isHoldingQuoting(): inv = inventoryFromState(this.state, now); buildDesiredQuote(config, market, refOdds, inv); the lazy-creation check from the cached ContestView.speculations (no open moneyline spec ⇒ `candidate` w/ skipReason would-create-lazy-speculation); reconcileBook(recordsOnSpec, desired, config, now, inv.openCommitmentCount); in dry-run emit would-submit / would-replace / would-soft-cancel + `candidate` (skipReason cap-hit per deferredSides) + mutate this.state (synthetic visibleOpen records for toSubmit / toReplace.replacement; reclassify toReplace.stale / toSoftCancel.record → softCancelled).
      // TODO(PR 4c): fill-detection — adapter.listOpenCommitments(maker, maxOpen+buffer); diff against last tick's visibleOpen hash set; by-hash lookup of disappeared hashes → reclassify (filled / cancelled / expired); periodically adapter.getPositionStatus(maker). (In dry-run this is the live path — a no-op unless a prior live run left commitments/positions.)
      await Promise.resolve(); // (an `await` placeholder until the steps above land)
      this.ageOut();
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'tick' });
    }
    // The flush is OUTSIDE the try/catch: if state can't be persisted the runner
    // must not keep ticking on an un-persistable state — let it propagate.
    this.stateStore.flush(this.state);
  }

  /** Reclassify any tracked commitment past its `expiryUnixSec` to `expired` (dead on chain — headroom released; DESIGN §9). Emits an `expire` per reclassification. */
  private ageOut(): void {
    const now = this.deps.now();
    for (const record of Object.values(this.state.commitments)) {
      if ((record.lifecycle === 'visibleOpen' || record.lifecycle === 'softCancelled' || record.lifecycle === 'partiallyFilled') && record.expiryUnixSec <= now) {
        record.lifecycle = 'expired';
        record.updatedAtUnixSec = now;
        this.eventLog.emit('expire', {
          commitmentHash: record.hash,
          speculationId: record.speculationId,
          contestId: record.contestId,
          makerSide: record.makerSide,
          oddsTick: record.oddsTick,
        });
      }
    }
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
