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
 *   - **reference odds** (DESIGN §10's stream guardrails): for each tracked
 *     market keep its reference moneyline odds + freshness current — by default a
 *     core-api SSE odds stream per market (snapshot-first seed, then the stream's
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
 * `fill` / `position-transition` / `settle` / `claim` events), the
 * `raiseMinNonce` per-speculation invalidation optimization (both for the
 * on-chain kill path here and `cancel-stale --authoritative` — both currently
 * per-commitment), and the `status` CLI command. (`cancel-stale` is a separate
 * one-shot CLI under `src/cli/cancel-stale.ts` — already wired.) Auto-settle +
 * auto-claim are wired here — they walk
 * `state.positions` each tick after the position poll, gas-gated by
 * `canSpendGas` with `mayUseReserve = settlement.continueOnGasBudgetExhausted`,
 * and emit `settle` / `claim` events; the `claim` path stamps the local
 * `MakerPositionStatus` to `claimed`. The kill switch's on-chain path
 * (`killCancelOnChain: true`) is wired too: on actual shutdown
 * (`shutdownReason !== null`), `onchainKillCancel` iterates every non-terminal
 * commitment and calls `cancelCommitmentOnchain` (gas-gated with
 * `mayUseReserve: true` — operator-explicit "burn the reserve"), stamping
 * each cancelled record `authoritativelyInvalidated`.
 *
 * No `@ospex/sdk` import — all chain/API access goes through the `OspexAdapter`. The
 * clock, sleep, kill-switch probe, OS-signal registration, and randomness are
 * injectable (`RunnerDeps`) and so is the `OspexAdapter`, so the loop is
 * unit-testable: run a bounded number of ticks; drive shutdown via the kill probe
 * or a simulated signal; pin discovery timing; drive the odds callbacks via a fake
 * `subscribeOdds`; fake `getContest` / `getSpeculation` / `getOddsSnapshot`.
 */

import { existsSync } from 'node:fs';

import { DEFAULT_PER_IP_STREAM_CAP, POLL_INTERVAL_FLOOR_MS, RESERVED_OWN_STATE_STREAMS, type Config } from '../config/index.js';
import { buildDesiredQuote, inventoryFromState, isExpiredForRelease, matchableCommitmentRiskWei6, reconcileBook, type BookReconciliation, type DesiredQuote, type RetainedPartial, type RetainedPartialReason, type SoftCancelReason } from '../orders/index.js';
import { OspexStreamError } from '../ospex/index.js';
import type {
  ApproveResult,
  ApproveUSDCAmount,
  ApprovalsSnapshot,
  Commitment,
  PublicVisibleCommitment,
  ContestOddsSnapshot,
  ContestView,
  Fill,
  Hex,
  MoneylineOdds,
  OddsSubscribeHandlers,
  OspexAdapter,
  OwnerCommitment,
  OwnerStateSnapshot,
  OwnerStateSubscribeHandlers,
  OwnStateFrameMeta,
  OwnStateHealth,
  PositionStatus,
  PositionStatusEvent,
  SpeculationView,
  Subscription,
} from '../ospex/index.js';
import { decimalToTick, inverseOddsTick, isTickInRange, oppositeSide, positionTypeForSide, toProtocolQuote, type ProtocolQuote, type QuoteSide } from '../pricing/index.js';
import {
  emptyOwnStateSession,
  mapOwnerCommitmentToMaker,
  mapOwnerPositionToMaker,
  OwnerMappingError,
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
  reducePolledCommitmentObservation,
  reducePolledPositionObservation,
  reducePolledSoftCancelledObservation,
  type ApplyDescriptorsResult,
  type OwnStateSession,
  type OwnStateTransportStatus,
  type PolledCommitmentObservation,
  type PolledPositionInput,
  type ReducerDescriptor,
} from '../reducers/index.js';
import { OwnStateQueue } from './own-state-queue.js';
import { compareAuditVsCanonical, type TrackedDivergence } from './audit-comparator.js';
import { WakeSignal } from './wake-signal.js';
import { canSpendGas, requiredPositionModuleAllowanceUSDC, type Market } from '../risk/index.js';
import { assessStateLoss, dispatchCancel, emptyMakerState, fillDedupKey, isTerminalPositionStatus, toMakerSignedPayload, type CancelDispatch, type MakerCommitmentRecord, type MakerSide, type MakerSignedPayload, type MakerState, type StateLossAssessment, type StateStore } from '../state/index.js';
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
  /** The neutral reference-game id — always set (a contest with no upstream linkage is skipped at discovery with `no-reference-odds`). Retained for the upstream-linkage gate and telemetry; the odds SSE stream itself is opened by `contestId`. */
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
   * The live SSE odds stream for this market's reference odds, or `null` — not
   * yet (re)subscribed (a newcomer this discovery cycle, or one whose stream
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
  /** Is an SSE odds stream live for this market right now? (`false` while degraded / over the channel cap / in `odds.subscribe: false` polling mode.) */
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
type DegradedReason =
  | 'channel-error' //        a fatal stream error ended the subscription (re-subscribed next discovery cycle)
  | 'subscribe-failed' //     the initial subscribe call rejected (re-subscribed next discovery cycle)
  | 'channel-cap' //          over the per-process odds-channel cap; tracked but unsubscribed until a slot frees
  | 'stream-reconnecting' //  the SSE transport dropped and is retrying with backoff (subscription kept alive)
  | 'stream-degraded'; //     the upstream odds source fell behind; live updates paused until the next snapshot

/**
 * Sentinel thrown by `submitQuote`'s `beforePost` hook (the SDK's just-in-time
 * §5.1 boundary, own-state SSE plan / Hermes #73 r3) when own-state health has
 * degraded by the time the SDK is about to `POST /v1/commitments`. The SDK
 * re-throws it unchanged out of `submitRaw`, and `submitQuote`'s catch
 * identity-compares it so the refusal returns `null` (a clean transient-failure →
 * re-quote next tick) WITHOUT logging a spurious submit `error` — the
 * `stream-health-hold` enter edge was already emitted by `updateStreamHealthHold`.
 */
const OWN_STATE_HOLD_ABORT = new Error('own-state degraded — §5.1 posting gate refused the submit at the POST boundary');

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
   * The AUDIT projection of own-state (Phase 3 PR3b source flip). When
   * `ownState.subscribe` is true the SSE stream writes canonical `this.state`
   * and the POLL path writes THIS second `MakerState` instead — a slower
   * cross-check fed to {@link compareAuditVsCanonical}. Process-lifetime, NEVER
   * flushed (an audit divergence is telemetry, not exposure; the one durable
   * canonical file stays `this.state`). Unused in backout (`subscribe:false`),
   * where the poll path remains the canonical writer of `this.state`.
   */
  private readonly auditState: MakerState = emptyMakerState();
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
  /** Hashes of recovered soft-cancels (`softCancelled` with a matched remainder) for which `maybeOnchainCancelRecoveredSoftCancels` has already emitted a `gas-budget-blocks-onchain-cancel` candidate this run — so the denial surfaces ONCE per stuck record rather than every tick (the cancel is still re-attempted each tick, landing when the budget frees). Pruned to currently-eligible hashes each sweep, so it can't grow unbounded. */
  private readonly gasDeniedRecoveredSoftCancelWarned = new Set<string>();
  /** Hashes of recovered soft-cancels for which the on-chain cancel is BLOCKED — `signedPayloadStatus === 'missing-legacy'` AND `lifecycle === 'softCancelled'` means the public commitments API redacts the signed payload (M2) and there's no captured local bundle (own-state SSE plan §M6). Tracked separately from {@link gasDeniedRecoveredSoftCancelWarned} so the `cancel-blocked-missing-payload` telemetry fires once per stuck record. The cancel WILL stay blocked until the operator manually recovers via owner-auth own-state (Phase 2) or the commitment expires; the warned set is pruned each sweep so a record that expired / was filled drops out and a future re-occurrence re-warns. */
  private readonly missingPayloadCancelBlockedWarned = new Set<string>();
  /**
   * Funding guard (C1a, DESIGN §6): `true` while the wallet can't back its matchable-
   * commitment exposure. Recomputed by `checkFunding()` (throttled, live-only) and
   * consulted by the posting gate in `reconcileMarkets`. Distinct from the boot
   * `holdQuotingUntil` (a one-shot time deadline) — this flips both ways as funding moves.
   */
  private fundingHold = false;
  /** Unix-seconds of the last funding re-read; throttles `checkFunding` to `fundingGuard.checkIntervalMs`. `null` = never read. */
  private lastFundingCheckAtSec: number | null = null;
  /**
   * Funding guard (C1b): under `underfundedCancelMode: onchain`, whether the active-cancel
   * sweep has already emitted a `gas-budget-blocks-onchain-cancel` candidate for the *current*
   * hold episode — so a sustained gas shortfall during a hold doesn't spam the log every tick
   * (the sweep still re-attempts the cancels each tick, landing once the budget frees, e.g. at the
   * UTC daily reset). Reset to `false` whenever the hold clears (a fresh episode re-warns) and on
   * the first cancel that lands within an episode. A single flag (not a per-hash set) suffices —
   * the sweep BREAKS on the first denial, since today's gas spend only grows so the rest would deny identically.
   */
  private fundingOnchainGasDeniedWarned = false;

  /**
   * Wakeable-sleep primitive (Phase 2 PR3 — own-state-sse-plan §2.5.1). PR4's
   * SSE handlers will call `wake()` when an own-state event arrives; the runner
   * loop replaces its straight `deps.sleep` with a `Promise.race` against this
   * signal so a wake interrupts the wait WITHOUT advancing the poll deadline.
   * Phase 2 invariant: a wake outcome does NOT increment ticks, run `tick()`,
   * or alter trading-timing.
   */
  private readonly wakeSignal = new WakeSignal();
  /**
   * Bounded buffer for SSE events between drains (spec §2.5.2). An overflow drops
   * an owner event, so it degrades composite own-state health (latched at enqueue
   * via `noteOwnStateOverflow`, Phase 3 PR2): in live + `ownState.subscribe: true`
   * the §5.1 posting gate then halts NEW posting; in dry-run / poll-only it stays
   * telemetry-only. Never alters canonical state directly / never sets `fundingHold`.
   */
  private readonly ownStateQueue = new OwnStateQueue();
  /**
   * Process-lifetime dedup set for owner-side `fill` events (Phase 2 PR4b —
   * own-state-sse-plan §2.5.3 restart-safety model). Seeded at the end of
   * the constructor from `state.commitments[].fills[]`; mutated by
   * `reduceOwnerFill`. Keys are `(txHash, logIndex)` per the SDK's spec
   * §2.1.2 dedup contract.
   *
   * Phase 2 is shadow-only: `MakerCommitmentRecord.fills[]` is empty (poll
   * never appends; owner reducer never writes canonical state). So the seed
   * is empty at boot in Phase 2 — forward-compat infrastructure for Phase 3
   * cutover when `reduceOwnerFill` starts appending to canonical `fills[]`.
   */
  private readonly ownStateDedupSet = new Set<string>();
  /**
   * Per-tick comparator state (Phase 2 PR5 — own-state-sse-plan §6.3). Tracks
   * each persisting divergence so the tolerance window can suppress transient
   * skew while persistent mismatch is emitted regardless of source-side freshness.
   */
  private readonly divergenceTracker = new Map<string, TrackedDivergence>();
  /**
   * Wall-clock ms (`Date.now()`) of the last completed post-tick `drainOwnState`
   * — the comparator uses this as "the poll side last observed at..." for the
   * tolerance window. `0` until the first tick completes.
   */
  private lastPollObsAtMs = 0;
  /**
   * Latch — `true` once at least one tick has completed AFTER `shadow.ready`
   * flipped true. The comparator suppresses until this is set so a fresh
   * shadow isn't compared against stale canonical-state (the comparator would
   * spuriously report divergence for every row before the next poll refreshes).
   * Cleared on resync (`shadow.ready = false`).
   */
  private firstAuditPollAfterReady = false;
  /**
   * Projection of canonical state built from the SSE stream (Phase 2 PR2 type;
   * PR4 wires the SSE feed). Distinct object identity from `this.state` so the
   * source-aware reducers' compile-time guards prevent crossing the canonical /
   * shadow boundary. PR5 wires the comparator that reads this against
   * `this.state` and emits divergence telemetry.
   */
  private readonly ownStateSession: OwnStateSession = emptyOwnStateSession();
  /**
   * Latch — `true` while the last drain reported `overflowed: true` and a
   * subsequent recovery (healthy stream + empty queue) hasn't cleared it. Used
   * to emit `stream-health-degraded {reason: 'queue-overflow'}` ONCE per
   * overflow window rather than every drain. In Phase 2 the latch can only set
   * (never clear) since the SSE handlers PR4 will own the recovery path.
   */
  private streamOverflowDegraded = false;
  /**
   * The currently-active own-state SSE subscription (Phase 2 PR4a). `null`
   * when `config.ownState.subscribe` is false OR while the runner is
   * resubscribing (resync path lands in PR4b). All event handlers re-check
   * `subscription === this.currentOwnStateSubscription` before any side-effect
   * — per `[[feedback_async_lifecycle_invariant]]` an aborted subscription's
   * callbacks MUST NOT mutate shadow state, enqueue events, or call `wake()`.
   *
   * The SDK guarantees handlers don't fire after `await unsubscribe()`, but
   * the in-flight `Subscription` identity is the load-bearing check inside
   * the runner — belt-and-braces.
   */
  private currentOwnStateSubscription: Subscription | null = null;
  /**
   * Whether the CURRENT own-state subscription was opened with a persisted
   * `initialCursor` (a resume), and no snapshot page has arrived on it yet
   * (own-state SSE plan §4.2, Phase 3 PR1). Set when `openOwnStateSubscription`
   * passes an `initialCursor`; cleared the moment a snapshot page arrives
   * (`handleOwnerSnapshot`) or `onReady` confirms a baseline. The empty-baseline
   * guard reads it: an `onReady` with `pendingBaseline === null` AND this flag
   * still set means the resume delivered NO snapshot — there is no durable
   * baseline for the cursor (a cursor alone is not state), so it cold-restarts.
   * It does NOT trip on a mid-session reconnect (the in-memory baseline is still
   * live there, and the flag is already false).
   */
  private resumedFromPersistedCursor = false;
  /**
   * Set by the empty-baseline guard (`handleOwnerReady`) to request an async
   * cold restart of the own-state subscription — close + reopen CURSOR-LESS so
   * the SDK cold-connects with a fresh snapshot. Acted on (and cleared) by
   * `performOwnStateColdRestart`, which the run loop invokes right after the
   * wake-path / post-tick `drainOwnState`. The guard cannot do the async
   * close/reopen itself (it runs inside a synchronous SDK handler).
   */
  private ownStateColdRestartRequested = false;
  /**
   * Recovery-hold anchor (own-state SSE plan §5, latch 8 — Phase 3 PR2). The
   * unix-second time at which the composite latch conjunction (see
   * {@link recomputeOwnStateHealth}) first became healthy in the current healthy
   * episode; `null` whenever any latch is tripped. The posting gate only trusts
   * own-state once the latches have been continuously healthy for
   * `ownState.recoveryHoldMs` — `(now - this) * 1000 >= recoveryHoldMs` (the
   * clock is unix SECONDS, the config is MILLISECONDS, mirroring the funding
   * guard's `checkIntervalMs` comparison). Prevents flapping the posting gate on
   * a brief recovery blip.
   */
  private healthyEligibleSinceSec: number | null = null;
  /**
   * §5 latch 2 (`transportFresh`) source — the unix-second time of the most
   * recent own-state SSE frame (ANY frame, including heartbeats), recorded by
   * {@link handleOwnerFrame} from the SDK's `onFrame` callback (Phase 3 PR2b).
   * `null` until the first frame. Transport freshness is `(now - this) * 1000 <
   * ownState.staleMaxMs` — see {@link transportFresh}.
   *
   * Stamped with `deps.now()` (unix SECONDS, the injected clock) — NOT the
   * SDK's `OwnStateFrameMeta.receivedAtMs` (`Date.now()` ms) — so freshness is
   * in the SAME units + clock as the recovery-hold anchor and is testable with
   * the injected clock.
   *
   * Unlike the event-driven latches, `transportFresh` is TIME-DEPENDENT — it
   * decays to false purely by the passage of time with NO SDK event — so it
   * canNOT be a stored bit on `shadow.healthy` (which would go stale). It is
   * evaluated at READ time and AND-ed onto the edge mirror by
   * {@link instantOwnStateHealthy}; the recovery-hold anchor is therefore
   * re-maintained at read time too (see {@link ownStateHealthy}).
   */
  private lastFrameAtSec: number | null = null;
  /**
   * §5 latch 7 (`tokenRefreshFailureInFlight`) — an EDGE latch (Phase 3 PR2b).
   * `true` between a `token-refresh` stream error (the SDK failed to re-mint the
   * bearer for a reconnect during an ALREADY-CONNECTED subscription — see
   * `OspexStreamError.phase`) and the next proof the transport re-authenticated.
   * A `token-mint` failure (initial connect, before any baseline) is NOT latched
   * here — it leaves `ready` false, which the mirror already reads as unhealthy.
   *
   * Cleared on {@link handleOwnerFrame} (a frame can only arrive on an open,
   * successfully-authed connection — the bearer is consumed at connect-time — so
   * a frame is the earliest robust "auth recovered" signal, and the SDK never
   * fires `token-refresh` while frames are flowing because it only re-mints at
   * reconnect), with backstops on `onStatus('connected')` and rebaseline. Folds
   * into the edge mirror `shadow.healthy` via {@link recomputeOwnStateHealth}.
   */
  private tokenRefreshFailureInFlight = false;
  /**
   * Transition latch for the §5.1 own-state-health posting gate's telemetry
   * (Phase 3 PR2). `true` while {@link updateStreamHealthHold} is holding; used
   * to emit `stream-health-hold` ONLY on an enter/clear edge (a sustained hold
   * must not spam the log), exactly as {@link setFundingHold} gates `funding-hold`.
   */
  private streamHealthHolding = false;
  /**
   * §5 latch 6 (`indexerLagDegraded`, Phase 3 PR2c-i) — a POSTING-only latch.
   * `true` while the last `client.ownState.health()` poll reported the indexer's
   * lag at/above `ownState.indexerLagMaxSeconds`, OR the poll itself FAILED
   * (fail-closed: an indexer we can't assess must not let the MM add exposure).
   * Set/cleared by {@link checkIndexerLag} (throttled to `auditPollIntervalMs`)
   * and ANDed into the posting gate {@link ownStateHealthy} — NOT the edge mirror
   * or the comparator's {@link instantOwnStateHealthy} gate (it is a posting-safety
   * signal, not a shadow-freshness one; the indexer backs both shadow + poll
   * equally, so it must not suppress the audit nor reset the recovery hold).
   */
  private indexerLagDegraded = false;
  /** Unix-seconds of the last own-state health poll; throttles {@link checkIndexerLag} to `ownState.auditPollIntervalMs`. `null` = never polled. */
  private lastAuditPollAtSec: number | null = null;
  /**
   * §5 latch 5 (`auditDivergenceUnresolved`, Phase 3 PR2c-ii) — a POSTING-only latch.
   * `true` while {@link runAuditComparator}'s last comparison found an EMIT-WORTHY
   * (persistent — aged past `divergenceToleranceMs`) shadow-vs-canonical divergence;
   * cleared when a comparison finds none, and on rebaseline ({@link resetOwnStateForRebaseline},
   * with the divergence tracker). Set/cleared from the comparator's `payload !== null`
   * result and ANDed into {@link ownStateHealthy} — NOT the edge mirror or the comparator's
   * own {@link instantOwnStateHealthy} gate. The decouple is LOAD-BEARING: the comparator
   * (which PRODUCES this latch) gates on `instantOwnStateHealthy`, so a latched divergence
   * holds posting WITHOUT suppressing the very comparator that can clear it — folding latch
   * 5 into the comparator gate would self-deadlock.
   */
  private auditDivergenceUnresolved = false;

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
    // Own-state SSE subscription (Phase 2 PR4a) is opt-in via `config.ownState.subscribe`.
    // Boot refuses if the operator asked for the stream but provided no maker address
    // (dry-run, or live without `runRun` resolving the signer's address): the SDK's
    // bearer-token mint signs with the signer's key and the token's `address` claim
    // must match — without a maker address there's no `address` to scope the subscription.
    if (this.config.ownState.subscribe && opts.makerAddress === undefined) {
      throw new Error(
        'Runner: `config.ownState.subscribe: true` requires a `makerAddress` — the own-state SSE stream is owner-authenticated, scoped to the signer\'s address. Set `mode.dryRun: false` AND `wallet.keystorePath` so `runRun` can resolve the signer.',
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

    // Stream-budget guardrail: each odds subscription is one core-api SSE connection,
    // counted against the per-IP cap shared with the (deferred) own-state streams. Warn
    // (don't clamp) if the configured cap + reserved own-state streams would exceed the
    // conservative default — the operator may have raised MAX_STREAM_CONNECTIONS_PER_IP.
    if (
      this.config.odds.subscribe &&
      this.config.odds.maxRealtimeChannels + RESERVED_OWN_STATE_STREAMS > DEFAULT_PER_IP_STREAM_CAP
    ) {
      this.deps.log(
        `[runner] odds.maxRealtimeChannels=${this.config.odds.maxRealtimeChannels} + ${RESERVED_OWN_STATE_STREAMS} reserved own-state streams exceeds the core-api per-IP cap of ${DEFAULT_PER_IP_STREAM_CAP} — odds subscriptions past the cap are refused (HTTP 429). Lower odds.maxRealtimeChannels (and marketSelection.maxTrackedContests), or raise MAX_STREAM_CONNECTIONS_PER_IP on your core-api.`,
      );
    }

    const { state, status } = this.stateStore.load();
    this.state = state;
    // Phase 2 PR4b — seed the owner-fill dedup-set from canonical persisted
    // fills (own-state-sse-plan §2.5.3). Phase 2 keeps the canonical
    // `fills[]` empty (poll never appends; shadow reducer never writes
    // canonical state); this seed is forward-compat for Phase 3 cutover.
    for (const c of Object.values(this.state.commitments)) {
      for (const f of c.fills) this.ownStateDedupSet.add(fillDedupKey(f.txHash, f.logIndex));
    }
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

  /**
   * Funding guard (C1a, DESIGN §6). Throttled to `fundingGuard.checkIntervalMs`, re-read
   * the wallet's USDC balance + PositionModule allowance and set `this.fundingHold` =
   * `funding < required`, where:
   *   - funding  = min(walletUSDC, positionModuleAllowance) — what the wallet can actually
   *                pay into `recordFill` right now;
   *   - required = the GROSS remaining maker risk over matchable commitments (visible +
   *                soft-cancelled-unexpired), NOT the risk engine's outcome-netted
   *                worst-case and NOT position-inclusive — see {@link matchableCommitmentRiskWei6}.
   *
   * A balance/allowance READ failure enters the hold when `failClosedOnReadError`: a read
   * we can't complete must never let the MM post commitments it might not be able to back.
   * Caller gates this to live mode (it needs `makerAddress` + does chain reads); the hold
   * only matters live, where `reconcileMarkets` actually posts.
   */
  private async checkFunding(): Promise<void> {
    const fg = this.config.fundingGuard;
    if (!fg.enabled || this.makerAddress === null) return;

    const nowSec = this.deps.now();

    // `required` is cheap local-state math — compute it every check. No matchable
    // exposure ⇒ the wallet trivially backs it: clear any hold and skip the (RPC)
    // reads entirely. This also keeps the guard inert (no balance/allowance reads)
    // until the MM actually has outstanding commitments to back.
    const requiredWei6 = matchableCommitmentRiskWei6(this.state, nowSec, this.config.orders.expiryReleaseGraceSeconds);
    if (requiredWei6 === 0n) {
      this.setFundingHold(false, { reason: 'funding-shortfall', requiredWei6 });
      return;
    }

    // Throttle the funding READS (they cost RPC; funding moves slowly). Between reads the
    // current hold persists — fail-safe: a hold entered on a read failure stays set until a
    // successful re-read clears it.
    if (this.lastFundingCheckAtSec !== null && (nowSec - this.lastFundingCheckAtSec) * 1000 < fg.checkIntervalMs) {
      return;
    }
    this.lastFundingCheckAtSec = nowSec;

    let walletUsdcWei6: bigint;
    let positionAllowanceWei6: bigint;
    try {
      walletUsdcWei6 = (await this.adapter.readBalances(this.makerAddress)).usdc;
      positionAllowanceWei6 = (await this.adapter.readApprovals(this.makerAddress)).usdc.allowances.positionModule.raw;
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'funding-check' });
      if (fg.failClosedOnReadError) this.setFundingHold(true, { reason: 'read-failed' });
      return;
    }

    const fundingWei6 = walletUsdcWei6 < positionAllowanceWei6 ? walletUsdcWei6 : positionAllowanceWei6;
    this.setFundingHold(fundingWei6 < requiredWei6, {
      reason: 'funding-shortfall',
      fundingWei6,
      requiredWei6,
      walletUsdcWei6,
      positionAllowanceWei6,
    });
  }

  /**
   * Flip `fundingHold` and emit a `funding-hold` telemetry event ONLY on a state
   * transition (enter / clear), so a sustained hold doesn't spam the log every check.
   * Numeric context (wei6 decimal strings) is attached when known.
   */
  private setFundingHold(
    hold: boolean,
    ctx: {
      reason: 'funding-shortfall' | 'read-failed';
      fundingWei6?: bigint;
      requiredWei6?: bigint;
      walletUsdcWei6?: bigint;
      positionAllowanceWei6?: bigint;
    },
  ): void {
    if (hold === this.fundingHold) return; // no transition — stay quiet
    this.fundingHold = hold;
    if (!hold) this.fundingOnchainGasDeniedWarned = false; // hold cleared — the next episode's onchain sweep re-warns on a fresh gas denial (C1b)
    const payload: Record<string, unknown> = { state: hold ? 'entered' : 'cleared', reason: ctx.reason };
    if (ctx.fundingWei6 !== undefined) payload.fundingWei6 = ctx.fundingWei6.toString();
    if (ctx.requiredWei6 !== undefined) payload.requiredWei6 = ctx.requiredWei6.toString();
    if (ctx.walletUsdcWei6 !== undefined) payload.walletUsdcWei6 = ctx.walletUsdcWei6.toString();
    if (ctx.positionAllowanceWei6 !== undefined) payload.positionModuleAllowanceWei6 = ctx.positionAllowanceWei6.toString();
    this.eventLog.emit('funding-hold', payload);
    this.deps.log(
      `[runner] funding hold ${hold ? 'ENTERED' : 'cleared'} (${ctx.reason})` +
        (ctx.fundingWei6 !== undefined && ctx.requiredWei6 !== undefined
          ? ` — funding ${ctx.fundingWei6} wei6 vs required ${ctx.requiredWei6} wei6`
          : ''),
    );
  }

  /**
   * Funding-guard active-cancel response (C1b, DESIGN §6). Runs each live tick while
   * {@link fundingHold} is set, per `config.fundingGuard.underfundedCancelMode`:
   *
   *   - `none`     — no active cancel; the C1a hold (halt NEW posting) is the whole
   *                  response. Existing quotes ride to expiry, so the hold persists until
   *                  they age out (or funding is topped up above the still-latent exposure).
   *   - `offchain` — pull every still-matchable `visibleOpen` quote off the relay (gasless
   *                  `cancelCommitmentOffchain` → `softCancelled`, reason `'funding'`), so no
   *                  NEW fills arrive through the relay. **Does NOT reduce `required`**: an
   *                  off-chain pull is visibility-only — the signed payload stays matchable on
   *                  chain until expiry, so {@link matchableCommitmentRiskWei6} keeps counting
   *                  it. The hold therefore persists until those commitments expire.
   *   - `onchain`  — the off-chain pull above, THEN an authoritative on-chain `cancelCommitment`
   *                  for every still-matchable non-terminal record. Each landed cancel stamps
   *                  the record `authoritativelyInvalidated`, which DOES drop it from `required`
   *                  — so this is the only mode that actively shrinks the exposure and lets the
   *                  hold clear (once funding ≥ the remaining required). Gas-gated via
   *                  {@link onchainCancelCommitment} (`mayUseReserve: false` — an automatic
   *                  guard must not burn the emergency reserve); a gas denial emits ONE
   *                  `gas-budget-blocks-onchain-cancel` candidate per hold episode (see
   *                  {@link fundingOnchainGasDeniedWarned}) and stops the sweep for the tick.
   *
   * Eligibility mirrors {@link matchableCommitmentRiskWei6} (the `required` this responds to)
   * exactly — non-terminal lifecycle, not past `expiry + expiryReleaseGraceSeconds` — so the
   * sweep acts on precisely the commitments that count toward the shortfall. A within-grace
   * record may still match on chain (the grace exists for host/chain clock skew), so it is
   * still swept; a past-grace one is dead on chain (`ageOut` terminalizes it) and is skipped so
   * the sweep doesn't waste a relay call / gas on it. (This is grace-aware, unlike
   * `pullVisibleQuotes`'s strict `expiry <= now` book-hygiene cutoff — here we match `required`.)
   *
   * Global scan of `state.commitments` (NOT per-tracked-market, like {@link offchainKillCancel}):
   * a matchable commitment's contest may no longer be tracked, yet its latent risk still counts
   * toward `required`, so the sweep must reach it. Live-only — `fundingHold` is only ever set in
   * live mode (`checkFunding` is dry-run-gated) and the per-record primitives never write to chain
   * in dry-run. Per-record failures self-heal: a thrown off-chain cancel leaves the record
   * `visibleOpen` and a thrown on-chain cancel leaves it as-is, both retried on the next held tick
   * (the sweep runs every tick while held).
   */
  private async fundingCancelSweep(): Promise<void> {
    const mode = this.config.fundingGuard.underfundedCancelMode;
    if (mode === 'none') return; // hold-only (C1a) — existing quotes ride to expiry
    if (this.config.mode.dryRun || this.makerAddress === null) return; // live-only invariant (caller already gates on !dryRun && fundingHold)
    const now = this.deps.now();
    const grace = this.config.orders.expiryReleaseGraceSeconds;

    // ── M6/A PRE-PASS (Hermes #63) ─────────────────────────────────────────────
    // For `cancelMode: onchain` only: a pre-M6/A record (`missing-legacy`) that's
    // still `visibleOpen` must be on-chain-cancelled BEFORE the off-chain pull,
    // because the SDK's `cancelOnchain({ hash })` fetches the public row, and the
    // off-chain DELETE below would flip `book_visible: false` → SDK's
    // `requireVisibleCommitment` refuses → the record bricks into BLOCKED.
    //
    // CRITICAL (Hermes #63 round 2): populate `touchedByPrePass` with ALL
    // candidates UPFRONT, before attempting any cancels. A gas-denied verdict
    // breaks the cancel loop early; if we'd added records inside the loop, later
    // candidates would lose their off-chain-skip protection and the off-chain
    // pull below would brick them into BLOCKED — the same failure mode this
    // pre-pass exists to prevent. Pre-population ensures every candidate gets
    // its off-chain skip regardless of whether the cancel loop reaches it.
    const eligibleCandidates = Object.values(this.state.commitments).filter(
      (r) => r.signedPayloadStatus === 'missing-legacy' && r.lifecycle === 'visibleOpen' && !isExpiredForRelease(r.expiryUnixSec, now, grace),
    );
    const touchedByPrePass = new Set<string>(eligibleCandidates.map((r) => r.hash));
    if (mode === 'onchain') {
      for (const r of eligibleCandidates) {
        const result = await this.onchainCancelCommitment(r, now, {
          emitGasDenied: !this.fundingOnchainGasDeniedWarned,
          overrideDispatch: { kind: 'use-hash', hash: r.hash as Hex },
        });
        if (result === 'gas-denied') {
          this.fundingOnchainGasDeniedWarned = true;
          break; // today's spend only grows — every later attempt would deny too; the touched-set above already protects them
        }
        if (result === 'cancelled') this.fundingOnchainGasDeniedWarned = false;
        // 'transient-failure': adapter threw — record left visibleOpen + in `touchedByPrePass`,
        // so the off-chain loop skips and the regular on-chain leg below retries via dispatch.
      }
    } else {
      // Even in `offchain` mode we ASSEMBLED the candidate set so the off-chain
      // pull doesn't have to re-derive it — but we don't pre-populate the skip
      // set here (offchain mode never authoritatively cancels, so hiding them
      // is the intended behavior; missing-legacy records ride to expiry as
      // softCancelled, which is what the operator chose by configuring this
      // mode). Clear the touched set so the off-chain pull runs normally.
      touchedByPrePass.clear();
    }

    // ── off-chain pull (both `offchain` and `onchain` modes) ──────────────────
    // Pull every still-matchable `visibleOpen` quote off the relay. `softCancelRecord`
    // only acts on (and re-emits for) `visibleOpen` records, so re-running this every held
    // tick is idempotent + quiet once the book is swept; a transient off-chain-cancel failure
    // leaves the record `visibleOpen`, retried next held tick.
    let softCancelled = 0;
    for (const r of Object.values(this.state.commitments)) {
      if (touchedByPrePass.has(r.hash)) continue; // M6/A pre-pass already tried — never off-chain-hide these (would brick them into BLOCKED)
      if (r.lifecycle !== 'visibleOpen') continue;
      if (isExpiredForRelease(r.expiryUnixSec, now, grace)) continue; // dead on chain — not in `required`; ageOut handles it
      if (await this.softCancelRecord(r, 'funding', now)) softCancelled += 1; // true ⟺ pulled (the input is `visibleOpen`); false ⟺ a live cancel threw (stays visible, retried next tick)
    }

    // ── on-chain authoritative cancel (`onchain` mode only) ───────────────────
    // Reduce `required` for real: every still-matchable non-terminal record (the just-pulled
    // `softCancelled` ones, plus any `partiallyFilled` remainders and any `visibleOpen` whose
    // off-chain pull threw) → `authoritativelyInvalidated`. Scanned AFTER the off-chain step so
    // it sees the freshly-`softCancelled` lifecycles. Records the M6/A pre-pass already
    // succeeded on are excluded by the `authoritativelyInvalidated` filter; failed pre-pass
    // records (still `visibleOpen` thanks to the touched-skip above) reach this loop and
    // retry via the regular dispatch (which returns `use-hash` while visible).
    let onchainCancelled = 0;
    if (mode === 'onchain') {
      for (const r of Object.values(this.state.commitments)) {
        if (r.lifecycle !== 'visibleOpen' && r.lifecycle !== 'softCancelled' && r.lifecycle !== 'partiallyFilled') continue;
        if (isExpiredForRelease(r.expiryUnixSec, now, grace)) continue;
        const result = await this.onchainCancelCommitment(r, now, { emitGasDenied: !this.fundingOnchainGasDeniedWarned });
        if (result === 'gas-denied') {
          this.fundingOnchainGasDeniedWarned = true; // warned once for this hold episode
          break; // today's spend only grows — the rest would deny identically; retry next tick (budget frees at the UTC daily reset)
        }
        if (result === 'cancelled') {
          this.fundingOnchainGasDeniedWarned = false; // a cancel landed — re-warn if a later denial occurs this episode
          onchainCancelled += 1;
        }
        // 'transient-failure': the adapter threw — record left as-is, retried next held tick
      }
    }

    if (softCancelled > 0 || onchainCancelled > 0) {
      this.deps.log(`[runner] funding-cancel sweep (mode=${mode}): soft-cancelled ${softCancelled} visible quote(s), on-chain-cancelled ${onchainCancelled}`);
    }
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
    // Cadence selection (PR3b source flip): when subscribe is true the SSE
    // stream drives own-state in real time and the per-tick poll is only the
    // slower AUDIT cross-check + the reconcile/settle/funding/ageOut sweep, so
    // pace the tick at `ownState.auditPollIntervalMs` (default 60s, range
    // 10–300s — its own floor, NOT the trading `POLL_INTERVAL_FLOOR_MS`, which
    // exists to bound the poll-CANONICAL trading cadence in backout). In backout
    // (subscribe:false) the poll IS the trading cadence → the trading floor applies.
    if (this.config.ownState.subscribe) {
      return this.config.ownState.auditPollIntervalMs;
    }
    return Math.max(this.config.pollIntervalMs, POLL_INTERVAL_FLOOR_MS);
  }

  /**
   * Wait for the next poll deadline OR a wake — Phase 2 PR3 (own-state-sse-plan
   * §2.5.1). Returns when the originally-scheduled poll interval has elapsed
   * (cadence-preserving). A `wake()` aborts the in-flight sleep early; after
   * the debounce window, the shadow drains and the wait resumes for the
   * REMAINING time until the original poll deadline. Multiple wakes collapse
   * to one debounce + one drain per outer wake-loop iteration.
   *
   * Cadence preservation is load-bearing for the Phase 2 contract: a wake
   * outcome must NOT push the poll deadline back. This method tracks the
   * deadline against wall-clock time across wake iterations.
   *
   * Outcomes:
   * - poll-deadline: the originally-scheduled sleep ran to completion. The
   *   outer loop ticks next.
   * - kill: `this.abortController` aborted (kill-file or signal). The outer
   *   loop's `stopRequested` check catches it; this method just returns.
   *
   * (`wake` is not an external outcome — the wake-loop is internal; the outer
   * loop only sees the wait return when poll-deadline or kill fires.)
   */
  private async waitForNextPollDeadline(): Promise<void> {
    // Capture both `pollDeadlineMs` (for subsequent-iteration remaining-time
    // accounting) and `totalMs` (used unmodified on the first iteration so the
    // poll-driven sleep value is exactly `sleepMs()` — no `Date.now()` ε
    // drift, keeps the pre-PR3 `[30000, 30000]` test contract verbatim).
    const totalMs = this.sleepMs();
    const pollDeadlineMs = Date.now() + totalMs;
    let firstIter = true;
    while (!this.stopRequested) {
      let remainingMs: number;
      if (firstIter) {
        remainingMs = totalMs;
        firstIter = false;
      } else {
        remainingMs = pollDeadlineMs - Date.now();
        if (remainingMs <= 0) {
          // Poll deadline elapsed — possibly overshot during a wake-handling
          // cycle (debounce + drain). Phase 2 cadence preservation: do NOT
          // chain another debounce; exit so the outer loop runs the next
          // tick. Pending wakes that arrived during the wait will be picked
          // up by the outer loop's pre-tick `drainOwnState`.
          this.wakeSignal.clearPending();
          return;
        }
      }
      const wakeSig = this.wakeSignal.beginWait();
      // Compose wake + kill into a single signal so EITHER firing aborts the
      // sleep early. We then disambiguate the outcome by checking each
      // upstream signal. (Adding a listener to an already-aborted signal does
      // NOT auto-fire it per WHATWG; the explicit pre-checks below handle the
      // already-aborted-at-entry case.)
      const composed = new AbortController();
      if (wakeSig.aborted || this.abortController.signal.aborted) composed.abort();
      const onAbort = (): void => composed.abort();
      wakeSig.addEventListener('abort', onAbort, { once: true });
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await this.deps.sleep(remainingMs, composed.signal);
      } finally {
        wakeSig.removeEventListener('abort', onAbort);
        this.abortController.signal.removeEventListener('abort', onAbort);
        this.wakeSignal.endWait();
      }
      if (this.abortController.signal.aborted) return; // kill — outer loop handles shutdown
      if (wakeSig.aborted) {
        // Wake outcome — debounce, drain, loop back to wait for the ORIGINAL deadline.
        // Cadence preservation: `pollDeadlineMs` is unchanged across wake iterations.
        await this.deps.sleep(this.config.ownState.debounceMs, this.abortController.signal);
        if (this.abortController.signal.aborted) return;
        this.drainOwnState();
        // §4.2 (Phase 3 PR1) — the empty-baseline guard wakes the loop after
        // requesting a cold restart; perform it here, off the wake, now that
        // we're in an async context. No-op unless requested.
        await this.performOwnStateColdRestart();
        // Consume any wakes that arrived OUTSIDE the begin/endWait pair (during
        // the debounce window). Their queue contents are covered by the drain
        // above; without this clear, the next iteration's `beginWait` would
        // see `pending: true` and re-trigger the wake path on an empty queue —
        // under a sustained-burst SSE producer that loop would keep
        // postponing the poll-deadline outcome indefinitely (Hermes review).
        this.wakeSignal.clearPending();
        // PR5 wires the comparator hook here.
        continue;
      }
      // Poll-deadline outcome — sleep ran to completion without a wake.
      return;
    }
  }

  /**
   * Externally-callable wake — Phase 2 PR3 (own-state-sse-plan §2.5.1). PR4's
   * SSE handlers call this on every incoming event so the runner loop's
   * between-tick wait drains the shadow queue immediately (after the
   * `ownState.debounceMs` window) instead of waiting for the next poll
   * deadline. Tests use the same entry point.
   *
   * Calling `wake()` is idempotent: multiple wakes between drains collapse to
   * one wake-outcome — the consumer's drain pass processes the queue contents.
   *
   * Phase 2 invariant: wake does NOT advance the poll deadline, does NOT
   * increment ticks, does NOT run `tick()`. Trading cadence is byte-identical
   * to Phase 1.
   */
  wake(): void {
    this.wakeSignal.wake();
  }

  /**
   * Enqueue an SSE event for the next shadow drain (Phase 2 PR3). PR4 wires
   * the SSE adapter handlers to call this + `wake()`; PR3 exposes it so the
   * queue can be exercised by tests without the SSE adapter present.
   */
  enqueueOwnStateEvent(event: { kind: string; body: unknown; arrivedAtMs?: number; cursor?: string }): 'enqueued' | 'overflow' {
    return this.enqueueOwnStateAndReact({
      kind: event.kind,
      body: event.body,
      arrivedAtMs: event.arrivedAtMs ?? Date.now(),
      // PR1 (own-state SSE plan §4.1): default to '' (no resumable cursor) for
      // the test/external entry point — an empty cursor is never promoted by
      // `drainOwnState`. The SSE handlers below pass the real `meta.cursor`.
      cursor: event.cursor ?? '',
    });
  }

  /**
   * Append an own-state delta to the queue AND react to a queue overflow
   * IMMEDIATELY (Phase 3 PR2 — Hermes #73). A full queue DROPS the event, so the
   * lost owner-state mutation is a health-relevant degradation the §5.1 posting
   * gate must see BEFORE the next `reconcileMarkets`, not only at the post-tick
   * `drainOwnState`: own-state SSE events can arrive (and overflow) during a tick's
   * I/O, after the pre-tick drain but before the posting decision — latching only
   * at drain time would let that tick post on stale-healthy state. Shared by the
   * SSE handlers AND the `enqueueOwnStateEvent` test/external seam so both behave
   * identically. Does NOT wake — callers decide (the SSE handlers wake the loop;
   * the test seam stays wake-free, matching prior behavior).
   */
  private enqueueOwnStateAndReact(event: { kind: string; body: unknown; arrivedAtMs: number; cursor: string }): 'enqueued' | 'overflow' {
    const result = this.ownStateQueue.enqueue(event);
    if (result === 'overflow') this.noteOwnStateOverflow();
    return result;
  }

  /**
   * Latch the queue-overflow degradation, re-derive composite own-state health so
   * the §5.1 gate halts posting, and emit the once-per-overflow-window telemetry
   * (`stream-health-degraded` + conditional `stream-would-hold`). Idempotent
   * within a window via the `streamOverflowDegraded` guard (a fresh `resync`
   * snapshot rebaselines the dropped events and clears the latch in
   * `resetOwnStateForRebaseline`). Called from the enqueue path (the dropped event,
   * Hermes #73) and the drain path (belt-and-braces).
   */
  private noteOwnStateOverflow(): void {
    if (this.streamOverflowDegraded) return; // once per overflow window
    this.streamOverflowDegraded = true;
    this.recomputeOwnStateHealth();
    this.eventLog.emit('stream-health-degraded', {
      reason: 'queue-overflow',
      shadowReady: this.ownStateSession.ready,
      queueCapacity: this.ownStateQueue.capacity,
    });
    const exposureWei6 = computeOpenExposureWei6(this.state, this.deps.now(), this.config.orders.expiryReleaseGraceSeconds);
    if (exposureWei6 > 0n) {
      this.eventLog.emit('stream-would-hold', { reason: 'queue-overflow', exposureWei6: exposureWei6.toString() });
    }
  }

  /**
   * Drain the ownState queue and apply owner-source reducers to the shadow.
   * Overflow is normally already latched + telemetered at ENQUEUE time
   * (`noteOwnStateOverflow`, Hermes #73); this drain only belt-and-braces it.
   *
   * Overflow telemetry — once per overflow window (`streamOverflowDegraded` latch;
   * cleared on a server-driven `resync` rebaseline):
   * - `stream-health-degraded {reason: 'queue-overflow', shadowReady, queueCapacity}` — the composite-health overflow latch tripped (a dropped owner event).
   * - `stream-would-hold {reason: 'queue-overflow', exposureWei6}` — emitted IFF open exposure > 0; informational marker that the overflow happened with exposure at risk.
   *   The overflow degrades composite own-state health (`recomputeOwnStateHealth`).
   *   In **live + `ownState.subscribe: true`** the §5.1 posting gate then halts NEW
   *   posting and emits `stream-health-hold` (top-of-`reconcileMarkets` early-out +
   *   the authoritative `submitQuote` re-check). In **dry-run / poll-only** the gate
   *   is inert, so this stays telemetry-only and never alters canonical trading
   *   state (never sets `fundingHold` / runs `fundingCancelSweep`).
   *
   * Event dispatch (Phase 3 PR3b — the source flip): each queued event is routed
   * by `kind` to the appropriate owner reducer, which now writes **canonical
   * `MakerState`** via the PR3a mappers; the returned descriptors flow through
   * `applyDescriptors(_, 'owner')`. A mapper throw (`OwnerMappingError`) emits
   * `owner-mapping-failed` + skips the row; an unknown event kind emits an error
   * and skips; either freezes cursor promotion past the skipped event.
   *
   * **Gated on `ownStateSession.ready`**: deltas apply to canonical state ONLY
   * after `onReady` has established the baseline — a delta applied to an
   * unestablished book would corrupt it. Pre-ready deltas stay queued (the SDK
   * buffers too; `resetOwnStateForRebaseline` clears the queue on resync; the
   * enqueue-time overflow latch bounds growth). In backout (`subscribe:false`)
   * `ready` never flips, so this is a no-op.
   */
  private drainOwnState(): void {
    if (!this.ownStateSession.ready) return;
    const drained = this.ownStateQueue.drain();
    // Belt-and-braces — overflow is normally already latched at ENQUEUE time
    // (`enqueueOwnStateAndReact` → `noteOwnStateOverflow`), so the §5.1 posting
    // gate sees a dropped event before the next reconcile rather than only at
    // this post-tick drain (Hermes #73 — the same-tick overflow/posting race).
    // `noteOwnStateOverflow` is idempotent within an overflow window, so this
    // catches any drain-observed overflow without double-emitting.
    if (drained.overflowed) this.noteOwnStateOverflow();
    // Phase 2 PR4b — dispatch by event.kind and apply owner-side reducers.
    // The reducer module's type system pins the body type per `kind`; the cast
    // here is the runtime narrowing point (the queue carries `body: unknown`
    // so PR3 could exercise the descriptor pipeline before SDK types were wired).
    // Reducer calls are wrapped in try/catch so a single malformed event from
    // an SDK bug or a synthetic test fixture logs + skips rather than crashing
    // the loop — defensive at a per-event level (the queue itself is bounded
    // by `OWN_STATE_QUEUE_MAX`).
    const now = this.deps.now();
    // §4.3 delta cursor track (Phase 3 PR1): promote `state.ownStateCursor` to a
    // delta's `meta.cursor` ONLY after that delta's reducer + descriptors apply
    // cleanly, and ONLY for the contiguous-success PREFIX of this drain batch.
    // `promotionStopped` latches on the FIRST failure/skip so a later success
    // can't leapfrog a failed/skipped event (which would persist a cursor past
    // an effect we never applied). This MM-side freeze is the SOLE cursor guard
    // for deferred reducer throws: the SDK already returned success when the
    // handler enqueued the event, so it advanced its own running cursor and will
    // NOT abort the connection for a throw that happens later, here, in the
    // drain ([[feedback_dont_promote_partial_resume_cursor]] + the FM3 two-layer
    // model). We promote the event's carried cursor, never the SDK's.
    let promotionStopped = false;
    for (const event of drained.events) {
      // Reducer dispatch AND descriptor application share ONE try/catch so the
      // cursor-promotion gate has a SINGLE freeze site: promotion happens iff
      // BOTH the reducer and `applyDescriptors` succeed, and any throw/skip
      // freezes the rest of the batch identically ([[feedback_enforce_invariant_every_site]]).
      // A malformed event from an SDK bug / synthetic fixture logs + skips
      // rather than crashing the loop (defensive; the queue is bounded by
      // OWN_STATE_QUEUE_MAX). `applyDescriptors` is pure IO and won't realistically
      // throw, but is inside the try so promotion can't outrun a descriptor failure.
      try {
        let descriptors: ReducerDescriptor[];
        switch (event.kind) {
          case 'commitment':
            descriptors = reduceOwnerCommitmentObservation(this.state, event.body as OwnerCommitment);
            break;
          case 'fill':
            // The reducer needs our address for the maker/taker disambiguation.
            // When subscribe is true, makerAddress is non-null (boot refuses
            // otherwise); the empty-string fallback is defensive against a
            // misconfigured drain path with no subscription.
            descriptors = reduceOwnerFill(this.state, event.body as Fill, this.ownStateDedupSet, this.makerAddress ?? '', now);
            break;
          case 'positionStatus':
            descriptors = reduceOwnerPositionStatus(this.state, event.body as PositionStatusEvent);
            break;
          default:
            this.eventLog.emit('error', {
              class: 'UnknownOwnStateEventKind',
              detail: `drainOwnState received unrecognized event.kind=${JSON.stringify(event.kind)} — skipping`,
              phase: 'own-state-stream',
            });
            // An unrecognized event is NOT applied — freeze cursor promotion so
            // we never advance past an effect we skipped.
            promotionStopped = true;
            continue;
        }
        const applied = this.applyDescriptors(descriptors, 'owner');
        // §7.2: an unknown-own-fill skipped the orphan (no state mutation) and
        // requested a cursor-less cold restart — freeze promotion so the cursor
        // never advances past a fill we didn't apply ([[feedback_dont_promote_partial_resume_cursor]]).
        if (applied.unknownOwnFill) promotionStopped = true;
      } catch (err) {
        // The PR3a mappers fail closed (`OwnerMappingError`) on a payload missing
        // metadata a Maker*Record requires — emit the dedicated kind + skip the
        // row (never a partial record); other throws are defensive.
        this.emitOwnStateMappingFailure(err, `event.kind=${event.kind}`);
        promotionStopped = true;
        continue;
      }
      // Success — promote the event's carried cursor (a no-op for the empty-
      // string sentinel) unless the batch already froze on an earlier failure.
      if (!promotionStopped && event.cursor) {
        this.state.ownStateCursor = event.cursor;
      }
    }
  }

  /**
   * The event loop: `{ kill-check → tick → stop-check → sleep }` until killed or
   * `maxTicks` is reached. On shutdown (kill-switch file or SIGTERM/SIGINT) the
   * live runner first sweeps every visible quote off chain via
   * `offchainKillCancel` (gasless soft stop; always runs), then — if
   * `killCancelOnChain: true` — calls `onchainKillCancel` to authoritatively
   * cancel every non-terminal commitment on chain (gas-gated with
   * `mayUseReserve: true`). Finally emits a `kill` event and does a final
   * state flush (unless a boot-time state-loss hold is still active — see
   * `tick()`). Dry-run skips both sweeps; a clean `maxTicks` exit (no
   * `shutdownReason`) skips them too — there's no operator intent to "kill"
   * latent exposure on a bounded run. Single-use — call once. The kill *file*
   * is checked at the top of each iteration, so it's acted on within one poll
   * interval; a *signal* aborts the in-flight sleep, so it's acted on after
   * the current tick.
   */
  async run(): Promise<void> {
    const unregister = this.deps.registerShutdownSignals(() => this.requestShutdown('signal'));
    let ticks = 0;
    let bootApprovalsApplied = false;
    try {
      // Phase 2 PR4a — open the owner-authenticated own-state SSE stream BEFORE
      // the first tick when opted in. The SDK's `subscribe` returns synchronously
      // so the handle is captured (and identity-checked by every handler) before
      // any callback can fire. Subscription stays open across ticks; the `finally`
      // below unsubscribes on every shutdown path. INSIDE the `try` so a
      // synchronous throw from the SDK (auth misconfiguration, network init
      // failure) still runs `unregister()` + cleanup (Hermes #68 review blocker 3).
      if (this.config.ownState.subscribe && this.makerAddress !== null) {
        this.openOwnStateSubscription();
      }
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
        this.drainOwnState(); // own-state-sse-plan §"Drain placement" — pre-tick drain
        await this.tick(ticks);
        this.drainOwnState(); // §"Drain placement" — post-tick drain catches events that arrived during tick IO
        // §4.2 (Phase 3 PR1) — belt-and-braces cold-restart hook for a guard
        // that tripped during tick IO (before the loop returned to the wait).
        await this.performOwnStateColdRestart();
        // PR5 — comparator pass. Records that this tick completed (lastPollObsAtMs),
        // latches firstAuditPollAfterReady when applicable, and runs the comparator
        // when preconditions hold. Read-only on canonical state (never writes
        // `MakerState`); besides emitting `divergence` it sets the posting-only latch 5
        // (`auditDivergenceUnresolved`, PR2c-ii) that gates NEW posting in live+subscribe.
        this.runAuditComparator();
        if (this.stopRequested) break;
        if (this.maxTicks !== undefined && ticks >= this.maxTicks) break;
        // Phase 2 PR3 — wakeable wait. A wake interrupts the sleep but does NOT
        // advance the poll deadline (cadence-preserving): after a wake we
        // debounce, drain the shadow queue, and loop back to wait for the
        // SAME deadline. Only a poll-deadline outcome exits the wait loop and
        // triggers the next tick (own-state-sse-plan §2.5.1).
        await this.waitForNextPollDeadline();
      }
    } finally {
      unregister();
      // Phase 2 PR4a — close the own-state SSE subscription on EVERY exit path
      // (kill, signal, maxTicks, exception). Per the SDK contract `await
      // unsubscribe()` guarantees no handler fires after it returns; combined
      // with the runner's identity-guarded handlers this means a re-subscribe
      // after this point starts from a clean slate.
      await this.closeOwnStateSubscription();
      // Shutdown sweep — on EVERY actual operator-triggered shutdown
      // (`shutdownReason !== null`, live mode), pull every visible quote off
      // chain (gasless `cancelCommitmentOffchain`). This is the soft-stop
      // default: visible quotes leave the book immediately, the latent
      // (matchable-via-stale-signed-payload) window stays open until natural
      // expiry — or until the on-chain authoritative-cancel sweep below
      // closes it for good when `killCancelOnChain: true` (DESIGN §6 kill
      // switch; Hermes review-PR29). Maxticks exits and dry-run skip.
      if (this.shutdownReason !== null && !this.config.mode.dryRun) {
        // M6/A pre-pass (Hermes #63): when `killCancelOnChain` is set, missing-legacy +
        // visibleOpen records need an on-chain { hash } cancel BEFORE the off-chain
        // sweep — once the off-chain DELETE flips them book-hidden, the SDK's
        // public-fetch path refuses (M2 redaction) and they brick into BLOCKED.
        // `preOnchainKillCancelMissingLegacyVisible` returns the touched hashes
        // (success OR failure); `offchainKillCancel` skips them so a failed
        // pre-pass record stays visibleOpen for the regular `onchainKillCancel`
        // pass to retry via dispatch.
        const touchedByPrePass = this.config.killCancelOnChain
          ? await this.preOnchainKillCancelMissingLegacyVisible()
          : new Set<string>();
        await this.offchainKillCancel(touchedByPrePass);
        if (this.config.killCancelOnChain) {
          await this.onchainKillCancel();
        }
      }
      if (this.shutdownReason !== null) this.eventLog.emit('kill', { reason: this.shutdownReason, ticks });
      // Each non-held tick already flushes; this final flush only matters when a
      // shutdown fires before the first such tick. Skipped while a state-loss hold is
      // active — same reason as in `tick()` (DESIGN §12).
      if (!this.isHoldingQuoting()) this.stateStore.flush(this.state);
    }
  }

  /**
   * One iteration: discovery → reference-odds refresh → fill detection (live) →
   * position-status poll (live) → soft-cancelled-fill convergence (live) → per-market
   * reconcile → age-out → terminal-record prune → flush. Fill detection +
   * soft-cancelled-fill convergence run *before* the reconcile so a fill within this
   * tick dirties the market and the same reconcile re-prices the now-imbalanced book.
   *
   * **Fail-closed on lost fill visibility (live mode).** Four gates, same outcome
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
   *   4. `reconcileSoftCancelledFills`'s per-hash `getCommitment` lookup threw
   *      for a `softCancelled` record (a network error, or a 404 for a still-
   *      matchable signed payload). That record's stale payload could have just
   *      matched on chain; reading the throw as "unfilled" and letting `ageOut`
   *      terminalize it would lose the fill. The record stays `softCancelled`
   *      and the tick fails closed (gate 3's outer block must already have been
   *      entered — this step only runs when the position poll didn't trip its gate).
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
          // Soft-cancelled-fill convergence (live only) — runs after detectFills + the
          // position poll, before settle/reconcile/ageOut. It probes each softCancelled
          // record's authoritative cumulative fill via `getCommitment` and converges the
          // commitment record (NOT the position — that's the poll's job). A probe failure
          // fails closed the same way a lost position poll does: skip settle + reconcile +
          // ageOut so a record that may have just matched isn't terminalized on local time.
          let softCancelledFillOk = true;
          if (!this.config.mode.dryRun) softCancelledFillOk = await this.reconcileSoftCancelledFills();
          if (softCancelledFillOk) {
            if (!this.config.mode.dryRun) await this.settleAndClaim();
            if (!this.config.mode.dryRun) await this.checkFunding(); // funding guard (C1a) — sets fundingHold before the posting decision below
            if (!this.config.mode.dryRun && this.fundingHold) await this.fundingCancelSweep(); // funding guard (C1b) — actively pull/cancel existing quotes while underfunded, per underfundedCancelMode (reconcileMarkets below is gated by fundingHold anyway)
            if (this.config.ownState.subscribe) await this.checkIndexerLag(); // §5 latch 6 (PR2c-i) — poll own-state health, set indexerLagDegraded BEFORE reconcileMarkets' §5.1 posting gate reads it (subscribe-gated, not dryRun: runs for observability in dry-run+subscribe, gate dormant there)
            await this.reconcileMarkets();
            await this.maybeOnchainCancelRecoveredSoftCancels(); // cancelMode:onchain only — authoritatively cancel matched soft-cancels (self-guards offchain/dry-run); after reconcileMarkets so the freed side re-quotes next tick
            this.ageOut();
          }
          // else: live mode + a softCancelled-fill probe (`getCommitment`) failed — skip settleAndClaim + reconcile + ageOut (fail-closed; the record stays softCancelled, markets stay dirty for next-tick retry).
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

  /** Reclassify any tracked commitment past its `expiryUnixSec` + the release grace to `expired` (dead on chain even allowing for host/chain clock skew — headroom released; see {@link isExpiredForRelease}, DESIGN §6/§9). Emits an `expire` per reclassification. */
  private ageOut(): void {
    const now = this.deps.now();
    const grace = this.config.orders.expiryReleaseGraceSeconds;
    for (const record of Object.values(this.state.commitments)) {
      if ((record.lifecycle === 'visibleOpen' || record.lifecycle === 'softCancelled' || record.lifecycle === 'partiallyFilled') && isExpiredForRelease(record.expiryUnixSec, now, grace)) {
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
   *   core-api SSE odds stream for each tracked market that doesn't have a live
   *   one (a newcomer, or one whose channel errored), up to `odds.maxRealtimeChannels`
   *   (markets over the cap stay tracked but degraded — no odds — and are retried
   *   when a slot frees); the channel's `onChange` / `onRefresh` / `onError`
   *   handlers keep the market's odds + freshness + dirty flag current between
   *   cycles. The discovery interval is the (re)subscription throttle, so this is a
   *   no-op on non-discovery ticks.
   * - `odds.subscribe: false` — no streaming; snapshot every tracked market every
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

  /** Subscription mode (`odds.subscribe: true`): (re)subscribe an SSE odds stream for each tracked market lacking a live one, soonest games first, up to `odds.maxRealtimeChannels`; the rest get a `degraded` `channel-cap` event (retried when a slot frees). */
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

  /** Seed a market's reference odds from a one-shot snapshot (DESIGN §10 — "snapshot-first"). A failure is logged (inside `snapshotOdds`) and ignored: the SSE odds stream will deliver odds on its first `onChange`. */
  private async seedOdds(m: TrackedMarket): Promise<void> {
    const snap = await this.snapshotOdds(m, 'odds-seed');
    if (snap !== null) this.recordOdds(m, snap.odds.moneyline, { markDirty: true });
  }

  /** One-shot reference-odds snapshot for a market; logs an `error` (with the given `phase`) and returns `null` on failure. */
  private async snapshotOdds(m: TrackedMarket, phase: 'odds-seed' | 'odds-poll'): Promise<ContestOddsSnapshot | null> {
    try {
      return await this.adapter.getOddsSnapshot(m.contestId);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase, contestId: m.contestId });
      return null;
    }
  }

  /**
   * Open the core-api SSE odds stream for a market's reference moneyline odds and
   * install it on the market (`m.subscription`), wiring all five handlers:
   * `onSnapshot` (the baseline on connect / after a degraded recovery → store +
   * mark dirty), `onChange` (a price move → store, bump freshness, mark dirty),
   * `onRefresh` (a no-change re-poll → store, bump freshness), `onStatus` (surface
   * `reconnecting` / `degraded` as `degraded` telemetry), and `onError`. Returns
   * `true` if subscribed, `false` if the initial `subscribeOdds` call rejected (a
   * `degraded` `subscribe-failed` event is emitted and the next discovery cycle
   * retries).
   *
   * The 0.3.0 SSE transport self-reconnects with full-jitter backoff, so `onError`
   * is `reason`-aware: only a `fatal` error means the subscription has actually
   * ended (clear it, emit `degraded`, tear the dead channel down, re-subscribe next
   * cycle); a retryable `connection_failed` / `capacity_exceeded` keeps the channel
   * (the transport is still reconnecting) and is surfaced as an `error` breadcrumb —
   * the stale-reference gate pulls quotes if the outage outlasts
   * `staleReferenceAfterSeconds`. Every handler first checks it is still *its*
   * channel (`m.subscription === thisSub`), so a delivery from a channel already
   * replaced by a later cycle's re-subscribe can't clobber the new one.
   */
  private async subscribeMarketOdds(m: TrackedMarket): Promise<boolean> {
    let thisSub: Subscription | null = null;
    const handlers: OddsSubscribeHandlers<MoneylineOdds> = {
      onSnapshot: (odds) => {
        if (thisSub === null || m.subscription !== thisSub) return; // a delivery from an already-replaced channel
        this.recordOdds(m, odds, { markDirty: true });
      },
      onChange: (odds) => {
        if (thisSub === null || m.subscription !== thisSub) return;
        this.recordOdds(m, odds, { markDirty: true });
      },
      onRefresh: (odds) => {
        if (thisSub === null || m.subscription !== thisSub) return;
        this.recordOdds(m, odds, { markDirty: false });
      },
      onStatus: (status) => {
        if (thisSub === null || m.subscription !== thisSub) return;
        if (status === 'reconnecting') this.emitDegraded(m, 'stream-reconnecting');
        else if (status === 'degraded') this.emitDegraded(m, 'stream-degraded');
        // 'connected' → live (initial connect or a recovery); no degraded signal.
      },
      onError: (err) => {
        if (thisSub === null || m.subscription !== thisSub) return; // a stale error from an already-replaced channel
        if (err.reason === 'fatal') {
          // The subscription has ended (e.g. unknown contest/market). Tear it down
          // and let the next discovery cycle re-subscribe.
          m.subscription = null;
          this.emitDegraded(m, 'channel-error', err.message);
          void this.dropChannel(thisSub, m.contestId);
          return;
        }
        // connection_failed / capacity_exceeded: the transport keeps reconnecting —
        // keep the channel; onStatus reports the resulting state and the
        // stale-reference gate handles a prolonged outage.
        this.eventLog.emit('error', { class: `stream-${err.reason}`, detail: err.message, phase: 'odds-stream', contestId: m.contestId });
      },
    };
    try {
      const sub = await this.adapter.subscribeOdds({ contestId: m.contestId, market: 'moneyline' }, handlers);
      thisSub = sub;
      m.subscription = sub; // installed synchronously after the await resolves — no gap for a handler to race with
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

  /** Best-effort teardown of an SSE odds stream — a failure is logged but not fatal (the server reaps idle streams). */
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
   * quotes.
   *
   * **Retry / cadence invariant (the single source of truth for "when does a market
   * reconcile again" — keep all four parts consistent, they're a state machine):**
   *   1. **transient failure** (a `getSpeculation` read threw, or a live
   *      submit / replace / off-chain-cancel / routine on-chain partial-cancel threw)
   *      ⇒ `reconcileMarket` returns `'transient-failure'` ⇒ **always force `dirty`**
   *      (retry next tick) and leave `lastReconciledAt` — never defer a failed live
   *      write behind the `staleAfterSeconds` cadence. This is unconditional: it must
   *      not depend on how the market entered reconcile or on `needsReconcile`'s gates
   *      (those have proven fragile — a pulled `visibleOpen` can stop re-arming the
   *      eager gate; a recent `lastReconciledAt` can throttle the cadence).
   *   2. **gas-budget denial** (a policy decision, not a failure) ⇒ `'applied'` ⇒
   *      re-evaluate on the normal `lastReconciledAt` cadence, NOT every tick (no spam).
   *   3. **on-chain cancel success** ⇒ `'applied'`, but `maybeOnchainCancelRetainedPartials`
   *      sets `dirty` so the freed side re-quotes next tick (the read-and-clear below
   *      happens *before* the reconcile, so that in-reconcile `dirty` survives).
   *   4. the unquoteable eager gate (`needsReconcile`) counts `visibleOpen` only, never
   *      `partiallyFilled` — a retained partial relies on (1)/(2)/(3) or natural expiry.
   */
  private async reconcileMarkets(): Promise<void> {
    const now = this.deps.now();
    // §5.1 own-state-health posting gate (Phase 3 PR2) — the cheap EARLY-OUT.
    // Evaluated at the TOP of every reconcile pass (above the funding / boot
    // early-returns) so its enter/clear telemetry edge stays accurate even when one
    // of those holds would return first, and so a tick that's already unhealthy at
    // its start skips pricing/planning entirely. This is NOT the safety boundary:
    // own-state health can degrade DURING the per-market awaited work below (an SSE
    // overflow mid-`getSpeculation`), so the AUTHORITATIVE gate is re-checked
    // synchronously right before the only new-exposure write in `submitQuote`
    // (Hermes #73 r2). (Also not evaluated on a tick that fails closed upstream on
    // lost fill-visibility and never reaches reconcileMarkets; the latch is
    // eventually consistent.) Inert in dry-run / poll-only; dormant until PR3b.
    const streamHealthHold = this.updateStreamHealthHold(now);
    if (this.isHoldingQuoting()) return; // DESIGN §12 — must not resume quoting on a blank slate
    if (this.fundingHold) return; // DESIGN §6 funding guard (C1a) — wallet can't back its matchable-commitment exposure; halt NEW posting until a successful funding re-read clears it
    if (streamHealthHold) return; // own-state SSE §5.1 early-out — degraded at pass start; submitQuote re-checks for mid-pass degradation (active cancel-sweep posture lands in PR3b)
    for (const m of this.trackedMarkets.values()) {
      if (!this.needsReconcile(m, now)) continue;
      m.dirty = false; // read-and-clear BEFORE reconciling, so a dirty re-armed DURING the reconcile (a success re-quote, a concurrent onChange) survives to the next tick instead of being clobbered
      const outcome = await this.reconcileMarket(m, now);
      if (outcome === 'applied') {
        m.lastReconciledAt = now;
      } else {
        m.dirty = true; // invariant (1): a transient failure ALWAYS retries next tick — unconditional, independent of entry path / gates / lastReconciledAt. `lastReconciledAt` left unchanged (no decision applied).
      }
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
    // Force an eager pull only for `visibleOpen` quotes — the ones the gate can actually remove off-chain.
    // A `partiallyFilled` remainder can't be off-chain-cancelled, so it must NOT force a reconcile every tick:
    // that would re-fire the unquoteable gate and spam (e.g. re-emit `gas-budget-blocks-onchain-cancel` under
    // cancelMode:onchain after a gas denial). A retained partial is instead handled by the transient-failure
    // re-arm (an adapter throw sets the market dirty) or the normal `lastReconciledAt` cadence / natural expiry.
    if (this.marketUnquoteable(m, now) && this.hasVisibleOpenQuotesOn(m.speculationId, now)) return true;
    if (!this.lacksFreshTwoSidedQuote(m, now)) return false;
    return m.lastReconciledAt === null || now - m.lastReconciledAt >= this.config.orders.staleAfterSeconds;
  }

  /**
   * Is this market currently unquoteable on grounds the runner can see without an SDK
   * round-trip — its game is imminent (starts within one `expirySeconds` window); we
   * have no usable reference moneyline odds (none seen yet, the latest response had no
   * moneyline row, or a side isn't priced); the feed has stopped responding
   * (`now - lastOddsAt > staleReferenceAfterSeconds` — a `getOddsSnapshot` failure or
   * no `onChange` / `onRefresh` in a while); or (in subscription mode) its SSE
   * odds stream has errored / never came up? When such a market still has a *pullable*
   * `visibleOpen` quote of ours, it must be pulled off the book (DESIGN §2.2: never
   * quote on missing / ambiguous / stale data; never leave a stale quote visible) —
   * `needsReconcile` therefore forces a reconcile for it, and `reconcileMarket`'s
   * matching gate does the pull. A `partiallyFilled` remainder can't be
   * off-chain-cancelled, so it does NOT force this eager reconcile (see
   * `hasVisibleOpenQuotesOn`). (The speculation-closed case isn't here — it needs the
   * `getSpeculation` read to detect, so it's handled inside `reconcileMarket` after that read.)
   */
  private marketUnquoteable(m: TrackedMarket, now: number): boolean {
    if (m.matchTimeSec - now <= this.config.orders.expirySeconds) return true; // the game starts within one expiry window
    const ml = m.lastMoneylineOdds;
    if (ml === null || ml.awayOddsAmerican === null || ml.homeOddsAmerican === null) return true; // no usable reference moneyline odds — none seen yet, the latest response had no moneyline row, or a side isn't priced
    if (m.lastOddsAt !== null && now - m.lastOddsAt > this.config.orders.staleReferenceAfterSeconds) return true; // the feed has stopped responding
    if (this.config.odds.subscribe && m.subscription === null) return true; // the SSE odds stream errored / never came up (re-subscribed on the next discovery cycle; in polling mode pollTrackedOdds re-snapshots every tick, so there's no "degraded" notion)
    return false;
  }

  /**
   * Does the maker have a non-expired `visibleOpen` commitment of its own on `speculationId` right now?
   * Used by the unquoteable-market gate in `needsReconcile` to force a reconcile that PULLS such quotes
   * off the book. **Deliberately excludes `partiallyFilled`**: a matched remainder can't be
   * off-chain-cancelled, so it must not force an eager every-tick reconcile — that would re-fire the
   * unquoteable gate and spam (e.g. re-emit `gas-budget-blocks-onchain-cancel` under `cancelMode: onchain`
   * once gas is exhausted). Retained partials are handled by the transient-failure re-arm (an adapter
   * throw marks the market dirty) or the normal `lastReconciledAt` cadence / natural expiry instead.
   */
  private hasVisibleOpenQuotesOn(speculationId: string, now: number): boolean {
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== speculationId) continue;
      if (r.lifecycle !== 'visibleOpen') continue;
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
      const outcome = await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'start-too-soon' });
      return outcome;
    }
    // Gate: the reference odds have gone stale (the upstream feed stopped advancing). A never-seen-odds market (`lastOddsAt === null`) falls through to the `no-reference-odds` gate below — `lastOddsAt === null` iff `lastMoneylineOdds === null` (`recordOdds` sets both or neither).
    if (m.lastOddsAt !== null && now - m.lastOddsAt > this.config.orders.staleReferenceAfterSeconds) {
      const outcome = await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'stale-reference' });
      return outcome;
    }
    // Gate: no usable reference moneyline odds (both sides must be priced — `buildDesiredQuote` itself refuses out-of-range *values*, but it can't be handed a `null`).
    const ml = m.lastMoneylineOdds;
    if (ml === null || ml.awayOddsAmerican === null || ml.homeOddsAmerican === null) {
      const outcome = await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'no-reference-odds' });
      return outcome;
    }
    // Gate: the SSE odds stream is down (subscription mode) — the reference is no longer being kept fresh, so treat it as unsafe and pull. (`syncOddsSubscriptions` re-subscribes on the next discovery cycle; the existing `degraded` event already carries the precise cause.)
    if (this.config.odds.subscribe && m.subscription === null) {
      const outcome = await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'stale-reference' });
      return outcome;
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
      const outcome = await this.pullVisibleQuotes(m, now);
      this.eventLog.emit('candidate', { contestId: m.contestId, skipReason: 'no-open-speculation' });
      return outcome;
    }
    // Price → plan → apply.
    const market: Market = { contestId: m.contestId, sport: m.sport, awayTeam: m.awayTeam, homeTeam: m.homeTeam };
    const inventory = inventoryFromState(this.state, now, this.config.orders.expiryReleaseGraceSeconds);
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
    // ── risk-verdict (Phase 3 h) ─────────────────────────────────────────
    // The risk engine's per-market decision, with the per-cap headroom math
    // that produced it (DESIGN §11). Distinct from `quote-intent` (the
    // protocol-level intent — taker tick, maker tick, position type, …): this
    // event focuses on the exposure-side reasoning that operators ask "why
    // didn't the MM post here?" about. Emitted only when the engine actually
    // runs — i.e. after the pre-engine gates (no-reference-odds /
    // start-too-soon / stale-reference / no-open-speculation) have passed.
    // For each side (`away` / `home` as the *taker offer* — the side a taker
    // would back), `allowed` mirrors `desired.result.{away,home} !== null`;
    // `sizeUSDC` is the engine-bound size when allowed (zero when refused);
    // `headroomUSDC` is the maximum additional risk the per-cap math allowed
    // on that side before the pricing layer ran. `notes` carries the
    // refusal reasons (engine-level + pricing-level) when `allowed: false`.
    this.eventLog.emit('risk-verdict', {
      contestId: m.contestId,
      speculationId: m.speculationId,
      sport: m.sport,
      awayTeam: m.awayTeam,
      homeTeam: m.homeTeam,
      allowed: desired.result.canQuote,
      awayOffer: {
        allowed: desired.result.away !== null,
        sizeUSDC: desired.result.away?.sizeUSDC ?? 0,
        headroomUSDC: desired.headroomUSDC.away,
      },
      homeOffer: {
        allowed: desired.result.home !== null,
        sizeUSDC: desired.result.home?.sizeUSDC ?? 0,
        headroomUSDC: desired.headroomUSDC.home,
      },
      notes: desired.result.notes,
    });
    const recordsOnSpec = Object.values(this.state.commitments).filter((r) => r.speculationId === m.speculationId);
    const plan = reconcileBook(recordsOnSpec, desired, this.config, now, inventory.openCommitmentCount);
    const outcome = await this.applyReconcilePlan(m, plan, now);
    this.assessCompetitiveness(m, spec, desired);
    return outcome; // `'transient-failure'` if a live write failed mid-plan — `reconcileMarkets` then leaves `dirty` / `lastReconciledAt` so the market re-reconciles next tick
  }

  /** Pull (off-chain) every API-visible `visibleOpen` commitment of the maker's on `m.speculationId` — in live mode an actual `cancelCommitmentOffchain` per record (a failed one stays `visibleOpen` for the next pass), in dry-run a state-only simulation — then reclassify the pulled ones `softCancelled` and emit `would-soft-cancel` / `soft-cancel` (reason `side-not-quoted`: when a market is unquoteable, neither side is being quoted). A `partiallyFilled` remainder is NOT pulled — the API rejects an off-chain DELETE once a commitment has matched (409 `COMMITMENT_MATCHED`); it's retained (a `partial-remainder-retained` candidate is emitted) and rides to expiry / authoritative on-chain cancel. Used by the unquoteable-market gates above — the visible book must never carry a quote the MM is no longer pricing (DESIGN §2.2 / §3). A pulled / retained quote's signed payload stays matchable on chain until expiry, so the risk engine keeps counting it. Returns `'transient-failure'` if a live off-chain pull threw or a `cancelMode: onchain` authoritative cancel threw — the gate propagates it so the market stays dirty / un-throttled and retries next tick; `'applied'` otherwise. */
  private async pullVisibleQuotes(m: TrackedMarket, now: number): Promise<'applied' | 'transient-failure'> {
    const retained: RetainedPartial[] = [];
    let outcome: 'applied' | 'transient-failure' = 'applied';
    for (const r of Object.values(this.state.commitments)) {
      if (r.speculationId !== m.speculationId) continue;
      if (r.expiryUnixSec <= now) continue; // already dead on chain — `ageOut` handles it
      if (r.lifecycle === 'visibleOpen') {
        if (!(await this.softCancelRecord(r, 'side-not-quoted', now))) outcome = 'transient-failure'; // live off-chain cancel threw — re-arm so the pull retries next tick
      } else if (r.lifecycle === 'partiallyFilled') {
        this.emitPartialRetained(r, 'side-not-quoted'); // can't off-chain-cancel a matched commitment — retain the remainder
        retained.push({ record: r, reason: 'side-not-quoted' });
      }
    }
    if ((await this.maybeOnchainCancelRetainedPartials(retained, now)) === 'transient-failure') outcome = 'transient-failure'; // cancelMode:onchain authoritative cancel threw — re-arm for next-tick retry (gasless modes leave the remainder to ride to expiry)
    return outcome;
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
   *
   * **Off-chain cancel is only valid for `visibleOpen`.** The API returns 409
   * `COMMITMENT_MATCHED` for a `partiallyFilled` (or `filled`) commitment — once a
   * match exists the off-chain DELETE is rejected; only an authoritative on-chain
   * `cancelCommitment` can kill the remaining fillability. The reconciler never routes
   * a partial here (`reconcileBook` retains them), but this guards the call site so a
   * future path can't silently re-introduce the reject-loop bug: a non-`visibleOpen`
   * record skips the API call, keeps its lifecycle, and returns `true` (handled — no
   * `transient-failure` retry on a permanent rejection).
   */
  private async softCancelRecord(record: MakerCommitmentRecord, reason: SoftCancelReason, now: number): Promise<boolean> {
    if (record.lifecycle !== 'visibleOpen') {
      this.eventLog.emit('error', {
        class: 'NonVisibleOpenSoftCancel',
        detail: `refusing off-chain cancel of a ${record.lifecycle} commitment — the API rejects a DELETE once a commitment has matched (409 COMMITMENT_MATCHED)`,
        phase: 'cancel',
        contestId: record.contestId,
        commitmentHash: record.hash,
      });
      return true; // deliberately not pulled; report handled so the caller doesn't loop on a permanent rejection
    }
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
   * Emit a `candidate` `partial-remainder-retained` for a `partiallyFilled` remainder the runner
   * left in place — never off-chain-cancelled (the API rejects a DELETE once matched) and never
   * reposted over (a same-side quote on top would double the side's matchable exposure). Positive
   * telemetry so an operator / the summary walker sees the side is occupied by a matchable
   * remainder riding to expiry (or, under `cancelMode: onchain`, awaiting authoritative cancel).
   * `reason` is why it would have been actioned were it a `visibleOpen`.
   */
  private emitPartialRetained(record: MakerCommitmentRecord, reason: RetainedPartialReason | 'shutdown'): void {
    this.eventLog.emit('candidate', {
      skipReason: 'partial-remainder-retained',
      commitmentHash: record.hash,
      contestId: record.contestId,
      speculationId: record.speculationId,
      makerSide: record.makerSide,
      takerSide: oppositeSide(record.makerSide),
      reason,
    });
  }

  /**
   * Under `orders.cancelMode: onchain`, authoritatively cancel retained partial
   * remainders on chain — the opt-in path for freeing a side a `partiallyFilled`
   * remainder occupies (DESIGN §9), instead of waiting out its expiry. For each
   * retained partial: gas-gate via `canSpendGas` with **`mayUseReserve: false`** —
   * a routine quote refresh must NOT burn the emergency reserve (unlike the
   * shutdown kill / settlement paths) — then `cancelCommitmentOnchain` (the
   * authoritative `MatchingModule.cancelCommitment`). On success: stamp the record
   * `authoritativelyInvalidated`, emit `onchain-cancel`, and mark the market dirty
   * so the now-free side re-quotes on the **next** tick — never same-tick, because
   * `reconcileBook` already declined to submit over the (then-live) partial, so the
   * cancel→re-quote ordering footgun can't arise.
   *
   * **Outcome (so the caller can re-arm the market):** returns `'transient-failure'`
   * iff a `cancelCommitmentOnchain` call **threw** (an adapter / RPC failure) —
   * `applyReconcilePlan` / `pullVisibleQuotes` propagate that up so `reconcileMarkets`
   * leaves the market dirty / un-throttled and the cancel retries on the **next** tick
   * (the runner's live-write fail-closed rule), rather than waiting out
   * `orders.staleAfterSeconds`. A **gas-budget denial** is NOT a transient failure: it
   * emits `candidate` `gas-budget-blocks-onchain-cancel`, leaves the partial retained
   * (no off-chain DELETE fallback — the API would reject it — and no repost over it),
   * and stays `'applied'` — the operator must free gas budget, so a per-tick retry
   * would just spam; the standing `lacksFreshTwoSidedQuote` path re-evaluates it on the
   * normal cadence. No-op (`'applied'`) under `cancelMode: offchain` (the default) and
   * in dry-run (never writes to chain). The gas budget is re-checked per record (each
   * landed cancel grows today's spend), so a tight budget cancels what it can and
   * defers the rest.
   */
  private async maybeOnchainCancelRetainedPartials(retained: readonly RetainedPartial[], now: number): Promise<'applied' | 'transient-failure'> {
    if (this.config.orders.cancelMode !== 'onchain') return 'applied'; // default `offchain`: the remainder rides to expiry
    if (this.config.mode.dryRun || this.makerAddress === null) return 'applied'; // dry-run never writes to chain
    let outcome: 'applied' | 'transient-failure' = 'applied';
    for (const { record } of retained) {
      if (record.lifecycle !== 'partiallyFilled') continue; // defensive — only a matched (visible) remainder is cancelled here
      // A throw re-arms the market for a prompt next-tick retry (matches the live-write fail-closed
      // rule), not the staleAfterSeconds throttle. A gas denial is NOT transient (stays 'applied').
      if ((await this.onchainCancelCommitment(record, now)) === 'transient-failure') outcome = 'transient-failure';
    }
    return outcome;
  }

  /**
   * Under `orders.cancelMode: onchain`, authoritatively cancel **recovered soft-cancels** —
   * commitments the MM soft-cancelled off-chain that nonetheless matched on chain via their
   * stale signed payload (`lifecycle: 'softCancelled'` with `filledRiskWei6 > 0`, set by
   * {@link reconcileSoftCancelledFills}). Their unfilled remainder is still matchable, so this
   * stops further matching instead of letting it ride to expiry. The off-chain DELETE never
   * worked on these (a matched commitment returns `409 COMMITMENT_MATCHED`), so on-chain
   * `cancelCommitment` is the only lever — the soft-cancelled analogue of
   * {@link maybeOnchainCancelRetainedPartials} (which handles the *visible* `partiallyFilled`
   * remainders `reconcileBook` retains).
   *
   * Global scan (a soft-cancelled commitment's contest may no longer be tracked). Skips
   * **unmatched** soft-cancels (`filledRiskWei6 === 0` → rides to expiry; no point spending gas
   * on a quote that may never match — matches the gas economy of the routine staleness pulls)
   * and **past-expiry** ones (already unmatchable on chain — `ageOut` terminalizes them). Per
   * record, {@link onchainCancelCommitment} does the gas-gate + cancel + stamp
   * `authoritativelyInvalidated` + dirty the market. **Best-effort, no re-arm needed**: the
   * step scans every tick, so a throw / gas-denial simply leaves the record `softCancelled` for
   * the next tick to retry — but a gas denial surfaces its `gas-budget-blocks-onchain-cancel`
   * candidate only ONCE per stuck record (tracked in `gasDeniedRecoveredSoftCancelWarned`, pruned
   * to current eligibility each sweep), so a sustained budget shortfall doesn't spam the log even
   * though the cancel is re-attempted every tick. Runs AFTER `reconcileMarkets` so a dirtied
   * market re-quotes the freed side on the *next* tick — never same-tick over a just-cancelled
   * commitment. No-op under `cancelMode: offchain` (default) and in dry-run.
   */
  private async maybeOnchainCancelRecoveredSoftCancels(): Promise<void> {
    if (this.config.orders.cancelMode !== 'onchain') return; // default `offchain`: the remainder rides to expiry
    if (this.config.mode.dryRun || this.makerAddress === null) return; // dry-run never writes to chain
    const now = this.deps.now();
    // Eligible = matched soft-cancels (filledRiskWei6 > 0) not past expiry. Unmatched ones ride to
    // expiry (gas economy — no point cancelling a quote that may never match); past-expiry ones are
    // already unmatchable on chain (ageOut terminalizes them) so cancelling would just waste gas.
    const eligible = Object.values(this.state.commitments).filter(
      (r) => r.lifecycle === 'softCancelled' && BigInt(r.filledRiskWei6) > 0n && r.expiryUnixSec > now,
    );
    // Prune BOTH warned-sets to current eligibility so they can't grow unbounded (a record that was
    // gas-denied / missing-payload-blocked and then expired / was cancelled drops out — its hash
    // is removed here).
    const eligibleHashes = new Set(eligible.map((r) => r.hash));
    for (const h of this.gasDeniedRecoveredSoftCancelWarned) if (!eligibleHashes.has(h)) this.gasDeniedRecoveredSoftCancelWarned.delete(h);
    for (const h of this.missingPayloadCancelBlockedWarned) if (!eligibleHashes.has(h)) this.missingPayloadCancelBlockedWarned.delete(h);
    for (const record of eligible) {
      const emitGasDenied = !this.gasDeniedRecoveredSoftCancelWarned.has(record.hash); // surface the denial once per stuck record, not every tick
      const emitMissingPayload = !this.missingPayloadCancelBlockedWarned.has(record.hash); // same once-per-record discipline for the missing-payload block (own-state SSE plan §M6)
      const result = await this.onchainCancelCommitment(record, now, { emitGasDenied, emitMissingPayload }); // best-effort; a throw / gas-denial / missing-payload block leaves it softCancelled for the next-tick scan
      if (result === 'gas-denied') this.gasDeniedRecoveredSoftCancelWarned.add(record.hash);
      else this.gasDeniedRecoveredSoftCancelWarned.delete(record.hash); // cancelled / transient / blocked-missing-payload — clear so a later denial re-warns
      if (result === 'blocked-missing-payload') this.missingPayloadCancelBlockedWarned.add(record.hash);
      else this.missingPayloadCancelBlockedWarned.delete(record.hash); // any other outcome means the block doesn't apply (cancelled, denied, or transient) — clear so a future re-occurrence re-warns
    }
  }

  /**
   * Authoritatively cancel ONE commitment on chain — the shared per-record mechanics behind
   * both {@link maybeOnchainCancelRetainedPartials} (visible `partiallyFilled` remainders) and
   * {@link maybeOnchainCancelRecoveredSoftCancels} (matched soft-cancels). Gas-gated via
   * `canSpendGas` with **`mayUseReserve: false`** — a routine exposure-bounding cancel must not
   * burn the emergency reserve (unlike the shutdown kill / settlement paths). On success:
   * record today's gas, stamp the record `authoritativelyInvalidated`, emit `onchain-cancel`,
   * and dirty the market so the freed side re-quotes next tick. Returns `'cancelled'` (landed),
   * `'gas-denied'` (budget verdict refused — the record is left as-is; operator must free budget,
   * no off-chain fallback), or `'transient-failure'` (`cancelCommitmentOnchain` threw — record
   * left as-is for a next-tick retry). A `candidate` `gas-budget-blocks-onchain-cancel` is emitted
   * on denial unless `opts.emitGasDenied === false` (the recovered-soft-cancel sweep passes false
   * after the first warning to avoid per-tick spam — see {@link maybeOnchainCancelRecoveredSoftCancels}).
   * The caller owns lifecycle pre-filtering (which records are eligible) and any re-arm.
   */
  private async onchainCancelCommitment(record: MakerCommitmentRecord, now: number, opts: { emitGasDenied?: boolean; emitMissingPayload?: boolean; overrideDispatch?: CancelDispatch } = {}): Promise<'cancelled' | 'gas-denied' | 'transient-failure' | 'blocked-missing-payload'> {
    // Dispatch FIRST — before spending the gas-budget check on a record we
    // can't authoritatively cancel anyway. `blocked-missing-payload` is
    // operator-action-required (own-state SSE plan §M6); no point exercising
    // any of the downstream paths.
    //
    // `opts.overrideDispatch` lets the pre-pass for missing-legacy + visibleOpen
    // records (Hermes #63 — fixing the off-chain-mutation-then-on-chain-block
    // bug) inject `{ kind: 'use-hash' }` directly without re-computing
    // `dispatchCancel`. The pre-pass runs BEFORE the off-chain leg's lifecycle
    // mutation, so the record is genuinely still visibleOpen and the SDK's
    // public-fetch path resolves cleanly.
    const dispatch = opts.overrideDispatch ?? dispatchCancel(record);
    if (dispatch.kind === 'blocked-missing-payload') {
      if (opts.emitMissingPayload !== false) {
        this.eventLog.emit('cancel-blocked-missing-payload', {
          commitmentHash: record.hash,
          speculationId: record.speculationId,
          contestId: record.contestId,
          makerSide: record.makerSide,
          lifecycle: record.lifecycle,
          reason: 'missing-legacy-signed-payload-and-hidden',
          detail: 'state record predates M6/A (no captured signedPayload) AND is book-hidden (lifecycle=softCancelled); the public commitments API redacts the signed fields, so cancelOnchain has no recovery path. Operator action required: recover the payload via owner-auth own-state or wait for expiry.',
        });
      }
      return 'blocked-missing-payload';
    }
    const maxDailyGasPolWei = polFloatToWei18(this.config.gas.maxDailyGasPOL);
    const emergencyReservePolWei = polFloatToWei18(this.config.gas.emergencyReservePOL);
    const today = todayUTCDateString(now);
    const todayGasSpentPolWei = BigInt(this.state.dailyCounters[today]?.gasPolWei ?? '0');
    // mayUseReserve:false — a routine quote refresh must preserve the emergency reserve (unlike shutdown kill / settlement).
    const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve: false });
    if (!verdict.allowed) {
      if (opts.emitGasDenied !== false) {
        this.eventLog.emit('candidate', {
          skipReason: 'gas-budget-blocks-onchain-cancel',
          commitmentHash: record.hash,
          speculationId: record.speculationId,
          contestId: record.contestId,
          makerSide: record.makerSide,
          todayGasSpentPolWei: todayGasSpentPolWei.toString(),
          maxDailyGasPolWei: maxDailyGasPolWei.toString(),
          emergencyReservePolWei: emergencyReservePolWei.toString(),
          detail: verdict.reason,
        });
      }
      return 'gas-denied'; // keep the record as-is, no off-chain fallback, no repost (operator must free gas; the normal cadence re-evaluates)
    }
    let result: Awaited<ReturnType<OspexAdapter['cancelCommitmentOnchain']>>;
    try {
      // Pass `{ signedCommitment }` when we hold the captured payload (no API fetch, works for book-hidden rows post M2);
      // fall back to `{ hash }` for migration records (visible only — the SDK fetches + reconstructs).
      result = await this.adapter.cancelCommitmentOnchain(
        dispatch.kind === 'use-signed-payload' ? { signedCommitment: dispatch.payload } : { hash: dispatch.hash },
      );
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'onchain-cancel', commitmentHash: record.hash });
      return 'transient-failure';
    }
    const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
    this.recordGasSpentToday(today, gasPolWei);
    record.lifecycle = 'authoritativelyInvalidated';
    record.updatedAtUnixSec = now;
    this.eventLog.emit('onchain-cancel', {
      commitmentHash: record.hash,
      speculationId: record.speculationId,
      contestId: record.contestId,
      makerSide: record.makerSide,
      txHash: result.txHash,
      gasPolWei: gasPolWei.toString(),
    });
    const m = this.trackedMarkets.get(record.contestId);
    if (m !== undefined) m.dirty = true; // re-quote the freed side next tick (never same-tick over a just-cancelled commitment)
    return 'cancelled';
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
    for (const rp of plan.retainedPartials) {
      this.emitPartialRetained(rp.record, rp.reason); // a matched remainder occupying its side — left in place (off-chain cancel would be rejected; reposting over it would double exposure)
    }
    if ((await this.maybeOnchainCancelRetainedPartials(plan.retainedPartials, now)) === 'transient-failure') outcome = 'transient-failure'; // cancelMode:onchain authoritative cancel threw — re-arm the market so the cancel retries next tick (not throttled behind staleAfterSeconds)
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
    // §5.1 own-state posting gate — EARLY-OUT (Hermes #73 r2). Skip the SDK
    // round-trip entirely if own-state is already degraded at submit time. This is
    // NOT the boundary: the SDK's `submitRaw` awaits getAddress / allowance / nonce
    // / signing before the irreversible `POST /v1/commitments`, and own-state can
    // degrade during those awaits (Hermes #73 r3). The AUTHORITATIVE re-check is the
    // `beforePost` hook below, which the SDK runs synchronously immediately before
    // the POST. Inert in dry-run / poll-only (updateStreamHealthHold returns false),
    // so dry-run still prices + records its synthetic `would-submit`.
    if (this.updateStreamHealthHold(this.deps.now())) return null;
    const proto = toProtocolQuote({ side: qs.takerSide, oddsTick: qs.quoteTick });
    let hash: string;
    // The SDK's `submitRaw` returns `SubmitResult.signedPayload` (the canonical
    // EIP-712 bundle — own-state SSE plan §M6) on every live submit. We
    // capture + persist it here so the cancel paths can use
    // `cancelOnchainSigned(payload)` without round-tripping the public API —
    // critical for book-hidden rows post v0.5.0/M2 redaction. Dry-run skips
    // the SDK entirely (the synthetic `dry:...` hash never goes on chain), so
    // the persisted record gets `signedPayloadStatus: 'missing-legacy'` and
    // cancel paths never reach it (dry-run is self-guarded earlier).
    let signedPayload: MakerSignedPayload | undefined;
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
          // §5.1 AUTHORITATIVE own-state boundary (Hermes #73 r3): the SDK runs this
          // SYNCHRONOUSLY immediately before the irreversible POST /v1/commitments
          // (after its getAddress / allowance / nonce / signing awaits, during which
          // own-state can degrade). Throwing aborts the POST — the SDK re-throws
          // OWN_STATE_HOLD_ABORT unchanged, caught below. MUST be synchronous (the
          // SDK fail-closes a thenable-returning hook), so this only reads + throws.
          beforePost: () => {
            if (this.updateStreamHealthHold(this.deps.now())) throw OWN_STATE_HOLD_ABORT;
          },
        });
        hash = result.hash;
        signedPayload = toMakerSignedPayload(result.signedPayload);
      } catch (err) {
        // §5.1 refusal at the POST boundary — the `stream-health-hold` enter edge
        // was already emitted by `updateStreamHealthHold` inside `beforePost`; this
        // is not a submit failure, so return null (→ transient-failure → re-quote
        // next tick) WITHOUT logging a spurious `error`.
        if (err === OWN_STATE_HOLD_ABORT) return null;
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'submit', contestId: m.contestId, takerSide: qs.takerSide });
        return null;
      }
    }
    const record = this.commitmentRecord(m, qs, now, expiryUnixSec, hash, proto, signedPayload);
    this.state.commitments[record.hash] = record;
    return record;
  }

  /** Build a `visibleOpen` `MakerCommitmentRecord` for a taker offer (`qs`) at a given commitment `hash`, with the already-computed protocol params (`proto`) — the maker side + odds tick the risk engine accounts against (so the synthetic dry-run record and the real live one have the identical exposure shape). `signedPayload` is the canonical EIP-712 bundle captured at submit time (M6/A); undefined on a dry-run record (no signing happened) — in that case the discriminant `signedPayloadStatus` is `'missing-legacy'`. */
  private commitmentRecord(m: TrackedMarket, qs: QuoteSide, now: number, expiryUnixSec: number, hash: string, proto: ProtocolQuote, signedPayload: MakerSignedPayload | undefined): MakerCommitmentRecord {
    const record: MakerCommitmentRecord = {
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
      signedPayloadStatus: signedPayload === undefined ? 'missing-legacy' : 'present',
      // fills[] starts empty (Phase 2 PR1 — own-state SSE plan §2.5.3). The
      // poll path never appends; only the SSE `fill` reducer (Phase 2 PR4)
      // will populate this array.
      fills: [],
    };
    if (signedPayload !== undefined) record.signedPayload = signedPayload;
    return record;
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
   *     - `cancelled` (effective) → classify off CANONICAL signals, not the effective
   *       status (a merely book-hidden row reports `cancelled` too): `storedStatus ===
   *       'cancelled'` or `nonceInvalidated` → fill delta applied (if any), record
   *       `'authoritativelyInvalidated'` (no `expire` — v0's MM doesn't on-chain-cancel its
   *       own commitments; manual cancel between runs / outside the MM). Otherwise the row is
   *       just book-hidden (`book_visible=false`, still matchable on chain) → reclassify
   *       `'softCancelled'` + converge the fill commitment-only; the latent remainder is NOT
   *       released, and `reconcileSoftCancelledFills` owns it thereafter (Hermes review-2).
   *     - any other status (`open` / `partially_filled`, only reachable against a
   *       core-api predating effective-status, where an expired/invalidated row
   *       leaves the listing but get-by-hash still reports the raw status) →
   *       terminalize from local signals: past `expiryUnixSec` → `'expired'` +
   *       `expire`; else `nonceInvalidated` → `'authoritativelyInvalidated'`; else
   *       log `UnexpectedFillStatus` (a genuinely live commitment shouldn't vanish).
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
    // PR3b source flip: when subscribe is true the SSE stream is the canonical
    // own-state writer, so the poll path runs as a best-effort AUDIT over a fresh
    // clone of canonical (`this.auditState`) — cross-checking SSE-derived fills
    // against the API. detectFills is the first poll method in the tick, so it
    // (re)seeds the audit state from canonical for the whole audit cycle. An
    // audit failure NEVER gates trading (returns true): the §5 health gate owns
    // SSE fail-closed. In backout (subscribe:false) the poll IS canonical
    // (writes this.state) and a failure gates the tick fail-closed as before.
    const subscribe = this.config.ownState.subscribe;
    if (subscribe) this.reseedAuditState();
    const target = subscribe ? this.auditState : this.state;
    const source: 'poll' | 'audit' = subscribe ? 'audit' : 'poll';
    const now = this.deps.now();
    const reducerConfig = { expiryReleaseGraceSeconds: this.config.orders.expiryReleaseGraceSeconds };
    const localOpen = new Map<string, MakerCommitmentRecord>();
    for (const r of Object.values(target.commitments)) {
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
      return subscribe ? true : false; // backout: fail closed (skip live writes + ageOut); audit: never gates trading
    }
    const apiByHash = new Map<string, Commitment>();
    for (const c of apiList) apiByHash.set(c.commitmentHash, c);

    let pastExpiryLookupFailed = false;

    // Pass 1 — still-listed commitments (partial-fill bumps).
    for (const [, record] of localOpen) {
      const apiCommitment = apiByHash.get(record.hash);
      if (apiCommitment === undefined) continue; // disappeared — handled below
      const observation: PolledCommitmentObservation = { kind: 'still-listed', record, apiCommitment };
      const descriptors = reducePolledCommitmentObservation(target, observation, now, reducerConfig);
      const result = this.applyDescriptors(descriptors, source);
      if (result.pastExpiryLookupFailed) pastExpiryLookupFailed = true;
    }

    // Pass 2 — disappeared hashes (per-hash `getCommitment`, then reducer classifies).
    // Past-expiry lookup failures escalate to fail-closed (the reducer signals via
    // descriptor; `applyDescriptors` ORs into the result). Future-expiry lookup
    // failures are non-fatal — the record stays live + counted, next tick retries.
    for (const [hash, record] of localOpen) {
      if (apiByHash.has(hash)) continue;
      let observation: PolledCommitmentObservation;
      try {
        const apiCommitment = await this.adapter.getCommitment(hash as Hex);
        observation = { kind: 'disappeared', record, apiCommitment };
      } catch (err) {
        observation = { kind: 'disappeared-lookup-failed', record, err };
      }
      const descriptors = reducePolledCommitmentObservation(target, observation, now, reducerConfig);
      const result = this.applyDescriptors(descriptors, source);
      if (result.pastExpiryLookupFailed) pastExpiryLookupFailed = true;
    }
    return subscribe ? true : !pastExpiryLookupFailed;
  }

  /**
   * Reseed `this.auditState` from a shallow per-record clone of canonical
   * `this.state` (PR3b source flip, subscribe mode). The audit poll then
   * converges these COPIES against the API; because the poll reducers mutate
   * only primitive fields (`filledRiskWei6` / `lifecycle` / status / risk) of the
   * passed records, a shallow `{ ...record }` clone fully isolates the canonical
   * book from audit mutation. Reseeding each cycle makes the audit stateless and
   * lets it catch the dangerous SSE-BEHIND direction: the API convergence only
   * ever bumps `filledRiskWei6` UP, so an SSE that under-counted a fill diverges
   * from the API-converged audit (→ `auditDivergenceUnresolved` → posting hold).
   * `fills[]` arrays are shared by reference (the poll never mutates them and the
   * comparator never reads them — only `filledRiskWei6` matters).
   */
  private reseedAuditState(): void {
    this.auditState.commitments = Object.fromEntries(
      Object.entries(this.state.commitments).map(([hash, r]) => [hash, { ...r }]),
    );
    this.auditState.positions = Object.fromEntries(
      Object.entries(this.state.positions).map(([key, p]) => [key, { ...p }]),
    );
  }

  /**
   * Emit the right telemetry for a canonical own-state mapping failure: the
   * dedicated `owner-mapping-failed` kind when a PR3a mapper threw
   * `OwnerMappingError` (a payload missing metadata a `Maker*Record` requires),
   * or a generic `error` otherwise. Shared by the drain dispatch and the
   * snapshot-baseline accumulation — both skip the offending row (fail-closed).
   */
  private emitOwnStateMappingFailure(err: unknown, where: string): void {
    if (err instanceof OwnerMappingError) {
      this.eventLog.emit('owner-mapping-failed', {
        class: 'OwnerMappingError',
        field: err.field,
        ...(err.commitmentHash !== undefined ? { commitmentHash: err.commitmentHash } : {}),
        ...(err.speculationId !== undefined ? { speculationId: err.speculationId } : {}),
        detail: err.message,
        phase: 'own-state-stream',
      });
    } else {
      this.eventLog.emit('error', {
        class: errClass(err),
        detail: `${errMessage(err)} (${where})`,
        phase: 'own-state-stream',
      });
    }
  }

  /**
   * Translate a reducer's `ReducerDescriptor[]` into the runner's side-effects:
   * telemetry emits, market-dirtying (gated on `trackedMarkets`), and orchestrator-
   * level signals (`pastExpiryLookupFailed`, `softCancelledProbeFailed`,
   * `unknownOwnFill`). State mutations have already happened inside the reducer;
   * this method is purely IO + signal aggregation.
   *
   * The `source` tag distinguishes the canonical SSE writer (`'owner'`) from the
   * AUDIT poll (`'audit'`, post PR3b): an audit-source pass runs the poll
   * reducers against `this.auditState` purely to feed the divergence comparator,
   * so it MUST NOT re-emit `fill` / `position-transition` telemetry (the SSE
   * canonical path already emitted those) nor re-dirty markets (the audit must
   * never drive posting). Audit suppresses those; it keeps `emit-error` +
   * `emit-expire` (audit-internal anomalies) and the fail-closed signals.
   */
  private applyDescriptors(descriptors: ReducerDescriptor[], source: 'poll' | 'owner' | 'audit'): ApplyDescriptorsResult {
    const result: ApplyDescriptorsResult = { pastExpiryLookupFailed: false, softCancelledProbeFailed: false, unknownOwnFill: false };
    const audit = source === 'audit';
    for (const d of descriptors) {
      switch (d.kind) {
        case 'emit-fill':
          if (!audit) this.eventLog.emit('fill', d.payload as unknown as Record<string, unknown>);
          break;
        case 'emit-expire':
          this.eventLog.emit('expire', d.payload as unknown as Record<string, unknown>);
          break;
        case 'emit-position-transition':
          if (!audit) this.eventLog.emit('position-transition', d.payload as unknown as Record<string, unknown>);
          break;
        case 'emit-error':
          this.eventLog.emit('error', d.payload as unknown as Record<string, unknown>);
          break;
        case 'mark-dirty': {
          if (audit) break; // the audit poll must never dirty markets / drive posting
          const m = this.trackedMarkets.get(d.contestId);
          if (m !== undefined) m.dirty = true;
          break;
        }
        case 'signal-past-expiry-lookup-failed':
          result.pastExpiryLookupFailed = true;
          break;
        case 'signal-softcancel-probe-failed':
          result.softCancelledProbeFailed = true;
          break;
        case 'signal-unknown-own-fill':
          // §7.2: an own-state fill referenced a commitment not in canonical
          // state. Emit telemetry, latch the audit-divergence posting hold, and
          // request a cursor-less cold restart whose fresh snapshot reconciles
          // (the orphan fill was NOT applied — a fill carries no contest identity).
          this.eventLog.emit('unknown-own-fill', d.payload as unknown as Record<string, unknown>);
          this.auditDivergenceUnresolved = true;
          this.ownStateColdRestartRequested = true;
          this.wakeSignal.wake();
          result.unknownOwnFill = true;
          break;
      }
    }
    return result;
  }

  // ── own-state SSE subscription (Phase 2 PR4a) ────────────────────────────

  /**
   * Open the owner-authenticated own-state SSE stream. Captures the
   * `Subscription` SYNCHRONOUSLY before any handler can fire so the
   * identity-guard inside the handlers can compare against
   * `this.currentOwnStateSubscription` correctly on the very first event.
   *
   * Phase 2 invariant — shadow-only: the handlers project SSE bodies into
   * `this.ownStateSession` ONLY. Canonical `MakerState` writes still come
   * from the poll path. Owner-reducer event-application is stubbed in
   * PR4a (queue events drain to no-op reducers); PR4b lands the real
   * reducer bodies.
   */
  private openOwnStateSubscription(): void {
    if (this.makerAddress === null) return; // guarded by caller; defensive
    if (this.currentOwnStateSubscription !== null) return; // already open
    // Build the handlers up front. Each handler captures a `mySub` LOCAL ref
    // assigned after `subscribe` returns; the runtime identity check
    // `mySub === this.currentOwnStateSubscription` rejects late-fired
    // handlers from an unsubscribed prior subscription (belt-and-braces on
    // the SDK's own no-fire-after-unsubscribe contract).
    let mySub: Subscription | null = null;
    const sameSub = (): boolean => mySub !== null && mySub === this.currentOwnStateSubscription;
    const handlers: OwnerStateSubscribeHandlers = {
      onSnapshot: (snapshot) => {
        if (!sameSub()) return;
        this.handleOwnerSnapshot(snapshot);
      },
      onReady: (meta) => {
        if (!sameSub()) return;
        this.handleOwnerReady(meta.cursor);
      },
      onCommitment: (commitment, meta) => {
        if (!sameSub()) return;
        this.handleOwnerCommitment(commitment, meta.cursor);
      },
      onFill: (fill, meta) => {
        if (!sameSub()) return;
        this.handleOwnerFill(fill, meta.cursor);
      },
      onPositionStatus: (event, meta) => {
        if (!sameSub()) return;
        this.handleOwnerPositionStatus(event, meta.cursor);
      },
      onStatus: (status) => {
        if (!sameSub()) return;
        this.handleOwnerStatus(status);
      },
      onError: (error) => {
        if (!sameSub()) return;
        this.handleOwnerError(error);
      },
      onFrame: (meta) => {
        if (!sameSub()) return;
        this.handleOwnerFrame(meta);
      },
    };
    // §4.2 (Phase 3 PR1) — offer the persisted resume cursor as Last-Event-ID
    // when present. `resumedFromPersistedCursor` arms the empty-baseline guard
    // for THIS subscription: if the resume delivers no snapshot, `onReady` will
    // cold-restart cursor-less (a cursor alone is not state). A cursor-less
    // open (cold start, or the reopen AFTER a cold restart) leaves the flag
    // false. Built conditionally so `initialCursor: undefined` is never passed
    // (exactOptionalPropertyTypes).
    const initialCursor = this.state.ownStateCursor;
    this.resumedFromPersistedCursor = initialCursor !== undefined;
    mySub = this.adapter.subscribeOwnState(
      initialCursor !== undefined ? { address: this.makerAddress, initialCursor } : { address: this.makerAddress },
      handlers,
    );
    this.currentOwnStateSubscription = mySub;
  }

  /**
   * Close the current own-state SSE subscription. Awaiting `unsubscribe()`
   * is the SDK's contract for "no handler will fire after this returns".
   * Idempotent — safe to call when no subscription is open.
   *
   * Sets `currentOwnStateSubscription` to `null` BEFORE the await so that
   * any in-flight handler that happened to fire on the same microtask sees
   * `mySub !== current` (=== null) and no-ops via the identity guard.
   */
  private async closeOwnStateSubscription(): Promise<void> {
    const sub = this.currentOwnStateSubscription;
    if (sub === null) return;
    this.currentOwnStateSubscription = null;
    try {
      await sub.unsubscribe();
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'own-state-unsubscribe' });
    }
  }

  /**
   * Handle one snapshot page from the SSE cold-connect (inline) or REST
   * paging (when the first inline page was `truncated: true`). Each call
   * accumulates the page's commitments + positions — projected to CANONICAL
   * `MakerCommitmentRecord` / `MakerPositionRecord` via the PR3a mappers — into
   * `session.pendingBaseline`. The final page (`truncated: false`) is followed
   * by `onReady`, which atomically swaps `pendingBaseline` into
   * `this.state.commitments` / `.positions` (the source flip, PR3b).
   *
   * Fail-closed per row: a mapper throw (`OwnerMappingError` — missing required
   * metadata) emits `owner-mapping-failed` and SKIPS that row rather than
   * materializing a partial record or crashing the whole baseline.
   *
   * The snapshot page's own SSE-frame cursor is NOT consumed here: the SDK's
   * `OwnStateEventMeta` contract is that ONLY the cursor delivered to `onReady`
   * (final baseline complete) is a valid `Last-Event-ID` resume point — a
   * snapshot page's frame id (truncated pages especially) is not resumable. So
   * `handleOwnerReady` promotes the `onReady` cursor and this handler ignores
   * the per-page cursor entirely (own-state SSE plan §4.3).
   */
  private handleOwnerSnapshot(snapshot: OwnerStateSnapshot): void {
    // A snapshot page means the SDK IS delivering a baseline on this connect
    // (even a resume that re-snapshots) — so this is no longer a baseline-less
    // resume; disarm the empty-baseline guard (own-state SSE plan §4.2).
    this.resumedFromPersistedCursor = false;
    if (this.ownStateSession.pendingBaseline === null) {
      this.ownStateSession.pendingBaseline = {
        commitments: {},
        positions: {},
        truncated: snapshot.truncated,
        positionsTruncated: snapshot.positionsTruncated,
      };
    } else {
      this.ownStateSession.pendingBaseline.truncated = snapshot.truncated;
      // OR-latch positionsTruncated across pages — once any page reports the
      // actionable-positions cap was hit, the baseline is incomplete and the
      // session MUST surface that signal to the comparator regardless of
      // subsequent page outcomes (Hermes #68 review blocker 2 — don't rely
      // on `onStatus('degraded')` event ordering).
      if (snapshot.positionsTruncated) this.ownStateSession.pendingBaseline.positionsTruncated = true;
    }
    for (const c of snapshot.commitments) {
      try {
        this.ownStateSession.pendingBaseline.commitments[c.commitmentHash] = mapOwnerCommitmentToMaker(c);
      } catch (err) {
        this.emitOwnStateMappingFailure(err, 'snapshot-commitment');
      }
    }
    for (const p of snapshot.positions) {
      try {
        const mapped = mapOwnerPositionToMaker(p);
        this.ownStateSession.pendingBaseline.positions[`${p.speculationId}:${mapped.side}`] = mapped;
      } catch (err) {
        this.emitOwnStateMappingFailure(err, 'snapshot-position');
      }
    }
    this.ownStateSession.lastEventAtMs = Date.now();
    // Don't wake on snapshot pages — wake when `ready` fires (the comparator
    // shouldn't run against a partial baseline; the SDK still buffers deltas
    // internally until `ready`, but we belt-and-braces by deferring drain).
  }

  /**
   * Handle the `onReady` signal — fires after the final untruncated snapshot
   * page (cold start) OR after server catchup completes (resume reconnect).
   * Atomically swaps `pendingBaseline` into `shadow.commitments` /
   * `shadow.positions`; sets `ready: true`; wakes the loop so the next
   * drain sees `ready: true` (PR5 comparator uses this).
   *
   * INTENTIONAL DIVERGENCE from plan §4.3's single-queue promotion model:
   * snapshot + ready are processed OUT-OF-BAND (synchronously, here + in
   * `handleOwnerSnapshot`), NOT enqueued into `ownStateQueue` alongside deltas.
   * This is safe because the SDK buffers deltas until `onReady` when a snapshot
   * is being delivered, so at swap time the delta queue holds no pre-baseline
   * events; and the `baseline !== null` gate means a reconnect's `onReady`
   * (baseline already swapped) promotes nothing while catchup deltas stay queued
   * and promote in-order in `drainOwnState`. The synchronous swap is a plain
   * object assignment and cannot throw, so §4.4's "swap throws → cursor not
   * advanced" case is N/A. No leapfrog path exists.
   */
  private handleOwnerReady(cursor: string): void {
    const baseline = this.ownStateSession.pendingBaseline;
    // EMPTY-BASELINE GUARD (own-state SSE plan §4.2, "a cursor alone is not
    // state", Phase 3 PR1): a resume seeded from a persisted cursor that
    // reaches `onReady` with NO snapshot (`baseline === null`) has no durable
    // baseline to pair the cursor with — in Phase 2 the shadow is in-memory
    // only, so a process restart left it empty. Flipping `ready` here would
    // publish an empty baseline to the comparator (false divergence) and
    // persisting the cursor would compound it. Drop the cursor and request a
    // cold restart (close + reopen cursor-less → the SDK sends a fresh
    // snapshot). Does NOT trip on a mid-session reconnect (in-memory baseline
    // still live → `resumedFromPersistedCursor` already false). The actual
    // close/reopen is async, done by `performOwnStateColdRestart` off the wake.
    if (baseline === null && this.resumedFromPersistedCursor) {
      this.eventLog.emit('stream-cold-restart', { reason: 'resume-without-baseline' });
      this.state.ownStateCursor = undefined;
      this.resumedFromPersistedCursor = false;
      this.ownStateColdRestartRequested = true;
      this.wakeSignal.wake(); // so the loop's wake path performs the restart promptly
      return; // do NOT set ready — an empty shadow must not look ready
    }
    if (baseline !== null) {
      // Atomic swap — the SSE baseline becomes the CANONICAL book (PR3b source
      // flip). REPLACE `this.state.commitments`/`.positions` wholesale: the
      // pendingBaseline accumulated EVERY commitment/position the owner snapshot
      // reported, which is the authoritative re-grounding. A commitment the MM
      // posted but the indexer hasn't surfaced yet would be dropped here, but
      // §7.2 (unknown-own-fill) re-snapshots if such a commitment later fills,
      // and the §5.1 health gate halts posting across a resync — so the drop is
      // self-healing. The fill-dedup set is reseeded from the fresh baseline's
      // (empty) `fills[]` so a re-delivered fill isn't mis-deduped against a
      // pre-swap key (the snapshot's `filledRiskWei6` already reflects all fills).
      this.state.commitments = baseline.commitments;
      this.state.positions = baseline.positions;
      this.ownStateDedupSet.clear();
      this.ownStateSession.truncated = baseline.truncated;
      this.ownStateSession.positionsTruncated = baseline.positionsTruncated;
      this.ownStateSession.pendingBaseline = null;
      // §4.3 cursor promotion: the baseline is now live in the shadow, so the
      // cursor that pairs with it is safe to persist. The tick's existing atomic
      // flush writes it alongside the rest of MakerState. A cursor is promoted
      // ONLY here (with a real baseline) — never on the baseline-less path the
      // empty-baseline guard above intercepts, where a resume delivered no
      // snapshot and a cursor alone is not state.
      //
      // Persist the `onReady` cursor — the SDK's `OwnStateEventMeta` contract is
      // that the cursor delivered to `onReady` (final baseline complete) is the
      // FIRST cursor safe to persist as a restart `Last-Event-ID`; a snapshot
      // page's frame id (truncated pages especially) is NOT a resumable
      // position. The PR1 `pendingBaselineCursor` staging that preferred the
      // final-page cursor was fail-safe only while the cursor was shadow-only
      // (every boot-resume cold-restarted via the empty-baseline guard). PR3b
      // makes resume load-bearing, so this honours the documented contract and
      // drops the page-cursor staging entirely (own-state SSE plan §4.3, the
      // mandated pre-flip cursor reconfirm).
      const promoted = cursor || undefined;
      if (promoted) this.state.ownStateCursor = promoted;
    }
    // A real baseline was swapped, OR this is a mid-session reconnect whose
    // in-memory baseline is still live — either way a baseline now backs the
    // shadow, so the resume guard is satisfied.
    this.resumedFromPersistedCursor = false;
    this.ownStateSession.ready = true;
    this.ownStateSession.lastReadyAtMs = Date.now();
    this.ownStateSession.lastEventAtMs = Date.now();
    // Re-derive the composite latch health (Phase 3 PR2): `ready` just flipped
    // true and a fresh baseline (possibly `positionsTruncated`) swapped in, both
    // composite inputs. A queue overflow OR positionsTruncated baseline means the
    // shadow is incomplete in ways a transport-recovery alone cannot fix, so the
    // recompute keeps `healthy` false until a clean rebaseline clears them.
    this.recomputeOwnStateHealth();
    // No telemetry emit in PR4a — PR5 wires the proper `stream-ready` /
    // comparator-pass shape. Wake the loop so the next iteration drains.
    this.wakeSignal.wake();
  }

  private handleOwnerCommitment(commitment: OwnerCommitment, cursor: string): void {
    this.ownStateSession.lastEventAtMs = Date.now();
    this.enqueueOwnStateAndReact({ kind: 'commitment', body: commitment, arrivedAtMs: Date.now(), cursor });
    this.wakeSignal.wake();
  }

  private handleOwnerFill(fill: Fill, cursor: string): void {
    this.ownStateSession.lastEventAtMs = Date.now();
    this.enqueueOwnStateAndReact({ kind: 'fill', body: fill, arrivedAtMs: Date.now(), cursor });
    this.wakeSignal.wake();
  }

  private handleOwnerPositionStatus(event: PositionStatusEvent, cursor: string): void {
    this.ownStateSession.lastEventAtMs = Date.now();
    this.enqueueOwnStateAndReact({ kind: 'positionStatus', body: event, arrivedAtMs: Date.now(), cursor });
    this.wakeSignal.wake();
  }

  /**
   * Handle a wire-level SSE frame (own-state SSE plan §5, Phase 3 PR2b). Fires
   * for EVERY parsed frame INCLUDING heartbeats (`OwnStateFrameMeta.kind ===
   * 'heartbeat'`), so a quiet wallet that produces no domain events still keeps
   * the `transportFresh` latch (latch 2) alive — the whole point of the SDK's
   * `onFrame` callback. Drives three things off one frame:
   *
   *   1. Records `lastFrameAtSec` (the latch-2 freshness source) at `deps.now()`
   *      — the injected clock in unix SECONDS, NOT `meta.receivedAtMs`, so it
   *      shares units + clock with the recovery-hold anchor and is test-driveable.
   *   2. Gap-detect: if the inter-frame gap exceeded `staleMaxMs`, the transport
   *      was STALE during the gap (and a read may not have observed it, since
   *      `transportFresh` decays with no event), so the continuous-healthy streak
   *      is broken → clear the recovery-hold anchor. This is the belt-and-braces
   *      half of the read-time decay check in {@link ownStateHealthy}: it closes
   *      the case where NO read happened during the stale window, degrading at the
   *      SOURCE rather than only at the next read
   *      ([[feedback_enforce_invariant_every_site]]).
   *   3. Clears latch 7 (`tokenRefreshFailureInFlight`): a frame can only arrive
   *      on an open, successfully-authenticated connection (the bearer is consumed
   *      at connect-time and the SDK never re-mints mid-stream — it only re-mints
   *      at reconnect, when frames are NOT flowing), so a frame after a
   *      `token-refresh` failure proves the transport re-authenticated.
   *
   * Does NOT `wake()` — heartbeats arrive on a fixed cadence and waking per frame
   * would spin the loop. Freshness is consumed at read time (the per-tick posting
   * gate + comparator); domain events wake via their own handlers. A
   * transport-recovery resume is gated by the recovery hold anyway, so the next
   * natural tick picking it up is fine.
   */
  private handleOwnerFrame(_meta: OwnStateFrameMeta): void {
    const nowSec = this.deps.now();
    if (
      this.lastFrameAtSec !== null &&
      (nowSec - this.lastFrameAtSec) * 1000 >= this.config.ownState.staleMaxMs
    ) {
      // Transport was stale across this gap — restart the recovery hold on
      // recovery (recompute below re-anchors it at this fresh frame).
      this.healthyEligibleSinceSec = null;
    }
    this.lastFrameAtSec = nowSec;
    this.tokenRefreshFailureInFlight = false;
    // Re-derive composite health (transport just went fresh; latch 7 may have
    // cleared) + maintain the recovery-hold anchor at THIS frame's timestamp.
    this.recomputeOwnStateHealth(nowSec);
  }

  /**
   * Handle a transport status change. `resync` clears the prior baseline +
   * `ready: false` so the next snapshot fully replaces shadow state.
   * `degraded` sets `healthy: false` — the PR5 comparator's precondition
   * `healthy && ready` suppresses divergence telemetry until the transport
   * recovers (`connected` clears it).
   */
  private handleOwnerStatus(status: OwnStateTransportStatus): void {
    this.ownStateSession.lastStatus = status;
    this.ownStateSession.lastEventAtMs = Date.now();
    if (status === 'resync') {
      // The upcoming fresh snapshot is authoritative — drop every buffer the
      // prior baseline seeded. Centralized in `resetOwnStateForRebaseline` so the
      // resync path and the empty-baseline cold-restart path clear the SAME set
      // ([[feedback_enforce_invariant_every_site]] + [[feedback_reset_event_clears_dependent_buffers]]).
      this.resetOwnStateForRebaseline();
    } else if (status === 'connected') {
      // Transport recovered — clear any prior transport-level error mark
      // (including the fatal-error input the recompute below reads). A queue
      // overflow / positionsTruncated baseline are NOT cleared here: they
      // dropped/omitted events a transport reconnect alone can't recover (the
      // SDK's catchup resumes from the running cursor, never replaying the
      // events the runner dropped), so they need a `resync` → fresh snapshot
      // to clear (Hermes #68 review blocker 1). The recompute below keeps
      // `healthy` false while either latch is still set.
      this.ownStateSession.lastError = null;
      // Latch 7 backstop (Phase 3 PR2b): `connected` proves the transport
      // re-authenticated. `onFrame` is the primary clear (it precedes
      // `connected`), but `onFrame` is optional in the SDK contract — clearing
      // here too guards against latch 7 sticking (a permanent posting hold) if a
      // future SDK ever stops firing frames.
      this.tokenRefreshFailureInFlight = false;
    }
    // Single derivation site for ALL status transitions (connected / degraded /
    // reconnecting / resync): re-derive the composite latch health from every
    // input rather than a per-branch single-path set, so a recovery on one
    // signal can't mask a different still-tripped latch
    // ([[feedback_health_predicate_composite_inputs]]). `degraded` /
    // `reconnecting` fall through here with `lastStatus !== 'connected'`, which
    // the recompute reads as unhealthy.
    this.recomputeOwnStateHealth();
    this.wakeSignal.wake();
  }

  /**
   * Clear every shadow/cursor buffer that a RE-BASELINE invalidates — shared by
   * the server-driven resync path (`handleOwnerStatus('resync')`) and the
   * MM-driven empty-baseline cold restart (`performOwnStateColdRestart`). The
   * upcoming fresh snapshot is authoritative, so all of these MUST be dropped at
   * one site or stale state double-applies onto the new baseline:
   * - `ready=false` / `pendingBaseline=null` — a partial pre-rebaseline snapshot
   *   must not swap in; reducers gate reads on `ready`.
   * - `streamOverflowDegraded=false` — a fresh snapshot re-baselines the events
   *   the overflow dropped, so the latch may clear (Hermes #68 blocker 1).
   * - `tokenRefreshFailureInFlight=false` (latch 7, PR2b) — a rebaseline opens a
   *   fresh connection whose auth is independent of the prior refresh failure;
   *   a new failure re-latches ([[feedback_reset_event_clears_dependent_buffers]]).
   * - `lastFrameAtSec=null` (latch 2 source, PR2b) — transport freshness must be
   *   re-earned on the new connection's first frame, not carried over from the old
   *   subscription's last frame. Harmless either way (`ready=false` dominates the
   *   mirror until the new baseline), but resetting removes a cross-subscription
   *   dependence on the SDK's onFrame-before-onReady ordering.
   * - `ownStateQueue.clear()` — pre-rebaseline deltas would double-count on the
   *   fresh baseline (Hermes #69).
   * - `state.ownStateCursor` — the resume cursor that indexed the dropped
   *   baseline is stale; a stale cursor surviving could resume a future boot
   *   onto a baseline the snapshot replaced (a cursor alone is not state).
   *   Cleared persisted cursor is written on the next flush.
   * - `resumedFromPersistedCursor=false` — the next connect's snapshot (or a
   *   reopen) re-arms it as appropriate.
   * - `ownStateColdRestartRequested=false` — consume any pending cold-restart
   *   request at this drain site ([[feedback_consume_latched_signal_at_drain_site]]):
   *   a server-driven resync already re-baselines on the LIVE socket, so it
   *   supersedes a not-yet-performed MM-driven cold restart (which would
   *   pointlessly close + reopen the connection the resync is already healing).
   * - `firstAuditPollAfterReady` + `divergenceTracker` + `auditDivergenceUnresolved`
   *   (latch 5, PR2c-ii) — the comparator must wait for the post-rebaseline `onReady`
   *   AND one poll-tick before comparing; the prior divergence verdict is moot.
   */
  private resetOwnStateForRebaseline(): void {
    this.ownStateSession.ready = false;
    this.ownStateSession.pendingBaseline = null;
    this.streamOverflowDegraded = false;
    this.tokenRefreshFailureInFlight = false;
    this.lastFrameAtSec = null;
    this.ownStateQueue.clear();
    this.state.ownStateCursor = undefined;
    this.resumedFromPersistedCursor = false;
    this.ownStateColdRestartRequested = false;
    this.firstAuditPollAfterReady = false;
    this.divergenceTracker.clear();
    // §5 latch 5 (PR2c-ii): a rebaseline invalidates any prior divergence verdict
    // (the fresh snapshot replaces the shadow the comparator measured), so clear the
    // posting-only latch with its tracker — a post-rebaseline comparison re-derives it.
    this.auditDivergenceUnresolved = false;
    // The rebaseline cleared `ready` + the overflow latch, so re-derive composite
    // health (it goes unhealthy on `ready=false`, which also clears the recovery
    // hold so the fresh baseline must re-earn `recoveryHoldMs` of stability before
    // the posting gate trusts it again). Covers both callers — the resync path
    // and `performOwnStateColdRestart`.
    this.recomputeOwnStateHealth();
  }

  /**
   * Act on a cold-restart request raised by the empty-baseline guard (own-state
   * SSE plan §4.2, Phase 3 PR1). The guard runs inside a synchronous SDK
   * handler, so it can only set `ownStateColdRestartRequested` + wake; this
   * async method (invoked off the wake-path / post-tick `drainOwnState`) does the
   * close + reopen. Order matters: close FIRST (the SDK contract + the runner's
   * identity guard mean no handler fires after `await unsubscribe()`), THEN
   * reset the rebaseline buffers (so no event delivered between the guard and
   * the close survives), THEN reopen — cursor-less, because the guard already
   * cleared `state.ownStateCursor`, so `openOwnStateSubscription` omits
   * `initialCursor` and the SDK cold-connects with a fresh snapshot. Skips if
   * the runner is shutting down. The flag is consumed up front so a redundant
   * call (it's invoked after every drain) is a no-op; the reopen is cursor-less
   * so its own `onReady` can't re-trip the guard.
   */
  private async performOwnStateColdRestart(): Promise<void> {
    if (!this.ownStateColdRestartRequested) return;
    this.ownStateColdRestartRequested = false;
    if (this.stopRequested || this.abortController.signal.aborted) return;
    await this.closeOwnStateSubscription();
    this.resetOwnStateForRebaseline();
    if (this.makerAddress !== null) this.openOwnStateSubscription();
  }

  /**
   * Handle a non-fatal transport error from the SDK. Records the error
   * details on the shadow; sets `healthy: false` for fatal errors (SDK
   * surfaces fatality via `OspexStreamError.reason === 'fatal'`).
   * Pre-existing shadow state is PRESERVED — the PR5 comparator's
   * `healthy && ready` precondition is what suppresses divergence telemetry.
   */
  private handleOwnerError(error: OspexStreamError): void {
    const reason = error.reason;
    this.ownStateSession.lastError = {
      class: error.constructor.name,
      detail: error.message,
      reason: reason ?? 'unknown',
      recordedAtMs: Date.now(),
    };
    this.ownStateSession.lastEventAtMs = Date.now();
    // §5 latch 7 (Phase 3 PR2b): a `token-refresh` failure means the SDK could
    // not re-mint the bearer for a reconnect on an already-connected subscription
    // — a future reconnect may fail, so the shadow is at risk of going stale.
    // Latch it into the mirror. (`token-mint` — the initial-connect phase, before
    // any baseline — is NOT latched here: it leaves `ready` false, which the
    // mirror already reads as unhealthy.) Cleared on the next frame /
    // `onStatus('connected')` / rebaseline.
    if (error.phase === 'token-refresh') this.tokenRefreshFailureInFlight = true;
    // Re-derive composite health: a `fatal` error is a latch input (the recompute
    // reads `lastError.reason === 'fatal'`); a non-fatal error leaves the
    // conjunction unchanged, preserving the Phase-2 "only fatal flips healthy"
    // behavior. The fatal input clears when `onStatus('connected')` nulls lastError.
    this.recomputeOwnStateHealth();
    this.eventLog.emit('error', {
      class: error.constructor.name,
      detail: error.message,
      phase: 'own-state-stream',
    });
    this.wakeSignal.wake();
  }

  /**
   * Re-derive the composite own-state latch health (own-state SSE plan §5,
   * Phase 3 PR2) and maintain the recovery-hold anchor. MUST be called at EVERY
   * latch-mutation site — `handleOwnerReady` (ready / positionsTruncated),
   * `handleOwnerStatus` (lastStatus / lastError-clear), `handleOwnerError`
   * (fatal), `drainOwnState` (overflow set), `resetOwnStateForRebaseline` (overflow
   * clear + ready clear) — so the conjunction is re-derived from ALL inputs and
   * a recovery on one signal can never mask a different still-tripped latch
   * ([[feedback_health_predicate_composite_inputs]] + the every-site discipline
   * of [[feedback_enforce_invariant_every_site]]).
   *
   * `shadow.healthy` is the EDGE-latch mirror — the conjunction of the
   * event-driven (non-time-dependent) inputs that say "the shadow is a current,
   * complete view of the maker's own state". It changes only when an SDK event
   * mutates a latch, so a stored bit recomputed at every mutation site is
   * accurate (never stale-by-time). Latches:
   *   - `ready` — a durable baseline is swapped in (no baseline ⇒ untrustworthy);
   *   - `lastStatus === 'connected'` (latch 1) — transport settled;
   *   - `!streamOverflowDegraded` (latch 3) — no dropped events;
   *   - `!positionsTruncated` (latch 4) — the baseline's positions are complete;
   *   - `lastError.reason !== 'fatal'` — the preserved Phase-2 fatal-stream input;
   *   - `!tokenRefreshFailureInFlight` (latch 7, PR2b) — the SDK can still
   *     re-authenticate the transport (a `token-refresh` error means a future
   *     reconnect may fail; an unauthenticated transport ⇒ a soon-stale shadow).
   *
   * Latch 2 (`transportFresh`, PR2b) is DELIBERATELY NOT in this stored
   * conjunction: it is TIME-DEPENDENT (decays to false with no SDK event), so a
   * stored bit would go stale between recomputes. It is evaluated at READ time by
   * {@link transportFresh} and AND-ed onto the edge mirror by
   * {@link instantOwnStateHealthy} — which is what the divergence comparator AND
   * the posting gate gate on (a stale transport ⇒ a stale shadow that must not be
   * audited or traded against). The recovery-hold anchor below is maintained
   * against that FULL instantaneous composite, NOT the bare edge mirror.
   *
   * The POSTING-only latches do NOT go here: the recovery hold (latch 8) lives in
   * {@link ownStateHealthy} (a posting anti-flap delay — suppressing the audit
   * comparator for it would hide divergences), and §5 latch 5
   * (`auditDivergenceUnresolved`, PR2c) MUST stay out of this mirror because the
   * comparator gates on the full instant mirror (which reads this edge mirror) and
   * ALSO produces latch 5 — folding it in would self-deadlock (a latched
   * divergence would suppress the comparator that clears it). Latch 6
   * (`indexerLagDegraded`, PR2c) is likewise a posting-safety latch
   * for {@link ownStateHealthy}, not a shadow-freshness signal. See the comparator
   * read site in {@link runAuditComparator}.
   *
   * The recovery-hold anchor `healthyEligibleSinceSec` is set to `nowSec` on the
   * false→true edge of the FULL instantaneous composite (edge mirror AND
   * transportFresh) and cleared to `null` whenever it is false, so a rebaseline /
   * any latch trip / a transport going stale restarts the hold. Because
   * transportFresh is time-dependent, this maintenance MUST also run at read time
   * — {@link ownStateHealthy} calls this with the current `nowSec` before reading
   * the anchor (a transport that simply goes quiet produces no edge event), and
   * {@link handleOwnerFrame} clears the anchor on a frame that arrives after a
   * staleness gap. Returns the FULL instantaneous composite so the posting-gate
   * read site avoids re-evaluating it.
   *
   * `nowSec` defaults to `deps.now()` for the edge-mutation callers (each reads
   * the clock at its own edge); read sites pass an explicit `nowSec` so the whole
   * §5.1 evaluation within a tick shares one clock sample.
   */
  private recomputeOwnStateHealth(nowSec: number = this.deps.now()): boolean {
    this.ownStateSession.healthy =
      this.ownStateSession.ready &&
      this.ownStateSession.lastStatus === 'connected' &&
      !this.streamOverflowDegraded &&
      !this.ownStateSession.positionsTruncated &&
      this.ownStateSession.lastError?.reason !== 'fatal' &&
      !this.tokenRefreshFailureInFlight;
    const instant = this.instantOwnStateHealthy(nowSec);
    if (instant) {
      if (this.healthyEligibleSinceSec === null) this.healthyEligibleSinceSec = nowSec;
    } else {
      this.healthyEligibleSinceSec = null;
    }
    return instant;
  }

  /**
   * §5 latch 2 (`transportFresh`, Phase 3 PR2b) — TIME-DEPENDENT: a frame (any
   * frame, including a heartbeat — see {@link handleOwnerFrame}) arrived within
   * `ownState.staleMaxMs`. False before the first frame (`lastFrameAtSec` null).
   *
   * Clock note: `nowSec` / `lastFrameAtSec` are unix SECONDS and `staleMaxMs` is
   * MILLISECONDS, so the elapsed seconds are scaled by 1000 (same idiom as the
   * recovery-hold comparison). The whole-second clock quantizes the effective
   * window to whole seconds in production.
   */
  private transportFresh(nowSec: number): boolean {
    return (
      this.lastFrameAtSec !== null &&
      (nowSec - this.lastFrameAtSec) * 1000 < this.config.ownState.staleMaxMs
    );
  }

  /**
   * The FULL instantaneous own-state mirror at `nowSec`: the stored edge-latch
   * mirror ({@link recomputeOwnStateHealth}) AND the time-dependent
   * {@link transportFresh} (latch 2). This — NOT the bare `shadow.healthy` — is
   * what the divergence comparator and the posting gate gate on, so a transport
   * that has gone silent (connected per `lastStatus` but delivering no frames)
   * is treated as a stale shadow. Pure read (no anchor side-effect); the posting
   * gate maintains the anchor separately via {@link recomputeOwnStateHealth}.
   */
  private instantOwnStateHealthy(nowSec: number): boolean {
    return this.ownStateSession.healthy && this.transportFresh(nowSec);
  }

  /**
   * The composite own-state health GATE for the §5.1 POSTING decision (own-state
   * SSE plan §5, Phase 3 PR2): the FULL instantaneous mirror
   * ({@link instantOwnStateHealthy} — the edge mirror AND `transportFresh`,
   * returned by {@link recomputeOwnStateHealth}) AND the recovery hold (latch 8) —
   * the composite has been continuously healthy for at least
   * `ownState.recoveryHoldMs`. The recovery hold is a posting-only anti-flap delay,
   * which is why the divergence comparator gates on {@link instantOwnStateHealthy}
   * (the full instant, WITHOUT the recovery hold) instead — see
   * {@link runAuditComparator}.
   *
   * Clock note: `deps.now()` is unix SECONDS and `recoveryHoldMs` is MILLISECONDS,
   * so the comparison scales the seconds delta by 1000 (mirrors the funding guard's
   * `checkIntervalMs` math). Because the clock is whole-seconds, the effective hold
   * is quantized to whole seconds in production — e.g. any `recoveryHoldMs` in
   * 1..1000 yields a 1s hold, and the window can open up to ~1s early relative to
   * the nominal ms (the anchor second was already in progress when it was stamped).
   * `recoveryHoldMs: 0` is immediate. The posting-only latches AND in below: latch 6
   * (`indexerLagDegraded`, PR2c-i) and latch 5 (`auditDivergenceUnresolved`, PR2c-ii).
   *
   * Calls {@link recomputeOwnStateHealth} with `nowSec` FIRST — re-deriving the
   * edge mirror (idempotent) and re-maintaining the recovery-hold anchor against
   * the full composite at this read instant. This is load-bearing: latch 2
   * (`transportFresh`) decays with no SDK event, so reading a stored mirror would
   * miss a transport that went silent since the last edge — the gate (and the
   * anchor) must be re-evaluated with the current clock at the read.
   */
  private ownStateHealthy(nowSec: number = this.deps.now()): boolean {
    const instant = this.recomputeOwnStateHealth(nowSec);
    if (!instant) return false;
    // §5 POSTING-only latch 6 (`indexerLagDegraded`, PR2c-i): the indexer must be
    // keeping up. ANDed in HERE (the posting gate), deliberately NOT in the edge
    // mirror or `instantOwnStateHealthy` (the comparator gate): it is a
    // posting-safety signal, not a shadow-freshness one — so it holds posting WITHOUT
    // suppressing the audit and WITHOUT resetting the recovery-hold anchor (which the
    // recompute above maintains on the transport composite only).
    if (this.indexerLagDegraded) return false;
    // §5 POSTING-only latch 5 (`auditDivergenceUnresolved`, PR2c-ii): a persistent
    // shadow-vs-canonical divergence means the own-state view is suspect — hold posting.
    // Same placement rationale as latch 6, PLUS the load-bearing decouple: the comparator
    // that PRODUCES this latch gates on `instantOwnStateHealthy` (which excludes latch 5),
    // so a latched divergence never suppresses the comparison that can clear it.
    if (this.auditDivergenceUnresolved) return false;
    if (this.healthyEligibleSinceSec === null) return false; // defensive — recompute sets it iff instant
    return (nowSec - this.healthyEligibleSinceSec) * 1000 >= this.config.ownState.recoveryHoldMs;
  }

  /**
   * §5.1 own-state-health posting gate (own-state SSE plan, Hermes-locked).
   * Returns `true` — meaning {@link reconcileMarkets} must refuse NEW posting —
   * when the runner is LIVE and SUBSCRIBED and the composite own-state health is
   * degraded: we can't trust our own commitment/fill/position view, so adding (or
   * compounding) exposure is unsafe. Inert in dry-run (nothing posts) and in
   * poll-only mode (`subscribe: false` ⇒ no SSE health to assess), mirroring the
   * funding guard's live-only hold; the gate therefore stays DORMANT until PR3b
   * flips `subscribe: true`.
   *
   * Emits `stream-health-hold` ONLY on an enter/clear transition (a sustained
   * hold must not spam the log — same discipline as {@link setFundingHold}),
   * with `severity: 'high'` iff there is open exposure to protect, `'low'`
   * otherwise. The active cancel-sweep posture for `exposure > 0` (§5.1) lands in
   * PR3b alongside the source cutover, when the gate first goes live; PR2a halts
   * new posting and surfaces the high-severity signal that documents the posture.
   */
  private updateStreamHealthHold(nowSec: number): boolean {
    const holding = !this.config.mode.dryRun && this.config.ownState.subscribe && !this.ownStateHealthy(nowSec);
    if (holding === this.streamHealthHolding) return holding; // no transition — stay quiet
    this.streamHealthHolding = holding;
    if (holding) {
      const exposureWei6 = computeOpenExposureWei6(this.state, nowSec, this.config.orders.expiryReleaseGraceSeconds);
      this.eventLog.emit('stream-health-hold', {
        state: 'entered',
        severity: exposureWei6 > 0n ? 'high' : 'low',
        exposureWei6: exposureWei6.toString(),
      });
      this.deps.log(`[runner] own-state health hold ENTERED — halting new posting (open exposure ${exposureWei6} wei6)`);
    } else {
      this.eventLog.emit('stream-health-hold', { state: 'cleared' });
      // Matches the setFundingHold log style — no unconditional "posting resumes"
      // claim, since a boot / funding hold may still gate this same reconcile pass.
      this.deps.log('[runner] own-state health hold cleared (posting may resume unless another hold is active)');
    }
    return holding;
  }

  /**
   * §5 latch 6 (`indexerLagDegraded`, Phase 3 PR2c-i). Polls the GLOBAL indexer-lag
   * probe `client.ownState.health()` — throttled to `ownState.auditPollIntervalMs`
   * — and sets {@link indexerLagDegraded} = `indexerLagSeconds >= indexerLagMaxSeconds`.
   * A poll FAILURE fails closed (latch degraded): an indexer we can't assess must not
   * let the MM add exposure, mirroring {@link checkFunding}'s read-failure posture
   * (always fail-closed here — no opt-out knob, unlike `fundingGuard.failClosedOnReadError`).
   * The latch holds its value between polls; {@link ownStateHealthy} reads it on each
   * posting decision. The caller gates this to `ownState.subscribe` (the own-state gate
   * is subscribe-only); it runs in dry-run+subscribe too (observability — the gate is
   * dormant there, like the comparator). No signer / token (global probe).
   */
  private async checkIndexerLag(): Promise<void> {
    const nowSec = this.deps.now();
    // Throttle the poll (it costs an API call; indexer lag moves slowly). Between
    // polls the latch persists — fail-safe: a degraded latch (from a lagging or
    // failed poll) stays set until a successful in-bounds poll clears it.
    if (this.lastAuditPollAtSec !== null && (nowSec - this.lastAuditPollAtSec) * 1000 < this.config.ownState.auditPollIntervalMs) {
      return;
    }
    this.lastAuditPollAtSec = nowSec;

    let health: OwnStateHealth;
    try {
      health = await this.adapter.getOwnStateHealth();
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'own-state-health-poll' });
      this.setIndexerLagDegraded(true, { reason: 'poll-failed' });
      return;
    }
    const lagSeconds = health.indexerLagSeconds;
    // A non-finite reading (e.g. a malformed `1e400` → Infinity that the wire
    // schema's `z.number()` still accepts) is UNUSABLE: the `>=` threshold compare
    // is meaningless on it and the telemetry emit would reject a non-finite payload.
    // Treat it like a poll failure — fail closed (UNKNOWN ⇒ degraded), don't pass it
    // through ([[feedback_defensive_bounds_unknown_not_null]]).
    if (!Number.isFinite(lagSeconds)) {
      this.eventLog.emit('error', { class: 'OwnStateHealthMalformed', detail: `non-finite indexerLagSeconds: ${String(lagSeconds)}`, phase: 'own-state-health-poll' });
      this.setIndexerLagDegraded(true, { reason: 'poll-failed' });
      return;
    }
    const maxSeconds = this.config.ownState.indexerLagMaxSeconds;
    this.setIndexerLagDegraded(lagSeconds >= maxSeconds, {
      reason: 'indexer-lag',
      indexerLagSeconds: lagSeconds,
      indexerLagMaxSeconds: maxSeconds,
      lagSource: health.lagSource,
    });
  }

  /**
   * Set {@link indexerLagDegraded} and emit `stream-health-degraded` ONLY on the
   * false→true (enter-degraded) edge — once per degraded episode, NOT every poll —
   * matching the `queue-overflow` variant's emit-on-degrade shape (reason-discriminated,
   * no `state` field). The latch is ALWAYS updated; the clear is silent (recovery is
   * observable via the composite `stream-health-hold {state:'cleared'}` when the gate
   * is live). `reason: 'indexer-lag'` carries the lag numbers; `'poll-failed'` is the
   * fail-closed case (no lag number — the poll threw).
   */
  private setIndexerLagDegraded(
    degraded: boolean,
    ctx: { reason: 'indexer-lag' | 'poll-failed'; indexerLagSeconds?: number; indexerLagMaxSeconds?: number; lagSource?: string },
  ): void {
    const wasDegraded = this.indexerLagDegraded;
    this.indexerLagDegraded = degraded;
    if (!degraded || wasDegraded) return; // emit only on enter-degraded; silent on clear / no-change
    const payload: Record<string, unknown> = { reason: ctx.reason };
    if (ctx.indexerLagSeconds !== undefined) payload.indexerLagSeconds = ctx.indexerLagSeconds;
    if (ctx.indexerLagMaxSeconds !== undefined) payload.indexerLagMaxSeconds = ctx.indexerLagMaxSeconds;
    if (ctx.lagSource !== undefined) payload.lagSource = ctx.lagSource;
    this.eventLog.emit('stream-health-degraded', payload);
    this.deps.log(
      `[runner] indexer-lag posting gate degraded (${ctx.reason})` +
        (ctx.indexerLagSeconds !== undefined && ctx.indexerLagMaxSeconds !== undefined
          ? ` — lag ${ctx.indexerLagSeconds}s vs max ${ctx.indexerLagMaxSeconds}s`
          : ''),
    );
  }

  /**
   * Run the Phase 2 PR5 shadow-vs-canonical comparator (own-state-sse-plan §6.3).
   * Called once per tick AFTER the post-tick `drainOwnState`. Records the
   * poll-side observation timestamp, latches `firstAuditPollAfterReady`
   * when appropriate, and runs the comparator when the precondition gate
   * holds. Comparator output (an aggregated `divergence` payload OR `null`)
   * drives a single `divergence` telemetry emit per tick.
   *
   * Precondition gate (Hermes-required):
   *   - `config.ownState.subscribe: true` — the stream is even opted in;
   *   - `instantOwnStateHealthy(now)` — the FULL instantaneous mirror: the edge
   *     latches (ready + connected + no overflow / fatal / positionsTruncated +
   *     no token-refresh failure) AND `transportFresh` (latch 2 — a frame within
   *     `staleMaxMs`, so a silently-dead transport isn't audited against fresh
   *     canonical). Deliberately NOT the posting gate `ownStateHealthy()`: the
   *     audit path must not inherit the posting recovery hold (latch 8) nor be
   *     gated by the audit-divergence latch (latch 5, PR2c) it produces — see the
   *     decoupling note at the read site below (Phase 3 PR2);
   *   - `ownStateQueue.size === 0` — no pending events would alter the shadow;
   *   - `firstAuditPollAfterReady` — at least one tick has completed since
   *     `shadow.ready` flipped true (otherwise canonical is stale relative
   *     to a fresh shadow and every row reads as divergent).
   *
   * Read-only on canonical state: no `MakerState` writes (the audit never touches
   * `this.state`). Besides emitting `divergence`, it sets the POSTING-only latch 5
   * (`auditDivergenceUnresolved`, PR2c-ii) from `payload !== null` — which, in live +
   * subscribe, holds NEW posting via the §5.1 gate. The latch is read ONLY by
   * {@link ownStateHealthy} (NOT the `instantOwnStateHealthy` gate this method itself
   * uses), so producing it can never suppress the next comparison that clears it.
   */
  private runAuditComparator(): void {
    const nowMs = Date.now();
    const nowSec = this.deps.now();
    // Record this tick's audit-poll observation timestamp regardless of whether
    // we'll compare — the next compareAuditVsCanonical call needs it.
    this.lastPollObsAtMs = nowMs;
    // Latch firstAuditPollAfterReady: this tick just completed a pre+tick+post
    // drainOwnState cycle with `shadow.ready === true`; the canonical side is
    // now post-ready, so the comparator can fire on the NEXT iteration.
    if (this.ownStateSession.ready && !this.firstAuditPollAfterReady) {
      this.firstAuditPollAfterReady = true;
      // Don't compare on the same tick the latch first flips — give the next
      // tick's pre-drainOwnState + tick a chance to refresh canonical first.
      // (The plan's wording: "firstPollAfterReadyDone — need ≥1 poll completed
      // since shadow became ready". Setting the latch this tick means the
      // poll completed this tick; the comparator runs FROM the next tick.)
      return;
    }
    if (!this.config.ownState.subscribe) return;
    // Gate on the FULL INSTANTANEOUS mirror — the edge latches (ready + connected
    // + no overflow / truncation / fatal / token-refresh failure) AND the
    // time-dependent `transportFresh` (latch 2) — NOT the posting gate
    // `ownStateHealthy()`. transportFresh belongs here: a transport that has gone
    // silent (still `connected` per lastStatus but delivering no frames) holds a
    // STALE shadow, and auditing it against fresh canonical would manufacture
    // divergence. But the comparator must NOT inherit the recovery hold (latch
    // 8 — a posting-only anti-flap delay; suppressing audit for 30s after every
    // blip would hide a real divergence), and it must NOT be gated by the
    // audit-divergence latch (§5 latch 5, PR2c) that it itself produces — doing
    // so would self-deadlock (a latched divergence suppresses the comparator that
    // would clear it). So latch 5 + the recovery hold live ONLY in
    // `ownStateHealthy()` (posting); this full instant mirror feeds the audit gate.
    if (!this.instantOwnStateHealthy(nowSec)) return;
    if (this.ownStateQueueSizeForTest() !== 0) return;
    if (!this.firstAuditPollAfterReady) return;
    const payload = compareAuditVsCanonical(
      this.state, // canonical — SSE-derived (post PR3b source flip)
      this.auditState, // audit — poll-derived
      this.divergenceTracker,
      nowMs,
      this.config.ownState.divergenceToleranceMs,
      this.ownStateSession.lastEventAtMs, // canonical (SSE) last-event observation
      this.lastPollObsAtMs, // audit (poll) last observation
    );
    // §5 latch 5 (PR2c-ii): a non-null payload IS an emit-worthy (persistent) divergence
    // — set the posting-only latch; a null payload means the audit is clean → clear it.
    // This runs only when the comparator's preconditions hold (subscribe + instant-healthy
    // + empty queue + first-poll-done); across early-returns the latch persists, and a
    // rebaseline clears it with the tracker. Because the latch is read ONLY by
    // `ownStateHealthy` (NOT the `instantOwnStateHealthy` gate above), setting it here can
    // never suppress the next comparison that would clear it — no self-deadlock.
    this.auditDivergenceUnresolved = payload !== null;
    if (payload === null) return;
    this.eventLog.emit('divergence', payload as unknown as Record<string, unknown>);
  }

  /**
   * Test seam — exposes the own-state SSE session (transport/health/baseline
   * bits) for assertions in `runner.test.ts`. Returns the live reference; tests
   * must not mutate it. The canonical book (commitments/positions) lives on
   * {@link stateForTest} now (PR3b source flip), NOT here.
   */
  ownStateSessionView(): Readonly<OwnStateSession> {
    return this.ownStateSession;
  }

  /**
   * Test seam — exposes the canonical `MakerState` (commitments / positions /
   * cursor / pnl). Post PR3b source flip this is the SSE-written book in
   * subscribe mode (the poll-written book in backout). Returns the live
   * reference; tests must not mutate it.
   */
  stateForTest(): Readonly<MakerState> {
    return this.state;
  }

  /**
   * Test seam — exposes the AUDIT `MakerState` (poll-derived, subscribe mode)
   * that {@link compareAuditVsCanonical} cross-checks against canonical. Returns
   * the live reference; tests must not mutate it.
   */
  auditStateForTest(): Readonly<MakerState> {
    return this.auditState;
  }

  /**
   * Test seam — evaluates the composite §5 health GATE ({@link ownStateHealthy})
   * at the current `deps.now()`, so PR2 tests can assert the recovery-hold timing
   * (latch-healthy but gate-false until `recoveryHoldMs` elapses) by advancing the
   * injected clock. Distinct from `ownStateSessionView().healthy`, which is the
   * EDGE-latch mirror only — WITHOUT the time-dependent `transportFresh` latch
   * (latch 2) AND WITHOUT the recovery hold, both of which the gate adds.
   */
  ownStateHealthyForTest(): boolean {
    return this.ownStateHealthy();
  }

  /**
   * Test seam — exposes the current subscription handle for adversarial
   * lifecycle-invariant tests (PR4a). Tests swap this out and verify that
   * the prior subscription's callbacks no-op.
   */
  currentOwnStateSubscriptionForTest(): Subscription | null {
    return this.currentOwnStateSubscription;
  }

  /**
   * Test seam — sets `this.currentOwnStateSubscription` to a sentinel value
   * for the lifecycle-invariant adversarial test (PR4a). The sentinel makes
   * the identity check `mySub === current` false from the prior subscription's
   * point of view, so its handlers must no-op.
   */
  setCurrentOwnStateSubscriptionForTest(sub: Subscription | null): void {
    this.currentOwnStateSubscription = sub;
  }

  /**
   * Test seam — sets the `streamOverflowDegraded` latch directly so tests can
   * exercise the connected/resync gating without driving the full overflow
   * detection path through `drainOwnState` (PR4a round 2 / Hermes #68 review).
   * Re-derives composite health (Phase 3 PR2) so the seam mirrors the production
   * latch-mutation sites — directly setting the latch without recomputing would
   * leave `shadow.healthy` / the recovery-hold anchor stale and the seam would
   * silently fail to model production ([[feedback_enforce_invariant_every_site]]).
   */
  setStreamOverflowDegradedForTest(value: boolean): void {
    this.streamOverflowDegraded = value;
    this.recomputeOwnStateHealth();
  }

  /** Test seam — reads the `streamOverflowDegraded` latch. */
  streamOverflowDegradedForTest(): boolean {
    return this.streamOverflowDegraded;
  }

  /**
   * Test seam — evaluates the time-dependent `transportFresh` latch (latch 2,
   * PR2b) at an explicit `nowSec`, so tests can assert freshness decay across the
   * injected clock without reaching into private state.
   */
  transportFreshForTest(nowSec: number): boolean {
    return this.transportFresh(nowSec);
  }

  /** Test seam — the unix-second timestamp of the last own-state frame (PR2b), or null. */
  lastFrameAtSecForTest(): number | null {
    return this.lastFrameAtSec;
  }

  /** Test seam — reads the `tokenRefreshFailureInFlight` latch (latch 7, PR2b). */
  tokenRefreshFailureForTest(): boolean {
    return this.tokenRefreshFailureInFlight;
  }

  /**
   * Test seam — sets the `indexerLagDegraded` latch (latch 6, PR2c-i) directly so
   * tests can exercise the posting gate without driving the throttled poll. Unlike
   * the overflow seam this needs NO recompute — latch 6 is posting-only (read live by
   * {@link ownStateHealthy}), not part of the edge mirror / comparator gate.
   */
  setIndexerLagDegradedForTest(value: boolean): void {
    this.indexerLagDegraded = value;
  }

  /** Test seam — reads the `indexerLagDegraded` latch (latch 6, PR2c-i). */
  indexerLagDegradedForTest(): boolean {
    return this.indexerLagDegraded;
  }

  /**
   * Test seam — sets the `auditDivergenceUnresolved` latch (latch 5, PR2c-ii) directly
   * so tests can exercise the posting gate + the comparator decouple without driving a
   * persistent divergence through the tolerance window. Posting-only (read live by
   * {@link ownStateHealthy}); no recompute needed.
   */
  setAuditDivergenceUnresolvedForTest(value: boolean): void {
    this.auditDivergenceUnresolved = value;
  }

  /** Test seam — reads the `auditDivergenceUnresolved` latch (latch 5, PR2c-ii). */
  auditDivergenceUnresolvedForTest(): boolean {
    return this.auditDivergenceUnresolved;
  }

  /** Test seam — current `ownStateQueue` occupancy (PR4b round 2 / Hermes #69). */
  ownStateQueueSizeForTest(): number {
    return this.ownStateQueue.size;
  }

  /**
   * Test seam — current divergence-tracker occupancy (PR5 comparator). Non-zero
   * iff `runAuditComparator` actually invoked `compareShadowVsCanonical` (the
   * tracker is populated only inside it, after the precondition gate). PR2b uses
   * this to prove the comparator gate reads `instantOwnStateHealthy` — a stale
   * transport with a healthy edge mirror must leave the tracker empty (the audit
   * was skipped), not populated.
   */
  divergenceTrackerSizeForTest(): number {
    return this.divergenceTracker.size;
  }

  /** Test seam — the in-memory `state.ownStateCursor` (own-state SSE plan §4.1, Phase 3 PR1). */
  ownStateCursorForTest(): string | undefined {
    return this.state.ownStateCursor;
  }

  /**
   * Live-mode soft-cancelled-fill convergence (DESIGN §9, §10). A commitment the MM
   * soft-cancelled off-chain (`lifecycle: 'softCancelled'`) is API-*hidden* from
   * `listOpenCommitments`, so `detectFills` never probes it — yet its stale signed
   * payload stays matchable on chain until expiry, and a taker can match it. The
   * resulting maker risk shows up in `pollPositionStatus`'s aggregate (which converges
   * the *position*), but the originating commitment record is left stranded
   * `softCancelled` with `filledRiskWei6: '0'` — a split-brain the risk engine reads
   * wrong. This step closes that: for each `softCancelled` record it reads the
   * AUTHORITATIVE cumulative `filledRiskAmount` from `getCommitment(hash)` (a shipped
   * data-layer fix returns the real cumulative fill even for hidden / soft-cancelled
   * rows) and converges the record's `filledRiskWei6` up to it — commitment-only, no
   * position mutation (positions are `pollPositionStatus`'s job; touching them here
   * would double-count).
   *
   * **Cumulative, never additive, never decreasing** — `reducePolledSoftCancelledObservation`
   * (in `src/reducers/poll.ts`) sets `filledRiskWei6 = min(apiCumulative, riskAmount)` only when it would grow.
   * For a *visible* matched commitment `detectFills` converges to the same API
   * cumulative; whichever path runs first applies the change, the other sees
   * `apiCumulative <= local` and no-ops — so there's no double-count even though both
   * paths target the same number. Soft-cancelled records are reached ONLY here.
   *
   * **Status is NOT consulted.** A hidden row presents effective status `'cancelled'`
   * for backward-compat — that is *not* what we use. The lifecycle is derived purely
   * from the (clamped) cumulative fill: `f < risk` → stays `softCancelled` (still
   * book-hidden + matchable on chain, just partially matched — `reconcileSoftCancelledFills`
   * keeps owning it, and the risk engine counts the remainder); `f >= risk` → `filled`.
   *
   * **Fail-closed.** If `getCommitment(hash)` throws — a network error, or a 404 for a
   * still-matchable signed payload — we must NOT treat the record as resolved /
   * unfilled or let `ageOut` terminalize it this tick: it could have just matched. The
   * record stays `softCancelled`, an `error` (`class: 'SoftCancelledProbeFailed'`) is
   * emitted, and the step returns `false` so `tick()` skips `settleAndClaim` /
   * `reconcileMarkets` / `ageOut` (the same fail-closed posture as a lost position
   * poll). Returns `true` when every probe succeeded — or when there were no
   * `softCancelled` records (nothing to do).
   */
  private async reconcileSoftCancelledFills(): Promise<boolean> {
    if (this.makerAddress === null) return true; // dry-run path — defensive (the caller skips); treat as ok
    // PR3b: AUDIT over this.auditState when subscribe (cross-check; never gates
    // trading); canonical this.state in backout (poll-canonical, fail-closed).
    const subscribe = this.config.ownState.subscribe;
    const target = subscribe ? this.auditState : this.state;
    const source: 'poll' | 'audit' = subscribe ? 'audit' : 'poll';
    const now = this.deps.now();
    const softCancelled = Object.values(target.commitments).filter((r) => r.lifecycle === 'softCancelled');
    if (softCancelled.length === 0) return true; // nothing soft-cancelled → nothing to converge
    let allProbesOk = true;
    for (const record of softCancelled) {
      let observation:
        | { kind: 'probed'; record: MakerCommitmentRecord; apiCumulativeWei6: bigint }
        | { kind: 'probe-failed'; record: MakerCommitmentRecord; err: unknown };
      try {
        const apiCommitment = await this.adapter.getCommitment(record.hash as Hex);
        observation = { kind: 'probed', record, apiCumulativeWei6: BigInt(apiCommitment.filledRiskAmount) };
      } catch (err) {
        observation = { kind: 'probe-failed', record, err };
      }
      const descriptors = reducePolledSoftCancelledObservation(target, observation, now);
      const result = this.applyDescriptors(descriptors, source);
      if (result.softCancelledProbeFailed) allProbesOk = false;
    }
    return subscribe ? true : allProbesOk; // audit never gates trading
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
    // PR3b: AUDIT over this.auditState when subscribe (cross-check; never gates
    // trading); canonical this.state in backout. detectFills already reseeded
    // this.auditState from canonical this tick, so the position convergence
    // resolves identity against the audit clone's commitments.
    const subscribe = this.config.ownState.subscribe;
    const target = subscribe ? this.auditState : this.state;
    const source: 'poll' | 'audit' = subscribe ? 'audit' : 'poll';
    const now = this.deps.now();
    let status: PositionStatus;
    try {
      status = await this.adapter.getPositionStatus(this.makerAddress);
    } catch (err) {
      this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'position-poll' });
      return subscribe ? true : false; // backout: caller fails closed iff non-terminal softCancelled commitments exist; audit: never gates
    }
    for (const p of status.active) {
      const descriptors = reducePolledPositionObservation(target, 'active', p as PolledPositionInput, undefined, undefined, now);
      this.applyDescriptors(descriptors, source);
    }
    for (const p of status.pendingSettle) {
      const descriptors = reducePolledPositionObservation(target, 'pendingSettle', p as PolledPositionInput, p.result, p.predictedWinSide, now);
      this.applyDescriptors(descriptors, source);
    }
    for (const p of status.claimable) {
      const descriptors = reducePolledPositionObservation(target, 'claimable', p as PolledPositionInput, p.result, undefined, now);
      this.applyDescriptors(descriptors, source);
    }
    return true;
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

    // NB: deliberately NOT behind the §5.1 own-state posting gate. `approveUSDC`
    // raises the PositionModule USDC allowance CEILING (raise-only — see the
    // `currentAllowance >= target` skip above); it creates no matchable commitment
    // and no position, so it is not "new exposure" under §5.1 (matchability comes
    // only from `submitCommitment`). Whether the wallet can BACK its exposure is
    // the funding guard's concern (`fundingHold`), not the own-state health gate's.
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
   *     `adapter.ensureSpeculationSettled({ speculationId })` (idempotent). If we
   *     sent the settle tx → emit `settle` carrying the on-chain `winSide` +
   *     `txHash` + `gasPolWei`. If it was already settled (pre-flight) or recovered
   *     from a concurrent settle → emit `candidate` `skipReason: 'already-settled'`
   *     (info, not error); a recovered inclusion-time revert of ours still bills its
   *     gas (`gasPolWei`) or flags `gasAccountingGap`. No local status flip — the
   *     next `pollPositionStatus` observes the bucket change to `claimable` and runs
   *     the `position-transition` event through `reducePolledPositionObservation`. Only a genuine
   *     settle failure (e.g. contest not yet scored) surfaces as `error`
   *     `phase: 'settle'`; the tick continues regardless.
   *   - For each record at `status: 'claimable'` with `settlement.autoClaimOwn`,
   *     gas-verdict (same `mayUseReserve` rule) →
   *     `adapter.ensurePositionClaimed({ speculationId, positionType })`
   *     (idempotent). A fresh claim → emit `claim` carrying the event-sourced
   *     `payoutWei6` + `txHash` + `gasPolWei`. If it was already claimed
   *     (pre-flight) or recovered from a benign already-claimed race → emit
   *     `candidate` `skipReason: 'already-claimed'` (info, not error) — NO `claim`
   *     event and NO payout (the contract zeroes economic fields post-claim, so
   *     none is derived); a recovered inclusion-time revert of ours still bills
   *     its gas (`gasPolWei`) or flags `gasAccountingGap`. EVERY success outcome
   *     stamps the record's `status = 'claimed'` so a later poll (with the
   *     position now absent from the API) doesn't re-attempt. Only a genuine
   *     `NotSettled` / `NoPayout` / RPC failure surfaces as `error` `phase: 'claim'`.
   *
   * Gas accumulates into `state.dailyCounters[YYYY-MM-DD].gasPolWei`; the
   * `gas-budget-blocks-settlement` `candidate` skip fires when the verdict denies.
   * Genuine errors (the ensure-helpers throw — e.g. contest not yet scored,
   * `NotSettled` / `NoPayout`, RPC) are logged (`error` `phase: 'settle' | 'claim'`)
   * and the tick continues; the next poll re-reads chain state. A benign
   * "already settled" / "already claimed" by another caller is NOT an error —
   * it's the idempotent `candidate` skip described above (no event, no payout).
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

    // Snapshot the records up front — the claim leg (`ensurePositionClaimed`)
    // mutates `state.positions` (sets `status: 'claimed'` on every success
    // outcome), and modifying an object while iterating its
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

      // Idempotent settle: under multi-wallet postgame contention another EOA
      // may have already settled this speculation. `ensureSpeculationSettled`
      // resolves to success in that case (no tx) instead of reverting, so a
      // lost race is a boring skip, not an error. A genuine failure (e.g. the
      // contest isn't scored yet) still throws → the error path below.
      let result: Awaited<ReturnType<OspexAdapter['ensureSpeculationSettled']>>;
      try {
        result = await this.adapter.ensureSpeculationSettled({ speculationId: BigInt(r.speculationId) });
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'settle', speculationId: r.speculationId });
        continue;
      }
      if (result.receipt !== undefined && result.txHash !== undefined) {
        // We sent a settle tx that confirmed — debit gas and emit the settle
        // event, unchanged shape.
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
      } else {
        // Already settled (pre-flight read) or recovered from a concurrent
        // settle — the goal is achieved without a confirmed tx of ours. Record
        // a settle-skip (info, not error); we don't fake a txHash or force the
        // local bucket (the position poll flips it to `claimable` next tick).
        //
        // Gas accounting: a recovered *inclusion-time* race DID broadcast a
        // settle that reverted (POL spent). The SDK returns its `revertedReceipt`
        // so we MUST debit that gas — every tx this wallet broadcasts is
        // accounted, even reverted ones. If only `revertedTxHash` is present
        // (the SDK's receipt re-fetch failed), gas was spent but we can't bill
        // it exactly: flag the gap rather than silently report zero. Pre-flight
        // / pre-send recovery and `alreadySettled` broadcast nothing → no gas.
        let revertedGasPolWei: bigint | undefined;
        let gasAccountingGap = false;
        if (result.revertedReceipt !== undefined) {
          revertedGasPolWei =
            BigInt(result.revertedReceipt.gasUsed) * BigInt(result.revertedReceipt.effectiveGasPrice);
          this.recordGasSpentToday(today, revertedGasPolWei);
        } else if (result.revertedTxHash !== undefined) {
          gasAccountingGap = true;
        }
        this.eventLog.emit('candidate', {
          skipReason: 'already-settled',
          purpose: 'settleSpeculation',
          speculationId: r.speculationId,
          contestId: r.contestId,
          makerSide: r.side,
          outcome: result.outcome,
          winSide: result.winSide,
          ...(result.revertedTxHash !== undefined ? { revertedTxHash: result.revertedTxHash } : {}),
          ...(revertedGasPolWei !== undefined ? { gasPolWei: revertedGasPolWei.toString() } : {}),
          ...(gasAccountingGap ? { gasAccountingGap: true } : {}),
        });
      }
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
      // Idempotent claim: under multi-wallet contention, a rerun, or core-API
      // `claimable`-projection lag the position may already be claimed.
      // `ensurePositionClaimed` resolves to success in that case (no tx, no
      // payout) instead of reverting `AlreadyClaimed`, so a benign already-
      // claimed is a boring skip, not an error. A genuine failure (`NotSettled`
      // / `NoPayout` / RPC) still throws → the error path below.
      let result: Awaited<ReturnType<OspexAdapter['ensurePositionClaimed']>>;
      try {
        result = await this.adapter.ensurePositionClaimed({ speculationId: BigInt(r.speculationId), positionType });
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'claim', speculationId: r.speculationId });
        continue;
      }
      // Every success outcome means the position is (or just became) claimed —
      // stamp it now so the per-tick loop stops retrying this record (the next
      // poll drops it from the API anyway). This single stamp covers the fresh
      // claim AND the benign already-claimed/recovered skip.
      r.status = 'claimed';
      r.updatedAtUnixSec = this.deps.now();
      if (result.receipt !== undefined && result.txHash !== undefined && result.payoutWei6 !== undefined) {
        // We sent a claim tx that confirmed — debit gas and emit the `claim`
        // event with the event-sourced payout (unchanged shape).
        const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
        this.recordGasSpentToday(today, gasPolWei);
        const claimPayload: Record<string, unknown> = {
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
        };
        // Settled outcome from the API's ClaimablePositionView.result (captured
        // during the position-status poll, stored on r.result). Lets the summary
        // walker classify the position as push/void without depending on a
        // `settle` event being in the same `--since` window (closes Hermes
        // review-PR33's documented limitation).
        if (r.result !== undefined) claimPayload.result = r.result;
        this.eventLog.emit('claim', claimPayload);
      } else {
        // Already claimed (pre-flight read) or recovered from a benign already-
        // claimed race — the goal is achieved without a confirmed claim of ours.
        // We do NOT fake a `claim` event or a payout (the SDK never derives one;
        // the contract zeroes economic fields post-claim), and this never enters
        // `claimTxs`. Surface a `candidate` skip (info) instead.
        //
        // Gas accounting mirrors the settle leg: a recovered *inclusion-time*
        // race DID broadcast a claim that reverted (POL spent). The SDK returns
        // its `revertedReceipt` so we MUST debit that gas — every tx this wallet
        // broadcasts is accounted, even reverted ones. If only `revertedTxHash`
        // is present (the SDK's receipt re-fetch failed), gas was spent but we
        // can't bill it exactly: flag the gap rather than silently report zero.
        // Pre-flight / pre-send recovery and `alreadyClaimed` broadcast nothing.
        let revertedGasPolWei: bigint | undefined;
        let gasAccountingGap = false;
        if (result.revertedReceipt !== undefined) {
          revertedGasPolWei =
            BigInt(result.revertedReceipt.gasUsed) * BigInt(result.revertedReceipt.effectiveGasPrice);
          this.recordGasSpentToday(today, revertedGasPolWei);
        } else if (result.revertedTxHash !== undefined) {
          gasAccountingGap = true;
        }
        this.eventLog.emit('candidate', {
          skipReason: 'already-claimed',
          purpose: 'claimPosition',
          speculationId: r.speculationId,
          contestId: r.contestId,
          makerSide: r.side,
          outcome: result.outcome,
          ...(result.revertedTxHash !== undefined ? { revertedTxHash: result.revertedTxHash } : {}),
          ...(revertedGasPolWei !== undefined ? { gasPolWei: revertedGasPolWei.toString() } : {}),
          ...(gasAccountingGap ? { gasAccountingGap: true } : {}),
        });
      }
    }
  }

  /** Add `gasPolWei` to today's `state.dailyCounters` counter (additive; preserves `feeUsdcWei6`; lazy-creates the entry). Shared by `applyAutoApprovals` + `settleAndClaim` + `onchainKillCancel`. */
  private recordGasSpentToday(today: string, gasPolWei: bigint): void {
    const existing = this.state.dailyCounters[today];
    const prior = existing !== undefined ? BigInt(existing.gasPolWei) : 0n;
    this.state.dailyCounters[today] = {
      gasPolWei: (prior + gasPolWei).toString(),
      feeUsdcWei6: existing !== undefined ? existing.feeUsdcWei6 : '0',
    };
  }

  /**
   * Shutdown-time off-chain "soft stop" sweep (DESIGN §6 — kill switch).
   * Runs on every actual operator-triggered shutdown (`shutdownReason !== null`)
   * regardless of `killCancelOnChain`. For every `visibleOpen` commitment, calls
   * `adapter.cancelCommitmentOffchain` (gasless API DELETE) to pull the quote from
   * the book and then reclassifies the record to `softCancelled` + emits
   * `soft-cancel` `reason: 'shutdown'`. A `partiallyFilled` remainder is NOT
   * off-chain-cancelled — the API rejects a DELETE once a commitment has matched
   * (409 `COMMITMENT_MATCHED`); it's retained (a `partial-remainder-retained`
   * candidate, `reason: 'shutdown'`) and left for the authoritative
   * `onchainKillCancel` below (if `killCancelOnChain: true`) or natural expiry.
   * Either way the signed payload stays matchable on chain until natural expiry
   * unless the on-chain sweep closes that window.
   *
   * Per-record failures are logged (`error` `phase: 'cancel'`) and the loop
   * continues — pulling one record doesn't depend on another.
   */
  private async offchainKillCancel(skipHashes: Set<string> = new Set()): Promise<void> {
    if (this.makerAddress === null) return; // live-mode invariant (caller already gated on `!dryRun`)
    const records = Object.values(this.state.commitments).filter(
      (r) => r.lifecycle === 'visibleOpen' || r.lifecycle === 'partiallyFilled',
    );
    if (records.length === 0) return;

    const now = this.deps.now();
    for (const r of records) {
      if (skipHashes.has(r.hash)) continue; // M6/A pre-pass already attempted on-chain; never off-chain-hide these (would brick missing-legacy + visibleOpen into BLOCKED on the subsequent on-chain pass)
      if (r.lifecycle === 'partiallyFilled') {
        // Off-chain DELETE is rejected once matched. Retain the remainder — `onchainKillCancel`
        // below (if `killCancelOnChain: true`) authoritatively cancels it; else it rides to expiry.
        this.emitPartialRetained(r, 'shutdown');
        continue;
      }
      try {
        await this.adapter.cancelCommitmentOffchain(r.hash as Hex);
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'cancel', commitmentHash: r.hash });
        continue; // failed pull stays at original lifecycle; the on-chain sweep below (if enabled) may still authoritatively cancel it
      }
      r.lifecycle = 'softCancelled';
      r.updatedAtUnixSec = now;
      this.eventLog.emit('soft-cancel', softCancelEventPayload(r, 'shutdown'));
    }
  }

  /**
   * M6/A shutdown pre-pass (Hermes #63 — own-state SSE plan §M6). On-chain-cancel
   * every missing-legacy + visibleOpen record BEFORE {@link offchainKillCancel}
   * runs. Otherwise the off-chain DELETE flips `book_visible: false` on the API
   * row, and the SDK's later `cancelOnchain({ hash })` refuses the public fetch
   * (M2 redaction), bricking the record into the BLOCKED dispatch path.
   *
   * Returns the set of hashes this pre-pass TOUCHED (success or failure). The
   * caller passes that set into `offchainKillCancel` to keep failed pre-pass
   * records `visibleOpen` so the regular `onchainKillCancel` dispatch can retry
   * via `use-hash` (still works while visible). Success records are
   * `authoritativelyInvalidated`; the existing on-chain sweep filter excludes
   * them naturally.
   *
   * Gas budget mirrors `onchainKillCancel` (`mayUseReserve: true` — kill-switch
   * is operator-explicit). A verdict denial halts the pre-pass; the regular
   * on-chain sweep below will hit the same denial and break too — by then the
   * touched-set has already protected those records from off-chain hide.
   */
  private async preOnchainKillCancelMissingLegacyVisible(): Promise<Set<string>> {
    if (this.makerAddress === null) return new Set<string>(); // live-mode invariant
    const eligible = Object.values(this.state.commitments).filter(
      (r) => r.signedPayloadStatus === 'missing-legacy' && r.lifecycle === 'visibleOpen',
    );
    // CRITICAL (Hermes #63 round 2): populate the touched set with ALL
    // candidates UPFRONT, before attempting any cancels. A gas-denied verdict
    // breaks the loop early; if we'd added records inside the loop, later
    // candidates would lose their off-chain-skip protection and offchainKillCancel
    // would brick them into BLOCKED — the same failure mode this pre-pass exists
    // to prevent. The skip set guarantees every candidate's off-chain protection
    // even when the cancel loop only reaches some of them.
    const touched = new Set<string>(eligible.map((r) => r.hash));
    for (const r of eligible) {
      const now = this.deps.now();
      const result = await this.onchainCancelCommitment(r, now, {
        overrideDispatch: { kind: 'use-hash', hash: r.hash as Hex },
      });
      if (result === 'gas-denied') break; // remaining candidates' off-chain protection is already in `touched` from the pre-population above
      // 'cancelled' → record is now authoritativelyInvalidated (lifecycle stamped by onchainCancelCommitment)
      // 'transient-failure' → record stays visibleOpen, touched-skip prevents off-chain hide, regular on-chain retries via dispatch
      // 'blocked-missing-payload' → unreachable here (we overrode dispatch to use-hash explicitly)
    }
    return touched;
  }

  /**
   * Shutdown-time on-chain authoritative kill (DESIGN §6 / §13 — "hard stop"
   * mode). Triggered when `config.killCancelOnChain: true` AND the runner is
   * exiting via an actual operator-triggered shutdown (kill file or
   * SIGTERM/SIGINT — `shutdownReason !== null`). Runs AFTER the unconditional
   * off-chain sweep above so the soft-cancelled records (the on-chain
   * sweep's input set includes them via the `softCancelled` lifecycle) are
   * also authoritatively cancelled. Iterates every non-terminal tracked
   * commitment (`visibleOpen` / `softCancelled` / `partiallyFilled`) and
   * calls `adapter.cancelCommitmentOnchain(hash)` for each — the
   * authoritative cancel (`MatchingModule.cancelCommitment`) sets
   * `s_cancelledCommitments[hash]` on chain, after which `matchCommitment`
   * reverts. Without this, a taker holding the signed payload can still match
   * the commitment until its expiry — the off-chain DELETE only stops the
   * relay from rebroadcasting.
   *
   * Gas-gated via `canSpendGas` with `mayUseReserve: true` — `killCancelOnChain`
   * is operator-explicit "burn the reserve to make sure latent exposure is
   * killed". A verdict denial emits `candidate` `gas-budget-blocks-onchain-cancel`
   * and BREAKS the loop (subsequent cancels would deny the same way), so any
   * remaining commitments stay matchable; the operator should top up POL +
   * restart, or live with the latent window until natural expiry. An adapter
   * throw on a single hash logs `error` `phase: 'onchain-cancel'` and the loop
   * continues to the next record. Successful cancels stamp the local record
   * to `authoritativelyInvalidated` so the next boot's risk engine doesn't
   * count it.
   */
  private async onchainKillCancel(): Promise<void> {
    if (this.makerAddress === null) return; // live-mode invariant (caller already gated on `!dryRun`)
    const records = Object.values(this.state.commitments).filter(
      (r) => r.lifecycle === 'visibleOpen' || r.lifecycle === 'softCancelled' || r.lifecycle === 'partiallyFilled',
    );
    if (records.length === 0) return;

    const maxDailyGasPolWei = polFloatToWei18(this.config.gas.maxDailyGasPOL);
    const emergencyReservePolWei = polFloatToWei18(this.config.gas.emergencyReservePOL);

    for (const r of records) {
      const now = this.deps.now();
      const today = todayUTCDateString(now);
      const todayGasSpentPolWei = BigInt(this.state.dailyCounters[today]?.gasPolWei ?? '0');
      const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve: true });
      if (!verdict.allowed) {
        this.eventLog.emit('candidate', {
          skipReason: 'gas-budget-blocks-onchain-cancel',
          commitmentHash: r.hash,
          speculationId: r.speculationId,
          makerSide: r.makerSide,
          todayGasSpentPolWei: todayGasSpentPolWei.toString(),
          maxDailyGasPolWei: maxDailyGasPolWei.toString(),
          emergencyReservePolWei: emergencyReservePolWei.toString(),
          detail: verdict.reason,
        });
        // Subsequent cancels would deny the same way (today's spend only grows). Break — remaining commitments
        // stay matchable, the operator must top up POL + restart, or wait for natural expiry.
        break;
      }

      // Dispatch on signedPayloadStatus + lifecycle (own-state SSE plan §M6):
      // pre-M6/A records that are hidden are unreachable here — emit the
      // blocked telemetry and continue to the next record so the kill sweep
      // doesn't burn gas on a cancel that's guaranteed to fail.
      const dispatch = dispatchCancel(r);
      if (dispatch.kind === 'blocked-missing-payload') {
        this.eventLog.emit('cancel-blocked-missing-payload', {
          commitmentHash: r.hash,
          speculationId: r.speculationId,
          contestId: r.contestId,
          makerSide: r.makerSide,
          lifecycle: r.lifecycle,
          reason: 'missing-legacy-signed-payload-and-hidden',
          detail: 'shutdown kill swept a record that predates M6/A AND is book-hidden; cancelOnchain has no recovery path. The latent exposure rides to expiry — operator should recover the payload via owner-auth own-state if early cancel is needed.',
          phase: 'shutdown-kill',
        });
        continue;
      }
      let result: Awaited<ReturnType<OspexAdapter['cancelCommitmentOnchain']>>;
      try {
        result = await this.adapter.cancelCommitmentOnchain(
          dispatch.kind === 'use-signed-payload' ? { signedCommitment: dispatch.payload } : { hash: dispatch.hash },
        );
      } catch (err) {
        this.eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'onchain-cancel', commitmentHash: r.hash });
        continue;
      }
      const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
      this.recordGasSpentToday(today, gasPolWei);
      r.lifecycle = 'authoritativelyInvalidated';
      r.updatedAtUnixSec = now;
      this.eventLog.emit('onchain-cancel', {
        commitmentHash: r.hash,
        speculationId: r.speculationId,
        contestId: r.contestId,
        makerSide: r.makerSide,
        txHash: result.txHash,
        gasPolWei: gasPolWei.toString(),
      });
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

/**
 * Sum the maker's currently-at-risk USDC across non-released commitments +
 * non-terminal positions ({@link isTerminalPositionStatus} excludes claimed /
 * settledLost / void — none carry live exposure), in wei6. Used by the own-state overflow telemetry
 * (`stream-would-hold {exposureWei6}`) and the §5.1 `stream-health-hold` severity
 * (`high` iff > 0) — the exposure the Phase 3 PR2a posting gate protects when it
 * halts new posting on degraded own-state. Identical accounting to `inventoryFromState` minus the
 * per-item shape; keep the predicates in lockstep with `RELEASED_LIFECYCLES`
 * and `isExpiredForRelease` over there if either changes.
 */
export function computeOpenExposureWei6(state: MakerState, nowUnixSec: number, graceSeconds: number): bigint {
  let total = 0n;
  for (const c of Object.values(state.commitments)) {
    if (c.lifecycle !== 'visibleOpen' && c.lifecycle !== 'softCancelled' && c.lifecycle !== 'partiallyFilled') continue;
    if (isExpiredForRelease(c.expiryUnixSec, nowUnixSec, graceSeconds)) continue;
    const remaining = BigInt(c.riskAmountWei6) - BigInt(c.filledRiskWei6);
    if (remaining > 0n) total += remaining;
  }
  for (const p of Object.values(state.positions)) {
    if (isTerminalPositionStatus(p.status)) continue; // claimed / settledLost / void — no live exposure
    total += BigInt(p.riskAmountWei6);
  }
  return total;
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The UTC date `YYYY-MM-DD` for `unixSec` — the key into `state.dailyCounters`. UTC so a maker straddling midnight in any local timezone sees the same day boundary as another instance in another zone. Exported for the one-shot CLIs (`cancel-stale`) which need to update the same counters. */
export function todayUTCDateString(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert a config-supplied float POL value to wei18. POL has 18 decimals; budgets are typically << 1 POL so the `Number → BigInt` round-trip is exact for any realistic input. Exported for the one-shot CLIs (`cancel-stale`) which need to evaluate the same `canSpendGas` verdict. */
export function polFloatToWei18(p: number): bigint {
  return BigInt(Math.round(p * 1e18));
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

/** An orderbook `Commitment` that's still matchable (`isLive`), carries the fields the competitiveness check needs (`oddsTick` + `positionType`), and has an in-range `oddsTick` (so `inverseOddsTick` can convert it). Legacy / partially-decoded / out-of-range rows are skipped — they can't be valid matchable commitments anyway. SDK v0.5.0 (M5/PR1) narrowed `Commitment` to a discriminated `PublicVisibleCommitment | PublicHiddenCommitment` union; hidden rows have no `oddsTick` / `isLive` (those fields belong to the matchable-payload allow-list, off the public hidden surface), so the predicate refuses them up front before reaching the field reads. */
type PricedLiveCommitment = PublicVisibleCommitment & { oddsTick: number; positionType: 0 | 1 };
function isPricedLiveCommitment(c: Commitment): c is PricedLiveCommitment {
  if (c.redacted === true) return false;
  return c.isLive && c.oddsTick !== null && c.positionType !== null && isTickInRange(c.oddsTick);
}

/** The `would-soft-cancel` event payload for a pulled commitment record — the protocol commitment params (`makerSide` / `makerOddsTick` / `positionType`) plus `takerSide` (the offer side it served, `oppositeSide(makerSide)`) and the pull reason. Exported for the one-shot CLIs (`cancel-stale`) which emit the same `soft-cancel` event shape. */
export function softCancelEventPayload(record: MakerCommitmentRecord, reason: SoftCancelReason): Record<string, unknown> {
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
