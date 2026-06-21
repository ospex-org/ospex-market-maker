import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../config/index.js';
import { decimalToAmerican, decimalToImpliedProb, tickToDecimal, toProtocolQuote, type QuoteSide } from '../pricing/index.js';
import { contestWorstCaseUSDC, type ExposureItem, type Inventory, type Market } from '../risk/index.js';
import { emptyMakerState, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';
import { breakdownReferenceOdds, buildDesiredQuote, inventoryFromState, isExpiredForRelease, matchableCommitmentRiskWei6, reconcileBook, toRiskCaps, type BookReconciliation, type DesiredQuote, type ReferenceOdds } from './index.js';

const cfg = (overrides: Record<string, unknown> = {}): Config => parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });

const MARKET: Market = { contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-C1', marketType: 'moneyline' };
const EMPTY: Inventory = { items: [], openCommitmentCount: 0 };
/** A moneyline `ReferenceOdds` from a per-side American pair (the buildDesiredQuote default-market input). */
const ml = (away: number, home: number): ReferenceOdds => ({ market: 'moneyline', awayOddsAmerican: away, homeOddsAmerican: home });
function inventoryWith(items: ExposureItem[]): Inventory {
  return { items, openCommitmentCount: items.length };
}

// ── fixtures for inventoryFromState / reconcileBook ──────────────────────────

const NOW = 1_900_000_000; // a fixed unix-second clock for the state/reconcile tests

function commitmentRecord(overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  return {
    hash: '0xabc',
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    marketType: 'moneyline',
    lineTicks: 0,
    makerSide: 'away',
    oddsTick: 250,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    lifecycle: 'visibleOpen',
    expiryUnixSec: NOW + 100,
    postedAtUnixSec: NOW - 10,
    updatedAtUnixSec: NOW - 10,
    // M6/A — fixtures for inventory / reconcile tests don't exercise the
    // signed-payload cancel path; 'missing-legacy' is the safe default.
    signedPayloadStatus: 'missing-legacy',
    // Phase 2 PR1 — fills[] defaults empty.
    fills: [],
    ...overrides,
  };
}

function positionRecord(overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    marketType: 'moneyline',
    lineTicks: 0,
    side: 'away',
    riskAmountWei6: '250000',
    counterpartyRiskWei6: '150000',
    status: 'active',
    updatedAtUnixSec: NOW - 50,
    ...overrides,
  };
}

function stateWith(partial: Partial<MakerState> = {}): MakerState {
  return { ...emptyMakerState(), ...partial };
}

/** A taker-offer `QuoteSide` for `takerSide` at taker tick `quoteTick`. */
function quoteSide(takerSide: 'away' | 'home', quoteTick: number, sizeWei6 = 250_000): QuoteSide {
  const quoteDecimal = tickToDecimal(quoteTick);
  return {
    takerSide,
    quoteProb: decimalToImpliedProb(quoteDecimal),
    quoteDecimal,
    quoteAmerican: decimalToAmerican(quoteDecimal),
    quoteTick,
    sizeUSDC: sizeWei6 / 1_000_000,
    sizeWei6,
  };
}

/** A `visibleOpen` commitment record that *correctly* serves `offer` — `makerSide` / `oddsTick` are `toProtocolQuote` of the offer (the maker takes the opposite side, at the inverse tick), so it's the on-tick incumbent for that taker offer. */
function incumbentFor(offer: QuoteSide, overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  const proto = toProtocolQuote({ side: offer.takerSide, oddsTick: offer.quoteTick });
  return commitmentRecord({ makerSide: proto.makerSide, oddsTick: proto.makerOddsTick, lifecycle: 'visibleOpen', ...overrides });
}

/** A minimal `DesiredQuote` for `reconcileBook` — which only reads `result.away` / `result.home`. */
function desiredWith(away: QuoteSide | null, home: QuoteSide | null): DesiredQuote {
  return {
    referenceOdds: null,
    headroomUSDC: { away: 0, home: 0 },
    result: {
      canQuote: away !== null || home !== null,
      away,
      home,
      fair: null,
      spread: null,
      targetMonthlyReturnUSDC: null,
      expectedMonthlyFilledVolumeUSDC: null,
      notes: [],
    },
  };
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
    const d = buildDesiredQuote(cfg(), MARKET, ml(150, -180), EMPTY);
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

  it('reduces headroom on the offer whose protocol side already carries exposure on that contest', () => {
    // A maker-on-*home* item of 0.9 USDC on C1 → loses if away wins; it also counts toward LAD's team
    // exposure. The *away offer* becomes a maker-on-home commitment, so it draws on exactly that bucket
    // (`headroomForSide(..., 'home', ...)`): away-offer headroom = min(perCommitment 0.25, perContest
    // 1 - 0.9 ≈ 0.1, perTeam(LAD) 2 - 0.9, perSport 5 - 0.9, bankroll 25 - 0.9) ≈ 0.1. The home offer
    // (a maker-on-away commitment) is untouched: home-offer headroom = min(0.25, 1 - 0, 2 - 0, ...) = 0.25.
    const inv = inventoryWith([{ contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-C1', marketType: 'moneyline', makerSide: 'home', riskAmountUSDC: 0.9 }]);
    const d = buildDesiredQuote(cfg(), MARKET, ml(150, -180), inv);
    expect(d.headroomUSDC.away).toBeCloseTo(0.1, 6);
    expect(d.headroomUSDC.home).toBeCloseTo(0.25, 9);
    // Both offers still quoted, but the away offer is the smaller one (its headroom ≈ 0.1 binds, vs the home offer's 0.25).
    expect(d.result.away).not.toBeNull();
    expect(d.result.home).not.toBeNull();
    expect(d.result.away?.sizeWei6 ?? 0).toBeLessThan(d.result.home?.sizeWei6 ?? 0);
    expect(d.result.away?.sizeUSDC ?? 0).toBeLessThan(0.25);
  });

  it('pulls an offer whose headroom has been exhausted (clamps to 0)', () => {
    // 1.5 USDC of maker-on-home exposure on C1 → over the per-contest cap of 1 in the "away wins" bucket
    // → the away offer (a maker-on-home commitment) has 0 headroom and is pulled. The home offer is fine.
    const inv = inventoryWith([{ contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-C1', marketType: 'moneyline', makerSide: 'home', riskAmountUSDC: 1.5 }]);
    const d = buildDesiredQuote(cfg(), MARKET, ml(150, -180), inv);
    expect(d.headroomUSDC.away).toBe(0);
    expect(d.result.away).toBeNull();
    // home offer still has headroom
    expect(d.result.home).not.toBeNull();
  });

  it('reports canQuote: false when the math refuses (direct spread far exceeds the consensus overround)', () => {
    const d = buildDesiredQuote(cfg({ pricing: { mode: 'direct', direct: { spreadBps: 9000 } } }), MARKET, ml(150, -180), EMPTY);
    expect(d.result.canQuote).toBe(false);
    expect(d.result.notes.some((n) => n.startsWith('REFUSE:'))).toBe(true);
  });

  it('refuses (both sides null) when the open-commitment count cap is hit — even with positive exposure headroom', () => {
    // openCommitmentCount 1 / maxOpenCommitments 1 → verdictForMarket refuses, but headroomForSide over an empty `items` array is still the full per-commitment cap.
    const d = buildDesiredQuote(cfg({ risk: { maxOpenCommitments: 1 } }), MARKET, ml(150, -180), { items: [], openCommitmentCount: 1 });
    expect(d.result.canQuote).toBe(false);
    expect(d.result.away).toBeNull();
    expect(d.result.home).toBeNull();
    expect(d.result.notes.some((n) => /open-commitment count/.test(n))).toBe(true);
    // headroom + the reference breakdown are still populated (the refusal is the count cap, not the odds or the exposure size).
    expect(d.headroomUSDC.away).toBeGreaterThan(0);
    expect(d.referenceOdds).not.toBeNull();
  });

  it('refuses (referenceOdds: null) when the upstream reference odds are out of range — does not throw', () => {
    for (const bad of [ml(0, -180), ml(Number.NaN, -180), ml(Number.POSITIVE_INFINITY, -180)]) {
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
    expect(buildDesiredQuote(cfg(), MARKET, ml(150, -180), EMPTY).result.targetMonthlyReturnUSDC).not.toBeNull(); // economics mode populates these
    const direct = buildDesiredQuote(cfg({ pricing: { mode: 'direct', direct: { spreadBps: 200 } } }), MARKET, ml(150, -180), EMPTY);
    expect(direct.result.targetMonthlyReturnUSDC).toBeNull(); // direct mode has no economics diagnostics
  });

  it('dispatches a spread ReferenceOdds to the spread adapter — a two-sided cover quote', () => {
    const d = buildDesiredQuote(cfg(), MARKET, { market: 'spread', awayLine: 1.5, homeLine: -1.5, awayOddsAmerican: 152, homeOddsAmerican: -176 }, EMPTY);
    expect(d.result.canQuote).toBe(true);
    expect(d.result.away).not.toBeNull();
    expect(d.result.home).not.toBeNull();
  });

  it('dispatches a total ReferenceOdds to the total adapter, relabelling over→away / under→home (protocol-correct)', () => {
    const d = buildDesiredQuote(cfg(), MARKET, { market: 'total', line: 7.5, overOddsAmerican: 104, underOddsAmerican: -123 }, EMPTY);
    expect(d.result.canQuote).toBe(true);
    // result.away is the OVER side; via toProtocolQuote the maker of an over offer is on under (home/Lower/1).
    expect(toProtocolQuote({ side: d.result.away!.takerSide, oddsTick: d.result.away!.quoteTick })).toMatchObject({ makerSide: 'home', positionType: 1 });
    expect(toProtocolQuote({ side: d.result.home!.takerSide, oddsTick: d.result.home!.quoteTick })).toMatchObject({ makerSide: 'away', positionType: 0 });
  });
});

// ── matchableCommitmentRiskWei6 (funding guard `required`) ───────────────────

describe('matchableCommitmentRiskWei6', () => {
  it('is 0n on empty state', () => {
    expect(matchableCommitmentRiskWei6(emptyMakerState(), NOW, 0)).toBe(0n);
  });

  it('sums GROSS remaining maker risk over visibleOpen + softCancelled + partiallyFilled', () => {
    const commitments = {
      open: commitmentRecord({ hash: 'open', lifecycle: 'visibleOpen', riskAmountWei6: '250000', filledRiskWei6: '0' }),
      sc: commitmentRecord({ hash: 'sc', lifecycle: 'softCancelled', riskAmountWei6: '250000', filledRiskWei6: '0' }),
      partial: commitmentRecord({ hash: 'partial', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000' }),
    };
    // 250000 + 250000 + (500000 - 200000) = 800000
    expect(matchableCommitmentRiskWei6(stateWith({ commitments }), NOW, 0)).toBe(800_000n);
  });

  it('drops released lifecycles (filled / expired / authoritativelyInvalidated)', () => {
    const commitments = {
      keep: commitmentRecord({ hash: 'keep', lifecycle: 'visibleOpen', riskAmountWei6: '250000' }),
      filled: commitmentRecord({ hash: 'filled', lifecycle: 'filled', riskAmountWei6: '999000' }),
      expired: commitmentRecord({ hash: 'expired', lifecycle: 'expired', riskAmountWei6: '999000' }),
      invalidated: commitmentRecord({ hash: 'invalidated', lifecycle: 'authoritativelyInvalidated', riskAmountWei6: '999000' }),
    };
    expect(matchableCommitmentRiskWei6(stateWith({ commitments }), NOW, 0)).toBe(250_000n);
  });

  it('drops commitments past expiry + grace, keeps those still within the grace window', () => {
    const commitments = {
      live: commitmentRecord({ hash: 'live', expiryUnixSec: NOW + 50, riskAmountWei6: '250000' }),
      withinGrace: commitmentRecord({ hash: 'grace', expiryUnixSec: NOW - 10, riskAmountWei6: '250000' }),
      pastGrace: commitmentRecord({ hash: 'dead', expiryUnixSec: NOW - 100, riskAmountWei6: '250000' }),
    };
    // grace=60: live + within-grace (NOW-10) kept; pastGrace (NOW-100) dropped → 500000
    expect(matchableCommitmentRiskWei6(stateWith({ commitments }), NOW, 60)).toBe(500_000n);
  });

  it('EXCLUDES filled positions — their USDC was already pulled on chain, not a future wallet obligation', () => {
    const commitments = { open: commitmentRecord({ hash: 'open', riskAmountWei6: '250000' }) };
    const positions = { 'spec-1:away': positionRecord({ riskAmountWei6: '999000', status: 'active' }) };
    expect(matchableCommitmentRiskWei6(stateWith({ commitments, positions }), NOW, 0)).toBe(250_000n);
  });

  it('is GROSS, not outcome-netted — opposing-side commitments each count fully', () => {
    const commitments = {
      away: commitmentRecord({ hash: 'away', makerSide: 'away', riskAmountWei6: '250000' }),
      home: commitmentRecord({ hash: 'home', makerSide: 'home', riskAmountWei6: '250000' }),
    };
    // each pulls its own makerRisk at fill, independently → 500000 (NOT netted to a smaller worst-case)
    expect(matchableCommitmentRiskWei6(stateWith({ commitments }), NOW, 0)).toBe(500_000n);
  });
});

// ── inventoryFromState ───────────────────────────────────────────────────────

describe('inventoryFromState', () => {
  it('an empty state yields an empty inventory', () => {
    expect(inventoryFromState(emptyMakerState(), NOW, 0)).toEqual({ items: [], openCommitmentCount: 0 });
  });

  it('maps a visibleOpen commitment + an active position into items (contest metadata + USDC amounts), counting only the commitment', () => {
    const c = commitmentRecord({ hash: '0x1', makerSide: 'away', riskAmountWei6: '250000' });
    const p = positionRecord({ side: 'home', riskAmountWei6: '100000' });
    const inv = inventoryFromState(stateWith({ commitments: { '0x1': c }, positions: { 'spec-1:home': p } }), NOW, 0);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([
      { contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-1', marketType: 'moneyline', makerSide: 'away', riskAmountUSDC: 0.25 },
      { contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-1', marketType: 'moneyline', makerSide: 'home', riskAmountUSDC: 0.1 },
    ]);
  });

  it('drops filled / expired / authoritativelyInvalidated commitments; keeps visibleOpen + softCancelled-not-yet-expired', () => {
    const commitments: Record<string, MakerCommitmentRecord> = {
      keep: commitmentRecord({ hash: 'keep', lifecycle: 'visibleOpen', makerSide: 'away' }),
      sc: commitmentRecord({ hash: 'sc', lifecycle: 'softCancelled', makerSide: 'home' }),
      filled: commitmentRecord({ hash: 'filled', lifecycle: 'filled' }),
      expired: commitmentRecord({ hash: 'expired', lifecycle: 'expired' }),
      invalidated: commitmentRecord({ hash: 'invalidated', lifecycle: 'authoritativelyInvalidated' }),
    };
    const inv = inventoryFromState(stateWith({ commitments }), NOW, 0);
    expect(inv.openCommitmentCount).toBe(2); // visibleOpen + softCancelled (both still in the future)
    expect(inv.items.map((it) => it.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('drops commitments past their expiry — even visibleOpen / softCancelled / partiallyFilled — as dead on chain', () => {
    const commitments: Record<string, MakerCommitmentRecord> = {
      liveOpen: commitmentRecord({ hash: 'liveOpen', lifecycle: 'visibleOpen', expiryUnixSec: NOW + 50 }),
      expiredOpen: commitmentRecord({ hash: 'expiredOpen', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 1 }),
      expiredSoftCancel: commitmentRecord({ hash: 'expiredSoftCancel', lifecycle: 'softCancelled', expiryUnixSec: NOW - 1 }),
      expiredPartial: commitmentRecord({ hash: 'expiredPartial', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '100000', expiryUnixSec: NOW - 1 }),
    };
    const inv = inventoryFromState(stateWith({ commitments }), NOW, 0);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([{ contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-1', marketType: 'moneyline', makerSide: 'away', riskAmountUSDC: 0.25 }]);
  });

  it('counts a partiallyFilled commitment at its remaining (unfilled) risk', () => {
    const partial = commitmentRecord({ hash: 'p', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000' });
    const inv = inventoryFromState(stateWith({ commitments: { p: partial } }), NOW, 0);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([{ contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', speculationId: 'spec-1', marketType: 'moneyline', makerSide: 'away', riskAmountUSDC: 0.3 }]);
  });

  it('inventoryFromState → contestWorstCaseUSDC: two same-contest positions on distinct speculations SUM (the snapshot-rehydration path)', () => {
    // A cold-restart own-state snapshot maps positions with lineTicks 0 (the body omits the line)
    // but their real, DISTINCT speculationIds. Two spread covers on the same contest at different
    // lines therefore land in distinct exposure groups and must SUM, not net — the regression the
    // speculationId key prevents (under the old line-based key both would key to lineTicks 0 and net).
    const posA = positionRecord({ speculationId: 'spec-A', marketType: 'spread', lineTicks: 0, side: 'away', riskAmountWei6: '250000' }); // 0.25 USDC
    const posB = positionRecord({ speculationId: 'spec-B', marketType: 'spread', lineTicks: 0, side: 'home', riskAmountWei6: '100000' }); // 0.10 USDC
    const inv = inventoryFromState(stateWith({ positions: { 'spec-A:away': posA, 'spec-B:home': posB } }), NOW, 0);
    // both on contest-1 (factory default) → 0.25 + 0.10, NOT max = 0.25
    expect(contestWorstCaseUSDC(inv.items, 'contest-1')).toBeCloseTo(0.35, 9);
  });

  it('drops a fully-filled commitment (filled === risk — its filled portion is a position; no latent risk left here)', () => {
    const fullyFilled = commitmentRecord({ hash: 'f', lifecycle: 'partiallyFilled', riskAmountWei6: '300000', filledRiskWei6: '300000' });
    expect(inventoryFromState(stateWith({ commitments: { f: fullyFilled } }), NOW, 0)).toEqual({ items: [], openCommitmentCount: 0 });
  });

  it('throws on a corrupt commitment with filledRiskWei6 > riskAmountWei6 (fail closed — never silently drop latent exposure)', () => {
    const overFilled = commitmentRecord({ hash: 'o', lifecycle: 'softCancelled', riskAmountWei6: '300000', filledRiskWei6: '400000' });
    expect(() => inventoryFromState(stateWith({ commitments: { o: overFilled } }), NOW, 0)).toThrow(/corrupt inventory/);
  });

  it('keeps active / pendingSettle / claimable positions; drops ALL terminal statuses claimed / settledLost / void (positions never add to the commitment count)', () => {
    const positions: Record<string, MakerPositionRecord> = {
      'spec-1:away': positionRecord({ status: 'active', side: 'away', riskAmountWei6: '250000' }),
      'spec-2:home': positionRecord({ speculationId: 'spec-2', contestId: 'contest-2', status: 'pendingSettle', side: 'home', riskAmountWei6: '100000' }),
      'spec-3:away': positionRecord({ speculationId: 'spec-3', contestId: 'contest-3', status: 'claimable', side: 'away', riskAmountWei6: '50000' }),
      'spec-4:home': positionRecord({ speculationId: 'spec-4', contestId: 'contest-4', status: 'claimed', side: 'home', riskAmountWei6: '999999' }),
      // the two NEW terminals carry no live exposure either — they must NOT be counted
      'spec-5:away': positionRecord({ speculationId: 'spec-5', contestId: 'contest-5', status: 'settledLost', side: 'away', riskAmountWei6: '888888' }),
      'spec-6:home': positionRecord({ speculationId: 'spec-6', contestId: 'contest-6', status: 'void', side: 'home', riskAmountWei6: '777777' }),
    };
    const inv = inventoryFromState(stateWith({ positions }), NOW, 0);
    expect(inv.openCommitmentCount).toBe(0);
    expect(inv.items).toHaveLength(3);
    expect(Object.fromEntries(inv.items.map((it) => [it.contestId, it.riskAmountUSDC]))).toEqual({ 'contest-1': 0.25, 'contest-2': 0.1, 'contest-3': 0.05 });
  });

  it('with a grace margin, keeps a commitment past its expiry but inside the grace window (still counted, not released)', () => {
    const within = commitmentRecord({ hash: 'g', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 30 }); // 30s past expiry
    const inv = inventoryFromState(stateWith({ commitments: { g: within } }), NOW, 60); // grace 60 ⇒ not yet releasable
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toHaveLength(1);
  });

  it('with a grace margin, releases a commitment only once it is past expiry + grace', () => {
    const pastGrace = commitmentRecord({ hash: 'g', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 61 }); // past expiry + grace(60)
    expect(inventoryFromState(stateWith({ commitments: { g: pastGrace } }), NOW, 60)).toEqual({ items: [], openCommitmentCount: 0 });
  });
});

describe('isExpiredForRelease', () => {
  it('is true only once now >= expiry + grace', () => {
    expect(isExpiredForRelease(1000, 1059, 60)).toBe(false); // 59s past expiry, grace 60
    expect(isExpiredForRelease(1000, 1060, 60)).toBe(true); //  exactly expiry + grace
    expect(isExpiredForRelease(1000, 1061, 60)).toBe(true);
    expect(isExpiredForRelease(1000, 1000, 0)).toBe(true); //   grace 0 ⇒ release exactly at expiry
    expect(isExpiredForRelease(1000, 999, 0)).toBe(false);
  });
});

describe('expiry-release grace — interleaving G (sizing safety)', () => {
  it('a within-grace commitment still constrains a same-side repost: old_remaining + new headroom <= the per-contest cap', () => {
    // A maker-on-home commitment of 0.9 USDC on C1, 30s past expiry but inside the 60s grace window.
    const within = commitmentRecord({ hash: 'g', contestId: 'C1', makerSide: 'home', riskAmountWei6: '900000', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 30 });
    const graced = inventoryFromState(stateWith({ commitments: { g: within } }), NOW, 60);
    expect(graced.openCommitmentCount).toBe(1); // still counted through the grace window

    // The away offer is served by a maker-on-home commitment, so it draws on the same outcome bucket as
    // the within-grace one. Per-contest cap 1.0; the within-grace 0.9 leaves only 0.1 of headroom.
    const d = buildDesiredQuote(cfg(), MARKET, ml(150, -180), graced);
    expect(d.headroomUSDC.away).toBeCloseTo(0.1, 6); // 0.9 (old remaining) + 0.1 (max repost) = the 1.0 per-contest cap

    // Contrast: at grace 0 the commitment is released from the inventory and the headroom jumps back to
    // the per-commitment cap (0.25) — so 0.9 (still matchable on chain) + 0.25 would breach the 1.0 cap.
    const released = inventoryFromState(stateWith({ commitments: { g: within } }), NOW, 0);
    expect(released.openCommitmentCount).toBe(0);
    const dReleased = buildDesiredQuote(cfg(), MARKET, ml(150, -180), released);
    expect(dReleased.headroomUSDC.away).toBeCloseTo(0.25, 6);
    expect(0.9 + dReleased.headroomUSDC.away).toBeGreaterThan(1.0); // the breach the grace prevents
  });
});

// ── reconcileBook ────────────────────────────────────────────────────────────

describe('reconcileBook', () => {
  const OPEN_COUNT_OK = 0; // plenty of count headroom (risk.maxOpenCommitments defaults to 10)
  const NOTHING: BookReconciliation = { toSubmit: [], toReplace: [], toSoftCancel: [], retainedPartials: [], deferredSides: [] };

  // Reminder of the side mapping: a desired offer with `takerSide: 'away'` is served on chain by a
  // maker-on-*home* commitment (so `makerSide: 'home'`, `oddsTick: inverseOddsTick(quoteTick)` — that's
  // exactly what `incumbentFor` builds), and vice versa. `commitmentRecord({ makerSide: 'away' })` is
  // therefore a quote on the *home* offer.

  it('submits a fresh quote on every wanted side when the maker holds nothing on the speculation', () => {
    const r = reconcileBook([], desiredWith(quoteSide('away', 200), quoteSide('home', 200)), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide).sort()).toEqual(['away', 'home']);
    expect(r.toReplace).toEqual([]);
    expect(r.toSoftCancel).toEqual([]);
    expect(r.deferredSides).toEqual([]);
  });

  it('soft-cancels a visibleOpen on a no-longer-wanted offer side, and submits the wanted side', () => {
    const homeOfferRec = commitmentRecord({ hash: '0xh', makerSide: 'away', lifecycle: 'visibleOpen' }); // a quote on the (now-unwanted) home offer
    const r = reconcileBook([homeOfferRec], desiredWith(quoteSide('away', 200), null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide)).toEqual(['away']);
    expect(r.toSoftCancel).toEqual([{ record: homeOfferRec, reason: 'side-not-quoted' }]);
    expect(r.toReplace).toEqual([]);
  });

  it('on a no-longer-quoted offer side: soft-cancels the visibleOpen but RETAINS the partiallyFilled remainder (off-chain cancel is rejected once matched)', () => {
    const partialHomeOffer = commitmentRecord({ hash: '0xph', makerSide: 'away', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000' });
    const visibleHomeOffer = commitmentRecord({ hash: '0xvh', makerSide: 'away', lifecycle: 'visibleOpen' });
    const r = reconcileBook([partialHomeOffer, visibleHomeOffer], desiredWith(quoteSide('away', 200), null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide)).toEqual(['away']);
    expect(r.toSoftCancel).toEqual([{ record: visibleHomeOffer, reason: 'side-not-quoted' }]); // only the visibleOpen is pulled
    expect(r.retainedPartials).toEqual([{ record: partialHomeOffer, reason: 'side-not-quoted' }]); // the partial rides to expiry — never off-chain-cancelled
    expect(r.toReplace).toEqual([]);
  });

  it('leaves a fresh, correctly-priced visibleOpen alone (no submit / replace / cancel)', () => {
    const incumbent = incumbentFor(quoteSide('away', 200), { hash: '0xi', postedAtUnixSec: NOW - 30 });
    expect(reconcileBook([incumbent], desiredWith(quoteSide('away', 200), null), cfg(), NOW, OPEN_COUNT_OK)).toEqual(NOTHING);
  });

  it('replaces a stale visibleOpen (reason "stale") on a wanted side', () => {
    const stale = incumbentFor(quoteSide('away', 200), { hash: '0xa', postedAtUnixSec: NOW - 200 }); // > staleAfterSeconds (90)
    const replacement = quoteSide('away', 200);
    const r = reconcileBook([stale], desiredWith(replacement, null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toReplace).toEqual([{ stale, reason: 'stale', replacement }]);
    expect(r.toSubmit).toEqual([]);
    expect(r.toSoftCancel).toEqual([]);
    expect(r.deferredSides).toEqual([]);
  });

  it('replaces a mispriced visibleOpen (reason "mispriced"), but leaves one whose price moved within the threshold', () => {
    const conf = cfg(); // orders.replaceOnOddsMoveBps defaults to 50

    // incumbent priced for the taker-200 offer (maker tick 200, implied 0.50); the new desired is the
    // taker-150 offer → maker tick inverseOddsTick(150) = 300 (implied 0.333) → ~1667 bps move → mispriced.
    const recA = incumbentFor(quoteSide('away', 200), { hash: '0xa', postedAtUnixSec: NOW - 5 });
    const repl = quoteSide('away', 150);
    let r = reconcileBook([recA], desiredWith(repl, null), conf, NOW, OPEN_COUNT_OK);
    expect(r.toReplace).toEqual([{ stale: recA, reason: 'mispriced', replacement: repl }]);
    expect(r.toSubmit).toEqual([]);

    // incumbent maker tick 200; the new desired (taker-199) → maker tick inverseOddsTick(199) = 201 → ~25 bps < 50 → not mispriced.
    const recB = incumbentFor(quoteSide('away', 200), { hash: '0xb', postedAtUnixSec: NOW - 5 });
    r = reconcileBook([recB], desiredWith(quoteSide('away', 199), null), conf, NOW, OPEN_COUNT_OK);
    expect(r).toEqual(NOTHING);
  });

  it('keeps the newest visibleOpen on a side and soft-cancels older ones as "duplicate" (book hygiene)', () => {
    const newer = incumbentFor(quoteSide('away', 200), { hash: '0xnew', postedAtUnixSec: NOW - 10 });
    const older = incumbentFor(quoteSide('away', 200), { hash: '0xold', postedAtUnixSec: NOW - 60 });
    // passed in reverse posting order — reconcileBook sorts newest-first internally.
    let r = reconcileBook([older, newer], desiredWith(quoteSide('away', 200), null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSoftCancel).toEqual([{ record: older, reason: 'duplicate' }]);
    expect(r.toReplace).toEqual([]); // the kept (newer) one is fresh + on-tick
    expect(r.toSubmit).toEqual([]);

    // if the kept one is also stale: it gets replaced, the older is still a duplicate.
    const newerStale = incumbentFor(quoteSide('away', 200), { hash: '0xns', postedAtUnixSec: NOW - 100 });
    const olderStale = incumbentFor(quoteSide('away', 200), { hash: '0xos', postedAtUnixSec: NOW - 200 });
    const repl = quoteSide('away', 200);
    r = reconcileBook([olderStale, newerStale], desiredWith(repl, null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toReplace).toEqual([{ stale: newerStale, reason: 'stale', replacement: repl }]);
    expect(r.toSoftCancel).toEqual([{ record: olderStale, reason: 'duplicate' }]);
    expect(r.toSubmit).toEqual([]);
  });

  it('soft-cancels every visibleOpen when the quote was refused (canQuote === false ⇒ both sides null)', () => {
    const awayOfferRec = commitmentRecord({ hash: '0xao', makerSide: 'home', lifecycle: 'visibleOpen' }); // a quote on the away offer
    const homeOfferRec = commitmentRecord({ hash: '0xho', makerSide: 'away', lifecycle: 'visibleOpen' }); // a quote on the home offer
    const r = reconcileBook([awayOfferRec, homeOfferRec], desiredWith(null, null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSoftCancel).toEqual([
      { record: awayOfferRec, reason: 'side-not-quoted' }, // the away offer is processed first
      { record: homeOfferRec, reason: 'side-not-quoted' },
    ]);
    expect(r.toSubmit).toEqual([]);
    expect(r.toReplace).toEqual([]);
    expect(r.deferredSides).toEqual([]);
  });

  it('ignores softCancelled / filled records and expired visibleOpen ones — they are not the visible book', () => {
    const softCancelled = commitmentRecord({ hash: '0xsc', makerSide: 'home', lifecycle: 'softCancelled', postedAtUnixSec: NOW - 200 });
    const filled = commitmentRecord({ hash: '0xf', makerSide: 'home', lifecycle: 'filled' });
    const expiredVisible = commitmentRecord({ hash: '0xev', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 1, postedAtUnixSec: NOW - 200 });
    const r = reconcileBook([softCancelled, filled, expiredVisible], desiredWith(quoteSide('away', 200), quoteSide('home', 200)), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide).sort()).toEqual(['away', 'home']); // both fresh-submitted; none of those records occupied an offer side
    expect(r.toSoftCancel).toEqual([]); // an expired visibleOpen is dead on chain — not soft-cancelled
    expect(r.toReplace).toEqual([]);
  });

  it('does not double-post over a fresh, correctly-priced partiallyFilled remainder on a wanted side (an expired one does not suppress)', () => {
    // a maker-on-home partial occupies the *away* offer; on-tick for the taker-200 offer (maker tick 200).
    const partial = commitmentRecord({ hash: '0xpf', makerSide: 'home', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', postedAtUnixSec: NOW - 10 });
    const d = desiredWith(quoteSide('away', 200), quoteSide('home', 200));
    let r = reconcileBook([partial], d, cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide)).toEqual(['home']); // the away offer is occupied by the (fresh, on-tick) partial
    expect(r.toReplace).toEqual([]);
    expect(r.toSoftCancel).toEqual([]);
    expect(r.retainedPartials).toEqual([]); // a fresh, on-tick, lone occupant is normal steady-state — not surfaced (would emit every tick)

    const expiredPartial = commitmentRecord({ hash: '0xep', makerSide: 'home', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: NOW - 1 });
    r = reconcileBook([expiredPartial], d, cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSubmit.map((q) => q.takerSide).sort()).toEqual(['away', 'home']); // the expired partial doesn't occupy the offer
  });

  it('RETAINS a stale partiallyFilled remainder and does NOT repost over it (no off-chain cancel, no same-side submit)', () => {
    const stalePartial = commitmentRecord({ hash: '0xsp', makerSide: 'home', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', postedAtUnixSec: NOW - 200 }); // > staleAfterSeconds
    const fresh = quoteSide('away', 200);
    const r = reconcileBook([stalePartial], desiredWith(fresh, null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSoftCancel).toEqual([]); // never off-chain-cancelled — the API rejects a DELETE once matched
    expect(r.toSubmit).toEqual([]); // never reposted over — that would double the side's matchable exposure
    expect(r.toReplace).toEqual([]);
    expect(r.retainedPartials).toEqual([{ record: stalePartial, reason: 'stale' }]); // surfaced for telemetry; rides to expiry / authoritative cancel
  });

  it('RETAINS a mispriced partiallyFilled remainder (reason "mispriced") and does not repost over it', () => {
    // partial priced for the taker-200 offer (maker tick 200); the desired is the taker-150 offer → ~1667 bps move → mispriced.
    const mispricedPartial = commitmentRecord({ hash: '0xmp', makerSide: 'home', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', postedAtUnixSec: NOW - 5 });
    const r = reconcileBook([mispricedPartial], desiredWith(quoteSide('away', 150), null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSoftCancel).toEqual([]);
    expect(r.toSubmit).toEqual([]);
    expect(r.toReplace).toEqual([]);
    expect(r.retainedPartials).toEqual([{ record: mispricedPartial, reason: 'mispriced' }]);
  });

  it('on a wanted side with a partial occupant AND a redundant visibleOpen: pulls the visibleOpen (duplicate), retains the partial, posts nothing', () => {
    // both maker-on-home → both serve the away offer; the partial occupies the side, the visibleOpen is redundant.
    const partial = commitmentRecord({ hash: '0xpf', makerSide: 'home', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', postedAtUnixSec: NOW - 10 });
    const redundantVisible = commitmentRecord({ hash: '0xrv', makerSide: 'home', lifecycle: 'visibleOpen', oddsTick: 200, postedAtUnixSec: NOW - 5 });
    const r = reconcileBook([partial, redundantVisible], desiredWith(quoteSide('away', 200), null), cfg(), NOW, OPEN_COUNT_OK);
    expect(r.toSoftCancel).toEqual([{ record: redundantVisible, reason: 'duplicate' }]); // the removable one is pulled (gasless)
    expect(r.retainedPartials).toEqual([{ record: partial, reason: 'duplicate' }]); // the partial is kept (can't be off-chain-cancelled)
    expect(r.toSubmit).toEqual([]); // no fresh post over a live partial
    expect(r.toReplace).toEqual([]);
  });

  // ── open-commitment-count budget (DESIGN §6) ───────────────────────────────

  it('defers fresh submits when the count budget is exhausted; one slot ⇒ exactly one side posts', () => {
    // maxOpenCommitments defaults to 10. Current count 10 ⇒ budget 0 ⇒ neither side can be posted.
    let r = reconcileBook([], desiredWith(quoteSide('away', 200), quoteSide('home', 200)), cfg(), NOW, 10);
    expect(r.toSubmit).toEqual([]);
    expect(r.deferredSides).toEqual(['away', 'home']);

    // Current count 9 ⇒ budget 1 ⇒ exactly one side posts (away — deterministic order), the other defers.
    r = reconcileBook([], desiredWith(quoteSide('away', 200), quoteSide('home', 200)), cfg(), NOW, 9);
    expect(r.toSubmit.map((q) => q.takerSide)).toEqual(['away']);
    expect(r.deferredSides).toEqual(['home']);
  });

  it('degrades a stale-quote replacement to a plain soft-cancel when the count budget is exhausted', () => {
    const stale = incumbentFor(quoteSide('away', 200), { hash: '0xa', postedAtUnixSec: NOW - 200 });
    // Current count 10 (includes the stale one) ⇒ budget 0 ⇒ can't afford the +1 replacement post.
    const r = reconcileBook([stale], desiredWith(quoteSide('away', 200), null), cfg(), NOW, 10);
    expect(r.toReplace).toEqual([]);
    expect(r.toSoftCancel).toEqual([{ record: stale, reason: 'stale' }]); // pulled anyway — must not stay visibly stale
    expect(r.deferredSides).toEqual(['away']);
    expect(r.toSubmit).toEqual([]);
  });

  it('prioritizes a replace over a fresh submit when only one slot remains', () => {
    const staleAway = incumbentFor(quoteSide('away', 200), { hash: '0xa', postedAtUnixSec: NOW - 200 });
    const replAway = quoteSide('away', 200);
    // the away offer wants a replace (+1), the home offer wants a fresh submit (+1); budget 1 ⇒ the replace wins, home defers.
    const r = reconcileBook([staleAway], desiredWith(replAway, quoteSide('home', 200)), cfg(), NOW, 9);
    expect(r.toReplace).toEqual([{ stale: staleAway, reason: 'stale', replacement: replAway }]);
    expect(r.toSubmit).toEqual([]);
    expect(r.deferredSides).toEqual(['home']);
  });
});
