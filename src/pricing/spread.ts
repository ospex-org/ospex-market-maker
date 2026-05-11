import type { EconomicsInputs } from './types.js';
import type { FairOdds } from './vig.js';

export interface SpreadEconomicsDiagnostics {
  targetMonthlyReturnUSDC: number;
  expectedMonthlyFilledVolumeUSDC: number;
}

export type DeriveSpreadResult =
  | { ok: true; spread: number; diagnostics?: SpreadEconomicsDiagnostics }
  | { ok: false; reason: string; diagnostics?: SpreadEconomicsDiagnostics };

/**
 * Expected monthly *filled* volume across both sides, given the operator's economics.
 *
 *   maxPerQuote          = capital × maxPerQuotePctOfCapital
 *   quotedPerDayUncapped = gamesPerDay × 2 sides × maxPerQuote
 *   quotedPerDay         = min(quotedPerDayUncapped, capital × turnoverPerDay)
 *   filledPerDay         = quotedPerDay × fillRate
 *   monthlyFilled        = filledPerDay × daysHorizon            (total across both sides)
 */
export function expectedMonthlyFilledVolumeUSDC(
  capitalUSDC: number,
  maxPerQuotePctOfCapital: number,
  e: EconomicsInputs,
): number {
  const maxPerQuote = capitalUSDC * maxPerQuotePctOfCapital;
  const quotedPerDayUncapped = e.estGamesPerDay * 2 * maxPerQuote;
  const dailyCapitalCapacity = capitalUSDC * e.capitalTurnoverPerDay;
  const quotedPerDay = Math.min(quotedPerDayUncapped, dailyCapitalCapacity);
  const filledPerDay = quotedPerDay * e.fillRateAssumption;
  return filledPerDay * e.daysHorizon;
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/**
 * Economics mode: solve `targetSpread = targetReturn / (expectedMonthlyFilled / 2)`,
 * then refuse if it's too wide (vs `maxReasonableSpread` or the consensus overround)
 * or too thin (below `minEdgeBps`). The refusal message names which input to change.
 */
export function deriveSpreadEconomics(
  capitalUSDC: number,
  maxPerQuotePctOfCapital: number,
  e: EconomicsInputs,
  fair: FairOdds,
  minEdgeBps: number,
): DeriveSpreadResult {
  const targetMonthlyReturnUSDC = capitalUSDC * e.targetMonthlyReturnPct;
  const expectedFilledUSDC = expectedMonthlyFilledVolumeUSDC(
    capitalUSDC,
    maxPerQuotePctOfCapital,
    e,
  );
  const diagnostics: SpreadEconomicsDiagnostics = {
    targetMonthlyReturnUSDC,
    expectedMonthlyFilledVolumeUSDC: expectedFilledUSDC,
  };
  if (!(expectedFilledUSDC > 0)) {
    return {
      ok: false,
      reason:
        'expected filled volume is zero given your inputs (games/day, capital, per-quote cap, fill-rate, horizon) — nothing to size against',
      diagnostics,
    };
  }
  const targetSpread = targetMonthlyReturnUSDC / (expectedFilledUSDC / 2);
  if (targetSpread > e.maxReasonableSpread) {
    return {
      ok: false,
      reason:
        `the spread your targets imply (${pct(targetSpread)}) exceeds maxReasonableSpread (${pct(e.maxReasonableSpread)}) — ` +
        'lower targetMonthlyReturnPct, raise capital, add sports/games, or revisit fillRateAssumption',
      diagnostics,
    };
  }
  if (targetSpread > fair.consensusOverround) {
    return {
      ok: false,
      reason:
        `the spread your targets imply (${pct(targetSpread)}) is wider than the consensus overround (${pct(fair.consensusOverround)}) — ` +
        "you can't quote inside the market and still earn that margin",
      diagnostics,
    };
  }
  if (targetSpread * 10_000 < minEdgeBps) {
    return {
      ok: false,
      reason: `the spread your targets imply (${(targetSpread * 10_000).toFixed(0)} bps) is below minEdgeBps (${minEdgeBps}) — not worth quoting`,
      diagnostics,
    };
  }
  return { ok: true, spread: targetSpread, diagnostics };
}

/** Direct mode: use `spreadBps` as the embedded spread; refuse if wider than the consensus overround or thinner than `minEdgeBps`. */
export function deriveSpreadDirect(
  spreadBps: number,
  fair: FairOdds,
  minEdgeBps: number,
): DeriveSpreadResult {
  if (!(spreadBps > 0)) return { ok: false, reason: `spreadBps must be positive, got ${spreadBps}` };
  const spread = spreadBps / 10_000;
  if (spread > fair.consensusOverround) {
    return {
      ok: false,
      reason: `spreadBps (${spreadBps}) is wider than the consensus overround (${pct(fair.consensusOverround)}) — you can't quote inside the market and still earn that margin`,
    };
  }
  if (spreadBps < minEdgeBps) {
    return { ok: false, reason: `spreadBps (${spreadBps}) is below minEdgeBps (${minEdgeBps}) — not worth quoting` };
  }
  return { ok: true, spread };
}
