/**
 * Spread market pricing (DESIGN §5). A thin per-market *adapter* over the shared
 * two-way pipeline `computeQuote`: a spread market is two-sided (away-cover vs
 * home-cover) at a line, so its juice flows through the exact same vig-strip → fair
 * → quoting-spread → quote-prices → ticks → size pipeline as moneyline. The only
 * spread-specific parts are (a) the reference odds come from the spread's per-side
 * juice, and (b) the line is carried through so the resulting commitment can set
 * its `lineTicks`.
 *
 * Side semantics (DESIGN §5, `OspexTypes.sol`): the `QuoteResult`'s `away` /
 * `home` sides are the **away-cover** / **home-cover** taker offers. The existing
 * `toProtocolQuote` converts each to the maker's *opposite* side — exactly as for
 * moneyline, so no spread-specific relabeling is needed:
 *   - away-cover taker offer → maker home / Lower / positionType 1
 *   - home-cover taker offer → maker away / Upper / positionType 0
 * (Total, by contrast, needs over/under relabeling — its own adapter.)
 *
 * Pure: no SDK, no chain. Moneyline keeps using `computeQuote` directly via the
 * orders layer; this is the spread sibling the orders layer will delegate to once
 * spread quoting is wired in.
 */

import { americanToDecimal } from '../odds.js';
import { computeQuote } from '../quote.js';
import type { QuoteCommonInputs, QuoteResult, SpreadConfig, QuoteInputs } from '../types.js';

/** The spread market's reference odds: the line (both perspectives) + per-side cover juice (American). */
export interface SpreadReference {
  /** Away team's spread line, decimal points (e.g. `+1.5`). `homeLine = -awayLine`. */
  awayLine: number;
  /** Home team's spread line (negative if home favored). */
  homeLine: number;
  /** Away-cover reference juice (American, e.g. `+152`). */
  awayOddsAmerican: number;
  /** Home-cover reference juice (American, e.g. `-176`). */
  homeOddsAmerican: number;
}

/** Pricing scalars + spread-derivation mode shared with `computeQuote`, minus the reference odds (a spread market sources those from its own juice — see {@link SpreadReference}). */
export type SpreadPricing = Omit<QuoteCommonInputs, 'consensusAwayDecimal' | 'consensusHomeDecimal'> & SpreadConfig;

/** A priced spread market: the two-sided taker-facing quote + the line it is for (carried through for the commitment's `lineTicks`). */
export interface SpreadQuote {
  /** `computeQuote` output — `away` = away-cover offer, `home` = home-cover offer (taker-facing). */
  result: QuoteResult;
  /** The away-team spread line this quote is for. */
  awayLine: number;
  /** The home-team spread line (`= -awayLine`). */
  homeLine: number;
}

function refusedSpread(reason: string, ref: SpreadReference): SpreadQuote {
  return {
    result: {
      canQuote: false,
      away: null,
      home: null,
      fair: null,
      spread: null,
      targetMonthlyReturnUSDC: null,
      expectedMonthlyFilledVolumeUSDC: null,
      notes: [`REFUSE: ${reason}`],
    },
    awayLine: ref.awayLine,
    homeLine: ref.homeLine,
  };
}

/**
 * Price a spread market: convert the per-side cover juice to decimals, run the
 * shared `computeQuote` pipeline, and tag the result with the line. Bad reference
 * juice (a zero / non-finite American price) is an operational *refusal* — mirroring
 * `computeQuote`'s "refuse on bad reference data" (DESIGN §2.2) — not a throw;
 * `computeQuote` throws only on invalid *caller* (config-derived) arguments.
 */
export function priceSpread(ref: SpreadReference, pricing: SpreadPricing): SpreadQuote {
  let consensusAwayDecimal: number;
  let consensusHomeDecimal: number;
  try {
    consensusAwayDecimal = americanToDecimal(ref.awayOddsAmerican);
    consensusHomeDecimal = americanToDecimal(ref.homeOddsAmerican);
  } catch (err) {
    return refusedSpread((err as Error).message, ref);
  }
  const inputs: QuoteInputs = { ...pricing, consensusAwayDecimal, consensusHomeDecimal };
  return { result: computeQuote(inputs), awayLine: ref.awayLine, homeLine: ref.homeLine };
}
