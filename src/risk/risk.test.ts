import { describe, expect, it } from 'vitest';

import {
  canSpendGas,
  headroomForSide,
  requiredPositionModuleAllowanceUSDC,
  teamExposureUSDC,
  totalWorstCaseUSDC,
  verdictForMarket,
  worstCaseByOutcome,
  type ExposureItem,
  type Inventory,
  type Market,
  type RiskCaps,
} from './index.js';

function item(o: Partial<ExposureItem> & Pick<ExposureItem, 'contestId' | 'makerSide' | 'riskAmountUSDC'>): ExposureItem {
  return { sport: o.sport ?? 'mlb', awayTeam: o.awayTeam ?? 'AWAY', homeTeam: o.homeTeam ?? 'HOME', ...o };
}
function inventory(items: ExposureItem[], openCommitmentCount = items.length): Inventory {
  return { items, openCommitmentCount };
}
const HUGE = 1e9;
const caps = (o: Partial<RiskCaps> = {}): RiskCaps => ({
  bankrollUSDC: o.bankrollUSDC ?? HUGE,
  maxBankrollUtilizationPct: o.maxBankrollUtilizationPct ?? 1,
  maxRiskPerCommitmentUSDC: o.maxRiskPerCommitmentUSDC ?? HUGE,
  maxRiskPerContestUSDC: o.maxRiskPerContestUSDC ?? HUGE,
  maxRiskPerTeamUSDC: o.maxRiskPerTeamUSDC ?? HUGE,
  maxRiskPerSportUSDC: o.maxRiskPerSportUSDC ?? HUGE,
  maxOpenCommitments: o.maxOpenCommitments ?? 1000,
});
const market = (o: Partial<Market> = {}): Market => ({
  contestId: o.contestId ?? 'C1',
  sport: o.sport ?? 'mlb',
  awayTeam: o.awayTeam ?? 'AWAY',
  homeTeam: o.homeTeam ?? 'HOME',
});

describe('worstCaseByOutcome', () => {
  it('sums the at-risk USDC of the losing side in each outcome', () => {
    const items = [
      item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 5 }), // loses if HOME wins
      item({ contestId: 'C1', makerSide: 'home', riskAmountUSDC: 3 }), // loses if AWAY wins
      item({ contestId: 'C2', makerSide: 'away', riskAmountUSDC: 99 }), // different contest — ignored
    ];
    expect(worstCaseByOutcome(items, 'C1')).toEqual({ ifAwayWins: 3, ifHomeWins: 5 });
    expect(worstCaseByOutcome([], 'C1')).toEqual({ ifAwayWins: 0, ifHomeWins: 0 });
  });
});

describe('totalWorstCaseUSDC + teamExposureUSDC', () => {
  it('sums per-contest worst cases / per-team directional exposure', () => {
    const items = [
      item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 5, awayTeam: 'A' }),
      item({ contestId: 'C1', makerSide: 'home', riskAmountUSDC: 3, homeTeam: 'B' }),
      item({ contestId: 'C2', makerSide: 'home', riskAmountUSDC: 2, awayTeam: 'A', homeTeam: 'C' }),
    ];
    // C1 worst case = max(3, 5) = 5; C2 worst case = max(2, 0) = 2 → total 7
    expect(totalWorstCaseUSDC(items)).toBe(7);
    // maker is on team A on C1's away side (risk 5); on C2 maker is on home (team C), not A → A exposure = 5
    expect(teamExposureUSDC(items, 'A')).toBe(5);
    expect(teamExposureUSDC(items, 'C')).toBe(2);
    expect(teamExposureUSDC(items, 'A')).toBe(5);
  });
});

describe('headroomForSide', () => {
  it('each cap binds in turn; never over-estimates; clamps to 0', () => {
    // per-commitment cap
    expect(headroomForSide(inventory([]), market(), 'away', caps({ maxRiskPerCommitmentUSDC: 0.5 }))).toBe(0.5);
    // per-contest cap: maker already has 0.7 on C1's away side (→ loses if HOME wins) → away headroom = 1 - 0.7
    expect(
      headroomForSide(
        inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 0.7 })]),
        market({ contestId: 'C1' }),
        'away',
        caps({ maxRiskPerContestUSDC: 1 }),
      ),
    ).toBeCloseTo(0.3, 12);
    // per-team cap: 0.6 on team A elsewhere → headroom for another contest where A is the away team = 1 - 0.6
    expect(
      headroomForSide(
        inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 0.6, awayTeam: 'A' })]),
        market({ contestId: 'C2', awayTeam: 'A' }),
        'away',
        caps({ maxRiskPerTeamUSDC: 1 }),
      ),
    ).toBeCloseTo(0.4, 12);
    // per-sport cap: 0.7 worst-case in mlb (on C1) → headroom for C2 (also mlb) = 1 - 0.7
    expect(
      headroomForSide(
        inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 0.7, sport: 'mlb' })]),
        market({ contestId: 'C2', sport: 'mlb' }),
        'home',
        caps({ maxRiskPerSportUSDC: 1 }),
      ),
    ).toBeCloseTo(0.3, 12);
    // bankroll ceiling: ceiling = 1 * 1 = 1; current worst-case total = 0.7 → headroom = 0.3
    expect(
      headroomForSide(
        inventory([item({ contestId: 'C1', makerSide: 'home', riskAmountUSDC: 0.7 })]),
        market({ contestId: 'C2' }),
        'away',
        caps({ bankrollUSDC: 1, maxBankrollUtilizationPct: 1 }),
      ),
    ).toBeCloseTo(0.3, 12);
    // already over the per-contest cap → clamps to 0
    expect(
      headroomForSide(
        inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 2 })]),
        market({ contestId: 'C1' }),
        'away',
        caps({ maxRiskPerContestUSDC: 1 }),
      ),
    ).toBe(0);
  });
});

describe('verdictForMarket', () => {
  it('allows when there is headroom and no global cap is hit', () => {
    expect(verdictForMarket(inventory([]), market(), caps({ maxRiskPerCommitmentUSDC: 1 }))).toEqual({ allowed: true });
  });
  it('refuses at the open-commitment count', () => {
    const v = verdictForMarket(inventory([], 10), market(), caps({ maxOpenCommitments: 10 }));
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.reason).toMatch(/open-commitment count/);
  });
  it('refuses at the bankroll exposure ceiling', () => {
    const v = verdictForMarket(
      inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 1 })]),
      market({ contestId: 'C2' }),
      caps({ bankrollUSDC: 1, maxBankrollUtilizationPct: 1 }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.reason).toMatch(/bankroll exposure ceiling/);
  });
  it('refuses when neither side has headroom', () => {
    // both sides of C1 already at the per-contest cap
    const v = verdictForMarket(
      inventory([
        item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: 1 }),
        item({ contestId: 'C1', makerSide: 'home', riskAmountUSDC: 1 }),
      ]),
      market({ contestId: 'C1' }),
      caps({ maxRiskPerContestUSDC: 1 }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.reason).toMatch(/no exposure headroom on either side/);
  });
});

describe('requiredPositionModuleAllowanceUSDC', () => {
  it('is the min of (maxOpenCommitments × per-commitment cap) and (bankroll × utilization)', () => {
    expect(requiredPositionModuleAllowanceUSDC(caps({ maxOpenCommitments: 10, maxRiskPerCommitmentUSDC: 0.5, bankrollUSDC: 50, maxBankrollUtilizationPct: 0.5 }))).toBe(5);
    expect(requiredPositionModuleAllowanceUSDC(caps({ maxOpenCommitments: 4, maxRiskPerCommitmentUSDC: 10, bankrollUSDC: 50, maxBankrollUtilizationPct: 0.5 }))).toBe(25);
  });
});

describe('runtime guards (the money-risk boundary — malformed input throws, never fails open)', () => {
  it('rejects NaN / negative / non-finite riskAmountUSDC', () => {
    const bad = inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: Number.NaN })]);
    expect(() => worstCaseByOutcome(bad.items, 'C1')).toThrow(/finite, non-negative/);
    expect(() => totalWorstCaseUSDC(bad.items)).toThrow(/finite, non-negative/);
    expect(() => teamExposureUSDC(bad.items, 'AWAY')).toThrow(/finite, non-negative/);
    expect(() => headroomForSide(bad, market({ contestId: 'C1' }), 'away', caps())).toThrow(/finite, non-negative/);
    expect(() => verdictForMarket(bad, market({ contestId: 'C1' }), caps())).toThrow(/finite, non-negative/);
    const neg = inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: -5 })]);
    expect(() => verdictForMarket(neg, market({ contestId: 'C1' }), caps())).toThrow(/finite, non-negative/);
    const inf = inventory([item({ contestId: 'C1', makerSide: 'away', riskAmountUSDC: Number.POSITIVE_INFINITY })]);
    expect(() => verdictForMarket(inf, market({ contestId: 'C1' }), caps())).toThrow(/finite, non-negative/);
  });

  it('rejects an invalid open-commitment count', () => {
    expect(() => verdictForMarket(inventory([], Number.NaN), market(), caps())).toThrow(/openCommitmentCount.*non-negative integer/);
    expect(() => verdictForMarket(inventory([], 1.5), market(), caps())).toThrow(/openCommitmentCount.*non-negative integer/);
    expect(() => verdictForMarket(inventory([], -1), market(), caps())).toThrow(/openCommitmentCount.*non-negative integer/);
  });

  it('rejects invalid caps', () => {
    expect(() => requiredPositionModuleAllowanceUSDC(caps({ bankrollUSDC: Number.NaN }))).toThrow(/bankrollUSDC.*finite, non-negative/);
    expect(() => requiredPositionModuleAllowanceUSDC(caps({ maxBankrollUtilizationPct: 1.5 }))).toThrow(/maxBankrollUtilizationPct must be in/);
    expect(() => requiredPositionModuleAllowanceUSDC(caps({ maxBankrollUtilizationPct: 0 }))).toThrow(/maxBankrollUtilizationPct must be in/);
    expect(() => requiredPositionModuleAllowanceUSDC(caps({ maxOpenCommitments: 10.5 }))).toThrow(/maxOpenCommitments.*non-negative integer/);
    expect(() => headroomForSide(inventory([]), market(), 'away', caps({ maxRiskPerContestUSDC: Number.NaN }))).toThrow(/maxRiskPerContestUSDC.*finite, non-negative/);
  });

  it('rejects an invalid makerSide (defends against JS consumers)', () => {
    expect(() => headroomForSide(inventory([]), market(), 'sideways' as unknown as 'away', caps())).toThrow(/makerSide must be/);
  });
});

describe('canSpendGas (Phase 3 d-ii)', () => {
  const POL = 10n ** 18n; // 1 POL in wei18

  it('allows when nothing spent today and the budget exceeds the reserve', () => {
    const v = canSpendGas({ todayGasSpentPolWei: 0n, maxDailyGasPolWei: 1n * POL, emergencyReservePolWei: POL / 5n /* 0.2 POL */ });
    expect(v).toEqual({ allowed: true });
  });

  it('allows when some spend has occurred but still leaves room above the reserve floor', () => {
    // spent 0.5 POL of a 1 POL budget with 0.2 POL reserve → 0.5 + 0.2 = 0.7 < 1.0 → allowed
    const v = canSpendGas({ todayGasSpentPolWei: POL / 2n, maxDailyGasPolWei: 1n * POL, emergencyReservePolWei: POL / 5n });
    expect(v).toEqual({ allowed: true });
  });

  it('denies when today\'s spend plus the reserve has reached the daily cap', () => {
    // spent 0.8 POL of a 1 POL budget with 0.2 POL reserve → 0.8 + 0.2 = 1.0 (= cap) → DENIED
    const v = canSpendGas({ todayGasSpentPolWei: (POL * 8n) / 10n, maxDailyGasPolWei: 1n * POL, emergencyReservePolWei: POL / 5n });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/reached the daily cap/);
  });

  it('denies when today\'s spend exceeds the spendable headroom by overshooting', () => {
    // spent 0.9 POL — past the 0.8 spendable headroom
    const v = canSpendGas({ todayGasSpentPolWei: (POL * 9n) / 10n, maxDailyGasPolWei: 1n * POL, emergencyReservePolWei: POL / 5n });
    expect(v.allowed).toBe(false);
  });

  it('denies on a zero or negative daily budget (no spend allowed at all)', () => {
    const v0 = canSpendGas({ todayGasSpentPolWei: 0n, maxDailyGasPolWei: 0n, emergencyReservePolWei: 0n });
    expect(v0.allowed).toBe(false);
    if (!v0.allowed) expect(v0.reason).toMatch(/maxDailyGasPOL/);
    const vNeg = canSpendGas({ todayGasSpentPolWei: 0n, maxDailyGasPolWei: -1n, emergencyReservePolWei: 0n });
    expect(vNeg.allowed).toBe(false);
  });

  it('denies on an operator misconfig where the reserve equals or exceeds the daily cap (no spendable headroom)', () => {
    const v = canSpendGas({ todayGasSpentPolWei: 0n, maxDailyGasPolWei: POL, emergencyReservePolWei: POL });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/no spendable headroom/);
  });

  it('denies on a negative reserve (operator misconfig)', () => {
    const v = canSpendGas({ todayGasSpentPolWei: 0n, maxDailyGasPolWei: POL, emergencyReservePolWei: -1n });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/emergencyReservePOL/);
  });

  it('defense-in-depth: denies on a negative todayGasSpentPolWei (state corruption / caller bug) — the state validator already rejects negative decimal strings on load, but the verdict is the money/gas safety boundary (Hermes review-PR26)', () => {
    const v = canSpendGas({ todayGasSpentPolWei: -1n, maxDailyGasPolWei: POL, emergencyReservePolWei: POL / 5n });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/todayGasSpentPolWei.*>= 0/);
  });
});
