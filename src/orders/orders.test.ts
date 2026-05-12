import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../config/index.js';
import type { ExposureItem, Inventory, Market } from '../risk/index.js';
import { breakdownReferenceOdds, buildDesiredQuote, toRiskCaps } from './index.js';

const cfg = (overrides: Record<string, unknown> = {}): Config => parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });

const MARKET: Market = { contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD' };
const EMPTY: Inventory = { items: [], openCommitmentCount: 0 };
function inventoryWith(items: ExposureItem[]): Inventory {
  return { items, openCommitmentCount: items.length };
}

// ── breakdownReferenceOdds ───────────────────────────────────────────────────

describe('breakdownReferenceOdds', () => {
  it('converts American → decimal + implied, and computes the overround', () => {
    const b = breakdownReferenceOdds(150, -180);
    expect(b.awayDecimal).toBeCloseTo(2.5, 6);
    expect(b.homeDecimal).toBeCloseTo(1 + 100 / 180, 6);
    expect(b.awayImpliedProb).toBeCloseTo(0.4, 6);
    expect(b.homeImpliedProb).toBeCloseTo(1 / (1 + 100 / 180), 6);
    expect(b.overround).toBeCloseTo(0.4 + 1 / (1 + 100 / 180) - 1, 6);
    expect(b.overround).toBeGreaterThan(0);
  });
});

// ── toRiskCaps ───────────────────────────────────────────────────────────────

describe('toRiskCaps', () => {
  it('mirrors config.risk (dropping maxDailyFeeUSDC, which the engine does not take)', () => {
    const caps = toRiskCaps(cfg());
    // default config (the example yaml): bankroll 50, util 0.5, per-commitment 0.25, per-contest 1, per-team 2, per-sport 5, maxOpen 10.
    expect(caps).toEqual({
      bankrollUSDC: 50,
      maxBankrollUtilizationPct: 0.5,
      maxRiskPerCommitmentUSDC: 0.25,
      maxRiskPerContestUSDC: 1,
      maxRiskPerTeamUSDC: 2,
      maxRiskPerSportUSDC: 5,
      maxOpenCommitments: 10,
    });
  });
});

// ── buildDesiredQuote ────────────────────────────────────────────────────────

describe('buildDesiredQuote', () => {
  it('prices a two-sided quote against an empty inventory (default economics config)', () => {
    const d = buildDesiredQuote(cfg(), MARKET, { away: 150, home: -180 }, EMPTY);
    expect(d.referenceOdds).not.toBeNull();
    expect(d.referenceOdds?.overround).toBeGreaterThan(0);
    // Empty inventory + default caps → headroom on each side is the per-commitment cap (0.25), the smallest.
    expect(d.headroomUSDC.away).toBeCloseTo(0.25, 9);
    expect(d.headroomUSDC.home).toBeCloseTo(0.25, 9);
    expect(d.result.canQuote).toBe(true);
    // perQuoteCap = capitalUSDC(50) * maxPerQuotePctOfCapital(0.05) = 2.5; size = min(2.5, headroom 0.25) = 0.25 USDC.
    expect(d.result.away?.sizeUSDC).toBeCloseTo(0.25, 9);
    expect(d.result.home?.sizeUSDC).toBeCloseTo(0.25, 9);
    expect(d.result.fair).not.toBeNull();
    expect(d.result.spread).not.toBeNull();
  });

  it('reduces headroom on a side that already carries exposure on that contest', () => {
    // An away-side item of 0.9 USDC on C1 → loses if home wins → "currentLossInThatBucket" for adding more to away is 0.9.
    // away headroom = min(perCommitment 0.25, perContest 1 - 0.9 ≈ 0.1, perTeam 2 - 0.9, perSport 5 - 0.9, bankroll 25 - 0.9) ≈ 0.1.
    // home headroom = min(0.25, 1 - 0, 2 - 0, 5 - 0, 25 - 0.9) = 0.25.
    const inv = inventoryWith([{ contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', riskAmountUSDC: 0.9 }]);
    const d = buildDesiredQuote(cfg(), MARKET, { away: 150, home: -180 }, inv);
    expect(d.headroomUSDC.away).toBeCloseTo(0.1, 6);
    expect(d.headroomUSDC.home).toBeCloseTo(0.25, 9);
    // Both sides still quoted, but the away quote is the smaller one (its headroom is the binding cap, ≈ 0.1, vs the home side's 0.25).
    expect(d.result.away).not.toBeNull();
    expect(d.result.home).not.toBeNull();
    expect(d.result.away?.sizeWei6 ?? 0).toBeLessThan(d.result.home?.sizeWei6 ?? 0);
    expect(d.result.away?.sizeUSDC ?? 0).toBeLessThan(0.25);
  });

  it('pulls a side whose headroom has been exhausted (clamps to 0)', () => {
    // 1.5 USDC of away-side exposure on C1 → over the per-contest cap of 1 → away headroom clamps to 0.
    const inv = inventoryWith([{ contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', riskAmountUSDC: 1.5 }]);
    const d = buildDesiredQuote(cfg(), MARKET, { away: 150, home: -180 }, inv);
    expect(d.headroomUSDC.away).toBe(0);
    expect(d.result.away).toBeNull();
    // home still has headroom
    expect(d.result.home).not.toBeNull();
  });

  it('reports canQuote: false when the math refuses (direct spread far exceeds the consensus overround)', () => {
    const d = buildDesiredQuote(cfg({ pricing: { mode: 'direct', direct: { spreadBps: 9000 } } }), MARKET, { away: 150, home: -180 }, EMPTY);
    expect(d.result.canQuote).toBe(false);
    expect(d.result.notes.some((n) => n.startsWith('REFUSE:'))).toBe(true);
  });

  it('refuses (both sides null) when the open-commitment count cap is hit — even with positive exposure headroom', () => {
    // openCommitmentCount 1 / maxOpenCommitments 1 → verdictForMarket refuses, but headroomForSide over an empty `items` array is still the full per-commitment cap.
    const d = buildDesiredQuote(cfg({ risk: { maxOpenCommitments: 1 } }), MARKET, { away: 150, home: -180 }, { items: [], openCommitmentCount: 1 });
    expect(d.result.canQuote).toBe(false);
    expect(d.result.away).toBeNull();
    expect(d.result.home).toBeNull();
    expect(d.result.notes.some((n) => /open-commitment count/.test(n))).toBe(true);
    // headroom + the reference breakdown are still populated (the refusal is the count cap, not the odds or the exposure size).
    expect(d.headroomUSDC.away).toBeGreaterThan(0);
    expect(d.referenceOdds).not.toBeNull();
  });

  it('refuses (referenceOdds: null) when the upstream reference odds are out of range — does not throw', () => {
    for (const bad of [{ away: 0, home: -180 }, { away: Number.NaN, home: -180 }, { away: Number.POSITIVE_INFINITY, home: -180 }] as const) {
      const d = buildDesiredQuote(cfg(), MARKET, bad, EMPTY);
      expect(d.referenceOdds).toBeNull();
      expect(d.result.canQuote).toBe(false);
      expect(d.result.away).toBeNull();
      expect(d.result.home).toBeNull();
      expect(d.result.notes.some((n) => /invalid|out of range/.test(n))).toBe(true);
      // headroom is still populated (the inventory was fine).
      expect(d.headroomUSDC.away).toBeGreaterThan(0);
    }
  });

  it('carries the spread mode through (economics vs direct)', () => {
    expect(buildDesiredQuote(cfg(), MARKET, { away: 150, home: -180 }, EMPTY).result.targetMonthlyReturnUSDC).not.toBeNull(); // economics mode populates these
    const direct = buildDesiredQuote(cfg({ pricing: { mode: 'direct', direct: { spreadBps: 200 } } }), MARKET, { away: 150, home: -180 }, EMPTY);
    expect(direct.result.targetMonthlyReturnUSDC).toBeNull(); // direct mode has no economics diagnostics
  });
});
