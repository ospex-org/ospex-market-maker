/**
 * The runner — the event loop (DESIGN §3, §8). One `Runner` per process, mode set
 * by `config.mode.dryRun`. This module is the loop's *machinery* + the *discovery*
 * layer: the boot path (state load + the boot-time state-loss fail-safe — DESIGN
 * §12), the kill-switch (a file at `config.killSwitchFile`, or a SIGTERM / SIGINT →
 * a graceful shutdown), the tick loop, **discovery** (every `discovery.everyNTicks`
 * ticks — jittered — find the verified contests with an open moneyline speculation +
 * a reference-game id starting within `marketSelection.maxStartsWithinHours`, honour
 * the allow/deny lists, track up to `marketSelection.maxTrackedContests` of them,
 * untrack the departed ones; `candidate` telemetry for the skipped/tracked), age-out
 * of expired tracked commitments, the per-tick state flush, and an interruptible
 * sleep clamped to the `pollIntervalMs` floor.
 *
 * Still TODO follow-ups: the odds subscriptions for the tracked markets (PR 4b-ii —
 * snapshot-first, the `odds.maxRealtimeChannels` cap, the Realtime guardrails of
 * DESIGN §10), the per-market reconcile (PR 4c — `buildDesiredQuote` →
 * `reconcileBook` → `would-*` telemetry + state mutation, respecting the boot-time
 * hold), and fill-detection (PR 4c).
 *
 * No `@ospex/sdk` import — all chain/API access goes through the `OspexAdapter`. The
 * clock, sleep, kill-switch probe, OS-signal registration, and randomness are
 * injectable (`RunnerDeps`) so the loop is unit-testable: run a bounded number of
 * ticks; drive shutdown via the kill probe or a simulated signal; pin discovery
 * timing.
 */

import { existsSync } from 'node:fs';

import { POLL_INTERVAL_FLOOR_MS, type Config } from '../config/index.js';
import type { ContestView, OspexAdapter } from '../ospex/index.js';
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
  /** A value in `[0, 1)` — only used to jitter the discovery interval. Default: `Math.random`. */
  random: () => number;
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

/**
 * A contest the runner is tracking — its market metadata. PR 4b-ii adds the
 * odds-subscription state (the `Subscription`, the latest reference odds + their
 * freshness timestamp, the dirty flag); PR 4c's per-market reconcile reads
 * `speculationId` (re-confirms it's still open — the lazy-creation check) and
 * `matchTimeSec` (the `start-too-soon` gate / the `match-time` expiry value).
 */
interface TrackedMarket {
  contestId: string;
  /** The neutral reference-game id — always set (a contest with no upstream linkage is skipped at discovery with `no-reference-odds`). PR 4b-ii uses it to open the odds Realtime channel. */
  referenceGameId: string;
  /** Contest sport / teams — for the risk engine's `Market` (per-team / per-sport caps). */
  sport: string;
  awayTeam: string;
  homeTeam: string;
  /** The contest's open moneyline speculation, as last seen at discovery. */
  speculationId: string;
  /** Contest match time, unix seconds. */
  matchTimeSec: number;
}

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
   * Unix-seconds deadline before which the boot fail-safe holds (DESIGN §12) — the
   * (TODO) per-market reconcile step must not post, AND state is not flushed (the
   * loaded state is empty / loss-derived, so persisting a clean `maker-state.json`
   * would let a restart-before-this-deadline resume with no hold). `null` = no hold;
   * a finite value = hold until then (`fixed-seconds` expiry: `now + expirySeconds`);
   * `Number.POSITIVE_INFINITY` = hold indefinitely (`match-time` expiry — a prior
   * soft-cancelled quote may be matchable until game start, so only
   * `--ignore-missing-state` / telemetry reconstruction lifts it). Set at boot; read
   * via `isHoldingQuoting()`.
   */
  private readonly holdQuotingUntil: number | null;
  private shutdownReason: ShutdownReason | null = null;
  private readonly abortController = new AbortController();
  /** The contests currently being tracked, keyed by `contestId`. Rebuilt each discovery cycle (add newcomers up to the cap; drop the departed). */
  private readonly trackedMarkets = new Map<string, TrackedMarket>();
  /** The tick number at/after which the next discovery cycle runs. `0` ⇒ the first tick (1) always discovers; bumped by `jitteredDiscoveryInterval()` after each cycle. */
  private nextDiscoveryAtTick = 0;

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
      random: opts.deps?.random ?? Math.random,
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
      const wait = this.bootAssessment.suggestedWaitSeconds;
      const matchTimeExpiry = this.config.orders.expiryMode === 'match-time';
      // Under `match-time` expiry a prior soft-cancelled quote stays matchable until
      // game start — `expirySeconds` is not a sufficient wait — so hold indefinitely
      // (only `--ignore-missing-state` / telemetry reconstruction lifts it). Under
      // `fixed-seconds` a one-`expirySeconds` wait suffices (DESIGN §12).
      if (matchTimeExpiry || wait === undefined) {
        this.holdQuotingUntil = Number.POSITIVE_INFINITY;
        this.deps.log(
          `[runner] holding quoting indefinitely — ${this.bootAssessment.reason}${matchTimeExpiry ? ' (match-time expiry: a soft-cancelled quote may be matchable until game start; reconstruct from telemetry or pass --ignore-missing-state once you have confirmed no prior commitment is open)' : ''}`,
        );
      } else {
        this.holdQuotingUntil = this.deps.now() + wait;
        this.deps.log(`[runner] holding quoting for ${wait}s — ${this.bootAssessment.reason}`);
      }
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
   * `kill` event and does a final state flush (unless a boot-time state-loss hold is
   * still active — see `tick()`). (In dry-run there's nothing posted to pull on
   * shutdown; live mode's `killCancelOnChain` path is Phase 3.) Single-use — call
   * once. The kill *file* is checked at the top of each iteration, so it's acted on
   * within one poll interval; a *signal* aborts the in-flight sleep, so it's acted
   * on after the current tick.
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
      // Each non-held tick already flushes; this final flush only matters when a
      // shutdown fires before the first such tick. Skipped while a state-loss hold is
      // active — same reason as in `tick()` (DESIGN §12).
      if (!this.isHoldingQuoting()) this.stateStore.flush(this.state);
    }
  }

  /** One iteration: discovery → per-market reconcile → fill-detection → age-out → flush. (The middle two are TODO follow-ups; discovery + age-out + flush are wired.) */
  private async tick(tick: number): Promise<void> {
    this.eventLog.emit('tick-start', { tick });
    try {
      if (tick >= this.nextDiscoveryAtTick) {
        await this.discover(tick);
        this.nextDiscoveryAtTick = tick + this.jitteredDiscoveryInterval();
      }
      // TODO(PR 4b-ii): for each market newly tracked by this discovery cycle, getOddsSnapshot (seed) then subscribeOdds (snapshot-first, up to odds.maxRealtimeChannels); for each departed market, unsubscribe its odds channel; the Realtime guardrails (DESIGN §10) — channel-error → market degraded + retry-next-cycle, dirty-event coalescing.
      // TODO(PR 4c): per-market reconcile — for each dirty / newly-tracked market, skip while isHoldingQuoting(): inv = inventoryFromState(this.state, now); buildDesiredQuote(config, market, refOdds, inv); the lazy-creation re-check from m.speculationId / ContestView.speculations (gone ⇒ `candidate` skipReason would-create-lazy-speculation); reconcileBook(recordsOnSpec, desired, config, now, inv.openCommitmentCount); in dry-run emit would-submit / would-replace / would-soft-cancel + `candidate` (skipReason cap-hit per deferredSides) + mutate this.state (synthetic visibleOpen records for toSubmit / toReplace.replacement; reclassify toReplace.stale / toSoftCancel.record → softCancelled).
      // TODO(PR 4c): fill-detection — adapter.listOpenCommitments(maker, maxOpen+buffer); diff against last tick's visibleOpen hash set; by-hash lookup of disappeared hashes → reclassify (filled / cancelled / expired); periodically adapter.getPositionStatus(maker). (In dry-run this is the live path — a no-op unless a prior live run left commitments/positions.)
      this.ageOut();
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'tick' });
    }
    // The flush is OUTSIDE the try/catch: if state can't be persisted the runner
    // must not keep ticking on an un-persistable state — let it propagate. It's
    // skipped entirely while a boot-time state-loss hold is active: the loaded state
    // is empty / loss-derived, and persisting a clean `maker-state.json` would let a
    // restart-before-the-hold-deadline resume with no hold (DESIGN §12). Once the
    // hold has elapsed (`fixed-seconds`) or been overridden, normal flushing resumes.
    if (!this.isHoldingQuoting()) this.stateStore.flush(this.state);
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

  /**
   * The discovery cycle (DESIGN §10): list the verified contests starting within
   * `marketSelection.maxStartsWithinHours` (filtered to the configured sports + the
   * allow/deny lists); drop tracked contests no longer in that set (started / scored
   * / out of window); for each *new* candidate (soonest game first) — confirm it has
   * an open moneyline speculation (else `candidate` `no-open-speculation`), isn't
   * already started (else `start-too-soon`), and there's room under
   * `marketSelection.maxTrackedContests` (else `tracking-cap-reached`); then
   * `getContest` for the reference-game id (else `no-reference-odds`) and track it,
   * with a `candidate` event (no `skipReason`). A `listContests` failure aborts the
   * cycle (the tracked set is left as-is, retried next cycle); a per-candidate
   * `getContest` failure just skips that candidate. (PR 4b-ii then seeds + subscribes
   * each newly-tracked market's odds and unsubscribes the departed ones.)
   */
  private async discover(tick: number): Promise<void> {
    const now = this.deps.now();
    const ms = this.config.marketSelection;
    let listed: ContestView[];
    try {
      listed = await this.adapter.listContests({ status: 'verified', hours: ms.maxStartsWithinHours, limit: 200 });
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'discovery', tick });
      return;
    }

    const sportsWanted = new Set<string>(ms.sports);
    const allow = new Set(ms.contestAllowList);
    const deny = new Set(ms.contestDenyList);
    const byId = new Map<string, ContestView>();
    for (const c of listed) {
      if (!sportsWanted.has(c.sport)) continue;
      if (allow.size > 0 && !allow.has(c.contestId)) continue;
      if (deny.has(c.contestId)) continue;
      byId.set(c.contestId, c);
    }

    for (const id of [...this.trackedMarkets.keys()]) {
      if (!byId.has(id)) {
        this.trackedMarkets.delete(id);
        // TODO(PR 4b-ii): unsubscribe this market's odds channel.
      }
    }

    const newCandidates = [...byId.values()]
      .filter((c) => !this.trackedMarkets.has(c.contestId))
      .sort((a, b) => Date.parse(a.matchTime) - Date.parse(b.matchTime));
    for (const c of newCandidates) {
      const spec = c.speculations.find((s) => s.marketType === 'moneyline' && s.open);
      if (spec === undefined) {
        this.eventLog.emit('candidate', { contestId: c.contestId, skipReason: 'no-open-speculation' });
        continue;
      }
      const matchTimeSec = Math.floor(Date.parse(c.matchTime) / 1000);
      if (!Number.isFinite(matchTimeSec)) continue; // malformed match time — skip silently (a data error, not a quoting decision)
      if (matchTimeSec <= now) {
        this.eventLog.emit('candidate', { contestId: c.contestId, skipReason: 'start-too-soon' });
        continue;
      }
      if (this.trackedMarkets.size >= ms.maxTrackedContests) {
        this.eventLog.emit('candidate', { contestId: c.contestId, skipReason: 'tracking-cap-reached' });
        continue;
      }
      let full: ContestView;
      try {
        full = await this.adapter.getContest(c.contestId);
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'discovery', contestId: c.contestId });
        continue;
      }
      if (full.referenceGameId === null) {
        this.eventLog.emit('candidate', { contestId: c.contestId, skipReason: 'no-reference-odds' });
        continue;
      }
      const confirmedSpec = full.speculations.find((s) => s.marketType === 'moneyline' && s.open);
      if (confirmedSpec === undefined) {
        this.eventLog.emit('candidate', { contestId: c.contestId, skipReason: 'no-open-speculation' });
        continue;
      }
      this.trackedMarkets.set(c.contestId, {
        contestId: c.contestId,
        referenceGameId: full.referenceGameId,
        sport: full.sport,
        awayTeam: full.awayTeam,
        homeTeam: full.homeTeam,
        speculationId: confirmedSpec.speculationId,
        matchTimeSec,
      });
      this.eventLog.emit('candidate', { contestId: c.contestId, sport: full.sport, matchTime: full.matchTime, speculationId: confirmedSpec.speculationId });
      // TODO(PR 4b-ii): seed + subscribe this market's odds (snapshot-first), up to odds.maxRealtimeChannels.
    }
  }

  /** Ticks until the next discovery cycle: `discovery.everyNTicks` jittered by ±`discovery.jitterPct` (so multiple MMs don't all discover on the same tick). At least 1. */
  private jitteredDiscoveryInterval(): number {
    const { everyNTicks, jitterPct } = this.config.discovery;
    const factor = 1 + (this.deps.random() * 2 - 1) * jitterPct; // in [1 - jitterPct, 1 + jitterPct)
    return Math.max(1, Math.round(everyNTicks * factor));
  }

  /** The contest ids the runner is currently tracking, sorted — for diagnostics / tests. */
  trackedContestIds(): readonly string[] {
    return [...this.trackedMarkets.keys()].sort();
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
