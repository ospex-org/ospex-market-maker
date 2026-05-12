import {
  MAX_ODDS_TICK,
  MIN_ODDS_TICK,
  ODDS_SCALE,
  RISK_LOT_WEI6,
  USDC_UNIT_WEI6,
} from './constants.js';

/** American odds → decimal odds. `+150` → `2.50`; `-200` → `1.50`. Throws on `0` or non-finite. */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) {
    throw new Error(`americanToDecimal: ${american} is not a valid American odd`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

/** Decimal odds → American odds (rounded to the nearest integer). `2.50` → `+150`; `1.50` → `-200`. */
export function decimalToAmerican(decimal: number): number {
  if (!(decimal > 1)) throw new Error(`decimalToAmerican: decimal must be > 1, got ${decimal}`);
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}

/** Decimal odds → implied probability. `2.00` → `0.50`. */
export function decimalToImpliedProb(decimal: number): number {
  if (!(decimal > 1)) throw new Error(`decimalToImpliedProb: decimal must be > 1, got ${decimal}`);
  return 1 / decimal;
}

/** Implied probability → decimal odds. `0.50` → `2.00`. */
export function impliedProbToDecimal(prob: number): number {
  if (!(prob > 0 && prob < 1)) {
    throw new Error(`impliedProbToDecimal: prob must be in (0, 1), got ${prob}`);
  }
  return 1 / prob;
}

/** Decimal odds → uint16 tick (100× scale, rounded). `1.91` → `191`. */
export function decimalToTick(decimal: number): number {
  return Math.round(decimal * ODDS_SCALE);
}

/** uint16 tick → decimal odds. `191` → `1.91`. */
export function tickToDecimal(tick: number): number {
  return tick / ODDS_SCALE;
}

/** Is `tick` an integer within the protocol's `[MIN_ODDS_TICK, MAX_ODDS_TICK]` range? */
export function isTickInRange(tick: number): boolean {
  return Number.isInteger(tick) && tick >= MIN_ODDS_TICK && tick <= MAX_ODDS_TICK;
}

/**
 * The symmetric counterparty odds tick. A protocol commitment posted at maker
 * tick `T` (decimal `T/100`) gives the taker who matches it the *opposite* side
 * at decimal `(T/100) / (T/100 − 1) = T / (T − 100)` — in ticks,
 * `round(100·T / (T − 100))`. So a maker tick of `150` ↔ a taker tick of `300`,
 * `200` ↔ `200`, `300` ↔ `150`. The relation is an involution up to integer
 * rounding (`inverseOddsTick(inverseOddsTick(T)) === T` for the great majority of
 * ticks; double-rounding can shift the round-trip by 1 at a handful of values —
 * the same imprecision the SDK and contract live with). For `T` in
 * `[MIN_ODDS_TICK, MAX_ODDS_TICK]` the result is also in that range.
 *
 * Mirrors the SDK's `inverseOddsTick` (`commitments/buildMatchPreview.js`).
 * Throws on a non-integer tick or one outside `[MIN_ODDS_TICK, MAX_ODDS_TICK]` —
 * a bad tick here is a caller bug, not data.
 */
export function inverseOddsTick(makerTick: number): number {
  if (!Number.isInteger(makerTick) || makerTick < MIN_ODDS_TICK || makerTick > MAX_ODDS_TICK) {
    throw new Error(`inverseOddsTick: ${makerTick} is not an odds tick in [${MIN_ODDS_TICK}, ${MAX_ODDS_TICK}]`);
  }
  return Math.round((ODDS_SCALE * makerTick) / (makerTick - ODDS_SCALE));
}

/**
 * Quantize a USDC amount **down** to the largest valid risk amount ≤ it (in wei6).
 * Risk amounts must be multiples of `RISK_LOT_WEI6`, so `0.250001` USDC →
 * `250000` wei6 and any amount below one lot (`< 0.0001` USDC) → `0`. Negative /
 * non-finite input → `0`. Always rounds **down** (never `Math.round`) so a quote
 * can never exceed the caller's headroom — this helper is part of the risk/safety
 * boundary, so it must fail closed.
 */
export function quantizeRiskWei6(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc <= 0) return 0;
  const rawWei6 = Math.floor(usdc * USDC_UNIT_WEI6);
  return Math.floor(rawWei6 / RISK_LOT_WEI6) * RISK_LOT_WEI6;
}

/** wei6 → USDC (float). `250000` → `0.25`. */
export function wei6ToUSDC(wei6: number): number {
  return wei6 / USDC_UNIT_WEI6;
}
