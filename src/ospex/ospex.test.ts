import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { DEFAULT_API_URL } from '@ospex/sdk';
import type {
  ApprovalsSnapshot,
  BalancesSnapshot,
  Commitment,
  Contest,
  ContestOddsSnapshot,
  Hex,
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  PositionStatus,
  Signer,
  Speculation,
  SpeculationDetail,
  Subscription,
} from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';

import {
  OspexAdapter,
  createLiveOspexAdapter,
  createOspexAdapter,
  readKeystoreAddress,
  unlockKeystoreSigner,
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

const SAMPLE_SPECULATION_DETAIL: SpeculationDetail = {
  ...SAMPLE_SPECULATION_MONEYLINE,
  orderbook: [SAMPLE_COMMITMENT],
  contest: {
    contestId: 'contest-1',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    awayTeamId: null,
    homeTeamId: null,
    sport: 'mlb',
    matchTime: '2026-05-12T01:30:00Z',
    status: 'verified',
  },
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
    commitments: {
      list: notStubbed('commitments.list'),
      get: notStubbed('commitments.get'),
      submitRaw: notStubbed('commitments.submitRaw'),
      cancel: notStubbed('commitments.cancel'),
      cancelOnchain: notStubbed('commitments.cancelOnchain'),
      raiseMinNonce: notStubbed('commitments.raiseMinNonce'),
      approve: notStubbed('commitments.approve'),
      getNonceFloor: notStubbed('commitments.getNonceFloor'),
      ...overrides.commitments,
    },
    positions: {
      status: notStubbed('positions.status'),
      byAddress: notStubbed('positions.byAddress'),
      settleSpeculation: notStubbed('positions.settleSpeculation'),
      claim: notStubbed('positions.claim'),
      claimAll: notStubbed('positions.claimAll'),
      ...overrides.positions,
    },
    balances: { read: notStubbed('balances.read'), ...overrides.balances },
    approvals: { read: notStubbed('approvals.read'), ...overrides.approvals },
    health: { check: notStubbed('health.check'), ...overrides.health },
    odds: { snapshot: notStubbed('odds.snapshot'), subscribe: notStubbed('odds.subscribe'), ...overrides.odds },
  };
}

const FAKE_CTX = { chainId: 137 as const, apiUrl: 'https://api.test' };

function adapterWith(overrides: DeepPartial<OspexClientLike> = {}): OspexAdapter {
  return new OspexAdapter(makeFakeClient(overrides), FAKE_CTX);
}

/** A minimal `Signer` fake — deterministic address, dummy signatures (the adapter never inspects them). */
function fakeSigner(address: Hex = '0x9999999999999999999999999999999999999999'): Signer {
  return {
    getAddress: () => Promise.resolve(address),
    signTypedData: () => Promise.resolve('0xsignature' as Hex),
    signTransaction: () => Promise.resolve('0xsignedtx' as Hex),
  };
}

/** An adapter built with a signer attached — `isLive()` is true, the write wrappers reach the (overridable) fake client. */
function liveAdapterWith(overrides: DeepPartial<OspexClientLike> = {}, signer: Signer = fakeSigner()): OspexAdapter {
  return new OspexAdapter(makeFakeClient(overrides), { ...FAKE_CTX, signer });
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

  it('listSpeculations passes options through and maps the result (lean — no orderbook on list rows)', async () => {
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
    expect(result[0]?.orderbook).toBeUndefined();
  });

  it('getSpeculation returns the speculation with its orderbook populated (and maps speculationStatus → open)', async () => {
    let received: unknown = null;
    const adapter = adapterWith({
      speculations: {
        get: (specId) => {
          received = specId;
          return Promise.resolve(SAMPLE_SPECULATION_DETAIL);
        },
      },
    });
    const view = await adapter.getSpeculation('spec-1');
    expect(received).toBe('spec-1');
    expect(view).toEqual({
      speculationId: 'spec-1',
      contestId: 'contest-1',
      marketType: 'moneyline',
      lineTicks: null,
      line: null,
      open: true,
      orderbook: [SAMPLE_COMMITMENT],
    });
  });

  it('getContest carries orderbook on the embedded speculations the detail endpoint populated; leaves it absent otherwise', async () => {
    const contestWithOrderbooks: Contest = {
      ...SAMPLE_CONTEST,
      speculations: [{ ...SAMPLE_SPECULATION_MONEYLINE, orderbook: [SAMPLE_COMMITMENT] }, SAMPLE_SPECULATION_CLOSED],
    };
    const adapter = adapterWith({ contests: { get: () => Promise.resolve(contestWithOrderbooks) } });
    const view = await adapter.getContest('contest-1');
    expect(view.speculations[0]?.orderbook).toEqual([SAMPLE_COMMITMENT]);
    expect(view.speculations[1]?.orderbook).toBeUndefined(); // SAMPLE_SPECULATION_CLOSED has no orderbook in the SDK shape
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

// ── createLiveOspexAdapter — the signed factory ──────────────────────────────

describe('createLiveOspexAdapter', () => {
  it('builds a live adapter: isLive() true, makerAddress() resolves to the signer\'s address', async () => {
    const adapter = createLiveOspexAdapter(
      parseConfig({ rpcUrl: 'http://localhost:8545' }),
      fakeSigner('0xabc0000000000000000000000000000000000abc'),
    );
    expect(adapter.isLive()).toBe(true);
    expect(await adapter.makerAddress()).toBe('0xabc0000000000000000000000000000000000abc');
  });

  it('honours apiUrl / chainId like the read-only factory', () => {
    const a = createLiveOspexAdapter(parseConfig({ rpcUrl: 'http://localhost:8545' }), fakeSigner());
    expect(a.apiUrl).toBe(DEFAULT_API_URL);
    expect(a.chainId).toBe(137);

    const b = createLiveOspexAdapter(
      parseConfig({ rpcUrl: 'http://localhost:8545', apiUrl: 'https://my-api.test', chainId: 80002 }),
      fakeSigner(),
    );
    expect(b.apiUrl).toBe('https://my-api.test');
    expect(b.chainId).toBe(80002);
  });
});

// ── signer / live-mode identity ──────────────────────────────────────────────

describe('OspexAdapter — signer / live mode', () => {
  it('a read-only adapter: isLive() false, makerAddress() throws', async () => {
    const adapter = adapterWith();
    expect(adapter.isLive()).toBe(false);
    await expect(adapter.makerAddress()).rejects.toThrow(/no signer attached/);
  });

  it('a live adapter: isLive() true, makerAddress() returns the signer\'s address', async () => {
    const adapter = liveAdapterWith({}, fakeSigner('0x1234123412341234123412341234123412341234'));
    expect(adapter.isLive()).toBe(true);
    expect(await adapter.makerAddress()).toBe('0x1234123412341234123412341234123412341234');
  });
});

// ── write surface — thin SDK passthroughs (live) ─────────────────────────────

describe('OspexAdapter — write surface', () => {
  it('submitCommitment forwards the protocol tuple to commitments.submitRaw and returns its result', async () => {
    let received: unknown = null;
    const result = { hash: '0xdeadbeef' as Hex, commitment: SAMPLE_COMMITMENT };
    const adapter = liveAdapterWith({
      commitments: {
        submitRaw: (args) => {
          received = args;
          return Promise.resolve(result);
        },
      },
    });
    const args = {
      contestId: 1234n,
      scorer: '0x2222222222222222222222222222222222222222' as Hex,
      lineTicks: 0,
      positionType: 1 as const,
      oddsTick: 202,
      riskAmount: 250_000n,
    };
    expect(await adapter.submitCommitment(args)).toBe(result);
    expect(received).toEqual(args);
  });

  it('cancelCommitmentOffchain forwards the hash to commitments.cancel and resolves void', async () => {
    let received: unknown = null;
    const adapter = liveAdapterWith({
      commitments: {
        cancel: (h) => {
          received = h;
          return Promise.resolve({ ok: true as const });
        },
      },
    });
    await expect(adapter.cancelCommitmentOffchain('0xabc')).resolves.toBeUndefined();
    expect(received).toBe('0xabc');
  });

  it('cancelCommitmentOnchain forwards the hash to commitments.cancelOnchain and returns its result', async () => {
    let received: unknown = null;
    const result = { txHash: '0xtx' as Hex, receipt: {} as unknown as never, commitmentHash: '0xabc' as Hex };
    const adapter = liveAdapterWith({
      commitments: {
        cancelOnchain: (h) => {
          received = h;
          return Promise.resolve(result);
        },
      },
    });
    expect(await adapter.cancelCommitmentOnchain('0xabc')).toBe(result);
    expect(received).toBe('0xabc');
  });

  it('raiseMinNonce forwards { contestId, scorer, lineTicks, newMinNonce } to commitments.raiseMinNonce', async () => {
    let received: unknown = null;
    const result = { txHash: '0xtx' as Hex, receipt: {} as unknown as never };
    const adapter = liveAdapterWith({
      commitments: {
        raiseMinNonce: (args) => {
          received = args;
          return Promise.resolve(result);
        },
      },
    });
    const args = { contestId: 1234n, scorer: '0x2222222222222222222222222222222222222222' as Hex, lineTicks: 0, newMinNonce: 5n };
    expect(await adapter.raiseMinNonce(args)).toBe(result);
    expect(received).toEqual(args);
  });

  it('readMinNonceFloor forwards to commitments.getNonceFloor and returns the bigint floor', async () => {
    let received: unknown = null;
    const adapter = liveAdapterWith({
      commitments: {
        getNonceFloor: (args) => {
          received = args;
          return Promise.resolve(42n);
        },
      },
    });
    const args = {
      maker: '0x1111111111111111111111111111111111111111' as Hex,
      contestId: 1234n,
      scorer: '0x2222222222222222222222222222222222222222' as Hex,
      lineTicks: 0,
    };
    expect(await adapter.readMinNonceFloor(args)).toBe(42n);
    expect(received).toEqual(args);
  });

  it('approveUSDC forwards the amount to commitments.approve (exact wei6 and the "max" sentinel)', async () => {
    const received: unknown[] = [];
    const result = { txHash: '0xtx' as Hex, receipt: {} as unknown as never, spender: '0xpos', token: '0xusdc', amount: 5_000_000n };
    const adapter = liveAdapterWith({
      commitments: {
        approve: (amount) => {
          received.push(amount);
          return Promise.resolve(result);
        },
      },
    });
    expect(await adapter.approveUSDC(5_000_000n)).toBe(result);
    await adapter.approveUSDC('max');
    expect(received).toEqual([5_000_000n, 'max']);
  });

  it('settleSpeculation forwards { speculationId } to positions.settleSpeculation', async () => {
    let received: unknown = null;
    const result = { txHash: '0xtx' as Hex, blockNumber: 100n, winSide: 'home' as const, receipt: {} as unknown as never };
    const adapter = liveAdapterWith({
      positions: {
        settleSpeculation: (args) => {
          received = args;
          return Promise.resolve(result);
        },
      },
    });
    expect(await adapter.settleSpeculation({ speculationId: 7n })).toBe(result);
    expect(received).toEqual({ speculationId: 7n });
  });

  it('claimPosition forwards { speculationId, positionType } to positions.claim', async () => {
    let received: unknown = null;
    const result = { txHash: '0xtx' as Hex, blockNumber: 100n, payoutWei6: 500_000n, payoutUSDC: 0.5, receipt: {} as unknown as never };
    const adapter = liveAdapterWith({
      positions: {
        claim: (args) => {
          received = args;
          return Promise.resolve(result);
        },
      },
    });
    expect(await adapter.claimPosition({ speculationId: 7n, positionType: 0 })).toBe(result);
    expect(received).toEqual({ speculationId: 7n, positionType: 0 });
  });

  it('claimAll forwards its optional args (including undefined) to positions.claimAll', async () => {
    const received: unknown[] = [];
    const result = {
      address: '0x9999999999999999999999999999999999999999',
      success: true,
      entries: [],
      totals: { claimed: 0, failed: 0, totalPayoutWei6: '0', totalPayoutUSDC: 0 },
    };
    const adapter = liveAdapterWith({
      positions: {
        claimAll: (args) => {
          received.push(args);
          return Promise.resolve(result);
        },
      },
    });
    expect(await adapter.claimAll()).toBe(result);
    await adapter.claimAll({ opts: { dryRun: true } });
    expect(received).toEqual([undefined, { opts: { dryRun: true } }]);
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

// ── unlockKeystoreSigner — the real decrypt → Signer ─────────────────────────

describe('unlockKeystoreSigner', () => {
  // scrypt at ethers' default cost runs once per encrypt and once per decrypt
  // (~hundreds of ms each) — generous headroom for slower / CI hosts.
  const KDF_TIMEOUT_MS = 30_000;
  const PASSPHRASE = 'correct horse battery staple';

  let dir: string;
  let keystorePath: string;
  let expectedAddress: Hex;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-unlock-'));
    // Synthetic key generated at test time — never a real wallet (CLAUDE.md).
    const syntheticPk = `0x${randomBytes(32).toString('hex')}` as Hex;
    expectedAddress = await KeystoreSigner.fromPrivateKey(syntheticPk).getAddress();
    keystorePath = join(dir, 'keystore.json');
    writeFileSync(keystorePath, await KeystoreSigner.encrypt(syntheticPk, PASSPHRASE), 'utf8');
  }, KDF_TIMEOUT_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decrypts a v3 keystore with the right passphrase and returns a Signer whose address matches', async () => {
    const signer = await unlockKeystoreSigner(keystorePath, PASSPHRASE);
    expect(await signer.getAddress()).toBe(expectedAddress);
  }, KDF_TIMEOUT_MS);

  it('rejects on a wrong passphrase', async () => {
    await expect(unlockKeystoreSigner(keystorePath, 'wrong passphrase')).rejects.toThrow();
  }, KDF_TIMEOUT_MS);

  it('throws a clear error naming the path when the keystore file cannot be read', async () => {
    const missing = join(dir, 'does-not-exist.json');
    await expect(unlockKeystoreSigner(missing, PASSPHRASE)).rejects.toThrow(
      /unlockKeystoreSigner: cannot read keystore file at .+does-not-exist\.json/,
    );
  });

  it('rejects when the file is not valid keystore JSON', async () => {
    const garbage = join(dir, 'garbage.json');
    writeFileSync(garbage, 'definitely not json', 'utf8');
    await expect(unlockKeystoreSigner(garbage, PASSPHRASE)).rejects.toThrow();
  });
});
