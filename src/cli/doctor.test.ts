import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../config/index.js';
import { OspexAdapter, type ApprovalsSnapshot, type BalancesSnapshot, type Hex, type OspexClientLike } from '../ospex/index.js';
import { emptyMakerState, type StateLoadResult } from '../state/index.js';
import {
  doctorExitCode,
  renderDoctorReportJson,
  renderDoctorReportText,
  runDoctor,
  type DoctorCheckName,
  type DoctorCheckStatus,
  type DoctorDeps,
  type DoctorReport,
} from './doctor.js';

// ── fixtures + helpers ───────────────────────────────────────────────────────

const ADDR = '0x1111111111111111111111111111111111111111' as Hex;
const KEYSTORE_PATH = '/tmp/ospex-mm-keystore.json';

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ rpcUrl: 'http://localhost:8545', wallet: { keystorePath: KEYSTORE_PATH }, ...overrides });
}
function cfgNoKeystore(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ rpcUrl: 'http://localhost:8545', ...overrides });
}

const SAMPLE_BALANCES: BalancesSnapshot = {
  owner: ADDR,
  chainId: 137,
  native: 1_000_000_000_000_000_000n, // 1 POL
  usdc: 50_000_000n, // 50 USDC
  link: 0n,
  usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  linkAddress: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
};
function approvalsWith(positionModuleRaw: bigint): ApprovalsSnapshot {
  return {
    owner: ADDR,
    chainId: 137,
    usdc: {
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      allowances: {
        positionModule: { spender: '0xPM', spenderModule: 'positionModule', raw: positionModuleRaw },
        treasuryModule: { spender: '0xTM', spenderModule: 'treasuryModule', raw: 0n },
      },
    },
    link: {
      address: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
      decimals: 18,
      allowances: { oracleModule: { spender: '0xOM', spenderModule: 'oracleModule', raw: 0n } },
    },
  };
}

type ClientOverrides = { [K in keyof OspexClientLike]?: Partial<OspexClientLike[K]> };

function fakeAdapter(client: ClientOverrides = {}, ctx = { chainId: 137 as const, apiUrl: 'https://api.test' }): OspexAdapter {
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
  return new OspexAdapter(full, ctx);
}

/** A "healthy host" adapter: API up, RPC up, plenty of POL/USDC, allowance covers the cap ceiling. */
function healthyAdapter(approvalRaw = 5_000_000n): OspexAdapter {
  return fakeAdapter({
    health: { check: () => Promise.resolve({ ok: true } as unknown as never) },
    balances: { read: () => Promise.resolve(SAMPLE_BALANCES) },
    approvals: { read: () => Promise.resolve(approvalsWith(approvalRaw)) },
  });
}

/** Default deps: keystore file present, address derivable, no prior state, no prior telemetry. */
function defaultDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    keystoreFileExists: () => true,
    readKeystoreAddress: () => ADDR,
    loadState: (): StateLoadResult => ({ state: emptyMakerState(), status: { kind: 'fresh' } }),
    eventLogsExist: () => false,
    ...over,
  };
}

function statusOf(report: DoctorReport, name: DoctorCheckName): DoctorCheckStatus {
  const c = report.checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named ${name}`);
  return c.status;
}
function detailOf(report: DoctorReport, name: DoctorCheckName): string {
  const c = report.checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named ${name}`);
  return c.detail;
}
function collect(): { sink: { write(s: string): void }; text: () => string } {
  let buf = '';
  return { sink: { write: (s: string) => { buf += s; } }, text: () => buf };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('runDoctor — happy path', () => {
  it('all checks OK; exit 0; postCommitments tracks mode.dryRun', async () => {
    const dryReport = await runDoctor(
      { config: cfg(), configPath: './ospex-mm.yaml', adapter: healthyAdapter(), address: ADDR },
      defaultDeps(),
    );
    expect(dryReport.checks.map((c) => c.status).every((s) => s === 'ok')).toBe(true);
    expect(doctorExitCode(dryReport)).toBe(0);
    expect(dryReport.ready.dryRunShadow.ok).toBe(true);
    // default config has mode.dryRun: true → not ready to post
    expect(dryReport.ready.postCommitments.ok).toBe(false);
    expect(dryReport.ready.postCommitments.reason).toMatch(/mode\.dryRun: true/);

    const liveReport = await runDoctor(
      { config: cfg({ mode: { dryRun: false } }), configPath: './ospex-mm.yaml', adapter: healthyAdapter(), address: ADDR },
      defaultDeps(),
    );
    expect(liveReport.ready.postCommitments.ok).toBe(true);
    expect(doctorExitCode(liveReport)).toBe(0);
  });
});

describe('runDoctor — broken infrastructure FAILs (exit 1)', () => {
  it('API unreachable → api FAIL', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: fakeAdapter({ health: { check: () => Promise.reject(new Error('down')) }, balances: { read: () => Promise.resolve(SAMPLE_BALANCES) }, approvals: { read: () => Promise.resolve(approvalsWith(5_000_000n)) } }), address: ADDR },
      defaultDeps(),
    );
    expect(statusOf(report, 'api')).toBe('fail');
    expect(doctorExitCode(report)).toBe(1);
  });

  it('RPC errors on the balance read → rpc FAIL; pol/usdc balances SKIP', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: fakeAdapter({ health: { check: () => Promise.resolve(undefined as unknown as never) }, balances: { read: () => Promise.reject(new Error('rpc timeout')) }, approvals: { read: () => Promise.reject(new Error('rpc timeout')) } }), address: ADDR },
      defaultDeps(),
    );
    expect(statusOf(report, 'rpc')).toBe('fail');
    expect(detailOf(report, 'rpc')).toMatch(/rpc timeout/);
    expect(statusOf(report, 'pol-balance')).toBe('skipped');
    expect(statusOf(report, 'usdc-balance')).toBe('skipped');
    expect(doctorExitCode(report)).toBe(1);
  });

  it('keystore path set but the file is missing → keystore FAIL', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: healthyAdapter(), address: ADDR },
      defaultDeps({ keystoreFileExists: () => false }),
    );
    expect(statusOf(report, 'keystore')).toBe('fail');
    expect(doctorExitCode(report)).toBe(1);
  });

  it('zero POL → pol-balance FAIL', async () => {
    const report = await runDoctor(
      {
        config: cfg(),
        configPath: 'c.yaml',
        adapter: fakeAdapter({
          health: { check: () => Promise.resolve(undefined as unknown as never) },
          balances: { read: () => Promise.resolve({ ...SAMPLE_BALANCES, native: 0n }) },
          approvals: { read: () => Promise.resolve(approvalsWith(5_000_000n)) },
        }),
        address: ADDR,
      },
      defaultDeps(),
    );
    expect(statusOf(report, 'pol-balance')).toBe('fail');
    expect(doctorExitCode(report)).toBe(1);
  });
});

describe('runDoctor — advisory WARNs do not fail the exit', () => {
  it('no keystore configured, low POL, low USDC, short allowance, lost state — all WARN; exit 0', async () => {
    const report = await runDoctor(
      {
        config: cfgNoKeystore(),
        configPath: 'c.yaml',
        adapter: fakeAdapter({
          health: { check: () => Promise.resolve(undefined as unknown as never) },
          // no address resolved → balances/approvals are never called; they'd be SKIP anyway.
        }),
        // No --address; no keystorePath → walletAddress is null → chain reads skipped.
      },
      defaultDeps({ loadState: (): StateLoadResult => ({ state: emptyMakerState(), status: { kind: 'lost', reason: 'corrupt JSON' } }) }),
    );
    expect(statusOf(report, 'keystore')).toBe('warn');
    expect(statusOf(report, 'wallet')).toBe('skipped');
    expect(statusOf(report, 'rpc')).toBe('skipped');
    expect(statusOf(report, 'state')).toBe('warn');
    expect(detailOf(report, 'state')).toMatch(/fail-safe/);
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(doctorExitCode(report)).toBe(0);
    expect(report.ready.dryRunShadow.ok).toBe(true); // no FAILs → the shadow loop (which posts nothing) is good to boot; the missing keystore is a WARN
    expect(report.ready.postCommitments.ok).toBe(false); // a keystore is a live prereq
    expect(report.ready.postCommitments.reason).toMatch(/no usable keystore/);
  });

  it('with a wallet but a low POL balance + short allowance → those checks WARN, exit 0, postCommitments NO', async () => {
    const report = await runDoctor(
      {
        config: cfg(), // emergencyReservePOL defaults to 0.2 POL
        configPath: 'c.yaml',
        adapter: fakeAdapter({
          health: { check: () => Promise.resolve(undefined as unknown as never) },
          balances: { read: () => Promise.resolve({ ...SAMPLE_BALANCES, native: 100_000_000_000_000n }) }, // 0.0001 POL — below the 0.2 reserve
          approvals: { read: () => Promise.resolve(approvalsWith(0n)) }, // no allowance
        }),
        address: ADDR,
      },
      defaultDeps(),
    );
    expect(statusOf(report, 'pol-balance')).toBe('warn');
    expect(statusOf(report, 'allowance')).toBe('warn');
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(doctorExitCode(report)).toBe(0);
    expect(report.ready.postCommitments.ok).toBe(false);
  });
});

describe('runDoctor — wallet resolution + state check', () => {
  it('a Foundry-style keystore (no address field) and no --address → wallet SKIP, chain checks SKIP', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: fakeAdapter({ health: { check: () => Promise.resolve(undefined as unknown as never) } }) },
      defaultDeps({ readKeystoreAddress: () => null }),
    );
    expect(report.walletAddress).toBeNull();
    expect(report.walletAddressSource).toBe('unknown');
    expect(statusOf(report, 'wallet')).toBe('skipped');
    expect(statusOf(report, 'rpc')).toBe('skipped');
    expect(statusOf(report, 'allowance')).toBe('skipped');
    expect(statusOf(report, 'keystore')).toBe('ok'); // the file is there; it just has no `address` field
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(report.ready.dryRunShadow.ok).toBe(true); // no FAILs → run --dry-run can boot (it posts nothing)
    expect(report.ready.postCommitments.ok).toBe(false); // no wallet address resolved (a Foundry keystore omits it; pass --address for the live path)
    expect(report.ready.postCommitments.reason).toMatch(/wallet address unresolved/);
  });

  it('a loaded state file → state OK with counts + last-flushed', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: healthyAdapter(), address: ADDR },
      defaultDeps({ loadState: (): StateLoadResult => ({ state: { ...emptyMakerState(), lastFlushedAt: '2026-05-11T12:00:00Z' }, status: { kind: 'loaded' } }) }),
    );
    expect(statusOf(report, 'state')).toBe('ok');
    expect(detailOf(report, 'state')).toMatch(/last flushed 2026-05-11T12:00:00Z/);
  });

  it('a fresh state file but prior telemetry exists → state WARN (the boot-time fail-safe holds)', async () => {
    const report = await runDoctor(
      { config: cfg(), configPath: 'c.yaml', adapter: healthyAdapter(), address: ADDR },
      defaultDeps({ eventLogsExist: () => true }),
    );
    expect(statusOf(report, 'state')).toBe('warn');
    expect(detailOf(report, 'state')).toMatch(/fail-safe/);
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe('renderDoctorReport*', () => {
  it('JSON envelope is { schemaVersion: 1, doctor: DoctorReport }', async () => {
    const report = await runDoctor({ config: cfg(), configPath: 'c.yaml', adapter: healthyAdapter(), address: ADDR }, defaultDeps());
    const { sink, text } = collect();
    renderDoctorReportJson(report, sink);
    const parsed = JSON.parse(text()) as { schemaVersion: number; doctor: DoctorReport };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.doctor.chainId).toBe(137);
    expect(parsed.doctor.checks).toHaveLength(9);
  });

  it('text render lists the check rows and the Ready-to matrix', async () => {
    const report = await runDoctor({ config: cfg(), configPath: 'c.yaml', adapter: healthyAdapter(), address: ADDR }, defaultDeps());
    const { sink, text } = collect();
    renderDoctorReportText(report, sink);
    const out = text();
    for (const name of ['config', 'keystore', 'wallet', 'api', 'rpc', 'pol-balance', 'usdc-balance', 'allowance', 'state'] satisfies DoctorCheckName[]) {
      expect(out).toContain(name);
    }
    expect(out).toMatch(/Ready to:/);
    expect(out).toMatch(/dry-run shadow/);
    expect(out).toMatch(/post commitments/);
  });
});
