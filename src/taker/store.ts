import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { TakerConfig } from './config.js';
import { TakerError } from './errors.js';
import type { Decision, Quote, Reference } from './policy.js';

export interface DecisionRecord {
  type: 'decision'; id: string; at: string; dryRun: boolean;
  quote: Quote; reference: Reference | null; decision: Decision;
  makerLabel: string | null; makerController: string | null;
  capWei6: string; distanceLimitPp: number; txHash: null; submissionAt: null; receiptAt: null;
}
export interface SignedRecord {
  type: 'signed'; id: string; at: string; txHash: string; nonce: number;
  /** Handoff to SDK broadcast, not proof of RPC acceptance. */
  submissionAt: string;
}
export interface OutcomeRecord {
  type: 'outcome'; id: string; at: string; txHash: string;
  result: 'success' | 'reverted'; stakeWei6: string;
  receiptAt: string; includedAt: string; blockNumber: string; blockHash: string;
}
export type ReleaseProof = { kind: 'unsigned' } | {
  kind: 'replaced'; chainId: number; wallet: string; nonce: number; txHash: string;
  replacementHash: string; blockNumber: string; blockHash: string;
  finalizedBlockNumber: string; finalizedBlockHash: string;
};
export interface ReleasedRecord { type: 'released'; id: string; at: string; proof: ReleaseProof }
export type RecordEvent = DecisionRecord | SignedRecord | OutcomeRecord | ReleasedRecord;
export interface Attempt { decision: DecisionRecord; signed?: SignedRecord; outcome?: OutcomeRecord }
interface Identity { version: 1; chainId: number; wallet: string; dryRun: boolean }
interface Row { sequence: number; previous: string; event: Identity | RecordEvent; digest: string }
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isAmount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const hasKeys = (v: object, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const READ_CHUNK_BYTES = 64 * 1024;
// Bound individual rows, not the lifetime history. The newline is not part of the row.
const MAX_ROW_BYTES = 1024 * 1024;

function directory(config: TakerConfig): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(config.stateDir, 'maker-state.json')) || existsSync(join(config.stateDir, 'maker.lock'))) {
    throw new TakerError('TAKER_STATE', 'The taker requires its own state directory, never the maker directory.');
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** No automatic stale-lock deletion: recovery must first establish the old process is dead. */
export function lockTaker(config: TakerConfig): () => void {
  directory(config);
  const path = join(config.stateDir, 'taker.lock');
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new TakerError('TAKER_LOCK', 'Taker state is locked. Stop the old taker; verify it is dead before removing taker.lock. Maker is unaffected.'); }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, wallet: config.wallet.address }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  let released = false;
  return () => { if (!released) { unlinkSync(path); released = true; } };
}

/** Append-only, fsynced authority. No allowance/balance/winnings inference; no reset on restart. */
export class Journal {
  readonly path: string;
  /** Only open attempts; completed detail remains in the append-only journal. */
  readonly attempts = new Map<string, Attempt>();
  private sequence = 0;
  private tip = '';
  private spent = 0n;
  private reserved = 0n;
  // One hash per successful real take is necessary to prevent repeat fills after restart.
  private readonly consumedHashes = new Set<string>();
  private failed = false;
  private readonly identity: Identity;
  constructor(config: TakerConfig, readonly dryRun: boolean, initialize = false) {
    directory(config);
    this.path = join(config.stateDir, dryRun ? 'shadow.ndjson' : 'live.ndjson');
    this.identity = { version: 1, chainId: config.chainId, wallet: config.wallet.address.toLowerCase(), dryRun };
    if (initialize) {
      const fd = openSync(this.path, 'wx', 0o600);
      try { this.writeRow(fd, this.encode(this.identity)); } finally { closeSync(fd); }
      syncDirectory(config.stateDir);
    } else {
      if (!existsSync(this.path)) throw new TakerError('TAKER_JOURNAL', 'Spend journal missing. Restore it; only a genuinely new taker may use init. Never reset a running cap.');
      this.replay();
    }
  }
  get spentWei6(): bigint { return this.spent; }
  get pending(): Attempt[] { return [...this.attempts.values()]; }
  get reservedWei6(): bigint { return this.reserved; }
  consumed(hash: string): boolean { return this.consumedHashes.has(hash.toLowerCase()); }

  private replay(): void {
    const fd = openSync(this.path, 'r');
    try {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const line = Buffer.allocUnsafe(MAX_ROW_BYTES);
      let length = 0;
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        let start = 0;
        while (start < count) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 || newline >= count ? count : newline;
          const size = end - start;
          if (length + size > MAX_ROW_BYTES) throw new TakerError('TAKER_JOURNAL', 'Spend journal row exceeds size limit; taker held for recovery.');
          chunk.copy(line, length, start, end);
          length += size;
          if (end < count) {
            // Decode only complete lines so UTF-8 code points may span read chunks.
            this.replayRow(line.toString('utf8', 0, length));
            length = 0;
          }
          start = end + 1;
        }
      }
      if (length !== 0 || this.sequence === 0) throw new TakerError('TAKER_JOURNAL', 'Incomplete spend journal; taker held for recovery.');
    } finally { closeSync(fd); }
  }
  private replayRow(line: string): void {
    try {
      const row = JSON.parse(line) as Row;
      const base = { sequence: this.sequence, previous: this.tip, event: row.event };
      if (row.sequence !== base.sequence || row.previous !== base.previous || row.digest !== digest(base)) {
        throw new TakerError('TAKER_JOURNAL', 'Invalid journal hash chain.');
      }
      if (this.sequence === 0) {
        if (JSON.stringify(row.event) !== JSON.stringify(this.identity)) throw new TakerError('TAKER_JOURNAL', 'Invalid journal identity.');
      } else this.apply(row.event as RecordEvent);
      this.sequence += 1;
      this.tip = row.digest;
    } catch { throw new TakerError('TAKER_JOURNAL', 'Spend journal is corrupt or belongs to another wallet/chain/mode; taker held.'); }
  }
  append(event: RecordEvent): void {
    if (this.failed) throw new TakerError('TAKER_JOURNAL', 'Journal write failed; stop the taker and recover before continuing.');
    // Validate and bound the row before IO, but never release funds before durable success.
    this.apply(event, false);
    const next = this.encode(event);
    try {
      // No O_CREAT: a deleted spend ledger must never silently become an empty one.
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND);
      try { this.writeRow(fd, next); } finally { closeSync(fd); }
      this.apply(event);
    } catch {
      this.failed = true;
      throw new TakerError('TAKER_JOURNAL', 'Journal write failed; stop the taker and recover before continuing.');
    }
  }
  private encode(event: Identity | RecordEvent): { row: Row; bytes: Buffer } {
    // Keep the original v1 key order and digest input exactly; no history migration.
    const base = { sequence: this.sequence, previous: this.tip, event };
    const row: Row = { ...base, digest: digest(base) };
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    if (bytes.length - 1 > MAX_ROW_BYTES) throw new TakerError('TAKER_JOURNAL', 'Spend journal row exceeds size limit; taker held for recovery.');
    return { row, bytes };
  }
  private writeRow(fd: number, { row, bytes }: { row: Row; bytes: Buffer }): void {
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote === 0) throw new TakerError('TAKER_JOURNAL', 'Journal short write.');
      offset += wrote;
    }
    fsyncSync(fd);
    this.sequence += 1;
    this.tip = row.digest;
  }
  private validRelease(proof: ReleaseProof, a: Attempt): boolean {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
    if (proof.kind === 'unsigned') return hasKeys(proof, ['kind']) && !a.signed;
    // The producer verifies chain inclusion/finality; the journal checks shape and binding.
    return proof.kind === 'replaced' && hasKeys(proof, [
      'kind', 'chainId', 'wallet', 'nonce', 'txHash', 'replacementHash',
      'blockNumber', 'blockHash', 'finalizedBlockNumber', 'finalizedBlockHash',
    ]) && a.signed !== undefined
      && Number.isSafeInteger(proof.chainId) && proof.chainId === this.identity.chainId
      && typeof proof.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(proof.wallet) && proof.wallet.toLowerCase() === this.identity.wallet
      && Number.isSafeInteger(proof.nonce) && proof.nonce >= 0 && proof.nonce === a.signed.nonce
      && isHash(proof.txHash) && proof.txHash.toLowerCase() === a.signed.txHash.toLowerCase()
      && isHash(proof.replacementHash) && proof.replacementHash.toLowerCase() !== proof.txHash.toLowerCase()
      && isAmount(proof.blockNumber) && isHash(proof.blockHash)
      && isAmount(proof.finalizedBlockNumber) && isHash(proof.finalizedBlockHash)
      && BigInt(proof.finalizedBlockNumber) >= BigInt(proof.blockNumber);
  }
  private apply(e: RecordEvent, commit = true): void {
    if (!e || !isTime(e.at) || typeof e.id !== 'string' || e.id.length === 0) throw new TakerError('TAKER_JOURNAL', 'Invalid journal event.');
    if (e.type === 'decision') {
      if (e.dryRun !== this.dryRun || typeof e.decision?.take !== 'boolean' || !isAmount(e.decision.stakeWei6) || !isAmount(e.capWei6) || !isHash(e.quote?.hash)) throw new TakerError('TAKER_JOURNAL', 'Invalid decision.');
      if (e.txHash !== null || e.submissionAt !== null || e.receiptAt !== null) throw new TakerError('TAKER_JOURNAL', 'Decision cannot carry a transaction.');
      if (e.decision.take && !e.dryRun) {
        if (this.attempts.has(e.id) || this.consumed(e.quote.hash) || this.attempts.size !== 0) throw new TakerError('TAKER_JOURNAL', 'Duplicate or unresolved take.');
        const stake = BigInt(e.decision.stakeWei6);
        if (stake <= 0n || stake + this.spent > BigInt(e.capWei6)) throw new TakerError('TAKER_JOURNAL', 'Reservation would exceed cap.');
        if (commit) {
          this.attempts.set(e.id, { decision: e });
          this.reserved += stake;
        }
      }
    } else {
      const a = this.attempts.get(e.id);
      if (!a || a.outcome) throw new TakerError('TAKER_JOURNAL', 'Unknown or completed take.');
      if (e.type === 'signed') {
        if (a.signed || !isHash(e.txHash) || !Number.isSafeInteger(e.nonce) || e.nonce < 0 || !isTime(e.submissionAt)) throw new TakerError('TAKER_JOURNAL', 'Invalid signed record.');
        if (commit) a.signed = e;
      } else if (e.type === 'outcome') {
        if (!a.signed || !isHash(e.txHash) || e.txHash.toLowerCase() !== a.signed.txHash.toLowerCase() || !isAmount(e.stakeWei6) || !isAmount(e.blockNumber) || !isHash(e.blockHash) || !isTime(e.receiptAt) || !isTime(e.includedAt)) throw new TakerError('TAKER_JOURNAL', 'Invalid receipt record.');
        const amount = BigInt(e.stakeWei6);
        if (e.result === 'reverted' ? amount !== 0n : e.result !== 'success' || amount <= 0n || amount > BigInt(a.decision.decision.stakeWei6)) throw new TakerError('TAKER_JOURNAL', 'Receipt stake exceeds reservation or is invalid.');
        if (commit) {
          if (e.result === 'success') {
            this.spent += amount;
            this.consumedHashes.add(a.decision.quote.hash.toLowerCase());
          }
          this.reserved -= BigInt(a.decision.decision.stakeWei6);
          this.attempts.delete(e.id);
        }
      } else if (e.type === 'released') {
        if (!this.validRelease(e.proof, a)) throw new TakerError('TAKER_JOURNAL', 'Invalid release proof.');
        if (commit) {
          this.reserved -= BigInt(a.decision.decision.stakeWei6);
          this.attempts.delete(e.id);
        }
      } else throw new TakerError('TAKER_JOURNAL', 'Unknown journal event.');
    }
  }
}
