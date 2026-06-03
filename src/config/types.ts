/**
 * The ospex-mm config schema (DESIGN §7), as TypeScript. The annotated reference
 * config is `ospex-mm.example.yaml` at the repo root. Use `loadConfig` /
 * `parseConfig` from `./index.js` to get a validated, defaulted `Config`.
 */

export const KNOWN_SPORTS = ['mlb', 'nba', 'nhl', 'ncaab', 'ncaaf', 'nfl'] as const;
export type Sport = (typeof KNOWN_SPORTS)[number];

/** v0 supports only moneyline — the config schema rejects `spread` / `total`. */
export const SUPPORTED_MARKETS = ['moneyline'] as const;
export type MarketType = (typeof SUPPORTED_MARKETS)[number];

export const CHAIN_IDS = [137, 80002] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

export const SPREAD_MODES = ['economics', 'direct'] as const;
export type SpreadMode = (typeof SPREAD_MODES)[number];

export const APPROVAL_MODES = ['exact', 'unlimited'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const EXPIRY_MODES = ['fixed-seconds', 'match-time'] as const;
export type ExpiryMode = (typeof EXPIRY_MODES)[number];

export const CANCEL_MODES = ['offchain', 'onchain'] as const;
export type CancelMode = (typeof CANCEL_MODES)[number];

/**
 * What the funding guard does to EXISTING visible quotes while it holds. Distinct from
 * `orders.cancelMode` (the routine partial-fill cancel policy, which ALSO drives the §5.1
 * own-state-health active cancel-sweep) — the funding guard adds a `none` option (just
 * hold; let quotes ride to expiry). The guard ALWAYS halts new
 * posting while held regardless of this value; this only governs the active cancel sweep:
 * `offchain` pulls visible quotes off the relay (gasless, doesn't reduce on-chain exposure),
 * `onchain` also authoritatively cancels on chain (the only mode that shrinks `required` so
 * the hold can clear), `none` leaves quotes up to ride to expiry.
 */
export const UNDERFUNDED_CANCEL_MODES = ['offchain', 'onchain', 'none'] as const;
export type UnderfundedCancelMode = (typeof UNDERFUNDED_CANCEL_MODES)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Enforced floor for `pollIntervalMs` (DESIGN §7) — the runner clamps + warns below this. */
export const POLL_INTERVAL_FLOOR_MS = 30_000;

/**
 * The conservative per-IP SSE-connection cap on `ospex-core-api` (its default
 * `MAX_STREAM_CONNECTIONS_PER_IP`). Every open odds subscription — and, once they
 * land, every own-state stream — is one connection counted against this from a
 * single host; exceeding it gets the connection refused with HTTP 429. Operators
 * running their own core-api can raise the server-side cap. Used only for a
 * boot-time guardrail warning — the MM never silently rewrites the operator's caps.
 */
export const DEFAULT_PER_IP_STREAM_CAP = 10;

/**
 * Connections to hold in reserve out of {@link DEFAULT_PER_IP_STREAM_CAP} for the
 * runner's own-state streams (fills + commitments + positions) — a deferred
 * push-architecture item. Reserving them now keeps the default odds-channel cap
 * compatible with the per-IP budget once they're wired (5 odds + 3 = 8 ≤ 10).
 */
export const RESERVED_OWN_STATE_STREAMS = 3;

export interface WalletConfig {
  /** Path to a Foundry v3 keystore. May be omitted — then `OSPEX_KEYSTORE_PATH` or the SDK default applies. */
  keystorePath?: string;
}

export interface MarketSelectionConfig {
  sports: Sport[];
  markets: MarketType[];
  maxStartsWithinHours: number;
  maxTrackedContests: number;
  requireReferenceOdds: boolean;
  /** v0: only quote markets whose speculation already exists (no lazy creation). */
  requireOpenSpeculation: boolean;
  contestAllowList: string[];
  contestDenyList: string[];
}

export interface DiscoveryConfig {
  everyNTicks: number;
  jitterPct: number;
}

export interface OddsConfig {
  subscribe: boolean;
  maxRealtimeChannels: number;
}

/**
 * Own-state SSE stream config (Phase 2 PR3 — wakeable runner infrastructure).
 * Phase 2 PR3 ships the queue + wake-signal primitives only; the SSE
 * subscription itself lands in PR4 (which will add `subscribe: boolean` to
 * this section). PR3's runner builds `OwnStateShadow` + drains the (still-empty)
 * queue at each wake / tick boundary — `debounceMs` governs how long the loop
 * waits between a `wake()` and the corresponding shadow drain so SSE bursts
 * coalesce into a single drain pass.
 */
export interface OwnStateConfig {
  /**
   * Open the maker's owner-authenticated own-state SSE stream at boot
   * (Phase 2 PR4a). Default `false` — Phase 2 is opt-in until the comparator
   * (PR5) is wired and soak-validated. When `true`, the runner refuses to
   * boot in dry-run / without a `makerAddress` (the SDK's bearer-token mint
   * needs a signer that owns the configured address).
   *
   * Phase 2 shadow-only invariant: when the stream is open, events flow into
   * `OwnStateShadow` ONLY — canonical `MakerState` writes still come from
   * the poll path. Phase 3 cutover flips the source.
   */
  subscribe: boolean;
  /**
   * Coalescing window after a wake fires before the loop drains the queue
   * (own-state-sse-plan §2.5.1). Range 250-1000ms; default 500ms.
   * Hermes-endorsed: prevents tight wake-drain churn under burst load while
   * keeping shadow-vs-canonical divergence detectable within one poll interval.
   */
  debounceMs: number;
  /**
   * Tolerance window for the Phase 2 PR5 shadow-vs-canonical comparator
   * (own-state-sse-plan §6.3). A divergence is SUPPRESSED while EITHER the
   * shadow-side last observation OR the poll-side last observation is within
   * this window — both sides may legitimately see the same on-chain truth at
   * slightly different walltimes; tolerance suppresses transient skew.
   * Persistent mismatch (divergence age >= toleranceMs) is emitted regardless.
   * Range 1000-60000ms; default 5000ms.
   */
  divergenceToleranceMs: number;
  /**
   * Cadence (ms) of the own-state health poll (`client.ownState.health()`) that
   * drives the `indexerLagDegraded` health latch (own-state SSE plan §5/A4).
   * Selected only when `subscribe: true`. Range 10000-300000ms; default 60000ms.
   * (Phase 3 PR2 ships the knob; the poll itself lands in PR2c.)
   */
  auditPollIntervalMs: number;
  /**
   * The `/v1/health/own-state` `indexerLagSeconds` threshold at/above which the
   * `indexerLagDegraded` latch trips, gating posting (own-state SSE plan §5,
   * latch 6). Range 5-300s; default 30s. (Knob ships in PR2; latch in PR2c.)
   */
  indexerLagMaxSeconds: number;
  /**
   * Transport-freshness window (ms): the composite health predicate's
   * `transportFresh` latch requires a frame (`onFrame`, including heartbeats)
   * within this window — `now - lastFrameAt < staleMaxMs` (own-state SSE plan
   * §5, latch 2). MUST stay above the server's own-state heartbeat cadence (~20s)
   * — a value at/under it would mark a healthy idle connection stale every cycle
   * and permanently hold posting. Range 30000-300000ms (floor keeps margin above
   * the heartbeat); default 60000ms (≈3 heartbeats). (Latch wired in PR2b.)
   */
  staleMaxMs: number;
  /**
   * Recovery hold (ms): after all other health latches read healthy, the
   * composite predicate stays UNhealthy until they have been continuously
   * healthy for this long — prevents flapping the posting gate on a brief
   * recovery blip (own-state SSE plan §5, latch 8). Range 0-300000ms; default
   * 30000ms.
   */
  recoveryHoldMs: number;
}

export interface EconomicsConfig {
  capitalUSDC: number;
  targetMonthlyReturnPct: number;
  daysHorizon: number;
  estGamesPerDay: number;
  fillRateAssumption: number;
  capitalTurnoverPerDay: number;
  maxReasonableSpread: number;
}

export interface DirectConfig {
  spreadBps: number;
}

export interface PricingConfig {
  mode: SpreadMode;
  economics: EconomicsConfig;
  direct: DirectConfig;
  /** v0 supports only `true`. */
  quoteBothSides: boolean;
  minEdgeBps: number;
  maxPerQuotePctOfCapital: number;
}

export interface RiskConfig {
  bankrollUSDC: number;
  maxBankrollUtilizationPct: number;
  maxRiskPerCommitmentUSDC: number;
  maxRiskPerContestUSDC: number;
  maxRiskPerTeamUSDC: number;
  maxRiskPerSportUSDC: number;
  maxOpenCommitments: number;
  maxDailyFeeUSDC: number;
}

export interface GasConfig {
  maxDailyGasPOL: number;
  emergencyReservePOL: number;
  reportInUSDC: boolean;
  nativeTokenUSDCPrice: number;
}

export interface ApprovalsConfig {
  autoApprove: boolean;
  mode: ApprovalMode;
}

export interface OrdersConfig {
  expiryMode: ExpiryMode;
  expirySeconds: number;
  /**
   * Seconds past a commitment's local `expiryUnixSec` before the MM releases its
   * accounting headroom / terminalizes it as expired. The contract keeps a commitment
   * matchable until `block.timestamp >= expiry`, and the MM host / core-api clock can
   * lead the Polygon block timestamp — so headroom is held for this margin past local
   * expiry rather than freed (and reposted over) while the signed payload may still
   * match on chain. Book hygiene still treats a quote as expired at the original expiry;
   * only headroom release waits for the grace. `0` disables it (release exactly at expiry).
   */
  expiryReleaseGraceSeconds: number;
  staleAfterSeconds: number;
  staleReferenceAfterSeconds: number;
  replaceOnOddsMoveBps: number;
  /**
   * How the MM authoritatively cancels matchable commitments it no longer wants on chain.
   * `offchain` (default) pulls them off the relay (gasless, visibility-only — the signed
   * payload stays matchable until expiry); `onchain` ALSO sends an authoritative
   * `MatchingModule.cancelCommitment` (gas-gated, reserve-preserving), the only mode that
   * actually drops the exposure. Governs BOTH the routine partial-remainder / recovered
   * soft-cancel paths AND the §5.1 own-state-health active cancel-sweep (PR3b-ii) when
   * `ownState.subscribe: true` and a high-severity stream-health hold is active. (No `none`
   * opt-out — see `fundingGuard.underfundedCancelMode` for the guard that has one.)
   */
  cancelMode: CancelMode;
}

export interface FundingGuardConfig {
  /** Master switch. When false, the guard never reads funding and never holds. */
  enabled: boolean;
  /**
   * Minimum interval between on-chain funding re-reads (USDC balance + PositionModule
   * allowance). The check runs at most this often regardless of tick cadence — funding
   * changes slowly and the reads cost RPC. Independent of `pollIntervalMs`.
   */
  checkIntervalMs: number;
  /**
   * What to do with EXISTING visible quotes when underfunded: `offchain` (soft-cancel —
   * pull them off the relay, gasless) / `onchain` (also authoritatively cancel on chain) /
   * `none` (hold only, let them ride to expiry). The guard always halts NEW posting while
   * held regardless; this governs the active cancel sweep. Only `onchain` reduces the
   * on-chain exposure (`required`), so it's the only mode under which the hold clears before
   * the commitments expire naturally.
   */
  underfundedCancelMode: UnderfundedCancelMode;
  /**
   * When a balance/allowance read FAILS, enter the hold (halt new posting) rather than
   * proceed — a read failure must never let the MM post commitments it might not be
   * able to back. Strongly recommended `true`.
   */
  failClosedOnReadError: boolean;
}

export interface SettlementConfig {
  autoSettleOwn: boolean;
  autoClaimOwn: boolean;
  continueOnGasBudgetExhausted: boolean;
}

export interface TelemetryConfig {
  logDir: string;
  logLevel: LogLevel;
}

export interface StateConfig {
  dir: string;
}

export interface ModeConfig {
  dryRun: boolean;
}

export interface Config {
  wallet: WalletConfig;
  /** Required — set here or via `OSPEX_RPC_URL`. There is no public-RPC default. */
  rpcUrl: string;
  /** Optional — the SDK defaults to the production core API URL. */
  apiUrl?: string;
  chainId: ChainId;
  marketSelection: MarketSelectionConfig;
  discovery: DiscoveryConfig;
  odds: OddsConfig;
  ownState: OwnStateConfig;
  pricing: PricingConfig;
  risk: RiskConfig;
  gas: GasConfig;
  approvals: ApprovalsConfig;
  orders: OrdersConfig;
  fundingGuard: FundingGuardConfig;
  settlement: SettlementConfig;
  telemetry: TelemetryConfig;
  state: StateConfig;
  killSwitchFile: string;
  killCancelOnChain: boolean;
  pollIntervalMs: number;
  mode: ModeConfig;
}
