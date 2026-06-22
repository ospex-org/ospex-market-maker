import { describe, expect, it } from 'vitest';

import { contestWorstCaseUSDC } from '../risk/index.js';
import type { ExposureItem, MarketType } from '../risk/types.js';
import { isSeedSpeculationId, seedSpeculationId } from './seed.js';

function item(speculationId: string, makerSide: 'away' | 'home', riskAmountUSDC: number, marketType: MarketType = 'spread'): ExposureItem {
  return { contestId: 'C1', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', speculationId, marketType, makerSide, riskAmountUSDC, source: 'commitment' };
}

describe('seedSpeculationId / isSeedSpeculationId', () => {
  it('mints a stable placeholder per (contest, market, line), collision-proof vs a real (decimal) id', () => {
    const id = seedSpeculationId('C1', 'spread', -15);
    expect(id).toBe('seed:C1:spread:-15');
    expect(seedSpeculationId('C1', 'spread', -15)).toBe(id); // stable — every record of one seed shares it
    expect(seedSpeculationId('C1', 'total', 85)).not.toBe(id); // distinct per market + line
    expect(isSeedSpeculationId(id)).toBe(true);
    expect(isSeedSpeculationId('4217')).toBe(false); // a real on-chain counter id
    expect(/^\d+$/.test(id)).toBe(false); // never a pure-decimal string → can never collide with a real id
  });
});

describe('seed placeholder in the risk engine', () => {
  it('groups a seed-keyed exposure in ISOLATION from a real-keyed one (no merge → per-contest worst case is not under-counted)', () => {
    const seedKey = seedSpeculationId('C1', 'spread', -15);
    // A seed away-side + a real-id home-side on the same contest — opposite sides so merge-vs-isolate differ.
    const items = [item(seedKey, 'away', 1), item('4217', 'home', 1)];
    // Isolated → two groups, each worst case 1.0 → 2.0. If the seed key wrongly merged with the real id,
    // the two opposite sides would net into a single group worth max(1.0, 1.0) = 1.0. Asserting 2.0 proves isolation.
    expect(contestWorstCaseUSDC(items, 'C1')).toBe(2);
  });

  it('a seed-only contest keys + sums its worst case correctly', () => {
    const items = [item(seedSpeculationId('C1', 'total', 85), 'away', 1.5, 'total')];
    expect(contestWorstCaseUSDC(items, 'C1')).toBe(1.5);
  });

  it('two records of the SAME seed share one group (the placeholder is stable → not split into two groups)', () => {
    const seedKey = seedSpeculationId('C1', 'spread', -15);
    const items = [item(seedKey, 'away', 1), item(seedKey, 'home', 1)];
    // Same group, opposite sides → worst case max(1.0, 1.0) = 1.0 (NOT 2.0).
    expect(contestWorstCaseUSDC(items, 'C1')).toBe(1);
  });
});
