import { MAX_ODDS_TICK, MIN_ODDS_TICK, ODDS_SCALE } from './constants.js';
import {
  decimalToAmerican,
  decimalToTick,
  isTickInRange,
  quantizeRiskWei6,
  wei6ToUSDC,
} from './odds.js';
import { deriveSpreadDirect, deriveSpreadEconomics, type DeriveSpreadResult } from './spread.js';
import type { EconomicsInputs, QuoteInputs, QuoteResult, QuoteSide } from './types.js';
import { stripVig, type FairOdds } from './vig.js';

const refusePrefix = (reason: string): string => `REFUSE: ${reason}`;

function refused(
  notes: string[],
  fair: FairOdds | null,
  spread: number | null,
  targetMonthlyReturnUSDC: number | null,
  expectedMonthlyFilledVolumeUSDC: number | null,
): QuoteResult {
  return {
    canQuote: false,
    away: null,
    home: null,
    fair,
    spread,
    targetMonthlyReturnUSDC,
    expectedMonthlyFilledVolumeUSDC,
    notes,
  };
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`computeQuote: ${name} must be a finite number, got ${value}`);
  }
}

// Caller-argument validation. Non-finite *parameters* throw (they come from config
// or risk calculations — a NaN / Infinity there is a bug). The *reference odds*
// (consensusAwayDecimal / consensusHomeDecimal) are data, not parameters: a garbage
// value there is handled downstream in `stripVig` as a refusal (DESIGN §2.2 — refuse
// on bad reference data), not a throw.
function validateCommon(inputs: QuoteInputs): void {
  requireFinite(inputs.capitalUSDC, 'capitalUSDC');
  requireFinite(inputs.maxPerQuotePctOfCapital, 'maxPerQuotePctOfCapital');
  requireFinite(inputs.minEdgeBps, 'minEdgeBps');
  requireFinite(inputs.awayHeadroomUSDC, 'awayHeadroomUSDC');
  requireFinite(inputs.homeHeadroomUSDC, 'homeHeadroomUSDC');
  if (!(inputs.capitalUSDC > 0)) {
    throw new Error(`computeQuote: capitalUSDC must be positive, got ${inputs.capitalUSDC}`);
  }
  if (!(inputs.maxPerQuotePctOfCapital > 0 && inputs.maxPerQuotePctOfCapital <= 1)) {
    throw new Error(`computeQuote: maxPerQuotePctOfCapital must be in (0, 1], got ${inputs.maxPerQuotePctOfCapital}`);
  }
  if (!(inputs.minEdgeBps >= 0)) {
    throw new Error(`computeQuote: minEdgeBps must be ≥ 0, got ${inputs.minEdgeBps}`);
  }
  if (!(inputs.awayHeadroomUSDC >= 0) || !(inputs.homeHeadroomUSDC >= 0)) {
    throw new Error(
      `computeQuote: headroom must be ≥ 0 (away=${inputs.awayHeadroomUSDC}, home=${inputs.homeHeadroomUSDC})`,
    );
  }
  // The inventory-skew signal is a caller-derived PARAMETER (the orders layer computes it from
  // config + inventory), so a non-finite / out-of-range value is a bug → throw, fail-closed.
  // Omitted is fine (defaults to 0 = symmetric). The [-1, 1] bound is what guarantees
  // |skewDelta| ≤ halfSpread (never quote below fair) before the per-side range clamp.
  if (inputs.skewSignal !== undefined) {
    requireFinite(inputs.skewSignal, 'skewSignal');
    if (!(inputs.skewSignal >= -1 && inputs.skewSignal <= 1)) {
      throw new Error(`computeQuote: skewSignal must be in [-1, 1], got ${inputs.skewSignal}`);
    }
  }
}

// Conservative probability band that maps strictly inside the protocol tick range
// [MIN_ODDS_TICK, MAX_ODDS_TICK]: `tickToDecimal(t) = t / ODDS_SCALE`, so a quote prob at
// SKEW_PROB_CEIL has decimal `1/ceil = MIN_ODDS_TICK/ODDS_SCALE` ⇒ tick = MIN_ODDS_TICK, and at
// SKEW_PROB_FLOOR ⇒ tick = MAX_ODDS_TICK. A prob inside [FLOOR, CEIL] therefore has a tick inside
// [MIN, MAX]. Used to clamp the inventory skew so it can never push a side out of tick range.
export const SKEW_PROB_CEIL = ODDS_SCALE / MIN_ODDS_TICK; //  ≈ 0.990099 — above this the tick drops below MIN_ODDS_TICK
export const SKEW_PROB_FLOOR = ODDS_SCALE / MAX_ODDS_TICK; // ≈ 0.009901 — below this the tick exceeds MAX_ODDS_TICK

/**
 * Clamp the signed inventory-skew lean `desiredDelta` (= skewSignal × halfSpread) so that
 * neither skewed quote — away = symAwayProb + d, home = symHomeProb − d — leaves the
 * conservative valid-prob band [SKEW_PROB_FLOOR, SKEW_PROB_CEIL] (⇒ both ticks stay in
 * [MIN_ODDS_TICK, MAX_ODDS_TICK]). Reduces |d| toward 0 only as much as needed, applying the
 * SAME clamped d to both sides so the edge-preserving `+d / −d` cancellation (sum = 1+spread)
 * is kept. The invariant: if the SYMMETRIC quote (d=0) is two-sided tick-valid, the skewed
 * quote is too — skew never turns a quotable line into a refusal. Over-clamping on an extreme
 * (near-pathological) line just means slightly less skew there — the safe direction. `d = 0`
 * (skew off) returns 0 exactly, so the disabled path is byte-identical.
 */
export function clampSkewDelta(d: number, symAwayProb: number, symHomeProb: number): number {
  if (d === 0) return d;
  if (d > 0) {
    // away leans UP toward SKEW_PROB_CEIL; home leans DOWN toward SKEW_PROB_FLOOR.
    return Math.max(0, Math.min(d, SKEW_PROB_CEIL - symAwayProb, symHomeProb - SKEW_PROB_FLOOR));
  }
  // d < 0: away leans DOWN toward SKEW_PROB_FLOOR; home leans UP toward SKEW_PROB_CEIL.
  return Math.min(0, Math.max(d, SKEW_PROB_FLOOR - symAwayProb, symHomeProb - SKEW_PROB_CEIL));
}

function validateEconomics(e: EconomicsInputs): void {
  requireFinite(e.targetMonthlyReturnPct, 'economics.targetMonthlyReturnPct');
  requireFinite(e.daysHorizon, 'economics.daysHorizon');
  requireFinite(e.estGamesPerDay, 'economics.estGamesPerDay');
  requireFinite(e.fillRateAssumption, 'economics.fillRateAssumption');
  requireFinite(e.capitalTurnoverPerDay, 'economics.capitalTurnoverPerDay');
  requireFinite(e.maxReasonableSpread, 'economics.maxReasonableSpread');
  if (!(e.targetMonthlyReturnPct > 0)) {
    throw new Error(`computeQuote: economics.targetMonthlyReturnPct must be positive, got ${e.targetMonthlyReturnPct}`);
  }
  if (!(e.daysHorizon > 0)) {
    throw new Error(`computeQuote: economics.daysHorizon must be positive, got ${e.daysHorizon}`);
  }
  if (!(e.estGamesPerDay > 0)) {
    throw new Error(`computeQuote: economics.estGamesPerDay must be positive, got ${e.estGamesPerDay}`);
  }
  if (!(e.fillRateAssumption > 0 && e.fillRateAssumption <= 1)) {
    throw new Error(`computeQuote: economics.fillRateAssumption must be in (0, 1], got ${e.fillRateAssumption}`);
  }
  if (!(e.capitalTurnoverPerDay > 0)) {
    throw new Error(`computeQuote: economics.capitalTurnoverPerDay must be positive, got ${e.capitalTurnoverPerDay}`);
  }
  if (!(e.maxReasonableSpread > 0)) {
    throw new Error(`computeQuote: economics.maxReasonableSpread must be positive, got ${e.maxReasonableSpread}`);
  }
}

function sizeSide(perQuoteCap: number, headroomUSDC: number): { sizeUSDC: number; sizeWei6: number } {
  const sizeWei6 = quantizeRiskWei6(Math.min(perQuoteCap, headroomUSDC));
  return { sizeUSDC: wei6ToUSDC(sizeWei6), sizeWei6 };
}

function buildSide(takerSide: 'away' | 'home', quoteProb: number, sizeUSDC: number, sizeWei6: number): QuoteSide {
  const quoteDecimal = 1 / quoteProb;
  return {
    takerSide,
    quoteProb,
    quoteDecimal,
    quoteAmerican: decimalToAmerican(quoteDecimal),
    quoteTick: decimalToTick(quoteDecimal),
    sizeUSDC,
    sizeWei6,
  };
}

/**
 * Compute a two-sided moneyline quote (price + size for each side) — the full
 * pipeline from DESIGN §5: strip vig → derive spread → build quote prices →
 * convert to ticks (range-checked) → size each side by per-quote cap and
 * exposure headroom (upsizing the open side if the other is capped).
 *
 * Returns `{ canQuote: false, notes: ['REFUSE: …', …] }` for any *operational*
 * refusal: bad reference data, infeasible economics, a lopsided line that pushes
 * a quote probability to ≥ 1, an out-of-range tick, or no exposure headroom on
 * either side. Throws only on invalid *caller* arguments (non-finite or
 * out-of-range parameters, a missing mode sub-object).
 *
 * Pure function — no I/O, no SDK, no chain. The risk engine supplies the per-side
 * headroom (DESIGN §6); the runner/orders layer builds `QuoteInputs` from config +
 * reference odds + current exposure.
 */
export function computeQuote(inputs: QuoteInputs): QuoteResult {
  // Validate all caller arguments up front, before doing any work.
  validateCommon(inputs);
  if (inputs.mode === 'economics') {
    validateEconomics(inputs.economics);
  } else {
    requireFinite(inputs.direct.spreadBps, 'direct.spreadBps');
  }

  if (!inputs.quoteBothSides) {
    return refused(
      [refusePrefix('quoteBothSides=false (single-sided quoting) is not implemented in v0 — set quoteBothSides: true')],
      null,
      null,
      null,
      null,
    );
  }

  // Step 1 — strip the consensus vig (a data error here is a refusal, not a throw).
  let fair: FairOdds;
  try {
    fair = stripVig(inputs.consensusAwayDecimal, inputs.consensusHomeDecimal);
  } catch (err) {
    return refused([refusePrefix((err as Error).message)], null, null, null, null);
  }

  // Step 2 — derive the quoting spread (caller args were validated up front).
  let spreadResult: DeriveSpreadResult;
  if (inputs.mode === 'economics') {
    spreadResult = deriveSpreadEconomics(
      inputs.capitalUSDC,
      inputs.maxPerQuotePctOfCapital,
      inputs.economics,
      fair,
      inputs.minEdgeBps,
    );
  } else {
    spreadResult = deriveSpreadDirect(inputs.direct.spreadBps, fair, inputs.minEdgeBps);
  }
  const targetReturnUSDC = spreadResult.diagnostics?.targetMonthlyReturnUSDC ?? null;
  const expectedFilledUSDC = spreadResult.diagnostics?.expectedMonthlyFilledVolumeUSDC ?? null;
  if (!spreadResult.ok) {
    return refused([refusePrefix(spreadResult.reason)], fair, null, targetReturnUSDC, expectedFilledUSDC);
  }
  const spread = spreadResult.spread;

  // Step 3 — build quote probabilities. The symmetric half-spread split (DESIGN §5), plus an
  // optional inventory skew: `skewSignal ∈ [-1,1]` leans the away quote UP and the home quote
  // DOWN by `skewDelta = skewSignal × halfSpread` (clamped so neither side leaves the protocol
  // tick range — skew never turns a symmetric-quotable line into a refusal). The +d/−d cancel,
  // so the two-sided sum stays `fair.away + fair.home + spread = 1 + spread`; |skewDelta| ≤
  // halfSpread keeps each quote ≥ fair (never gives away edge). skewSignal omitted / 0 ⇒
  // skewDelta = +0 ⇒ `symProb + 0 === symProb` at IEEE-754 ⇒ byte-identical symmetric quoting.
  const skewSignal = inputs.skewSignal ?? 0;
  const halfSpread = spread / 2;
  const symAwayProb = fair.awayFairProb + halfSpread;
  const symHomeProb = fair.homeFairProb + halfSpread;
  const skewDelta = clampSkewDelta(skewSignal * halfSpread, symAwayProb, symHomeProb);
  const awayQuoteProb = symAwayProb + skewDelta;
  const homeQuoteProb = symHomeProb - skewDelta;
  if (!(awayQuoteProb < 1) || !(homeQuoteProb < 1)) {
    return refused(
      [
        refusePrefix(
          'the spread pushed a quote probability to ≥ 1.0 — extremely lopsided line; an asymmetric vig split would handle this (future work)',
        ),
      ],
      fair,
      spread,
      targetReturnUSDC,
      expectedFilledUSDC,
    );
  }

  // Step 4 — convert to ticks, range-checked against [MIN_ODDS_TICK, MAX_ODDS_TICK].
  const awayTick = decimalToTick(1 / awayQuoteProb);
  const homeTick = decimalToTick(1 / homeQuoteProb);
  if (!isTickInRange(awayTick) || !isTickInRange(homeTick)) {
    return refused(
      [refusePrefix(`a quote tick is outside the protocol's [101, 10100] range (away=${awayTick}, home=${homeTick})`)],
      fair,
      spread,
      targetReturnUSDC,
      expectedFilledUSDC,
    );
  }

  // Step 5 — size each side: min(perQuoteCap, headroom); upsize the open side if the other is capped.
  const notes: string[] = [];
  const perQuoteCap = inputs.capitalUSDC * inputs.maxPerQuotePctOfCapital;
  let away = sizeSide(perQuoteCap, inputs.awayHeadroomUSDC);
  let home = sizeSide(perQuoteCap, inputs.homeHeadroomUSDC);

  if (away.sizeWei6 <= 0 && home.sizeWei6 > 0) {
    const boosted = sizeSide(perQuoteCap * 1.5, inputs.homeHeadroomUSDC);
    if (boosted.sizeWei6 > home.sizeWei6) {
      home = boosted;
      notes.push('away side at exposure cap — upsizing the home quote 1.5× to encourage flow that rebalances the book');
    }
  } else if (home.sizeWei6 <= 0 && away.sizeWei6 > 0) {
    const boosted = sizeSide(perQuoteCap * 1.5, inputs.awayHeadroomUSDC);
    if (boosted.sizeWei6 > away.sizeWei6) {
      away = boosted;
      notes.push('home side at exposure cap — upsizing the away quote 1.5× to encourage flow that rebalances the book');
    }
  }

  const quoteAway = away.sizeWei6 > 0;
  const quoteHome = home.sizeWei6 > 0;
  if (!quoteAway) notes.push('away side: no exposure headroom (or size rounds to zero) — not quoting away');
  if (!quoteHome) notes.push('home side: no exposure headroom (or size rounds to zero) — not quoting home');
  if (!quoteAway && !quoteHome) notes.push(refusePrefix('both sides are at their exposure caps — nothing to quote'));

  return {
    canQuote: quoteAway || quoteHome,
    away: quoteAway ? buildSide('away', awayQuoteProb, away.sizeUSDC, away.sizeWei6) : null,
    home: quoteHome ? buildSide('home', homeQuoteProb, home.sizeUSDC, home.sizeWei6) : null,
    fair,
    spread,
    targetMonthlyReturnUSDC: targetReturnUSDC,
    expectedMonthlyFilledVolumeUSDC: expectedFilledUSDC,
    notes,
  };
}
