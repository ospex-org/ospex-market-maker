import { describe, expect, it } from 'vitest';

import type { Contest, ContestOddsSnapshot, ContestsListOptions, Game, GamesListOptions, Speculation } from '@ospex/sdk';

import { parseConfig, type Config } from '../config/index.js';
import { OspexAdapter, type OspexClientLike } from '../ospex/index.js';
import {
  candidatesExitCode,
  renderCandidatesReportJson,
  renderCandidatesReportText,
  resolveHours,
  resolveSports,
  runCandidates,
  type CandidateItem,
  type CandidatesReport,
} from './candidates.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Fixed clock: 2026-06-12T16:00:00Z — every fixture matchTime is relative to this. */
const T0_ISO = '2026-06-12T16:00:00Z';
const NOW = (): Date => new Date(T0_ISO);

function gameWith(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'game-1',
    slug: 'mia-pit-2026-06-12',
    sport: 'mlb',
    matchTime: '2026-06-12T22:40:00Z',
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Miami Marlins', abbreviation: 'MIA' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'ext-1', sportspage: null, rundown: null },
    ...overrides,
  };
}

function moneylineSpec(contestId: string, open = true): Speculation {
  return {
    speculationId: `spec-ml-${contestId}`,
    contestId,
    type: 'moneyline',
    lineTicks: null,
    line: null,
    speculationStatus: open ? 0 : 1,
  };
}

function spreadSpec(contestId: string): Speculation {
  return {
    speculationId: `spec-sp-${contestId}`,
    contestId,
    type: 'spread',
    lineTicks: -35,
    line: -3.5,
    speculationStatus: 0,
  };
}

function contestWith(overrides: Partial<Contest> = {}): Contest {
  return {
    contestId: 'contest-1',
    awayTeam: 'Miami Marlins',
    homeTeam: 'Pittsburgh Pirates',
    sport: 'mlb',
    sportId: 0,
    matchTime: '2026-06-12T22:40:00Z',
    status: 'verified',
    jsonoddsId: null, // list rows don't carry the linkage (detail-endpoint-only)
    speculations: [moneylineSpec('contest-1')],
    ...overrides,
  };
}

function oddsSnapshot(
  contestId: string,
  moneyline: ContestOddsSnapshot['odds']['moneyline'] = {
    market: 'moneyline',
    awayOddsAmerican: -113,
    homeOddsAmerican: -100,
    upstreamLastUpdated: '2026-06-12T15:00:00Z',
    pollCapturedAt: '2026-06-12T15:00:30Z',
    changedAt: '2026-06-12T15:00:00Z',
  },
): ContestOddsSnapshot {
  return { contestId, odds: { moneyline, spread: null, total: null } };
}

type ClientOverrides = { [K in keyof OspexClientLike]?: Partial<OspexClientLike[K]> };
function fakeAdapter(client: ClientOverrides): OspexAdapter {
  const notStubbed = (name: string) => () => Promise.reject(new Error(`fake.${name}: not stubbed`));
  const full: OspexClientLike = {
    contests: { get: notStubbed('contests.get'), list: notStubbed('contests.list'), ...client.contests },
    games: { list: notStubbed('games.list'), ...client.games },
    speculations: { list: notStubbed('speculations.list'), get: notStubbed('speculations.get'), ...client.speculations },
    commitments: {
      list: notStubbed('commitments.list'), get: notStubbed('commitments.get'),
      submitRaw: notStubbed('commitments.submitRaw'), cancel: notStubbed('commitments.cancel'),
      cancelOnchain: notStubbed('commitments.cancelOnchain'), raiseMinNonce: notStubbed('commitments.raiseMinNonce'),
      approve: notStubbed('commitments.approve'), getNonceFloor: notStubbed('commitments.getNonceFloor'),
      ...client.commitments,
    },
    positions: {
      status: notStubbed('positions.status'), byAddress: notStubbed('positions.byAddress'),
      settleSpeculation: notStubbed('positions.settleSpeculation'), ensureSpeculationSettled: notStubbed('positions.ensureSpeculationSettled'), claim: notStubbed('positions.claim'), ensurePositionClaimed: notStubbed('positions.ensurePositionClaimed'),
      claimAll: notStubbed('positions.claimAll'),
      ...client.positions,
    },
    balances: { read: notStubbed('balances.read'), ...client.balances },
    approvals: { read: notStubbed('approvals.read'), ...client.approvals },
    health: { check: notStubbed('health.check'), ...client.health },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe'), ...client.odds },
    ownState: { subscribe: () => ({ unsubscribe: () => Promise.reject(new Error('fake.ownState.subscribe: not stubbed')) }), health: notStubbed('ownState.health') },
  };
  return new OspexAdapter(full, { chainId: 137, apiUrl: 'https://api.test' });
}

/** An adapter whose games/contests lists resolve to the given SDK shapes (single page each) and whose odds snapshots resolve per contest id. */
function adapterFor(games: Game[], contests: Contest[], odds: Record<string, ContestOddsSnapshot | Error> = {}): OspexAdapter {
  return fakeAdapter({
    games: { list: () => Promise.resolve(games) },
    contests: { list: () => Promise.resolve(contests) },
    odds: {
      snapshot: (contestId: string) => {
        const entry = odds[contestId];
        if (entry === undefined) return Promise.reject(new Error(`no odds stubbed for ${contestId}`));
        if (entry instanceof Error) return Promise.reject(entry);
        return Promise.resolve(entry);
      },
      subscribe: () => Promise.resolve({ unsubscribe: async () => {} }),
    },
  });
}

const cfg = (overrides: Record<string, unknown> = {}): Config => parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });

function run(adapter: OspexAdapter, config = cfg(), opts: { sports?: Config['marketSelection']['sports']; hours?: number } = {}): Promise<CandidatesReport> {
  return runCandidates({
    config,
    adapter,
    sports: opts.sports ?? config.marketSelection.sports,
    hours: opts.hours ?? 24,
    now: NOW,
  });
}

function collect(): { sink: { write(s: string): void }; text: () => string } {
  let buf = '';
  return { sink: { write: (s: string) => { buf += s; } }, text: () => buf };
}

// ── 1. the tomorrow-morning reality: a creatable slate, nothing quotable ─────

describe('runCandidates — setup slate (no contests yet)', () => {
  it('classifies every creatable game as setup; summary counts agree; exit 0', async () => {
    const games = Array.from({ length: 15 }, (_, i) =>
      gameWith({ gameId: `game-${i}`, slug: `slug-${i}`, matchTime: `2026-06-12T2${i % 4}:10:00Z` }),
    );
    const report = await run(adapterFor(games, []));

    expect(report.items).toHaveLength(15);
    expect(report.items.every((i) => i.kind === 'setup')).toBe(true);
    expect(report.items.every((i) => i.recommendedAction === 'create_contest_then_seed_moneyline')).toBe(true);
    expect(report.summary).toEqual({
      gamesAvailableToCreate: 15,
      quoteReady: 0,
      needsContest: 15,
      needsMoneylineSpeculation: 0,
      needsVerification: 0,
      skipped: {},
    });
    expect(report.truncated).toBe(false);
    expect(candidatesExitCode(report)).toBe(0);
  });

  it('setup items carry full team names, the game id, and a null contest id', async () => {
    const report = await run(adapterFor([gameWith()], []));
    expect(report.items[0]).toMatchObject({
      kind: 'setup',
      gameId: 'game-1',
      slug: 'mia-pit-2026-06-12',
      awayTeam: 'Miami Marlins',
      homeTeam: 'Pittsburgh Pirates',
      matchTime: '2026-06-12T22:40:00Z',
      status: 'upcoming',
      hasOdds: true,
      canCreateContest: true,
      contestCreated: false,
      contestId: null,
      moneylineSpeculationId: null,
    });
  });
});

// ── 2./3./7. contest lifecycle classification ────────────────────────────────

describe('runCandidates — contest classification', () => {
  const createdGame = (contestId: string, overrides: Partial<Game> = {}): Game =>
    gameWith({ gameId: `game-${contestId}`, contestCreated: true, contestId, ...overrides });

  it('verified contest with NO open moneyline speculation → needs_moneyline_speculation', async () => {
    const contest = contestWith({ speculations: [spreadSpec('contest-1'), moneylineSpec('contest-1', false)] });
    const report = await run(adapterFor([createdGame('contest-1')], [contest]));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      kind: 'needs_moneyline_speculation',
      recommendedAction: 'seed_moneyline_speculation',
      contestId: 'contest-1',
      contestStatus: 'verified',
      moneylineSpeculationId: null,
    });
  });

  it('verified contest WITH an open moneyline speculation and odds → quote_ready with referenceOdds', async () => {
    const report = await run(
      adapterFor([createdGame('contest-1')], [contestWith()], { 'contest-1': oddsSnapshot('contest-1') }),
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      kind: 'quote_ready',
      recommendedAction: 'quote',
      contestId: 'contest-1',
      contestStatus: 'verified',
      moneylineSpeculationId: 'spec-ml-contest-1',
      referenceOdds: { awayAmerican: -113, homeAmerican: -100 },
    });
    expect(report.summary.quoteReady).toBe(1);
    expect(candidatesExitCode(report)).toBe(0);
  });

  it('created game whose contest is still unverified → needs_verification', async () => {
    const contest = contestWith({ status: 'unverified' });
    const report = await run(adapterFor([createdGame('contest-1')], [contest]));
    expect(report.items[0]).toMatchObject({
      kind: 'needs_verification',
      recommendedAction: 'wait_for_verification',
      contestId: 'contest-1',
      contestStatus: 'unverified',
    });
    expect(report.summary.needsVerification).toBe(1);
  });

  it('created game with no contest row visible in the window yet → needs_verification with contestStatus null', async () => {
    const report = await run(adapterFor([createdGame('contest-9')], []));
    expect(report.items[0]).toMatchObject({
      kind: 'needs_verification',
      contestId: 'contest-9',
      contestStatus: null,
    });
  });

  it('a contest with no game row in the window is still classified (contest-only item)', async () => {
    const report = await run(adapterFor([], [contestWith()], { 'contest-1': oddsSnapshot('contest-1') }));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      kind: 'quote_ready',
      gameId: null,
      slug: null,
      status: null,
      hasOdds: null,
      canCreateContest: null,
      contestCreated: true,
      contestId: 'contest-1',
    });
  });

  it('requireReferenceOdds: false lets a quote candidate through without odds (referenceOdds null)', async () => {
    const config = cfg({ marketSelection: { requireReferenceOdds: false } });
    const report = await run(
      adapterFor([createdGame('contest-1')], [contestWith()], { 'contest-1': new Error('snapshot down') }),
      config,
    );
    expect(report.items[0]).toMatchObject({ kind: 'quote_ready', referenceOdds: null });
  });
});

// ── 4. skip reasons ──────────────────────────────────────────────────────────

describe('runCandidates — skip reasons', () => {
  it('uncreated game with canCreateContest=false → cannot-create-contest', async () => {
    const report = await run(adapterFor([gameWith({ canCreateContest: false })], []));
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'cannot-create-contest', recommendedAction: null });
  });

  it('uncreated game with hasOdds=false → no-odds', async () => {
    const report = await run(adapterFor([gameWith({ hasOdds: false })], []));
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'no-odds' });
  });

  it('live / final games → started-or-live', async () => {
    const report = await run(
      adapterFor(
        [
          gameWith({ gameId: 'g-live', status: 'live' }),
          gameWith({ gameId: 'g-final', status: 'final' }),
        ],
        [],
      ),
    );
    expect(report.items.map((i) => i.kind === 'skipped' && i.skipReason)).toEqual(['started-or-live', 'started-or-live']);
  });

  it('postponed / cancelled games → game-status-postponed-or-cancelled', async () => {
    const report = await run(
      adapterFor(
        [
          gameWith({ gameId: 'g-post', status: 'postponed' }),
          gameWith({ gameId: 'g-canc', status: 'cancelled' }),
        ],
        [],
      ),
    );
    expect(report.items.map((i) => i.kind === 'skipped' && i.skipReason)).toEqual([
      'game-status-postponed-or-cancelled',
      'game-status-postponed-or-cancelled',
    ]);
  });

  it('deny-listed contest → deny-list (even when it would otherwise be quote-ready)', async () => {
    const config = cfg({ marketSelection: { contestDenyList: ['contest-1'] } });
    const report = await run(
      adapterFor([gameWith({ contestCreated: true, contestId: 'contest-1' })], [contestWith()]),
      config,
    );
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'deny-list', contestId: 'contest-1' });
  });

  it('scored / voided contests → not-quotable-status', async () => {
    const report = await run(
      adapterFor(
        [
          gameWith({ gameId: 'g-1', contestCreated: true, contestId: 'c-scored' }),
          gameWith({ gameId: 'g-2', contestCreated: true, contestId: 'c-voided' }),
        ],
        [
          contestWith({ contestId: 'c-scored', status: 'scored' }),
          contestWith({ contestId: 'c-voided', status: 'voided' }),
        ],
      ),
    );
    expect(report.items.map((i) => i.kind === 'skipped' && i.skipReason)).toEqual(['not-quotable-status', 'not-quotable-status']);
  });

  it('odds snapshot failure on a quote candidate degrades to no-reference-odds — the command still succeeds (exit 0)', async () => {
    const report = await run(
      adapterFor(
        [gameWith({ contestCreated: true, contestId: 'contest-1' })],
        [contestWith()],
        { 'contest-1': new Error('snapshot endpoint down') },
      ),
    );
    expect(report.items[0]).toMatchObject({
      kind: 'skipped',
      skipReason: 'no-reference-odds',
      moneylineSpeculationId: 'spec-ml-contest-1',
    });
    expect(report.summary.skipped).toEqual({ 'no-reference-odds': 1 });
    expect(candidatesExitCode(report)).toBe(0);
  });

  it('incomplete reference odds (one side null) → no-reference-odds when required', async () => {
    const report = await run(
      adapterFor(
        [gameWith({ contestCreated: true, contestId: 'contest-1' })],
        [contestWith()],
        {
          'contest-1': oddsSnapshot('contest-1', {
            market: 'moneyline', awayOddsAmerican: -113, homeOddsAmerican: null,
            upstreamLastUpdated: 'x', pollCapturedAt: 'x', changedAt: 'x',
          }),
        },
      ),
    );
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'no-reference-odds' });
  });

  it('a contest-only item whose matchTime has passed → started-or-live', async () => {
    const report = await run(adapterFor([], [contestWith({ matchTime: '2026-06-12T15:00:00Z' })]));
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'started-or-live' });
  });

  it('a game whose matchTime has passed but whose status still reads upcoming (writer poll lag) → started-or-live', async () => {
    const report = await run(adapterFor([gameWith({ matchTime: '2026-06-12T15:55:00Z', status: 'upcoming' })], []));
    expect(report.items[0]).toMatchObject({ kind: 'skipped', skipReason: 'started-or-live' });
  });
});

// ── 5. envelope shape, summary arithmetic, sort order ────────────────────────

describe('runCandidates — report envelope + determinism', () => {
  async function mixedReport(): Promise<CandidatesReport> {
    const games = [
      gameWith({ gameId: 'g-setup-late', matchTime: '2026-06-13T01:10:00Z' }),
      gameWith({ gameId: 'g-setup-early', matchTime: '2026-06-12T22:40:00Z' }),
      gameWith({ gameId: 'g-ready', contestCreated: true, contestId: 'c-ready', matchTime: '2026-06-12T23:05:00Z' }),
      gameWith({ gameId: 'g-needs-ml', contestCreated: true, contestId: 'c-needs-ml', matchTime: '2026-06-12T22:40:00Z' }),
      gameWith({ gameId: 'g-unverified', contestCreated: true, contestId: 'c-unverified', matchTime: '2026-06-12T22:40:00Z' }),
      gameWith({ gameId: 'g-no-odds', hasOdds: false, matchTime: '2026-06-12T22:40:00Z' }),
    ];
    const contests = [
      contestWith({ contestId: 'c-ready', matchTime: '2026-06-12T23:05:00Z', speculations: [moneylineSpec('c-ready')] }),
      contestWith({ contestId: 'c-needs-ml', speculations: [spreadSpec('c-needs-ml')] }),
      contestWith({ contestId: 'c-unverified', status: 'unverified', speculations: [] }),
    ];
    return run(adapterFor(games, contests, { 'c-ready': oddsSnapshot('c-ready') }));
  }

  it('JSON envelope is { schemaVersion: 1, candidates: CandidatesReport } and never surfaces externalIds', async () => {
    const report = await mixedReport();
    const { sink, text } = collect();
    renderCandidatesReportJson(report, sink);
    const parsed = JSON.parse(text()) as { schemaVersion: number; candidates: CandidatesReport };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.candidates.generatedAt).toBe(new Date(T0_ISO).toISOString());
    expect(parsed.candidates.config).toEqual({
      sports: ['mlb'],
      hours: 24,
      contestsHours: 24, // == hours while within the contests API's 168h max
      maxTrackedContests: 5,
      requireReferenceOdds: true,
      contestAllowListSize: 0,
    });
    expect(text()).not.toContain('externalIds');
  });

  it('summary arithmetic is consistent with items', async () => {
    const report = await mixedReport();
    const count = (kind: CandidateItem['kind']): number => report.items.filter((i) => i.kind === kind).length;
    expect(report.summary.quoteReady).toBe(count('quote_ready'));
    expect(report.summary.needsMoneylineSpeculation).toBe(count('needs_moneyline_speculation'));
    expect(report.summary.needsVerification).toBe(count('needs_verification'));
    expect(report.summary.gamesAvailableToCreate).toBe(count('setup'));
    expect(report.summary.needsContest).toBe(report.summary.gamesAvailableToCreate);
    const skippedTotal = Object.values(report.summary.skipped).reduce((a: number, n) => a + (n ?? 0), 0);
    expect(skippedTotal).toBe(count('skipped'));
    expect(report.items).toHaveLength(6);
  });

  it('items sort by kind priority, then matchTime ascending', async () => {
    const report = await mixedReport();
    expect(report.items.map((i) => i.kind)).toEqual([
      'quote_ready',
      'needs_moneyline_speculation',
      'needs_verification',
      'setup',
      'setup',
      'skipped',
    ]);
    const setups = report.items.filter((i) => i.kind === 'setup');
    expect(setups.map((i) => i.gameId)).toEqual(['g-setup-early', 'g-setup-late']);
  });

  it('an empty window is a valid answer: zero items, zero summary, exit 0', async () => {
    const report = await run(adapterFor([], []));
    expect(report.items).toEqual([]);
    expect(report.summary).toEqual({
      gamesAvailableToCreate: 0,
      quoteReady: 0,
      needsContest: 0,
      needsMoneylineSpeculation: 0,
      needsVerification: 0,
      skipped: {},
    });
    expect(candidatesExitCode(report)).toBe(0);
  });

  it('text render shows the matchup, the summary line, and the skip reason', async () => {
    const report = await mixedReport();
    const { sink, text } = collect();
    renderCandidatesReportText(report, sink);
    const o = text();
    expect(o).toContain('Miami Marlins @ Pittsburgh Pirates');
    expect(o).toMatch(/Quote-ready: 1/);
    expect(o).toMatch(/Setup \(creatable games\): 2/);
    expect(o).toContain('skipped: no-odds');
    expect(o).not.toContain('externalIds');
  });

  it('text render says an empty board is a valid state', async () => {
    const report = await run(adapterFor([], []));
    const { sink, text } = collect();
    renderCandidatesReportText(report, sink);
    expect(text()).toMatch(/valid state/);
  });
});

// ── 6. flags, allow-list annotation, adapter options ─────────────────────────

describe('resolveSports / resolveHours', () => {
  it('defaults to the config sports; validates and lowercases a --sport flag; rejects unknown values', () => {
    expect(resolveSports(undefined, cfg())).toEqual(['mlb']);
    expect(resolveSports('mlb', cfg())).toEqual(['mlb']);
    expect(resolveSports('NHL', cfg())).toEqual(['nhl']);
    expect(() => resolveSports('cricket', cfg())).toThrow(/--sport must be one of/);
  });

  it('defaults to maxStartsWithinHours; bounds --hours to integer 1-720', () => {
    expect(resolveHours(undefined, cfg())).toBe(24);
    expect(resolveHours('48', cfg())).toBe(48);
    expect(resolveHours('1', cfg())).toBe(1);
    expect(resolveHours('720', cfg())).toBe(720);
    expect(() => resolveHours('0', cfg())).toThrow(/--hours must be an integer between 1 and 720/);
    expect(() => resolveHours('721', cfg())).toThrow(/--hours/);
    expect(() => resolveHours('1.5', cfg())).toThrow(/--hours/);
    expect(() => resolveHours('abc', cfg())).toThrow(/--hours/);
  });

  it('rejects a config maxStartsWithinHours outside the games-window bounds (pointing at --hours)', () => {
    const config = cfg({ marketSelection: { maxStartsWithinHours: 1000 } });
    expect(() => resolveHours(undefined, config)).toThrow(/pass --hours/);
  });
});

describe('runCandidates — allow-list annotation', () => {
  it('annotates contest-backed items iff the allow-list is non-empty; never hides anything', async () => {
    const config = cfg({ marketSelection: { contestAllowList: ['c-ready'] } });
    const report = await run(
      adapterFor(
        [
          gameWith({ gameId: 'g-1', contestCreated: true, contestId: 'c-ready' }),
          gameWith({ gameId: 'g-2', contestCreated: true, contestId: 'c-other' }),
          gameWith({ gameId: 'g-3' }), // setup — no contest, never annotated
        ],
        [
          contestWith({ contestId: 'c-ready', speculations: [moneylineSpec('c-ready')] }),
          contestWith({ contestId: 'c-other', speculations: [moneylineSpec('c-other')] }),
        ],
        { 'c-ready': oddsSnapshot('c-ready'), 'c-other': oddsSnapshot('c-other') },
      ),
      config,
    );
    const byContest = new Map(report.items.map((i) => [i.contestId, i]));
    expect(byContest.get('c-ready')?.inContestAllowList).toBe(true);
    expect(byContest.get('c-other')?.inContestAllowList).toBe(false);
    const setup = report.items.find((i) => i.kind === 'setup');
    expect(setup).toBeDefined();
    expect(setup && 'inContestAllowList' in setup).toBe(false);
    expect(report.items).toHaveLength(3); // off-allow-list items are annotated, not hidden
    expect(report.config.contestAllowListSize).toBe(1);
  });

  it('omits the annotation entirely when the allow-list is empty', async () => {
    const report = await run(
      adapterFor([gameWith({ contestCreated: true, contestId: 'contest-1' })], [contestWith()], {
        'contest-1': oddsSnapshot('contest-1'),
      }),
    );
    const item = report.items[0];
    expect(item).toBeDefined();
    expect(item && 'inContestAllowList' in item).toBe(false);
  });
});

describe('runCandidates — adapter options + pagination', () => {
  it('passes availableOnly: false, the hours window, and the single configured sport to games.list', async () => {
    const captured: GamesListOptions[] = [];
    const adapter = fakeAdapter({
      games: { list: (options?: GamesListOptions) => { captured.push(options ?? {}); return Promise.resolve([]); } },
      contests: { list: () => Promise.resolve([]) },
    });
    await run(adapter, cfg(), { hours: 36 });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ availableOnly: false, hours: 36, sport: 'mlb', offset: 0 });
  });

  it('omits the sport param (and filters client-side) when several sports are configured', async () => {
    const captured: GamesListOptions[] = [];
    const adapter = fakeAdapter({
      games: {
        list: (options?: GamesListOptions) => {
          captured.push(options ?? {});
          return Promise.resolve([gameWith({ gameId: 'g-mlb', sport: 'mlb' }), gameWith({ gameId: 'g-nhl', sport: 'nhl' })]);
        },
      },
      contests: { list: () => Promise.resolve([]) },
    });
    const config = cfg({ marketSelection: { sports: ['mlb', 'nba'] } });
    const report = await run(adapter, config, { sports: config.marketSelection.sports });
    expect(captured[0]?.sport).toBeUndefined();
    expect(report.items.map((i) => i.gameId)).toEqual(['g-mlb']); // the nhl game is outside the selected sports
  });

  it('caps the contests leg at 168h while the games leg gets the full --hours window (the two APIs have asymmetric maxima)', async () => {
    const gamesOpts: GamesListOptions[] = [];
    const contestsOpts: ContestsListOptions[] = [];
    const adapter = fakeAdapter({
      games: { list: (options?: GamesListOptions) => { gamesOpts.push(options ?? {}); return Promise.resolve([]); } },
      contests: { list: (options?: ContestsListOptions) => { contestsOpts.push(options ?? {}); return Promise.resolve([]); } },
    });
    const report = await run(adapter, cfg(), { hours: 720 });
    expect(gamesOpts[0]?.hours).toBe(720);
    expect(contestsOpts[0]?.hours).toBe(168); // above it the contests API 400s — one leg must not kill the preflight
    expect(report.config.hours).toBe(720);
    expect(report.config.contestsHours).toBe(168);
    expect(candidatesExitCode(report)).toBe(0);
  });

  it('paginates games until a short page; flags truncated when the page bound is hit (never a silent partial answer)', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => gameWith({ gameId: `g-${i}` }));
    const offsets: Array<number | undefined> = [];
    const adapter = fakeAdapter({
      games: { list: (options?: GamesListOptions) => { offsets.push(options?.offset); return Promise.resolve(fullPage); } },
      contests: { list: () => Promise.resolve([]) },
    });
    const report = await run(adapter);
    expect(offsets).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]);
    expect(report.truncated).toBe(true);
    expect(report.items).toHaveLength(200); // duplicate rows across pages dedup by gameId
    expect(candidatesExitCode(report)).toBe(0);
  });
});
