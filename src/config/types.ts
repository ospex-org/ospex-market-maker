/**
 * The ospex-mm config schema (DESIGN §7), as TypeScript. The annotated reference
 * config is `ospex-mm.example.yaml` at the repo root. Use `loadConfig` /
 * `parseConfig` from `./index.js` to get a validated, defaulted `Config`.
 */

export const KNOWN_SPORTS = ['mlb', 'nba', 'nhl', 'ncaab', 'ncaaf', 'nfl'] as const;
export type Sport = (typeof KNOWN_SPORTS)[number];

/** The market types `marketSelection.markets` accepts. The default is moneyline only — spread / total are opt-in. */
export const SUPPORTED_MARKETS = ['moneyline', 'spread', 'total'] as const;
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

/**
 * The per-IP SSE-connection cap on `ospex-core-api` (its default
 * `MAX_STREAM_CONNECTIONS_PER_IP`). Every open odds subscription AND the
 * owner-auth own-state stream is one connection counted against this — and the
 * cap is per **egress IP / host**, so it is SHARED across every MM instance
 * running on that host, not per process. Exceeding it gets the connection
 * refused with HTTP 429. Operators running their own core-api can raise the
 * server-side cap. Used only for a boot-time guardrail warning — the MM never
 * silently rewrites the operator's caps. Mirrors the core-api default (keep in
 * lockstep if that default changes).
 */
export const DEFAULT_PER_IP_STREAM_CAP = 16;

/**
 * Of {@link DEFAULT_PER_IP_STREAM_CAP}, the per-IP slots `ospex-core-api` reserves
 * for the owner-authenticated own-state stream (its default
 * `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER`). **Anonymous** streams — the odds
 * subscriptions — may use at most `DEFAULT_PER_IP_STREAM_CAP - this` per IP; the
 * reserve keeps the safety-critical own-state stream from being 429'd by anonymous
 * saturation. So the binding budget for odds channels is the *anonymous* one
 * (16 - 3 = 13), tighter than the total cap. Mirrors the core-api default (keep in
 * lockstep); used only for the boot-time guardrail warning.
 */
export const DEFAULT_PER_IP_OWNER_RESERVE = 3;

/**
 * SSE connections one MM instance holds open for own-state: exactly ONE composite
 * **owner-auth** stream (commitments + fills + positions in a single connection —
 * not three). It draws from core-api's per-IP owner reserve ({@link
 * DEFAULT_PER_IP_OWNER_RESERVE}), NOT the anonymous odds budget. Distinct from that
 * reserve: this is how many own-state streams a SINGLE instance opens (the "+1" in
 * its total footprint); the reserve is how many per-IP slots core-api sets aside
 * for owner-auth across the host. So one live instance opens
 * `odds.maxRealtimeChannels` (default 5) anonymous odds streams + 1 owner-auth
 * own-state stream = 6, well within {@link DEFAULT_PER_IP_STREAM_CAP}.
 */
export const RESERVED_OWN_STATE_STREAMS = 1;

export interface WalletConfig {
  /** Path to a Foundry v3 keystore. May be omitted — then `OSPEX_KEYSTORE_PATH` or the SDK default applies. */
  keystorePath?: string;
}

export interface MarketSelectionConfig {
  sports: Sport[];
  markets: MarketType[];
  maxStartsWithinHours: number;
  maxTrackedMarkets: number;
  requireReferenceOdds: boolean;
  /**
   * Opt-in to **seeding** — posting a commitment at the oracle-primary line for a
   * wanted market that has **no open speculation yet**, lazily creating the
   * speculation on first match. Consequential: it makes the MM actively create
   * speculations, pay the protocol creation fee (a USDC cost, not just gas), and
   * approve the `TreasuryModule` (a wider approval surface than the default
   * PositionModule-only). Default `false` — the MM only quotes markets whose
   * speculation already exists. (Replaces the former dead `requireOpenSpeculation`.)
   */
  seedSpeculations: boolean;
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
 * Own-state SSE stream config. The owner-authenticated own-state stream is the
 * canonical state driver (OS-Phase 3 source flip) and is ALWAYS ON in live
 * mode (OS-Phase 4 retired the poll-driven backout): a live boot opens the
 * subscription, and the per-tick poll survives only as the slow audit
 * cross-check feeding the divergence comparator. Dry-run never subscribes —
 * the stream is owner-authenticated and dry-run has no signer; its own-state
 * surface stays inert.
 */
export interface OwnStateConfig {
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
   * The runner's single tick cadence (ms) since OS-Phase 4: paces the audit
   * cross-check poll, the own-state health poll (`client.ownState.health()`,
   * which drives the `indexerLagDegraded` latch — own-state SSE plan §5/A4),
   * and the reconcile/settle/funding/ageOut sweep. Fills and lifecycle changes
   * arrive in real time over the stream; nothing trading-critical waits on
   * this interval. Range 10000-300000ms; default 60000ms.
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
   * Spread / total only — the minimum oracle line move (in away-perspective ticks, the
   * protocol's 10×-scaled `lineTicks` unit) that makes the MM re-bind a tracked market to
   * the open speculation at the new line and re-quote there. The discovery refresh FOLLOWS
   * the oracle: when the line the reference odds imply (`oracleLineTicks` — `round(awayLine ×
   * 10)` for spread, `round(line × 10)` for total) has moved MORE than this many ticks from
   * the line we're quoting, the tracked market re-points to the open spec at the oracle line
   * (the line-consistency gate then lets it quote). A smaller move is held (debounced): the
   * gate keeps refusing the residual mismatch (`reference-line-mismatch`) until the move is
   * worth chasing or the oracle returns to our line. `0` (default) follows every move — no
   * debounce, the smallest refusal window. Moneyline has no line and ignores this entirely.
   */
  replaceOnLineMoveTicks: number;
  /**
   * How the MM authoritatively cancels matchable commitments it no longer wants on chain.
   * `offchain` (default) pulls them off the relay (gasless, visibility-only — the signed
   * payload stays matchable until expiry); `onchain` ALSO sends an authoritative
   * `MatchingModule.cancelCommitment` (gas-gated, reserve-preserving), the only mode that
   * actually drops the exposure. Governs BOTH the routine partial-remainder / recovered
   * soft-cancel paths AND the §5.1 own-state-health active cancel-sweep (PR3b-ii) when
   * a high-severity stream-health hold is active in live mode. (No `none`
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
   * changes slowly and the reads cost RPC. Independent of `ownState.auditPollIntervalMs`.
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
  mode: ModeConfig;
}
