import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, fsyncSync, mkdtempSync, readFileSync, readSync,
  rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TakerConfig } from '../src/taker/config.js';
import {
  Journal, lockTaker, type DecisionRecord, type OutcomeRecord, type RecordEvent,
  type ReleasedRecord, type ReleaseProof, type SignedRecord,
} from '../src/taker/store.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    writeSync: vi.fn(actual.writeSync),
  };
});

// Synthetic local journal fixtures only; no wallet, network, or service access.
const at = '2026-10-15T12:00:00Z';
const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const upperHex = (value: string): string => `0x${value.slice(2).toUpperCase()}`;
const dirs: string[] = [];
const maxRowBytes = 1024 * 1024;
function config(): TakerConfig {
  const stateDir = mkdtempSync(join(tmpdir(), 'taker-store-')); dirs.push(stateDir);
  return {
    schemaVersion: 1, mode: { dryRun: false }, chainId: 137,
    apiUrl: 'https://example.invalid', rpcUrl: 'https://example.invalid',
    wallet: { address: `0x${'a'.repeat(40)}`, keystorePath: 'not-a-wallet' },
    makers: [{ address: `0x${'2'.repeat(40)}`, label: 'synthetic maker', controller: 'test' }],
    houseWallets: [{ address: `0x${'3'.repeat(40)}`, label: 'synthetic house', controller: 'test' }],
    distancePp: 0, capUSDC: '1000000', minSecondsLeft: 30, pollIntervalMs: 100, stateDir,
  };
}
function decision(id = 'take', n = 1, take = true, dryRun = false): DecisionRecord {
  return {
    type: 'decision', id, at, dryRun,
    quote: {
      hash: hash(n), maker: `0x${'2'.repeat(40)}`, contestId: '15', market: 'moneyline',
      lineTicks: 0, makerSide: 0, makerOddsTick: 200, remainingMakerWei6: '1000',
      expiry: '2026-10-15T13:00:00Z',
    },
    reference: null,
    decision: {
      take, reason: 'synthetic journal fixture', stakeWei6: '1000', bettorSide: 'home',
      bettorDecimal: 2, referenceAmerican: -110, referenceProbability: 0.52,
      referenceObservedAt: at, secondsLeft: 3600, distancePp: -2, remainingCapWei6: '1000000000000',
    },
    makerLabel: 'synthetic maker', makerController: 'test', capWei6: '1000000000000',
    distanceLimitPp: 0, txHash: null, submissionAt: null, receiptAt: null,
  };
}
function signed(id = 'take', n = 171, nonce = 7): SignedRecord {
  return { type: 'signed', id, at, txHash: hash(n), nonce, submissionAt: at };
}
function outcome(id = 'take', n = 171, result: 'success' | 'reverted' = 'success'): OutcomeRecord {
  return {
    type: 'outcome', id, at, txHash: hash(n), result, stakeWei6: result === 'success' ? '600' : '0',
    receiptAt: at, includedAt: at, blockNumber: '100', blockHash: hash(500),
  };
}
function replaced(c: TakerConfig): Extract<ReleaseProof, { kind: 'replaced' }> {
  return {
    kind: 'replaced', chainId: c.chainId, wallet: c.wallet.address, nonce: 7,
    txHash: hash(171), replacementHash: hash(172), blockNumber: '100', blockHash: hash(500),
    finalizedBlockNumber: '110', finalizedBlockHash: hash(510),
  };
}
function released(proof: ReleaseProof, id = 'take'): ReleasedRecord {
  return { type: 'released', id, at, proof };
}

/** Independent encoder matching the original v1 serialization and hash-chain order. */
function legacyWriter(c: TakerConfig, dryRun = false) {
  const path = join(c.stateDir, dryRun ? 'shadow.ndjson' : 'live.ndjson');
  let sequence = 0;
  let previous = '';
  writeFileSync(path, '', { flag: 'wx' });
  const append = (event: unknown): void => {
    const base = { sequence, previous, event };
    const digest = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    appendFileSync(path, JSON.stringify({ ...base, digest }) + '\n');
    sequence += 1;
    previous = digest;
  };
  append({ version: 1, chainId: c.chainId, wallet: c.wallet.address.toLowerCase(), dryRun });
  return { path, append, tip: () => ({ sequence, previous }) };
}
function finish(j: Journal, id = 'take', n = 1): void {
  j.append(decision(id, n));
  j.append(signed(id));
  j.append(outcome(id));
}
function expectBounded(j: Journal, successes: number, pending: number): void {
  expect(j.attempts.size).toBe(pending);
  expect(j.pending).toHaveLength(pending);
  expect(j).not.toHaveProperty('rows');
  const collections = Object.values(j).filter(value => value instanceof Map || value instanceof Set || Array.isArray(value));
  expect(collections.filter(value => value instanceof Map).map(value => value.size)).toEqual([pending]);
  expect(collections.filter(value => value instanceof Set).map(value => value.size)).toEqual([successes]);
  expect(collections.filter(value => Array.isArray(value))).toEqual([]);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(readSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(writeSync).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded v1 journal replay and retained authority', () => {
  it('replays an original-format chain and appends the exact next sequence and digest without rewriting history', () => {
    const c = config(); const old = legacyWriter(c);
    old.append(decision('filled')); old.append(signed('filled')); old.append(outcome('filled'));
    old.append(decision('reverted', 2)); old.append(signed('reverted', 172)); old.append(outcome('reverted', 172, 'reverted'));
    old.append(decision('poll', 3, false)); old.append(decision('pending', 4));
    const before = readFileSync(old.path, 'utf8');
    const j = new Journal(c, false);
    expect(j.spentWei6).toBe(600n); expect(j.reservedWei6).toBe(1000n);
    expect(j.consumed(hash(1))).toBe(true); expect(j.consumed(hash(2))).toBe(false);
    expect([...j.attempts.keys()]).toEqual(['pending']);
    const event = signed('pending', 173);
    const base = { ...old.tip(), event };
    j.append(event);
    const expected = { ...base, digest: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
    expect(readFileSync(old.path, 'utf8')).toBe(before + JSON.stringify(expected) + '\n');
    const reopened = new Journal(c, false);
    expect(reopened.pending[0]?.signed).toEqual(event);
    expectBounded(reopened, 1, 1);
  });

  it.each([128, 4096])('retains only successful quote hashes and one open attempt after %i completed histories', count => {
    const c = config(); const old = legacyWriter(c);
    let successes = 0;
    for (let i = 0; i < count; i += 1) {
      const id = `history-${i}`;
      old.append(decision(`poll-${i}`, count + i + 1, false));
      old.append(decision(id, i + 1)); old.append(signed(id, i + 10000, i));
      const result = i % 8 === 0 ? 'success' : 'reverted';
      old.append(outcome(id, i + 10000, result));
      if (result === 'success') successes += 1;
    }
    old.append(decision('pending', count + 1)); old.append(signed('pending', 99999));
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('whole-file replay is forbidden'); });
    vi.mocked(readSync).mockClear();
    const j = new Journal(c, false);
    expect(j.spentWei6).toBe(BigInt(successes) * 600n); expect(j.reservedWei6).toBe(1000n);
    expect(j.pending[0]?.decision.id).toBe('pending');
    for (let i = 0; i < count; i += 1) expect(j.consumed(hash(i + 1))).toBe(i % 8 === 0);
    expect(j.consumed(hash(count + 1))).toBe(false);
    expectBounded(j, successes, 1);
    expect(vi.mocked(readSync).mock.calls.length).toBeGreaterThan(1);
    for (const call of vi.mocked(readSync).mock.calls) {
      const length = (call as unknown as [number, Uint8Array, number, number, null])[3];
      expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(64 * 1024);
    }
    // Accounting and no-repeat lookups must not rescan even the pending map.
    const scan = vi.spyOn(j.attempts, 'values').mockImplementation(() => { throw new Error('unexpected attempt scan'); });
    expect(j.spentWei6).toBe(BigInt(successes) * 600n); expect(j.reservedWei6).toBe(1000n);
    expect(j.consumed(hash(1))).toBe(true); scan.mockRestore();
    j.append(outcome('pending', 99999, 'reverted'));
    for (let i = 0; i < count; i += 1) j.append(decision(`new-poll-${i}`, count + i + 1, false));
    expect(j.spentWei6).toBe(BigInt(successes) * 600n); expect(j.reservedWei6).toBe(0n);
    expectBounded(j, successes, 0);
  }, 30_000); // Thousands of real fsynced appends must also fit slower local disks.

  it('does not retain completed live attempts or shadow/pass polls during append', () => {
    const c = config(); const j = new Journal(c, false, true); const shadow = new Journal(c, true, true);
    for (let i = 0; i < 100; i += 1) {
      j.append(decision(`poll-${i}`, i + 1000, false));
      finish(j, `filled-${i}`, i + 1);
      shadow.append(decision(`shadow-${i}`, i + 1, true, true));
    }
    expect(j.spentWei6).toBe(60000n); expect(j.reservedWei6).toBe(0n);
    expectBounded(j, 100, 0); expectBounded(shadow, 0, 0);
    expectBounded(new Journal(c, true), 0, 0);
    expect(() => j.append(decision('repeat', 1))).toThrow('Duplicate');
  });

  it('preserves UTF-8 and hashes when one row crosses multiple bounded read chunks', () => {
    const c = config(); const old = legacyWriter(c);
    old.append({ ...decision(), makerLabel: 'é🌍'.repeat(20000) });
    const j = new Journal(c, false);
    expect(j.pending[0]?.decision.makerLabel).toBe('é🌍'.repeat(20000));
    expect(j.reservedWei6).toBe(1000n);
  });

  it.each(['terminated', 'unterminated'])('rejects an oversized %s row without loading the rest of the file', ending => {
    const c = config(); const old = legacyWriter(c);
    if (ending === 'terminated') old.append({ ...decision(), makerLabel: 'x'.repeat(maxRowBytes + 1) });
    else appendFileSync(old.path, 'x'.repeat(maxRowBytes * 2));
    vi.mocked(readSync).mockClear();
    expect(() => new Journal(c, false)).toThrow(/row.*(size|large)|size.*row/i);
    const requestedBytes = vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + (call as unknown as [number, Uint8Array, number, number, null])[3], 0);
    expect(requestedBytes).toBeLessThanOrEqual(maxRowBytes + 2 * 64 * 1024);
  });

  it('accepts a row exactly at the byte limit and continues the original chain', () => {
    const c = config(); const old = legacyWriter(c); const event = { ...decision(), makerLabel: '' };
    const emptyRow = { ...old.tip(), event, digest: '0'.repeat(64) };
    const padding = maxRowBytes - Buffer.byteLength(JSON.stringify(emptyRow));
    event.makerLabel = 'x'.repeat(padding); old.append(event);
    const j = new Journal(c, false);
    expect(j.pending[0]?.decision.makerLabel).toHaveLength(padding);
    j.append(signed()); j.append(outcome());
    expect(new Journal(c, false).spentWei6).toBe(600n);
  });

  it('bounds row bytes rather than UTF-16 string length', () => {
    const c = config(); const old = legacyWriter(c);
    old.append({ ...decision(), makerLabel: '🌍'.repeat(maxRowBytes / 4) });
    expect(() => new Journal(c, false)).toThrow(/row.*(size|large)|size.*row/i);
  });

  it('rejects an oversized append before changing the journal or its reservation', () => {
    const c = config(); const j = new Journal(c, false, true); const before = readFileSync(j.path, 'utf8');
    expect(() => j.append({ ...decision(), makerLabel: 'x'.repeat(maxRowBytes + 1) })).toThrow();
    expect(readFileSync(j.path, 'utf8')).toBe(before);
    expect(j.spentWei6).toBe(0n); expect(j.reservedWei6).toBe(0n); expect(j.pending).toEqual([]);
  });

  it.each(['empty', 'truncated', 'malformed', 'wrong-sequence', 'wrong-previous', 'wrong-digest', 'blank-row'])('fails closed on %s history', mode => {
    const c = config(); const old = legacyWriter(c);
    if (mode === 'empty') writeFileSync(old.path, '');
    else if (mode === 'truncated') appendFileSync(old.path, '{"sequence":1');
    else if (mode === 'malformed') appendFileSync(old.path, '{not json}\n');
    else if (mode === 'blank-row') appendFileSync(old.path, '\n');
    else {
      old.append(decision());
      const lines = readFileSync(old.path, 'utf8').trimEnd().split('\n');
      const row = JSON.parse(lines[1]!);
      if (mode === 'wrong-sequence') row.sequence = 4;
      if (mode === 'wrong-previous') row.previous = 'wrong';
      if (mode === 'wrong-digest') row.digest = 'wrong';
      writeFileSync(old.path, lines[0] + '\n' + JSON.stringify(row) + '\n');
    }
    const before = readFileSync(old.path, 'utf8');
    expect(() => new Journal(c, false)).toThrow(/Incomplete|corrupt/);
    expect(readFileSync(old.path, 'utf8')).toBe(before);
  });

  it.each(['wallet', 'chain', 'mode'])('rejects a different %s identity without rewriting history', changed => {
    const c = config(); const old = legacyWriter(c); const before = readFileSync(old.path, 'utf8');
    if (changed === 'mode') writeFileSync(join(c.stateDir, 'shadow.ndjson'), before);
    const other = changed === 'wallet' ? { ...c, wallet: { ...c.wallet, address: `0x${'b'.repeat(40)}` } }
      : changed === 'chain' ? { ...c, chainId: 80002 as const } : c;
    expect(() => new Journal(other, changed === 'mode')).toThrow('corrupt');
    expect(readFileSync(old.path, 'utf8')).toBe(before);
  });

  it('requires explicit initialization and never overwrites an existing journal', () => {
    const c = config(); expect(() => new Journal(c, false)).toThrow('missing');
    const j = new Journal(c, false, true); finish(j);
    const before = readFileSync(j.path, 'utf8');
    expect(() => new Journal(c, false, true)).toThrow();
    expect(readFileSync(j.path, 'utf8')).toBe(before);
  });
});

describe('release records are bound evidence, never a manual reservation reset', () => {
  it('releases an unsigned attempt, preserving prior spend/history/consumption across reopen', () => {
    const c = config(); const j = new Journal(c, false, true); finish(j, 'filled', 1);
    j.append(decision('take', 2)); const before = readFileSync(j.path, 'utf8');
    const event = released({ kind: 'unsigned' }); j.append(event);
    expect(j.spentWei6).toBe(600n); expect(j.reservedWei6).toBe(0n); expect(j.pending).toEqual([]);
    expect(j.consumed(hash(1))).toBe(true); expect(j.consumed(hash(2))).toBe(false);
    expect(readFileSync(j.path, 'utf8').startsWith(before)).toBe(true);
    expect(() => j.append(event)).toThrow('completed');
    const reopened = new Journal(c, false);
    expect(reopened.spentWei6).toBe(600n); expect(reopened.reservedWei6).toBe(0n);
    expect(reopened.consumed(hash(1))).toBe(true); expect(reopened.consumed(hash(2))).toBe(false);
    expectBounded(reopened, 1, 0);
    reopened.append(decision('retry-after-proven-release', 2));
    expect(reopened.reservedWei6).toBe(1000n);
  });

  it('accepts a bound replacement proof, including case-insensitive hashes/wallet, and replays it', () => {
    const c = config(); const j = new Journal(c, false, true); finish(j, 'filled', 1);
    j.append(decision('take', 2)); j.append(signed());
    const proof = replaced(c);
    proof.wallet = upperHex(proof.wallet); proof.txHash = upperHex(proof.txHash);
    j.append(released(proof));
    expect(j.spentWei6).toBe(600n); expect(j.reservedWei6).toBe(0n);
    expect(j.consumed(hash(2))).toBe(false); expectBounded(j, 1, 0);
    const reopened = new Journal(c, false);
    expect(reopened.spentWei6).toBe(600n); expect(reopened.reservedWei6).toBe(0n);
    expect(reopened.consumed(hash(1))).toBe(true); expect(reopened.consumed(hash(2))).toBe(false);
    expectBounded(reopened, 1, 0);
    expect(() => reopened.append(released(proof))).toThrow('completed');
  });

  it('allows replacement inclusion at the finalized height and compares large heights exactly', () => {
    const c = config(); const j = new Journal(c, false, true);
    j.append(decision()); j.append(signed());
    const proof = { ...replaced(c), blockNumber: '9007199254740993', finalizedBlockNumber: '9007199254740993', finalizedBlockHash: hash(500) };
    j.append(released(proof)); expect(j.reservedWei6).toBe(0n);
  });

  it.each(['unknown', 'completed', 'signed-as-unsigned', 'unsigned-as-replaced'])('rejects %s releases without changing state or bytes', mode => {
    const c = config(); const j = new Journal(c, false, true);
    if (mode === 'completed') finish(j);
    else if (mode !== 'unknown') {
      j.append(decision()); if (mode === 'signed-as-unsigned') j.append(signed());
    }
    const before = readFileSync(j.path, 'utf8'); const spent = j.spentWei6; const reserved = j.reservedWei6;
    const proof: ReleaseProof = mode === 'unsigned-as-replaced' ? replaced(c) : { kind: 'unsigned' };
    expect(() => j.append(released(proof))).toThrow();
    expect(readFileSync(j.path, 'utf8')).toBe(before);
    expect(j.spentWei6).toBe(spent); expect(j.reservedWei6).toBe(reserved);
  });

  const invalidProofs: Array<[string, (proof: Extract<ReleaseProof, { kind: 'replaced' }>) => unknown]> = [
    ['null', () => null], ['missing kind', p => ({ ...p, kind: undefined })],
    ['unknown kind', p => ({ ...p, kind: 'manual' })],
    ['wrong chain', p => ({ ...p, chainId: 80002 })], ['string chain', p => ({ ...p, chainId: '137' })],
    ['wrong wallet', p => ({ ...p, wallet: `0x${'b'.repeat(40)}` })], ['malformed wallet', p => ({ ...p, wallet: 'not-an-address' })],
    ['wrong nonce', p => ({ ...p, nonce: 8 })], ['fractional nonce', p => ({ ...p, nonce: 7.5 })],
    ['negative nonce', p => ({ ...p, nonce: -1 })], ['string nonce', p => ({ ...p, nonce: '7' })],
    ['unsafe nonce', p => ({ ...p, nonce: Number.MAX_SAFE_INTEGER + 1 })],
    ['wrong original hash', p => ({ ...p, txHash: hash(173) })], ['malformed original hash', p => ({ ...p, txHash: 'bad' })],
    ['same replacement hash', p => ({ ...p, replacementHash: upperHex(p.txHash) })],
    ['malformed replacement hash', p => ({ ...p, replacementHash: 'bad' })],
    ['numeric block', p => ({ ...p, blockNumber: 100 })], ['negative block', p => ({ ...p, blockNumber: '-1' })],
    ['noncanonical block', p => ({ ...p, blockNumber: '0100' })], ['malformed block hash', p => ({ ...p, blockHash: 'bad' })],
    ['earlier finality', p => ({ ...p, finalizedBlockNumber: '99' })],
    ['large earlier finality', p => ({ ...p, blockNumber: '9007199254740993', finalizedBlockNumber: '9007199254740992' })],
    ['noncanonical finality', p => ({ ...p, finalizedBlockNumber: '0110' })],
    ['missing finality', p => ({ ...p, finalizedBlockNumber: undefined })],
    ['malformed finality hash', p => ({ ...p, finalizedBlockHash: 'bad' })],
    ['extra proof field', p => ({ ...p, force: true })],
  ];
  it.each(invalidProofs)('rejects %s in replacement proofs on append and valid-chain replay', (_name, change) => {
    const c = config(); const j = new Journal(c, false, true); j.append(decision()); j.append(signed());
    const bad = released(change(replaced(c)) as ReleaseProof); const before = readFileSync(j.path, 'utf8');
    expect(() => j.append(bad)).toThrow('release');
    expect(readFileSync(j.path, 'utf8')).toBe(before);
    expect(j.reservedWei6).toBe(1000n); expect(j.spentWei6).toBe(0n); expect(j.pending).toHaveLength(1);
    const other = config(); const old = legacyWriter(other); old.append(decision()); old.append(signed()); old.append(bad);
    expect(() => new Journal(other, false)).toThrow('corrupt');
  });

  it('rejects extra fields on unsigned proofs rather than treating them as a bypass', () => {
    const c = config(); const j = new Journal(c, false, true); j.append(decision());
    expect(() => j.append(released({ kind: 'unsigned', force: true } as ReleaseProof))).toThrow('release');
    expect(j.reservedWei6).toBe(1000n);
  });
});

describe('fail-closed durable append and trusted store errors', () => {
  it('does not recreate a deleted journal and latches failure even if its path is restored', () => {
    const c = config(); const j = new Journal(c, false, true); const before = readFileSync(j.path, 'utf8');
    rmSync(j.path); expect(() => j.append(decision())).toThrow('Journal write failed');
    expect(existsSync(j.path)).toBe(false);
    writeFileSync(j.path, before);
    expect(() => j.append(decision('retry'))).toThrow('Journal write failed');
    expect(readFileSync(j.path, 'utf8')).toBe(before);
  });

  it.each(['outcome', 'released'])('does not release the in-memory reservation when %s fsync fails', kind => {
    const c = config(); const j = new Journal(c, false, true); j.append(decision()); j.append(signed());
    const event: RecordEvent = kind === 'outcome' ? outcome() : released(replaced(c));
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('untrusted filesystem secret'); });
    expect(() => j.append(event)).toThrow('Journal write failed');
    expect(j.spentWei6).toBe(0n); expect(j.reservedWei6).toBe(1000n); expect(j.pending).toHaveLength(1);
    expect(j.consumed(hash(1))).toBe(false);
    vi.mocked(writeSync).mockClear();
    expect(() => j.append(event)).toThrow('Journal write failed');
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('latches a zero-byte short write without advancing durable state', () => {
    const c = config(); const j = new Journal(c, false, true); const before = readFileSync(j.path, 'utf8');
    vi.mocked(writeSync).mockReturnValueOnce(0);
    expect(() => j.append(decision())).toThrow('Journal write failed');
    expect(readFileSync(j.path, 'utf8')).toBe(before); expect(j.pending).toEqual([]);
    expect(() => j.append(decision())).toThrow('Journal write failed');
  });

  it('uses constant typed errors for journal, maker-directory and lock failures', () => {
    const c = config();
    expect(() => new Journal(c, false)).toThrowError(expect.objectContaining({ code: 'TAKER_JOURNAL' }));
    writeFileSync(join(c.stateDir, 'maker-state.json'), 'sentinel');
    expect(() => new Journal(c, false, true)).toThrowError(expect.objectContaining({ code: 'TAKER_STATE' }));
    expect(readFileSync(join(c.stateDir, 'maker-state.json'), 'utf8')).toBe('sentinel');
    const other = config(); const unlock = lockTaker(other);
    try { expect(() => lockTaker(other)).toThrowError(expect.objectContaining({ code: 'TAKER_LOCK' })); }
    finally { unlock(); }
  });
});
