/**
 * Reference-odds ingestion model (DESIGN §5). The MM's internal, *usable*
 * representation of upstream reference odds for one (contest, market), plus the
 * mapper from the SDK's per-market odds shapes.
 *
 * The SDK delivers a discriminated per-market shape — `MoneylineOdds`,
 * `SpreadOdds`, `TotalOdds` — whose fields are individually nullable: the writer
 * may have priced one side, the line, both, or neither for a given game. Pricing
 * shouldn't have to null-check upstream fields on every path, so
 * `referenceOddsFromSdk` collapses those shapes to this fully-populated,
 * market-tagged `ReferenceOdds` — or `null` when the upstream data isn't usable
 * yet (a missing side price, or a missing line for spread / total). A `null` is the
 * ingestion-layer signal that there is no usable reference for this market right
 * now; the caller refuses to quote it.
 *
 * This is the foundation the spread / total pricing strategies and line-keyed
 * candidate discovery build on; it is purely a data transform — no SDK calls, no
 * chain, no pricing. (Moneyline today flows through its own
 * `ReferenceMoneylineAmerican` path in `orders/index.ts`; that type is subsumed
 * into `ReferenceOdds` when `buildDesiredQuote` is generalized for spread / total.)
 *
 * Side semantics (DESIGN §5, `OspexTypes.sol`): moneyline and spread are
 * away/home; total is over/under. Line values are decimal points (e.g. `-1.5`,
 * `7.5`) — the on-chain `int32`, 10×-scaled `lineTicks` conversion happens at
 * commitment construction, behind the SDK.
 */

import type { MoneylineOdds, SpreadOdds, TotalOdds } from '../ospex/index.js';

/** The MM's usable reference odds for one (contest, market) — every field populated (the no-usable-data case is the mapper's `null` return, not a partially-null object). */
export type ReferenceOdds =
  | {
      market: 'moneyline';
      awayOddsAmerican: number;
      homeOddsAmerican: number;
    }
  | {
      market: 'spread';
      /** Away team's spread line (= `-homeLine`). Negative if away is favored. */
      awayLine: number;
      /** Home team's spread line. Negative if home is favored. */
      homeLine: number;
      awayOddsAmerican: number;
      homeOddsAmerican: number;
    }
  | {
      market: 'total';
      /** Over/under threshold (perspective-neutral). */
      line: number;
      overOddsAmerican: number;
      underOddsAmerican: number;
    };

/**
 * Collapse an SDK per-market odds shape (`MoneylineOdds` / `SpreadOdds` /
 * `TotalOdds`) to the MM's usable {@link ReferenceOdds}, or `null` when a required
 * field is missing — a side price, or the line for spread / total. The SDK's
 * nullable fields encode "the writer hasn't priced this yet"; a `null` return means
 * there is no usable reference for this market right now.
 */
export function referenceOddsFromSdk(odds: MoneylineOdds | SpreadOdds | TotalOdds): ReferenceOdds | null {
  switch (odds.market) {
    case 'moneyline': {
      if (odds.awayOddsAmerican === null || odds.homeOddsAmerican === null) return null;
      return { market: 'moneyline', awayOddsAmerican: odds.awayOddsAmerican, homeOddsAmerican: odds.homeOddsAmerican };
    }
    case 'spread': {
      if (odds.awayLine === null || odds.homeLine === null || odds.awayOddsAmerican === null || odds.homeOddsAmerican === null) return null;
      return {
        market: 'spread',
        awayLine: odds.awayLine,
        homeLine: odds.homeLine,
        awayOddsAmerican: odds.awayOddsAmerican,
        homeOddsAmerican: odds.homeOddsAmerican,
      };
    }
    case 'total': {
      if (odds.line === null || odds.overOddsAmerican === null || odds.underOddsAmerican === null) return null;
      return { market: 'total', line: odds.line, overOddsAmerican: odds.overOddsAmerican, underOddsAmerican: odds.underOddsAmerican };
    }
  }
}

/**
 * True iff two {@link ReferenceOdds} carry the same market AND identical fields.
 * The change-detector the polling-fallback ingestion (`odds.subscribe: false`) uses
 * to decide whether the reference moved since last tick — and therefore whether the
 * market must re-quote. Market-aware: it compares exactly the fields that define each
 * market type (moneyline / spread side prices; spread lines + side prices; total line +
 * over/under prices), so it is correct for all three without per-caller branching.
 * (A re-quote *threshold* — re-quote only on a move beyond N ticks — is a later layer;
 * this is exact equality, matching today's "any move re-quotes" moneyline behavior.)
 */
/**
 * The on-chain `lineTicks` the oracle (reference odds) implies for this market —
 * the line a tracked speculation MUST carry for the reference price to apply to it.
 * `null` for moneyline (no line). The protocol stores spread `lineTicks` in
 * **away-perspective**, 10×-scaled (the SDK convention: a spec at away `-1.5` is
 * `-15`); total `lineTicks` is the threshold, 10×-scaled (`7.5` → `75`). So the
 * oracle ticks are `round(awayLine × 10)` for spread and `round(line × 10)` for
 * total — directly comparable to a tracked spec's `lineTicks`. The runner uses this
 * to refuse quoting a spread/total commitment whose on-chain line has diverged from
 * the reference line (which would post the reference's price at a different line).
 */
export function oracleLineTicks(ref: ReferenceOdds): number | null {
  switch (ref.market) {
    case 'moneyline':
      return null;
    case 'spread':
      return Math.round(ref.awayLine * 10); // spec lineTicks is away-perspective; awayLine is the away line
    case 'total':
      return Math.round(ref.line * 10);
  }
}

export function referenceOddsEqual(a: ReferenceOdds, b: ReferenceOdds): boolean {
  if (a.market !== b.market) return false;
  switch (a.market) {
    case 'moneyline':
      return b.market === 'moneyline' && a.awayOddsAmerican === b.awayOddsAmerican && a.homeOddsAmerican === b.homeOddsAmerican;
    case 'spread':
      return (
        b.market === 'spread' &&
        a.awayLine === b.awayLine &&
        a.homeLine === b.homeLine &&
        a.awayOddsAmerican === b.awayOddsAmerican &&
        a.homeOddsAmerican === b.homeOddsAmerican
      );
    case 'total':
      return b.market === 'total' && a.line === b.line && a.overOddsAmerican === b.overOddsAmerican && a.underOddsAmerican === b.underOddsAmerican;
  }
}
