/** Types for the risk engine (DESIGN §6). */

export type MakerSide = 'away' | 'home';

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
  /** Which side the maker is on — if this side loses, the maker loses `riskAmountUSDC`. */
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

/** A market the maker is considering quoting. */
export interface Market {
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
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

/** Worst-case USDC loss for a contest, per outcome (DESIGN §6). */
export interface OutcomeLoss {
  ifAwayWins: number;
  ifHomeWins: number;
}

export type RiskVerdict = { allowed: true } | { allowed: false; reason: string };
