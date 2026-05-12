import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../config/index.js';
import { decimalToAmerican, decimalToImpliedProb, tickToDecimal, type QuoteSide } from '../pricing/index.js';
import type { ExposureItem, Inventory, Market } from '../risk/index.js';
import { emptyMakerState, type MakerCommitmentRecord, type MakerPositionRecord, type MakerState } from '../state/index.js';
import { breakdownReferenceOdds, buildDesiredQuote, inventoryFromState, reconcileBook, toRiskCaps, type DesiredQuote } from './index.js';

const cfg = (overrides: Record<string, unknown> = {}): Config => parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });

const MARKET: Market = { contestId: 'C1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD' };
const EMPTY: Inventory = { items: [], openCommitmentCount: 0 };
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
    makerSide: 'away',
    oddsTick: 250,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    lifecycle: 'visibleOpen',
    expiryUnixSec: NOW + 100,
    postedAtUnixSec: NOW - 10,
    updatedAtUnixSec: NOW - 10,
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

function quoteSide(side: 'away' | 'home', quoteTick: number, sizeWei6 = 250_000): QuoteSide {
  const quoteDecimal = tickToDecimal(quoteTick);
  return {
    side,
    quoteProb: decimalToImpliedProb(quoteDecimal),
    quoteDecimal,
    quoteAmerican: decimalToAmerican(quoteDecimal),
    quoteTick,
    sizeUSDC: sizeWei6 / 1_000_000,
    sizeWei6,
  };
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

// ── inventoryFromState ───────────────────────────────────────────────────────

describe('inventoryFromState', () => {
  it('an empty state yields an empty inventory', () => {
    expect(inventoryFromState(emptyMakerState(), NOW)).toEqual({ items: [], openCommitmentCount: 0 });
  });

  it('maps a visibleOpen commitment + an active position into items (contest metadata + USDC amounts), counting only the commitment', () => {
    const c = commitmentRecord({ hash: '0x1', makerSide: 'away', riskAmountWei6: '250000' });
    const p = positionRecord({ side: 'home', riskAmountWei6: '100000' });
    const inv = inventoryFromState(stateWith({ commitments: { '0x1': c }, positions: { 'spec-1:home': p } }), NOW);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([
      { contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', riskAmountUSDC: 0.25 },
      { contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', riskAmountUSDC: 0.1 },
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
    const inv = inventoryFromState(stateWith({ commitments }), NOW);
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
    const inv = inventoryFromState(stateWith({ commitments }), NOW);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([{ contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', riskAmountUSDC: 0.25 }]);
  });

  it('counts a partiallyFilled commitment at its remaining (unfilled) risk', () => {
    const partial = commitmentRecord({ hash: 'p', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000' });
    const inv = inventoryFromState(stateWith({ commitments: { p: partial } }), NOW);
    expect(inv.openCommitmentCount).toBe(1);
    expect(inv.items).toEqual([{ contestId: 'contest-1', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', riskAmountUSDC: 0.3 }]);
  });

  it('drops a commitment whose filled amount meets or exceeds its risk (effectively filled — no latent risk left)', () => {
    const fullyFilled = commitmentRecord({ hash: 'f', lifecycle: 'partiallyFilled', riskAmountWei6: '300000', filledRiskWei6: '300000' });
    const overFilled = commitmentRecord({ hash: 'o', lifecycle: 'partiallyFilled', riskAmountWei6: '300000', filledRiskWei6: '400000' }); // logic-bug-shaped; clamps to 0
    const inv = inventoryFromState(stateWith({ commitments: { f: fullyFilled, o: overFilled } }), NOW);
    expect(inv).toEqual({ items: [], openCommitmentCount: 0 });
  });

  it('keeps active / pendingSettle / claimable positions; drops claimed (positions never add to the commitment count)', () => {
    const positions: Record<string, MakerPositionRecord> = {
      'spec-1:away': positionRecord({ status: 'active', side: 'away', riskAmountWei6: '250000' }),
      'spec-2:home': positionRecord({ speculationId: 'spec-2', contestId: 'contest-2', status: 'pendingSettle', side: 'home', riskAmountWei6: '100000' }),
      'spec-3:away': positionRecord({ speculationId: 'spec-3', contestId: 'contest-3', status: 'claimable', side: 'away', riskAmountWei6: '50000' }),
      'spec-4:home': positionRecord({ speculationId: 'spec-4', contestId: 'contest-4', status: 'claimed', side: 'home', riskAmountWei6: '999999' }),
    };
    const inv = inventoryFromState(stateWith({ positions }), NOW);
    expect(inv.openCommitmentCount).toBe(0);
    expect(inv.items).toHaveLength(3);
    expect(Object.fromEntries(inv.items.map((it) => [it.contestId, it.riskAmountUSDC]))).toEqual({ 'contest-1': 0.25, 'contest-2': 0.1, 'contest-3': 0.05 });
  });
});

// ── reconcileBook ────────────────────────────────────────────────────────────

describe('reconcileBook', () => {
  it('submits a fresh quote on every wanted side when the maker holds nothing on the speculation', () => {
    const r = reconcileBook([], desiredWith(quoteSide('away', 250), quoteSide('home', 165)), cfg(), NOW);
    expect(r.toSubmit.map((q) => q.side).sort()).toEqual(['away', 'home']);
    expect(r.toReplace).toEqual([]);
    expect(r.toSoftCancel).toEqual([]);
  });

  it('soft-cancels a visibleOpen on a side the quote no longer wants, and submits the wanted side', () => {
    const homeRec = commitmentRecord({ hash: '0xh', makerSide: 'home', lifecycle: 'visibleOpen' });
    const r = reconcileBook([homeRec], desiredWith(quoteSide('away', 250), null), cfg(), NOW);
    expect(r.toSubmit.map((q) => q.side)).toEqual(['away']);
    expect(r.toSoftCancel).toEqual([{ record: homeRec, reason: 'side-not-quoted' }]);
    expect(r.toReplace).toEqual([]);
  });

  it('leaves a fresh, correctly-priced visibleOpen alone (no submit / replace / cancel)', () => {
    const awayRec = commitmentRecord({ hash: '0xa', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 30 });
    const r = reconcileBook([awayRec], desiredWith(quoteSide('away', 250), null), cfg(), NOW);
    expect(r).toEqual({ toSubmit: [], toReplace: [], toSoftCancel: [] });
  });

  it('replaces a stale visibleOpen (reason "stale") on a wanted side', () => {
    const stale = commitmentRecord({ hash: '0xa', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 200 }); // > staleAfterSeconds (90)
    const replacement = quoteSide('away', 250);
    const r = reconcileBook([stale], desiredWith(replacement, null), cfg(), NOW);
    expect(r.toReplace).toEqual([{ stale, reason: 'stale', replacement }]);
    expect(r.toSubmit).toEqual([]);
    expect(r.toSoftCancel).toEqual([]);
  });

  it('replaces a mispriced visibleOpen (reason "mispriced"), but leaves one whose tick moved within the threshold', () => {
    const conf = cfg(); // orders.replaceOnOddsMoveBps defaults to 50

    // tick 250 → implied 0.4000; tick 200 → implied 0.5000 → ~1000 bps move → mispriced.
    const recA = commitmentRecord({ hash: '0xa', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 5 });
    const repl = quoteSide('away', 200);
    let r = reconcileBook([recA], desiredWith(repl, null), conf, NOW);
    expect(r.toReplace).toEqual([{ stale: recA, reason: 'mispriced', replacement: repl }]);
    expect(r.toSubmit).toEqual([]);

    // tick 250 → implied 0.4000; tick 253 → implied ~0.39526 → ~47 bps move < 50 → not mispriced.
    const recB = commitmentRecord({ hash: '0xb', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 5 });
    r = reconcileBook([recB], desiredWith(quoteSide('away', 253), null), conf, NOW);
    expect(r).toEqual({ toSubmit: [], toReplace: [], toSoftCancel: [] });
  });

  it('keeps the newest visibleOpen on a side and soft-cancels older ones as "duplicate" (book hygiene)', () => {
    const newer = commitmentRecord({ hash: '0xnew', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 10 });
    const older = commitmentRecord({ hash: '0xold', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 60 });
    // passed in reverse posting order — reconcileBook sorts newest-first internally.
    let r = reconcileBook([older, newer], desiredWith(quoteSide('away', 250), null), cfg(), NOW);
    expect(r.toSoftCancel).toEqual([{ record: older, reason: 'duplicate' }]);
    expect(r.toReplace).toEqual([]); // the kept (newer) one is fresh + on-tick
    expect(r.toSubmit).toEqual([]);

    // if the kept one is also stale: it gets replaced, the older is still a duplicate.
    const newerStale = commitmentRecord({ hash: '0xns', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 100 });
    const olderStale = commitmentRecord({ hash: '0xos', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, postedAtUnixSec: NOW - 200 });
    const repl = quoteSide('away', 250);
    r = reconcileBook([olderStale, newerStale], desiredWith(repl, null), cfg(), NOW);
    expect(r.toReplace).toEqual([{ stale: newerStale, reason: 'stale', replacement: repl }]);
    expect(r.toSoftCancel).toEqual([{ record: olderStale, reason: 'duplicate' }]);
    expect(r.toSubmit).toEqual([]);
  });

  it('soft-cancels every visibleOpen when the quote was refused (canQuote === false ⇒ both sides null)', () => {
    const awayRec = commitmentRecord({ hash: '0xa', makerSide: 'away', lifecycle: 'visibleOpen' });
    const homeRec = commitmentRecord({ hash: '0xh', makerSide: 'home', lifecycle: 'visibleOpen' });
    const r = reconcileBook([awayRec, homeRec], desiredWith(null, null), cfg(), NOW);
    expect(r.toSoftCancel).toEqual([
      { record: awayRec, reason: 'side-not-quoted' },
      { record: homeRec, reason: 'side-not-quoted' },
    ]);
    expect(r.toSubmit).toEqual([]);
    expect(r.toReplace).toEqual([]);
  });

  it('ignores softCancelled / filled records and expired visibleOpen ones — they are not the visible book', () => {
    const softCancelled = commitmentRecord({ hash: '0xsc', makerSide: 'away', lifecycle: 'softCancelled', postedAtUnixSec: NOW - 200 });
    const filled = commitmentRecord({ hash: '0xf', makerSide: 'away', lifecycle: 'filled' });
    const expiredVisible = commitmentRecord({ hash: '0xev', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: NOW - 1, postedAtUnixSec: NOW - 200 });
    const r = reconcileBook([softCancelled, filled, expiredVisible], desiredWith(quoteSide('away', 250), quoteSide('home', 165)), cfg(), NOW);
    expect(r.toSubmit.map((q) => q.side).sort()).toEqual(['away', 'home']); // both fresh-submitted; none of those records occupied a side
    expect(r.toSoftCancel).toEqual([]); // an expired visibleOpen is dead on chain — not soft-cancelled
    expect(r.toReplace).toEqual([]);
  });

  it('does not double-post over a non-expired partiallyFilled remainder on a wanted side (an expired one does not suppress)', () => {
    const partial = commitmentRecord({ hash: '0xpf', makerSide: 'away', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000' });
    const d = desiredWith(quoteSide('away', 250), quoteSide('home', 165));
    let r = reconcileBook([partial], d, cfg(), NOW);
    expect(r.toSubmit.map((q) => q.side)).toEqual(['home']); // away occupied by the partial
    expect(r.toReplace).toEqual([]); // v0 doesn't reconcile partials
    expect(r.toSoftCancel).toEqual([]);

    const expiredPartial = commitmentRecord({ hash: '0xep', makerSide: 'away', lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: NOW - 1 });
    r = reconcileBook([expiredPartial], d, cfg(), NOW);
    expect(r.toSubmit.map((q) => q.side).sort()).toEqual(['away', 'home']); // the expired partial doesn't occupy the side
  });
});
