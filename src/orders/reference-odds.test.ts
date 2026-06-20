import { describe, expect, it } from 'vitest';

import type { MoneylineOdds, SpreadOdds, TotalOdds } from '../ospex/index.js';
import { oracleLineTicks, referenceOddsEqual, referenceOddsFromSdk, type ReferenceOdds } from './reference-odds.js';

// Every SDK odds shape extends OddsTimestamps; a real delivery carries them. The
// mapper must ignore them (they're liveness metadata, not pricing inputs).
const TS = {
  upstreamLastUpdated: '2026-06-20T01:20:03.457+00:00',
  pollCapturedAt: '2026-06-20T01:20:03.457+00:00',
  changedAt: '2026-06-20T01:20:03.457+00:00',
} as const;

const moneyline = (away: number | null, home: number | null): MoneylineOdds => ({
  market: 'moneyline',
  awayOddsAmerican: away,
  homeOddsAmerican: home,
  ...TS,
});
const spread = (awayLine: number | null, homeLine: number | null, away: number | null, home: number | null): SpreadOdds => ({
  market: 'spread',
  awayLine,
  homeLine,
  awayOddsAmerican: away,
  homeOddsAmerican: home,
  ...TS,
});
const total = (line: number | null, over: number | null, under: number | null): TotalOdds => ({
  market: 'total',
  line,
  overOddsAmerican: over,
  underOddsAmerican: under,
  ...TS,
});

// ── reference-odds ingestion (SDK shape → MM usable ReferenceOdds) ──────────────

describe('referenceOddsFromSdk', () => {
  it('maps a fully-priced moneyline to a usable ReferenceOdds (no field swap)', () => {
    expect(referenceOddsFromSdk(moneyline(-150, 130))).toEqual<ReferenceOdds>({
      market: 'moneyline',
      awayOddsAmerican: -150,
      homeOddsAmerican: 130,
    });
  });

  it('maps a live MLB run-line spread (home favored -1.5) preserving line + per-side juice', () => {
    // Live-observed MLB shape: home -1.5 / away +1.5, away +152 / home -176.
    expect(referenceOddsFromSdk(spread(1.5, -1.5, 152, -176))).toEqual<ReferenceOdds>({
      market: 'spread',
      awayLine: 1.5,
      homeLine: -1.5,
      awayOddsAmerican: 152,
      homeOddsAmerican: -176,
    });
  });

  it('maps a live MLB total preserving line + over/under juice (over→over, under→under)', () => {
    // Live-observed MLB shape: total 7.5, over +104 / under -123.
    expect(referenceOddsFromSdk(total(7.5, 104, -123))).toEqual<ReferenceOdds>({
      market: 'total',
      line: 7.5,
      overOddsAmerican: 104,
      underOddsAmerican: -123,
    });
  });

  it('returns null when a moneyline side is unpriced', () => {
    expect(referenceOddsFromSdk(moneyline(null, 130))).toBeNull();
    expect(referenceOddsFromSdk(moneyline(-150, null))).toBeNull();
    expect(referenceOddsFromSdk(moneyline(null, null))).toBeNull();
  });

  it('returns null when any spread field — a line or a side price — is missing', () => {
    expect(referenceOddsFromSdk(spread(null, -1.5, 152, -176))).toBeNull(); // no away line
    expect(referenceOddsFromSdk(spread(1.5, null, 152, -176))).toBeNull(); // no home line
    expect(referenceOddsFromSdk(spread(1.5, -1.5, null, -176))).toBeNull(); // no away juice
    expect(referenceOddsFromSdk(spread(1.5, -1.5, 152, null))).toBeNull(); // no home juice
  });

  it('returns null when the total line or a side price is missing', () => {
    expect(referenceOddsFromSdk(total(null, 104, -123))).toBeNull(); // no line
    expect(referenceOddsFromSdk(total(7.5, null, -123))).toBeNull(); // no over juice
    expect(referenceOddsFromSdk(total(7.5, 104, null))).toBeNull(); // no under juice
  });

  it('treats a pick-em / zero line as a real, usable value (0 is not "missing")', () => {
    expect(referenceOddsFromSdk(spread(0, 0, -110, -110))).toMatchObject({ market: 'spread', awayLine: 0, homeLine: 0 });
    // (total line is contract-bounded >= 0; a 0 total is degenerate but still "present")
    expect(referenceOddsFromSdk(total(0, -110, -110))).toMatchObject({ market: 'total', line: 0 });
  });
});

// ── reference-odds change-detection (polling-fallback ingestion) ────────────────
//
// `referenceOddsEqual` decides whether the reference moved since last tick (and the
// market must re-quote). It is market-aware: identical iff same market AND every
// pricing-relevant field matches. Built from the real mapper so the test exercises
// the shapes the runner actually compares.

describe('referenceOddsEqual', () => {
  const ref = (odds: Parameters<typeof referenceOddsFromSdk>[0]): ReferenceOdds => {
    const r = referenceOddsFromSdk(odds);
    if (r === null) throw new Error('test fixture must be fully priced');
    return r;
  };

  it('a market is equal to itself, field-for-field (no spurious re-quote on an unchanged poll)', () => {
    expect(referenceOddsEqual(ref(moneyline(-150, 130)), ref(moneyline(-150, 130)))).toBe(true);
    expect(referenceOddsEqual(ref(spread(1.5, -1.5, 152, -176)), ref(spread(1.5, -1.5, 152, -176)))).toBe(true);
    expect(referenceOddsEqual(ref(total(7.5, 104, -123)), ref(total(7.5, 104, -123)))).toBe(true);
  });

  it('moneyline: any side-price move is a change', () => {
    expect(referenceOddsEqual(ref(moneyline(-150, 130)), ref(moneyline(-148, 130)))).toBe(false); // away juice moved
    expect(referenceOddsEqual(ref(moneyline(-150, 130)), ref(moneyline(-150, 132)))).toBe(false); // home juice moved
  });

  it('spread: a line move OR a side-price move is a change (the line matters, not just juice)', () => {
    const base = ref(spread(1.5, -1.5, 152, -176));
    expect(referenceOddsEqual(base, ref(spread(2.5, -2.5, 152, -176)))).toBe(false); // both lines moved together
    // Each line field is compared independently — move one in isolation (a synthetic
    // shape; real run-lines mirror, but the equality check must not depend on that).
    expect(referenceOddsEqual(base, ref(spread(2.5, -1.5, 152, -176)))).toBe(false); // away line only
    expect(referenceOddsEqual(base, ref(spread(1.5, -2.5, 152, -176)))).toBe(false); // home line only
    expect(referenceOddsEqual(base, ref(spread(1.5, -1.5, 150, -176)))).toBe(false); // away juice moved
    expect(referenceOddsEqual(base, ref(spread(1.5, -1.5, 152, -174)))).toBe(false); // home juice moved
  });

  it('total: a line move OR an over/under-price move is a change', () => {
    const base = ref(total(7.5, 104, -123));
    expect(referenceOddsEqual(base, ref(total(8.5, 104, -123)))).toBe(false); // line moved
    expect(referenceOddsEqual(base, ref(total(7.5, 106, -123)))).toBe(false); // over juice moved
    expect(referenceOddsEqual(base, ref(total(7.5, 104, -125)))).toBe(false); // under juice moved
  });

  it('different markets are never equal (a contest can carry moneyline + spread + total at once)', () => {
    expect(referenceOddsEqual(ref(moneyline(-150, 130)), ref(spread(1.5, -1.5, 152, -176)))).toBe(false);
    expect(referenceOddsEqual(ref(spread(1.5, -1.5, 152, -176)), ref(total(7.5, 104, -123)))).toBe(false);
    expect(referenceOddsEqual(ref(total(7.5, 104, -123)), ref(moneyline(-150, 130)))).toBe(false);
  });
});

// ── oracle line → on-chain lineTicks (the line a tracked spec must carry) ────────
//
// PINS the side/sign convention: spread lineTicks is AWAY-perspective, 10×-scaled
// (a spec at away -1.5 is -15); total lineTicks is the threshold, 10×-scaled. These
// are the values a tracked speculation's `lineTicks` is compared against, so the
// sign/perspective must match the protocol exactly — the runner refuses to quote on
// a mismatch.

describe('oracleLineTicks', () => {
  const ref = (odds: Parameters<typeof referenceOddsFromSdk>[0]): ReferenceOdds => {
    const r = referenceOddsFromSdk(odds);
    if (r === null) throw new Error('test fixture must be fully priced');
    return r;
  };

  it('moneyline has no line → null', () => {
    expect(oracleLineTicks(ref(moneyline(-150, 130)))).toBeNull();
  });

  it('spread → round(awayLine × 10), away-perspective (matches the spec lineTicks convention)', () => {
    // Away favored -1.5 (home +1.5): away-perspective ticks = -15.
    expect(oracleLineTicks(ref(spread(-1.5, 1.5, -176, 152)))).toBe(-15);
    // Away underdog +1.5 (home -1.5): away-perspective ticks = +15.
    expect(oracleLineTicks(ref(spread(1.5, -1.5, 152, -176)))).toBe(15);
    // A pick-em / 0 line is a real value.
    expect(oracleLineTicks(ref(spread(0, 0, -110, -110)))).toBe(0);
    // A larger run/point line preserves magnitude + sign.
    expect(oracleLineTicks(ref(spread(-7.5, 7.5, -110, -110)))).toBe(-75);
  });

  it('total → round(line × 10), perspective-neutral', () => {
    expect(oracleLineTicks(ref(total(7.5, 104, -123)))).toBe(75);
    expect(oracleLineTicks(ref(total(220.5, -110, -110)))).toBe(2205); // NBA-scale total
    expect(oracleLineTicks(ref(total(0, -110, -110)))).toBe(0);
  });
});
