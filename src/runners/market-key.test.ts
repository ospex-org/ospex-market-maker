import { describe, expect, it } from 'vitest';

import { marketKey } from './index.js';

// ── tracked-market identity (the `trackedMarkets` map key) ──────────────────────
//
// A single contest can carry independent moneyline / spread / total markets (and,
// once line policy lands, distinct lines), so the runner keys its tracked-market
// map on `marketKey(contestId, marketType, lineTicks)` rather than `contestId`
// alone. These assertions pin the property the map relies on: markets that differ
// in ANY identity component get DISTINCT keys (so the map never collapses two of a
// contest's markets onto one entry), while the same identity round-trips stably.

describe('marketKey — tracked-market identity', () => {
  it('moneyline collapses to a stable `…:moneyline:0` key (1:1 with the old contestId key)', () => {
    expect(marketKey('1234', 'moneyline', 0)).toBe('1234:moneyline:0');
    // Deterministic — the same identity always produces the same key (the map relies
    // on this to find/refresh an already-tracked market rather than re-adding it).
    expect(marketKey('1234', 'moneyline', 0)).toBe(marketKey('1234', 'moneyline', 0));
  });

  it('the same contest gets distinct keys per market type — moneyline / spread / total never collide', () => {
    const ml = marketKey('1234', 'moneyline', 0);
    const spread = marketKey('1234', 'spread', -15);
    const total = marketKey('1234', 'total', 85);
    expect(new Set([ml, spread, total]).size).toBe(3); // three independent map entries for one contest
  });

  it('the same contest + market gets distinct keys per line — two spread lines never collide', () => {
    expect(marketKey('1234', 'spread', -15)).not.toBe(marketKey('1234', 'spread', 15));
    expect(marketKey('1234', 'total', 85)).not.toBe(marketKey('1234', 'total', 90));
  });

  it('different contests never collide even at the same market + line', () => {
    expect(marketKey('1234', 'moneyline', 0)).not.toBe(marketKey('5678', 'moneyline', 0));
  });
});
