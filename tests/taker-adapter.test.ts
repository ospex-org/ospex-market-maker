import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OspexClient, buildMatchPreview, getAddresses, type PublicVisibleCommitment, type Signer, type SignTransactionArgs } from '@ospex/sdk';
import { encodeAbiParameters, encodeEventTopics, keccak256, type TransactionReceipt, type Hex } from 'viem';
import { createTakerGateway, guardedSigner, matchEvents, quoteFromCommitment, receiptStake } from '../src/ospex/taker.js';
import { parseConfig } from '../src/taker/config.js';
import { evaluate } from '../src/taker/policy.js';
import type { Attempt } from '../src/taker/store.js';

// Mock transports and invalid signing bytes only. No wallet or network is used.
const m = vi.hoisted(() => ({
  commitments: { list: vi.fn(), get: vi.fn(), getFilledRisk: vi.fn(), prepareMatch: vi.fn(), matchFromPreview: vi.fn() },
  odds: { snapshot: vi.fn() }, approvals: { read: vi.fn() },
  rpc: { getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn() },
}));
vi.mock('@ospex/sdk', async original => ({ ...await original<typeof import('@ospex/sdk')>(), OspexClient: vi.fn(function () { return m; }) }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: vi.fn(() => m.rpc) }));
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const now = Date.parse('2026-10-15T12:00:00Z');
const c = parseConfig({ schemaVersion: 1, mode: { dryRun: false }, chainId: 137, apiUrl: 'https://example.invalid', rpcUrl: 'https://example.invalid', wallet: { address: `0x${'1'.repeat(40)}`, keystorePath: 'no-wallet' }, makers: [{ address: `0x${'2'.repeat(40)}`, label: 'synthetic maker', controller: 'outside test' }], houseWallets: [{ address: `0x${'3'.repeat(40)}`, label: 'synthetic house', controller: 'house test' }], capUSDC: '1', distancePp: 0, minSecondsLeft: 30, pollIntervalMs: 100, stateDir: './not-used' });
const addresses = getAddresses(c.chainId);
const commitment = (): PublicVisibleCommitment => ({ visibility: 'visible', redacted: false, commitmentHash: h(1), maker: c.makers[0]!.address, contestId: '15', scorer: addresses.scorers.moneyline, lineTicks: 0, positionType: 0, oddsTick: 200, marketType: 'moneyline', riskAmount: '1000000', filledRiskAmount: '0', remainingRiskAmount: '1000000', nonce: '7', expiry: '2026-10-15T13:00:00Z', speculationKey: h(30), signature: '0xdead', status: 'open', storedStatus: 'open', source: 'test', network: 'polygon', nonceInvalidated: false, isLive: true, createdAt: '2026-10-15T10:00:00Z' });
const ref = { contestId: '15', market: 'moneyline' as const, awayOddsAmerican: -110, homeOddsAmerican: -110, upstreamLastUpdated: '2026-10-15T04:00:00Z', pollCapturedAt: '2026-10-15T04:00:00Z', changedAt: '2026-10-15T04:00:00Z' };
function preview(row = commitment()) {
  // The REAL published SDK producer computes these economics, not our fixture.
  return buildMatchPreview({ commitment: row, chainId: c.chainId, matchingModuleAddress: addresses.matchingModule, taker: c.wallet.address as Hex,
    awayTeam: 'Synthetic away', homeTeam: 'Synthetic home', awayTeamId: null, homeTeamId: null, sport: 'NBA', matchTime: '2026-10-16T12:00:00Z',
    speculation: { mode: 'existing', speculationId: '77' }, speculationKey: h(30), speculationCreationTotalFeeWei6: 0n,
    takerTreasuryAllowanceWei6: 0n, makerTreasuryAllowanceWei6: 0n, treasuryModuleAddress: addresses.treasuryModule,
    positionModuleAddress: addresses.positionModule, takerPositionAllowanceWei6: 1_000_000n, nowUnixSec: BigInt(now / 1000) });
}
function attempt(): Attempt {
  const q = quoteFromCommitment(commitment());
  return { decision: { type: 'decision', id: 'a', at: new Date(now).toISOString(), dryRun: false, quote: q, reference: ref, decision: evaluate(q, ref, c, now, 0n), makerLabel: 'test', makerController: 'test', capWei6: '1000000', distanceLimitPp: c.distancePp, txHash: null, submissionAt: null, receiptAt: null }, signed: { type: 'signed', id: 'a', at: new Date(now).toISOString(), txHash: h(101), nonce: 1, submissionAt: new Date(now).toISOString() } };
}
function receipt(event: Partial<{ maker: Hex; lineTicks: number; makerSide: number; makerRisk: bigint; takerRisk: bigint }> = {}): TransactionReceipt {
  const topics = encodeEventTopics({ abi: matchEvents, eventName: 'CommitmentMatched', args: { commitmentHash: h(1), maker: event.maker ?? c.makers[0]!.address as Hex, taker: c.wallet.address as Hex } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'int32' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [15n, 77n, addresses.scorers.moneyline, event.lineTicks ?? 0, event.makerSide ?? 0, 200, event.makerRisk ?? 1_000_000n, event.takerRisk ?? 1_000_000n, 1_000_000n, 7n, 1_792_069_200n]);
  return { status: 'success', transactionHash: h(101), blockHash: h(200), blockNumber: 100n, from: c.wallet.address as Hex, to: addresses.matchingModule,
    logs: [{ address: addresses.matchingModule, data, topics, transactionHash: h(101), blockHash: h(200), blockNumber: 100n, transactionIndex: 0, logIndex: 0, removed: false }] } as TransactionReceipt;
}
beforeEach(() => {
  vi.clearAllMocks(); m.rpc.getChainId.mockResolvedValue(137);
  m.rpc.getTransaction.mockReset();
  m.commitments.list.mockResolvedValue([commitment()]); m.commitments.get.mockResolvedValue(commitment());
  m.commitments.getFilledRisk.mockResolvedValue({ atBlock: 100n, filledRisk: new Map([[h(1), 0n]]) });
  m.commitments.prepareMatch.mockImplementation(async ({ commitment: row }) => preview(row));
  m.odds.snapshot.mockResolvedValue({ contestId: '15', odds: { moneyline: ref, spread: null, total: null } });
  m.approvals.read.mockResolvedValue({ chainId: 137, owner: c.wallet.address, usdc: { allowances: { positionModule: { raw: 1_000_000n }, treasuryModule: { raw: 0n } } } });
  m.rpc.getTransactionReceipt.mockResolvedValue(receipt());
  m.rpc.getBlock.mockImplementation(async ({ blockTag }) => blockTag === 'finalized' ? { number: 100n } : { number: 100n, hash: h(200), timestamp: 1_792_065_601n });
});

describe('published SDK producer and taker adapter', () => {
  it('binds the receipt decoder to the published SDK ABI, not just our own fixture encoder', () => {
    const published = JSON.parse(readFileSync(new URL('../node_modules/@ospex/sdk/dist/contracts/abi/MatchingModule.json', import.meta.url), 'utf8'));
    const event = published.abi.find((e: { type: string; name?: string }) => e.type === 'event' && e.name === 'CommitmentMatched');
    expect(event).toBeDefined();
    expect(event.inputs.map((i: { name: string; type: string; indexed: boolean }) => ({ name: i.name, type: i.type, indexed: i.indexed }))).toEqual(matchEvents[0].inputs.map(i => ({ name: i.name, type: i.type, indexed: 'indexed' in i && i.indexed === true })));
  });
  it.each([101, 150, 200, 325, 10000])('agrees with real SDK full-size economics and taker side at tick %s', tick => {
    const row = { ...commitment(), oddsTick: tick }; const p = preview(row); const q = quoteFromCommitment(p.commitment);
    const d = evaluate(q, ref, { ...c, capUSDC: '100' }, now, 0n);
    expect(d.stakeWei6).toBe(p.economics.takerRiskWei6); expect(q.remainingMakerWei6).toBe(p.economics.fillMakerRiskWei6);
    expect(d.bettorSide).toBe(p.takerSide.role); expect(d.bettorDecimal).toBeCloseTo(tick / (tick - 100), 12);
  });
  it('lists only explicitly configured maker requests and deduplicates quote hashes', async () => {
    const g = createTakerGateway(c); m.commitments.list.mockResolvedValue([commitment(), commitment()]);
    expect(await g.book()).toHaveLength(1); expect(m.commitments.list).toHaveBeenCalledWith({ maker: c.makers[0]!.address, status: ['open', 'partially_filled'], limit: 100, offset: 0 });
  });
  it('overrides indexer remaining with chain capacity and uses full-size SDK preview', async () => {
    m.commitments.getFilledRisk.mockResolvedValue({ atBlock: 100n, filledRisk: new Map([[h(1), 200_000n]]) });
    const p = await createTakerGateway(c).prepare(quoteFromCommitment(commitment()));
    expect(p.quote.remainingMakerWei6).toBe('800000');
    const args = m.commitments.prepareMatch.mock.calls[0]![0]; expect(args).not.toHaveProperty('takerDesiredRiskWei6');
    expect(args.commitment.remainingRiskAmount).toBe('800000');
    await expect(p.sign({ beforeSign: vi.fn(), signed: vi.fn() })).rejects.toThrow('cannot sign');
    expect(m.commitments.matchFromPreview).not.toHaveBeenCalled();
  });
  it('rejects changed chain, scorer, zero/missing capacity and partial preview', async () => {
    const g = createTakerGateway(c); const q = quoteFromCommitment(commitment());
    m.rpc.getChainId.mockResolvedValueOnce(80002); await expect(g.prepare(q)).rejects.toThrow('chain');
    m.commitments.get.mockResolvedValueOnce({ ...commitment(), scorer: addresses.scorers.spread }); await expect(g.prepare(q)).rejects.toThrow('exact-market');
    m.commitments.getFilledRisk.mockResolvedValueOnce({ atBlock: 100n, filledRisk: new Map() }); await expect(g.prepare(q)).rejects.toThrow('capacity');
    const p = preview(); m.commitments.prepareMatch.mockResolvedValueOnce({ ...p, economics: { ...p.economics, fillMakerRiskWei6: '500000' } }); await expect(g.prepare(q)).rejects.toThrow('full-size');
  });
  it('preserves raw posted reference values/timestamps and refuses excessive or insufficient allowance without approval writes', async () => {
    const g = createTakerGateway(c); expect(await g.reference(quoteFromCommitment(commitment()))).toEqual(ref);
    expect(await g.allowance(1_000_000n, 0n)).toBe(true);
    for (const [position, treasury, spent, expected] of [[1_000_001n, 0n, 0n, false], [999_999n, 0n, 0n, false], [1_000_000n, 1_000_001n, 0n, false], [500_000n, 0n, 500_000n, true]] as const) {
      m.approvals.read.mockResolvedValueOnce({ chainId: 137, owner: c.wallet.address, usdc: { allowances: { positionModule: { raw: position }, treasuryModule: { raw: treasury } } } });
      expect(await g.allowance(500_000n, spent)).toBe(expected);
    }
  });
  it('rejects position allowance above cap after spend independently of the initial exact-cap guard', async () => {
    const g = createTakerGateway(c);
    // Nonzero spend bypasses the initial position === cap clause. Everything
    // except the upper position allowance bound is valid in the negative case.
    for (const [position, expected] of [[1_000_000n, true], [500_000n, true], [1_000_001n, false]] as const) {
      m.approvals.read.mockResolvedValueOnce({ chainId: 137, owner: c.wallet.address, usdc: { allowances: { positionModule: { raw: position }, treasuryModule: { raw: 0n } } } });
      expect(await g.allowance(500_000n, 500_000n)).toBe(expected);
    }
    expect(m.commitments.matchFromPreview).not.toHaveBeenCalled();
  });
});

describe('signed authority handoff', () => {
  const tx: SignTransactionArgs = { to: addresses.matchingModule, chainId: 137, nonce: 1, data: '0xdead' };
  function setup() {
    const order: string[] = [];
    const signer: Signer = { getAddress: async () => c.wallet.address as Hex, signTypedData: vi.fn(), signTransaction: vi.fn(async () => { order.push('sign'); return '0xdead' as Hex; }) };
    const hooks = { beforeSign: vi.fn(async () => { order.push('reference-and-reserve'); }), signed: vi.fn((_hash: string, _nonce: number, _at: string) => { order.push('persist-hash'); }) };
    const guarded = guardedSigner(signer, c, quoteFromCommitment(commitment()), hooks, async () => { order.push('capacity'); });
    return { order, signer, hooks, guarded };
  }
  it('does capacity, one last decision/reservation, signing, and durable hash in order before returning bytes', async () => {
    const s = setup(); expect(await s.guarded.signTransaction(tx)).toBe('0xdead');
    expect(s.order).toEqual(['capacity', 'reference-and-reserve', 'sign', 'persist-hash']);
    expect(s.hooks.signed.mock.calls[0]![0]).toBe(keccak256('0xdead'));
    await expect(s.guarded.signTransaction(tx)).rejects.toThrow('Unexpected');
  });
  it('never returns signed bytes if hash persistence fails', async () => {
    const s = setup(); s.hooks.signed.mockImplementation(() => { throw new Error('disk failure'); });
    await expect(s.guarded.signTransaction(tx)).rejects.toThrow('disk failure');
    expect(s.signer.signTransaction).toHaveBeenCalledTimes(1);
  });
  it('does not sign a failed decision, wrong chain/target/value, or wrong wallet', async () => {
    const s = setup(); s.hooks.beforeSign.mockRejectedValueOnce(new Error('pass'));
    await expect(s.guarded.signTransaction(tx)).rejects.toThrow('pass'); expect(s.signer.signTransaction).not.toHaveBeenCalled();
    for (const other of [{ ...tx, chainId: 80002 }, { ...tx, to: c.wallet.address as Hex }, { ...tx, value: 1n }]) {
      const a = setup(); await expect(a.guarded.signTransaction(other)).rejects.toThrow('Unexpected'); expect(a.signer.signTransaction).not.toHaveBeenCalled();
    }
    const b = setup(); b.signer.getAddress = async () => c.makers[0]!.address as Hex;
    await expect(b.guarded.signTransaction(tx)).rejects.toThrow('wallet'); expect(b.signer.signTransaction).not.toHaveBeenCalled();
  });
});

describe('exact final receipt binding', () => {
  it('rejects a different event maker with every other receipt field valid', () => {
    expect(receiptStake(receipt(), attempt(), c)).toBe(1_000_000n);
    expect(receiptStake(receipt({ maker: c.houseWallets[0]!.address as Hex }), attempt(), c)).toBeNull();
  });
  it('rejects a different event side with every other receipt field valid', () => {
    expect(receiptStake(receipt(), attempt(), c)).toBe(1_000_000n);
    expect(receiptStake(receipt({ makerSide: 1 }), attempt(), c)).toBeNull();
  });
  it('rejects a different event line with every other receipt field valid', () => {
    expect(receiptStake(receipt(), attempt(), c)).toBe(1_000_000n);
    expect(receiptStake(receipt({ lineTicks: 1 }), attempt(), c)).toBeNull();
  });
  it('rejects incorrect stake formula within both positive risk and reservation bounds', () => {
    expect(receiptStake(receipt({ makerRisk: 800_000n, takerRisk: 800_000n }), attempt(), c)).toBe(800_000n);
    // Only the formula differs: both risks remain positive and below their caps.
    expect(receiptStake(receipt({ makerRisk: 800_000n, takerRisk: 799_999n }), attempt(), c)).toBeNull();
  });
  it('decodes an exact-match receipt and rejects unrelated hashes, sender, target and event emitter', () => {
    const a = attempt(); const r = receipt(); expect(receiptStake(r, a, c)).toBe(1_000_000n);
    expect(receiptStake({ ...r, transactionHash: h(102) }, a, c)).toBeNull();
    expect(receiptStake({ ...r, from: c.makers[0]!.address as Hex }, a, c)).toBeNull();
    expect(receiptStake({ ...r, to: addresses.positionModule }, a, c)).toBeNull();
    expect(receiptStake({ ...r, logs: [{ ...r.logs[0]!, address: addresses.positionModule }] }, a, c)).toBeNull();
    expect(receiptStake({ ...r, logs: [r.logs[0]!, r.logs[0]!] }, a, c)).toBeNull();
    a.decision.quote.contestId = '16'; expect(receiptStake(r, a, c)).toBeNull();
  });
  it('only releases a proven reverted receipt, never a success lacking the exact event', () => {
    expect(receiptStake({ ...receipt(), status: 'reverted', logs: [] }, attempt(), c)).toBe(0n);
    expect(receiptStake({ ...receipt(), logs: [] }, attempt(), c)).toBeNull();
  });
  it('holds nonfinal/orphaned receipts; final receipt preserves block and acquisition times', async () => {
    const g = createTakerGateway(c); const a = attempt();
    m.rpc.getBlock.mockResolvedValueOnce({ number: 99n }); expect(await g.receipt(a)).toBeNull();
    m.rpc.getBlock.mockResolvedValueOnce({ number: 100n }).mockResolvedValueOnce({ number: 100n, hash: h(201) }); expect(await g.receipt(a)).toBeNull();
    const out = await g.receipt(a); expect(out?.stakeWei6).toBe('1000000'); expect(out?.blockHash).toBe(h(200)); expect(out?.blockNumber).toBe('100'); expect(Number.isFinite(Date.parse(out!.receiptAt))).toBe(true);
  });
});

describe('signer-free finalized replacement proof', () => {
  // Synthetic read models, never signed transactions or captured wallet data.
  function transaction() {
    return { chainId: 137, hash: h(102), from: c.wallet.address as Hex, to: c.wallet.address as Hex,
      nonce: 1, value: 0n, input: '0x', blockNumber: 100n, blockHash: h(200), transactionIndex: 0 };
  }
  function replacementReceipt(): TransactionReceipt {
    return { ...receipt(), transactionHash: h(102), to: c.wallet.address as Hex, transactionIndex: 0, logs: [] };
  }
  function block(number: bigint) {
    if (number === 100n) return { number, hash: h(200), transactions: [h(102)] };
    if (number === 120n) return { number, hash: h(220), transactions: [] };
    throw new Error('Unexpected synthetic block request.');
  }
  beforeEach(() => {
    m.rpc.getTransaction.mockResolvedValue(transaction());
    m.rpc.getTransactionReceipt.mockReset().mockResolvedValue(replacementReceipt());
    m.rpc.getBlock.mockReset().mockImplementation(async ({ blockTag, blockNumber }) => block(blockTag === 'finalized' ? 120n : blockNumber));
  });
  it('returns exact proof for a canonical finalized same-nonce different-hash self-transfer without a signer', async () => {
    const g = createTakerGateway(c);
    expect(await g.replacementProof(attempt(), h(102))).toEqual({
      kind: 'replaced', chainId: 137, wallet: c.wallet.address, nonce: 1, txHash: h(101), replacementHash: h(102),
      blockNumber: '100', blockHash: h(200), finalizedBlockNumber: '120', finalizedBlockHash: h(220),
    });
    expect(m.rpc.getTransaction).toHaveBeenCalledExactlyOnceWith({ hash: h(102) });
    expect(m.rpc.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: h(102) });
    expect(m.rpc.getBlock.mock.calls.map(([args]) => args)).toEqual([{ blockTag: 'finalized' }, { blockNumber: 100n }, { blockNumber: 120n }]);
    expect(vi.mocked(OspexClient)).toHaveBeenCalledExactlyOnceWith({ chainId: 137, apiUrl: c.apiUrl, rpcUrl: c.rpcUrl });
    expect(m.commitments.matchFromPreview).not.toHaveBeenCalled();
    expect(m.approvals.read).not.toHaveBeenCalled();
  });
  it('accepts inclusion at the finalized height itself', async () => {
    m.rpc.getBlock.mockImplementation(async () => block(100n));
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toMatchObject({ blockNumber: '100', finalizedBlockNumber: '100', finalizedBlockHash: h(200) });
  });
  it('holds unsigned attempts without making chain reads', async () => {
    expect(await createTakerGateway(c).replacementProof({ decision: attempt().decision }, h(102))).toBeNull();
    expect(m.rpc.getChainId).not.toHaveBeenCalled(); expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it.each([h(101), '0x1234', 'not-a-hash'])('holds same or malformed replacement hash %s', async hash => {
    expect(await createTakerGateway(c).replacementProof(attempt(), hash)).toBeNull();
    expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('compares original and replacement hashes case-insensitively', async () => {
    const a = attempt(); a.signed!.txHash = `0x${'ab'.repeat(32)}`;
    expect(await createTakerGateway(c).replacementProof(a, `0x${'AB'.repeat(32)}`)).toBeNull();
    expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('holds invalid recorded nonce %s', async nonce => {
    const a = attempt(); a.signed!.nonce = nonce;
    expect(await createTakerGateway(c).replacementProof(a, h(102))).toBeNull();
    expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('holds malformed original hash without a transaction read', async () => {
    const a = attempt(); a.signed!.txHash = '0x1234';
    expect(await createTakerGateway(c).replacementProof(a, h(102))).toBeNull();
    expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('holds an RPC on a different chain', async () => {
    m.rpc.getChainId.mockResolvedValueOnce(80002);
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
    expect(m.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it.each([
    ['chain', { chainId: 80002 }], ['missing chain', { chainId: undefined }],
    ['sender', { from: c.makers[0]!.address }], ['recipient', { to: addresses.matchingModule }],
    ['creation', { to: null }], ['nonce', { nonce: 2 }], ['hash', { hash: h(103) }],
    ['value', { value: 1n }], ['input', { input: '0x00' }], ['missing input', { input: undefined }],
    ['authorization side effects', { authorizationList: [] }],
    ['pending height', { blockNumber: null }], ['pending hash', { blockHash: null }],
    ['negative height', { blockNumber: -1n }], ['malformed block hash', { blockHash: '0x1234' }],
    ['receipt height', { blockNumber: 99n }], ['receipt block hash', { blockHash: h(201) }],
    ['receipt index', { transactionIndex: 1 }], ['pending index', { transactionIndex: null }],
  ])('holds mismatched replacement transaction %s', async (_label, changed) => {
    m.rpc.getTransaction.mockResolvedValueOnce({ ...transaction(), ...changed });
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it('does not release a replacement match spend, even with the right sender and nonce', async () => {
    m.rpc.getTransaction.mockResolvedValueOnce({ ...transaction(), to: addresses.matchingModule, input: '0xdead' });
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each([
    ['hash', { transactionHash: h(103) }], ['sender', { from: c.makers[0]!.address }],
    ['recipient', { to: addresses.matchingModule }], ['unknown status', { status: 'unknown' }],
    ['missing block', { blockNumber: null }], ['missing block hash', { blockHash: null }],
    ['event side effects', { logs: receipt().logs }],
  ])('holds mismatched replacement receipt %s', async (_label, changed) => {
    m.rpc.getTransactionReceipt.mockResolvedValueOnce({ ...replacementReceipt(), ...changed });
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it('a reverted finalized self-transfer still proves consumption of this nonce', async () => {
    m.rpc.getTransactionReceipt.mockResolvedValueOnce({ ...replacementReceipt(), status: 'reverted' });
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toMatchObject({ kind: 'replaced', nonce: 1 });
  });
  it.each([
    ['not finalized', { number: 99n, hash: h(199) }], ['unknown height', { number: null, hash: h(220) }],
    ['unknown hash', { number: 120n, hash: null }], ['malformed finalized hash', { number: 120n, hash: '0x1234' }],
  ])('holds %s replacement', async (_label, finalized) => {
    m.rpc.getBlock.mockResolvedValueOnce(finalized);
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each([
    ['reorged inclusion', { ...block(100n), hash: h(201) }],
    ['wrong inclusion height', { ...block(100n), number: 101n }],
    ['absent from canonical block', { ...block(100n), transactions: [] }],
    ['wrong canonical transaction index', { ...block(100n), transactions: [h(103), h(102)] }],
  ])('holds %s', async (_label, inclusion) => {
    m.rpc.getBlock.mockResolvedValueOnce(block(120n)).mockResolvedValueOnce(inclusion);
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each([
    ['hash changed', { ...block(120n), hash: h(221) }], ['height changed', { ...block(120n), number: 119n }],
  ])('holds finalized anchor whose %s on recheck', async (_label, recheck) => {
    m.rpc.getBlock.mockResolvedValueOnce(block(120n)).mockResolvedValueOnce(block(100n)).mockResolvedValueOnce(recheck);
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each(['getTransaction', 'getTransactionReceipt', 'getBlock'] as const)('holds absent %s evidence', async method => {
    m.rpc[method].mockResolvedValueOnce(null);
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each(['inclusion', 'anchor'])('holds unavailable canonical %s evidence', async stage => {
    m.rpc.getBlock.mockResolvedValueOnce(block(120n));
    if (stage === 'anchor') m.rpc.getBlock.mockResolvedValueOnce(block(100n));
    m.rpc.getBlock.mockRejectedValueOnce(new Error('Synthetic canonical block unavailable.'));
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
  it.each(['getChainId', 'getTransaction', 'getTransactionReceipt', 'getBlock'] as const)('holds unknown %s results without exposing transport errors', async method => {
    m.rpc[method].mockRejectedValueOnce(new Error('synthetic provider cause must not escape'));
    expect(await createTakerGateway(c).replacementProof(attempt(), h(102))).toBeNull();
  });
});
