import { describe, expect, it } from 'vitest';

import { isTickInRange } from '../odds.js';
import { toProtocolQuote } from '../protocol.js';
import { priceTotal, type TotalPricing, type TotalReference } from './total.js';

const PRICING: TotalPricing = {
  capitalUSDC: 1000,
  maxPerQuotePctOfCapital: 0.05,
  minEdgeBps: 0,
  quoteBothSides: true,
  awayHeadroomUSDC: 1000,
  homeHeadroomUSDC: 1000,
  mode: 'direct',
  direct: { spreadBps: 200 },
};

// Live-observed MLB total: line 7.5, over +104 (underdog) / under -123 (favorite).
const REF: TotalReference = { line: 7.5, overOddsAmerican: 104, underOddsAmerican: -123 };

// ── total market pricing (adapter over computeQuote, over/under relabel) ────────

describe('priceTotal', () => {
  it('prices a real MLB total as a two-sided over/under quote, carrying the line', () => {
    const q = priceTotal(REF, PRICING);
    expect(q.line).toBe(7.5);
    expect(q.canQuote).toBe(true);
    expect(q.over).not.toBeNull();
    expect(q.under).not.toBeNull();
    expect(isTickInRange(q.over!.quoteTick)).toBe(true);
    expect(isTickInRange(q.under!.quoteTick)).toBe(true);
    expect(q.spread).toBe(0.02);
  });

  it('maps the OVER juice to the `over` side: over (+104, underdog) is priced less likely than under (-123, favorite)', () => {
    const q = priceTotal(REF, PRICING);
    // If the over/under juice were swapped into the wrong slots, this inverts.
    expect(q.over!.quoteProb).toBeLessThan(q.under!.quoteProb);
  });

  it('side mapping is protocol-correct: over → maker home/Lower/1, under → maker away/Upper/0', () => {
    // The executable contract (OspexTypes.sol: Upper/0 = over, Lower/1 = under).
    // The maker takes the opposite of each taker offer via toProtocolQuote — called
    // exactly as the runner's sign boundary does: { side: takerSide, oddsTick: quoteTick }.
    const q = priceTotal(REF, PRICING);
    expect(toProtocolQuote({ side: q.over!.takerSide, oddsTick: q.over!.quoteTick })).toMatchObject({ makerSide: 'home', positionType: 1 }); // over offer -> maker on under
    expect(toProtocolQuote({ side: q.under!.takerSide, oddsTick: q.under!.quoteTick })).toMatchObject({ makerSide: 'away', positionType: 0 }); // under offer -> maker on over
  });

  it('quotes only the side with headroom — awayHeadroom gates the OVER side', () => {
    const q = priceTotal(REF, { ...PRICING, awayHeadroomUSDC: 0 });
    expect(q.over).toBeNull();
    expect(q.under).not.toBeNull();
    expect(q.canQuote).toBe(true);
  });

  it('refuses (does not throw) on bad reference juice, still carrying the line', () => {
    const q = priceTotal({ ...REF, underOddsAmerican: 0 }, PRICING);
    expect(q.canQuote).toBe(false);
    expect(q.over).toBeNull();
    expect(q.under).toBeNull();
    expect(q.notes.some((n) => n.startsWith('REFUSE:'))).toBe(true);
    expect(q.line).toBe(7.5);
  });

  it('still throws on an invalid caller argument (delegates computeQuote validation)', () => {
    expect(() => priceTotal(REF, { ...PRICING, capitalUSDC: 0 })).toThrow(/capitalUSDC/);
  });
});
