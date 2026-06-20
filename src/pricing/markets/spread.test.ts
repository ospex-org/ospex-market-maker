import { describe, expect, it } from 'vitest';

import { isTickInRange } from '../odds.js';
import { priceSpread, type SpreadPricing, type SpreadReference } from './spread.js';

// Shared pricing scalars (direct mode) — mirrors the moneyline computeQuote fixture,
// minus the reference odds (a spread market sources those from its own juice).
const PRICING: SpreadPricing = {
  capitalUSDC: 1000,
  maxPerQuotePctOfCapital: 0.05,
  minEdgeBps: 0,
  quoteBothSides: true,
  awayHeadroomUSDC: 1000,
  homeHeadroomUSDC: 1000,
  mode: 'direct',
  direct: { spreadBps: 200 },
};

// Live-observed MLB run line: home favored -1.5 (away +1.5), away +152 / home -176.
const REF: SpreadReference = { awayLine: 1.5, homeLine: -1.5, awayOddsAmerican: 152, homeOddsAmerican: -176 };

// ── spread market pricing (adapter over computeQuote) ──────────────────────────

describe('priceSpread', () => {
  it('prices a real MLB run line as a two-sided cover quote, carrying the line', () => {
    const q = priceSpread(REF, PRICING);
    expect(q.awayLine).toBe(1.5);
    expect(q.homeLine).toBe(-1.5);
    const r = q.result;
    expect(r.canQuote).toBe(true);
    expect(r.away).not.toBeNull();
    expect(r.home).not.toBeNull();
    // The QuoteResult sides are the away-cover / home-cover taker offers.
    expect(r.away!.takerSide).toBe('away');
    expect(r.home!.takerSide).toBe('home');
    expect(isTickInRange(r.away!.quoteTick)).toBe(true);
    expect(isTickInRange(r.home!.quoteTick)).toBe(true);
    // The shared pipeline embeds the direct spread; the two quote probs sum to 1 + spread.
    expect(r.spread).toBe(0.02);
    expect(r.away!.quoteProb + r.home!.quoteProb).toBeCloseTo(1 + r.spread!, 12);
  });

  it('sizes each side by the per-quote cap when headroom is ample (perQuoteCap = capital × pct)', () => {
    const r = priceSpread(REF, PRICING).result;
    expect(r.away!.sizeWei6).toBe(50_000_000); // 1000 × 0.05 = 50 USDC, under headroom 1000
    expect(r.home!.sizeWei6).toBe(50_000_000);
  });

  it('quotes only the side with headroom when the other is capped', () => {
    const r = priceSpread(REF, { ...PRICING, awayHeadroomUSDC: 0 }).result;
    expect(r.away).toBeNull();
    expect(r.home).not.toBeNull();
    expect(r.canQuote).toBe(true);
  });

  it('refuses (does not throw) on bad reference juice, still carrying the line', () => {
    const q = priceSpread({ ...REF, awayOddsAmerican: 0 }, PRICING);
    expect(q.result.canQuote).toBe(false);
    expect(q.result.away).toBeNull();
    expect(q.result.home).toBeNull();
    expect(q.result.notes.some((n) => n.startsWith('REFUSE:'))).toBe(true);
    expect(q.awayLine).toBe(1.5); // line still reported on a refusal
    expect(q.homeLine).toBe(-1.5);
  });

  it('prices a pick-em spread (line 0) — 0 is a real line, not "missing"', () => {
    const q = priceSpread({ awayLine: 0, homeLine: 0, awayOddsAmerican: -110, homeOddsAmerican: -110 }, PRICING);
    expect(q.awayLine).toBe(0);
    expect(q.result.canQuote).toBe(true);
  });

  it('still throws on an invalid caller argument (delegates computeQuote validation)', () => {
    expect(() => priceSpread(REF, { ...PRICING, capitalUSDC: 0 })).toThrow(/capitalUSDC/);
  });
});
