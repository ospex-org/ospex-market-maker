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

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Enforced floor for `pollIntervalMs` (DESIGN §7) — the runner clamps + warns below this. */
export const POLL_INTERVAL_FLOOR_MS = 30_000;

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
  staleAfterSeconds: number;
  staleReferenceAfterSeconds: number;
  replaceOnOddsMoveBps: number;
  cancelMode: CancelMode;
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
  pricing: PricingConfig;
  risk: RiskConfig;
  gas: GasConfig;
  approvals: ApprovalsConfig;
  orders: OrdersConfig;
  settlement: SettlementConfig;
  telemetry: TelemetryConfig;
  state: StateConfig;
  killSwitchFile: string;
  killCancelOnChain: boolean;
  pollIntervalMs: number;
  mode: ModeConfig;
}
