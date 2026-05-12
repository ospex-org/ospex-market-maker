import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { createOspexAdapter } from '../ospex/index.js';
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

// Quiet, deterministic deps: an immediate sleep, a fixed clock, no kill file, no signal wiring, a swallowed log.
const noopDeps: Partial<RunnerDeps> = {
  now: () => 1_900_000_000,
  sleep: () => Promise.resolve(),
  killFileExists: () => false,
  registerShutdownSignals: () => () => {},
  log: () => {},
};

function makeRunner(opts: { config?: Config; runId?: string; ignoreMissingState?: boolean; maxTicks?: number; deps?: Partial<RunnerDeps> } = {}): Runner {
  const config = opts.config ?? cfg();
  const full: RunnerOptions = {
    config,
    adapter: createOspexAdapter(config),
    stateStore: StateStore.at(config.state.dir),
    runId: opts.runId ?? RUN_ID,
    deps: { ...noopDeps, ...opts.deps },
  };
  if (opts.ignoreMissingState !== undefined) full.ignoreMissingState = opts.ignoreMissingState;
  if (opts.maxTicks !== undefined) full.maxTicks = opts.maxTicks;
  return new Runner(full);
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
    const runner = new Runner({ config, adapter: createOspexAdapter(config), stateStore, runId: RUN_ID, maxTicks: 5, deps: { ...noopDeps } });
    await expect(runner.run()).rejects.toThrow('disk full');
    flushSpy.mockRestore();
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
