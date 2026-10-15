import { randomUUID } from 'node:crypto';
import { capWei6, formatUSDC, type TakerConfig } from './config.js';
import { evaluate, type Quote, type Reference } from './policy.js';
import { Journal, type Attempt, type OutcomeRecord } from './store.js';

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
}
// SDK preserves errors carrying a code across its signing boundary.
class Passed extends Error { readonly code = 'TAKER_PASS'; }
export class Taker {
  constructor(readonly config: TakerConfig, readonly journal: Journal, readonly gateway: TakerGateway,
    private readonly now: () => number = Date.now, private readonly stopping: () => boolean = () => false) {}
  private async reference(q: Quote): Promise<Reference | null> {
    try { return await this.gateway.reference(q); } catch { return null; }
  }
  private async decision(q: Quote, id: string, forcedReason?: string): Promise<void> {
    const reference = await this.reference(q);
    const at = new Date(this.now()).toISOString();
    const decision = evaluate(q, reference, this.config, this.now(), this.journal.spentWei6 + this.journal.reservedWei6);
    if (forcedReason !== undefined) { decision.take = false; decision.reason = forcedReason; }
    if (this.stopping()) { decision.take = false; decision.reason = 'taker stop requested'; }
    const maker = [...this.config.makers, ...this.config.houseWallets].find(m => m.address.toLowerCase() === q.maker.toLowerCase());
    this.journal.append({ type: 'decision', id, at, dryRun: this.journal.dryRun, quote: q, reference, decision,
      makerLabel: maker?.label ?? null, makerController: maker?.controller ?? null,
      capWei6: capWei6(this.config).toString(), distanceLimitPp: this.config.distancePp, txHash: null, submissionAt: null, receiptAt: null });
    if (!decision.take) throw new Passed(decision.reason);
  }
  private summary(what: string, needed = 0n): string {
    const spent = this.journal.spentWei6;
    const reserved = this.journal.reservedWei6;
    const remainder = capWei6(this.config) - spent - reserved;
    return `${what} Cap ${this.config.capUSDC} USDC; spent ${formatUSDC(spent)}; reserved ${formatUSDC(reserved)}; remaining ${formatUSDC(remainder > 0n ? remainder : 0n)}; next quote needs ${formatUSDC(needed)}. Only the taker holds; the maker and everything else keep running. Raise the cap by hand (and set its exact allowance by hand) to fund more takes; reconcile uncertain receipts before resuming. Never reset the spend journal.`;
  }
  async tick(): Promise<string | null> {
    for (const a of this.journal.pending) {
      if (!a.signed) return this.summary('Uncertain take without a persisted transaction hash. Restore/reconcile its signing record; do not retry.');
      let receipt;
      try { receipt = await this.gateway.receipt(a); } catch { receipt = null; }
      if (receipt === null) return this.summary('Transaction receipt is not yet proven final. Its stake stays reserved; no resend.');
      this.journal.append({ ...receipt, type: 'outcome', id: a.decision.id, at: new Date(this.now()).toISOString() });
    }
    if (this.stopping()) return 'Taker stopped. No maker shutdown or cancellation sweep.';
    if (this.journal.spentWei6 >= capWei6(this.config)) return this.summary('The cap has been reached. Taking is stopped.');
    const seen = new Set<string>();
    let capPass: string | null = null;
    for (const listed of await this.gateway.book()) {
      if (this.stopping()) break;
      const hash = listed.hash.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const id = randomUUID();
      let recorded = false;
      let considered = listed;
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
        const prepared = await this.gateway.prepare(listed);
        considered = prepared.quote;
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
            // This is the only reference price check on a live signing path.
            // It runs after SDK gas/nonce/preflight work, immediately before signing.
            await this.decision(quote, id, allowance ? undefined : 'allowance is not the finite cap authorization or cannot fund the full quote; Vince must set it by hand');
          },
          signed: (txHash, nonce, submissionAt) => {
            this.journal.append({ type: 'signed', id, at: new Date(this.now()).toISOString(), txHash, nonce, submissionAt });
            if (this.stopping()) throw new Error('Stop requested after signing; hash retained, no SDK handoff.');
          },
        });
      } catch (err) {
        if (err instanceof Passed) {
          if (err.message.startsWith('would exceed the cap')) {
            const a = BigInt(considered.remainingMakerWei6) * BigInt(considered.makerOddsTick - 100) / 100n;
            capPass = this.summary(err.message, a);
          }
        } else if (!recorded) {
          try { await this.decision(listed, id, 'quote preflight failed; no take submitted'); } catch (e) { if (!(e instanceof Passed)) throw e; }
        } else if (this.journal.pending.length === 0) {
          // A failed durable decision must never be hidden by a retry loop.
          throw new Error('Taker decision/record failed. Stop and recover the journal.');
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
    return capPass;
  }
}
