/**
 * Total (over/under) market pricing (DESIGN §5). A thin per-market adapter over
 * the shared two-way pipeline `computeQuote`, like the spread adapter — a total is
 * two-sided (over vs under) at a line, so its per-side juice flows through the exact
 * same vig-strip → fair → quoting-spread → quote-prices → ticks → size pipeline. Two
 * total-specific parts: the reference odds come from the over / under juice, and the
 * line is carried through for the commitment's `lineTicks`.
 *
 * Side semantics — the one place total differs from spread (`OspexTypes.sol`:
 * `positionType` Upper/0 = away/**over**, Lower/1 = home/**under**). `computeQuote`
 * is labelled away/home, so this adapter maps:
 *   - OVER  → the away / Upper protocol side → `consensusAwayDecimal` (over juice),
 *             surfaced as `over` (the away `QuoteSide`, `takerSide: 'away'`);
 *   - UNDER → the home / Lower protocol side → `consensusHomeDecimal` (under juice),
 *             surfaced as `under` (the home `QuoteSide`, `takerSide: 'home'`).
 *
 * The maker takes the *opposite* of each taker offer via the existing
 * `toProtocolQuote` (traced + pinned in the tests):
 *   - the OVER offer  (`takerSide: 'away'`) → maker home / Lower / `positionType` 1
 *     (the maker of an over offer is on under);
 *   - the UNDER offer (`takerSide: 'home'`) → maker away / Upper / `positionType` 0
 *     (the maker of an under offer is on over).
 *
 * The over / under surface naming is what consumers (telemetry, commitment
 * construction) use; the inner `QuoteSide.takerSide` (`'away'` / `'home'`) is the
 * protocol-side driver that `toProtocolQuote` consumes — `'away'` = the Upper/over
 * outcome, `'home'` = the Lower/under outcome — so no change to the shared `Side`
 * model is needed. Pure: no SDK, no chain.
 */

import { americanToDecimal } from '../odds.js';
import { computeQuote } from '../quote.js';
import type { QuoteCommonInputs, QuoteResult, QuoteSide, SpreadConfig } from '../types.js';

/** The total market's reference odds: the over/under line + per-side juice (American). */
export interface TotalReference {
  /** Over/under threshold (perspective-neutral, e.g. `7.5`). */
  line: number;
  /** Over reference juice (American, e.g. `+104`). */
  overOddsAmerican: number;
  /** Under reference juice (American, e.g. `-123`). */
  underOddsAmerican: number;
}

/** Pricing scalars + spread-derivation mode shared with `computeQuote`, minus the reference odds (a total market sources those from its own juice). (Identical in shape to `SpreadPricing`.) */
export type TotalPricing = Omit<QuoteCommonInputs, 'consensusAwayDecimal' | 'consensusHomeDecimal'> & SpreadConfig;

/** A priced total market: the two-sided over/under quote + the line. Mirrors `QuoteResult` with `away`/`home` relabelled to `over`/`under`. */
export type TotalQuote = Omit<QuoteResult, 'away' | 'home'> & {
  /** Over taker offer — the away/Upper protocol side (`takerSide: 'away'`; the maker of this offer is on under). `null` if pulled / refused. */
  over: QuoteSide | null;
  /** Under taker offer — the home/Lower protocol side (`takerSide: 'home'`; the maker of this offer is on over). `null` if pulled / refused. */
  under: QuoteSide | null;
  /** The over/under threshold this quote is for. */
  line: number;
};

function refusedTotal(reason: string, ref: TotalReference): TotalQuote {
  return {
    canQuote: false,
    over: null,
    under: null,
    fair: null,
    spread: null,
    targetMonthlyReturnUSDC: null,
    expectedMonthlyFilledVolumeUSDC: null,
    notes: [`REFUSE: ${reason}`],
    line: ref.line,
  };
}

/**
 * Price a total market: convert the over / under juice to decimals (over →
 * `consensusAwayDecimal`, under → `consensusHomeDecimal`), run the shared
 * `computeQuote` pipeline, relabel its `away` / `home` sides to `over` / `under`,
 * and tag the result with the line. Bad reference juice is an operational *refusal*
 * (mirroring `computeQuote`), not a throw; invalid caller args still throw.
 */
export function priceTotal(ref: TotalReference, pricing: TotalPricing): TotalQuote {
  let consensusAwayDecimal: number;
  let consensusHomeDecimal: number;
  try {
    consensusAwayDecimal = americanToDecimal(ref.overOddsAmerican); // over = away/Upper
    consensusHomeDecimal = americanToDecimal(ref.underOddsAmerican); // under = home/Lower
  } catch (err) {
    return refusedTotal((err as Error).message, ref);
  }
  const { away, home, ...rest } = computeQuote({ ...pricing, consensusAwayDecimal, consensusHomeDecimal });
  return { ...rest, over: away, under: home, line: ref.line };
}
