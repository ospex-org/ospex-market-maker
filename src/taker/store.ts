import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { TakerConfig } from './config.js';
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
export type RecordEvent = DecisionRecord | SignedRecord | OutcomeRecord;
export interface Attempt { decision: DecisionRecord; signed?: SignedRecord; outcome?: OutcomeRecord }
interface Identity { version: 1; chainId: number; wallet: string; dryRun: boolean }
interface Row { sequence: number; previous: string; event: Identity | RecordEvent; digest: string }
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isAmount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function directory(config: TakerConfig): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(config.stateDir, 'maker-state.json')) || existsSync(join(config.stateDir, 'maker.lock'))) {
    throw new Error('The taker requires its own state directory, never the maker directory.');
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
  catch { throw new Error('Taker state is locked. Stop the old taker; verify it is dead before removing taker.lock. Maker is unaffected.'); }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, wallet: config.wallet.address }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  let released = false;
  return () => { if (!released) { unlinkSync(path); released = true; } };
}

/** Append-only, fsynced authority. No allowance/balance/winnings inference; no reset on restart. */
export class Journal {
  readonly path: string;
  readonly attempts = new Map<string, Attempt>();
  private rows: Row[] = [];
  private failed = false;
  private readonly identity: Identity;
  constructor(config: TakerConfig, readonly dryRun: boolean, initialize = false) {
    directory(config);
    this.path = join(config.stateDir, dryRun ? 'shadow.ndjson' : 'live.ndjson');
    this.identity = { version: 1, chainId: config.chainId, wallet: config.wallet.address.toLowerCase(), dryRun };
    if (initialize) {
      const fd = openSync(this.path, 'wx', 0o600);
      try { this.writeRow(fd, this.identity); } finally { closeSync(fd); }
      syncDirectory(config.stateDir);
    } else {
      if (!existsSync(this.path)) throw new Error('Spend journal missing. Restore it; only a genuinely new taker may use init. Never reset a running cap.');
      const raw = readFileSync(this.path, 'utf8');
      if (!raw.endsWith('\n')) throw new Error('Incomplete spend journal; taker held for recovery.');
      try {
        for (const line of raw.slice(0, -1).split('\n')) {
          const row = JSON.parse(line) as Row;
          const base = { sequence: this.rows.length, previous: this.rows.at(-1)?.digest ?? '', event: row.event };
          if (row.sequence !== base.sequence || row.previous !== base.previous || row.digest !== digest(base)) throw new Error();
          if (this.rows.length === 0) {
            if (JSON.stringify(row.event) !== JSON.stringify(this.identity)) throw new Error();
          } else this.apply(row.event as RecordEvent);
          this.rows.push(row);
        }
      } catch { throw new Error('Spend journal is corrupt or belongs to another wallet/chain/mode; taker held.'); }
    }
  }
  get spentWei6(): bigint {
    return [...this.attempts.values()].reduce((sum, a) => sum + (a.outcome?.result === 'success' ? BigInt(a.outcome.stakeWei6) : 0n), 0n);
  }
  get pending(): Attempt[] { return [...this.attempts.values()].filter(a => !a.outcome); }
  get reservedWei6(): bigint { return this.pending.reduce((sum, a) => sum + BigInt(a.decision.decision.stakeWei6), 0n); }
  consumed(hash: string): boolean {
    return [...this.attempts.values()].some(a => a.decision.quote.hash.toLowerCase() === hash.toLowerCase() && a.outcome?.result === 'success');
  }
  append(event: RecordEvent): void {
    if (this.failed) throw new Error('Journal write failed; stop the taker and recover before continuing.');
    // Validate before disk IO; after a failed write this object is never reusable.
    this.apply(event);
    let fd: number | undefined;
    try { fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND); this.writeRow(fd, event); }
    catch { this.failed = true; throw new Error('Journal write failed; stop the taker and recover before continuing.'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private writeRow(fd: number, event: Identity | RecordEvent): void {
    const base = { sequence: this.rows.length, previous: this.rows.at(-1)?.digest ?? '', event };
    const row: Row = { ...base, digest: digest(base) };
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote === 0) throw new Error('Journal short write.');
      offset += wrote;
    }
    fsyncSync(fd);
    this.rows.push(row);
  }
  private apply(e: RecordEvent): void {
    if (!e || !isTime(e.at) || typeof e.id !== 'string' || e.id.length === 0) throw new Error('Invalid journal event.');
    if (e.type === 'decision') {
      if (e.dryRun !== this.dryRun || typeof e.decision?.take !== 'boolean' || !isAmount(e.decision.stakeWei6) || !isAmount(e.capWei6) || !isHash(e.quote?.hash)) throw new Error('Invalid decision.');
      if (e.txHash !== null || e.submissionAt !== null || e.receiptAt !== null) throw new Error('Decision cannot carry a transaction.');
      if (e.decision.take && !e.dryRun) {
        if (this.attempts.has(e.id) || this.consumed(e.quote.hash) || this.pending.length !== 0) throw new Error('Duplicate or unresolved take.');
        const stake = BigInt(e.decision.stakeWei6);
        if (stake <= 0n || stake + this.spentWei6 > BigInt(e.capWei6)) throw new Error('Reservation would exceed cap.');
        this.attempts.set(e.id, { decision: e });
      }
    } else {
      const a = this.attempts.get(e.id);
      if (!a || a.outcome) throw new Error('Unknown or completed take.');
      if (e.type === 'signed') {
        if (a.signed || !isHash(e.txHash) || !Number.isSafeInteger(e.nonce) || e.nonce < 0 || !isTime(e.submissionAt)) throw new Error('Invalid signed record.');
        a.signed = e;
      } else if (e.type === 'outcome') {
        if (!a.signed || e.txHash.toLowerCase() !== a.signed.txHash.toLowerCase() || !isAmount(e.stakeWei6) || !isAmount(e.blockNumber) || !isHash(e.blockHash) || !isTime(e.receiptAt) || !isTime(e.includedAt)) throw new Error('Invalid receipt record.');
        const amount = BigInt(e.stakeWei6);
        if (e.result === 'reverted' ? amount !== 0n : e.result !== 'success' || amount <= 0n || amount > BigInt(a.decision.decision.stakeWei6)) throw new Error('Receipt stake exceeds reservation or is invalid.');
        a.outcome = e;
      } else throw new Error('Unknown journal event.');
    }
  }
}
