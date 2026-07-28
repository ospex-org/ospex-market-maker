import type { EconomicsInputs } from './types.js';
import type { FairOdds } from './vig.js';

export interface SpreadEconomicsDiagnostics {
  targetMonthlyReturnUSDC: number;
  expectedMonthlyFilledVolumeUSDC: number;
}

export type DeriveSpreadResult =
  | { ok: true; spread: number; diagnostics?: SpreadEconomicsDiagnostics; note?: string }
  | { ok: false; reason: string; diagnostics?: SpreadEconomicsDiagnostics };

/**
 * Advisory emitted when the operator's spread is wider than the reference
 * market's overround. This is NOT a refusal.
 *
 * Quoting wider than the books is a legitimate operator choice: a larger
 * margin bought with a lower fill rate. Reference odds are an input, not
 * an authority, and Ospex has no "inside the market" to quote against —
 * it is a peer-to-peer orderbook, so a taker either likes the price or
 * doesn't. A market with genuinely uncertain pricing and thin interest is
 * exactly where a wide quote is the correct quote.
 *
 * Note the asymmetry with `minEdgeBps`, which IS a refusal. Quoting too
 * THIN can lose money — the edge goes negative, and a tight spread
 * maximizes adverse selection (you get filled precisely when the true
 * price has moved against you). Quoting too WIDE cannot: per fill it is
 * strictly better, and it reduces adverse-selection cost. The only cost
 * is opportunity — fewer fills — which the market applies on its own.
 * Symmetric-looking bounds, asymmetric risks; only one of them earns a
 * refusal.
 */
function widerThanOverroundNote(spread: number, consensusOverround: number): string {
  return (
    `spread ${pct(spread)} is wider than the consensus overround ${pct(consensusOverround)} — ` +
    'quoting worse than the reference market, so expect a lower fill rate'
  );
}

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
 * then refuse if it's too wide (vs `maxReasonableSpread`) or too thin (below
 * `minEdgeBps`). The refusal message names which input to change.
 *
 * `maxReasonableSpread` is a consistency check on the operator's own inputs —
 * the return they asked for needs a wider spread than they called reasonable —
 * not a cap on what may be quoted. Exceeding the *consensus overround* is NOT
 * a refusal; it returns an advisory `note`. See {@link widerThanOverroundNote}.
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
  if (targetSpread * 10_000 < minEdgeBps) {
    return {
      ok: false,
      reason: `the spread your targets imply (${(targetSpread * 10_000).toFixed(0)} bps) is below minEdgeBps (${minEdgeBps}) — not worth quoting`,
      diagnostics,
    };
  }
  // Wider than the reference market is allowed — advisory only. In this mode
  // `maxReasonableSpread` above is the real upper bound, and it is a check on
  // the CONSISTENCY OF YOUR INPUTS (the return you asked for needs a wider
  // spread than you yourself called reasonable), not a cap on what you may
  // quote. Raise it if you mean it.
  const note =
    targetSpread > fair.consensusOverround
      ? widerThanOverroundNote(targetSpread, fair.consensusOverround)
      : undefined;
  return { ok: true, spread: targetSpread, diagnostics, ...(note !== undefined ? { note } : {}) };
}

/**
 * Direct mode: use `spreadBps` verbatim as the embedded spread. Refuses only
 * if it is non-positive or thinner than `minEdgeBps`.
 *
 * There is deliberately NO upper bound here. `spreadBps` is the operator's
 * explicitly chosen vig, and this mode exists precisely so that number is
 * honoured — the only remaining ceiling is the protocol's own odds-tick range,
 * enforced downstream in `computeQuote`. Wider than the reference market emits
 * an advisory note, not a refusal; see {@link widerThanOverroundNote}.
 */
export function deriveSpreadDirect(
  spreadBps: number,
  fair: FairOdds,
  minEdgeBps: number,
): DeriveSpreadResult {
  if (!(spreadBps > 0)) return { ok: false, reason: `spreadBps must be positive, got ${spreadBps}` };
  const spread = spreadBps / 10_000;
  if (spreadBps < minEdgeBps) {
    return { ok: false, reason: `spreadBps (${spreadBps}) is below minEdgeBps (${minEdgeBps}) — not worth quoting` };
  }
  const note =
    spread > fair.consensusOverround
      ? widerThanOverroundNote(spread, fair.consensusOverround)
      : undefined;
  return { ok: true, spread, ...(note !== undefined ? { note } : {}) };
}
