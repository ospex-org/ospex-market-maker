import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { createOspexAdapter, type Hex, type OspexAdapter } from '../ospex/index.js';
import type { RunnerDeps } from '../runners/index.js';
import { RunRefused, runRun } from './run.js';

// ── harness ──────────────────────────────────────────────────────────────────

let stateDir: string;
let logDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ospex-mm-run-state-'));
  logDir = mkdtempSync(join(tmpdir(), 'ospex-mm-run-log-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    rpcUrl: 'http://localhost:8545',
    telemetry: { logDir },
    state: { dir: stateDir },
    killSwitchFile: join(stateDir, 'KILL'),
    ...overrides,
  });
}

// Quiet, deterministic runner deps: an immediate sleep, a fixed clock, no kill file, no signal wiring, a swallowed internal log, no discovery jitter.
const noopRunnerDeps: Partial<RunnerDeps> = {
  now: () => 1_900_000_000,
  sleep: () => Promise.resolve(),
  killFileExists: () => false,
  registerShutdownSignals: () => () => {},
  log: () => {},
  random: () => 0.5,
};

/** A real `OspexAdapter` whose discovery finds nothing — so the loop ticks without touching the network. `addresses()` still works (the spy is just on `listContests`). */
function discoveryFindsNothing(config: Config): OspexAdapter {
  const adapter = createOspexAdapter(config);
  vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
  return adapter;
}

function captureLog(): { log: (line: string) => void; lines: () => readonly string[] } {
  const lines: string[] = [];
  return { log: (line) => void lines.push(line), lines: () => lines };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('runRun — mode gating', () => {
  it('--live → RunRefused (Phase 3, not yet implemented)', async () => {
    await expect(runRun({ config: cfg(), mode: 'live', ignoreMissingState: false })).rejects.toBeInstanceOf(RunRefused);
    await expect(runRun({ config: cfg(), mode: 'live', ignoreMissingState: false })).rejects.toThrow(/not yet implemented/i);
  });

  it('--dry-run with config mode.dryRun=false → logs the override note, normalizes the effective config (the runner boots in dry-run, not live), still runs the shadow loop', async () => {
    const cap = captureLog();
    const runnerLog = captureLog();
    await runRun(
      { config: cfg({ mode: { dryRun: false } }), mode: 'dry-run', ignoreMissingState: false },
      { createAdapter: discoveryFindsNothing, makeRunId: () => 'test-run', runnerDeps: { ...noopRunnerDeps, log: runnerLog.log }, maxTicks: 1, log: cap.log },
    );
    expect(cap.lines().some((l) => /config has mode\.dryRun=false/.test(l))).toBe(true);
    // The Runner derives its boot banner from the *effective* config — `--dry-run` forced it, so it must say "mode dry-run", not "mode live".
    expect(runnerLog.lines().some((l) => l.includes('mode dry-run'))).toBe(true);
    expect(runnerLog.lines().some((l) => l.includes('mode live'))).toBe(false);
    expect(existsSync(join(logDir, 'run-test-run.ndjson'))).toBe(true);
  });
});

describe('runRun — dry-run shadow loop wiring', () => {
  it('constructs a Runner from the injected factories and runs it; writes a state file + an event log with tick-starts', async () => {
    const createAdapter = vi.fn(discoveryFindsNothing);
    const makeRunId = vi.fn(() => 'test-run-abc');
    const cap = captureLog();
    const config = cfg();
    await runRun(
      { config, mode: 'dry-run', ignoreMissingState: false },
      { createAdapter, makeRunId, runnerDeps: noopRunnerDeps, maxTicks: 2, log: cap.log },
    );
    expect(createAdapter).toHaveBeenCalledWith(config);
    expect(makeRunId).toHaveBeenCalledTimes(1);
    // The loop ran: the state was flushed, the event log holds the tick-starts.
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true);
    const logPath = join(logDir, 'run-test-run-abc.ndjson');
    expect(existsSync(logPath)).toBe(true);
    const events = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string });
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(2);
    // The boot banner names the maker wallet (unresolved here — no --address, no keystore).
    expect(cap.lines().some((l) => /maker wallet:.*unresolved/.test(l))).toBe(true);
  });

  it('shows the --address override in the boot banner', async () => {
    const cap = captureLog();
    const addr = '0xabc0000000000000000000000000000000000abc' as Hex;
    await runRun(
      { config: cfg(), mode: 'dry-run', address: addr, ignoreMissingState: false },
      { createAdapter: discoveryFindsNothing, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: cap.log },
    );
    expect(cap.lines().some((l) => l.includes(addr))).toBe(true);
  });

  it('resolves the maker address from an ethers-style keystore when --address is omitted', async () => {
    const keystorePath = join(stateDir, 'keystore.json');
    writeFileSync(keystorePath, JSON.stringify({ address: 'ABC0000000000000000000000000000000000ABC', crypto: {} }), 'utf8');
    const cap = captureLog();
    await runRun(
      { config: cfg({ wallet: { keystorePath } }), mode: 'dry-run', ignoreMissingState: false },
      { createAdapter: discoveryFindsNothing, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: cap.log },
    );
    expect(cap.lines().some((l) => l.includes('0xabc0000000000000000000000000000000000abc'))).toBe(true);
  });
});
