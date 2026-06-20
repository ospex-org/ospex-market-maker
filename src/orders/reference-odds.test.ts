import { describe, expect, it } from 'vitest';

import type { MoneylineOdds, SpreadOdds, TotalOdds } from '../ospex/index.js';
import { referenceOddsFromSdk, type ReferenceOdds } from './reference-odds.js';

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
