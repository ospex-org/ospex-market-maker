import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { inverseOddsTick } from '../pricing/index.js';
import {
  createLiveOspexAdapter,
  createOspexAdapter,
  type Commitment,
  type ContestView,
  type Hex,
  type MoneylineOdds,
  type OddsSnapshotView,
  type OddsSubscribeHandlersView,
  type OddsUpdateView,
  type OspexAdapter,
  type PositionStatus,
  type Signer,
  type SpeculationView,
  type SubmitCommitmentArgs,
  type SubmitCommitmentResult,
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

function makeRunner(opts: { config?: Config; adapter?: OspexAdapter; runId?: string; ignoreMissingState?: boolean; maxTicks?: number; deps?: Partial<RunnerDeps>; makerAddress?: Hex } = {}): Runner {
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
    vi.spyOn(adapter, 'getSpeculation').mockRejectedValue(new Error('makeRunner: getSpeculation not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises the reconcile'));
  }
  // Default the maker address to the fake signer's address for any live-mode test that
  // doesn't override it — keeps the live-execution tests (which all use the same fake
  // signer via `liveSpiedAdapter`) from each having to plumb the same constant.
  const makerAddress = opts.makerAddress ?? (adapter.isLive() ? (DEFAULT_FAKE_MAKER_ADDRESS as Hex) : undefined);
  const full: RunnerOptions = {
    config,
    adapter,
    stateStore: StateStore.at(config.state.dir),
    runId: opts.runId ?? RUN_ID,
    deps: { ...noopDeps, ...opts.deps },
  };
  if (opts.ignoreMissingState !== undefined) full.ignoreMissingState = opts.ignoreMissingState;
  if (opts.maxTicks !== undefined) full.maxTicks = opts.maxTicks;
  if (makerAddress !== undefined) full.makerAddress = makerAddress;
  return new Runner(full);
}

/** The fake signer's address used across the live-mode tests (`liveSpiedAdapter` → `fakeSigner` → this). Re-exported as `SIGNER_ADDRESS` inside the `live execution` describe for symmetry with earlier test additions. */
const DEFAULT_FAKE_MAKER_ADDRESS = '0x9999999999999999999999999999999999999999';

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
/** A `getSpeculation` view for a moneyline speculation — `open` defaults to true (the realistic case the per-market reconcile expects); `orderbook` defaults to `[]` (the detail endpoint always populates it — pass entries to exercise the competitiveness check, or `{ ...speculationView(id) }` without an `orderbook` override for the degraded case). */
function speculationView(speculationId: string, open = true, orderbook: Commitment[] = []): SpeculationView {
  return { speculationId, contestId: 'contest', marketType: 'moneyline', lineTicks: null, line: null, open, orderbook };
}
/** An orderbook entry (the SDK `Commitment` shape — every maker's, not just ours) — only `positionType` (0 = away/Upper, 1 = home/Lower) and `oddsTick` matter for the competitiveness check; everything else is filler. */
function orderbookEntry(overrides: Partial<Commitment> = {}): Commitment {
  return {
    commitmentHash: '0xob',
    maker: '0xothermaker',
    contestId: 'A',
    scorer: '0xscorer',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '100000',
    filledRiskAmount: '0',
    remainingRiskAmount: '100000',
    nonce: '1',
    expiry: '2099-01-01T00:00:00Z',
    speculationKey: 'sk-A',
    signature: '0xsig',
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
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
 * `subscribeOdds` / `getSpeculation` spied: `listContests` calls `listContests()`
 * each time; `getContest(id)` defaults to echoing a fresh `contestView` with
 * `referenceGameId` filled in; `getOddsSnapshot(id)` / `subscribeOdds` /
 * `getSpeculation(id)` default to a `-110 / -110` snapshot, a no-op channel, and an
 * open speculation (override via `odds`).
 */
function spiedAdapter(
  config: Config,
  listContests: () => Promise<ContestView[]>,
  getContest?: (id: string) => Promise<ContestView>,
  odds?: {
    snapshot?: (contestId: string) => Promise<OddsSnapshotView>;
    subscribe?: (args: SubscribeOddsArgs, handlers: OddsSubscribeHandlersView) => Promise<Subscription>;
    getSpeculation?: (speculationId: string) => Promise<SpeculationView>;
  },
): OspexAdapter {
  const adapter = createOspexAdapter(config);
  vi.spyOn(adapter, 'listContests').mockImplementation(listContests);
  vi.spyOn(adapter, 'getContest').mockImplementation(getContest ?? ((id) => Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` }))));
  vi.spyOn(adapter, 'getOddsSnapshot').mockImplementation(odds?.snapshot ?? ((contestId) => Promise.resolve(oddsSnapshotView(contestId))));
  vi.spyOn(adapter, 'subscribeOdds').mockImplementation(odds?.subscribe ?? (() => Promise.resolve(noopSubscription())));
  vi.spyOn(adapter, 'getSpeculation').mockImplementation(odds?.getSpeculation ?? ((speculationId) => Promise.resolve(speculationView(speculationId))));
  return adapter;
}

/** A minimal `Signer` — deterministic address, dummy signatures (the live adapter never inspects them in these tests; the write methods are spied). */
function fakeSigner(): Signer {
  return {
    getAddress: () => Promise.resolve('0x9999999999999999999999999999999999999999' as Hex),
    signTypedData: () => Promise.resolve('0xsig' as Hex),
    signTransaction: () => Promise.resolve('0xtx' as Hex),
  };
}

/** A successful `submitCommitment` stub that hands back `0xlive<n>` hashes in call order. */
function submitRecorder(): { fn: (args: SubmitCommitmentArgs) => Promise<SubmitCommitmentResult>; calls: SubmitCommitmentArgs[] } {
  const calls: SubmitCommitmentArgs[] = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args);
      return Promise.resolve({ hash: `0xlive${calls.length}` as Hex, commitment: {} as unknown as Commitment });
    },
  };
}

/**
 * A *signed* adapter (`createLiveOspexAdapter`, so `isLive()` is true) with the same
 * reads spied as {@link spiedAdapter}, plus the live writes: `submitCommitment`
 * defaults to rejecting (a test that triggers a submit must stub it via `writes`),
 * `cancelCommitmentOffchain` defaults to a no-op success, `listOpenCommitments`
 * defaults to `[]` and `getCommitment` defaults to rejecting (a test that exercises
 * fill detection overrides both via `reads`) — every adapter method is spied so a
 * live-mode test never makes a real network call.
 */
function liveSpiedAdapter(
  config: Config,
  listContests: () => Promise<ContestView[]>,
  writes?: {
    submitCommitment?: (args: SubmitCommitmentArgs) => Promise<SubmitCommitmentResult>;
    cancelCommitmentOffchain?: (hash: Hex) => Promise<void>;
  },
  getContest?: (id: string) => Promise<ContestView>,
  odds?: {
    snapshot?: (contestId: string) => Promise<OddsSnapshotView>;
    subscribe?: (args: SubscribeOddsArgs, handlers: OddsSubscribeHandlersView) => Promise<Subscription>;
    getSpeculation?: (speculationId: string) => Promise<SpeculationView>;
  },
  reads?: {
    listOpenCommitments?: (maker: string, limit: number) => Promise<Commitment[]>;
    getCommitment?: (hash: Hex) => Promise<Commitment>;
    getPositionStatus?: (owner: string) => Promise<PositionStatus>;
  },
): OspexAdapter {
  const adapter = createLiveOspexAdapter(config, fakeSigner());
  vi.spyOn(adapter, 'listContests').mockImplementation(listContests);
  vi.spyOn(adapter, 'getContest').mockImplementation(getContest ?? ((id) => Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` }))));
  vi.spyOn(adapter, 'getOddsSnapshot').mockImplementation(odds?.snapshot ?? ((contestId) => Promise.resolve(oddsSnapshotView(contestId))));
  vi.spyOn(adapter, 'subscribeOdds').mockImplementation(odds?.subscribe ?? (() => Promise.resolve(noopSubscription())));
  vi.spyOn(adapter, 'getSpeculation').mockImplementation(odds?.getSpeculation ?? ((speculationId) => Promise.resolve(speculationView(speculationId))));
  vi.spyOn(adapter, 'submitCommitment').mockImplementation(writes?.submitCommitment ?? (() => Promise.reject(new Error('liveSpiedAdapter: submitCommitment not stubbed — pass `writes.submitCommitment`'))));
  vi.spyOn(adapter, 'cancelCommitmentOffchain').mockImplementation(writes?.cancelCommitmentOffchain ?? (() => Promise.resolve()));
  vi.spyOn(adapter, 'listOpenCommitments').mockImplementation(reads?.listOpenCommitments ?? (() => Promise.resolve([])));
  vi.spyOn(adapter, 'getCommitment').mockImplementation(reads?.getCommitment ?? (() => Promise.reject(new Error('liveSpiedAdapter: getCommitment not stubbed — pass `reads.getCommitment`'))));
  vi.spyOn(adapter, 'getPositionStatus').mockImplementation(reads?.getPositionStatus ?? (() => Promise.resolve(EMPTY_POSITION_STATUS)));
  return adapter;
}

/** Empty `PositionStatus` — `liveSpiedAdapter`'s default `getPositionStatus` return so the position poll is a no-op unless a test overrides it. */
const EMPTY_POSITION_STATUS: PositionStatus = {
  active: [], pendingSettle: [], claimable: [],
  totals: { activeCount: 0, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
};

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

// ── prune of old terminal commitment records ─────────────────────────────────

describe('Runner — prune terminal commitments', () => {
  // Default orders.expirySeconds is 120, so the retention window is max(3600, 1200) = 3600s before `now`.
  const cutoff = T0 - 3600;

  it('drops terminal records (expired / filled / authoritativelyInvalidated) older than the retention window', async () => {
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        'old-expired': commitmentRecord({ hash: 'old-expired', lifecycle: 'expired', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 1 }),
        'old-filled': commitmentRecord({ hash: 'old-filled', lifecycle: 'filled', riskAmountWei6: '300000', filledRiskWei6: '300000', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 50 }),
        'old-invalidated': commitmentRecord({ hash: 'old-invalidated', lifecycle: 'authoritativelyInvalidated', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 999 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1 }).run();

    expect(Object.keys(StateStore.at(stateDir).load().state.commitments)).toEqual([]);
  });

  it('keeps recent terminal records, and all non-terminal records regardless of age', async () => {
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        // Terminal but within the retention window — kept.
        'recent-expired': commitmentRecord({ hash: 'recent-expired', lifecycle: 'expired', expiryUnixSec: T0 - 200, postedAtUnixSec: T0 - 300, updatedAtUnixSec: T0 - 100 }),
        // Non-terminal, ancient updatedAt, not past expiry — never pruned (softCancelled stays matchable on chain → the risk engine must keep counting it).
        'old-soft': commitmentRecord({ hash: 'old-soft', lifecycle: 'softCancelled', expiryUnixSec: T0 + 5000, postedAtUnixSec: T0 - 999_999, updatedAtUnixSec: T0 - 999_999 }),
        'old-visible': commitmentRecord({ hash: 'old-visible', lifecycle: 'visibleOpen', makerSide: 'home', expiryUnixSec: T0 + 5000, postedAtUnixSec: T0 - 999_999, updatedAtUnixSec: T0 - 999_999 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1 }).run();

    expect(Object.keys(StateStore.at(stateDir).load().state.commitments).sort()).toEqual(['old-soft', 'old-visible', 'recent-expired']);
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
      dirty: false, // seeded dirty, but the same tick's per-market reconcile picked it up and cleared the flag
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

    // after the seed: subscribed, the feed responded (so lastOddsAt is set) but the response had no moneyline row, so no usable odds yet; not dirty (it had none before either).
    expect(runner.trackedMarketView('A')).toMatchObject({ subscribed: true, lastMoneylineOdds: null, lastOddsAt: T0, dirty: false });

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

// ── per-market reconcile (DESIGN §3 step 3, §8, §9) ──────────────────────────

describe('Runner — per-market reconcile', () => {
  it('a tracked market with reference odds gets a two-sided quote — a quote-intent, would-submit per side, synthetic visibleOpen records', async () => {
    StateStore.at(stateDir).flush(emptyMakerState()); // clean state → no boot hold
    const config = cfg(); // economics-mode pricing, conservative defaults
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    const events = readEvents();
    const submits = events.filter((e) => e.kind === 'would-submit');
    expect(submits.map((e) => e.takerSide).sort()).toEqual(['away', 'home']); // a quote per taker-offer side
    expect(submits.map((e) => e.makerSide).sort()).toEqual(['away', 'home']); // ...which on chain are maker-on-home (away offer) + maker-on-away (home offer)
    for (const e of submits) {
      expect(e).toMatchObject({ contestId: 'A', speculationId: 'spec-A', sport: 'mlb', riskAmountWei6: '250000', expiryUnixSec: T0 + 120 });
      // The conversion happened at the boundary: makerSide is the opposite of takerSide; makerOddsTick is inverseOddsTick of takerOddsTick; positionType matches makerSide (away → 0, home → 1).
      expect(e.makerSide).toBe(e.takerSide === 'away' ? 'home' : 'away');
      expect(e.makerOddsTick).toBe(inverseOddsTick(e.takerOddsTick as number));
      expect(e.positionType).toBe(e.makerSide === 'away' ? 0 : 1);
      expect(typeof e.takerImpliedProb).toBe('number');
    }
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: 'A', speculationId: 'spec-A', canQuote: true });

    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
    // Each synthetic record carries the *protocol* commitment params it would post — and matches its would-submit event.
    for (const r of records) {
      expect(r.lifecycle).toBe('visibleOpen');
      expect(r.speculationId).toBe('spec-A');
      expect(r.contestId).toBe('A');
      expect(r.sport).toBe('mlb');
      expect(r.riskAmountWei6).toBe('250000');
      expect(r.filledRiskWei6).toBe('0');
      expect(r.expiryUnixSec).toBe(T0 + 120);
      expect(r.postedAtUnixSec).toBe(T0);
      expect(r.scorer).toBe(adapter.addresses().scorers.moneyline);
      expect(r.oddsTick).toBeGreaterThanOrEqual(101);
      expect(r.oddsTick).toBeLessThanOrEqual(10100);
      const matchingSubmit = submits.find((e) => e.makerSide === r.makerSide);
      expect(matchingSubmit?.makerOddsTick).toBe(r.oddsTick);
    }
    expect(runner.trackedMarketView('A')).toMatchObject({ dirty: false, lastReconciledAt: T0 }); // the reconcile consumed the dirty flag
  });

  it('match-time expiry mode: a synthetic quote expires at the contest match time, not now + expirySeconds', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ orders: { expiryMode: 'match-time', expirySeconds: 120 } });
    const matchTimeSec = Math.floor(Date.parse(FUTURE_ISO) / 1000);
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    for (const r of records) expect(r.expiryUnixSec).toBe(matchTimeSec);
  });

  it('a stale incumbent gets replaced (would-replace; the old record → softCancelled; a fresh synthetic record); a missing side gets submitted', async () => {
    const stale = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, riskAmountWei6: '250000', expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': stale } });
    const config = cfg(); // default staleAfterSeconds 90 → posted 200s ago is stale
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    // `0xstaleAway` is `makerSide: 'away'` → a quote on the *home offer*; its replacement is the home offer's quote (also maker-on-away). The other (away) offer has no incumbent → fresh submit (a maker-on-home commitment).
    expect(events.find((e) => e.kind === 'would-replace')).toMatchObject({ replacedCommitmentHash: '0xstaleAway', takerSide: 'home', makerSide: 'away', reason: 'stale', speculationId: 'spec-A' });
    expect(events.find((e) => e.kind === 'would-submit')).toMatchObject({ takerSide: 'away', makerSide: 'home', speculationId: 'spec-A' });

    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('softCancelled'); // pulled, but still counted (matchable on chain)
    const records = Object.values(reloaded);
    expect(records).toHaveLength(3); // the old (softCancelled) + the away replacement + the home submit
    expect(records.filter((r) => r.lifecycle === 'visibleOpen').map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('a market the risk engine refuses gets a quote-intent with canQuote: false; its standing quotes are soft-cancelled (would-soft-cancel side-not-quoted)', async () => {
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    const onA = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xother': onOther, '0xaWay': onA } });
    const config = cfg({ risk: { maxOpenCommitments: 2 } }); // the open-commitment count is already 2 → market A is refused (count cap)
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: 'A', canQuote: false });
    expect(events.find((e) => e.kind === 'would-soft-cancel')).toMatchObject({ commitmentHash: '0xaWay', takerSide: 'home', makerSide: 'away', reason: 'side-not-quoted' }); // makerSide:'away' → a quote on the home offer
    expect(events.some((e) => e.kind === 'would-submit' || e.kind === 'would-replace')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-competitiveness' || e.kind === 'competitiveness-unavailable')).toBe(false); // a refused quote has nothing to assess
    expect(StateStore.at(stateDir).load().state.commitments['0xaWay']?.lifecycle).toBe('softCancelled');
  });

  it('when the open-commitment count budget runs out mid-plan a side is deferred — a cap-hit candidate, only the affordable side submitted', async () => {
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xother': onOther } });
    const config = cfg({ risk: { maxOpenCommitments: 2 } }); // count 1 < 2 → A allowed, but room for only 1 more new commitment → one side of the two-sided quote is deferred
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(1);
    const capHit = events.filter((e) => e.kind === 'candidate' && e.skipReason === 'cap-hit');
    expect(capHit).toHaveLength(1);
    expect(capHit[0]).toMatchObject({ contestId: 'A' });
    expect(['away', 'home']).toContain(capHit[0]?.takerSide);
    expect(events.filter((e) => e.kind === 'quote-competitiveness')).toHaveLength(2); // both sides' would-be prices are assessed — including the cap-deferred one
  });

  it('a quoted market emits a quote-competitiveness event per side — book depth, best taker-perspective tick, vs the reference, at/inside the book', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // The MM's offer ticks for a -110 / -110 reference land near 200 (a roughly even line, well inside [101, 10100]).
    // An *away offer* on chain is a maker-on-home (positionType 1) commitment, so it competes with the book's positionType-1
    // commitments; a *home offer* is a maker-on-away (positionType 0) commitment. The taker-perspective tick of a competing
    // commitment is inverseOddsTick(c.oddsTick), and a higher one is better for the taker — so `bestBookTakerTick` is the *max*
    // of those over the same-positionType commitments, and the MM's offer is at/inside iff its takerOddsTick is at least that high.
    //   Away offer (vs positionType-1): one competitor at maker tick 10100 → taker tick inverseOddsTick(10100) = 101 → the MM's
    //     ~200 is well ahead → at/inside; bookDepthOnSide 1, bestBookTakerTick 101.
    //   Home offer (vs positionType-0): two competitors at maker ticks 101 & 102 → taker ticks 10100 & 5100 → the MM's ~200 is
    //     far behind → not at/inside; bookDepthOnSide 2, bestBookTakerTick 10100.
    //   The non-live entry, and the null-positionType / null-tick (and out-of-range) ones, are skipped.
    const book: Commitment[] = [
      orderbookEntry({ commitmentHash: '0xob-pt0-1', positionType: 0, oddsTick: 101 }),
      orderbookEntry({ commitmentHash: '0xob-pt0-2', positionType: 0, oddsTick: 102 }),
      orderbookEntry({ commitmentHash: '0xob-pt1', positionType: 1, oddsTick: 10100 }),
      orderbookEntry({ commitmentHash: '0xob-dead', positionType: 0, oddsTick: 200, isLive: false }), // not matchable
      orderbookEntry({ commitmentHash: '0xob-np', positionType: null, oddsTick: 5000 }), // legacy: no position type
      orderbookEntry({ commitmentHash: '0xob-nt', positionType: 0, oddsTick: null }), // legacy: no tick
      orderbookEntry({ commitmentHash: '0xob-oor', positionType: 0, oddsTick: 100 }), // out of [101, 10100] — can't be a valid commitment; skipped
    ];
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (specId) => Promise.resolve({ ...speculationView(specId), orderbook: book }),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const comps = readEvents().filter((e) => e.kind === 'quote-competitiveness');
    expect(comps.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    const away = comps.find((e) => e.takerSide === 'away');
    const home = comps.find((e) => e.takerSide === 'home');
    expect(away).toMatchObject({ contestId: 'A', speculationId: 'spec-A', takerSide: 'away', makerSide: 'home', positionType: 1, bookDepthOnSide: 1, bestBookTakerTick: 101, atOrInsideBook: true });
    expect(home).toMatchObject({ contestId: 'A', speculationId: 'spec-A', takerSide: 'home', makerSide: 'away', positionType: 0, bookDepthOnSide: 2, bestBookTakerTick: 10100, atOrInsideBook: false });
    // The rest of the payload is present and well-formed.
    for (const c of comps) {
      expect(typeof c.takerOddsTick).toBe('number');
      expect((c.takerOddsTick as number) >= 101 && (c.takerOddsTick as number) <= 10100).toBe(true);
      expect(typeof c.takerImpliedProb).toBe('number');
      expect(typeof c.makerOddsTick).toBe('number');
      expect(typeof c.referenceTakerTick).toBe('number');
      expect(typeof c.referenceImpliedProb).toBe('number');
      expect(c.vsReferenceTicks).toBe((c.takerOddsTick as number) - (c.referenceTakerTick as number));
    }
  });

  it('a quoted market whose getSpeculation response carries no orderbook emits competitiveness-unavailable (but the quote itself still goes through)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // A SpeculationView without `orderbook` — getSpeculation normally always populates it, so this is the degraded read path.
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (specId): Promise<SpeculationView> => Promise.resolve({ speculationId: specId, contestId: 'A', marketType: 'moneyline', lineTicks: null, line: null, open: true }),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'competitiveness-unavailable')).toMatchObject({ contestId: 'A', speculationId: 'spec-A' });
    expect(events.some((e) => e.kind === 'quote-competitiveness')).toBe(false);
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // competitiveness is an observational extra, not a gate
  });

  it('a market starting within one expiry window is gated — a start-too-soon candidate, no quote', async () => {
    const config = cfg(); // expirySeconds 120
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // 60s past the test clock — past discovery's "started" gate, inside the reconcile's start-too-soon gate
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A', matchTime: SOON_ISO })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // tracked at discovery
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'start-too-soon')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a tracked market with no usable reference odds is gated — a no-reference-odds candidate, no quote', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { snapshot: () => Promise.reject(new Error('no odds')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a tracked market whose speculation has closed is gated — a no-open-speculation candidate, no quote', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { getSpeculation: (specId) => Promise.resolve(speculationView(specId, false)) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-open-speculation')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a market whose reference odds have gone stale is gated — a stale-reference candidate', async () => {
    let t = T0;
    const config = cfg({ orders: { staleAfterSeconds: 1, staleReferenceAfterSeconds: 1 } });
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    // tick 1: seed odds (lastOddsAt = T0) + quote. sleep → clock advances 2s. tick 2 (now = T0+2): the odds are now 2s old > staleReferenceAfterSeconds(1) → stale-reference.
    await makeRunner({ config, adapter, maxTicks: 2, deps: { now: () => t, sleep: () => { t += 2; return Promise.resolve(); } } }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'stale-reference')).toBe(true);
  });

  it('a getSpeculation failure during the reconcile is logged (error, phase reconcile) and the market is skipped this pass', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { getSpeculation: () => Promise.reject(new Error('spec read failed')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().find((e) => e.kind === 'error' && e.phase === 'reconcile')).toMatchObject({ contestId: 'A', detail: 'spec read failed' });
    expect(readEvents().some((e) => e.kind === 'would-submit')).toBe(false);
  });

  it('the per-market reconcile is skipped while the boot-time state-loss hold is active (DESIGN §12) — discovery + odds still run', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8'); // prior telemetry, no state file → state loss → hold
    const config = cfg(); // fixed-seconds expiry; the fixed clock never reaches the deadline
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => T0 } });
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // discovery runs while held
    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // odds subscription runs while held
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false); // but no quoting
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // not flushed while held
    expect(runner.trackedMarketView('A')?.dirty).toBe(true); // dirty stays armed — the reconcile never consumed it
  });

  it('an onChange between ticks re-arms a market that already has a fresh quote — it is reconciled again the next tick', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    // tick 1: track + seed + quote A (dirty consumed). sleep → an onChange re-arms A. tick 2: A is reconciled again (no discovery this tick).
    await makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('GAME-A')?.onChange(oddsUpdate('GAME-A', -110, -110)); return Promise.resolve(); } },
    }).run();
    expect(readEvents().filter((e) => e.kind === 'quote-intent' && e.contestId === 'A')).toHaveLength(2);
  });

  // ── unquoteable-market quote pulls (review-PR14) ───────────────────────────

  it('a market with visible quotes that loses its reference odds has them pulled (would-soft-cancel) — not left visible', async () => {
    const away = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 200, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    const home = commitmentRecord({ hash: '0xaHome', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 200, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xaWay': away, '0xaHome': home } });
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { snapshot: (contestId) => Promise.resolve(oddsSnapshotView(contestId, null)) }); // no moneyline row → no usable reference odds
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls.map((e) => e.commitmentHash).sort()).toEqual(['0xaHome', '0xaWay']);
    expect(pulls.every((e) => e.reason === 'side-not-quoted')).toBe(true);
    expect(events.some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    expect(events.some((e) => e.kind === 'would-submit')).toBe(false);
    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect([reloaded['0xaWay']?.lifecycle, reloaded['0xaHome']?.lifecycle]).toEqual(['softCancelled', 'softCancelled']);
  });

  it('a market whose odds channel errors has its visible quotes pulled the next tick (would-soft-cancel) — a degraded channel must not keep stale quotes visible', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    // tick 1: track + seed + quote A (2 synthetic visibleOpen records). sleep → the channel errors. tick 2: A is unquoteable (channel down) → its visible quotes are pulled.
    await makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('GAME-A')?.onError?.(new Error('channel boom')); return Promise.resolve(); } },
    }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // tick 1
    expect(events.some((e) => e.kind === 'degraded' && e.reason === 'channel-error')).toBe(true);
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls).toHaveLength(2); // tick 2 pulled both
    expect(pulls.every((e) => e.contestId === 'A' && e.reason === 'side-not-quoted')).toBe(true);
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.lifecycle === 'softCancelled')).toBe(true);
  });

  it('a transient getSpeculation failure after an odds move does not clear the dirty flag — the market retries the next tick', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    let getSpecCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (speculationId) => { getSpecCalls += 1; return getSpecCalls === 1 ? Promise.reject(new Error('spec read transient')) : Promise.resolve(speculationView(speculationId, true)); },
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(getSpecCalls).toBe(2); // tick 1 failed, tick 2 retried
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'reconcile')).toMatchObject({ contestId: 'A', detail: 'spec read transient' });
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // A got quoted on tick 2 — it would NOT if tick 1's failure had cleared dirty (the fixed clock means the staleAfterSeconds throttle never elapses)
  });

  it('polling mode: a market quoted on valid odds whose next snapshot has no moneyline row has its visible quotes pulled (would-soft-cancel) — a vanished reference must not leave quotes up', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ odds: { subscribe: false }, discovery: { everyNTicks: 10 } }); // discovery runs once (tick 1)
    let snapshotCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, snapshotCalls === 1 ? moneylineOdds(-150, 130) : null)); }, // tick 1: valid moneyline → quote; tick 2: the moneyline row is gone
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // tick 1 quoted both sides
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls).toHaveLength(2); // tick 2 pulled both — the reference odds vanished
    expect(pulls.every((e) => e.contestId === 'A' && e.reason === 'side-not-quoted')).toBe(true);
    expect(events.some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.lifecycle === 'softCancelled')).toBe(true);
  });
});

// ── live execution — the per-market reconcile's write path (Phase 3) ─────────
//
// `config.mode.dryRun: false` + a signed adapter (`createLiveOspexAdapter`). Same
// reconcile machinery as dry-run — only the leaves differ: submits go through
// `submitCommitment` (and the recorded hash is the real one), pulls go through
// `cancelCommitmentOffchain`, and the event kinds are `submit` / `replace` /
// `soft-cancel` rather than the `would-` counterparts. The `run --live` *on-switch*
// (CLI / config) lands in a later slice — until then live mode is reachable only
// here, with a fake adapter; a live-mode config with a read-only adapter is rejected.

describe('Runner — live execution', () => {
  it('a live-mode config with a read-only adapter is rejected at construction', () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    expect(() => makeRunner({ config: cfg({ mode: { dryRun: false } }) })).toThrow(/live mode .* requires a signed adapter/);
  });

  it('posts both sides via submitCommitment, records the real hashes, emits `submit` (not `would-submit`) — the protocol tuple flows through `toProtocolQuote`', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: submit.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.some((e) => e.kind === 'would-submit')).toBe(false);
    const submitEvents = events.filter((e) => e.kind === 'submit');
    expect(submitEvents.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    expect(submitEvents.map((e) => e.commitmentHash).sort()).toEqual(['0xlive1', '0xlive2']);

    expect(submit.calls).toHaveLength(2);
    for (const a of submit.calls) {
      expect(a).toMatchObject({ contestId: 1234n, scorer: adapter.addresses().scorers.moneyline, lineTicks: 0, expiry: BigInt(T0 + 120) });
      expect(typeof a.riskAmount).toBe('bigint');
      expect([0, 1]).toContain(a.positionType);
      expect(a.oddsTick).toBeGreaterThanOrEqual(101);
      expect(a.oddsTick).toBeLessThanOrEqual(10100);
    }
    // The conversion happened at the boundary, end to end: each submit event's makerSide is the opposite of its takerSide,
    // makerOddsTick is inverseOddsTick(takerOddsTick), positionType matches makerSide — and the submitCommitment call for that
    // positionType used that same oddsTick.
    for (const e of submitEvents) {
      expect(e.makerSide).toBe(e.takerSide === 'away' ? 'home' : 'away');
      expect(e.makerOddsTick).toBe(inverseOddsTick(e.takerOddsTick as number));
      expect(e.positionType).toBe(e.makerSide === 'away' ? 0 : 1);
      const call = submit.calls.find((a) => a.positionType === e.positionType);
      expect(call?.oddsTick).toBe(e.makerOddsTick);
      expect(call?.riskAmount).toBe(BigInt(e.riskAmountWei6 as string));
    }

    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.hash).sort()).toEqual(['0xlive1', '0xlive2']);
    expect(records.every((r) => r.lifecycle === 'visibleOpen' && r.expiryUnixSec === T0 + 120)).toBe(true);
    expect(records.map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('match-time expiry: submitCommitment is called with expiry = the contest match time', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false }, orders: { expiryMode: 'match-time', expirySeconds: 120 } });
    const matchTimeSec = Math.floor(Date.parse(FUTURE_ISO) / 1000);
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: submit.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(submit.calls).toHaveLength(2);
    for (const a of submit.calls) expect(a.expiry).toBe(BigInt(matchTimeSec));
  });

  it('a submitCommitment failure is logged (error, phase submit) and the tick continues — no record, no submit event', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: () => Promise.reject(new Error('relay 503')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run(); // must not throw

    const events = readEvents();
    const submitErrors = events.filter((e) => e.kind === 'error' && e.phase === 'submit');
    expect(submitErrors).toHaveLength(2); // both sides attempted, both failed
    expect(submitErrors[0]).toMatchObject({ contestId: '1234', detail: 'relay 503' });
    expect(submitErrors.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    expect(events.some((e) => e.kind === 'submit')).toBe(false);
    expect(Object.keys(StateStore.at(stateDir).load().state.commitments)).toHaveLength(0);
  });

  it('a stale incumbent is replaced — off-chain cancel then submit, a `replace` event, the old record softCancelled', async () => {
    const stale = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, riskAmountWei6: '250000', expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': stale } });
    const config = cfg({ mode: { dryRun: false } }); // default staleAfterSeconds 90 → posted 200s ago is stale
    const submit = submitRecorder();
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(cancels).toContain('0xstaleAway'); // the incumbent was pulled off the API book
    expect(events.find((e) => e.kind === 'replace')).toMatchObject({ replacedCommitmentHash: '0xstaleAway', takerSide: 'home', makerSide: 'away', reason: 'stale', speculationId: 'spec-1234' });
    expect(events.find((e) => e.kind === 'submit')).toMatchObject({ takerSide: 'away', makerSide: 'home', speculationId: 'spec-1234' });
    expect(events.some((e) => e.kind === 'would-replace' || e.kind === 'would-submit')).toBe(false);

    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('softCancelled');
    expect(submit.calls).toHaveLength(2); // the away offer's fresh submit + the home offer's replacement
    expect(Object.values(reloaded).filter((r) => r.lifecycle === 'visibleOpen').map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('an unquoteable-gate pull does a real off-chain cancel — a `soft-cancel` event, the record softCancelled', async () => {
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // 60s ahead — past discovery's "started" gate, inside the reconcile's start-too-soon gate (60 <= 120)
    const visible = commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xvisible': visible } });
    const config = cfg({ mode: { dryRun: false } });
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), {
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'start-too-soon')).toMatchObject({ contestId: '1234' });
    expect(cancels).toEqual(['0xvisible']);
    expect(events.find((e) => e.kind === 'soft-cancel')).toMatchObject({ commitmentHash: '0xvisible', reason: 'side-not-quoted' });
    expect(events.some((e) => e.kind === 'would-soft-cancel' || e.kind === 'submit')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xvisible']?.lifecycle).toBe('softCancelled');
  });

  it('a side the reconcile decides not to quote has its standing commitment pulled via a real off-chain cancel (`soft-cancel` side-not-quoted)', async () => {
    const onA = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xaWay': onA, '0xother': onOther } });
    const config = cfg({ mode: { dryRun: false }, risk: { maxOpenCommitments: 2 } }); // count is already 2 → market 1234 is refused (count cap)
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: '1234', canQuote: false });
    expect(cancels).toEqual(['0xaWay']);
    expect(events.find((e) => e.kind === 'soft-cancel')).toMatchObject({ commitmentHash: '0xaWay', reason: 'side-not-quoted' });
    expect(events.some((e) => e.kind === 'submit' || e.kind === 'replace')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xaWay']?.lifecycle).toBe('softCancelled');
  });

  it('an off-chain-cancel failure is logged (error, phase cancel) and the record stays visibleOpen for retry', async () => {
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString();
    const visible = commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xvisible': visible } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), {
      cancelCommitmentOffchain: () => Promise.reject(new Error('relay 500')),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'cancel')).toMatchObject({ contestId: '1234', commitmentHash: '0xvisible', detail: 'relay 500' });
    expect(events.some((e) => e.kind === 'soft-cancel' || e.kind === 'would-soft-cancel')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xvisible']?.lifecycle).toBe('visibleOpen'); // still up — next pass retries the pull
  });

  it('a dry-run state directory reused for live is rejected at construction (a `dry:` synthetic commitment)', () => {
    const synthetic = commitmentRecord({ hash: 'dry:prior-run:1', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { 'dry:prior-run:1': synthetic } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]));
    expect(() => makeRunner({ config, adapter, maxTicks: 1 })).toThrow(/dry-run synthetic commitment/); // never gets near cancelCommitmentOffchain — the runner can't even construct
  });

  it('a prior live run\'s state (real `0x` commitment hashes) constructs fine — the dry-run guard does not false-positive', () => {
    const live = commitmentRecord({ hash: '0xrealhash', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealhash': live } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]));
    expect(() => makeRunner({ config, adapter, maxTicks: 1 })).not.toThrow();
  });

  it('a failed replace-cancel does not post the replacement and re-reconciles next tick (retries the cancel) — DESIGN §9', async () => {
    // Two stale incumbents (one per maker side) on spec-1234 → both are toReplace. With the cancel always failing,
    // the replacements must NOT go up (a second visible quote on a side the MM can't pull would violate DESIGN §9 and
    // wouldn't self-heal — needsReconcile would see a fresh two-sided quote and skip). Instead the market stays dirty
    // and tick 2 retries the cancels.
    const staleAway = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    const staleHome = commitmentRecord({ hash: '0xstaleHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', oddsTick: 250, expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': staleAway, '0xstaleHome': staleHome } });
    const config = cfg({ mode: { dryRun: false }, risk: { maxOpenCommitments: 8 } }); // count 2 < 8 → market 1234 allowed; default staleAfterSeconds 90 → posted 200s ago is stale
    const submit = submitRecorder();
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.reject(new Error('relay 500')); },
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    const events = readEvents();
    expect([...cancels].sort()).toEqual(['0xstaleAway', '0xstaleAway', '0xstaleHome', '0xstaleHome']); // both attempted on tick 1, both retried on tick 2 — a failed pull doesn't stop the next tick
    expect(submit.calls).toHaveLength(0); // no replacement posted (and no fresh submit — both sides are occupied by their stale incumbents)
    expect(events.filter((e) => e.kind === 'error' && e.phase === 'cancel')).toHaveLength(4);
    expect(events.some((e) => e.kind === 'replace' || e.kind === 'submit')).toBe(false);
    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('visibleOpen'); // both incumbents still up — unchanged (only the original, never two)
    expect(reloaded['0xstaleHome']?.lifecycle).toBe('visibleOpen');
    expect(runner.trackedMarketView('1234')?.dirty).toBe(true); // never cleared — the reconcile kept returning transient-failure
  });
});

// ── fill detection (live only, Phase 3 (c-i)) ────────────────────────────────
//
// `tick()`'s new step (between odds refresh and reconcile, live mode only) —
// diffs `listOpenCommitments(maker)` against the local `visibleOpen`/`partiallyFilled`
// set, classifies disappeared hashes via `getCommitment(hash).status`, bumps
// still-listed commitments whose `filledRiskAmount` advanced, dirties the affected
// market so the same tick's reconcile re-prices the imbalance, and emits `fill` /
// `expire` events. `liveSpiedAdapter` defaults `listOpenCommitments → []` and
// `getCommitment → reject`, so every fill-detection test stubs `reads` explicitly.
// `DEFAULT_FAKE_MAKER_ADDRESS` (module scope, `0x9999…`) is the fake signer's
// address — used as the `Commitment.maker` value when an API row is the MM's own.

describe('Runner — fill detection', () => {
  it('dry-run mode: the fill-detection step is skipped — `listOpenCommitments` is never called, even with local records', async () => {
    const record = commitmentRecord({ hash: '0xtracked', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'getContest').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'getOddsSnapshot').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'subscribeOdds').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'getSpeculation').mockRejectedValue(new Error('unused'));
    const listOpenSpy = vi.spyOn(adapter, 'listOpenCommitments').mockResolvedValue([]);
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(listOpenSpy).not.toHaveBeenCalled();
  });

  it('a fully-filled commitment is reclassified `filled`, a position is created, the market is dirtied, and a `fill` event fires (partial:false)', async () => {
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => h === '0xrealAway' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('filled');
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']).toMatchObject({
      speculationId: 'spec-1234', contestId: '1234', side: 'home',
      riskAmountWei6: '250000',
      // (oddsTick − 100) / 100 × risk = (200 − 100) / 100 × 250000 = 250000
      counterpartyRiskWei6: '250000',
      status: 'active',
    });

    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      commitmentHash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234',
      takerSide: 'away', makerSide: 'home', positionType: 1, makerOddsTick: 200,
      newFillWei6: '250000', filledRiskWei6: '250000', partial: false,
    });
  });

  it('a partial-fill bump (still listed; `filledRiskAmount` advanced) → record reclassified `partiallyFilled`, position extended by the delta, market dirtied, `fill` event (partial:true)', async () => {
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '100000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    // Still listed; filledRiskAmount advanced 100000 → 300000 (delta 200000).
    const apiPartial: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '300000', remainingRiskAmount: '200000', status: 'partially_filled', isLive: true });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([apiPartial]) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('partiallyFilled');
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('300000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('200000'); // delta only — counts the *new* fill
    expect(reloaded.positions['spec-1234:home']?.counterpartyRiskWei6).toBe('200000'); // 200000 × (200 − 100) / 100

    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ partial: true, newFillWei6: '200000', filledRiskWei6: '300000' });
  });

  it('a disappeared commitment whose API status is `expired` → record reclassified `expired`, an `expire` event (no `fill`)', async () => {
    const record = commitmentRecord({ hash: '0xexpiry', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xexpiry': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiExpired: Commitment = orderbookEntry({ commitmentHash: '0xexpiry', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiExpired) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xexpiry']?.lifecycle).toBe('expired');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'expire' && e.commitmentHash === '0xexpiry')).toBeDefined();
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a disappeared commitment whose API status is `cancelled` → record reclassified `authoritativelyInvalidated`, no event', async () => {
    const record = commitmentRecord({ hash: '0xcancelled', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xcancelled': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiCancelled: Commitment = orderbookEntry({ commitmentHash: '0xcancelled', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiCancelled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xcancelled']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(readEvents().some((e) => e.kind === 'fill' || e.kind === 'expire')).toBe(false);
  });

  it('a `listOpenCommitments` failure is logged (`error` phase fill-detection) and the tick continues; state unchanged', async () => {
    const record = commitmentRecord({ hash: '0xtracked', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.reject(new Error('API 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run(); // must not throw

    expect(StateStore.at(stateDir).load().state.commitments['0xtracked']?.lifecycle).toBe('visibleOpen');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection')).toMatchObject({ detail: 'API 503' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a per-hash `getCommitment` failure is logged (phase fill-detection-lookup) and other disappeared hashes are still processed', async () => {
    const recordA = commitmentRecord({ hash: '0xfilled', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    const recordB = commitmentRecord({ hash: '0xbroken', speculationId: 'spec-B', contestId: 'B', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xfilled': recordA, '0xbroken': recordB } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xfilled', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: 'A', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => h === '0xfilled' ? Promise.resolve(apiFilled) : Promise.reject(new Error('lookup failed')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xfilled']?.lifecycle).toBe('filled'); // processed normally
    expect(reloaded.commitments['0xbroken']?.lifecycle).toBe('visibleOpen'); // unchanged — the lookup error skipped it
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection-lookup')).toMatchObject({ commitmentHash: '0xbroken', detail: 'lookup failed' });
    expect(events.filter((e) => e.kind === 'fill')).toHaveLength(1);
  });

  it('the `assessCompetitiveness` orderbook excludes the MM\'s own commitments (`c.maker === this.makerAddress` filter)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // One self-maker entry (positionType 0, the away-offer book) + one other-maker entry (positionType 1, the home-offer book).
    // The home offer (taker side `home`, the MM as maker on `away`, positionType 0) competes with positionType-0 commitments —
    // the only one (`0xself`) is filtered out → bookDepthOnSide 0. The away offer (taker side `away`, MM as maker on `home`,
    // positionType 1) competes with positionType-1 — only `0xother` (not self) → bookDepthOnSide 1.
    const book: Commitment[] = [
      orderbookEntry({ commitmentHash: '0xself', maker: DEFAULT_FAKE_MAKER_ADDRESS, positionType: 0, oddsTick: 101 }),
      orderbookEntry({ commitmentHash: '0xother', maker: '0xothermaker', positionType: 1, oddsTick: 200 }),
    ];
    const adapter = spiedAdapter(
      config, () => Promise.resolve([contestView({ contestId: 'A' })]),
      undefined, { getSpeculation: (id) => Promise.resolve(speculationView(id, true, book)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1, makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex }).run();

    const comps = readEvents().filter((e) => e.kind === 'quote-competitiveness');
    expect(comps).toHaveLength(2);
    const homeOffer = comps.find((e) => e.takerSide === 'home');
    expect(homeOffer).toMatchObject({ bookDepthOnSide: 0, bestBookTakerTick: null, atOrInsideBook: true });
    const awayOffer = comps.find((e) => e.takerSide === 'away');
    expect(awayOffer).toMatchObject({ bookDepthOnSide: 1, bestBookTakerTick: 200 });
  });
});

// ── review-PR23 fixes (fill-detection blockers + position-status poll) ───────

describe('Runner — fill detection — past-local-expiry classification (review-PR23 B1, B2)', () => {
  it('a visibleOpen record past local expiry whose API status is `filled` is reclassified BEFORE ageOut terminalizes it (the fill is not lost)', async () => {
    // The bug Hermes reproduced: tick order is detectFills → reconcile → ageOut, and the previous
    // detectFills skipped records past local expiry; ageOut then marked them `expired` without
    // calling getCommitment. A fill that landed right before expiry was permanently missed.
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 10 /* past-expiry */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiFilled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('filled'); // detectFills classified it BEFORE ageOut got a chance to call it `expired`
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xrealAway')).toMatchObject({ partial: false, newFillWei6: '250000', source: 'commitment-diff' });
    expect(events.some((e) => e.kind === 'expire' && e.commitmentHash === '0xrealAway')).toBe(false); // ageOut's `expire` did not fire
  });

  it('a disappeared `expired` API status with prior unobserved filledRiskAmount applies the partial fill BEFORE terminalizing — the position records the matched portion', async () => {
    const record = commitmentRecord({ hash: '0xpartialThenExpired', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '0', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialThenExpired': record } });
    const config = cfg({ mode: { dryRun: false } });
    // Partial fill of 100000 wei6 landed before the commitment expired — neither was seen locally before now.
    const apiExpired: Commitment = orderbookEntry({ commitmentHash: '0xpartialThenExpired', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiExpired) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpartialThenExpired']?.lifecycle).toBe('expired'); // terminalized
    expect(reloaded.commitments['0xpartialThenExpired']?.filledRiskWei6).toBe('100000'); // the partial fill was applied
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('100000'); // position records the matched portion
    expect(reloaded.positions['spec-1234:home']?.counterpartyRiskWei6).toBe('100000'); // 100000 × (200 − 100) / 100
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xpartialThenExpired')).toMatchObject({ partial: false, newFillWei6: '100000' });
    expect(events.find((e) => e.kind === 'expire' && e.commitmentHash === '0xpartialThenExpired')).toBeDefined(); // expire still fires (the terminal status was 'expired')
  });

  it('a disappeared `cancelled` API status with prior unobserved filledRiskAmount applies the partial fill BEFORE terminalizing', async () => {
    const record = commitmentRecord({ hash: '0xpartialThenCancelled', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '0', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialThenCancelled': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiCancelled: Commitment = orderbookEntry({ commitmentHash: '0xpartialThenCancelled', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiCancelled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpartialThenCancelled']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xpartialThenCancelled']?.filledRiskWei6).toBe('100000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('100000');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xpartialThenCancelled')).toMatchObject({ partial: false, newFillWei6: '100000' });
    expect(events.some((e) => e.kind === 'expire' && e.commitmentHash === '0xpartialThenCancelled')).toBe(false); // cancelled is not expired
  });
});

describe('Runner — fail-closed on lost fill visibility (review-PR23 B3)', () => {
  it('live mode: a `listOpenCommitments` failure SKIPS reconcile (no live writes) and ageOut (no terminalization on unverified fill state); the market stays dirty for next-tick retry', async () => {
    // Without the fail-closed fix, the runner would proceed to reconcile on a tracked-quoteable market
    // with no fill visibility, submitting a fresh commitment based on stale exposure state.
    // (Numeric contestId so live `submitCommitment`'s `BigInt(contestId)` doesn't throw — the absence
    // of a submit must prove the *fail-closed gate* worked, not a downstream BigInt error.)
    const record = commitmentRecord({ hash: '0xtracked', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { listOpenCommitments: () => Promise.reject(new Error('API 503')) },
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection')).toMatchObject({ detail: 'API 503' });
    expect(submit.calls).toHaveLength(0); // reconcile was skipped — no submit despite the tracked market being quoteable
    expect(events.some((e) => e.kind === 'submit' || e.kind === 'replace' || e.kind === 'soft-cancel')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-intent')).toBe(false); // reconcileMarkets never ran
    expect(StateStore.at(stateDir).load().state.commitments['0xtracked']?.lifecycle).toBe('visibleOpen'); // ageOut didn't run either
  });

  it('dry-run mode: a `listOpenCommitments` failure is irrelevant — detectFills doesn\'t run in dry-run, so the reconcile proceeds normally', async () => {
    // Defensive: confirm the fail-closed gate is live-only — dry-run should never be blocked by it.
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg(); // dryRun:true
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    // listOpenCommitments isn't even spied on the read-only adapter (no live writes path); the
    // dry-run tick never calls it. We assert by exercising a full would-submit and seeing the loop run.
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // reconcile ran in dry-run despite the absence of fill detection
  });
});

describe('Runner — position-status poll (review-PR23 B4)', () => {
  /** A bare `getPositionStatus` response with one `active` position for `(speculationId, makerSide)`. */
  function withActivePosition(speculationId: string, positionType: 0 | 1, riskUSDC: number, profitUSDC: number, positionId = '0xpos'): PositionStatus {
    return {
      active: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC }],
      pendingSettle: [], claimable: [],
      totals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
  }

  it('a position the API reports but local state is missing → `MakerPositionRecord` created + `fill` event (source: position-poll). Context (contestId, sport, teams) is copied from the matching local commitment.', async () => {
    // Setup: a soft-cancelled commitment (a quote we pulled off-chain). A taker matched it via the
    // stale signed payload before expiry → the chain has a position the commitment-list diff can't see.
    // The position poll catches it.
    const softCancelled = commitmentRecord({ hash: '0xstaleSignedPayload', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleSignedPayload': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-1234', 1 /* home */, 0.25, 0.25)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']).toMatchObject({
      speculationId: 'spec-1234', contestId: '1234', side: 'home',
      sport: softCancelled.sport, awayTeam: softCancelled.awayTeam, homeTeam: softCancelled.homeTeam, // copied from the source commitment
      riskAmountWei6: '250000', counterpartyRiskWei6: '250000', // 0.25 USDC × 1e6
      status: 'active',
    });
    expect(reloaded.commitments['0xstaleSignedPayload']?.lifecycle).toBe('softCancelled'); // commitment record untouched (we can't attribute the fill to a specific commitment, and the soft-cancelled risk + position will reconcile naturally once ageOut terminalizes)
    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'position-poll', speculationId: 'spec-1234', makerSide: 'home', positionType: 1, newFillWei6: '250000', cumulativeRiskWei6: '250000' });
  });

  it('a `getPositionStatus` response that matches local state is a no-op (idempotent — no `fill` event, no position update on subsequent ticks)', async () => {
    // The position record already reflects the on-chain risk; subsequent polls shouldn't emit phantom fills.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xc': commitmentRecord({ hash: '0xc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, lifecycle: 'filled', riskAmountWei6: '250000', filledRiskWei6: '250000' }),
      },
      positions: {
        'spec-1234:home': { speculationId: 'spec-1234', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 5 },
      },
    });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-1234', 1, 0.25, 0.25)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'fill')).toBe(false); // already caught up
    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // unchanged
  });

  it('a position with no matching local commitment is skipped + logged (don\'t create an incomplete `MakerPositionRecord`)', async () => {
    // Setup: the API reports a position on a speculation we have NO commitment for (state pre-seeded
    // externally, or a long-running discrepancy). Refuse to create the record — the risk engine's
    // per-team/sport caps need real metadata.
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-orphan', 0, 0.5, 0.5)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-orphan:away']).toBeUndefined();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ class: 'PositionWithoutCommitment' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a `getPositionStatus` failure with NO softCancelled records is logged (`error` phase position-poll) and the tick continues normally — reconcile still runs (detectFills already covered the maker\'s posted commitments)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]), // numeric so live `submitCommitment` can BigInt() it
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getPositionStatus: () => Promise.reject(new Error('positions API 500')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ detail: 'positions API 500' });
    expect(submit.calls.length).toBeGreaterThan(0); // reconcile still ran — no softCancelled records, so the position poll failure isn't a lost-fill risk
  });

  it('a `getPositionStatus` failure WITH a non-terminal softCancelled record fails closed — reconcile + ageOut skipped, markets stay dirty for next-tick retry (review-PR23 round 2)', async () => {
    // Setup: a softCancelled commitment whose stale signed payload could have been
    // matched on chain at any point before expiry. The commitment-list diff (detectFills)
    // can't see soft-cancelled commitments — the position poll is the ONLY way to learn
    // about that match. If the poll fails, we MUST NOT (a) submit replacement quotes on
    // exposure we may already have, or (b) terminalize the record via ageOut while a
    // taker may have just filled it. Even a past-local-expiry record stays softCancelled
    // this tick — next tick retries the poll.
    const stale = commitmentRecord({ hash: '0xstaleSignedPayload', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'softCancelled', expiryUnixSec: T0 - 1, postedAtUnixSec: T0 - 100, updatedAtUnixSec: T0 - 100 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleSignedPayload': stale } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getPositionStatus: () => Promise.reject(new Error('positions API 500')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ detail: 'positions API 500' });
    expect(submit.calls).toHaveLength(0); // reconcile skipped — no replacement quotes posted on unverified exposure
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xstaleSignedPayload']?.lifecycle).toBe('softCancelled'); // ageOut skipped — record NOT terminalized to `expired`
    expect(events.some((e) => e.kind === 'expire')).toBe(false);
  });
});

// ── position-status transitions (Phase 3 c-ii) ───────────────────────────────

describe('Runner — position-status transitions (Phase 3 c-ii)', () => {
  /** A `PositionStatus` with one `pendingSettle` position. The estimated payout = risk + profit (Ospex pays back the winner's risk + the counterparty's risk; this test only needs a self-consistent shape). */
  function withPendingSettlePosition(
    speculationId: string,
    positionType: 0 | 1,
    riskUSDC: number,
    profitUSDC: number,
    result: 'won' | 'push' | 'void' = 'won',
    predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push' = 'home',
    positionId = '0xpos',
  ): PositionStatus {
    const payout = riskUSDC + profitUSDC;
    const payoutWei6 = BigInt(Math.round(payout * 1_000_000)).toString();
    return {
      active: [],
      pendingSettle: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC, result, predictedWinSide, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6 }],
      claimable: [],
      totals: { activeCount: 0, pendingSettleCount: 1, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: payout, pendingSettlePayoutWei6: payoutWei6 },
    };
  }

  /** A `PositionStatus` with one `claimable` position. */
  function withClaimablePosition(
    speculationId: string,
    positionType: 0 | 1,
    riskUSDC: number,
    profitUSDC: number,
    result: 'won' | 'push' | 'void' = 'won',
    positionId = '0xpos',
  ): PositionStatus {
    const payout = riskUSDC + profitUSDC;
    const payoutWei6 = BigInt(Math.round(payout * 1_000_000)).toString();
    return {
      active: [],
      pendingSettle: [],
      claimable: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC, result, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6 }],
      totals: { activeCount: 0, pendingSettleCount: 0, claimableCount: 1, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6, pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
  }

  /** Pre-seed an `active` `MakerPositionRecord` on `(speculationId, side='home')` matched to a `filled` commitment. The poll's transition path needs both to assemble context. */
  function seedActiveHomePosition(speculationId: string, contestId: string, riskWei6 = '250000', counterpartyRiskWei6 = '250000'): MakerState {
    const commitment = commitmentRecord({ hash: '0xc', speculationId, contestId, makerSide: 'home', oddsTick: 200, lifecycle: 'filled', riskAmountWei6: riskWei6, filledRiskWei6: riskWei6 });
    return {
      ...emptyMakerState(),
      commitments: { '0xc': commitment },
      positions: {
        [`${speculationId}:home`]: { speculationId, contestId, sport: commitment.sport, awayTeam: commitment.awayTeam, homeTeam: commitment.homeTeam, side: 'home', riskAmountWei6: riskWei6, counterpartyRiskWei6, status: 'active', updatedAtUnixSec: T0 - 60 },
      },
    };
  }

  it('a position the API has moved from active → pendingSettle is updated locally + emits `position-transition` (fromStatus active, toStatus pendingSettle, result, predictedWinSide)', async () => {
    StateStore.at(stateDir).flush(seedActiveHomePosition('spec-1234', '1234'));
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // risk unchanged — pure status transition

    const events = readEvents();
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', positionType: 1, fromStatus: 'active', toStatus: 'pendingSettle', result: 'won', predictedWinSide: 'home' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false); // status-only transition, no fill
  });

  it('a position the API has moved from pendingSettle → claimable is updated locally + emits `position-transition` (result carried, predictedWinSide omitted — claimable view does not surface it)', async () => {
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'pendingSettle';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable');
    const transitions = readEvents().filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'pendingSettle', toStatus: 'claimable', result: 'won' });
    expect(transitions[0]?.predictedWinSide).toBeUndefined(); // not on the claimable view
  });

  it('a position the API has moved from active → claimable (skipping pendingSettle within the poll window) is a single forward transition (one `position-transition` event)', async () => {
    StateStore.at(stateDir).flush(seedActiveHomePosition('spec-1234', '1234'));
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable');
    const transitions = readEvents().filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'claimable' });
  });

  it('a position first observed directly in claimable (no prior local record) is CREATED with status claimable + emits `fill` (the position\'s birth — NO `position-transition` event)', async () => {
    // The soft-cancelled-stale-payload path can land a position straight into pendingSettle/claimable
    // (the indexer is slow OR the speculation scored fast). We must record the maker's risk and at
    // the right status — but it's a birth, not a transition, so no transition event.
    const softCancelled = commitmentRecord({ hash: '0xstale', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, lifecycle: 'softCancelled', riskAmountWei6: '250000' });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstale': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']).toMatchObject({ status: 'claimable', riskAmountWei6: '250000', counterpartyRiskWei6: '250000' });
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'fill')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
  });

  it('a backwards transition (API reports claimable as active) is refused + logged (`error` class BackwardsPositionTransition); the local status stays claimable', async () => {
    // This shouldn't happen in production — a settled speculation can't un-settle, claimed positions
    // disappear from the API. It signals state corruption (manual edit, version skew). The runner
    // refuses to revert the local record to a less-advanced status.
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'claimable';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const apiActive: PositionStatus = {
      active: [{ positionId: '0xpos', speculationId: 'spec-1234', positionType: 1, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: 0.25, profitAmountUSDC: 0.25 }],
      pendingSettle: [], claimable: [],
      totals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(apiActive) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable'); // unchanged
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ class: 'BackwardsPositionTransition' });
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
  });

  it('a poll that matches local status + risk is a no-op across two ticks (idempotent — no `position-transition`, no `fill`)', async () => {
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'pendingSettle';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('pendingSettle');
    const events = readEvents();
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a poll carrying BOTH a risk delta AND a forward status transition emits both `fill` and `position-transition`', async () => {
    // E.g. the speculation just scored AND the indexer just caught up on a prior fill the maker
    // missed — first poll observes the position with more risk AND in a non-`active` bucket.
    const state = seedActiveHomePosition('spec-1234', '1234', '100000', '100000'); // local: 0.10 USDC
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) }, // API: 0.25 USDC risk, pendingSettle
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // 0.10 + 0.15 delta

    const events = readEvents();
    const fills = events.filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'position-poll', newFillWei6: '150000', cumulativeRiskWei6: '250000' });
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'pendingSettle' });
  });

  it('an existing position whose source commitment was pruned (long-running game) still transitions — context comes from the position record\'s own denormalized fields (Hermes review-PR24)', async () => {
    // The realistic case: maker fills a commitment at T=0; the commitment becomes `filled`;
    // `pruneTerminalCommitments` deletes the filled record after ~1h; the game scores T+hours
    // later and the API moves the position from `active` to `pendingSettle`. Requiring a
    // still-retained source commitment would strand the position in stale `active` status.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      // No commitments — the source commitment was pruned post-fill.
      positions: {
        'spec-1234:home': { speculationId: 'spec-1234', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 7200 },
      },
    });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error' && e.class === 'PositionWithoutCommitment')).toBe(false); // no false alarm
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'pendingSettle', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD' }); // context from the existing record
  });
});
