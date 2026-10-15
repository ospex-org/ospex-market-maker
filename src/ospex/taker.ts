import { OspexClient, getAddresses, type PublicVisibleCommitment, type Signer, type Hex } from '@ospex/sdk';
import { createPublicClient, http, keccak256, parseAbi, parseEventLogs, type TransactionReceipt } from 'viem';
import { capWei6, type TakerConfig } from '../taker/config.js';
import type { PreparedTake, SignHooks, TakerGateway } from '../taker/engine.js';
import type { Quote, Reference } from '../taker/policy.js';
import type { Attempt, OutcomeRecord } from '../taker/store.js';

// Read-only decoding of the MatchingModule event in SDK 0.16.0's ABI.
// All contract reads and every write still go through the SDK; viem is used
// only for receipt/block RPCs, event decoding and hashing signed bytes in memory.
export const matchEvents = parseAbi([
  'event CommitmentMatched(bytes32 indexed commitmentHash,address indexed maker,address indexed taker,uint256 contestId,uint256 speculationId,address scorer,int32 lineTicks,uint8 makerPositionType,uint16 oddsTick,uint256 makerRisk,uint256 takerRisk,uint256 commitmentRiskAmount,uint256 nonce,uint256 expiry)',
]);
const lower = (v: string): string => v.toLowerCase();
export function quoteFromCommitment(c: PublicVisibleCommitment): Quote {
  return { hash: c.commitmentHash, maker: c.maker, contestId: c.contestId ?? '', market: c.marketType!,
    lineTicks: c.lineTicks!, makerSide: c.positionType!, makerOddsTick: c.oddsTick!,
    remainingMakerWei6: c.remainingRiskAmount, expiry: c.expiry ?? '' };
}
export function receiptStake(receipt: TransactionReceipt, attempt: Attempt, config: TakerConfig): bigint | null {
  const addresses = getAddresses(config.chainId);
  const q = attempt.decision.quote;
  if (!attempt.signed || lower(receipt.transactionHash) !== lower(attempt.signed.txHash) || lower(receipt.from) !== lower(config.wallet.address) || lower(receipt.to ?? '') !== lower(addresses.matchingModule)) return null;
  if (receipt.status === 'reverted') return 0n;
  if (receipt.status !== 'success') return null;
  const logs = parseEventLogs({ abi: matchEvents, eventName: 'CommitmentMatched', strict: true,
    logs: receipt.logs.filter(log => lower(log.address) === lower(addresses.matchingModule)) });
  if (logs.length !== 1) return null;
  const a = logs[0]!.args;
  if (lower(a.commitmentHash) !== lower(q.hash) || lower(a.maker) !== lower(q.maker) || lower(a.taker) !== lower(config.wallet.address) || a.contestId.toString() !== q.contestId || lower(a.scorer) !== lower(addresses.scorers[q.market]) || a.lineTicks !== q.lineTicks || a.makerPositionType !== q.makerSide || a.oddsTick !== q.makerOddsTick || a.makerRisk <= 0n || a.makerRisk > BigInt(q.remainingMakerWei6) || a.takerRisk !== a.makerRisk * BigInt(q.makerOddsTick - 100) / 100n || a.takerRisk <= 0n || a.takerRisk > BigInt(attempt.decision.decision.stakeWei6)) return null;
  return a.takerRisk;
}

/** Persists the deterministic hash BEFORE signed authority can leave this process. */
export function guardedSigner(signer: Signer, config: TakerConfig, quote: Quote, hooks: SignHooks,
  checkCapacity: () => Promise<void>): Signer {
  let used = false;
  return {
    getAddress: () => signer.getAddress(),
    signTypedData: async () => { throw new Error('The taker never signs typed data.'); },
    signTransaction: async tx => {
      if (used || tx.chainId !== config.chainId || lower(tx.to ?? '') !== lower(getAddresses(config.chainId).matchingModule) || (tx.value ?? 0n) !== 0n || !Number.isSafeInteger(tx.nonce) || tx.nonce! < 0) throw new Error('Unexpected taker transaction.');
      used = true;
      if (lower(await signer.getAddress()) !== lower(config.wallet.address)) throw new Error('Taker signer does not match the configured wallet.');
      await checkCapacity();
      await hooks.beforeSign(quote);
      const serialized = await signer.signTransaction(tx);
      // No signed bytes or SDK error causes are persisted or printed.
      hooks.signed(keccak256(serialized), tx.nonce!, new Date().toISOString());
      return serialized;
    },
  };
}

export function createTakerGateway(config: TakerConfig, signer?: Signer): TakerGateway {
  const options = { chainId: config.chainId, apiUrl: config.apiUrl, rpcUrl: config.rpcUrl };
  const read = new OspexClient(options);
  const rpc = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 20_000 }) });
  const addresses = getAddresses(config.chainId);
  async function chainIdentity(): Promise<void> {
    if (await rpc.getChainId() !== config.chainId) throw new Error('RPC chain does not match configuration.');
  }
  async function canonical(hash: string): Promise<PublicVisibleCommitment> {
    const c = await read.commitments.get(hash as Hex);
    if (c.visibility !== 'visible' || !c.isLive || c.nonceInvalidated || c.contestId === null || c.marketType === null || c.scorer === null || lower(c.scorer) !== lower(addresses.scorers[c.marketType]) || lower(c.commitmentHash) !== lower(hash)) throw new Error('Quote is not a visible, live, exact-market commitment.');
    const snapshot = await read.commitments.getFilledRisk({ hashes: [c.commitmentHash as Hex] });
    const filled = snapshot.filledRisk.get(c.commitmentHash as Hex);
    if (filled === undefined || filled < 0n || filled >= BigInt(c.riskAmount)) throw new Error('Quote has no proven remaining chain capacity.');
    return { ...c, remainingRiskAmount: (BigInt(c.riskAmount) - filled).toString(), filledRiskAmount: filled.toString() };
  }
  return {
    async book(): Promise<Quote[]> {
      const quotes = new Map<string, Quote>();
      for (const maker of config.makers) {
        let offset = 0;
        for (;;) {
          const rows = await read.commitments.list({ maker: maker.address as Hex, status: ['open', 'partially_filled'], limit: 100, offset });
          let added = 0;
          for (const c of rows) {
            if (c.visibility !== 'visible') continue;
            // Do not silently trust server filters: the engine rejects house,
            // self and non-list makers before any preparation/signing.
            const q = quoteFromCommitment(c);
            if (!quotes.has(lower(q.hash))) { quotes.set(lower(q.hash), q); added++; }
          }
          if (rows.length < 100) break;
          if (added === 0) throw new Error('Quote pagination did not advance.');
          offset += rows.length;
        }
      }
      return [...quotes.values()];
    },
    async prepare(listed: Quote): Promise<PreparedTake> {
      await chainIdentity();
      const commitment = await canonical(listed.hash);
      if (lower(commitment.maker) !== lower(listed.maker)) throw new Error('Maker changed since listing.');
      const preview = await read.commitments.prepareMatch({ commitment, taker: config.wallet.address as Hex });
      const quote = quoteFromCommitment(commitment);
      const expected = BigInt(quote.remainingMakerWei6) * BigInt(quote.makerOddsTick - 100) / 100n;
      if (preview.selfMatch || preview.economics.fillMakerRiskWei6 !== quote.remainingMakerWei6 || BigInt(preview.economics.takerRiskWei6) !== expected) throw new Error('Preview is not a full-size outside-maker fill.');
      return { quote, sign: async hooks => {
        if (!signer) throw new Error('Shadow mode cannot sign.');
        const guarded = guardedSigner(signer, config, quote, hooks, async () => {
          const fresh = quoteFromCommitment(await canonical(quote.hash));
          if (JSON.stringify(fresh) !== JSON.stringify(quote)) throw new Error('Quote/capacity changed before signing; re-evaluate next poll.');
        });
        const live = new OspexClient({ ...options, signer: guarded });
        // Omit an explicit requested amount in prepareMatch: full remaining
        // capacity. SDK matchFromPreview rechecks signed fields and allowance.
        await live.commitments.matchFromPreview(preview);
      } };
    },
    async reference(quote: Quote): Promise<Reference | null> {
      const snapshot = await read.odds.snapshot(quote.contestId);
      const row = snapshot.odds[quote.market];
      return row === null ? null : { ...row, contestId: snapshot.contestId };
    },
    async allowance(stake: bigint, spent: bigint): Promise<boolean> {
      const a = await read.approvals.read({ owner: config.wallet.address as Hex });
      const position = a.usdc.allowances.positionModule.raw;
      const treasury = a.usdc.allowances.treasuryModule.raw;
      const cap = capWei6(config);
      return a.chainId === config.chainId && lower(a.owner) === lower(config.wallet.address) && position <= cap && treasury <= cap && position >= stake && (spent !== 0n || position === cap);
    },
    async receipt(attempt: Attempt): Promise<Omit<OutcomeRecord, 'type' | 'id' | 'at'> | null> {
      if (!attempt.signed) return null;
      await chainIdentity();
      const receipt = await rpc.getTransactionReceipt({ hash: attempt.signed.txHash as Hex });
      const receiptAt = new Date().toISOString();
      const finalized = await rpc.getBlock({ blockTag: 'finalized' });
      if (receipt.blockNumber > finalized.number) return null;
      const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
      if (lower(block.hash) !== lower(receipt.blockHash)) return null;
      const stake = receiptStake(receipt, attempt, config);
      if (stake === null) return null;
      return { txHash: receipt.transactionHash, result: receipt.status, stakeWei6: stake.toString(), receiptAt,
        includedAt: new Date(Number(block.timestamp) * 1000).toISOString(), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    },
  };
}
