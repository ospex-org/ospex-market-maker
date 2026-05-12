import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import {
  createOspexAdapter,
  type ContestView,
  type MoneylineOdds,
  type OddsSnapshotView,
  type OddsSubscribeHandlersView,
  type OddsUpdateView,
  type OspexAdapter,
  type SubscribeOddsArgs,
  type Subscription,
} from '../ospex/index.js';
import { StateStore, emptyMakerState, type MakerCommitmentRecord, type MakerState } from '../state/index.js';
import { Runner, interruptibleSleep, type RunnerDeps, type RunnerOptions } from './index.js';

// ── harness ──────────────────────────────────────────────────────────────────

const RUN_ID = 'test-run-1';

let stateDir: string;
let logDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ospex-mm-runner-state-'));
  logDir = mkdtempSync(join(tmpdir(), 'ospex-mm-runner-log-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    rpcUrl: 'http://localhost:8545',
    telemetry: { logDir },
    state: { dir: stateDir },
    killSwitchFile: join(stateDir, 'KILL'),
    orders: { expirySeconds: 120 },
    ...overrides,
  });
}

function eventLogPath(id = RUN_ID): string {
  return join(logDir, `run-${id}.ndjson`);
}
function readEvents(id = RUN_ID): Array<Record<string, unknown>> {
  if (!existsSync(eventLogPath(id))) return [];
  return readFileSync(eventLogPath(id), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Quiet, deterministic deps: an immediate sleep, a fixed clock, no kill file, no signal wiring, a swallowed log, no discovery jitter (random → 0.5 ⇒ jitter factor 1).
const T0 = 1_900_000_000;
const noopDeps: Partial<RunnerDeps> = {
  now: () => T0,
  sleep: () => Promise.resolve(),
  killFileExists: () => false,
  registerShutdownSignals: () => () => {},
  log: () => {},
  random: () => 0.5,
};

function makeRunner(opts: { config?: Config; adapter?: OspexAdapter; runId?: string; ignoreMissingState?: boolean; maxTicks?: number; deps?: Partial<RunnerDeps> } = {}): Runner {
  const config = opts.config ?? cfg();
  let adapter = opts.adapter;
  if (adapter === undefined) {
    // Tests that don't exercise discovery: stub the API so the discovery cycle finds nothing (no real HTTP).
    // The reference-odds steps are then no-ops (no tracked markets), but stub them too so an accidental track surfaces rather than hitting the network.
    adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'getContest').mockRejectedValue(new Error('makeRunner: getContest not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises discovery'));
    vi.spyOn(adapter, 'getOddsSnapshot').mockRejectedValue(new Error('makeRunner: getOddsSnapshot not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises odds'));
    vi.spyOn(adapter, 'subscribeOdds').mockRejectedValue(new Error('makeRunner: subscribeOdds not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises odds'));
  }
  const full: RunnerOptions = {
    config,
    adapter,
    stateStore: StateStore.at(config.state.dir),
    runId: opts.runId ?? RUN_ID,
    deps: { ...noopDeps, ...opts.deps },
  };
  if (opts.ignoreMissingState !== undefined) full.ignoreMissingState = opts.ignoreMissingState;
  if (opts.maxTicks !== undefined) full.maxTicks = opts.maxTicks;
  return new Runner(full);
}

// ── discovery fixtures ───────────────────────────────────────────────────────

const FUTURE_ISO = '2099-01-01T00:00:00Z'; // far after the test clock (T0 ≈ 2030-03)
const PAST_ISO = '2020-01-01T00:00:00Z';

function contestView(overrides: Partial<ContestView> & { contestId: string }): ContestView {
  return {
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    sport: 'mlb',
    sportId: 0,
    matchTime: FUTURE_ISO,
    status: 'verified',
    referenceGameId: null, // list-endpoint default; `getContest` fills it
    speculations: [{ speculationId: `spec-${overrides.contestId}`, contestId: overrides.contestId, marketType: 'moneyline', lineTicks: null, line: null, open: true }],
    ...overrides, // (carries `contestId`; may override the speculations / referenceGameId / matchTime / sport above)
  };
}

// ── odds fixtures ────────────────────────────────────────────────────────────

function moneylineOdds(awayOddsAmerican: number | null, homeOddsAmerican: number | null): MoneylineOdds {
  return { market: 'moneyline', awayOddsAmerican, homeOddsAmerican, upstreamLastUpdated: '2026-01-01T00:00:00Z', pollCapturedAt: '2026-01-01T00:00:00Z', changedAt: '2026-01-01T00:00:00Z' };
}
/** A one-shot odds snapshot view for a contest — `referenceGameId` echoes `GAME-<contestId>` (matching `spiedAdapter`'s default `getContest`); the moneyline defaults to `-110 / -110`, pass `null` for "no moneyline row yet". */
function oddsSnapshotView(contestId: string, moneyline: MoneylineOdds | null = moneylineOdds(-110, -110)): OddsSnapshotView {
  return { contestId, referenceGameId: `GAME-${contestId}`, odds: { moneyline, spread: null, total: null } };
}
/** A Realtime `onChange` / `onRefresh` payload for a moneyline channel. */
function oddsUpdate(referenceGameId: string, awayOddsAmerican: number | null, homeOddsAmerican: number | null): OddsUpdateView {
  return { referenceGameId, market: 'moneyline', network: 'polygon', line: null, awayOddsAmerican, homeOddsAmerican, upstreamLastUpdated: '2026-02-02T00:00:00Z', pollCapturedAt: '2026-02-02T00:00:00Z', changedAt: '2026-02-02T00:00:00Z' };
}
function noopSubscription(): Subscription {
  return { unsubscribe: () => Promise.resolve() };
}

/**
 * A `subscribeOdds` stub that records each call (the handlers + a per-call
 * `unsubscribe` spy), keyed by `referenceGameId`. By default every call succeeds;
 * `rejectWhen(matcher)` makes matching calls reject (e.g. the first attempt for a
 * given game — simulating the Realtime-credentials fetch failing).
 */
function makeSubscribeRecorder() {
  const handlers = new Map<string, OddsSubscribeHandlersView>();
  const unsubs = new Map<string, ReturnType<typeof vi.fn>>();
  const calls: string[] = []; // referenceGameId per successful subscribe, in order
  const attempts = new Map<string, number>();
  let rejectMatcher: ((referenceGameId: string, attempt: number) => boolean) | null = null;
  return {
    subscribe(args: SubscribeOddsArgs, h: OddsSubscribeHandlersView): Promise<Subscription> {
      const attempt = (attempts.get(args.referenceGameId) ?? 0) + 1;
      attempts.set(args.referenceGameId, attempt);
      if (rejectMatcher !== null && rejectMatcher(args.referenceGameId, attempt)) {
        return Promise.reject(new Error('subscribe failed (test)'));
      }
      const unsubscribe = vi.fn(); // a no-impl spy: `await unsubscribe()` resolves to undefined, which is fine
      handlers.set(args.referenceGameId, h);
      unsubs.set(args.referenceGameId, unsubscribe);
      calls.push(args.referenceGameId);
      return Promise.resolve({ unsubscribe });
    },
    rejectWhen(matcher: (referenceGameId: string, attempt: number) => boolean): void { rejectMatcher = matcher; },
    handlersFor(referenceGameId: string): OddsSubscribeHandlersView | undefined { return handlers.get(referenceGameId); },
    unsubscribeFor(referenceGameId: string): ReturnType<typeof vi.fn> | undefined { return unsubs.get(referenceGameId); },
    successfulCalls(): string[] { return [...calls]; },
    attemptsFor(referenceGameId: string): number { return attempts.get(referenceGameId) ?? 0; },
  };
}

/**
 * An `OspexAdapter` with `listContests` / `getContest` / `getOddsSnapshot` /
 * `subscribeOdds` spied: `listContests` calls `listContests()` each time;
 * `getContest(id)` defaults to echoing a fresh `contestView` with
 * `referenceGameId` filled in; `getOddsSnapshot(id)` and `subscribeOdds` default
 * to a `-110 / -110` snapshot and a no-op channel (override via `odds`).
 */
function spiedAdapter(
  config: Config,
  listContests: () => Promise<ContestView[]>,
  getContest?: (id: string) => Promise<ContestView>,
  odds?: {
    snapshot?: (contestId: string) => Promise<OddsSnapshotView>;
    subscribe?: (args: SubscribeOddsArgs, handlers: OddsSubscribeHandlersView) => Promise<Subscription>;
  },
): OspexAdapter {
  const adapter = createOspexAdapter(config);
  vi.spyOn(adapter, 'listContests').mockImplementation(listContests);
  vi.spyOn(adapter, 'getContest').mockImplementation(getContest ?? ((id) => Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` }))));
  vi.spyOn(adapter, 'getOddsSnapshot').mockImplementation(odds?.snapshot ?? ((contestId) => Promise.resolve(oddsSnapshotView(contestId))));
  vi.spyOn(adapter, 'subscribeOdds').mockImplementation(odds?.subscribe ?? (() => Promise.resolve(noopSubscription())));
  return adapter;
}

function commitmentRecord(overrides: Partial<MakerCommitmentRecord>): MakerCommitmentRecord {
  const NOW = 1_900_000_000;
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

// ── boot path — the state-loss fail-safe (DESIGN §12) ────────────────────────

describe('Runner — boot', () => {
  it('a cleanly-loaded state does not hold quoting', () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const runner = makeRunner();
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/loaded cleanly/);
    expect(runner.isHoldingQuoting()).toBe(false);
  });

  it('no state file + no prior telemetry = genuine first run — no hold', () => {
    const runner = makeRunner(); // stateDir + logDir both empty
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/genuine first run/);
  });

  it('no state file but prior telemetry = state loss — holds quoting until now + expirySeconds (fixed-seconds), and logs it', () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const now = 1_900_000_000;
    const lines: string[] = [];
    const runner = makeRunner({ config: cfg({ orders: { expirySeconds: 90 } }), deps: { now: () => now, log: (l) => lines.push(l) } });
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    expect(runner.bootAssessment.suggestedWaitSeconds).toBe(90);
    expect(runner.isHoldingQuoting()).toBe(true);
    expect(lines.some((l) => /holding quoting for 90s/.test(l))).toBe(true);
  });

  it('a corrupt state file holds quoting', () => {
    writeFileSync(join(stateDir, 'maker-state.json'), '{ this is not json', 'utf8');
    const runner = makeRunner();
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    expect(runner.bootAssessment.reason).toMatch(/blank slate/);
  });

  it('--ignore-missing-state lifts the hold on a corrupt state file', () => {
    writeFileSync(join(stateDir, 'maker-state.json'), '{ broken', 'utf8');
    const runner = makeRunner({ ignoreMissingState: true });
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/ignore-missing-state/);
  });
});

// ── the state-loss hold is durable across restart (DESIGN §12) ───────────────

describe('Runner — state-loss hold durability', () => {
  it('a state-loss hold survives a restart before the deadline — the runner does not persist a clean state while held', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    // First boot: missing state + prior telemetry → hold (fixed-seconds, expirySeconds 120). Fixed clock at T0, so the deadline never elapses during the run.
    const runner1 = makeRunner({ runId: 'first', maxTicks: 3, deps: { now: () => T0 } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run();
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // never flushed — held the whole time

    // Restart before the deadline → state still missing → still detects the loss → still holds.
    const runner2 = makeRunner({ runId: 'second', deps: { now: () => T0 + 60 } });
    expect(runner2.bootAssessment.holdQuoting).toBe(true);
    expect(runner2.isHoldingQuoting()).toBe(true);
  });

  it('a state-loss hold releases once a continuous run survives past the deadline, so a later restart resumes', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    let t = T0;
    // expirySeconds 120; advance 90s per sleep → tick 3 runs at T0 + 180, past the T0 + 120 deadline → the hold has elapsed → flush.
    const runner1 = makeRunner({ runId: 'first', maxTicks: 3, deps: { now: () => t, sleep: () => { t += 90; return Promise.resolve(); } } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run();
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true); // flushed on tick 3, once the deadline had passed

    const runner2 = makeRunner({ runId: 'second', deps: { now: () => t + 10 } });
    expect(runner2.bootAssessment.holdQuoting).toBe(false); // clean (empty) state loaded → no hold
    expect(runner2.bootAssessment.reason).toMatch(/loaded cleanly/);
  });

  it('under match-time expiry, a state-loss hold is indefinite — it does not auto-release after expirySeconds; only --ignore-missing-state lifts it', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    let t = T0;
    const runner1 = makeRunner({ runId: 'first', config: cfg({ orders: { expiryMode: 'match-time', expirySeconds: 120 } }), maxTicks: 3, deps: { now: () => t, sleep: () => { t += 500; return Promise.resolve(); } } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run(); // by tick 3 the clock is at T0 + 1000, way past expirySeconds — but the hold is indefinite
    expect(runner1.isHoldingQuoting()).toBe(true);
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // never flushed

    const runner2 = makeRunner({ runId: 'second', config: cfg({ orders: { expiryMode: 'match-time' } }), deps: { now: () => t } });
    expect(runner2.bootAssessment.holdQuoting).toBe(true); // a restart still detects the loss → still holds

    const runner3 = makeRunner({ runId: 'third', config: cfg({ orders: { expiryMode: 'match-time' } }), ignoreMissingState: true, deps: { now: () => t } });
    expect(runner3.bootAssessment.holdQuoting).toBe(false); // ...and --ignore-missing-state lifts it
    expect(runner3.isHoldingQuoting()).toBe(false);
  });
});

// ── the tick loop ────────────────────────────────────────────────────────────

describe('Runner — tick loop', () => {
  it('runs maxTicks ticks (emitting tick-start each), persists state, and does not emit kill on a normal exit', async () => {
    await makeRunner({ maxTicks: 3 }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start').map((e) => e.tick)).toEqual([1, 2, 3]);
    expect(events.some((e) => e.kind === 'kill')).toBe(false);
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true);
  });

  it('clamps pollIntervalMs to the floor and logs the clamp once', async () => {
    const sleepMsCalls: number[] = [];
    const lines: string[] = [];
    await makeRunner({
      config: cfg({ pollIntervalMs: 5000 }),
      maxTicks: 3,
      deps: { sleep: (ms) => { sleepMsCalls.push(ms); return Promise.resolve(); }, log: (l) => lines.push(l) },
    }).run();
    expect(sleepMsCalls).toEqual([30000, 30000]); // 3 ticks → 2 sleeps (the loop exits after tick 3 before sleeping)
    expect(lines.filter((l) => /clamping to 30000ms/.test(l))).toHaveLength(1);
  });

  it('a state-flush failure propagates (the runner must not keep ticking on an un-persistable state)', async () => {
    const stateStore = StateStore.at(stateDir);
    const flushSpy = vi.spyOn(stateStore, 'flush').mockImplementation(() => {
      throw new Error('disk full');
    });
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([])); // discovery finds nothing — no real HTTP
    const runner = new Runner({ config, adapter, stateStore, runId: RUN_ID, maxTicks: 5, deps: { ...noopDeps } });
    await expect(runner.run()).rejects.toThrow('disk full');
    flushSpy.mockRestore();
  });
});

// ── discovery (DESIGN §10) ───────────────────────────────────────────────────

describe('Runner — discovery', () => {
  it('discovers on tick 1, then every discovery.everyNTicks ticks (no jitter via random → 0.5)', async () => {
    let listCalls = 0;
    const config = cfg({ discovery: { everyNTicks: 3 } });
    const adapter = spiedAdapter(config, () => {
      listCalls += 1;
      return Promise.resolve([contestView({ contestId: 'A' })]);
    });
    const runner = makeRunner({ config, adapter, maxTicks: 8 });
    await runner.run();
    expect(listCalls).toBe(3); // ticks 1, 4, 7 (next at 10 > 8)
    expect(runner.trackedContestIds()).toEqual(['A']);
  });

  it('tracks contests with an open moneyline speculation + a reference-game id; skips the rest with the right candidate reasons', async () => {
    const config = cfg(); // sports: ['mlb'], default caps
    const A = contestView({ contestId: 'A' });
    const B = contestView({ contestId: 'B', speculations: [{ speculationId: 'spec-B', contestId: 'B', marketType: 'spread', lineTicks: -35, line: -3.5, open: true }] }); // no open moneyline spec
    const C = contestView({ contestId: 'C', sport: 'nba' }); // wrong sport — filtered out before any candidate event
    const D = contestView({ contestId: 'D' }); // looks fine in the list, but getContest(D) has no referenceGameId
    const E = contestView({ contestId: 'E', matchTime: PAST_ISO }); // already started
    const adapter = spiedAdapter(config, () => Promise.resolve([A, B, C, D, E]), (id) =>
      Promise.resolve(id === 'D' ? contestView({ contestId: 'D', referenceGameId: null }) : contestView({ contestId: id, referenceGameId: `GAME-${id}` })),
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(runner.trackedContestIds()).toEqual(['A']);
    const candidates = readEvents().filter((e) => e.kind === 'candidate');
    expect(candidates.map((e) => e.contestId).sort()).toEqual(['A', 'B', 'D', 'E']); // no event for C (wrong sport)
    expect(candidates.find((e) => e.contestId === 'A')?.skipReason).toBeUndefined(); // tracked
    expect(candidates.find((e) => e.contestId === 'B')?.skipReason).toBe('no-open-speculation');
    expect(candidates.find((e) => e.contestId === 'D')?.skipReason).toBe('no-reference-odds');
    expect(candidates.find((e) => e.contestId === 'E')?.skipReason).toBe('start-too-soon');
  });

  it('honours marketSelection.maxTrackedContests — tracks the soonest games, the rest get tracking-cap-reached', async () => {
    const config = cfg({ marketSelection: { sports: ['mlb'], maxTrackedContests: 2 } });
    const listed = [
      contestView({ contestId: 'A', matchTime: '2099-01-01T00:00:00Z' }),
      contestView({ contestId: 'B', matchTime: '2099-01-02T00:00:00Z' }),
      contestView({ contestId: 'C', matchTime: '2099-01-03T00:00:00Z' }),
      contestView({ contestId: 'D', matchTime: '2099-01-04T00:00:00Z' }),
      contestView({ contestId: 'E', matchTime: '2099-01-05T00:00:00Z' }),
    ];
    const adapter = spiedAdapter(config, () => Promise.resolve(listed));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A', 'B']); // the two earliest
    const capped = readEvents().filter((e) => e.kind === 'candidate' && e.skipReason === 'tracking-cap-reached');
    expect(capped.map((e) => e.contestId).sort()).toEqual(['C', 'D', 'E']);
  });

  it('untracks a contest that drops out of the candidate set (started / scored / out of window)', async () => {
    let listCount = 0;
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const adapter = spiedAdapter(config, () => {
      listCount += 1;
      return Promise.resolve(listCount === 1 ? [contestView({ contestId: 'A' }), contestView({ contestId: 'B' })] : [contestView({ contestId: 'A' })]);
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // B departed on the 2nd cycle
  });

  it('a listContests failure aborts the cycle (emits an error event, keeps the existing tracked set)', async () => {
    let listCount = 0;
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const adapter = spiedAdapter(config, () => {
      listCount += 1;
      return listCount === 1 ? Promise.resolve([contestView({ contestId: 'A' })]) : Promise.reject(new Error('api down'));
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // unchanged after the failed 2nd cycle
    const err = readEvents().find((e) => e.kind === 'error');
    expect(err).toMatchObject({ phase: 'discovery', detail: 'api down' });
  });

  it('a getContest failure for one candidate skips it (emits an error event), tracks the others', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]), (id) =>
      id === 'B' ? Promise.reject(new Error('boom')) : Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` })),
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']);
    expect(readEvents().find((e) => e.kind === 'error')).toMatchObject({ phase: 'discovery', contestId: 'B', detail: 'boom' });
  });

  it('honours the allow / deny lists (a denied / disallowed contest is filtered out before any candidate event)', async () => {
    const denyConfig = cfg({ marketSelection: { sports: ['mlb'], contestDenyList: ['B'] } });
    const denyAdapter = spiedAdapter(denyConfig, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]));
    const denyRunner = makeRunner({ config: denyConfig, adapter: denyAdapter, maxTicks: 1 });
    await denyRunner.run();
    expect(denyRunner.trackedContestIds()).toEqual(['A']);
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'B')).toBe(false);

    // (fresh logDir/stateDir from beforeEach won't reset mid-test, but a separate runId keeps the event logs apart)
    const allowConfig = cfg({ marketSelection: { sports: ['mlb'], contestAllowList: ['A'] } });
    const allowAdapter = spiedAdapter(allowConfig, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]));
    const allowRunner = makeRunner({ config: allowConfig, adapter: allowAdapter, runId: 'allow-run', maxTicks: 1 });
    await allowRunner.run();
    expect(allowRunner.trackedContestIds()).toEqual(['A']);
    expect(readEvents('allow-run').some((e) => e.kind === 'candidate' && e.contestId === 'B')).toBe(false);
  });

  it('jitters the discovery interval by ±jitterPct (random shifts how often discovery runs)', async () => {
    const config = cfg({ discovery: { everyNTicks: 4, jitterPct: 0.5 } });
    const listed = [contestView({ contestId: 'A' })];

    let shortCalls = 0;
    await makeRunner({ config, adapter: spiedAdapter(config, () => { shortCalls += 1; return Promise.resolve(listed); }), runId: 'short', maxTicks: 6, deps: { random: () => 0 } }).run();
    expect(shortCalls).toBe(3); // factor 0.5 ⇒ interval round(4*0.5)=2 ⇒ ticks 1, 3, 5 (next at 7)

    let longCalls = 0;
    await makeRunner({ config, adapter: spiedAdapter(config, () => { longCalls += 1; return Promise.resolve(listed); }), runId: 'long', maxTicks: 6, deps: { random: () => 1 } }).run();
    expect(longCalls).toBe(1); // factor 1.5 ⇒ interval round(4*1.5)=6 ⇒ tick 1 only (next at 7)
  });
});

// ── kill switch ──────────────────────────────────────────────────────────────

describe('Runner — kill switch', () => {
  it('a KILL file appearing stops the loop and emits kill with reason kill-file', async () => {
    let checks = 0;
    await makeRunner({ maxTicks: 20, deps: { killFileExists: () => { checks += 1; return checks >= 3; } } }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(2);
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ reason: 'kill-file', ticks: 2 });
  });

  it('a SIGTERM / SIGINT stops the loop and emits kill with reason signal', async () => {
    let onSignal: (() => void) | null = null;
    let sleeps = 0;
    await makeRunner({
      maxTicks: 20,
      deps: {
        registerShutdownSignals: (cb) => { onSignal = cb; return () => {}; },
        sleep: () => { sleeps += 1; if (sleeps === 2) onSignal?.(); return Promise.resolve(); },
      },
    }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(2);
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ reason: 'signal', ticks: 2 });
  });
});

// ── age-out (DESIGN §9) ──────────────────────────────────────────────────────

describe('Runner — age-out', () => {
  it('reclassifies expired visibleOpen / softCancelled / partiallyFilled records to expired (with an expire event); leaves future ones alone', async () => {
    const now = 1_900_000_000;
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        expiredOpen: commitmentRecord({ hash: 'expiredOpen', lifecycle: 'visibleOpen', expiryUnixSec: now - 1 }),
        expiredSc: commitmentRecord({ hash: 'expiredSc', lifecycle: 'softCancelled', expiryUnixSec: now - 1, makerSide: 'home' }),
        expiredPartial: commitmentRecord({ hash: 'expiredPartial', lifecycle: 'partiallyFilled', filledRiskWei6: '100000', expiryUnixSec: now - 1 }),
        futureOpen: commitmentRecord({ hash: 'futureOpen', lifecycle: 'visibleOpen', expiryUnixSec: now + 50 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1, deps: { now: () => now } }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments.expiredOpen?.lifecycle).toBe('expired');
    expect(reloaded.commitments.expiredSc?.lifecycle).toBe('expired');
    expect(reloaded.commitments.expiredPartial?.lifecycle).toBe('expired');
    expect(reloaded.commitments.futureOpen?.lifecycle).toBe('visibleOpen');
    expect(reloaded.commitments.expiredOpen?.updatedAtUnixSec).toBe(now);

    const expired = readEvents().filter((e) => e.kind === 'expire');
    expect(expired.map((e) => e.commitmentHash).sort()).toEqual(['expiredOpen', 'expiredPartial', 'expiredSc']);
  });
});

// ── interruptibleSleep ───────────────────────────────────────────────────────

describe('interruptibleSleep', () => {
  it('resolves after the timeout when never aborted', async () => {
    await interruptibleSleep(0, new AbortController().signal); // resolves on the next macrotask — proves it doesn't hang
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await interruptibleSleep(60_000, ac.signal); // a broken impl would hang here for a minute
  });

  it('resolves promptly when the signal aborts before the timeout elapses', async () => {
    const ac = new AbortController();
    const p = interruptibleSleep(60_000, ac.signal);
    ac.abort();
    await p; // resolves via the abort listener, not the (1-minute) timer
  });
});

// ── odds subscriptions / Realtime guardrails (DESIGN §10) ────────────────────

describe('Runner — odds subscriptions', () => {
  it('seeds odds (snapshot-first) then opens a Realtime channel for each newly-tracked market', async () => {
    const config = cfg(); // odds.subscribe defaults true, maxRealtimeChannels 60
    const recorder = makeSubscribeRecorder();
    let snapshotCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, moneylineOdds(-150, 130))); },
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(snapshotCalls).toBe(1); // seeded before subscribing
    expect(recorder.successfulCalls()).toEqual(['GAME-A']);
    expect(runner.trackedMarketView('A')).toMatchObject({
      subscribed: true,
      lastMoneylineOdds: { awayOddsAmerican: -150, homeOddsAmerican: 130 },
      lastOddsAt: T0,
      dirty: true, // a freshly-seeded market is dirty so the per-market reconcile picks it up
    });
  });

  it('honours odds.maxRealtimeChannels — subscribes the soonest games, the rest get a degraded channel-cap event; a freed slot is taken on the next cycle', async () => {
    const config = cfg({ odds: { maxRealtimeChannels: 2 }, discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    const a = contestView({ contestId: 'A', matchTime: '2099-01-01T00:00:00Z' });
    const b = contestView({ contestId: 'B', matchTime: '2099-01-02T00:00:00Z' });
    const c = contestView({ contestId: 'C', matchTime: '2099-01-03T00:00:00Z' });
    let listCount = 0;
    const adapter = spiedAdapter(config, () => { listCount += 1; return Promise.resolve(listCount === 1 ? [a, b, c] : [b, c]); }, undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    // cycle 1: A, B, C tracked; A & B get channels (soonest), C is over the cap → degraded channel-cap.
    // cycle 2: A departs → its channel frees → C is subscribed.
    expect(runner.trackedContestIds()).toEqual(['B', 'C']);
    expect(runner.trackedMarketView('B')?.subscribed).toBe(true);
    expect(runner.trackedMarketView('C')?.subscribed).toBe(true);
    const capEvents = readEvents().filter((e) => e.kind === 'degraded' && e.reason === 'channel-cap');
    expect(capEvents.map((e) => e.contestId)).toEqual(['C']);
    expect(recorder.successfulCalls().filter((id) => id === 'GAME-C')).toHaveLength(1); // C subscribed once, on cycle 2
    expect(recorder.successfulCalls().filter((id) => id === 'GAME-A')).toHaveLength(1); // A subscribed cycle 1, then departed
  });

  it('a channel onChange updates the odds + marks the market dirty; onRefresh updates without marking dirty; a seed with no moneyline row leaves lastMoneylineOdds null', async () => {
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let t = T0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => Promise.resolve(oddsSnapshotView(contestId, null)), // no moneyline row at seed time
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => t } });
    await runner.run();

    // after the seed: subscribed, but no odds yet, not dirty.
    expect(runner.trackedMarketView('A')).toMatchObject({ subscribed: true, lastMoneylineOdds: null, lastOddsAt: null, dirty: false });

    const handlers = recorder.handlersFor('GAME-A');
    expect(handlers).toBeDefined();

    // onRefresh: stores the odds + bumps freshness, but does NOT mark the market dirty.
    t = T0 + 5;
    handlers?.onRefresh?.(oddsUpdate('GAME-A', -120, 100));
    expect(runner.trackedMarketView('A')).toMatchObject({ lastMoneylineOdds: { awayOddsAmerican: -120, homeOddsAmerican: 100 }, lastOddsAt: T0 + 5, dirty: false });

    // onChange: updates the odds, bumps freshness, marks the market dirty.
    t = T0 + 10;
    handlers?.onChange(oddsUpdate('GAME-A', 150, -180));
    expect(runner.trackedMarketView('A')).toMatchObject({ lastMoneylineOdds: { awayOddsAmerican: 150, homeOddsAmerican: -180 }, lastOddsAt: T0 + 10, dirty: true });
  });

  it('a channel onError degrades the market (subscription cleared) + emits a degraded channel-error event; the next discovery cycle re-subscribes it', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('GAME-A')?.onError?.(new Error('channel boom')); return Promise.resolve(); } },
    });
    await runner.run();

    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // re-subscribed on cycle 2
    expect(recorder.successfulCalls()).toEqual(['GAME-A', 'GAME-A']);
    const degraded = readEvents().filter((e) => e.kind === 'degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ contestId: 'A', referenceGameId: 'GAME-A', reason: 'channel-error', detail: 'channel boom' });
  });

  it('a subscribeOdds rejection (e.g. the Realtime-credentials fetch failed) degrades the market with a subscribe-failed event; the next discovery cycle retries', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    recorder.rejectWhen((referenceGameId, attempt) => referenceGameId === 'GAME-A' && attempt === 1);
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // succeeded on the 2nd attempt
    expect(recorder.attemptsFor('GAME-A')).toBe(2);
    expect(recorder.successfulCalls()).toEqual(['GAME-A']);
    const degraded = readEvents().filter((e) => e.kind === 'degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ contestId: 'A', reason: 'subscribe-failed', detail: 'subscribe failed (test)' });
  });

  it('a seed-snapshot failure logs an error but does not block the subscription; odds arrive on the first channel onChange', async () => {
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: () => Promise.reject(new Error('snapshot 503')),
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(runner.trackedMarketView('A')).toMatchObject({ subscribed: true, lastMoneylineOdds: null }); // channel up despite the seed failure
    expect(readEvents().find((e) => e.kind === 'error')).toMatchObject({ phase: 'odds-seed', contestId: 'A', detail: 'snapshot 503' });

    recorder.handlersFor('GAME-A')?.onChange(oddsUpdate('GAME-A', -200, 170));
    expect(runner.trackedMarketView('A')?.lastMoneylineOdds).toEqual({ awayOddsAmerican: -200, homeOddsAmerican: 170 });
  });

  it('a departed market has its odds channel unsubscribed', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let listCount = 0;
    const adapter = spiedAdapter(config, () => { listCount += 1; return Promise.resolve(listCount === 1 ? [contestView({ contestId: 'A' }), contestView({ contestId: 'B' })] : [contestView({ contestId: 'A' })]); }, undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    expect(runner.trackedContestIds()).toEqual(['A']);
    expect(recorder.unsubscribeFor('GAME-B')).toHaveBeenCalledTimes(1);
    expect(recorder.unsubscribeFor('GAME-A')).not.toHaveBeenCalled(); // A is still tracked
    expect(runner.trackedMarketView('A')?.subscribed).toBe(true);
  });

  it('odds.subscribe: false → polling mode: snapshots every tracked market each tick, never opens a Realtime channel', async () => {
    const config = cfg({ odds: { subscribe: false }, discovery: { everyNTicks: 10 } }); // discovery runs once (tick 1)
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, moneylineOdds(-130, 110))); },
      subscribe: () => { subscribeCalls += 1; return Promise.resolve(noopSubscription()); },
    });
    const runner = makeRunner({ config, adapter, maxTicks: 3 });
    await runner.run();

    expect(subscribeCalls).toBe(0); // no Realtime in polling mode
    expect(snapshotCalls).toBe(3); // one snapshot per tick for the one tracked market
    expect(runner.trackedMarketView('A')).toMatchObject({
      subscribed: false,
      lastMoneylineOdds: { awayOddsAmerican: -130, homeOddsAmerican: 110 },
      lastOddsAt: T0,
    });
  });
});
