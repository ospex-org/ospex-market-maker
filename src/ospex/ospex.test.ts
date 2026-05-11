import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_API_URL } from '@ospex/sdk';
import type {
  ApprovalsSnapshot,
  BalancesSnapshot,
  Commitment,
  Contest,
  ContestOddsSnapshot,
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  PositionStatus,
  Speculation,
  Subscription,
} from '@ospex/sdk';

import {
  OspexAdapter,
  createOspexAdapter,
  readKeystoreAddress,
  type OspexClientLike,
} from './index.js';
import { parseConfig } from '../config/index.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_SPECULATION_MONEYLINE: Speculation = {
  speculationId: 'spec-1',
  contestId: 'contest-1',
  type: 'moneyline',
  lineTicks: null,
  line: null,
  speculationStatus: 0,
};

const SAMPLE_SPECULATION_CLOSED: Speculation = {
  speculationId: 'spec-2',
  contestId: 'contest-1',
  type: 'spread',
  lineTicks: -35,
  line: -3.5,
  speculationStatus: 1,
};

const SAMPLE_CONTEST: Contest = {
  contestId: 'contest-1',
  awayTeam: 'NYM',
  homeTeam: 'LAD',
  sport: 'mlb',
  sportId: 0,
  matchTime: '2026-05-12T01:30:00Z',
  status: 'verified',
  jsonoddsId: 'GAME-1',
  speculations: [SAMPLE_SPECULATION_MONEYLINE, SAMPLE_SPECULATION_CLOSED],
};

const SAMPLE_CONTEST_NO_LINKAGE: Contest = {
  contestId: 'contest-2',
  awayTeam: 'SF',
  homeTeam: 'OAK',
  sport: 'mlb',
  sportId: 0,
  matchTime: '2026-05-12T02:00:00Z',
  status: 'verified',
  jsonoddsId: null,
  speculations: [],
};

const SAMPLE_ODDS: ContestOddsSnapshot = {
  contestId: 'contest-1',
  jsonoddsId: 'GAME-1',
  odds: {
    moneyline: {
      market: 'moneyline',
      awayOddsAmerican: 150,
      homeOddsAmerican: -180,
      upstreamLastUpdated: '2026-05-11T20:00:00Z',
      pollCapturedAt: '2026-05-11T20:00:30Z',
      changedAt: '2026-05-11T20:00:00Z',
    },
    spread: null,
    total: null,
  },
};

const SAMPLE_ODDS_UPDATE: OddsSnapshot = {
  jsonoddsId: 'GAME-1',
  market: 'moneyline',
  network: 'polygon',
  line: null,
  awayOddsAmerican: 145,
  homeOddsAmerican: -175,
  upstreamLastUpdated: '2026-05-11T20:01:00Z',
  pollCapturedAt: '2026-05-11T20:01:30Z',
  changedAt: '2026-05-11T20:01:00Z',
};

const SAMPLE_COMMITMENT: Commitment = {
  commitmentHash: '0xabc',
  maker: '0x1111111111111111111111111111111111111111',
  contestId: 'contest-1',
  scorer: '0x2222222222222222222222222222222222222222',
  lineTicks: null,
  positionType: 0,
  oddsTick: 191,
  marketType: 'moneyline',
  riskAmount: '250000',
  filledRiskAmount: '0',
  remainingRiskAmount: '250000',
  nonce: '1730000000',
  expiry: '2026-05-12T01:30:00Z',
  speculationKey: 'key-1',
  signature: '0xsig',
  status: 'open',
  source: 'api',
  network: 'polygon',
  nonceInvalidated: false,
  isLive: true,
  createdAt: '2026-05-11T19:59:00Z',
};

const EMPTY_POSITION_STATUS: PositionStatus = {
  active: [],
  pendingSettle: [],
  claimable: [],
  totals: {
    activeCount: 0,
    pendingSettleCount: 0,
    claimableCount: 0,
    estimatedPayoutUSDC: 0,
    estimatedPayoutWei6: '0',
    pendingSettlePayoutUSDC: 0,
    pendingSettlePayoutWei6: '0',
  },
};

const SAMPLE_BALANCES: BalancesSnapshot = {
  owner: '0x1111111111111111111111111111111111111111',
  chainId: 137,
  native: 1_000_000_000_000_000_000n,
  usdc: 50_000_000n,
  link: 0n,
  usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  linkAddress: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
};

const SAMPLE_APPROVALS: ApprovalsSnapshot = {
  owner: '0x1111111111111111111111111111111111111111',
  chainId: 137,
  usdc: {
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    allowances: {
      positionModule: { spender: '0xpos', spenderModule: 'positionModule', raw: 0n },
      treasuryModule: { spender: '0xtre', spenderModule: 'treasuryModule', raw: 0n },
    },
  },
  link: {
    address: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1',
    decimals: 18,
    allowances: {
      oracleModule: { spender: '0xora', spenderModule: 'oracleModule', raw: 0n },
    },
  },
};

const FAKE_SUBSCRIPTION: Subscription = { unsubscribe: async () => {} };

// ── fake client builder ──────────────────────────────────────────────────────

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

function makeFakeClient(overrides: DeepPartial<OspexClientLike> = {}): OspexClientLike {
  const notStubbed = (name: string) => () => Promise.reject(new Error(`fake.${name}: not stubbed in this test`));
  return {
    contests: { get: notStubbed('contests.get'), list: notStubbed('contests.list'), ...overrides.contests },
    speculations: { list: notStubbed('speculations.list'), get: notStubbed('speculations.get'), ...overrides.speculations },
    commitments: { list: notStubbed('commitments.list'), get: notStubbed('commitments.get'), ...overrides.commitments },
    positions: { status: notStubbed('positions.status'), byAddress: notStubbed('positions.byAddress'), ...overrides.positions },
    balances: { read: notStubbed('balances.read'), ...overrides.balances },
    approvals: { read: notStubbed('approvals.read'), ...overrides.approvals },
    health: { check: notStubbed('health.check'), ...overrides.health },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe'), ...overrides.odds },
  };
}

function adapterWith(overrides: DeepPartial<OspexClientLike> = {}): OspexAdapter {
  return new OspexAdapter(makeFakeClient(overrides), { chainId: 137, apiUrl: 'https://api.test' });
}

// ── view-mapping tests (the provider-name boundary) ──────────────────────────

describe('OspexAdapter — contest views', () => {
  it('getContest maps jsonoddsId → referenceGameId and speculationStatus → open', async () => {
    const adapter = adapterWith({ contests: { get: () => Promise.resolve(SAMPLE_CONTEST) } });
    const view = await adapter.getContest('contest-1');

    expect(view.contestId).toBe('contest-1');
    expect(view.referenceGameId).toBe('GAME-1');
    // Provider-namey SDK fields must NOT be present on the view (DESIGN §16):
    expect((view as unknown as Record<string, unknown>).jsonoddsId).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).rundownId).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).sportspageId).toBeUndefined();

    expect(view.speculations).toHaveLength(2);
    expect(view.speculations[0]).toEqual({
      speculationId: 'spec-1',
      contestId: 'contest-1',
      marketType: 'moneyline',
      lineTicks: null,
      line: null,
      open: true,
    });
    expect(view.speculations[1]?.open).toBe(false);
    expect(view.speculations[1]?.marketType).toBe('spread');
  });

  it('referenceGameId is null when the contest has no upstream linkage', async () => {
    const adapter = adapterWith({ contests: { get: () => Promise.resolve(SAMPLE_CONTEST_NO_LINKAGE) } });
    const view = await adapter.getContest('contest-2');
    expect(view.referenceGameId).toBeNull();
    expect(view.speculations).toEqual([]);
  });

  it('listContests maps every contest', async () => {
    const adapter = adapterWith({
      contests: { list: () => Promise.resolve([SAMPLE_CONTEST, SAMPLE_CONTEST_NO_LINKAGE]) },
    });
    const list = await adapter.listContests();
    expect(list).toHaveLength(2);
    expect(list[0]?.referenceGameId).toBe('GAME-1');
    expect(list[1]?.referenceGameId).toBeNull();
  });

  it('listSpeculations passes options through and maps the result', async () => {
    let received: unknown = null;
    const adapter = adapterWith({
      speculations: {
        list: (options) => {
          received = options;
          return Promise.resolve([SAMPLE_SPECULATION_MONEYLINE]);
        },
      },
    });
    const result = await adapter.listSpeculations({ contestId: 'contest-1', status: 'open' });
    expect(received).toEqual({ contestId: 'contest-1', status: 'open' });
    expect(result).toEqual([
      {
        speculationId: 'spec-1',
        contestId: 'contest-1',
        marketType: 'moneyline',
        lineTicks: null,
        line: null,
        open: true,
      },
    ]);
  });
});

describe('OspexAdapter — odds (snapshot + subscribe)', () => {
  it('getOddsSnapshot renames jsonoddsId → referenceGameId and passes inner per-market shapes through', async () => {
    const adapter = adapterWith({ odds: { snapshot: () => Promise.resolve(SAMPLE_ODDS), subscribe: () => Promise.resolve(FAKE_SUBSCRIPTION) } });
    const snap = await adapter.getOddsSnapshot('contest-1');
    expect(snap.contestId).toBe('contest-1');
    expect(snap.referenceGameId).toBe('GAME-1');
    expect((snap as unknown as Record<string, unknown>).jsonoddsId).toBeUndefined();
    expect(snap.odds.moneyline?.awayOddsAmerican).toBe(150);
    expect(snap.odds.moneyline?.homeOddsAmerican).toBe(-180);
    expect(snap.odds.spread).toBeNull();
    expect(snap.odds.total).toBeNull();
  });

  it('subscribeOdds maps referenceGameId → jsonoddsId in the SDK args and wraps the handlers', async () => {
    let capturedArgs: OddsSubscribeArgs | null = null;
    let capturedHandlers: OddsSubscribeHandlers | null = null;
    const adapter = adapterWith({
      odds: {
        snapshot: () => Promise.reject(new Error('unused')),
        subscribe: (args, handlers) => {
          capturedArgs = args;
          capturedHandlers = handlers;
          return Promise.resolve(FAKE_SUBSCRIPTION);
        },
      },
    });

    const onChange = vi.fn();
    const onRefresh = vi.fn();
    const onError = vi.fn();
    const sub = await adapter.subscribeOdds(
      { referenceGameId: 'GAME-1', market: 'moneyline' },
      { onChange, onRefresh, onError },
    );

    expect(capturedArgs).toEqual({ jsonoddsId: 'GAME-1', market: 'moneyline' });
    expect(sub).toBe(FAKE_SUBSCRIPTION);

    // The SDK fires onChange with an OddsSnapshot — the adapter remaps to OddsUpdateView (jsonoddsId → referenceGameId).
    capturedHandlers!.onChange(SAMPLE_ODDS_UPDATE);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toEqual({
      referenceGameId: 'GAME-1',
      market: 'moneyline',
      network: 'polygon',
      line: null,
      awayOddsAmerican: 145,
      homeOddsAmerican: -175,
      upstreamLastUpdated: '2026-05-11T20:01:00Z',
      pollCapturedAt: '2026-05-11T20:01:30Z',
      changedAt: '2026-05-11T20:01:00Z',
    });

    // onRefresh is passed through, mapped.
    capturedHandlers!.onRefresh!(SAMPLE_ODDS_UPDATE);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh.mock.calls[0]?.[0]).toMatchObject({ referenceGameId: 'GAME-1', awayOddsAmerican: 145 });

    // onError is passed through as a direct reference (no wrapping needed — it doesn't carry SDK types).
    expect(capturedHandlers!.onError).toBe(onError);
  });

  it('subscribeOdds omits onRefresh / onError when the caller didn\'t pass them (exactOptionalPropertyTypes)', async () => {
    let capturedHandlers: OddsSubscribeHandlers | null = null;
    const adapter = adapterWith({
      odds: {
        snapshot: () => Promise.reject(new Error('unused')),
        subscribe: (_args, handlers) => {
          capturedHandlers = handlers;
          return Promise.resolve(FAKE_SUBSCRIPTION);
        },
      },
    });
    await adapter.subscribeOdds({ referenceGameId: 'G', market: 'moneyline' }, { onChange: () => {} });
    expect(capturedHandlers!.onRefresh).toBeUndefined();
    expect(capturedHandlers!.onError).toBeUndefined();
  });
});

// ── commitment / position / balance / approval / health passthroughs ─────────

describe('OspexAdapter — passthroughs', () => {
  it('listOpenCommitments bakes in status=[open, partially_filled] + caller-supplied limit (DESIGN §10 + §14)', async () => {
    let received: unknown = null;
    const adapter = adapterWith({
      commitments: {
        list: (options) => {
          received = options;
          return Promise.resolve([SAMPLE_COMMITMENT]);
        },
      },
    });
    const out = await adapter.listOpenCommitments('0xMaker', 25);
    expect(received).toEqual({ maker: '0xMaker', status: ['open', 'partially_filled'], limit: 25 });
    expect(out).toEqual([SAMPLE_COMMITMENT]);
  });

  it('getCommitment forwards the hash and returns the SDK Commitment unchanged', async () => {
    let received: unknown = null;
    const adapter = adapterWith({
      commitments: {
        list: () => Promise.reject(new Error('unused')),
        get: (h) => {
          received = h;
          return Promise.resolve(SAMPLE_COMMITMENT);
        },
      },
    });
    const c = await adapter.getCommitment('0xabc');
    expect(received).toBe('0xabc');
    expect(c).toBe(SAMPLE_COMMITMENT);
  });

  it('getPositionStatus forwards the owner and returns the SDK PositionStatus unchanged', async () => {
    let received: unknown = null;
    const adapter = adapterWith({
      positions: {
        status: (addr) => {
          received = addr;
          return Promise.resolve(EMPTY_POSITION_STATUS);
        },
        byAddress: () => Promise.reject(new Error('unused')),
      },
    });
    const status = await adapter.getPositionStatus('0xMaker');
    expect(received).toBe('0xMaker');
    expect(status).toBe(EMPTY_POSITION_STATUS);
  });

  it('readBalances / readApprovals pass owner=… (signer-free, no passphrase prompt)', async () => {
    let bArgs: unknown = null;
    let aArgs: unknown = null;
    const adapter = adapterWith({
      balances: {
        read: (args) => {
          bArgs = args;
          return Promise.resolve(SAMPLE_BALANCES);
        },
      },
      approvals: {
        read: (args) => {
          aArgs = args;
          return Promise.resolve(SAMPLE_APPROVALS);
        },
      },
    });
    expect(await adapter.readBalances('0x1111111111111111111111111111111111111111')).toBe(SAMPLE_BALANCES);
    expect(bArgs).toEqual({ owner: '0x1111111111111111111111111111111111111111' });
    expect(await adapter.readApprovals('0x1111111111111111111111111111111111111111')).toBe(SAMPLE_APPROVALS);
    expect(aArgs).toEqual({ owner: '0x1111111111111111111111111111111111111111' });
  });

  it('checkApiHealth resolves true on a successful health.check and false on any rejection (never throws)', async () => {
    const okAdapter = adapterWith({ health: { check: () => Promise.resolve({ status: 'ok' } as unknown as never) } });
    expect(await okAdapter.checkApiHealth()).toBe(true);

    const failAdapter = adapterWith({ health: { check: () => Promise.reject(new Error('boom')) } });
    expect(await failAdapter.checkApiHealth()).toBe(false);
  });

  it('addresses() returns the deployed address book for the configured chain', () => {
    const mainnet = adapterWith();
    expect(mainnet.addresses().usdc.toLowerCase()).toBe('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    expect(mainnet.addresses().scorers.moneyline.toLowerCase()).toMatch(/^0x[0-9a-f]{40}$/);

    const amoy = new OspexAdapter(makeFakeClient(), { chainId: 80002, apiUrl: 'https://api.test' });
    expect(amoy.addresses().usdc.toLowerCase()).toBe('0xb1d1c0a8cc8bb165b34735972e798f64a785eaf8');
  });
});

// ── createOspexAdapter factory ───────────────────────────────────────────────

describe('createOspexAdapter', () => {
  it('builds an adapter for a minimal config, defaulting apiUrl to the SDK production URL', () => {
    const config = parseConfig({ rpcUrl: 'http://localhost:8545' });
    const adapter = createOspexAdapter(config);
    expect(adapter.chainId).toBe(137);
    expect(adapter.apiUrl).toBe(DEFAULT_API_URL);
  });

  it('honours an explicit apiUrl', () => {
    const config = parseConfig({ rpcUrl: 'http://localhost:8545', apiUrl: 'https://my-api.test' });
    const adapter = createOspexAdapter(config);
    expect(adapter.apiUrl).toBe('https://my-api.test');
  });

  it('honours an amoy chainId', () => {
    const config = parseConfig({ rpcUrl: 'http://localhost:8545', chainId: 80002 });
    const adapter = createOspexAdapter(config);
    expect(adapter.chainId).toBe(80002);
  });
});

// ── readKeystoreAddress — cheap-path address read ────────────────────────────

describe('readKeystoreAddress', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-keystore-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the lowercased 0x-prefixed address for an ethers-style keystore', () => {
    const path = join(dir, 'ks.json');
    writeFileSync(path, JSON.stringify({ address: 'AbCdEf0123456789AbCdEf0123456789AbCdEf01', crypto: { dummy: true }, version: 3 }), 'utf8');
    expect(readKeystoreAddress(path)).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('accepts an already-0x-prefixed address', () => {
    const path = join(dir, 'ks.json');
    writeFileSync(path, JSON.stringify({ address: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' }), 'utf8');
    expect(readKeystoreAddress(path)).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('returns null for a Foundry-style keystore (no `address` field)', () => {
    const path = join(dir, 'foundry.json');
    writeFileSync(path, JSON.stringify({ crypto: { ciphertext: 'whatever' }, version: 3 }), 'utf8');
    expect(readKeystoreAddress(path)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(readKeystoreAddress(join(dir, 'does-not-exist.json'))).toBeNull();
  });

  it('returns null for non-JSON content', () => {
    const path = join(dir, 'garbage.json');
    writeFileSync(path, 'this is not json', 'utf8');
    expect(readKeystoreAddress(path)).toBeNull();
  });

  it('returns null for a malformed address field (wrong length / non-hex)', () => {
    const tooShort = join(dir, 'short.json');
    writeFileSync(tooShort, JSON.stringify({ address: 'deadbeef' }), 'utf8');
    expect(readKeystoreAddress(tooShort)).toBeNull();

    const nonHex = join(dir, 'nonhex.json');
    writeFileSync(nonHex, JSON.stringify({ address: 'g'.repeat(40) }), 'utf8');
    expect(readKeystoreAddress(nonHex)).toBeNull();
  });
});
