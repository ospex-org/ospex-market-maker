/** Types for the risk engine (DESIGN §6). */

export type MakerSide = 'away' | 'home';

/**
 * The market a line belongs to. Mirrored locally (not imported from `src/state`
 * or the SDK) to keep the risk engine decoupled, exactly as `MakerSide` is — the
 * orders layer bridges the (structurally identical) state/SDK unions to this one.
 */
export type MarketType = 'moneyline' | 'spread' | 'total';

/**
 * One unit of the maker's at-risk exposure: a position the maker holds (its own
 * stake), or a still-matchable commitment's *remaining* risk. The caller
 * (`orders.inventoryFromState`) builds these — keeping `visibleOpen` /
 * `softCancelled` / `partiallyFilled` commitments not past their expiry (an
 * off-chain cancel is visibility-only — a pulled-but-not-expired quote is still
 * matchable on chain, so it still counts) and positions other than `claimed`;
 * excluding `filled` / `expired` / `authoritatively-invalidated` commitments and
 * anything past its expiry.
 */
export interface ExposureItem {
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  /**
   * The on-chain speculation this exposure belongs to — the risk engine's **group
   * key**. A speculation is exactly one `(contestId, scorer, lineTicks)` (the
   * contract dedups creation per that tuple), so its id is 1:1 with a contest's
   * market + line; moneyline / spread / total (and different spread/total lines)
   * are independent speculations that can all lose at once, so each is its own
   * worst-case bucket (DESIGN §6). It is always present on every commitment /
   * position record and own-state body — unlike `lineTicks`, which the own-state
   * position body omits — so grouping by it has no missing-line failure mode.
   */
  speculationId: string;
  /**
   * The market type, kept for the per-team cap rule only: a `total` (over/under)
   * carries no team, so it is excluded from team exposure. The line itself is not
   * needed here — the speculation id already identifies the market + line.
   */
  marketType: MarketType;
  /** Which side the maker is on within this speculation — if this side loses, the maker loses `riskAmountUSDC`. */
  makerSide: MakerSide;
  /** The at-risk USDC: a position's stake, or a commitment's remaining risk. */
  riskAmountUSDC: number;
}

/** The maker's current state, as the risk engine sees it. */
export interface Inventory {
  items: readonly ExposureItem[];
  /** Count of the maker's still-live, matchable commitments — `visibleOpen`, `softCancelled`-not-yet-expired, and `partiallyFilled`-not-yet-expired (each is a distinct signed commitment a taker could match). The `maxOpenCommitments` cap binds this; `orders.inventoryFromState` computes it. */
  openCommitmentCount: number;
}

/** A market the maker is considering quoting — its contest, the two teams, the speculation id that picks its exposure group, and the market type (for the per-team cap rule) (DESIGN §6). */
export interface Market {
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  /** The speculation this quote's risk would land in — the exposure group key (1:1 with the contest's market + line). */
  speculationId: string;
  /** Market type — used only to exempt a `total` (over/under) market from the per-team cap. */
  marketType: MarketType;
}

/**
 * The exposure caps the risk engine enforces — mirrors `RiskConfig` (and is built
 * from the parsed `Config` by the orders / runner layer; the risk module stays
 * decoupled from `src/config/`). Amounts in USDC; `maxOpenCommitments` is a count.
 */
export interface RiskCaps {
  bankrollUSDC: number;
  maxBankrollUtilizationPct: number;
  maxRiskPerCommitmentUSDC: number;
  maxRiskPerContestUSDC: number;
  maxRiskPerTeamUSDC: number;
  maxRiskPerSportUSDC: number;
  maxOpenCommitments: number;
}

/**
 * The two mutually-exclusive sides of a single speculation (one exposure group),
 * as worst-case USDC loss (DESIGN §6). For moneyline the names are literal (loss if
 * the away / home team wins); for spread they are the away-cover / home-cover
 * outcomes; for total they are the over / under outcomes (over ↔ `ifAwayWins`,
 * under ↔ `ifHomeWins`, matching the protocol Upper/Lower side order). The two
 * sides can't both happen, so a group's worst case is `max(ifAwayWins, ifHomeWins)`.
 */
export interface OutcomeLoss {
  ifAwayWins: number;
  ifHomeWins: number;
}

export type RiskVerdict = { allowed: true } | { allowed: false; reason: string };
