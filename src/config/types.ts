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
 * `orders.cancelMode` (the routine partial-fill cancel policy) — the funding guard adds
 * a `none` option (just hold; let quotes ride to expiry). The guard ALWAYS halts new
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
   * Coalescing window after a wake fires before the loop drains the queue
   * (own-state-sse-plan §2.5.1). Range 250-1000ms; default 500ms.
   * Hermes-endorsed: prevents tight wake-drain churn under burst load while
   * keeping shadow-vs-canonical divergence detectable within one poll interval.
   */
  debounceMs: number;
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
