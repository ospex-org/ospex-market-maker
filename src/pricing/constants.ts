/**
 * Protocol odds / lot-size constants used by the pricing math.
 * Mirrors `MatchingModule`: `ODDS_SCALE`, `MIN_ODDS`, `MAX_ODDS`. See DESIGN §5.
 */

/** Odds-tick scale (uint16 ticks at 100×): decimal `1.91` → `191` ticks. */
export const ODDS_SCALE = 100;

/** Minimum odds tick — `1.01×` (`MatchingModule.MIN_ODDS`). */
export const MIN_ODDS_TICK = 101;

/** Maximum odds tick — `101.00×` (`MatchingModule.MAX_ODDS`). */
export const MAX_ODDS_TICK = 10_100;

/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6;

/** 1 USDC in 6-decimal base units ("wei6"). */
export const USDC_UNIT_WEI6 = 1_000_000;

/**
 * Risk amounts (in wei6) must be exact multiples of this — the tick math in
 * `MatchingModule` requires divisibility by `ODDS_SCALE`. So the smallest
 * quotable risk increment is `100` wei6 = `0.0001` USDC.
 */
export const RISK_LOT_WEI6 = ODDS_SCALE;
