/**
 * The runner — the event loop (DESIGN §3, §8, §10). One `Runner` per process,
 * mode set by `config.mode.dryRun`. This module is the loop's *machinery* +
 * *discovery* + the *reference-odds* layer:
 *
 *   - the boot path (state load + the boot-time state-loss fail-safe — DESIGN §12);
 *   - the kill-switch (a file at `config.killSwitchFile`, or a SIGTERM / SIGINT →
 *     a graceful shutdown);
 *   - the tick loop;
 *   - **discovery** (every `discovery.everyNTicks` ticks — jittered — find the
 *     verified contests with an open moneyline speculation + a reference-game id
 *     starting within `marketSelection.maxStartsWithinHours`, honour the allow/deny
 *     lists, track up to `marketSelection.maxTrackedContests` of them, untrack the
 *     departed ones; `candidate` telemetry for the skipped/tracked);
 *   - **reference odds** (DESIGN §10's Realtime guardrails): for each tracked
 *     market keep its reference moneyline odds + freshness current — by default a
 *     Supabase Realtime channel per market (snapshot-first seed, then the channel's
 *     `onChange` / `onRefresh` / `onError`), capped at `odds.maxRealtimeChannels`
 *     (markets over the cap stay tracked but *degraded* — no odds — and are retried
 *     when a slot frees); `odds.subscribe: false` falls back to a bounded
 *     per-tick snapshot poll. A channel error degrades the market and the next
 *     discovery cycle re-subscribes it. The `dirty` flag (an `onChange` arrived) is
 *     read-and-cleared by the per-market reconcile — dirty-event coalescing;
 *   - **the per-market reconcile** (DESIGN §3 step 3, §8, §9): for each tracked
 *     market that needs it (its reference odds moved, or it has no fresh two-sided
 *     standing quote of ours, or it has become unquoteable while quotes are still up)
 *     — skipped entirely while the boot-time hold is active (DESIGN §12) — first the
 *     unquoteable gates (game imminent / reference odds missing or stale / odds
 *     channel down / speculation closed): each pulls (soft-cancels) any visible
 *     quote of ours on that speculation — the visible book must never carry a quote
 *     the MM is no longer pricing (DESIGN §2.2 / §3) — and emits a `candidate` skip;
 *     otherwise build the desired two-sided quote (`buildDesiredQuote` over the
 *     hypothetical inventory `inventoryFromState` derives from the persisted state),
 *     `reconcileBook` it against the maker's current book on that speculation, and
 *     apply the plan: in dry-run (the only mode in Phase 2) log it (`quote-intent`
 *     + `would-submit` / `would-replace` / `would-soft-cancel` + a `cap-hit`
 *     candidate per deferred side) and mutate the *hypothetical* inventory (add
 *     synthetic `visibleOpen` records for submits / replacements; reclassify
 *     pulled / replaced records to `softCancelled` — they stay matchable on chain,
 *     so the risk engine keeps counting them); live execution is Phase 3;
 *   - age-out of expired tracked commitments;
 *   - the per-tick state flush;
 *   - an interruptible sleep clamped to the `pollIntervalMs` floor.
 *
 * Still TODO follow-ups: fill-detection (Phase 3 — in dry-run nothing real is
 * posted, so there are no fills to detect; it's the live path's read side, wired
 * with the SDK write calls in Phase 3) and the bounded quote-competitiveness reads
 * over the `getSpeculation` orderbook this reconcile already fetches (PR 5).
 *
 * No `@ospex/sdk` import — all chain/API access goes through the `OspexAdapter`. The
 * clock, sleep, kill-switch probe, OS-signal registration, and randomness are
 * injectable (`RunnerDeps`) and so is the `OspexAdapter`, so the loop is
 * unit-testable: run a bounded number of ticks; drive shutdown via the kill probe
 * or a simulated signal; pin discovery timing; drive the odds callbacks via a fake
 * `subscribeOdds`; fake `getContest` / `getSpeculation` / `getOddsSnapshot`.
 */

import { existsSync } from 'node:fs';

import { POLL_INTERVAL_FLOOR_MS, type Config } from '../config/index.js';
import { buildDesiredQuote, inventoryFromState, reconcileBook, type BookReconciliation, type SoftCancelReason } from '../orders/index.js';
import type {
  ContestView,
  OddsSnapshotView,
  OddsSubscribeHandlersView,
  OspexAdapter,
  SpeculationView,
  Subscription,
} from '../ospex/index.js';
import type { QuoteSide } from '../pricing/index.js';
import type { Market } from '../risk/index.js';
import { assessStateLoss, type MakerCommitmentRecord, type MakerSide, type MakerState, type StateLossAssessment, type StateStore } from '../state/index.js';
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

/** The latest reference moneyline odds seen for a market (American; either side can be `null` if the upstream hasn't priced it). */
interface MoneylineOddsPair {
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

/**
 * A contest the runner is tracking — its market metadata + the reference-odds
 * state. The (TODO) per-market reconcile reads `speculationId` (re-confirms it's
 * still open — the lazy-creation check), `matchTimeSec` (the `start-too-soon`
 * gate / the `match-time` expiry value), `lastMoneylineOdds` (the input to
 * `buildDesiredQuote`), `lastOddsAt` (the `stale-reference` gate), and `dirty`
 * (whether to re-quote — read-and-cleared each pass, so a burst of odds moves
 * coalesces to one reconcile).
 */
interface TrackedMarket {
  contestId: string;
  /** The neutral reference-game id — always set (a contest with no upstream linkage is skipped at discovery with `no-reference-odds`). Used to open the odds Realtime channel. */
  referenceGameId: string;
  /** Contest sport / teams — for the risk engine's `Market` (per-team / per-sport caps). */
  sport: string;
  awayTeam: string;
  homeTeam: string;
  /** The contest's open moneyline speculation, as last seen at discovery. */
  speculationId: string;
  /** Contest match time, unix seconds. */
  matchTimeSec: number;
  /**
   * The live Realtime channel for this market's reference odds, or `null` — not
   * yet (re)subscribed (a newcomer this discovery cycle, or one whose channel
   * errored), over the `odds.maxRealtimeChannels` cap, or running in
   * `odds.subscribe: false` polling mode. A `null` here on a discovery cycle is
   * the signal to (re)subscribe.
   */
  subscription: Subscription | null;
  /** The latest reference moneyline odds, or `null` if none seen yet (the seed snapshot failed / the upstream has no moneyline row for the game). */
  lastMoneylineOdds: MoneylineOddsPair | null;
  /** Unix seconds — when the reference odds were last seen fresh (the seed snapshot, or an `onChange` / `onRefresh` from the channel, or a polling snapshot). `null` until the first reading. */
  lastOddsAt: number | null;
  /** An `onChange` (a genuine price move, or a polling snapshot that differed) arrived since the per-market reconcile last consumed this market. Newly-seeded markets start `true` (they need their first reconcile). */
  dirty: boolean;
  /** Unix seconds — when the per-market reconcile last processed this market (a quote computed, or a gate hit), or `null` if never. Throttles the "we have no fresh standing quote" re-reconcile (a `dirty` event always triggers an immediate reconcile regardless). */
  lastReconciledAt: number | null;
}

/**
 * A read-only snapshot of a tracked market's state — for diagnostics / tests /
 * (Phase 3) `ospex-mm status`. The live `Subscription` handle is reduced to a
 * `subscribed` boolean.
 */
export interface TrackedMarketView {
  contestId: string;
  referenceGameId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  speculationId: string;
  matchTimeSec: number;
  /** Is a Realtime odds channel live for this market right now? (`false` while degraded / over the channel cap / in `odds.subscribe: false` polling mode.) */
  subscribed: boolean;
  /** The latest reference moneyline odds (American), or `null` if none seen yet. */
  lastMoneylineOdds: MoneylineOddsPair | null;
  /** Unix seconds — when the reference odds were last seen fresh; `null` until the first reading. */
  lastOddsAt: number | null;
  /** Has the reference odds moved since the per-market reconcile last consumed this market? */
  dirty: boolean;
  /** Unix seconds — when the per-market reconcile last processed this market, or `null` if never. */
  lastReconciledAt: number | null;
}

/** Reasons a tracked market is in a `degraded` (no live odds channel) state — carried on the `degraded` telemetry event. */
type DegradedReason = 'channel-error' | 'subscribe-failed' | 'channel-cap';

export class Runner {
  readonly config: Config;
  /** The boot-time state-loss assessment (DESIGN §12), computed in the constructor — `holdQuoting`, the reason, and (when holding) `suggestedWaitSeconds`. */
  readonly bootAssessment: StateLossAssessment;

  private readonly adapter: OspexAdapter;
  private readonly stateStore: StateStore;
  private readonly eventLog: EventLog;
  private readonly maxTicks: number | undefined;
  private readonly deps: RunnerDeps;
  /** The chain's moneyline scorer module address — every commitment the MM (would) post points at it (v0 quotes moneyline only). Cached at boot from `adapter.addresses()`. */
  private readonly moneylineScorer: string;
  /** Monotonic suffix for the synthetic commitment hashes the dry-run reconcile mints (`dry:<runId>:<n>`) — unique within a run; a run's id makes them unique across runs, so a restart's loaded state can't collide. */
  private syntheticCommitmentSeq = 0;

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
    this.moneylineScorer = this.adapter.addresses().scorers.moneyline;
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

  /** One iteration: discovery → reference-odds refresh → per-market reconcile → age-out → flush. (Fill-detection — Phase 3 — comes between the reconcile and age-out; nothing real is posted in dry-run, so there's nothing to detect yet.) */
  private async tick(tick: number): Promise<void> {
    this.eventLog.emit('tick-start', { tick });
    try {
      const ranDiscovery = tick >= this.nextDiscoveryAtTick;
      if (ranDiscovery) {
        await this.discover(tick);
        this.nextDiscoveryAtTick = tick + this.jitteredDiscoveryInterval();
      }
      await this.refreshTrackedOdds({ ranDiscovery });
      await this.reconcileMarkets();
      // TODO(Phase 3): fill-detection — adapter.listOpenCommitments(maker, maxOpen+buffer); diff against last tick's visibleOpen hash set; by-hash lookup of disappeared hashes → reclassify (filled / cancelled / expired); periodically adapter.getPositionStatus(maker). Lives next to the live write path — in dry-run nothing real was posted, so there's nothing of the MM's to detect.
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
   * / out of window — tearing down each one's odds channel); for each *new* candidate
   * (soonest game first) — confirm it has an open moneyline speculation (else
   * `candidate` `no-open-speculation`), isn't already started (else `start-too-soon`),
   * and there's room under `marketSelection.maxTrackedContests` (else
   * `tracking-cap-reached`); then `getContest` for the reference-game id (else
   * `no-reference-odds`) and track it, with a `candidate` event (no `skipReason`). A
   * `listContests` failure aborts the cycle (the tracked set is left as-is, retried
   * next cycle); a per-candidate `getContest` failure just skips that candidate.
   * `refreshTrackedOdds` (called right after this) then seeds + subscribes each
   * newly-tracked market's odds.
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
        const departed = this.trackedMarkets.get(id);
        this.trackedMarkets.delete(id);
        if (departed?.subscription) void this.dropChannel(departed.subscription, departed.contestId);
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
        subscription: null,
        lastMoneylineOdds: null,
        lastOddsAt: null,
        dirty: false,
        lastReconciledAt: null,
      });
      this.eventLog.emit('candidate', { contestId: c.contestId, sport: full.sport, matchTime: full.matchTime, speculationId: confirmedSpec.speculationId });
    }
  }

  /**
   * Keep the tracked markets' reference moneyline odds + freshness current
   * (DESIGN §10). Two modes:
   *
   * - `odds.subscribe: true` (default) — on a discovery cycle, (re)subscribe a
   *   Supabase Realtime channel for each tracked market that doesn't have a live
   *   one (a newcomer, or one whose channel errored), up to `odds.maxRealtimeChannels`
   *   (markets over the cap stay tracked but degraded — no odds — and are retried
   *   when a slot frees); the channel's `onChange` / `onRefresh` / `onError`
   *   handlers keep the market's odds + freshness + dirty flag current between
   *   cycles. The discovery interval is the (re)subscription throttle, so this is a
   *   no-op on non-discovery ticks.
   * - `odds.subscribe: false` — no Realtime; snapshot every tracked market every
   *   tick (bounded — one `getOddsSnapshot` per tracked market, ≤ `maxTrackedContests`).
   *
   * Each (re)subscribe is "snapshot-first": a `getOddsSnapshot` seed so the market
   * can be quoted next tick rather than only after the upstream price next moves. A
   * per-market read failure (snapshot or subscribe) is logged / degraded and left
   * for the next cycle; nothing here throws into the tick loop.
   */
  private async refreshTrackedOdds(opts: { ranDiscovery: boolean }): Promise<void> {
    if (!this.config.odds.subscribe) {
      await this.pollTrackedOdds();
      return;
    }
    if (!opts.ranDiscovery) return; // subscription mode: the discovery cycle is the (re)subscription throttle
    await this.syncOddsSubscriptions();
  }

  /** Subscription mode (`odds.subscribe: true`): (re)subscribe a Realtime channel for each tracked market lacking a live one, soonest games first, up to `odds.maxRealtimeChannels`; the rest get a `degraded` `channel-cap` event (retried when a slot frees). */
  private async syncOddsSubscriptions(): Promise<void> {
    const cap = this.config.odds.maxRealtimeChannels;
    let live = 0;
    const needSubscription: TrackedMarket[] = [];
    for (const m of this.trackedMarkets.values()) {
      if (m.subscription !== null) live += 1;
      else needSubscription.push(m);
    }
    needSubscription.sort((a, b) => a.matchTimeSec - b.matchTimeSec); // soonest games get channels first
    for (const m of needSubscription) {
      if (live >= cap) {
        this.emitDegraded(m, 'channel-cap');
        continue;
      }
      await this.seedOdds(m); // snapshot-first; a failure is logged and doesn't block the subscribe
      if (await this.subscribeMarketOdds(m)) live += 1;
    }
  }

  /** `odds.subscribe: false` mode: snapshot every tracked market's reference odds this tick. A market whose moneyline odds changed since last tick (or had none) is marked dirty (the per-market reconcile re-quotes it); an unchanged one just has its freshness bumped. A per-market failure is logged and skipped. */
  private async pollTrackedOdds(): Promise<void> {
    for (const m of this.trackedMarkets.values()) {
      const snap = await this.snapshotOdds(m, 'odds-poll');
      if (snap === null) continue;
      const ml = snap.odds.moneyline;
      const changed = ml !== null && (m.lastMoneylineOdds === null || m.lastMoneylineOdds.awayOddsAmerican !== ml.awayOddsAmerican || m.lastMoneylineOdds.homeOddsAmerican !== ml.homeOddsAmerican);
      this.recordOdds(m, ml, { markDirty: changed });
    }
  }

  /** Seed a market's reference odds from a one-shot snapshot (DESIGN §10 — "snapshot-first"). A failure is logged (inside `snapshotOdds`) and ignored: the Realtime channel will deliver odds on its first `onChange`. */
  private async seedOdds(m: TrackedMarket): Promise<void> {
    const snap = await this.snapshotOdds(m, 'odds-seed');
    if (snap !== null) this.recordOdds(m, snap.odds.moneyline, { markDirty: true });
  }

  /** One-shot reference-odds snapshot for a market; logs an `error` (with the given `phase`) and returns `null` on failure. */
  private async snapshotOdds(m: TrackedMarket, phase: 'odds-seed' | 'odds-poll'): Promise<OddsSnapshotView | null> {
    try {
      return await this.adapter.getOddsSnapshot(m.contestId);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase, contestId: m.contestId });
      return null;
    }
  }

  /**
   * Open a Realtime channel for a market's reference moneyline odds and install it
   * on the market (`m.subscription`), wiring `onChange` (→ store the odds, bump
   * freshness, mark dirty) / `onRefresh` (→ store the odds, bump freshness) /
   * `onError` (→ degrade the market: clear its subscription, emit `degraded`, tear
   * down the dead channel; the next discovery cycle re-subscribes it). Returns
   * `true` if subscribed, `false` if `subscribeOdds` rejected (e.g. the
   * Realtime-credentials fetch — `/v1/config/public` — failed), in which case a
   * `degraded` `subscribe-failed` event is emitted and the next discovery cycle
   * retries. The `onError` handler only acts while *its* channel is still the live
   * one (`m.subscription === thisSub`), so a stale error from a channel already
   * replaced by a later cycle's re-subscribe can't clobber the new one.
   */
  private async subscribeMarketOdds(m: TrackedMarket): Promise<boolean> {
    let thisSub: Subscription | null = null;
    const handlers: OddsSubscribeHandlersView = {
      onChange: (u) => this.recordOdds(m, u, { markDirty: true }),
      onRefresh: (u) => this.recordOdds(m, u, { markDirty: false }),
      onError: (err) => {
        if (thisSub === null || m.subscription !== thisSub) return; // a stale error from an already-replaced channel
        m.subscription = null;
        this.emitDegraded(m, 'channel-error', err.message);
        void this.dropChannel(thisSub, m.contestId);
      },
    };
    try {
      const sub = await this.adapter.subscribeOdds({ referenceGameId: m.referenceGameId, market: 'moneyline' }, handlers);
      thisSub = sub;
      m.subscription = sub; // installed synchronously after the await resolves — no gap for an onError to race with
      return true;
    } catch (err) {
      this.emitDegraded(m, 'subscribe-failed', errMessage(err));
      return false;
    }
  }

  /**
   * Apply a fresh *reference-odds response* for a tracked market. `recordOdds` is
   * called only when the feed actually responded (a `getOddsSnapshot` that resolved,
   * or an `onChange` / `onRefresh` payload), so it always bumps `lastOddsAt` — that's
   * the "the feed is alive" signal that the `stale-reference` gate keys off (a
   * *failed* snapshot request never reaches here, so `lastOddsAt` then ages out).
   * `odds === null` means the response had no moneyline row for this game — we have
   * no usable reference odds *now*: clear `lastMoneylineOdds`, and if it had been
   * usable, mark the market dirty so the next reconcile pulls our visible quotes via
   * the `no-reference-odds` gate (distinct from the `stale-reference` gate — the feed
   * isn't dead, it just has no moneyline). Otherwise store the new odds and set
   * `dirty` if `markDirty` (the caller's "the price moved / appeared" signal).
   */
  private recordOdds(m: TrackedMarket, odds: MoneylineOddsPair | null, opts: { markDirty: boolean }): void {
    m.lastOddsAt = this.deps.now();
    if (odds === null) {
      if (m.lastMoneylineOdds !== null) m.dirty = true; // it was usable a moment ago — the next reconcile must pull our quotes (no-reference-odds gate)
      m.lastMoneylineOdds = null;
      return;
    }
    m.lastMoneylineOdds = { awayOddsAmerican: odds.awayOddsAmerican, homeOddsAmerican: odds.homeOddsAmerican };
    if (opts.markDirty) m.dirty = true;
  }

  /** Best-effort teardown of a Realtime channel — a failure is logged but not fatal (the server reaps idle channels). */
  private async dropChannel(sub: Subscription, contestId: string): Promise<void> {
    try {
      await sub.unsubscribe();
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'odds-unsubscribe', contestId });
    }
  }

  private emitDegraded(m: TrackedMarket, reason: DegradedReason, detail?: string): void {
    const payload: Record<string, unknown> = { contestId: m.contestId, referenceGameId: m.referenceGameId, reason };
    if (detail !== undefined) payload.detail = detail;
    this.eventLog.emit('degraded', payload);
  }

  // ── per-market reconcile (DESIGN §3 step 3, §8, §9) ───────────────────────

  /**
   * For each tracked market that needs it — skipped entirely while the boot-time
   * state-loss hold is active (DESIGN §12, don't quote on a blank slate) — recompute
   * the desired two-sided quote and reconcile it against the maker's current book on
   * that speculation, *or* (when the market has become unquoteable) pull its visible
   * quotes. `dirty` is read-and-cleared / `lastReconciledAt` is set only when a
   * reconcile *decision was applied* — a transient `getSpeculation` failure leaves
   * both alone so the market retries promptly next tick rather than hiding behind the
   * `staleAfterSeconds` throttle (DESIGN §3).
   */
  private async reconcileMarkets(): Promise<void> {
    if (this.isHoldingQuoting()) return; // DESIGN §12 — must not resume quoting on a blank slate
    const now = this.deps.now();
    for (const m of this.trackedMarkets.values()) {
      if (!this.needsReconcile(m, now)) continue;
      const outcome = await this.reconcileMarket(m, now);
      if (outcome === 'applied') {
        m.dirty = false; // read-and-clear (a re-fired onChange before the next tick re-arms it)
        m.lastReconciledAt = now;
      }
      // 'transient-failure' (a getSpeculation read failed): leave `dirty` / `lastReconciledAt` so the market retries next tick
    }
  }

  /**
   * Does this market need a reconcile this pass? `dirty` (reference odds moved) → yes,
   * now. An *unquoteable* market that still has visible quotes of ours → yes, now
   * (`reconcileMarket`'s gates pull them — a stale quote must not stay visible, DESIGN
   * §2.2 / §3). Otherwise → only if it lacks a fresh two-sided standing quote of ours
   * AND it hasn't been reconciled in the last `orders.staleAfterSeconds` (so a
   * flat-odds market rolls its quote forward roughly every `staleAfterSeconds`, and a
   * persistently-refused / always-gated market is re-evaluated at that cadence rather
   * than every tick).
   */
  private needsReconcile(m: TrackedMarket, now: number): boolean {
    if (m.dirty) return true;
    if (this.marketUnquoteable(m, now) && this.hasVisibleQuotesOn(m.speculationId, now)) return true;
    if (!this.lacksFreshTwoSidedQuote(m, now)) return false;
    return m.lastReconciledAt === null || now - m.lastReconciledAt >= this.config.orders.staleAfterSeconds;
  }

  /**
   * Is this market currently unquoteable on grounds the runner can see without an SDK
   * round-trip — its game is imminent (starts within one `expirySeconds` window); we
   * have no usable reference moneyline odds (none seen yet, the latest response had no
   * moneyline row, or a side isn't priced); the feed has stopped responding
   * (`now - lastOddsAt > staleReferenceAfterSeconds` — a `getOddsSnapshot` failure or
   * no `onChange` / `onRefresh` in a while); or (in subscription mode) its Realtime
   * odds channel has errored / never came up? When such a market still has visible
   * quotes of ours, they must be pulled (DESIGN §2.2: never quote on missing /
   * ambiguous / stale data; never leave a stale quote visible) — `needsReconcile`
   * therefore forces a reconcile for it, and `reconcileMarket`'s matching gate does
   * the pull. (The speculation-closed case isn't here — it needs the `getSpeculation`
   * read to detect, so it's handled inside `reconcileMarket` after that read.)
   */
  private marketUnquoteable(m: TrackedMarket, now: number): boolean {
    if (m.matchTimeSec - now <= this.config.orders.expirySeconds) return true; // the game starts within one expiry window
    const ml = m.lastMoneylineOdds;
    if (ml === null || ml.awayOddsAmerican === null || ml.homeOddsAmerican === null) return true; // no usable reference moneyline odds — none seen yet, the latest response had no moneyline row, or a side isn't priced
    if (m.lastOddsAt !== null && now - m.lastOddsAt > this.config.orders.staleReferenceAfterSeconds) return true; // the feed has stopped responding
    if (this.config.odds.subscribe && m.subscription === null) return true; // the Realtime odds channel errored / never came up (re-subscribed on the next discovery cycle; in polling mode pollTrackedOdds re-snapshots every tick, so there's no "degraded" notion)
    return false;
  }

  /** Does the maker have an API-visible commitment of its own (`visibleOpen` / `partiallyFilled`, not expired) on `speculationId` right now? */
  private hasVisibleQuotesOn(speculationId: string, now: number): boolean {
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== speculationId) continue;
      if (r.lifecycle !== 'visibleOpen' && r.lifecycle !== 'partiallyFilled') continue;
      if (r.expiryUnixSec <= now) continue;
      return true;
    }
    return false;
  }

  /** True unless the maker has a `visibleOpen`, not-expired, not-yet-stale commitment of its own on `m.speculationId` for *both* sides (v0 always quotes both — `pricing.quoteBothSides`). A stale quote counts as "not a fresh standing quote", so the market re-reconciles to roll it forward before it expires. */
  private lacksFreshTwoSidedQuote(m: TrackedMarket, now: number): boolean {
    const fresh = new Set<MakerSide>();
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== m.speculationId) continue;
      if (r.lifecycle !== 'visibleOpen') continue;
      if (r.expiryUnixSec <= now) continue;
      if (now - r.postedAtUnixSec > this.config.orders.staleAfterSeconds) continue;
      fresh.add(r.makerSide);
    }
    return !(fresh.has('away') && fresh.has('home'));
  }

  /**
   * Reconcile one market: the cheap gates, then the lazy-creation re-check, then
   * price → plan → apply. A gate that fires **pulls any visible quotes of the
   * maker's on that speculation** (the visible book must not carry a quote the MM is
   * no longer pricing — DESIGN §2.2 / §3) and emits a `candidate` with the skip
   * reason. The `getSpeculation` re-check failing is `error`-logged and returns
   * `'transient-failure'` (no decision applied — `reconcileMarkets` then leaves
   * `dirty` / `lastReconciledAt` so the market retries promptly next tick; it's
   * treated as transient, not as "would lazily create a speculation": discovery
   * pre-filtered, and a permanently-gone speculation is essentially impossible on
   * chain). Pricing / risk refusals come back as a `quote-intent` with
   * `canQuote: false` (carrying the refusal notes) plus — via `reconcileBook` — the
   * `would-soft-cancel`s that pull any standing quote off an unwanted side. Returns
   * `'applied'` whenever a reconcile decision (a gate-pull, or a plan) was applied.
   */
  private async reconcileMarket(m: TrackedMarket, now: number): Promise<'applied' | 'transient-failure'> {
    // Gate: the game starts within one expiry window — stop quoting it (a fresh quote would still be matchable at game time / outlive the pre-game window), and pull whatever's still up.
    if (m.matchTimeSec - now <= this.config.orders.expirySeconds) {
      this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'start-too-soon' });
      return 'applied';
    }
    // Gate: the reference odds have gone stale (the upstream feed stopped advancing). A never-seen-odds market (`lastOddsAt === null`) falls through to the `no-reference-odds` gate below — `lastOddsAt === null` iff `lastMoneylineOdds === null` (`recordOdds` sets both or neither).
    if (m.lastOddsAt !== null && now - m.lastOddsAt > this.config.orders.staleReferenceAfterSeconds) {
      this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'stale-reference' });
      return 'applied';
    }
    // Gate: no usable reference moneyline odds (both sides must be priced — `buildDesiredQuote` itself refuses out-of-range *values*, but it can't be handed a `null`).
    const ml = m.lastMoneylineOdds;
    if (ml === null || ml.awayOddsAmerican === null || ml.homeOddsAmerican === null) {
      this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'no-reference-odds' });
      return 'applied';
    }
    // Gate: the Realtime odds channel is down (subscription mode) — the reference is no longer being kept fresh, so treat it as unsafe and pull. (`syncOddsSubscriptions` re-subscribes on the next discovery cycle; the existing `degraded` event already carries the precise cause.)
    if (this.config.odds.subscribe && m.subscription === null) {
      this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'stale-reference' });
      return 'applied';
    }
    // Lazy-creation re-check (DESIGN §6/§9): the speculation we'd post to must still exist + be open — discovery confirmed it; re-confirm via the per-speculation detail read (PR 5's competitiveness check reuses the `getSpeculation` orderbook).
    let spec: SpeculationView;
    try {
      spec = await this.adapter.getSpeculation(m.speculationId);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'reconcile', contestId: m.contestId });
      return 'transient-failure'; // no decision applied — retry next tick rather than wait out the staleAfterSeconds throttle
    }
    if (!spec.open) {
      this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'no-open-speculation' });
      return 'applied';
    }
    // Price → plan → apply.
    const market: Market = { contestId: m.contestId, sport: m.sport, awayTeam: m.awayTeam, homeTeam: m.homeTeam };
    const inventory = inventoryFromState(this.state, now);
    const desired = buildDesiredQuote(this.config, market, { away: ml.awayOddsAmerican, home: ml.homeOddsAmerican }, inventory);
    this.eventLog.emit('quote-intent', {
      contestId: m.contestId,
      speculationId: m.speculationId,
      sport: m.sport,
      awayTeam: m.awayTeam,
      homeTeam: m.homeTeam,
      canQuote: desired.result.canQuote,
      away: quoteSideSummary(desired.result.away),
      home: quoteSideSummary(desired.result.home),
      notes: desired.result.notes,
    });
    const recordsOnSpec = Object.values(this.state.commitments).filter((r) => r.speculationId === m.speculationId);
    const plan = reconcileBook(recordsOnSpec, desired, this.config, now, inventory.openCommitmentCount);
    this.applyReconcilePlan(m, plan, now);
    return 'applied';
  }

  /** Pull (off-chain) every API-visible commitment of the maker's on `m.speculationId` — reclassify it `softCancelled`, emit `would-soft-cancel` (reason `side-not-quoted`: when a market is unquoteable, neither side is being quoted). Used by the unquoteable-market gates above — the visible book must never carry a quote the MM is no longer pricing (DESIGN §2.2 / §3). The pulled quote's signed payload stays matchable on chain until expiry, so the risk engine keeps counting it. */
  private pullVisibleQuotes(m: TrackedMarket, now: number): void {
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== m.speculationId) continue;
      if (r.lifecycle !== 'visibleOpen' && r.lifecycle !== 'partiallyFilled') continue;
      if (r.expiryUnixSec <= now) continue; // already dead on chain — `ageOut` handles it
      this.softCancelRecord(r, 'side-not-quoted', now);
    }
  }

  /** Reclassify a tracked commitment `softCancelled` (off-chain pull) + emit `would-soft-cancel`. */
  private softCancelRecord(record: MakerCommitmentRecord, reason: SoftCancelReason, now: number): void {
    record.lifecycle = 'softCancelled';
    record.updatedAtUnixSec = now;
    this.eventLog.emit('would-soft-cancel', softCancelEventPayload(record, reason));
  }

  /** Apply a `reconcileBook` plan in dry-run: log each item (`would-submit` / `would-replace` / `would-soft-cancel`, plus a `cap-hit` candidate per deferred side) and mutate the hypothetical inventory — add a synthetic `visibleOpen` record per submit / replacement, reclassify each pulled / replaced record to `softCancelled` (its signed payload stays matchable until expiry, so the risk engine keeps counting it). Live execution — the real SDK write calls — is Phase 3. */
  private applyReconcilePlan(m: TrackedMarket, plan: BookReconciliation, now: number): void {
    const expiryUnixSec = this.expiryForNewCommitment(m, now);
    for (const qs of plan.toSubmit) {
      const record = this.mintSyntheticCommitment(m, qs, now, expiryUnixSec);
      this.state.commitments[record.hash] = record;
      this.eventLog.emit('would-submit', this.commitmentEventPayload(record));
    }
    for (const rp of plan.toReplace) {
      rp.stale.lifecycle = 'softCancelled';
      rp.stale.updatedAtUnixSec = now;
      const record = this.mintSyntheticCommitment(m, rp.replacement, now, expiryUnixSec);
      this.state.commitments[record.hash] = record;
      this.eventLog.emit('would-replace', {
        replacedCommitmentHash: rp.stale.hash,
        newCommitmentHash: record.hash,
        speculationId: m.speculationId,
        contestId: m.contestId,
        sport: m.sport,
        awayTeam: m.awayTeam,
        homeTeam: m.homeTeam,
        makerSide: rp.replacement.side,
        reason: rp.reason,
        fromOddsTick: rp.stale.oddsTick,
        toOddsTick: rp.replacement.quoteTick,
        riskAmountWei6: record.riskAmountWei6,
        expiryUnixSec,
      });
    }
    for (const sc of plan.toSoftCancel) this.softCancelRecord(sc.record, sc.reason, now);
    for (const side of plan.deferredSides) {
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'cap-hit', side });
    }
  }

  /** A new commitment's expiry, unix seconds: `now + orders.expirySeconds` under `fixed-seconds` mode (the v0 default — short-lived, rolled forward), or the contest's match time under `match-time` mode (the quote lapses exactly at game start). */
  private expiryForNewCommitment(m: TrackedMarket, now: number): number {
    return this.config.orders.expiryMode === 'match-time' ? m.matchTimeSec : now + this.config.orders.expirySeconds;
  }

  /** Mint a `visibleOpen` `MakerCommitmentRecord` for a `QuoteSide` the dry-run reconcile would post — a synthetic EIP-712 hash (`dry:<runId>:<n>`, unique within / across runs), the quote's tick + size, the contest / speculation metadata. (Live mode posts the real commitment and records its real hash; this is the hypothetical-inventory equivalent.) */
  private mintSyntheticCommitment(m: TrackedMarket, qs: QuoteSide, now: number, expiryUnixSec: number): MakerCommitmentRecord {
    this.syntheticCommitmentSeq += 1;
    return {
      hash: `dry:${this.eventLog.runId}:${this.syntheticCommitmentSeq}`,
      speculationId: m.speculationId,
      contestId: m.contestId,
      sport: m.sport,
      awayTeam: m.awayTeam,
      homeTeam: m.homeTeam,
      scorer: this.moneylineScorer,
      makerSide: qs.side,
      oddsTick: qs.quoteTick,
      riskAmountWei6: String(qs.sizeWei6),
      filledRiskWei6: '0',
      lifecycle: 'visibleOpen',
      expiryUnixSec,
      postedAtUnixSec: now,
      updatedAtUnixSec: now,
    };
  }

  private commitmentEventPayload(record: MakerCommitmentRecord): Record<string, unknown> {
    return {
      commitmentHash: record.hash,
      speculationId: record.speculationId,
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      makerSide: record.makerSide,
      oddsTick: record.oddsTick,
      riskAmountWei6: record.riskAmountWei6,
      expiryUnixSec: record.expiryUnixSec,
    };
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

  /** A read-only snapshot of one tracked market's state — for diagnostics / tests / (Phase 3) `ospex-mm status`. `undefined` if `contestId` isn't tracked. */
  trackedMarketView(contestId: string): TrackedMarketView | undefined {
    const m = this.trackedMarkets.get(contestId);
    if (m === undefined) return undefined;
    return {
      contestId: m.contestId,
      referenceGameId: m.referenceGameId,
      sport: m.sport,
      awayTeam: m.awayTeam,
      homeTeam: m.homeTeam,
      speculationId: m.speculationId,
      matchTimeSec: m.matchTimeSec,
      subscribed: m.subscription !== null,
      lastMoneylineOdds: m.lastMoneylineOdds === null ? null : { ...m.lastMoneylineOdds },
      lastOddsAt: m.lastOddsAt,
      dirty: m.dirty,
      lastReconciledAt: m.lastReconciledAt,
    };
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Compact a `QuoteSide` (or `null`) for the `quote-intent` event payload — the odds tick + the quoted size (USDC, and wei6 as a decimal string). */
function quoteSideSummary(qs: QuoteSide | null): { oddsTick: number; sizeUSDC: number; sizeWei6: string } | null {
  return qs === null ? null : { oddsTick: qs.quoteTick, sizeUSDC: qs.sizeUSDC, sizeWei6: String(qs.sizeWei6) };
}

/** The `would-soft-cancel` event payload for a pulled commitment record. */
function softCancelEventPayload(record: MakerCommitmentRecord, reason: SoftCancelReason): Record<string, unknown> {
  return {
    commitmentHash: record.hash,
    speculationId: record.speculationId,
    contestId: record.contestId,
    sport: record.sport,
    awayTeam: record.awayTeam,
    homeTeam: record.homeTeam,
    makerSide: record.makerSide,
    oddsTick: record.oddsTick,
    reason,
  };
}
