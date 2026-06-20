import { describe, expect, it } from 'vitest';

import { MM_MAX_SANE_LINE_TICKS } from './constants.js';
import { assertLineWithinSanityBand, isLineWithinSanityBand, LineOutOfSanityBandError } from './line.js';

// ── line-sanity rail (locked decision #1) ──────────────────────────────────────

describe('line-sanity bound', () => {
  it('MM_MAX_SANE_LINE_TICKS is the conservative ±500.0 line band, far tighter than the SDK catastrophic floor', () => {
    expect(MM_MAX_SANE_LINE_TICKS).toBe(5_000); // = ±500.0 line points (10×-scaled)
    // The SDK's catastrophic-overflow MAX_LINE_TICKS floor is ±1,000,000 ticks; this
    // fat-finger rail must stay well inside it. Guards against accidental widening.
    expect(MM_MAX_SANE_LINE_TICKS).toBeLessThan(1_000_000);
    // …and still comfortably above the most extreme real sports line (an NBA total
    // ~260.0 ⇒ 2_600 ticks), so legitimate quoting is never refused.
    expect(MM_MAX_SANE_LINE_TICKS).toBeGreaterThan(2_600);
  });

  it('accepts moneyline (always lineTicks 0) and every realistic spread/total line', () => {
    expect(isLineWithinSanityBand(0)).toBe(true); // moneyline
    expect(isLineWithinSanityBand(-15)).toBe(true); // -1.5 MLB run line (favorite)
    expect(isLineWithinSanityBand(15)).toBe(true); // +1.5 MLB run line (underdog)
    expect(isLineWithinSanityBand(-35)).toBe(true); // -3.5 spread
    expect(isLineWithinSanityBand(70)).toBe(true); // 7.0 MLB total
    expect(isLineWithinSanityBand(2_205)).toBe(true); // 220.5 NBA total
    expect(isLineWithinSanityBand(2_600)).toBe(true); // 260.0 extreme NBA total
  });

  it('accepts the band boundary and refuses anything just past it (fat-finger rail)', () => {
    expect(isLineWithinSanityBand(MM_MAX_SANE_LINE_TICKS)).toBe(true); // 5_000 (±500.0) — inclusive
    expect(isLineWithinSanityBand(-MM_MAX_SANE_LINE_TICKS)).toBe(true);
    expect(isLineWithinSanityBand(MM_MAX_SANE_LINE_TICKS + 1)).toBe(false); // 5_001 — refused
    expect(isLineWithinSanityBand(-(MM_MAX_SANE_LINE_TICKS + 1))).toBe(false);
    expect(isLineWithinSanityBand(25_000)).toBe(false); // a 2_500.0 fat-finger total
    expect(isLineWithinSanityBand(2_147_483_647)).toBe(false); // int32 max — the on-chain fund-lock value
  });

  it('refuses non-integer and non-finite lines', () => {
    expect(isLineWithinSanityBand(15.5)).toBe(false); // a half-tick — lineTicks must be an integer
    expect(isLineWithinSanityBand(Number.NaN)).toBe(false);
    expect(isLineWithinSanityBand(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isLineWithinSanityBand(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('assertLineWithinSanityBand returns an in-band line unchanged', () => {
    expect(assertLineWithinSanityBand(0)).toBe(0);
    expect(assertLineWithinSanityBand(-15)).toBe(-15);
    expect(assertLineWithinSanityBand(2_600)).toBe(2_600);
  });

  it('assertLineWithinSanityBand throws LineOutOfSanityBandError carrying the offending value + bound', () => {
    expect(() => assertLineWithinSanityBand(25_000)).toThrow(LineOutOfSanityBandError);
    expect(() => assertLineWithinSanityBand(15.5)).toThrow(LineOutOfSanityBandError);
    try {
      assertLineWithinSanityBand(25_000);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LineOutOfSanityBandError);
      const e = err as LineOutOfSanityBandError;
      expect(e.lineTicks).toBe(25_000);
      expect(e.maxAbsLineTicks).toBe(MM_MAX_SANE_LINE_TICKS);
      expect(e.name).toBe('LineOutOfSanityBandError');
      expect(e.message).toContain('25000');
    }
  });
});
