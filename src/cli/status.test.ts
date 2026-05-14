import { describe, expect, it, vi } from 'vitest';

import { parseConfig, type Config } from '../config/index.js';
import { OspexAdapter, type Hex, type OspexClientLike, type PositionStatus } from '../ospex/index.js';
import {
  emptyMakerState,
  type MakerCommitmentRecord,
  type MakerPositionRecord,
  type MakerState,
  type StateLoadResult,
  type StateLoadStatus,
} from '../state/index.js';
import {
  renderStatusReportJson,
  renderStatusReportText,
  runStatus,
  statusExitCode,
  type StatusDeps,
  type StatusReport,
} from './status.js';

// ── fixtures + helpers ───────────────────────────────────────────────────────

const T0 = 1_900_000_000;
const TODAY = new Date(T0 * 1000).toISOString().slice(0, 10);
const ADDR_FLAG = '0xaaaa000000000000000000000000000000000001' as Hex;
const ADDR_KEYSTORE = '0xbbbb000000000000000000000000000000000002' as Hex;

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    rpcUrl: 'http://localhost:8545',
    state: { dir: '/tmp/ospex-mm-state-status' },
    telemetry: { logDir: '/tmp/ospex-mm-log-status' },
    ...overrides,
  });
}

/** Build a commitment record. */
function rec(hash: string, overrides: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'A',
    homeTeam: 'B',
    scorer: '0xscorer',
    makerSide: 'away',
    oddsTick: 200,
    riskAmountWei6: '1000000',
    filledRiskWei6: '0',
    lifecycle: 'visibleOpen',
    expiryUnixSec: T0 + 600,
    postedAtUnixSec: T0 - 60,
    updatedAtUnixSec: T0 - 60,
    ...overrides,
  };
}

/** Build a position record. */
function pos(id: string, overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
  return {
    speculationId: id,
    contestId: id,
    sport: 'mlb',
    awayTeam: 'A',
    homeTeam: 'B',
    side: 'away',
    riskAmountWei6: '1000000', // 1 USDC
    counterpartyRiskWei6: '910000',
    status: 'active',
    updatedAtUnixSec: T0,
    ...overrides,
  };
}

/** A fake StateStore that returns the supplied `{state, status}`. */
function fakeStateStore(load: StateLoadResult): { dir: string; statePath: string; load: () => StateLoadResult; flush: () => void } {
  return {
    dir: '/fake',
    statePath: '/fake/maker-state.json',
    load: () => load,
    flush: () => {},
  };
}

/** A read-only adapter where `getPositionStatus` resolves to the supplied `PositionStatus`. */
function adapterWithLivePositions(totals: PositionStatus['totals']): OspexAdapter {
  const notStubbed = (name: string) => () => Promise.reject(new Error(`fake.${name}: not stubbed`));
  const ps: PositionStatus = { active: [], pendingSettle: [], claimable: [], totals };
  const client: OspexClientLike = {
    contests: { get: notStubbed('contests.get'), list: notStubbed('contests.list') },
    speculations: { list: notStubbed('speculations.list'), get: notStubbed('speculations.get') },
    commitments: {
      list: notStubbed('commitments.list'), get: notStubbed('commitments.get'),
      submitRaw: notStubbed('commitments.submitRaw'), cancel: notStubbed('commitments.cancel'),
      cancelOnchain: notStubbed('commitments.cancelOnchain'), raiseMinNonce: notStubbed('commitments.raiseMinNonce'),
      approve: notStubbed('commitments.approve'), getNonceFloor: notStubbed('commitments.getNonceFloor'),
    },
    positions: {
      status: () => Promise.resolve(ps),
      byAddress: notStubbed('positions.byAddress'),
      settleSpeculation: notStubbed('positions.settleSpeculation'),
      claim: notStubbed('positions.claim'),
      claimAll: notStubbed('positions.claimAll'),
    },
    balances: { read: notStubbed('balances.read') },
    approvals: { read: notStubbed('approvals.read') },
    health: { check: notStubbed('health.check') },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe') },
  };
  return new OspexAdapter(client, { chainId: 137, apiUrl: 'https://api.test' });
}

/** A read-only adapter whose `getPositionStatus` rejects with the supplied error. */
function adapterWithLivePositionsThrowing(err: Error): OspexAdapter {
  const notStubbed = (name: string) => () => Promise.reject(new Error(`fake.${name}: not stubbed`));
  const client: OspexClientLike = {
    contests: { get: notStubbed('contests.get'), list: notStubbed('contests.list') },
    speculations: { list: notStubbed('speculations.list'), get: notStubbed('speculations.get') },
    commitments: {
      list: notStubbed('commitments.list'), get: notStubbed('commitments.get'),
      submitRaw: notStubbed('commitments.submitRaw'), cancel: notStubbed('commitments.cancel'),
      cancelOnchain: notStubbed('commitments.cancelOnchain'), raiseMinNonce: notStubbed('commitments.raiseMinNonce'),
      approve: notStubbed('commitments.approve'), getNonceFloor: notStubbed('commitments.getNonceFloor'),
    },
    positions: {
      status: () => Promise.reject(err),
      byAddress: notStubbed('positions.byAddress'),
      settleSpeculation: notStubbed('positions.settleSpeculation'),
      claim: notStubbed('positions.claim'),
      claimAll: notStubbed('positions.claimAll'),
    },
    balances: { read: notStubbed('balances.read') },
    approvals: { read: notStubbed('approvals.read') },
    health: { check: notStubbed('health.check') },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe') },
  };
  return new OspexAdapter(client, { chainId: 137, apiUrl: 'https://api.test' });
}

/** Default deps — no keystore plaintext address, no prior telemetry (genuine first run), fixed clock at T0. */
function defaultDeps(overrides: StatusDeps = {}, loadResult: StateLoadResult = { state: emptyMakerState(), status: { kind: 'fresh' } }): StatusDeps {
  return {
    makeStateStore: () => fakeStateStore(loadResult) as unknown as ReturnType<NonNullable<StatusDeps['makeStateStore']>>,
    readKeystoreAddress: () => null,
    hasPriorTelemetry: () => false,
    now: () => T0,
    ...overrides,
  };
}

const zeroTotals: PositionStatus['totals'] = {
  activeCount: 0, pendingSettleCount: 0, claimableCount: 0,
  estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0',
  pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0',
};

function collect(): { sink: { write(s: string): void }; text: () => string } {
  let buf = '';
  return { sink: { write: (s: string) => { buf += s; } }, text: () => buf };
}

// ── state-integrity scenarios ────────────────────────────────────────────────

describe('runStatus — state-file integrity + state-loss assessment', () => {
  it('fresh state + no prior telemetry → integrity:"fresh", stateLossAssessment.holdQuoting:false (genuine first run, nothing to under-count)', async () => {
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({ hasPriorTelemetry: () => false }, { state: emptyMakerState(), status: { kind: 'fresh' } }),
    );
    expect(report.stateIntegrity).toBe('fresh');
    expect(report.stateLossAssessment.holdQuoting).toBe(false);
    expect(report.stateLossAssessment.reason).toMatch(/genuine first run/);
    expect(report.lastFlushedAt).toBeNull();
    expect(report.commitments.total).toBe(0);
    expect(report.positions.total).toBe(0);
  });

  it('fresh state + PRIOR TELEMETRY → integrity:"fresh" BUT stateLossAssessment.holdQuoting:true with the "soft-cancelled set is gone" diagnostic (Hermes review-PR31 blocker)', async () => {
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({ hasPriorTelemetry: () => true }, { state: emptyMakerState(), status: { kind: 'fresh' } }),
    );
    expect(report.stateIntegrity).toBe('fresh');
    expect(report.stateLossAssessment.holdQuoting).toBe(true);
    expect(report.stateLossAssessment.reason).toMatch(/soft-cancelled set is gone/);
    expect(report.stateLossAssessment.suggestedWaitSeconds).toBe(120); // default orders.expirySeconds
    // Crucial — status REPORTS the loss; it doesn't refuse. Exit code stays 0; the diagnostic is the report itself.
    expect(statusExitCode(report)).toBe(0);
  });

  it('loaded state → integrity:"loaded", stateLossAssessment.holdQuoting:false ("state loaded cleanly"); lastFlushedAt + lastRunId surfaced', async () => {
    const state: MakerState = {
      ...emptyMakerState(),
      lastFlushedAt: '2026-05-13T19:00:00.000Z',
      lastRunId: 'run-xyz',
    };
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({ hasPriorTelemetry: () => true }, { state, status: { kind: 'loaded' } }), // prior telemetry exists; doesn't matter when loaded
    );
    expect(report.stateIntegrity).toBe('loaded');
    expect(report.stateLossAssessment.holdQuoting).toBe(false);
    expect(report.stateLossAssessment.reason).toMatch(/loaded cleanly/);
    expect(report.lastFlushedAt).toBe('2026-05-13T19:00:00.000Z');
    expect(report.lastRunId).toBe('run-xyz');
  });

  it('lost state → integrity:"lost", stateLossAssessment.holdQuoting:true with the load-time reason (no refusal — status reports state-loss, it does not refuse)', async () => {
    const lost: StateLoadStatus = { kind: 'lost', reason: 'state file failed validation: bad version' };
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({}, { state: emptyMakerState(), status: lost }),
    );
    expect(report.stateIntegrity).toBe('lost');
    expect(report.stateLossAssessment.holdQuoting).toBe(true);
    expect(report.stateLossAssessment.reason).toMatch(/bad version/);
    expect(statusExitCode(report)).toBe(0);
  });
});

// ── commitment summarization ─────────────────────────────────────────────────

describe('runStatus — commitments summary', () => {
  it('counts records by lifecycle; distinctContestsNonTerminal counts only visibleOpen/softCancelled/partiallyFilled', async () => {
    const records: MakerCommitmentRecord[] = [
      rec('0x1', { lifecycle: 'visibleOpen', contestId: 'C1' }),
      rec('0x2', { lifecycle: 'softCancelled', contestId: 'C1' }), // same contest as 0x1, still counts once
      rec('0x3', { lifecycle: 'partiallyFilled', contestId: 'C2' }),
      rec('0x4', { lifecycle: 'filled', contestId: 'C3' }), //         terminal — excluded from distinct count
      rec('0x5', { lifecycle: 'expired', contestId: 'C4' }), //         terminal — excluded
      rec('0x6', { lifecycle: 'authoritativelyInvalidated', contestId: 'C5' }), // terminal — excluded
    ];
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: Object.fromEntries(records.map((r) => [r.hash, r])),
    };
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({}, { state, status: { kind: 'loaded' } }),
    );
    expect(report.commitments.total).toBe(6);
    expect(report.commitments.byLifecycle.visibleOpen).toBe(1);
    expect(report.commitments.byLifecycle.softCancelled).toBe(1);
    expect(report.commitments.byLifecycle.partiallyFilled).toBe(1);
    expect(report.commitments.byLifecycle.filled).toBe(1);
    expect(report.commitments.byLifecycle.expired).toBe(1);
    expect(report.commitments.byLifecycle.authoritativelyInvalidated).toBe(1);
    expect(report.commitments.distinctContestsNonTerminal).toBe(2); // C1 (from 0x1+0x2) and C2 (from 0x3)
  });
});

// ── position summarization ───────────────────────────────────────────────────

describe('runStatus — positions summary', () => {
  it('counts records by status and sums riskAmountWei6 per bucket', async () => {
    const positions: MakerPositionRecord[] = [
      pos('s1', { status: 'active', riskAmountWei6: '1000000' }), //          1 USDC
      pos('s2', { status: 'active', riskAmountWei6: '2500000' }), //          2.5 USDC
      pos('s3', { status: 'claimable', riskAmountWei6: '500000' }), //        0.5 USDC
      pos('s4', { status: 'claimed', riskAmountWei6: '750000' }), //          0.75 USDC
    ];
    const state: MakerState = {
      ...emptyMakerState(),
      positions: Object.fromEntries(positions.map((p) => [`${p.speculationId}:${p.side}`, p])),
    };
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({}, { state, status: { kind: 'loaded' } }),
    );
    expect(report.positions.total).toBe(4);
    expect(report.positions.byStatus.active.count).toBe(2);
    expect(report.positions.byStatus.active.ownRiskWei6).toBe('3500000'); // 1 + 2.5 USDC
    expect(report.positions.byStatus.pendingSettle.count).toBe(0);
    expect(report.positions.byStatus.pendingSettle.ownRiskWei6).toBe('0');
    expect(report.positions.byStatus.claimable.count).toBe(1);
    expect(report.positions.byStatus.claimable.ownRiskWei6).toBe('500000');
    expect(report.positions.byStatus.claimed.count).toBe(1);
    expect(report.positions.byStatus.claimed.ownRiskWei6).toBe('750000');
  });
});

// ── daily counters ───────────────────────────────────────────────────────────

describe('runStatus — daily counters', () => {
  it('reports today\'s and lifetime gas / fees (sum across all dailyCounters entries)', async () => {
    const yesterday = new Date((T0 - 86_400) * 1000).toISOString().slice(0, 10);
    const state: MakerState = {
      ...emptyMakerState(),
      dailyCounters: {
        [TODAY]: { gasPolWei: '3000000000000000000', feeUsdcWei6: '500000' }, // 3 POL today, 0.5 USDC fee
        [yesterday]: { gasPolWei: '2000000000000000000', feeUsdcWei6: '0' }, //  2 POL yesterday
      },
    };
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({}, { state, status: { kind: 'loaded' } }),
    );
    expect(report.dailyCounters.today).toBe(TODAY);
    expect(report.dailyCounters.todayGasPolWei).toBe('3000000000000000000');
    expect(report.dailyCounters.todayFeeUsdcWei6).toBe('500000');
    expect(report.dailyCounters.lifetimeGasPolWei).toBe('5000000000000000000'); // 3 + 2 POL
    expect(report.dailyCounters.lifetimeFeeUsdcWei6).toBe('500000');
  });

  it('today\'s counter defaults to "0" when no entry exists for today', async () => {
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps({}, { state: emptyMakerState(), status: { kind: 'fresh' } }),
    );
    expect(report.dailyCounters.todayGasPolWei).toBe('0');
    expect(report.dailyCounters.todayFeeUsdcWei6).toBe('0');
    expect(report.dailyCounters.lifetimeGasPolWei).toBe('0');
  });
});

// ── maker-address resolution ─────────────────────────────────────────────────

describe('runStatus — maker address resolution', () => {
  it('--address wins — makerAddressSource:"flag"; live read attempted with that address', async () => {
    const getPositionStatusSpy = vi.fn(() => Promise.resolve<PositionStatus>({ active: [], pendingSettle: [], claimable: [], totals: zeroTotals }));
    const adapter = adapterWithLivePositions(zeroTotals);
    vi.spyOn(adapter, 'getPositionStatus').mockImplementation(getPositionStatusSpy);
    const report = await runStatus(
      { config: cfg({ wallet: { keystorePath: '/some/ks.json' } }), configPath: '/c.yaml', adapter, address: ADDR_FLAG },
      defaultDeps({ readKeystoreAddress: () => ADDR_KEYSTORE }), // even with a keystore plaintext, --address takes precedence
    );
    expect(report.makerAddress).toBe(ADDR_FLAG);
    expect(report.makerAddressSource).toBe('flag');
    expect(getPositionStatusSpy).toHaveBeenCalledWith(ADDR_FLAG);
  });

  it('no --address, ethers-style keystore plaintext → makerAddressSource:"keystore"; live read attempted with the keystore address', async () => {
    const getPositionStatusSpy = vi.fn(() => Promise.resolve<PositionStatus>({ active: [], pendingSettle: [], claimable: [], totals: zeroTotals }));
    const adapter = adapterWithLivePositions(zeroTotals);
    vi.spyOn(adapter, 'getPositionStatus').mockImplementation(getPositionStatusSpy);
    const report = await runStatus(
      { config: cfg({ wallet: { keystorePath: '/some/ks.json' } }), configPath: '/c.yaml', adapter },
      defaultDeps({ readKeystoreAddress: () => ADDR_KEYSTORE }),
    );
    expect(report.makerAddress).toBe(ADDR_KEYSTORE);
    expect(report.makerAddressSource).toBe('keystore');
    expect(getPositionStatusSpy).toHaveBeenCalledWith(ADDR_KEYSTORE);
  });

  it('no --address, no keystore plaintext (Foundry-style) → makerAddress null, live read skipped with clear reason', async () => {
    const adapter = adapterWithLivePositions(zeroTotals);
    const getPositionStatusSpy = vi.spyOn(adapter, 'getPositionStatus');
    const report = await runStatus(
      { config: cfg({ wallet: { keystorePath: '/foundry-ks.json' } }), configPath: '/c.yaml', adapter },
      defaultDeps({ readKeystoreAddress: () => null }), // a Foundry keystore: no plaintext address
    );
    expect(report.makerAddress).toBeNull();
    expect(report.makerAddressSource).toBe('unknown');
    expect(report.livePositionTotals).toBeNull();
    expect(report.livePositionsSkipReason).toMatch(/no maker address/);
    expect(getPositionStatusSpy).not.toHaveBeenCalled();
  });

  it('no --address, no keystore configured → makerAddress null, live read skipped', async () => {
    const adapter = adapterWithLivePositions(zeroTotals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter },
      defaultDeps(),
    );
    expect(report.makerAddress).toBeNull();
    expect(report.livePositionsSkipReason).toMatch(/no maker address/);
  });
});

// ── optional live position read ──────────────────────────────────────────────

describe('runStatus — live position read', () => {
  it('success → livePositionTotals populated from the SDK\'s `totals` field', async () => {
    const totals: PositionStatus['totals'] = {
      activeCount: 3, pendingSettleCount: 1, claimableCount: 2,
      estimatedPayoutUSDC: 5, estimatedPayoutWei6: '5000000',
      pendingSettlePayoutUSDC: 2, pendingSettlePayoutWei6: '2000000',
    };
    const adapter = adapterWithLivePositions(totals);
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter, address: ADDR_FLAG },
      defaultDeps(),
    );
    expect(report.livePositionTotals).toEqual({
      activeCount: 3,
      pendingSettleCount: 1,
      claimableCount: 2,
      claimablePayoutWei6: '5000000',
      pendingSettlePayoutWei6: '2000000',
    });
    expect(report.livePositionsSkipReason).toBeNull();
  });

  it('throw → livePositionsSkipReason carries the error message; exit code still 0 (status is informational)', async () => {
    const adapter = adapterWithLivePositionsThrowing(new Error('api 503'));
    const report = await runStatus(
      { config: cfg(), configPath: '/c.yaml', adapter, address: ADDR_FLAG },
      defaultDeps(),
    );
    expect(report.livePositionTotals).toBeNull();
    expect(report.livePositionsSkipReason).toMatch(/api 503/);
    expect(statusExitCode(report)).toBe(0);
  });
});

// ── renderers ────────────────────────────────────────────────────────────────

describe('runStatus — renderers', () => {
  function buildSampleReport(overrides: Partial<StatusReport> = {}): StatusReport {
    return {
      schemaVersion: 1,
      configPath: '/c.yaml',
      statePath: '/state/maker-state.json',
      stateIntegrity: 'loaded',
      stateLossAssessment: { holdQuoting: false, reason: 'state loaded cleanly' },
      lastFlushedAt: '2026-05-13T19:00:00.000Z',
      lastRunId: 'run-xyz',
      commitments: {
        total: 2,
        byLifecycle: { visibleOpen: 1, softCancelled: 0, partiallyFilled: 1, filled: 0, expired: 0, authoritativelyInvalidated: 0 },
        distinctContestsNonTerminal: 2,
      },
      positions: {
        total: 1,
        byStatus: {
          active: { count: 1, ownRiskWei6: '1500000' },
          pendingSettle: { count: 0, ownRiskWei6: '0' },
          claimable: { count: 0, ownRiskWei6: '0' },
          claimed: { count: 0, ownRiskWei6: '0' },
        },
      },
      dailyCounters: {
        today: TODAY,
        todayGasPolWei: '3000000000000000000',
        todayFeeUsdcWei6: '0',
        lifetimeGasPolWei: '5000000000000000000',
        lifetimeFeeUsdcWei6: '0',
      },
      pnl: { realizedUsdcWei6: '0', unrealizedUsdcWei6: '0', asOfUnixSec: 0 },
      makerAddress: ADDR_FLAG,
      makerAddressSource: 'flag',
      livePositionTotals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, claimablePayoutWei6: '0', pendingSettlePayoutWei6: '0' },
      livePositionsSkipReason: null,
      ...overrides,
    };
  }

  it('JSON renderer emits a `{ schemaVersion: 1, status: StatusReport }` envelope', () => {
    const c = collect();
    renderStatusReportJson(buildSampleReport(), c.sink);
    const line = c.text().trim();
    const parsed = JSON.parse(line) as { schemaVersion: number; status: StatusReport };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.status.commitments.total).toBe(2);
    expect(parsed.status.makerAddress).toBe(ADDR_FLAG);
    expect(parsed.status.livePositionTotals?.activeCount).toBe(1);
  });

  it('text renderer prints the headline sections (commitments / positions / today / live)', () => {
    const c = collect();
    renderStatusReportText(buildSampleReport(), c.sink);
    const out = c.text();
    expect(out).toMatch(/ospex-mm status/);
    expect(out).toMatch(/state file:.*loaded/);
    expect(out).toMatch(/Commitments:\s*2 tracked/);
    expect(out).toMatch(/visibleOpen\s+1/);
    expect(out).toMatch(/partiallyFilled\s+1/);
    expect(out).toMatch(/Positions:\s*1 tracked/);
    expect(out).toMatch(/active\s+1\s+own-risk 1\.500000 USDC/);
    expect(out).toMatch(new RegExp(`Today \\(${TODAY}\\)`));
    expect(out).toMatch(/gas spent\s+3\.000000 POL/);
    expect(out).toMatch(/Live position status \(from API\)/);
    expect(out).toMatch(/active\s+1$/m);
  });

  it('text renderer flags a lost state with the assessment reason on its own line', () => {
    const c = collect();
    renderStatusReportText(buildSampleReport({
      stateIntegrity: 'lost',
      stateLossAssessment: { holdQuoting: true, reason: 'state was lost (state file failed validation: bad version) — must not resume quoting on a blank slate' },
    }), c.sink);
    const out = c.text();
    expect(out).toMatch(/state file:.*lost/);
    expect(out).toMatch(/state-loss:.*bad version/);
  });

  it('text renderer flags a fresh-with-prior-telemetry state-loss (Hermes review-PR31 blocker — without this, a deleted state file looks like a clean fresh snapshot)', () => {
    const c = collect();
    renderStatusReportText(buildSampleReport({
      stateIntegrity: 'fresh',
      stateLossAssessment: { holdQuoting: true, reason: 'the state file is missing but prior telemetry shows a prior run — its soft-cancelled set is gone — must not resume quoting on a blank slate', suggestedWaitSeconds: 120 },
    }), c.sink);
    const out = c.text();
    expect(out).toMatch(/state file:.*fresh/);
    expect(out).toMatch(/state-loss:.*soft-cancelled set is gone/);
    expect(out).toMatch(/wait 120s under fixed-seconds expiry/);
  });

  it('text renderer prints the skip reason when live read was skipped', () => {
    const c = collect();
    renderStatusReportText(buildSampleReport({
      makerAddress: null,
      makerAddressSource: 'unknown',
      livePositionTotals: null,
      livePositionsSkipReason: 'no maker address — pass --address',
    }), c.sink);
    expect(c.text()).toMatch(/skipped — no maker address/);
  });
});
