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
 *     apply the plan — the reconcile is **mode-aware**: in live mode the submits go
 *     through `commitments.submitRaw` (the SDK signs + POSTs the 9-field EIP-712
 *     commitment) and the pulls (off a replaced incumbent, an unwanted side, or an
 *     unquoteable market) through `commitments.cancel` (the gasless off-chain
 *     cancel); in dry-run nothing leaves the process — a synthetic `dry:` hash is
 *     minted instead of a real one and the cancel is a no-op. Either way the same
 *     state mutations and the same event stream are produced — only the kind names
 *     differ (`submit` / `replace` / `soft-cancel` in live, the `would-` prefixed
 *     counterparts in dry-run) and the recorded `commitmentHash` is the real one in
 *     live. A live submit / cancel that throws is logged (`error`, `phase: 'submit'`
 *     / `'cancel'`) and the tick continues — never crashes; a failed pull leaves the
 *     quote `visibleOpen` for the next pass to retry. A `cap-hit` candidate is
 *     emitted per deferred side in both modes. Then it measures **quote
 *     competitiveness** (DESIGN §8): for each would-be quote, where it'd sit
 *     relative to the visible orderbook on its side (the `getSpeculation` above
 *     already fetched it — no extra read) and to the reference odds — a
 *     `quote-competitiveness` event per side, or one `competitiveness-unavailable`
 *     if that orderbook somehow isn't populated (the MM's own commitments are
 *     filtered out by `c.maker === this.makerAddress`);
 *   - **fill detection** (live only — DESIGN §10): each tick — before the reconcile so
 *     a fill within this tick dirties the market and the same reconcile re-prices the
 *     imbalance — diff `listOpenCommitments(maker)` against the local
 *     `visibleOpen`/`partiallyFilled` set; per-disappeared-hash `getCommitment(hash)`
 *     → reclassify (`filled` → create / extend a `MakerPositionRecord`, emit `fill`
 *     `{partial:false}`; `expired` → emit `expire`; `cancelled` →
 *     `authoritativelyInvalidated`, no event). A still-listed hash whose
 *     `filledRiskAmount` advanced → bump `filledRiskWei6`, reclassify
 *     `partiallyFilled`, extend the position by the delta, emit `fill`
 *     `{partial:true}`. Bounded reads — one `listOpenCommitments` per tick, one
 *     `getCommitment` per disappeared hash;
 *   - age-out of expired tracked commitments;
 *   - a prune of old terminal (`expired` / `filled` / `authoritativelyInvalidated`)
 *     commitment records, so a long shadow run's state file stays bounded;
 *   - the per-tick state flush;
 *   - an interruptible sleep clamped to the `pollIntervalMs` floor.
 *
 * Still TODO follow-ups: P&L (realized over settled / claimed; unrealized over
 * active marked to fair — natural home is the `summary` aggregator that walks
 * `fill` / `position-transition` / `settle` / `claim` events), and the on-chain
 * authoritative cancel / `raiseMinNonce` paths used by the kill switch's
 * `killCancelOnChain: true` mode and `cancel-stale --authoritative`. Auto-settle
 * + auto-claim (`settlement.autoSettleOwn` / `autoClaimOwn`) are wired here —
 * they walk `state.positions` each tick after the position poll, gas-gated by
 * `canSpendGas` with `mayUseReserve = settlement.continueOnGasBudgetExhausted`,
 * and emit `settle` / `claim` events; the `claim` path stamps the local
 * `MakerPositionStatus` to `claimed` (no longer the poll's domain).
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
import { buildDesiredQuote, inventoryFromState, reconcileBook, type BookReconciliation, type DesiredQuote, type SoftCancelReason } from '../orders/index.js';
import type {
  ApproveResult,
  ApproveUSDCAmount,
  ApprovalsSnapshot,
  Commitment,
  ContestView,
  Hex,
  OddsSnapshotView,
  OddsSubscribeHandlersView,
  OspexAdapter,
  PositionStatus,
  SpeculationView,
  Subscription,
} from '../ospex/index.js';
import { decimalToTick, inverseOddsTick, isTickInRange, oppositeSide, positionTypeForSide, toProtocolQuote, type ProtocolQuote, type QuoteSide } from '../pricing/index.js';
import { canSpendGas, requiredPositionModuleAllowanceUSDC, type Market } from '../risk/index.js';
import { assessStateLoss, type CommitmentLifecycle, type MakerCommitmentRecord, type MakerPositionRecord, type MakerPositionStatus, type MakerSide, type MakerState, type StateLossAssessment, type StateStore } from '../state/index.js';
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
  /**
   * The maker wallet (live mode only) — the signer's address, resolved by `runRun`
   * via `await signer.getAddress()` before the Runner is constructed. **Required in
   * live mode** (`config.mode.dryRun: false`); the ctor refuses a missing value
   * since fill detection (`listOpenCommitments(maker, …)`) and the competitiveness
   * self-exclusion (`c.maker !== maker`) both need it. Absent in dry-run (the
   * shadow loop reads no live commitments and exposes no self-maker on the book).
   */
  makerAddress?: Hex;
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
  /** The chain's moneyline scorer module address — every commitment the MM posts (live) / would post (dry-run) points at it (v0 quotes moneyline only). Cached at boot from `adapter.addresses()`. */
  private readonly moneylineScorer: Hex;
  /**
   * The maker wallet — lowercased `Hex`. Set in live mode (from `RunnerOptions.makerAddress`,
   * which `runRun` derives from `signer.getAddress()`); `null` in dry-run. Used by fill detection
   * (`listOpenCommitments(maker, …)`) and by the competitiveness check to exclude the MM's own
   * orderbook entries when comparing against the rest of the book. Always lowercased so
   * comparisons with the SDK's `Commitment.maker` are case-insensitive without a per-call dance.
   */
  private readonly makerAddress: Hex | null;
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
    // Live mode needs a signed adapter — refuse a config/adapter mismatch up front
    // (the SDK would otherwise only throw on the first write, deep inside a tick).
    if (!this.config.mode.dryRun && !this.adapter.isLive()) {
      throw new Error(
        'Runner: live mode (config.mode.dryRun=false) requires a signed adapter — build it with createLiveOspexAdapter(config, signer), not createOspexAdapter(config)',
      );
    }
    // Live mode needs the maker address (fill detection + competitiveness self-exclusion).
    // `runRun` resolves it from `signer.getAddress()` before constructing the Runner.
    if (!this.config.mode.dryRun && opts.makerAddress === undefined) {
      throw new Error(
        'Runner: live mode (config.mode.dryRun=false) requires `makerAddress` (the signer\'s wallet) — `runRun` passes it from `signer.getAddress()`.',
      );
    }
    this.makerAddress = opts.makerAddress === undefined ? null : (opts.makerAddress.toLowerCase() as Hex);
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
    // Fail closed if a dry-run state directory was reused for live. A `dry:<runId>:<n>`
    // synthetic hash can never be a real on-chain commitment — counting one toward
    // exposure, or trying to off-chain-cancel it, corrupts live accounting and spams the
    // relay with bad hashes. This is what makes the `… as Hex` casts at the off-chain-cancel
    // call sites sound (every tracked record in a live run is a real `0x…`). Point
    // `state.dir` at a fresh directory for live, or clear the dry-run state first.
    if (!this.config.mode.dryRun) {
      const synthetic = Object.values(this.state.commitments).find((r) => r.hash.startsWith('dry:'));
      if (synthetic !== undefined) {
        throw new Error(
          `Runner: live mode but the loaded state contains a dry-run synthetic commitment ("${synthetic.hash}") — a dry-run state directory was reused. Point \`state.dir\` at a fresh directory for live, or clear the dry-run state first.`,
        );
      }
    }
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
    let bootApprovalsApplied = false;
    try {
      while (!this.stopRequested) {
        if (this.deps.killFileExists()) {
          this.requestShutdown('kill-file');
          break;
        }
        // Boot-time auto-approve runs INSIDE the loop (after the kill check so a
        // KILL file dropped pre-boot still aborts cleanly) but BEFORE the first
        // tick — so any allowance shortfall is closed before discovery / reconcile
        // would matter. Runs at most once per `run()` invocation; dry-run skips.
        //
        // ALSO gated on `!isHoldingQuoting()`: raising the PositionModule allowance
        // while the state-loss hold (DESIGN §12) is active could re-activate latent
        // soft-cancelled signed commitments the runner can't see — the same risk
        // that holds quoting in the first place. When the hold lifts (elapsed
        // fixed-seconds expiry, telemetry reconstruction, or `--ignore-missing-state`)
        // the next tick's check will fire. The latch stays `false` while deferred
        // so the retry happens; dry-run latches immediately (never approves).
        if (!bootApprovalsApplied) {
          if (this.config.mode.dryRun) {
            bootApprovalsApplied = true;
          } else if (!this.isHoldingQuoting()) {
            await this.applyAutoApprovals();
            bootApprovalsApplied = true;
          }
          // else: live + holding — leave the latch false, retry next tick.
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

  /**
   * One iteration: discovery → reference-odds refresh → fill detection (live) →
   * position-status poll (live) → per-market reconcile → age-out → terminal-record
   * prune → flush. Fill detection runs *before* the reconcile so a fill within this
   * tick dirties the market and the same reconcile re-prices the now-imbalanced book.
   *
   * **Fail-closed on lost fill visibility (live mode).** Three gates, same outcome
   * (skip reconcile + ageOut, markets stay dirty, next tick retries):
   *   1. `detectFills` can't read the maker's open commitments
   *      (`listOpenCommitments` threw) → also skips the position poll.
   *   2. `detectFills` saw a *past-expiry* tracked commitment disappear from
   *      the open-commitments listing but the per-hash `getCommitment` lookup
   *      threw — the past-expiry-and-disappeared combo is the sharp case
   *      because `ageOut` would otherwise terminalize the record and release
   *      its headroom without knowing whether a late fill landed. Future-expiry
   *      lookup failures stay non-fatal: the record stays live + counted, the
   *      next tick retries (Hermes review-PR23-late).
   *   3. `pollPositionStatus` can't read the maker's positions
   *      (`getPositionStatus` threw) AND any non-terminal `softCancelled`
   *      commitment exists in local state. Soft-cancelled commitments are
   *      API-hidden from `listOpenCommitments`, so a stale-signed-payload
   *      match on one is detectable ONLY through the position poll —
   *      proceeding without that read could submit replacements on
   *      already-matched exposure and let `ageOut` terminalize a record that
   *      a taker just filled. With no softCancelled records, the maker's
   *      own posted-commitment fills are fully covered by `detectFills`, so
   *      a position-poll failure is non-fatal.
   * `pruneTerminalCommitments` still runs (it only touches already-terminal
   * records, which are safe).
   */
  private async tick(tick: number): Promise<void> {
    this.eventLog.emit('tick-start', { tick });
    try {
      const ranDiscovery = tick >= this.nextDiscoveryAtTick;
      if (ranDiscovery) {
        await this.discover(tick);
        this.nextDiscoveryAtTick = tick + this.jitteredDiscoveryInterval();
      }
      await this.refreshTrackedOdds({ ranDiscovery });
      let liveStateReadOk = true;
      if (!this.config.mode.dryRun) liveStateReadOk = await this.detectFills();
      if (liveStateReadOk) {
        let positionPollOk = true;
        if (!this.config.mode.dryRun) positionPollOk = await this.pollPositionStatus();
        const hasSoftCancelled = !this.config.mode.dryRun && Object.values(this.state.commitments).some((r) => r.lifecycle === 'softCancelled');
        if (positionPollOk || !hasSoftCancelled) {
          if (!this.config.mode.dryRun) await this.settleAndClaim();
          await this.reconcileMarkets();
          this.ageOut();
        }
        // else: live mode + getPositionStatus failed AND softCancelled records exist — skip settleAndClaim + reconcile + ageOut (fail-closed; markets stay dirty for next-tick retry).
      }
      // else: live mode + listOpenCommitments failed — skip all state-mutating live steps this tick (fail-closed; the markets stay dirty for next-tick retry).
      this.pruneTerminalCommitments();
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
   * Drop terminal commitment records (`expired` / `filled` /
   * `authoritativelyInvalidated` — the lifecycles where headroom is released and
   * nothing more can happen on chain) once they're older than the retention window,
   * so a long shadow run's `maker-state.json` stays bounded. Retention =
   * `max(3600, 10 × orders.expirySeconds)` past `updatedAtUnixSec`: long enough to
   * still serve a telemetry-replay reconstruction after a crash and to keep a
   * just-replaced commitment's record around for cross-referencing, short enough not
   * to grow without limit. `visibleOpen` / `softCancelled` / `partiallyFilled`
   * records are never pruned — `softCancelled` in particular stays matchable on
   * chain until expiry, so the risk engine must keep counting it (DESIGN §9, §12).
   * No telemetry event — `expire` (emitted when the record became terminal) is the
   * meaningful lifecycle signal; this is just garbage collection.
   */
  private pruneTerminalCommitments(): void {
    const cutoff = this.deps.now() - Math.max(3600, 10 * this.config.orders.expirySeconds);
    for (const [hash, record] of Object.entries(this.state.commitments)) {
      const terminal = record.lifecycle === 'expired' || record.lifecycle === 'filled' || record.lifecycle === 'authoritativelyInvalidated';
      if (terminal && record.updatedAtUnixSec < cutoff) delete this.state.commitments[hash];
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
   * `would-soft-cancel`s that pull any standing quote off an unwanted side. After the
   * plan is applied, `assessCompetitiveness` measures where each would-be quote sits
   * vs the visible orderbook on its side (the `getSpeculation` read above already
   * fetched it). Returns `'applied'` when the plan went through cleanly (or a gate
   * pulled); `'transient-failure'` if a live write failed mid-plan (`applyReconcilePlan`
   * already logged the `error`) — `reconcileMarkets` then leaves `dirty` /
   * `lastReconciledAt` so the market re-reconciles next tick and retries the failed bit.
   */
  private async reconcileMarket(m: TrackedMarket, now: number): Promise<'applied' | 'transient-failure'> {
    // Gate: the game starts within one expiry window — stop quoting it (a fresh quote would still be matchable at game time / outlive the pre-game window), and pull whatever's still up.
    if (m.matchTimeSec - now <= this.config.orders.expirySeconds) {
      await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'start-too-soon' });
      return 'applied';
    }
    // Gate: the reference odds have gone stale (the upstream feed stopped advancing). A never-seen-odds market (`lastOddsAt === null`) falls through to the `no-reference-odds` gate below — `lastOddsAt === null` iff `lastMoneylineOdds === null` (`recordOdds` sets both or neither).
    if (m.lastOddsAt !== null && now - m.lastOddsAt > this.config.orders.staleReferenceAfterSeconds) {
      await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'stale-reference' });
      return 'applied';
    }
    // Gate: no usable reference moneyline odds (both sides must be priced — `buildDesiredQuote` itself refuses out-of-range *values*, but it can't be handed a `null`).
    const ml = m.lastMoneylineOdds;
    if (ml === null || ml.awayOddsAmerican === null || ml.homeOddsAmerican === null) {
      await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'no-reference-odds' });
      return 'applied';
    }
    // Gate: the Realtime odds channel is down (subscription mode) — the reference is no longer being kept fresh, so treat it as unsafe and pull. (`syncOddsSubscriptions` re-subscribes on the next discovery cycle; the existing `degraded` event already carries the precise cause.)
    if (this.config.odds.subscribe && m.subscription === null) {
      await this.pullVisibleQuotes(m, now);
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
      await this.pullVisibleQuotes(m, now);
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
    const outcome = await this.applyReconcilePlan(m, plan, now);
    this.assessCompetitiveness(m, spec, desired);
    return outcome; // `'transient-failure'` if a live write failed mid-plan — `reconcileMarkets` then leaves `dirty` / `lastReconciledAt` so the market re-reconciles next tick
  }

  /** Pull (off-chain) every API-visible commitment of the maker's on `m.speculationId` — in live mode an actual `cancelCommitmentOffchain` per record (a failed one stays `visibleOpen` for the next pass), in dry-run a state-only simulation — then reclassify the pulled ones `softCancelled` and emit `would-soft-cancel` / `soft-cancel` (reason `side-not-quoted`: when a market is unquoteable, neither side is being quoted). Used by the unquoteable-market gates above — the visible book must never carry a quote the MM is no longer pricing (DESIGN §2.2 / §3). The pulled quote's signed payload stays matchable on chain until expiry, so the risk engine keeps counting it. */
  private async pullVisibleQuotes(m: TrackedMarket, now: number): Promise<void> {
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== m.speculationId) continue;
      if (r.lifecycle !== 'visibleOpen' && r.lifecycle !== 'partiallyFilled') continue;
      if (r.expiryUnixSec <= now) continue; // already dead on chain — `ageOut` handles it
      await this.softCancelRecord(r, 'side-not-quoted', now);
    }
  }

  /**
   * Pull a tracked commitment off the API book — in live mode a real off-chain
   * cancel (`cancelCommitmentOffchain`), in dry-run a state-only no-op — then (on
   * success) reclassify it `softCancelled`, stamp `updatedAtUnixSec`, and emit
   * `soft-cancel` (live) / `would-soft-cancel` (dry-run). Returns `true` if the
   * record was pulled; `false` if a live cancel threw — then `error` `phase: 'cancel'`
   * is logged and the record is left `visibleOpen` (the caller treats that as a
   * `transient-failure` so the market re-reconciles and retries). The off-chain cancel
   * is visibility-only: the signed payload stays matchable on chain until expiry, so
   * the risk engine keeps counting it.
   */
  private async softCancelRecord(record: MakerCommitmentRecord, reason: SoftCancelReason, now: number): Promise<boolean> {
    if (!this.config.mode.dryRun) {
      try {
        // Every tracked record in a live run is a real EIP-712 hash (`0x…`): submits record
        // `submitCommitment`'s real hash, and the Runner ctor refuses to boot live on a state
        // file containing any `dry:` synthetic record. This branch never runs in dry-run.
        await this.adapter.cancelCommitmentOffchain(record.hash as Hex);
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'cancel', contestId: record.contestId, commitmentHash: record.hash });
        return false; // still visible — the next reconcile pass will see it and retry the pull
      }
    }
    record.lifecycle = 'softCancelled';
    record.updatedAtUnixSec = now;
    this.eventLog.emit(this.config.mode.dryRun ? 'would-soft-cancel' : 'soft-cancel', softCancelEventPayload(record, reason));
    return true;
  }

  /**
   * Apply a `reconcileBook` plan — **mode-aware**. In live mode each `toSubmit` /
   * `toReplace.replacement` goes through `commitments.submitRaw` (the SDK signs +
   * POSTs the 9-field EIP-712 commitment, picks the nonce) and the recorded hash is
   * the real one; each `toReplace.stale` and `toSoftCancel` goes through
   * `commitments.cancel` (the gasless off-chain pull). In dry-run nothing leaves the
   * process: a synthetic `dry:<runId>:<n>` hash is minted and the cancel is a no-op.
   * Either way the same state mutations and event stream — only the kind names differ
   * (`submit` / `replace` / `soft-cancel` in live; `would-`-prefixed in dry-run) and
   * a `cap-hit` candidate is emitted per deferred side.
   *
   * A live write that throws is logged (`error`, `phase: 'submit'` / `'cancel'`) and
   * the loop moves on — never crashes the tick — but the plan is reported back as
   * `'transient-failure'`, so the caller leaves the market `dirty` / un-throttled and
   * it re-reconciles next tick (rather than waiting out `staleAfterSeconds`). On a
   * failed submit no record is created (no `submit` / `replace` event); on a failed
   * `toReplace` *stale-pull* the replacement is **not** posted either — posting it
   * while the incumbent is still visible would surface two quotes on the side
   * (DESIGN §9) — so the side keeps only the (now-known-stale) incumbent until the
   * next-tick retry re-attempts the cancel. The pulled / replaced records that did
   * get pulled stay `softCancelled`-not-expired, so their signed payloads keep
   * counting toward exposure until expiry.
   */
  private async applyReconcilePlan(m: TrackedMarket, plan: BookReconciliation, now: number): Promise<'applied' | 'transient-failure'> {
    const expiryUnixSec = this.expiryForNewCommitment(m, now);
    const submitKind = this.config.mode.dryRun ? 'would-submit' : 'submit';
    const replaceKind = this.config.mode.dryRun ? 'would-replace' : 'replace';
    let outcome: 'applied' | 'transient-failure' = 'applied';

    for (const qs of plan.toSubmit) {
      const record = await this.submitQuote(m, qs, now, expiryUnixSec);
      if (record === null) { outcome = 'transient-failure'; continue; } // live submit threw — `error` already emitted; retry the now-empty side next tick
      this.eventLog.emit(submitKind, {
        ...this.commitmentEventPayload(record),
        takerOddsTick: qs.quoteTick,
        takerImpliedProb: qs.quoteProb,
      });
    }

    for (const rp of plan.toReplace) {
      // Pull the incumbent first (a brief no-quote gap beats a brief stale double-quote — we're
      // replacing it because it's stale/mispriced). In live mode, if that pull fails, do NOT post
      // the replacement: two visible quotes on the side would violate DESIGN §9 (and they wouldn't
      // self-heal — `needsReconcile` sees a fresh two-sided quote and skips). Leave the stale one up
      // and force a prompt retry; the next pass re-attempts the cancel.
      if (!this.config.mode.dryRun) {
        try {
          await this.adapter.cancelCommitmentOffchain(rp.stale.hash as Hex); // live: a real `0x…` hash (see softCancelRecord)
        } catch (err) {
          this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'cancel', contestId: m.contestId, commitmentHash: rp.stale.hash });
          outcome = 'transient-failure';
          continue;
        }
      }
      rp.stale.lifecycle = 'softCancelled';
      rp.stale.updatedAtUnixSec = now;
      const record = await this.submitQuote(m, rp.replacement, now, expiryUnixSec);
      if (record === null) { outcome = 'transient-failure'; continue; } // live submit threw — `error` already emitted; the stale is pulled, so the side is empty — re-quote it next tick
      this.eventLog.emit(replaceKind, {
        replacedCommitmentHash: rp.stale.hash,
        newCommitmentHash: record.hash,
        speculationId: m.speculationId,
        contestId: m.contestId,
        sport: m.sport,
        awayTeam: m.awayTeam,
        homeTeam: m.homeTeam,
        takerSide: rp.replacement.takerSide,
        makerSide: record.makerSide,
        positionType: positionTypeForSide(record.makerSide),
        reason: rp.reason,
        fromMakerOddsTick: rp.stale.oddsTick,
        toMakerOddsTick: record.oddsTick,
        fromTakerOddsTick: inverseOddsTick(rp.stale.oddsTick), // ≈ the incumbent's taker tick (a double-rounding round-trip — display only)
        toTakerOddsTick: rp.replacement.quoteTick,
        riskAmountWei6: record.riskAmountWei6,
        expiryUnixSec,
      });
    }

    for (const sc of plan.toSoftCancel) {
      if (!(await this.softCancelRecord(sc.record, sc.reason, now))) outcome = 'transient-failure'; // live cancel threw — `error` already emitted; the quote's still up, retry next tick
    }
    for (const offerSide of plan.deferredSides) {
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'cap-hit', takerSide: offerSide });
    }
    return outcome;
  }

  /** A new commitment's expiry, unix seconds: `now + orders.expirySeconds` under `fixed-seconds` mode (the v0 default — short-lived, rolled forward), or the contest's match time under `match-time` mode (the quote lapses exactly at game start). */
  private expiryForNewCommitment(m: TrackedMarket, now: number): number {
    return this.config.orders.expiryMode === 'match-time' ? m.matchTimeSec : now + this.config.orders.expirySeconds;
  }

  /**
   * Place one quote for a `QuoteSide` (a taker offer) the reconcile decided to post:
   * convert it to the protocol commitment params (`toProtocolQuote` — offering a
   * taker the away side ⇒ the maker is on `home` at `inverseOddsTick(quoteTick)`),
   * then in **live** mode sign + POST it via `commitments.submitRaw` (the SDK reads
   * the on-chain nonce floor + picks the nonce; we pass the short `fixed-seconds` /
   * `match-time` expiry explicitly so the SDK's 24-h default doesn't apply) and
   * record the *real* commitment hash; in **dry-run** mint a synthetic `dry:<runId>:<n>`
   * hash and post nothing. Stores the resulting `visibleOpen` `MakerCommitmentRecord`
   * in `state.commitments` and returns it; returns `null` if a live submit threw
   * (the `error` `phase: 'submit'` event is already emitted — the caller skips the
   * corresponding `submit` / `replace` event).
   */
  private async submitQuote(m: TrackedMarket, qs: QuoteSide, now: number, expiryUnixSec: number): Promise<MakerCommitmentRecord | null> {
    const proto = toProtocolQuote({ side: qs.takerSide, oddsTick: qs.quoteTick });
    let hash: string;
    if (this.config.mode.dryRun) {
      this.syntheticCommitmentSeq += 1;
      hash = `dry:${this.eventLog.runId}:${this.syntheticCommitmentSeq}`;
    } else {
      try {
        const result = await this.adapter.submitCommitment({
          contestId: BigInt(m.contestId),
          scorer: this.moneylineScorer,
          lineTicks: 0,
          positionType: proto.positionType,
          oddsTick: proto.makerOddsTick,
          riskAmount: BigInt(qs.sizeWei6),
          expiry: BigInt(expiryUnixSec),
        });
        hash = result.hash;
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'submit', contestId: m.contestId, takerSide: qs.takerSide });
        return null;
      }
    }
    const record = this.commitmentRecord(m, qs, now, expiryUnixSec, hash, proto);
    this.state.commitments[record.hash] = record;
    return record;
  }

  /** Build a `visibleOpen` `MakerCommitmentRecord` for a taker offer (`qs`) at a given commitment `hash`, with the already-computed protocol params (`proto`) — the maker side + odds tick the risk engine accounts against (so the synthetic dry-run record and the real live one have the identical exposure shape). */
  private commitmentRecord(m: TrackedMarket, qs: QuoteSide, now: number, expiryUnixSec: number, hash: string, proto: ProtocolQuote): MakerCommitmentRecord {
    return {
      hash,
      speculationId: m.speculationId,
      contestId: m.contestId,
      sport: m.sport,
      awayTeam: m.awayTeam,
      homeTeam: m.homeTeam,
      scorer: this.moneylineScorer,
      makerSide: proto.makerSide,
      oddsTick: proto.makerOddsTick,
      riskAmountWei6: String(qs.sizeWei6),
      filledRiskWei6: '0',
      lifecycle: 'visibleOpen',
      expiryUnixSec,
      postedAtUnixSec: now,
      updatedAtUnixSec: now,
    };
  }

  /** The protocol-side fields of a tracked commitment record, for an event payload. `takerSide` = the offer side a taker would back by matching it (`oppositeSide(makerSide)`); `makerSide` / `makerOddsTick` / `positionType` are what's on chain. */
  private commitmentEventPayload(record: MakerCommitmentRecord): Record<string, unknown> {
    return {
      commitmentHash: record.hash,
      speculationId: record.speculationId,
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      takerSide: oppositeSide(record.makerSide),
      makerSide: record.makerSide,
      positionType: positionTypeForSide(record.makerSide),
      makerOddsTick: record.oddsTick,
      riskAmountWei6: record.riskAmountWei6,
      expiryUnixSec: record.expiryUnixSec,
    };
  }

  /**
   * Measure how competitive each would-be quote is (DESIGN §8). The desired quote's
   * `QuoteSide`s are *taker offers* — "we'd let a taker back the away/home side at
   * this price"; the on-chain commitment that serves an away offer is maker-on-*home*
   * at `inverseOddsTick(quoteTick)` (`toProtocolQuote`). Other makers offering takers
   * the same side post commitments at that same `positionType`; among them the one a
   * taker reaches for first gives the *highest* taker-perspective payout —
   * `inverseOddsTick(c.oddsTick)` (which is *highest* when the maker tick `c.oddsTick`
   * is *lowest*). So `bestBookTakerTick` = the max of `inverseOddsTick(c.oddsTick)`
   * over the same-`positionType` commitments, and the would-be offer is "at or inside
   * the book" iff its `takerOddsTick` is at least that high (`takerOddsTick >=
   * bestBookTakerTick`), or no one else is offering that side. Emits a
   * `quote-competitiveness` per assessed side, carrying both the taker-facing fields
   * and the protocol commitment params.
   *
   * Reuses the orderbook the per-market reconcile's `getSpeculation` already fetched —
   * no extra read; only runs for markets that passed the risk engine and only when
   * the market was dirty / re-reconciled (the reconcile's gate), so it's bounded
   * (DESIGN §8). If the desired quote was refused there's nothing to assess; if the
   * speculation came back without its orderbook (the `SpeculationView.orderbook` is
   * optional — `getContest`'s embedded specs may omit it; `getSpeculation` itself
   * always populates it), it's a degraded read → one `competitiveness-unavailable`.
   *
   * In dry-run the orderbook is purely other makers' (the MM's own synthetic `dry:`
   * commitments are never on chain). In live mode the MM's own commitments do
   * appear on the book — they're filtered out by `c.maker === this.makerAddress`
   * (both lowercased — the SDK's `Commitment.maker` is the indexer-stored address,
   * conventionally lowercased; the ctor lowercased `this.makerAddress`).
   */
  private assessCompetitiveness(m: TrackedMarket, spec: SpeculationView, desired: DesiredQuote): void {
    const offers: QuoteSide[] = [];
    if (desired.result.away !== null) offers.push(desired.result.away);
    if (desired.result.home !== null) offers.push(desired.result.home);
    if (offers.length === 0) return; // the quote was refused — nothing to assess (the `quote-intent` already records the refusal)
    const ref = desired.referenceOdds;
    if (ref === null) return; // a non-null QuoteSide implies non-null referenceOdds, but narrow for the type checker
    const orderbook = spec.orderbook;
    if (orderbook === undefined) {
      this.eventLog.emit('competitiveness-unavailable', { contestId: m.contestId, speculationId: m.speculationId, reason: 'orderbook-not-populated' });
      return;
    }
    const selfMaker = this.makerAddress; // null in dry-run; lowercased Hex in live
    const live = orderbook
      .filter(isPricedLiveCommitment) // keep the type narrowing
      .filter((c) => selfMaker === null || c.maker.toLowerCase() !== selfMaker);
    for (const qs of offers) {
      const proto = toProtocolQuote({ side: qs.takerSide, oddsTick: qs.quoteTick }); // the MM's commitment for this offer: maker on the opposite side, at the inverse tick
      let bookDepthOnSide = 0;
      let bestBookTakerTick: number | null = null; // the highest taker-perspective tick among the commitments offering this same side
      for (const c of live) {
        if (c.positionType !== proto.positionType) continue;
        bookDepthOnSide += 1;
        const takerTick = inverseOddsTick(c.oddsTick);
        if (bestBookTakerTick === null || takerTick > bestBookTakerTick) bestBookTakerTick = takerTick;
      }
      const referenceTakerTick = decimalToTick(qs.takerSide === 'away' ? ref.awayDecimal : ref.homeDecimal);
      const referenceImpliedProb = qs.takerSide === 'away' ? ref.awayImpliedProb : ref.homeImpliedProb;
      this.eventLog.emit('quote-competitiveness', {
        contestId: m.contestId,
        speculationId: m.speculationId,
        takerSide: qs.takerSide,
        takerOddsTick: qs.quoteTick,
        takerImpliedProb: qs.quoteProb,
        makerSide: proto.makerSide,
        makerOddsTick: proto.makerOddsTick,
        positionType: proto.positionType,
        referenceTakerTick,
        referenceImpliedProb,
        vsReferenceTicks: qs.quoteTick - referenceTakerTick,
        bookDepthOnSide,
        bestBookTakerTick,
        atOrInsideBook: bestBookTakerTick === null || qs.quoteTick >= bestBookTakerTick, // at least as good for the taker as the best existing offer on this side
      });
    }
  }

  /**
   * Live-mode fill detection (DESIGN §10, §14). Each tick — *before* the per-market
   * reconcile so a fill detected here dirties the market and the same tick's
   * reconcile re-prices the now-imbalanced book — list the maker's open commitments
   * via `commitments.list({maker, status:[open,partially_filled]})`, diff against
   * the local `visibleOpen`/`partiallyFilled` set, and:
   *
   *   - **Still listed, `filledRiskAmount` advanced** → partial-fill bump: extend the
   *     record's `filledRiskWei6`, reclassify `partiallyFilled`, extend the position
   *     by the delta, dirty the market, emit `fill` `{ partial: true, source:
   *     'commitment-diff', newFillWei6, filledRiskWei6, … }`.
   *   - **Disappeared** → per-hash `getCommitment(hash)` classifies, **applying any
   *     unobserved fill delta first** (a commitment can have partially filled and
   *     then expired / been cancelled between polls; the delta `apiFilledRiskAmount −
   *     localFilledRiskWei6` is real on-chain risk and must enter the position):
   *     - `filled` → record `'filled'`, fill delta applied, `fill` `{ partial: false }`.
   *     - `expired` → fill delta applied (if any), record `'expired'`, then `expire`
   *       (matches `ageOut`'s payload). `ageOut` skips already-`expired` records next tick.
   *     - `cancelled` → fill delta applied (if any), record `'authoritativelyInvalidated'`.
   *       No `expire` (v0's MM doesn't on-chain-cancel its own commitments — manual
   *       cancel between runs / outside the MM, which the operator already knows about).
   *
   * Local **past-local-expiry** records are INCLUDED in the diff: the chain commitment
   * may have filled just before expiry, and `ageOut` (which runs after this step in
   * the same tick) reclassifies on local time alone — without this step's per-hash
   * `getCommitment` it would terminalize a record whose actual on-chain status is
   * `filled`, silently losing the position.
   *
   * **Fail closed.** Returns `false` in two cases:
   *   1. `listOpenCommitments` threw — the runner has no visibility into which
   *      commitments filled / expired / were cancelled.
   *   2. The per-hash `getCommitment` lookup threw for a *past-expiry* tracked
   *      commitment that had disappeared from the listing. Without the lookup
   *      we can't tell if it filled, expired, or was cancelled before vanishing,
   *      and `ageOut` (running after this step in the same tick) would otherwise
   *      terminalize the record on local time alone — releasing headroom + the
   *      reconcile then submitting replacements on possibly-already-matched
   *      exposure. Future-expiry lookup failures stay non-fatal (the record
   *      stays live + counted; the next tick retries) — only the past-expiry
   *      combo trips the gate (Hermes review-PR23-late).
   * Either way the caller MUST skip the position poll, the reconcile, and
   * `ageOut`. The other disappearances in the same tick still classify normally;
   * only the failing past-expiry hash escalates to a tick-wide fail-closed.
   *
   * Bounded reads (DESIGN §10): one `listOpenCommitments` per tick at
   * `max(maxOpenCommitments × 2, 50)`; one `getCommitment` per disappeared hash
   * (bounded by `maxOpenCommitments` plus the small expired-but-not-yet-classified
   * backlog).
   *
   * Soft-cancelled records are NOT tracked here (they're API-hidden from
   * `listOpenCommitments`, so a per-hash poll would be O(softCancelled count)
   * forever). A taker matching a soft-cancelled commitment via the stale signed
   * payload is caught by `pollPositionStatus` (one aggregate call) below — and
   * `tick()` fails closed when that poll throws while any non-terminal
   * `softCancelled` records exist, so a lost-poll tick can't terminalize a
   * record that just filled.
   */
  private async detectFills(): Promise<boolean> {
    if (this.makerAddress === null) return true; // dry-run path — defensive (the caller skips); treat as ok so the rest of the tick proceeds
    const now = this.deps.now();
    const localOpen = new Map<string, MakerCommitmentRecord>();
    for (const r of Object.values(this.state.commitments)) {
      if (r.lifecycle !== 'visibleOpen' && r.lifecycle !== 'partiallyFilled') continue;
      // Past-local-expiry records ARE included — see the doc above (a fill that landed
      // just before expiry must be classified before `ageOut` terminalizes the record).
      localOpen.set(r.hash, r);
    }
    if (localOpen.size === 0) return true; // nothing tracked → nothing to detect

    const listLimit = Math.max(this.config.risk.maxOpenCommitments * 2, 50);
    let apiList: Commitment[];
    try {
      apiList = await this.adapter.listOpenCommitments(this.makerAddress, listLimit);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'fill-detection' });
      return false; // fail closed — the caller skips live writes + ageOut this tick
    }
    const apiByHash = new Map<string, Commitment>();
    for (const c of apiList) apiByHash.set(c.commitmentHash, c);

    // Partial-fill bumps (commitment still listed; filledRiskAmount advanced).
    for (const [, record] of localOpen) {
      const apiCommitment = apiByHash.get(record.hash);
      if (apiCommitment === undefined) continue; // disappeared — handled below
      const apiFilled = BigInt(apiCommitment.filledRiskAmount);
      const localFilled = BigInt(record.filledRiskWei6);
      if (apiFilled <= localFilled) continue; // no new fill (or somehow regressed — ignore)
      this.applyFill(record, apiFilled - localFilled, now, 'partiallyFilled');
    }

    // Disappeared hashes → per-hash terminal classification via `getCommitment`.
    // **Fail-closed on past-expiry lookup failure.** A future-expiry record whose
    // lookup fails stays live + counted toward exposure; next tick retries — safe.
    // But a *past-expiry* record whose lookup fails is the sharp case: `ageOut`
    // would otherwise terminalize it to `expired` and release its headroom, and
    // the reconcile would submit replacements against exposure that may have just
    // filled. Track whether any such failure occurred and signal `tick()` to
    // skip reconcile + ageOut for the tick (the markets stay dirty for next-tick
    // retry, the record's lifecycle stays at its current value). Hermes
    // review-PR23-late.
    let pastExpiryLookupFailed = false;
    for (const [hash, record] of localOpen) {
      if (apiByHash.has(hash)) continue;
      let apiCommitment: Commitment;
      try {
        apiCommitment = await this.adapter.getCommitment(hash as Hex);
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'fill-detection-lookup', commitmentHash: hash });
        if (record.expiryUnixSec <= now) pastExpiryLookupFailed = true;
        continue; // skip this hash; other hashes still processed
      }
      // For every terminal status, first compute and apply any unobserved fill delta —
      // a commitment can have partially filled and then expired / been cancelled
      // between polls; that delta is real on-chain risk and must enter the position
      // before the commitment is terminalized.
      const apiFilled = BigInt(apiCommitment.filledRiskAmount);
      const localFilled = BigInt(record.filledRiskWei6);
      const delta = apiFilled > localFilled ? apiFilled - localFilled : 0n;
      switch (apiCommitment.status) {
        case 'filled': {
          this.applyFill(record, delta, now, 'filled');
          break;
        }
        case 'expired': {
          this.applyFill(record, delta, now, 'expired');
          this.eventLog.emit('expire', {
            commitmentHash: record.hash,
            speculationId: record.speculationId,
            contestId: record.contestId,
            makerSide: record.makerSide,
            oddsTick: record.oddsTick,
          });
          break;
        }
        case 'cancelled': {
          this.applyFill(record, delta, now, 'authoritativelyInvalidated');
          break;
        }
        default: {
          // 'open' / 'partially_filled' shouldn't disappear from the listing — log defensively, don't touch state.
          this.eventLog.emit('error', { class: 'UnexpectedFillStatus', detail: `disappeared commitment ${hash} has status "${apiCommitment.status}"`, phase: 'fill-detection', commitmentHash: hash });
          break;
        }
      }
    }
    return !pastExpiryLookupFailed;
  }

  /**
   * Apply a fill delta to a commitment record and extend the matching position.
   * Pure fill mechanics — sets `filledRiskWei6 += deltaWei6` (skipping the position
   * update + `fill` event when `delta === 0`, which the terminal-no-fill case
   * exercises), reclassifies the lifecycle, dirties the tracked market (so the
   * same tick's reconcile re-prices the imbalance — `detectFills` runs first).
   * `finalLifecycle` controls the reclassification: `'partiallyFilled'` for a
   * still-listed bump, `'filled'` / `'expired'` / `'authoritativelyInvalidated'`
   * for the corresponding terminal classifications. The `fill` event's `partial`
   * field is `true` iff the final lifecycle is `'partiallyFilled'`.
   */
  private applyFill(record: MakerCommitmentRecord, deltaWei6: bigint, now: number, finalLifecycle: CommitmentLifecycle): void {
    if (deltaWei6 > 0n) {
      record.filledRiskWei6 = (BigInt(record.filledRiskWei6) + deltaWei6).toString();
      this.updatePosition(record, deltaWei6, now);
      const m = this.trackedMarkets.get(record.contestId);
      if (m !== undefined) m.dirty = true; // the book on this side just changed — re-price next reconcile (same tick — `detectFills` runs before `reconcileMarkets`)
      this.eventLog.emit('fill', {
        source: 'commitment-diff',
        commitmentHash: record.hash,
        speculationId: record.speculationId,
        contestId: record.contestId,
        sport: record.sport,
        awayTeam: record.awayTeam,
        homeTeam: record.homeTeam,
        takerSide: oppositeSide(record.makerSide),
        makerSide: record.makerSide,
        positionType: positionTypeForSide(record.makerSide),
        makerOddsTick: record.oddsTick,
        newFillWei6: deltaWei6.toString(),
        filledRiskWei6: record.filledRiskWei6,
        partial: finalLifecycle === 'partiallyFilled',
      });
    }
    if (record.lifecycle !== finalLifecycle) {
      record.lifecycle = finalLifecycle;
      record.updatedAtUnixSec = now;
    }
  }

  /**
   * Create or extend a `MakerPositionRecord` for `(speculationId, makerSide)` by
   * `deltaWei6` of the maker's filled risk. Counterparty risk derives from the
   * commitment's `oddsTick` (the maker's decimal × 100): `delta × (oddsTick − 100) / 100`
   * — the taker's stake on the other side of the matched pair, the maker's
   * winnings if their side wins. Multiple fills on different commitments at
   * different ticks accumulate per-fill; the totals on the record stay consistent
   * with the on-chain `s_positions[speculationId][maker][positionType]`.
   */
  private updatePosition(record: MakerCommitmentRecord, deltaWei6: bigint, now: number): void {
    const key = `${record.speculationId}:${record.makerSide}`;
    const counterpartyDelta = (deltaWei6 * BigInt(record.oddsTick - 100)) / 100n;
    const existing: MakerPositionRecord | undefined = this.state.positions[key];
    if (existing === undefined) {
      this.state.positions[key] = {
        speculationId: record.speculationId,
        contestId: record.contestId,
        sport: record.sport,
        awayTeam: record.awayTeam,
        homeTeam: record.homeTeam,
        side: record.makerSide,
        riskAmountWei6: deltaWei6.toString(),
        counterpartyRiskWei6: counterpartyDelta.toString(),
        status: 'active',
        updatedAtUnixSec: now,
      };
    } else {
      existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + deltaWei6).toString();
      existing.counterpartyRiskWei6 = (BigInt(existing.counterpartyRiskWei6) + counterpartyDelta).toString();
      existing.updatedAtUnixSec = now;
    }
  }

  /**
   * Live-mode position-status poll (DESIGN §10). One aggregate `getPositionStatus(maker)`
   * call per tick — closes the soft-cancelled-then-matched gap that `detectFills`'s
   * commitment-list diff can't see (a soft-cancelled commitment is API-hidden, so its
   * stale-signed-payload match isn't visible until the indexer publishes the
   * resulting position). For each position the API reports (`active`, `pendingSettle`,
   * `claimable`) on `(speculationId, positionType)`, if the local
   * `MakerPositionRecord.riskAmountWei6` is short, create / extend it by the delta,
   * dirty the corresponding tracked market (a new on-chain fill changes the book
   * imbalance), and emit `fill` `{ source: 'position-poll', … }`.
   *
   * The position record's contest / sport / team context comes from two
   * sources: an *existing* `MakerPositionRecord` carries its own denormalized
   * context (copied at birth from the commitment that originated it), so an
   * extend / transition uses the record's own fields — important because
   * `pruneTerminalCommitments` deletes filled commitments after about an hour
   * while a position can stay `active` for hours/days until the game scores,
   * so requiring a still-retained source commitment would strand long-running
   * positions in stale status (Hermes review-PR24). A *brand-new* record
   * (`existing === undefined`) does look up a local commitment record on
   * `(speculationId, makerSide)` — we wouldn't have a position without
   * having submitted some commitment on that speculation. If none is found
   * there: log `error` `phase: 'position-poll'` and skip rather than create
   * incomplete records that would corrupt the risk engine's per-team /
   * per-sport caps.
   *
   * **Status transitions** (DESIGN §10). The API's three buckets — `active`,
   * `pendingSettle`, `claimable` — map 1:1 to the local `MakerPositionStatus`.
   * A new position is created with the bucket's status (not always `'active'`);
   * an existing position whose API bucket has advanced (the strict order is
   * `active` → `pendingSettle` → `claimable` → `claimed`) is updated and a
   * `position-transition` event fires carrying `fromStatus` / `toStatus` plus
   * the bucket-specific `result` (`'won' | 'push' | 'void'`) and, for
   * `pendingSettle`, `predictedWinSide`. A backwards bucket (e.g. `claimable`
   * reverting to `active`) signals state corruption — logged as `error`
   * `class: 'BackwardsPositionTransition'`, refused. `'claimed'` is never set
   * by the poll (claimed positions disappear from the API); the auto-claim
   * path (Phase 3 settlement slice) stamps it locally.
   *
   * A first-observation in `pendingSettle` / `claimable` is BOTH a fill (new
   * risk → `fill` event) AND a creation at a non-`active` status (no transition
   * event — the position has no prior local status to transition *from*).
   *
   * Returns `false` on a `getPositionStatus` throw (logged as `error`
   * `phase: 'position-poll'`). The caller in `tick()` fails closed
   * (skips reconcile + ageOut) only when local state holds any non-terminal
   * `softCancelled` commitment — those are the records whose stale-signed-payload
   * fills are visible ONLY through this poll. When no softCancelled records
   * exist, `detectFills` has already covered the maker's posted commitments
   * and the tick proceeds. (Hermes review-PR23 §4 + round-2.)
   */
  private async pollPositionStatus(): Promise<boolean> {
    if (this.makerAddress === null) return true; // dry-run path — defensive (the caller skips); treat as ok
    const now = this.deps.now();
    let status: PositionStatus;
    try {
      status = await this.adapter.getPositionStatus(this.makerAddress);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'position-poll' });
      return false; // caller fails closed iff any non-terminal softCancelled commitments exist
    }
    for (const p of status.active) {
      this.syncPolledPosition('active', p, undefined, undefined, now);
    }
    for (const p of status.pendingSettle) {
      this.syncPolledPosition('pendingSettle', p, p.result, p.predictedWinSide, now);
    }
    for (const p of status.claimable) {
      this.syncPolledPosition('claimable', p, p.result, undefined, now);
    }
    return true;
  }

  /**
   * Apply one polled position from `getPositionStatus` to local state. Shared by
   * all three API buckets — `apiStatus` is the bucket name (`active` /
   * `pendingSettle` / `claimable`), which maps 1:1 to `MakerPositionStatus`.
   *
   * Three paths: (1) no local record + positive `apiRiskWei6` → create with
   * `status = apiStatus`, emit `fill` (the position's birth — no transition
   * event); (2) existing record, status unchanged + risk grew → fill-only
   * (the c-i fill-detection path, unchanged); (3) existing record, status
   * advanced → update status (and risk delta, if any), emit `position-transition`
   * (and `fill` if risk grew). A backwards transition is refused + logged.
   */
  private syncPolledPosition(
    apiStatus: 'active' | 'pendingSettle' | 'claimable',
    p: { positionId: string; speculationId: string; positionType: 0 | 1; riskAmountUSDC: number; profitAmountUSDC: number },
    result: 'won' | 'push' | 'void' | undefined,
    predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push' | undefined,
    now: number,
  ): void {
    // Convert USDC float → wei6 integer. `Math.round` accepts the loss; for v0
    // amounts (well within 2^53) this is exact for whole-cent values and at
    // worst off-by-one wei for sub-cent fractions — acceptable when the goal
    // is "detect a missing position" rather than penny-perfect accounting.
    const apiRiskWei6 = BigInt(Math.round(p.riskAmountUSDC * 1_000_000));
    const apiCounterpartyWei6 = BigInt(Math.round(p.profitAmountUSDC * 1_000_000));
    const side: MakerSide = p.positionType === 0 ? 'away' : 'home';
    const key = `${p.speculationId}:${side}`;
    const existing = this.state.positions[key];
    const localRiskWei6 = existing !== undefined ? BigInt(existing.riskAmountWei6) : 0n;
    const riskGrew = apiRiskWei6 > localRiskWei6;
    const statusChanged = existing !== undefined && existing.status !== apiStatus;
    if (existing !== undefined && !riskGrew && !statusChanged) return; // already caught up — idempotent on no-change
    if (existing === undefined && !riskGrew) return; // never seen + zero risk — nothing to record

    // Backwards-transition guard runs before the context lookup — it doesn't need it,
    // and a corrupted state shouldn't trigger a spurious `PositionWithoutCommitment`.
    // Forward-only: claimed disappears from the API; a settled speculation can't
    // un-settle on chain — a reversal signals state corruption.
    if (existing !== undefined && statusChanged && positionStatusRank(apiStatus) < positionStatusRank(existing.status)) {
      this.eventLog.emit('error', {
        class: 'BackwardsPositionTransition',
        detail: `getPositionStatus reports (${p.speculationId}, ${side}) in bucket '${apiStatus}' but local state has it as '${existing.status}' — refusing to revert`,
        phase: 'position-poll',
        speculationId: p.speculationId,
      });
      return;
    }

    // Context lookup: contest / sport / teams. When the position exists locally we
    // use its own denormalized fields (carried over from the commitment that birthed
    // it) — this is the long-running case where the source commitment has since
    // been pruned (`pruneTerminalCommitments` deletes filled records after about an
    // hour, while a position can stay `active` for hours/days until the game scores).
    // Only a brand-new record needs to look up a source commitment, and a miss there
    // signals state corruption (the operator can't have positions on a speculation
    // they never quoted on) — log + skip rather than create incomplete records.
    let context: { contestId: string; sport: string; awayTeam: string; homeTeam: string };
    if (existing !== undefined) {
      context = { contestId: existing.contestId, sport: existing.sport, awayTeam: existing.awayTeam, homeTeam: existing.homeTeam };
    } else {
      const sourceCommitment = Object.values(this.state.commitments).find(
        (r) => r.speculationId === p.speculationId && r.makerSide === side,
      );
      if (sourceCommitment === undefined) {
        this.eventLog.emit('error', {
          class: 'PositionWithoutCommitment',
          detail: `getPositionStatus reports a position on (${p.speculationId}, ${side}) but no local commitment with that (speculationId, makerSide) is present — refusing to create an incomplete MakerPositionRecord`,
          phase: 'position-poll',
          speculationId: p.speculationId,
        });
        return;
      }
      context = { contestId: sourceCommitment.contestId, sport: sourceCommitment.sport, awayTeam: sourceCommitment.awayTeam, homeTeam: sourceCommitment.homeTeam };
    }

    const delta = riskGrew ? apiRiskWei6 - localRiskWei6 : 0n;
    const counterpartyDelta = existing !== undefined ? apiCounterpartyWei6 - BigInt(existing.counterpartyRiskWei6) : apiCounterpartyWei6;
    const fromStatus: MakerPositionStatus | undefined = existing?.status;

    if (existing === undefined) {
      this.state.positions[key] = {
        speculationId: p.speculationId,
        contestId: context.contestId,
        sport: context.sport,
        awayTeam: context.awayTeam,
        homeTeam: context.homeTeam,
        side,
        riskAmountWei6: delta.toString(),
        counterpartyRiskWei6: counterpartyDelta > 0n ? counterpartyDelta.toString() : '0',
        status: apiStatus,
        updatedAtUnixSec: now,
      };
    } else {
      if (riskGrew) {
        existing.riskAmountWei6 = (BigInt(existing.riskAmountWei6) + delta).toString();
        if (counterpartyDelta > 0n) {
          existing.counterpartyRiskWei6 = (BigInt(existing.counterpartyRiskWei6) + counterpartyDelta).toString();
        }
      }
      if (statusChanged) existing.status = apiStatus;
      existing.updatedAtUnixSec = now;
    }

    if (riskGrew) {
      const m = this.trackedMarkets.get(context.contestId);
      if (m !== undefined) m.dirty = true; // a new fill changes the book imbalance; a status-only transition does not
      this.eventLog.emit('fill', {
        source: 'position-poll',
        positionId: p.positionId,
        speculationId: p.speculationId,
        contestId: context.contestId,
        sport: context.sport,
        awayTeam: context.awayTeam,
        homeTeam: context.homeTeam,
        makerSide: side,
        positionType: p.positionType,
        newFillWei6: delta.toString(),
        cumulativeRiskWei6: (localRiskWei6 + delta).toString(),
      });
    }
    if (existing !== undefined && statusChanged) {
      const payload: Record<string, unknown> = {
        positionId: p.positionId,
        speculationId: p.speculationId,
        contestId: context.contestId,
        sport: context.sport,
        awayTeam: context.awayTeam,
        homeTeam: context.homeTeam,
        makerSide: side,
        positionType: p.positionType,
        fromStatus,
        toStatus: apiStatus,
      };
      if (result !== undefined) payload.result = result;
      if (predictedWinSide !== undefined) payload.predictedWinSide = predictedWinSide;
      this.eventLog.emit('position-transition', payload);
    }
  }

  /**
   * Boot-time auto-approve flow (DESIGN §6 / §13). In live mode, after the boot
   * fail-safe but before the first tick, reads the current `PositionModule`
   * USDC allowance for the maker; if it's short of the documented target,
   * calls `approveUSDC` to bring it up and emits an `approval` event.
   *
   * **`mode: 'exact'`** — target = `min(requiredPositionModuleAllowanceUSDC(caps),
   * walletUSDCBalance)`. Wallet-USDC-bounded per DESIGN §6: approving more than
   * the wallet currently holds would over-state matchable risk and is the
   * documented safety contract (Hermes review-PR25 §2). `readBalances` failure
   * fails closed (the bound is meaningful — log + skip the approve).
   * `approve(x)` *sets* the allowance, never adds; the check
   * `currentAllowance >= target` is "raise-only" — already-sufficient
   * allowances aren't downshifted (operator may have intended them).
   *
   * **`mode: 'unlimited'`** — sets `MaxUint256`. Skips the wallet-balance read
   * (operator confirmed the unbounded path via `--yes`; bounding it would
   * defeat the explicit opt-in). Idempotent: if `currentAllowance` is already
   * `MaxUint256`, silent no-op.
   *
   * `autoApprove: false` skips the whole flow (the operator approves manually).
   * A `readApprovals` or `approveUSDC` failure is logged (`error`
   * `phase: 'approve'`) and the boot proceeds — the first failed match will
   * surface the gap loudly, and the operator can retry.
   *
   * The `approval` event payload carries `walletBalanceWei6` (exact mode only),
   * `txHash`, and `gasPolWei` (`gasUsed × effectiveGasPrice`); the gas-budget
   * tracker in (d-ii) consumes the `gasPolWei` field without changing the shape.
   */
  private async applyAutoApprovals(): Promise<void> {
    if (this.makerAddress === null) return; // live-mode invariant — caller (`run()`) already gated on `!dryRun`
    if (!this.config.approvals.autoApprove) return; // operator opted out — leave allowances as-is

    let snapshot: ApprovalsSnapshot;
    try {
      snapshot = await this.adapter.readApprovals(this.makerAddress);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'approve' });
      return;
    }
    const positionModule = snapshot.usdc.allowances.positionModule;
    const currentAllowance = positionModule.raw;
    const requiredUSDC = requiredPositionModuleAllowanceUSDC(this.config.risk);
    const requiredCapWei6 = BigInt(Math.ceil(requiredUSDC * 1_000_000));

    let amount: ApproveUSDCAmount;
    let walletUSDCWei6: bigint | undefined;
    if (this.config.approvals.mode === 'unlimited') {
      const MAX_UINT256 = 2n ** 256n - 1n;
      if (currentAllowance >= MAX_UINT256) return; // already at max — idempotent
      amount = 'max';
    } else {
      // exact mode: bound the target by current wallet USDC balance.
      try {
        walletUSDCWei6 = (await this.adapter.readBalances(this.makerAddress)).usdc;
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'approve' });
        return; // fail closed — the wallet bound is part of the safety contract
      }
      const target = walletUSDCWei6 < requiredCapWei6 ? walletUSDCWei6 : requiredCapWei6;
      if (currentAllowance >= target) return; // already sufficient — silent
      amount = target;
    }

    // Gas-budget verdict (DESIGN §6): right before an on-chain write, confirm
    // today's POL spend hasn't already eaten into the emergency reserve. If
    // exhausted, emit `candidate` `gas-budget-blocks-reapproval` and skip the
    // approve. Posting commitments + routine off-chain cancels are gasless and
    // are NOT gated here. The daily counter (state.dailyCounters) persists
    // across restarts so the same UTC day's spend is honored.
    const today = todayUTCDateString(this.deps.now());
    const todayCounter = this.state.dailyCounters[today];
    const todayGasSpentPolWei = todayCounter !== undefined ? BigInt(todayCounter.gasPolWei) : 0n;
    const maxDailyGasPolWei = polFloatToWei18(this.config.gas.maxDailyGasPOL);
    const emergencyReservePolWei = polFloatToWei18(this.config.gas.emergencyReservePOL);
    const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei });
    if (!verdict.allowed) {
      this.eventLog.emit('candidate', {
        skipReason: 'gas-budget-blocks-reapproval',
        purpose: 'positionModule-approve',
        todayGasSpentPolWei: todayGasSpentPolWei.toString(),
        maxDailyGasPolWei: maxDailyGasPolWei.toString(),
        emergencyReservePolWei: emergencyReservePolWei.toString(),
        detail: verdict.reason,
      });
      return;
    }

    let result: ApproveResult;
    try {
      result = await this.adapter.approveUSDC(amount);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'approve' });
      return;
    }

    // The approve's POL cost — wei18. Exposed for (d-ii)'s daily-counter accumulator.
    const gasUsed = BigInt(result.receipt.gasUsed);
    const effectiveGasPrice = BigInt(result.receipt.effectiveGasPrice);
    const gasPolWei = gasUsed * effectiveGasPrice;

    // Accumulate today's gas spend so the verdict honors it on subsequent ops
    // (settle / claim — wired in (e-i); on-chain cancel / kill — landing in
    // (e-ii) / (f)). Persisted across restarts via the per-tick state flush.
    this.recordGasSpentToday(today, gasPolWei);

    const payload: Record<string, unknown> = {
      purpose: 'positionModule',
      spender: positionModule.spender,
      currentAllowance: currentAllowance.toString(),
      requiredAggregateAllowance: requiredCapWei6.toString(),
      amountSetTo: result.amount.toString(),
      txHash: result.txHash,
      gasPolWei: gasPolWei.toString(),
    };
    if (walletUSDCWei6 !== undefined) payload.walletBalanceWei6 = walletUSDCWei6.toString();
    this.eventLog.emit('approval', payload);
  }

  /**
   * Periodic auto-settle + auto-claim of the maker's own positions (DESIGN §6 / §11).
   * Walks `state.positions` (the local mirror that `pollPositionStatus` keeps in sync
   * with the API buckets):
   *   - For each record at `status: 'pendingSettle'` with `settlement.autoSettleOwn`,
   *     gas-verdict (`mayUseReserve = settlement.continueOnGasBudgetExhausted`) →
   *     `adapter.settleSpeculation({ speculationId })` → emit `settle` carrying the
   *     on-chain `winSide` + `txHash` + `gasPolWei`. No local status flip — the next
   *     `pollPositionStatus` observes the bucket change to `claimable` and runs the
   *     `position-transition` event through `syncPolledPosition`. The contract
   *     reverts on already-settled, so an extra concurrent settle by another EOA
   *     just shows up as `error` `phase: 'settle'` and the tick continues.
   *   - For each record at `status: 'claimable'` with `settlement.autoClaimOwn`,
   *     gas-verdict (same `mayUseReserve` rule) →
   *     `adapter.claimPosition({ speculationId, positionType })` → emit `claim`
   *     carrying the on-chain `payoutWei6` + `txHash` + `gasPolWei` → stamp the
   *     record's `status = 'claimed'` so a later poll (with the position now
   *     absent from the API) doesn't re-attempt the claim.
   *
   * Gas accumulates into `state.dailyCounters[YYYY-MM-DD].gasPolWei`; the
   * `gas-budget-blocks-settlement` `candidate` skip fires when the verdict denies.
   * Errors (adapter throws on `settleSpeculation` / `claim`) are logged + the
   * tick continues — typically a reverted "already settled" / "no payout" /
   * "already claimed" by another caller; the next poll re-reads chain state.
   *
   * Runs after `pollPositionStatus` and before `reconcileMarkets` so the
   * post-claim risk-engine view sees `claimed` status (headroom recovered) on
   * the same tick the claim landed. Gated by the same fail-closed
   * `positionPollOk || !hasSoftCancelled` rule as `reconcileMarkets` /
   * `ageOut` — if positions can't be verified and softCancelled commitments
   * exist, we don't trigger on-chain settle/claim either.
   */
  private async settleAndClaim(): Promise<void> {
    if (this.makerAddress === null) return; // live-mode invariant
    const autoSettle = this.config.settlement.autoSettleOwn;
    const autoClaim = this.config.settlement.autoClaimOwn;
    if (!autoSettle && !autoClaim) return; // operator opted out of both

    const continueOnGasBudgetExhausted = this.config.settlement.continueOnGasBudgetExhausted;
    const maxDailyGasPolWei = polFloatToWei18(this.config.gas.maxDailyGasPOL);
    const emergencyReservePolWei = polFloatToWei18(this.config.gas.emergencyReservePOL);

    // Snapshot the records up front — `claimPosition` mutates `state.positions`
    // (sets `status: 'claimed'`), and modifying an object while iterating its
    // `Object.values()` is fragile.
    const pendingSettleRecords = autoSettle
      ? Object.values(this.state.positions).filter((r) => r.status === 'pendingSettle')
      : [];
    const claimableRecords = autoClaim
      ? Object.values(this.state.positions).filter((r) => r.status === 'claimable')
      : [];

    // Settle first — pending speculations have to be settled on chain before any
    // claim against them can succeed. The settle's tx doesn't flip the local
    // status (that's the position poll's job on the next tick); but if another
    // EOA settled the same speculation between this tick's poll and our settle
    // call, the contract reverts and we log + continue.
    for (const r of pendingSettleRecords) {
      const today = todayUTCDateString(this.deps.now());
      const todayGasSpentPolWei = BigInt(this.state.dailyCounters[today]?.gasPolWei ?? '0');
      const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve: continueOnGasBudgetExhausted });
      if (!verdict.allowed) {
        this.eventLog.emit('candidate', {
          skipReason: 'gas-budget-blocks-settlement',
          purpose: 'settleSpeculation',
          speculationId: r.speculationId,
          contestId: r.contestId,
          makerSide: r.side,
          todayGasSpentPolWei: todayGasSpentPolWei.toString(),
          maxDailyGasPolWei: maxDailyGasPolWei.toString(),
          emergencyReservePolWei: emergencyReservePolWei.toString(),
          mayUseReserve: continueOnGasBudgetExhausted,
          detail: verdict.reason,
        });
        continue;
      }

      let result: Awaited<ReturnType<OspexAdapter['settleSpeculation']>>;
      try {
        result = await this.adapter.settleSpeculation({ speculationId: BigInt(r.speculationId) });
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'settle', speculationId: r.speculationId });
        continue;
      }
      const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
      this.recordGasSpentToday(today, gasPolWei);
      this.eventLog.emit('settle', {
        speculationId: r.speculationId,
        contestId: r.contestId,
        sport: r.sport,
        awayTeam: r.awayTeam,
        homeTeam: r.homeTeam,
        makerSide: r.side,
        winSide: result.winSide,
        txHash: result.txHash,
        gasPolWei: gasPolWei.toString(),
      });
    }

    for (const r of claimableRecords) {
      const today = todayUTCDateString(this.deps.now());
      const todayGasSpentPolWei = BigInt(this.state.dailyCounters[today]?.gasPolWei ?? '0');
      const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve: continueOnGasBudgetExhausted });
      if (!verdict.allowed) {
        this.eventLog.emit('candidate', {
          skipReason: 'gas-budget-blocks-settlement',
          purpose: 'claimPosition',
          speculationId: r.speculationId,
          contestId: r.contestId,
          makerSide: r.side,
          todayGasSpentPolWei: todayGasSpentPolWei.toString(),
          maxDailyGasPolWei: maxDailyGasPolWei.toString(),
          emergencyReservePolWei: emergencyReservePolWei.toString(),
          mayUseReserve: continueOnGasBudgetExhausted,
          detail: verdict.reason,
        });
        continue;
      }

      const positionType = r.side === 'away' ? 0 : 1;
      let result: Awaited<ReturnType<OspexAdapter['claimPosition']>>;
      try {
        result = await this.adapter.claimPosition({ speculationId: BigInt(r.speculationId), positionType });
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'claim', speculationId: r.speculationId });
        continue;
      }
      const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
      this.recordGasSpentToday(today, gasPolWei);
      r.status = 'claimed';
      r.updatedAtUnixSec = this.deps.now();
      this.eventLog.emit('claim', {
        speculationId: r.speculationId,
        contestId: r.contestId,
        sport: r.sport,
        awayTeam: r.awayTeam,
        homeTeam: r.homeTeam,
        makerSide: r.side,
        positionType,
        payoutWei6: result.payoutWei6.toString(),
        txHash: result.txHash,
        gasPolWei: gasPolWei.toString(),
      });
    }
  }

  /** Add `gasPolWei` to today's `state.dailyCounters` counter (additive; preserves `feeUsdcWei6`; lazy-creates the entry). Shared by `applyAutoApprovals` + `settleAndClaim`. */
  private recordGasSpentToday(today: string, gasPolWei: bigint): void {
    const existing = this.state.dailyCounters[today];
    const prior = existing !== undefined ? BigInt(existing.gasPolWei) : 0n;
    this.state.dailyCounters[today] = {
      gasPolWei: (prior + gasPolWei).toString(),
      feeUsdcWei6: existing !== undefined ? existing.feeUsdcWei6 : '0',
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

/** The UTC date `YYYY-MM-DD` for `unixSec` — the key into `state.dailyCounters`. UTC so a maker straddling midnight in any local timezone sees the same day boundary as another instance in another zone. */
function todayUTCDateString(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert a config-supplied float POL value to wei18. POL has 18 decimals; budgets are typically << 1 POL so the `Number → BigInt` round-trip is exact for any realistic input. */
function polFloatToWei18(p: number): bigint {
  return BigInt(Math.round(p * 1e18));
}

/** Strict forward-only ordering of `MakerPositionStatus` — used by `pollPositionStatus` to reject a backwards transition (e.g. a `claimable` record reported back in `active`). */
function positionStatusRank(s: MakerPositionStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'pendingSettle': return 1;
    case 'claimable': return 2;
    case 'claimed': return 3;
  }
}

/** Compact a `QuoteSide` (a taker offer) for the `quote-intent` event payload — the taker-facing price (tick + implied prob) and size, plus the protocol commitment params it converts to (`toProtocolQuote`: `makerSide` / `makerOddsTick` / `positionType`). `null` for a side the desired quote pulled / refused. */
function quoteSideSummary(qs: QuoteSide | null): {
  takerOddsTick: number;
  takerImpliedProb: number;
  makerSide: MakerSide;
  makerOddsTick: number;
  positionType: 0 | 1;
  sizeUSDC: number;
  sizeWei6: string;
} | null {
  if (qs === null) return null;
  const proto = toProtocolQuote({ side: qs.takerSide, oddsTick: qs.quoteTick });
  return {
    takerOddsTick: qs.quoteTick,
    takerImpliedProb: qs.quoteProb,
    makerSide: proto.makerSide,
    makerOddsTick: proto.makerOddsTick,
    positionType: proto.positionType,
    sizeUSDC: qs.sizeUSDC,
    sizeWei6: String(qs.sizeWei6),
  };
}

/** An orderbook `Commitment` that's still matchable (`isLive`), carries the fields the competitiveness check needs (`oddsTick` + `positionType`), and has an in-range `oddsTick` (so `inverseOddsTick` can convert it). Legacy / partially-decoded / out-of-range rows are skipped — they can't be valid matchable commitments anyway. */
type PricedLiveCommitment = Commitment & { oddsTick: number; positionType: 0 | 1 };
function isPricedLiveCommitment(c: Commitment): c is PricedLiveCommitment {
  return c.isLive && c.oddsTick !== null && c.positionType !== null && isTickInRange(c.oddsTick);
}

/** The `would-soft-cancel` event payload for a pulled commitment record — the protocol commitment params (`makerSide` / `makerOddsTick` / `positionType`) plus `takerSide` (the offer side it served, `oppositeSide(makerSide)`) and the pull reason. */
function softCancelEventPayload(record: MakerCommitmentRecord, reason: SoftCancelReason): Record<string, unknown> {
  return {
    commitmentHash: record.hash,
    speculationId: record.speculationId,
    contestId: record.contestId,
    sport: record.sport,
    awayTeam: record.awayTeam,
    homeTeam: record.homeTeam,
    takerSide: oppositeSide(record.makerSide),
    makerSide: record.makerSide,
    positionType: positionTypeForSide(record.makerSide),
    makerOddsTick: record.oddsTick,
    reason,
  };
}
