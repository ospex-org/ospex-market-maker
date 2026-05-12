import { describe, expect, it } from 'vitest';

import {
  americanToDecimal,
  decimalToAmerican,
  decimalToImpliedProb,
  decimalToTick,
  impliedProbToDecimal,
  inverseOddsTick,
  isTickInRange,
  quantizeRiskWei6,
  tickToDecimal,
  wei6ToUSDC,
} from './odds.js';
import { oppositeSide, positionTypeForSide, sideForPositionType, toProtocolQuote } from './protocol.js';
import { stripVig } from './vig.js';
import { deriveSpreadDirect, deriveSpreadEconomics, expectedMonthlyFilledVolumeUSDC } from './spread.js';
import { computeQuote } from './quote.js';
import type { EconomicsInputs, QuoteCommonInputs } from './types.js';

// ── odds conversions ──────────────────────────────────────────────────────────

describe('odds conversions', () => {
  it('americanToDecimal', () => {
    expect(americanToDecimal(150)).toBe(2.5);
    expect(americanToDecimal(-200)).toBe(1.5);
    expect(americanToDecimal(100)).toBe(2);
    expect(() => americanToDecimal(0)).toThrow();
    expect(() => americanToDecimal(Number.NaN)).toThrow();
  });

  it('decimalToAmerican', () => {
    expect(decimalToAmerican(2.5)).toBe(150);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(decimalToAmerican(2)).toBe(100);
    expect(() => decimalToAmerican(1)).toThrow();
    expect(() => decimalToAmerican(0.5)).toThrow();
  });

  it('implied-probability conversions', () => {
    expect(decimalToImpliedProb(2)).toBe(0.5);
    expect(impliedProbToDecimal(0.5)).toBe(2);
    expect(() => decimalToImpliedProb(1)).toThrow();
    expect(() => impliedProbToDecimal(0)).toThrow();
    expect(() => impliedProbToDecimal(1)).toThrow();
  });

  it('tick conversions and range checks', () => {
    expect(decimalToTick(1.91)).toBe(191);
    expect(decimalToTick(2.5)).toBe(250);
    expect(tickToDecimal(191)).toBe(1.91);
    expect(isTickInRange(101)).toBe(true);
    expect(isTickInRange(10_100)).toBe(true);
    expect(isTickInRange(100)).toBe(false);
    expect(isTickInRange(10_101)).toBe(false);
    expect(isTickInRange(150.5)).toBe(false);
  });

  it('inverseOddsTick — symmetric counterparty tick', () => {
    expect(inverseOddsTick(150)).toBe(300);
    expect(inverseOddsTick(300)).toBe(150);
    expect(inverseOddsTick(200)).toBe(200);
    expect(inverseOddsTick(198)).toBe(202);
    expect(inverseOddsTick(202)).toBe(198);
    expect(inverseOddsTick(250)).toBe(167); // round(25000/150) = round(166.67)
    expect(inverseOddsTick(101)).toBe(10_100); // protocol min ↔ max
    expect(inverseOddsTick(10_100)).toBe(101);
    expect(() => inverseOddsTick(100)).toThrow(/odds tick in/); // would divide by zero
    expect(() => inverseOddsTick(10_101)).toThrow(/odds tick in/); // above MAX
    expect(() => inverseOddsTick(150.5)).toThrow(/odds tick in/); // non-integer
  });

  it('inverseOddsTick stays in range and is the rounded exact inverse, across the whole tick range', () => {
    for (let t = 101; t <= 10_100; t++) {
      const inv = inverseOddsTick(t);
      expect(isTickInRange(inv)).toBe(true);
      expect(inv).toBe(Math.round((100 * t) / (t - 100)));
    }
  });

  it('inverseOddsTick round-trips exactly on the canonical pairs (but is not a blind involution)', () => {
    for (const t of [101, 150, 198, 200, 202, 300, 10_100]) {
      expect(inverseOddsTick(inverseOddsTick(t))).toBe(t);
    }
    // Double-rounding loses information when the exact inverse lands just above
    // the 1.00× floor (a very lopsided maker tick → a taker tick barely over
    // even money), so a blind round-trip is *not* an involution in general — and
    // nothing in the MM relies on one (every odds conversion is a single hop).
    expect(inverseOddsTick(inverseOddsTick(6767))).not.toBe(6767);
  });

  it('quantizeRiskWei6 rounds down to a valid lot (never up — it is a risk/safety boundary)', () => {
    expect(quantizeRiskWei6(0.25)).toBe(250_000);
    expect(quantizeRiskWei6(0.250001)).toBe(250_000);
    expect(quantizeRiskWei6(50)).toBe(50_000_000);
    expect(quantizeRiskWei6(0.0001)).toBe(100); // exactly one lot
    expect(quantizeRiskWei6(0.00019999)).toBe(100); // between one and two lots → one lot
    expect(quantizeRiskWei6(0.0002)).toBe(200); // exactly two lots
    expect(quantizeRiskWei6(0.00005)).toBe(0); // 50 wei6 — below one lot
    expect(quantizeRiskWei6(0.0000999)).toBe(0); // 99.9 wei6 — below one lot; must NOT round up to 100
    expect(quantizeRiskWei6(0)).toBe(0);
    expect(quantizeRiskWei6(-1)).toBe(0);
    expect(quantizeRiskWei6(Number.NaN)).toBe(0);
    expect(quantizeRiskWei6(Number.POSITIVE_INFINITY)).toBe(0);
    expect(wei6ToUSDC(250_000)).toBe(0.25);
  });
});

// ── taker ↔ protocol conversion ───────────────────────────────────────────────

describe('taker ↔ protocol conversion (DESIGN §5)', () => {
  it('oppositeSide / positionTypeForSide / sideForPositionType', () => {
    expect(oppositeSide('away')).toBe('home');
    expect(oppositeSide('home')).toBe('away');
    expect(positionTypeForSide('away')).toBe(0); // Upper
    expect(positionTypeForSide('home')).toBe(1); // Lower
    expect(sideForPositionType(0)).toBe('away');
    expect(sideForPositionType(1)).toBe('home');
    expect(() => oppositeSide('sideways' as unknown as 'away')).toThrow(/must be "away" or "home"/);
    expect(() => positionTypeForSide('over' as unknown as 'away')).toThrow(/must be "away" or "home"/);
    expect(() => sideForPositionType(2 as unknown as 0)).toThrow(/must be 0 or 1/);
  });

  it('toProtocolQuote inverts the side and the odds tick', () => {
    // Offering a taker the AWAY side at tick 198 → the maker is on HOME at the inverse tick.
    expect(toProtocolQuote({ side: 'away', oddsTick: 198 })).toEqual({
      makerSide: 'home',
      makerOddsTick: 202,
      positionType: 1, // Lower = home
    });
    // Offering a taker the HOME side at tick 198 → the maker is on AWAY at the inverse tick.
    expect(toProtocolQuote({ side: 'home', oddsTick: 198 })).toEqual({
      makerSide: 'away',
      makerOddsTick: 202,
      positionType: 0, // Upper = away
    });
    // The decimal-2.00 (tick-200) midpoint maps to itself on the opposite side.
    expect(toProtocolQuote({ side: 'away', oddsTick: 200 })).toEqual({
      makerSide: 'home',
      makerOddsTick: 200,
      positionType: 1,
    });
    expect(() => toProtocolQuote({ side: 'away', oddsTick: 100 })).toThrow(/odds tick in/);
  });

  it('a taker-facing quote with the half-spread baked in gives the maker positive EV (the un-inverted mapping does not)', () => {
    // Fair 50/50 market, 100 bps quoting spread → 0.005 half-spread on each side.
    const pAway = 0.5;
    const pHome = 0.5;
    const halfSpread = 0.005;
    const awayQuoteProb = pAway + halfSpread; // 0.505 — a taker backing away faces an inflated probability
    const awayTakerTick = decimalToTick(1 / awayQuoteProb); // round(198.0198) = 198
    expect(awayTakerTick).toBe(198);

    // Correct: convert to the protocol maker side — the maker ends up on HOME at the inverse tick.
    const proto = toProtocolQuote({ side: 'away', oddsTick: awayTakerTick });
    expect(proto.makerSide).toBe('home');
    expect(proto.makerOddsTick).toBe(202);
    const makerEvPerRisk = pHome * (proto.makerOddsTick / 100 - 1) - pAway * 1;
    expect(makerEvPerRisk).toBeGreaterThan(0); // ≈ +0.01 — the maker holds the half-spread of edge

    // The bug this whole change fixes: posting the taker tick *directly* as a maker-on-away commitment.
    const wrongMakerOnAwayEv = pAway * (awayTakerTick / 100 - 1) - pHome * 1;
    expect(wrongMakerOnAwayEv).toBeLessThan(0); // ≈ −0.01 — the maker bleeds the spread it meant to earn
  });
});

// ── stripVig ──────────────────────────────────────────────────────────────────

describe('stripVig', () => {
  it('recovers fair probabilities from a vig-laden moneyline', () => {
    const fair = stripVig(2.1, 1.8);
    expect(fair.consensusOverround).toBeCloseTo(1 / 2.1 + 1 / 1.8 - 1, 10);
    expect(fair.consensusOverround).toBeGreaterThan(0);
    expect(fair.awayFairProb + fair.homeFairProb).toBeCloseTo(1, 12);
    expect(fair.awayFairDecimal).toBeCloseTo(1 / fair.awayFairProb, 12);
    // away (2.1) is the longer price → lower fair prob than home (1.8).
    expect(fair.awayFairProb).toBeLessThan(fair.homeFairProb);
  });

  it('throws when the reference odds imply a sub-1 book (data error)', () => {
    expect(() => stripVig(3, 3)).toThrow(/sum to/);
  });
});

// ── spread derivation ─────────────────────────────────────────────────────────

const ECON: EconomicsInputs = {
  targetMonthlyReturnPct: 0.005,
  daysHorizon: 30,
  estGamesPerDay: 10,
  fillRateAssumption: 0.3,
  capitalTurnoverPerDay: 1,
  maxReasonableSpread: 0.05,
};

describe('expectedMonthlyFilledVolumeUSDC', () => {
  it('matches the model', () => {
    // maxPerQuote = 1000*0.05 = 50; quotedUncapped = 10*2*50 = 1000; dailyCap = 1000;
    // quotedPerDay = 1000; filledPerDay = 1000*0.3 = 300; monthly = 300*30 = 9000.
    expect(expectedMonthlyFilledVolumeUSDC(1000, 0.05, ECON)).toBeCloseTo(9000, 6);
  });
});

describe('deriveSpreadEconomics', () => {
  const fair = stripVig(2.1, 1.8); // overround ≈ 3.17%

  it('happy path — feasible target → a thin spread', () => {
    const r = deriveSpreadEconomics(1000, 0.05, ECON, fair, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.spread).toBeCloseTo(5 / 4500, 12); // targetReturn 5 / (expectedFilled 9000 / 2)
    expect(r.diagnostics?.targetMonthlyReturnUSDC).toBe(5);
    expect(r.diagnostics?.expectedMonthlyFilledVolumeUSDC).toBeCloseTo(9000, 6);
  });

  it('refuses when the implied spread exceeds maxReasonableSpread', () => {
    const r = deriveSpreadEconomics(1000, 0.05, { ...ECON, targetMonthlyReturnPct: 1 }, fair, 0);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/maxReasonableSpread/);
  });

  it('refuses when the implied spread is wider than the consensus overround', () => {
    // targetReturn 180 → targetSpread 0.04: > overround (≈0.0317) but < maxReasonableSpread (0.05).
    const r = deriveSpreadEconomics(1000, 0.05, { ...ECON, targetMonthlyReturnPct: 0.18 }, fair, 0);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/consensus overround/);
  });

  it('refuses when the implied spread is below minEdgeBps', () => {
    const r = deriveSpreadEconomics(1000, 0.05, ECON, fair, 50); // ≈11 bps < 50 bps
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/minEdgeBps/);
  });
});

describe('deriveSpreadDirect', () => {
  const fair = stripVig(2.1, 1.8); // overround ≈ 3.17%

  it('happy path', () => {
    const r = deriveSpreadDirect(200, fair, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.spread).toBe(0.02);
  });

  it('refuses when wider than the consensus overround', () => {
    const r = deriveSpreadDirect(400, fair, 0);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/consensus overround/);
  });

  it('refuses non-positive spreadBps', () => {
    expect(deriveSpreadDirect(0, fair, 0).ok).toBe(false);
    expect(deriveSpreadDirect(-10, fair, 0).ok).toBe(false);
  });

  it('refuses below minEdgeBps', () => {
    const r = deriveSpreadDirect(50, fair, 100);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/minEdgeBps/);
  });
});

// ── computeQuote ──────────────────────────────────────────────────────────────

const COMMON: QuoteCommonInputs = {
  consensusAwayDecimal: 2.1,
  consensusHomeDecimal: 1.8,
  capitalUSDC: 1000,
  maxPerQuotePctOfCapital: 0.05,
  minEdgeBps: 0,
  quoteBothSides: true,
  awayHeadroomUSDC: 1000,
  homeHeadroomUSDC: 1000,
};

describe('computeQuote', () => {
  it('economics mode — produces a sane two-sided quote', () => {
    const r = computeQuote({ ...COMMON, mode: 'economics', economics: ECON });
    expect(r.canQuote).toBe(true);
    expect(r.away).not.toBeNull();
    expect(r.home).not.toBeNull();
    expect(r.notes).toHaveLength(0);
    const away = r.away!;
    const home = r.home!;
    expect(away.sizeWei6).toBe(50_000_000); // perQuoteCap = 1000*0.05 = 50 USDC, clamped by headroom 1000
    expect(home.sizeWei6).toBe(50_000_000);
    expect(away.sizeUSDC).toBe(50);
    // ticks in the protocol range
    expect(isTickInRange(away.quoteTick)).toBe(true);
    expect(isTickInRange(home.quoteTick)).toBe(true);
    // each side quoted at fair + half-spread
    expect(r.spread).toBeCloseTo(5 / 4500, 12);
    expect(away.quoteProb).toBeCloseTo(r.fair!.awayFairProb + r.spread! / 2, 12);
    expect(home.quoteProb).toBeCloseTo(r.fair!.homeFairProb + r.spread! / 2, 12);
    // embedded overround = the quoting spread
    expect(away.quoteProb + home.quoteProb).toBeCloseTo(1 + r.spread!, 12);
    expect(Number.isFinite(away.quoteAmerican)).toBe(true);
    expect(r.targetMonthlyReturnUSDC).toBe(5);
    expect(r.expectedMonthlyFilledVolumeUSDC).toBeCloseTo(9000, 6);
  });

  it('direct mode — uses spreadBps, no economics diagnostics', () => {
    const r = computeQuote({ ...COMMON, mode: 'direct', direct: { spreadBps: 200 } });
    expect(r.canQuote).toBe(true);
    expect(r.spread).toBe(0.02);
    expect(r.targetMonthlyReturnUSDC).toBeNull();
    expect(r.expectedMonthlyFilledVolumeUSDC).toBeNull();
    expect(r.away!.quoteProb + r.home!.quoteProb).toBeCloseTo(1.02, 12);
  });

  it('refuses when the economics imply too wide a spread', () => {
    const r = computeQuote({ ...COMMON, mode: 'economics', economics: { ...ECON, targetMonthlyReturnPct: 1 } });
    expect(r.canQuote).toBe(false);
    expect(r.away).toBeNull();
    expect(r.home).toBeNull();
    expect(r.spread).toBeNull();
    expect(r.fair).not.toBeNull(); // we got past stripVig
    expect(r.notes[0]).toMatch(/^REFUSE:/);
    expect(r.notes[0]).toMatch(/maxReasonableSpread/);
  });

  it('refuses on bad reference odds (sub-1 implied book)', () => {
    const r = computeQuote({ ...COMMON, consensusAwayDecimal: 3, consensusHomeDecimal: 3, mode: 'economics', economics: ECON });
    expect(r.canQuote).toBe(false);
    expect(r.fair).toBeNull();
    expect(r.notes[0]).toMatch(/^REFUSE:/);
    expect(r.notes[0]).toMatch(/sum to/);
  });

  it('refuses quoteBothSides=false (not implemented in v0)', () => {
    const r = computeQuote({ ...COMMON, quoteBothSides: false, mode: 'economics', economics: ECON });
    expect(r.canQuote).toBe(false);
    expect(r.notes[0]).toMatch(/quoteBothSides=false/);
  });

  it('clamps a side to its exposure headroom', () => {
    const r = computeQuote({ ...COMMON, awayHeadroomUSDC: 10, mode: 'economics', economics: ECON });
    expect(r.canQuote).toBe(true);
    expect(r.away!.sizeWei6).toBe(10_000_000); // clamped to the 10-USDC headroom
    expect(r.home!.sizeWei6).toBe(50_000_000); // perQuoteCap (50) < headroom (1000)
  });

  it('upsizes the open side 1.5× when the other side is capped', () => {
    const r = computeQuote({ ...COMMON, awayHeadroomUSDC: 0, mode: 'economics', economics: ECON });
    expect(r.canQuote).toBe(true);
    expect(r.away).toBeNull();
    expect(r.home).not.toBeNull();
    expect(r.home!.sizeWei6).toBe(75_000_000); // 50 USDC × 1.5
    expect(r.notes.some((n) => /upsizing the home quote 1\.5/.test(n))).toBe(true);
    expect(r.notes.some((n) => /away side: no exposure headroom/.test(n))).toBe(true);
  });

  it('pulls a side whose size rounds below one lot', () => {
    const r = computeQuote({
      ...COMMON,
      capitalUSDC: 0.001, // perQuoteCap = 0.001 × 0.05 = 0.00005 USDC = 50 wei6 < one 100-wei6 lot
      mode: 'direct',
      direct: { spreadBps: 100 },
    });
    expect(r.canQuote).toBe(false);
    expect(r.away).toBeNull();
    expect(r.home).toBeNull();
    expect(r.notes.some((n) => /rounds to zero/.test(n))).toBe(true);
    expect(r.notes.some((n) => /^REFUSE: both sides/.test(n))).toBe(true);
  });

  it('never quotes over the available headroom — a sub-lot headroom yields no quote', () => {
    // 0.0000999 USDC = 99.9 wei6, below the 100-wei6 lot. The previous `Math.round`
    // rounded that up to a full lot — quoting *over* the stated headroom. With the
    // `Math.floor` fix it quantizes to 0, so the side is pulled.
    const r = computeQuote({
      ...COMMON,
      awayHeadroomUSDC: 0.0000999,
      homeHeadroomUSDC: 0,
      mode: 'direct',
      direct: { spreadBps: 100 },
    });
    expect(r.canQuote).toBe(false);
    expect(r.away).toBeNull();
    expect(r.home).toBeNull();
  });

  it('throws on invalid caller arguments', () => {
    expect(() => computeQuote({ ...COMMON, capitalUSDC: 0, mode: 'economics', economics: ECON })).toThrow(/capitalUSDC/);
    expect(() => computeQuote({ ...COMMON, mode: 'economics', economics: { ...ECON, fillRateAssumption: 0 } })).toThrow(/fillRateAssumption/);
    expect(() => computeQuote({ ...COMMON, awayHeadroomUSDC: -1, mode: 'direct', direct: { spreadBps: 100 } })).toThrow(/headroom/);
    // non-finite parameters throw (they come from config / risk calcs — a NaN/Infinity there is a bug)
    expect(() => computeQuote({ ...COMMON, capitalUSDC: Number.POSITIVE_INFINITY, mode: 'direct', direct: { spreadBps: 100 } })).toThrow(/finite/);
    expect(() => computeQuote({ ...COMMON, awayHeadroomUSDC: Number.POSITIVE_INFINITY, mode: 'direct', direct: { spreadBps: 100 } })).toThrow(/finite/);
    expect(() => computeQuote({ ...COMMON, mode: 'economics', economics: { ...ECON, daysHorizon: Number.NaN } })).toThrow(/finite/);
    expect(() => computeQuote({ ...COMMON, mode: 'direct', direct: { spreadBps: Number.NaN } })).toThrow(/finite/);
  });
});
