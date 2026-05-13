import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { createLiveOspexAdapter, createOspexAdapter, type Hex, type OspexAdapter, type Signer } from '../ospex/index.js';
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
  it('--dry-run with config mode.dryRun=false → logs the override note, normalizes the effective config (the runner boots in dry-run, not live), still runs the shadow loop', async () => {
    const cap = captureLog();
    const runnerLog = captureLog();
    await runRun(
      { config: cfg({ mode: { dryRun: false } }), mode: 'dry-run', ignoreMissingState: false, confirmUnlimited: false },
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
      { config, mode: 'dry-run', ignoreMissingState: false, confirmUnlimited: false },
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
      { config: cfg(), mode: 'dry-run', address: addr, ignoreMissingState: false, confirmUnlimited: false },
      { createAdapter: discoveryFindsNothing, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: cap.log },
    );
    expect(cap.lines().some((l) => l.includes(addr))).toBe(true);
  });

  it('resolves the maker address from an ethers-style keystore when --address is omitted', async () => {
    const keystorePath = join(stateDir, 'keystore.json');
    writeFileSync(keystorePath, JSON.stringify({ address: 'ABC0000000000000000000000000000000000ABC', crypto: {} }), 'utf8');
    const cap = captureLog();
    await runRun(
      { config: cfg({ wallet: { keystorePath } }), mode: 'dry-run', ignoreMissingState: false, confirmUnlimited: false },
      { createAdapter: discoveryFindsNothing, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: cap.log },
    );
    expect(cap.lines().some((l) => l.includes('0xabc0000000000000000000000000000000000abc'))).toBe(true);
  });
});

// ── live mode wiring (the on-switch — Phase 3 (b-ii)) ────────────────────────

describe('runRun — live mode wiring', () => {
  const SIGNER_ADDRESS = '0x9999999999999999999999999999999999999999' as Hex;

  /** A minimal Signer — deterministic address, dummy signatures. */
  function fakeSigner(): Signer {
    return {
      getAddress: () => Promise.resolve(SIGNER_ADDRESS),
      signTypedData: () => Promise.resolve('0xsig' as Hex),
      signTransaction: () => Promise.resolve('0xtx' as Hex),
    };
  }

  /** A signed adapter whose discovery finds nothing — the loop ticks without touching the network or attempting a real submit. */
  function liveDiscoveryFindsNothing(config: Config, signer: Signer): OspexAdapter {
    const adapter = createLiveOspexAdapter(config, signer);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    // The runner's boot-time auto-approve (Phase 3 d-i) reads the maker's PositionModule allowance —
    // default the stub to a saturated allowance so no `approveUSDC` is needed, and stub `approveUSDC`
    // to reject loudly in case a test inadvertently lands on the write path.
    vi.spyOn(adapter, 'readApprovals').mockResolvedValue({
      owner: '0xowner' as Hex, chainId: 137,
      usdc: { address: '0xusdc' as Hex, decimals: 6, allowances: { positionModule: { spender: '0xpm' as Hex, spenderModule: 'positionModule', raw: 2n ** 255n }, treasuryModule: { spender: '0xtm' as Hex, spenderModule: 'treasuryModule', raw: 0n } } },
      link: { address: '0xlink' as Hex, decimals: 18, allowances: { oracleModule: { spender: '0xom' as Hex, spenderModule: 'oracleModule', raw: 0n } } },
    });
    vi.spyOn(adapter, 'approveUSDC').mockRejectedValue(new Error('liveDiscoveryFindsNothing: approveUSDC not stubbed'));
    return adapter;
  }

  function liveConfig(overrides: Record<string, unknown> = {}): Config {
    const keystorePath = join(stateDir, 'ks.json');
    writeFileSync(keystorePath, '{}', 'utf8'); // never actually decrypted — `unlockSigner` is faked
    return cfg({ mode: { dryRun: false }, wallet: { keystorePath }, ...overrides });
  }

  it('--live + mode.dryRun:false + OSPEX_KEYSTORE_PASSPHRASE → unlocks the signer, builds the live adapter, runs (the env wins over any prompt)', async () => {
    const unlockSigner = vi.fn((_path: string, _pw: string) => Promise.resolve(fakeSigner()));
    const createLiveAdapter = vi.fn(liveDiscoveryFindsNothing);
    const promptPassphrase = vi.fn(() => Promise.reject(new Error('should not be called')));
    const cap = captureLog();
    const config = liveConfig();
    await runRun(
      { config, mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter, unlockSigner, promptPassphrase, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw-from-env' }, makeRunId: () => 'live-run', runnerDeps: noopRunnerDeps, maxTicks: 1, log: cap.log },
    );
    expect(unlockSigner).toHaveBeenCalledWith(config.wallet.keystorePath, 'pw-from-env');
    expect(createLiveAdapter).toHaveBeenCalledTimes(1);
    expect(createLiveAdapter.mock.calls[0]?.[0]).toBe(config); // (the same config object — no normalization needed when dryRun was already false)
    expect(promptPassphrase).not.toHaveBeenCalled();
    expect(cap.lines().some((l) => l.includes(SIGNER_ADDRESS))).toBe(true); // boot banner names the signer's address
    expect(existsSync(join(logDir, 'run-live-run.ndjson'))).toBe(true); // the runner ran
  });

  it('--live with env unset → prompts for the passphrase', async () => {
    const unlockSigner = vi.fn((_path: string, _pw: string) => Promise.resolve(fakeSigner()));
    const promptPassphrase = vi.fn(() => Promise.resolve('pw-from-prompt'));
    await runRun(
      { config: liveConfig(), mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, promptPassphrase, env: {}, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: () => {} },
    );
    expect(promptPassphrase).toHaveBeenCalledTimes(1);
    expect(unlockSigner.mock.calls[0]?.[1]).toBe('pw-from-prompt');
  });

  it('--live with env unset and the prompt rejects (no TTY / cancelled) → RunRefused with a clear hint about OSPEX_KEYSTORE_PASSPHRASE', async () => {
    const unlockSigner = vi.fn();
    const promptPassphrase = vi.fn(() => Promise.reject(new Error('stdin is not a TTY')));
    await expect(runRun(
      { config: liveConfig(), mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, promptPassphrase, env: {}, log: () => {} },
    )).rejects.toMatchObject({ name: 'RunRefused', message: expect.stringMatching(/OSPEX_KEYSTORE_PASSPHRASE/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('--live + config.mode.dryRun:true → RunRefused (the two-key model — both keys must agree), no signer unlock attempted', async () => {
    const unlockSigner = vi.fn();
    await expect(runRun(
      { config: cfg({ mode: { dryRun: true } }), mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, log: () => {} },
    )).rejects.toMatchObject({ name: 'RunRefused', message: expect.stringMatching(/mode\.dryRun=true/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('--live without wallet.keystorePath → RunRefused', async () => {
    const unlockSigner = vi.fn();
    await expect(runRun(
      { config: cfg({ mode: { dryRun: false } }), mode: 'live', ignoreMissingState: false, confirmUnlimited: false }, // no wallet.keystorePath
      { unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, log: () => {} },
    )).rejects.toMatchObject({ name: 'RunRefused', message: expect.stringMatching(/keystorePath/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('--live with --address → RunRefused (the maker address comes from the signer in live mode)', async () => {
    const unlockSigner = vi.fn();
    await expect(runRun(
      { config: liveConfig(), mode: 'live', address: '0xabc0000000000000000000000000000000000abc' as Hex, ignoreMissingState: false, confirmUnlimited: false },
      { unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, log: () => {} },
    )).rejects.toMatchObject({ name: 'RunRefused', message: expect.stringMatching(/--address is incompatible with --live/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('unlockSigner throws (bad passphrase / malformed keystore) → propagates a plain Error (the CLI prints "run failed: …")', async () => {
    const unlockSigner = vi.fn(() => Promise.reject(new Error('invalid password')));
    await expect(runRun(
      { config: liveConfig(), mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'wrong' }, log: () => {} },
    )).rejects.toThrow(/invalid password/);
    // Not a RunRefused — a bad passphrase is an operational failure, not a "refused mode".
    await expect(runRun(
      { config: liveConfig(), mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'wrong' }, log: () => {} },
    )).rejects.not.toBeInstanceOf(RunRefused);
  });

  it('--live + approvals.autoApprove=true + approvals.mode=unlimited + no --yes → RunRefused (must explicitly confirm a MaxUint256 USDC approval), no signer unlock attempted', async () => {
    const unlockSigner = vi.fn();
    const unlimitedConfig = { ...liveConfig(), approvals: { autoApprove: true, mode: 'unlimited' as const } };
    await expect(runRun(
      { config: unlimitedConfig, mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, log: () => {} },
    )).rejects.toMatchObject({ name: 'RunRefused', message: expect.stringMatching(/MaxUint256.*--yes/) as unknown });
    expect(unlockSigner).not.toHaveBeenCalled();
  });

  it('--live + approvals.autoApprove=true + approvals.mode=unlimited + --yes → unlock proceeds (confirmation accepted)', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    const unlimitedConfig = { ...liveConfig(), approvals: { autoApprove: true, mode: 'unlimited' as const } };
    await runRun(
      { config: unlimitedConfig, mode: 'live', ignoreMissingState: false, confirmUnlimited: true },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: () => {} },
    );
    expect(unlockSigner).toHaveBeenCalledTimes(1);
  });

  it('--live + approvals.autoApprove=false + approvals.mode=unlimited + no --yes → runs (the unlimited mode is inert without autoApprove, so the gate doesn\'t fire)', async () => {
    const unlockSigner = vi.fn(() => Promise.resolve(fakeSigner()));
    const inertConfig = { ...liveConfig(), approvals: { autoApprove: false, mode: 'unlimited' as const } };
    await runRun(
      { config: inertConfig, mode: 'live', ignoreMissingState: false, confirmUnlimited: false },
      { createLiveAdapter: liveDiscoveryFindsNothing, unlockSigner, env: { OSPEX_KEYSTORE_PASSPHRASE: 'pw' }, makeRunId: () => 'r', runnerDeps: noopRunnerDeps, maxTicks: 1, log: () => {} },
    );
    expect(unlockSigner).toHaveBeenCalledTimes(1);
  });
});
