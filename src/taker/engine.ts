import { createHash, randomUUID } from 'node:crypto';
import { capWei6, formatUSDC, type TakerConfig } from './config.js';
import { TakerError } from './errors.js';
import { evaluate, type Decision, type Quote, type Reference } from './policy.js';
import { Journal, type Attempt, type OutcomeRecord, type ReleaseProof } from './store.js';

export interface SignHooks {
  beforeSign(quote: Quote): Promise<void>;
  signed(txHash: string, nonce: number, submissionAt: string): void;
}
export interface PreparedTake { quote: Quote; sign(hooks: SignHooks): Promise<void> }
export interface TakerGateway {
  book(): Promise<Quote[]>;
  prepare(quote: Quote): Promise<PreparedTake>;
  reference(quote: Quote): Promise<Reference | null>;
  allowance(stakeWei6: bigint, spentWei6: bigint): Promise<boolean>;
  receipt(attempt: Attempt): Promise<Omit<OutcomeRecord, 'type' | 'id' | 'at'> | null>;
  replacementProof(attempt: Attempt, replacementHash: string): Promise<ReleaseProof | null>;
}
interface Observation { at: string; reference: Reference | null; decision: Decision }
// SDK preserves errors carrying a code across its signing boundary.
class Passed extends Error {
  readonly code = 'TAKER_PASS';
  constructor(readonly decision: Decision) { super(decision.reason); }
}
const capPass = (decision: Decision): boolean => !decision.take && decision.reason.startsWith('would exceed the cap');
export class Taker {
  // One digest per currently listed quote, never one entry per observation.
  // Restart records a fresh observation; this cache never authorizes a live take.
  private readonly observations = new Map<string, string>();
  constructor(readonly config: TakerConfig, readonly journal: Journal, readonly gateway: TakerGateway,
    private readonly now: () => number = Date.now, private readonly stopping: () => boolean = () => false) {}
  private async observe(q: Quote): Promise<Observation> {
    let reference: Reference | null;
    try { reference = await this.gateway.reference(q); } catch { reference = null; }
    const now = this.now();
    return { at: new Date(now).toISOString(), reference,
      decision: evaluate(q, reference, this.config, now, this.journal.spentWei6 + this.journal.reservedWei6) };
  }
  private async decision(q: Quote, id: string, forcedReason?: string, observed?: Observation): Promise<void> {
    const { at, reference, decision } = observed ?? await this.observe(q);
    if (forcedReason !== undefined) { decision.take = false; decision.reason = forcedReason; }
    if (this.stopping()) { decision.take = false; decision.reason = 'taker stop requested'; }
    const maker = [...this.config.makers, ...this.config.houseWallets].find(m => m.address.toLowerCase() === q.maker.toLowerCase());
    // Poll capture time and countdown alone are not new decisions. Expiry threshold
    // transitions change the reason; reference changes and remaining budget still count.
    const fingerprint = createHash('sha256').update(JSON.stringify({ quote: q,
      reference: reference === null ? null : { ...reference, pollCapturedAt: undefined },
      decision: { ...decision, secondsLeft: undefined }, cap: this.config.capUSDC, distance: this.config.distancePp,
    })).digest('hex');
    const hash = q.hash.toLowerCase();
    if ((decision.take && !this.journal.dryRun) || this.observations.get(hash) !== fingerprint) {
      this.journal.append({ type: 'decision', id, at, dryRun: this.journal.dryRun, quote: q, reference, decision,
        makerLabel: maker?.label ?? null, makerController: maker?.controller ?? null,
        capWei6: capWei6(this.config).toString(), distanceLimitPp: this.config.distancePp, txHash: null, submissionAt: null, receiptAt: null });
      this.observations.set(hash, fingerprint);
    }
    if (!decision.take) throw new Passed(decision);
  }
  private summary(what: string, needed?: bigint): string {
    const spent = this.journal.spentWei6;
    const reserved = this.journal.reservedWei6;
    const remainder = capWei6(this.config) - spent - reserved;
    const next = needed === undefined ? 'next quote not evaluated' : `smallest price-eligible quote needs ${formatUSDC(needed)}`;
    return `${what} Cap ${this.config.capUSDC} USDC; spent ${formatUSDC(spent)}; reserved ${formatUSDC(reserved)}; remaining ${formatUSDC(remainder > 0n ? remainder : 0n)}; ${next}. Only the taker holds; the maker and everything else keep running. Raise the cap by hand (and set its exact allowance by hand) to fund more takes; reconcile uncertain receipts before resuming. Never reset the spend journal.`;
  }
  /** Explicit, signer-free recovery under the same exclusive lock as the runner. */
  async reconcile(id: string, replacementHash?: string): Promise<string> {
    const attempt = this.journal.pending.find(a => a.decision.id === id);
    if (!attempt) throw new TakerError('TAKER_RECONCILE', 'No pending take has that decision ID. Nothing changed.');
    if (!attempt.signed) {
      if (replacementHash !== undefined) throw new TakerError('TAKER_RECONCILE', 'An unsigned reservation does not accept a replacement hash.');
      // Signed bytes cannot leave the guarded signer until their record is durable.
      this.journal.append({ type: 'released', id, at: new Date(this.now()).toISOString(), proof: { kind: 'unsigned' } });
    } else {
      let receipt = null;
      try { receipt = await this.gateway.receipt(attempt); } catch { /* Unknown is not a release proof. */ }
      if (receipt !== null) {
        this.journal.append({ ...receipt, type: 'outcome', id, at: new Date(this.now()).toISOString() });
      } else {
        if (replacementHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(replacementHash)) {
          throw new TakerError('TAKER_RECONCILE', 'A signed take needs an exact finalized replacement transaction hash, or its own final receipt. Stake stays reserved.');
        }
        let proof: ReleaseProof | null = null;
        try { proof = await this.gateway.replacementProof(attempt, replacementHash); } catch { /* Fail closed. */ }
        if (proof?.kind !== 'replaced' || proof.replacementHash.toLowerCase() !== replacementHash.toLowerCase()) {
          throw new TakerError('TAKER_RECONCILE', 'Finalized same-wallet, same-nonce replacement proof is unavailable. Stake stays reserved.');
        }
        this.journal.append({ type: 'released', id, at: new Date(this.now()).toISOString(), proof });
      }
    }
    return `Reconciled pending take. Spent ${formatUSDC(this.journal.spentWei6)} USDC; reserved ${formatUSDC(this.journal.reservedWei6)}. No transaction signed or sent; historical spend is unchanged except for a proven original receipt.`;
  }
  async tick(): Promise<string | null> {
    for (const a of this.journal.pending) {
      if (!a.signed) return this.summary('Unsigned take remains held. Stop the taker and use explicit reconcile with its decision ID; do not reset history.');
      let receipt;
      try { receipt = await this.gateway.receipt(a); } catch { receipt = null; }
      if (receipt === null) return this.summary('Transaction receipt is not yet proven final. Its stake stays reserved; no resend.');
      this.journal.append({ ...receipt, type: 'outcome', id: a.decision.id, at: new Date(this.now()).toISOString() });
    }
    if (this.stopping()) return 'Taker stopped. No maker shutdown or cancellation sweep.';
    if (this.journal.spentWei6 >= capWei6(this.config)) return this.summary('The cap has been reached. Taking is stopped.');
    let book: Quote[];
    try { book = await this.gateway.book(); }
    catch { return 'TAKER_BOOK_RETRY: Quote book unavailable; no take attempted. Will retry after the configured poll interval. Maker is unaffected.'; }
    const current = new Set(book.map(q => q.hash.toLowerCase()));
    for (const hash of this.observations.keys()) if (!current.has(hash)) this.observations.delete(hash);
    const seen = new Set<string>();
    let smallestNeeded: bigint | undefined;
    for (const listed of book) {
      if (this.stopping()) break;
      const hash = listed.hash.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const id = randomUUID();
      let recorded = false;
      try {
        if (this.journal.consumed(hash)) {
          recorded = true;
          await this.decision(listed, id, 'already filled by this taker; not retried');
          continue;
        }
        const maker = listed.maker.toLowerCase();
        if (maker === this.config.wallet.address.toLowerCase() || this.config.houseWallets.some(m => m.address.toLowerCase() === maker) || !this.config.makers.some(m => m.address.toLowerCase() === maker)) {
          recorded = true;
          await this.decision(listed, id, 'maker is self, house, or not on the explicit outside-maker list');
          continue;
        }
        const precheck = await this.observe(listed);
        // Cheap rejection saves SDK preflight reads. Listed capacity may be stale,
        // so an otherwise eligible cap pass must still get canonical full size.
        if (!precheck.decision.take && !capPass(precheck.decision)) {
          recorded = true;
          await this.decision(listed, id, undefined, precheck);
          continue;
        }
        const prepared = await this.gateway.prepare(listed);
        if (this.journal.dryRun) {
          recorded = true;
          await this.decision(prepared.quote, id);
          continue;
        }
        await prepared.sign({
          beforeSign: async quote => {
            const stake = BigInt(quote.remainingMakerWei6) * BigInt(quote.makerOddsTick - 100) / 100n;
            const allowance = await this.gateway.allowance(stake, this.journal.spentWei6);
            recorded = true;
            // Always fetch the deciding reference anew after SDK preflight and
            // final capacity/allowance reads, immediately before signing.
            const observed = await this.observe(quote);
            await this.decision(quote, id, allowance || !observed.decision.take ? undefined : 'allowance is not the finite cap authorization or cannot fund the full quote; the operator must set it by hand', observed);
          },
          signed: (txHash, nonce, submissionAt) => {
            this.journal.append({ type: 'signed', id, at: new Date(this.now()).toISOString(), txHash, nonce, submissionAt });
            if (this.stopping()) throw new Error('Stop requested after signing; hash retained, no SDK handoff.');
          },
        });
      } catch (err) {
        if (err instanceof TakerError) throw err;
        if (err instanceof Passed) {
          if (capPass(err.decision)) {
            const needed = BigInt(err.decision.stakeWei6);
            if (smallestNeeded === undefined || needed < smallestNeeded) smallestNeeded = needed;
          }
        } else if (!recorded) {
          try { await this.decision(listed, id, 'quote preflight failed; no take submitted'); } catch (e) { if (!(e instanceof Passed)) throw e; }
        } else if (this.journal.pending.length === 0) {
          throw new TakerError('TAKER_JOURNAL', 'Taker decision/record failed. Stop and recover the journal.');
        }
      }
      if (this.journal.pending.length > 0) {
        const a = this.journal.pending[0]!;
        let receipt = null;
        if (a.signed) { try { receipt = await this.gateway.receipt(a); } catch { /* Keep full reservation. */ } }
        if (receipt !== null) this.journal.append({ ...receipt, type: 'outcome', id: a.decision.id, at: new Date(this.now()).toISOString() });
        else return this.summary('Take submitted or uncertain. Waiting for a final receipt; its full stake remains reserved.');
      }
      if (this.journal.spentWei6 >= capWei6(this.config)) return this.summary('The cap has been reached. Taking is stopped.');
    }
    return smallestNeeded === undefined ? null : this.summary('No price-eligible full quote fits the remaining cap.', smallestNeeded);
  }
}
