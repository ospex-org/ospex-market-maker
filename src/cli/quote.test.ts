import { describe, expect, it } from 'vitest';

import type { Contest, ContestOddsSnapshot, Speculation } from '@ospex/sdk';

import { parseConfig, type Config } from '../config/index.js';
import { OspexAdapter, type OspexClientLike } from '../ospex/index.js';
import {
  quoteExitCode,
  renderQuoteReportJson,
  renderQuoteReportText,
  runQuote,
  type QuoteReport,
} from './quote.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const MONEYLINE_OPEN: Speculation = {
  speculationId: 'spec-ml',
  contestId: 'contest-1',
  type: 'moneyline',
  lineTicks: null,
  line: null,
  speculationStatus: 0,
};
const MONEYLINE_CLOSED: Speculation = { ...MONEYLINE_OPEN, speculationStatus: 1 };
const SPREAD_OPEN: Speculation = {
  speculationId: 'spec-sp',
  contestId: 'contest-1',
  type: 'spread',
  lineTicks: -35,
  line: -3.5,
  speculationStatus: 0,
};

function contestWith(overrides: Partial<Contest> = {}): Contest {
  return {
    contestId: 'contest-1',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    sport: 'mlb',
    sportId: 0,
    matchTime: '2026-05-12T01:30:00Z',
    status: 'verified',
    jsonoddsId: 'GAME-1',
    speculations: [MONEYLINE_OPEN, SPREAD_OPEN],
    ...overrides,
  };
}

function oddsWith(moneyline: ContestOddsSnapshot['odds']['moneyline'] = {
  market: 'moneyline',
  awayOddsAmerican: 150,
  homeOddsAmerican: -180,
  upstreamLastUpdated: '2026-05-11T20:00:00Z',
  pollCapturedAt: '2026-05-11T20:00:30Z',
  changedAt: '2026-05-11T20:00:00Z',
}): ContestOddsSnapshot {
  return { contestId: 'contest-1', jsonoddsId: 'GAME-1', odds: { moneyline, spread: null, total: null } };
}

type ClientOverrides = { [K in keyof OspexClientLike]?: Partial<OspexClientLike[K]> };
function fakeAdapter(client: ClientOverrides): OspexAdapter {
  const notStubbed = (name: string) => () => Promise.reject(new Error(`fake.${name}: not stubbed`));
  const full: OspexClientLike = {
    contests: { get: notStubbed('contests.get'), list: notStubbed('contests.list'), ...client.contests },
    speculations: { list: notStubbed('speculations.list'), get: notStubbed('speculations.get'), ...client.speculations },
    commitments: { list: notStubbed('commitments.list'), get: notStubbed('commitments.get'), ...client.commitments },
    positions: { status: notStubbed('positions.status'), byAddress: notStubbed('positions.byAddress'), ...client.positions },
    balances: { read: notStubbed('balances.read'), ...client.balances },
    approvals: { read: notStubbed('approvals.read'), ...client.approvals },
    health: { check: notStubbed('health.check'), ...client.health },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe'), ...client.odds },
  };
  return new OspexAdapter(full, { chainId: 137, apiUrl: 'https://api.test' });
}

/** An adapter where `getContest` / `getOddsSnapshot` resolve to the given SDK shapes. */
function adapterFor(contest: Contest, odds: ContestOddsSnapshot): OspexAdapter {
  return fakeAdapter({
    contests: { get: () => Promise.resolve(contest) },
    odds: { snapshot: () => Promise.resolve(odds), subscribe: () => Promise.resolve({ unsubscribe: async () => {} }) },
  });
}

const cfg = (overrides: Record<string, unknown> = {}): Config => parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });

function collect(): { sink: { write(s: string): void }; text: () => string } {
  let buf = '';
  return { sink: { write: (s: string) => { buf += s; } }, text: () => buf };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('runQuote — happy path', () => {
  it('computes a two-sided moneyline quote; exit 0', async () => {
    const report = await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith(), oddsWith()) });
    expect(report.pipeline).toBe('computed');
    if (report.pipeline !== 'computed') throw new Error('unreachable');
    expect(report.context).toMatchObject({ contestId: 'contest-1', awayTeam: 'NYM', homeTeam: 'LAD', sport: 'mlb', referenceGameId: 'GAME-1' });
    expect(report.referenceOdds.awayOddsAmerican).toBe(150);
    expect(report.referenceOdds.homeOddsAmerican).toBe(-180);
    expect(report.referenceOdds.overround).toBeGreaterThan(0);
    expect(report.result.canQuote).toBe(true);
    // default config: economics mode, capitalUSDC 50, maxRiskPerCommitmentUSDC 0.25 → per-side size ~0.25 USDC.
    expect(report.result.away?.sizeUSDC).toBeGreaterThan(0);
    expect(report.result.home?.sizeUSDC).toBeGreaterThan(0);
    expect(report.spreadMode).toBe('economics');
    expect(report.inventoryNote).toMatch(/empty inventory/);
    expect(quoteExitCode(report)).toBe(0);
  });
});

describe('runQuote — refusals (exit 1)', () => {
  async function expectRefused(report: QuoteReport, pattern: RegExp): Promise<void> {
    expect(report.pipeline).toBe('refused');
    if (report.pipeline !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(pattern);
    expect(quoteExitCode(report)).toBe(1);
  }

  it('contest is scored / voided → refused', async () => {
    await expectRefused(
      await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith({ status: 'scored' }), oddsWith()) }),
      /scored/,
    );
    await expectRefused(
      await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith({ status: 'voided' }), oddsWith()) }),
      /voided/,
    );
  });

  it('no moneyline speculation → refused with the lazy-creation message', async () => {
    await expectRefused(
      await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith({ speculations: [SPREAD_OPEN] }), oddsWith()) }),
      /no moneyline speculation|lazy-creation/,
    );
  });

  it('moneyline speculation is closed → refused', async () => {
    await expectRefused(
      await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith({ speculations: [MONEYLINE_CLOSED] }), oddsWith()) }),
      /closed/,
    );
  });

  it('no reference moneyline odds → refused', async () => {
    await expectRefused(
      await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith(), oddsWith(null)) }),
      /no reference moneyline odds/,
    );
  });

  it('incomplete reference moneyline odds → refused', async () => {
    await expectRefused(
      await runQuote({
        contestId: 'contest-1',
        config: cfg(),
        adapter: adapterFor(
          contestWith(),
          oddsWith({ market: 'moneyline', awayOddsAmerican: 150, homeOddsAmerican: null, upstreamLastUpdated: 'x', pollCapturedAt: 'x', changedAt: 'x' }),
        ),
      }),
      /incomplete/,
    );
  });
});

describe('runQuote — computed-but-canQuote-false (exit 1)', () => {
  it('the math refuses (direct spread far exceeds the consensus overround)', async () => {
    const report = await runQuote({
      contestId: 'contest-1',
      config: cfg({ pricing: { mode: 'direct', direct: { spreadBps: 9000 } } }),
      adapter: adapterFor(contestWith(), oddsWith()),
    });
    expect(report.pipeline).toBe('computed');
    if (report.pipeline !== 'computed') throw new Error('unreachable');
    expect(report.result.canQuote).toBe(false);
    expect(report.result.notes.some((n) => n.startsWith('REFUSE:'))).toBe(true);
    expect(quoteExitCode(report)).toBe(1);
  });
});

describe('runQuote — operational failures throw (CLI exits 1)', () => {
  it('a failing contest fetch propagates', async () => {
    const adapter = fakeAdapter({ contests: { get: () => Promise.reject(new Error('contest not found')) }, odds: { snapshot: () => Promise.resolve(oddsWith()), subscribe: () => Promise.resolve({ unsubscribe: async () => {} }) } });
    await expect(runQuote({ contestId: 'nope', config: cfg(), adapter })).rejects.toThrow(/contest not found/);
  });
});

describe('renderQuoteReport*', () => {
  it('JSON envelope is { schemaVersion: 1, quote: QuoteReport }', async () => {
    const report = await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith(), oddsWith()) });
    const { sink, text } = collect();
    renderQuoteReportJson(report, sink);
    const parsed = JSON.parse(text()) as { schemaVersion: number; quote: QuoteReport };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.quote.contestId).toBe('contest-1');
    expect(parsed.quote.pipeline).toBe('computed');
  });

  it('text render shows the contest, reference odds, and the quote — and the refusal reason for a refused report', async () => {
    const ok = await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith(), oddsWith()) });
    const { sink: s1, text: t1 } = collect();
    renderQuoteReportText(ok, s1);
    const o1 = t1();
    expect(o1).toContain('NYM @ LAD');
    expect(o1).toMatch(/Reference odds/);
    expect(o1).toMatch(/Quote/);

    const refused = await runQuote({ contestId: 'contest-1', config: cfg(), adapter: adapterFor(contestWith({ speculations: [] }), oddsWith()) });
    const { sink: s2, text: t2 } = collect();
    renderQuoteReportText(refused, s2);
    expect(t2()).toMatch(/Refused:/);
  });
});
