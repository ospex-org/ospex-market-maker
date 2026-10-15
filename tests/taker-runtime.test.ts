import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseConfig, type TakerConfig } from '../src/taker/config.js';
import { Journal, lockTaker, type Attempt, type DecisionRecord } from '../src/taker/store.js';
import { Taker, type TakerGateway, type SignHooks } from '../src/taker/engine.js';
import { evaluate, type Quote, type Reference } from '../src/taker/policy.js';

// Synthetic business-state fixtures, not captured production quotes or receipts.
const now = Date.parse('2026-10-15T12:00:00Z');
const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const dirs: string[] = [];
const config = (): TakerConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'taker-test-')); dirs.push(dir);
  return parseConfig({ schemaVersion: 1, mode: { dryRun: false }, chainId: 137,
    apiUrl: 'https://example.invalid', rpcUrl: 'https://example.invalid',
    wallet: { address: `0x${'1'.repeat(40)}`, keystorePath: 'not-a-wallet' },
    makers: [{ address: `0x${'2'.repeat(40)}`, label: 'synthetic outside maker', controller: 'test' }],
    houseWallets: [{ address: `0x${'3'.repeat(40)}`, label: 'synthetic house', controller: 'test' }],
    distancePp: 0, capUSDC: '1', minSecondsLeft: 30, pollIntervalMs: 100, stateDir: dir });
};
const quote = (n = 1, stake = '1000000'): Quote => ({ hash: hash(n), maker: `0x${'2'.repeat(40)}`, contestId: '15', market: 'moneyline', lineTicks: 0, makerSide: 0, makerOddsTick: 200, remainingMakerWei6: stake, expiry: '2026-10-15T13:00:00Z' });
const reference = (): Reference => ({ contestId: '15', market: 'moneyline', awayOddsAmerican: -110, homeOddsAmerican: -110, upstreamLastUpdated: '2026-10-15T04:00:00Z', pollCapturedAt: '2026-10-15T11:00:00Z', changedAt: '2026-10-15T04:00:00Z' });
const receipt = (a: Attempt, result: 'success' | 'reverted' = 'success', amount?: string) => ({ txHash: a.signed!.txHash, result, stakeWei6: result === 'reverted' ? '0' : (amount ?? a.decision.decision.stakeWei6), receiptAt: '2026-10-15T12:00:02Z', includedAt: '2026-10-15T12:00:01Z', blockNumber: '100', blockHash: hash(500) });
function gateway(quotes = [quote()]): TakerGateway {
  return { book: vi.fn(async () => quotes), reference: vi.fn(async () => reference()), allowance: vi.fn(async () => true),
    prepare: vi.fn(async q => ({ quote: q, sign: vi.fn(async hooks => { await hooks.beforeSign(q); hooks.signed(hash(101), 1, '2026-10-15T12:00:00Z'); }) })),
    receipt: vi.fn(async a => receipt(a)) };
}
function reserve(c: TakerConfig, j: Journal, id = 'a'): void {
  const q = quote();
  const event: DecisionRecord = { type: 'decision', id, at: new Date(now).toISOString(), dryRun: false, quote: q, reference: reference(), decision: evaluate(q, reference(), c, now, 0n), makerLabel: 'test', makerController: 'test', capWei6: '1000000', distanceLimitPp: c.distancePp, txHash: null, submissionAt: null, receiptAt: null };
  j.append(event);
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('durable cumulative stakes and reservations', () => {
  it('does not recreate a deleted journal or invent unknown price fields', () => {
    const c = config(); const j = new Journal(c, false, true); rmSync(j.path);
    expect(() => reserve(c, j)).toThrow('Journal write failed');
    expect(existsSync(j.path)).toBe(false);
    const d = evaluate({ ...quote(), hash: 'invalid' }, null, c, now, 0n);
    expect(d.bettorSide).toBeNull(); expect(d.bettorDecimal).toBeNull();
    expect(d.secondsLeft).toBeNull(); expect(d.distancePp).toBeNull();
  });
  it('requires explicit new initialization; never recreates a missing spend ledger', () => {
    const c = config(); expect(() => new Journal(c, false)).toThrow('missing');
    new Journal(c, false, true); expect(() => new Journal(c, false, true)).toThrow();
  });
  it('fails closed on truncation, invalid hash chain, changed wallet/chain/mode', () => {
    const c = config(); const j = new Journal(c, false, true);
    expect(() => new Journal({ ...c, chainId: 80002 }, false)).toThrow('corrupt');
    expect(() => new Journal({ ...c, wallet: { ...c.wallet, address: `0x${'4'.repeat(40)}` } }, false)).toThrow('corrupt');
    appendFileSync(j.path, '{'); expect(() => new Journal(c, false)).toThrow('Incomplete');
    writeFileSync(j.path, '{"wrong":true}\n'); expect(() => new Journal(c, false)).toThrow('corrupt');
  });
  it('retains pre-sign reservations after restart; no hash never means free funds', () => {
    const c = config(); const j = new Journal(c, false, true); reserve(c, j);
    const reloaded = new Journal(c, false); expect(reloaded.reservedWei6).toBe(1_000_000n); expect(reloaded.spentWei6).toBe(0n);
    expect(() => reserve(c, reloaded, 'b')).toThrow('unresolved');
  });
  it('charges actual stakes only after a terminal receipt; winnings/restarts cannot reset it', () => {
    const c = config(); const j = new Journal(c, false, true); reserve(c, j);
    j.append({ type: 'signed', id: 'a', at: new Date(now).toISOString(), submissionAt: new Date(now).toISOString(), txHash: hash(101), nonce: 1 });
    j.append({ type: 'outcome', id: 'a', at: new Date(now).toISOString(), ...receipt(j.pending[0]!, 'success', '800000') });
    const reopened = new Journal(c, false); expect(reopened.spentWei6).toBe(800_000n); expect(reopened.reservedWei6).toBe(0n); expect(reopened.consumed(hash(1))).toBe(true);
    const raised = new Journal({ ...c, capUSDC: '2' }, false); expect(raised.spentWei6).toBe(800_000n);
    expect(() => j.append({ type: 'outcome', id: 'a', at: new Date(now).toISOString(), ...receipt([...j.attempts.values()][0]!) })).toThrow('completed');
  });
  it('rejects unrelated receipt hashes and success stakes larger than reservation', () => {
    const c = config(); const j = new Journal(c, false, true); reserve(c, j);
    j.append({ type: 'signed', id: 'a', at: new Date(now).toISOString(), submissionAt: new Date(now).toISOString(), txHash: hash(101), nonce: 1 });
    const r = receipt(j.pending[0]!);
    expect(() => j.append({ type: 'outcome', id: 'a', at: new Date(now).toISOString(), ...r, txHash: hash(102) })).toThrow('receipt');
    expect(() => j.append({ type: 'outcome', id: 'a', at: new Date(now).toISOString(), ...r, stakeWei6: '1000001' })).toThrow('stake');
  });
  it('does not open or modify maker state and excludes its state directory', () => {
    const c = config(); writeFileSync(join(c.stateDir, 'maker-state.json'), 'sentinel');
    expect(() => new Journal(c, false, true)).toThrow('own state');
    expect(readFileSync(join(c.stateDir, 'maker-state.json'), 'utf8')).toBe('sentinel');
  });
  it('rejects a real overlapping process and never automatically steals a stale lock', async () => {
    const c = config(); const release = lockTaker(c);
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {lockTaker} from './src/taker/store.ts'; try {lockTaker(JSON.parse(process.argv[1])); process.exit(0);} catch { process.exit(23); }`, JSON.stringify(c)], { cwd: process.cwd(), stdio: 'ignore' });
    const [code] = await once(child, 'exit'); expect(code).toBe(23);
    release(); const next = lockTaker(c); next();
    writeFileSync(join(c.stateDir, 'taker.lock'), '{"pid":999999999}');
    expect(() => lockTaker(c)).toThrow('locked');
  });
});

describe('one separate taker loop', () => {
  it('takes exactly to cap, records all timing/hash fields, then holds without scanning or stopping maker', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway();
    const t = new Taker(c, j, g, () => now); expect(await t.tick()).toContain('cap has been reached');
    expect(j.spentWei6).toBe(1_000_000n); expect(j.reservedWei6).toBe(0n);
    expect(g.reference).toHaveBeenCalledTimes(1); expect(await t.tick()).toContain('maker and everything else keep running');
    expect(g.book).toHaveBeenCalledTimes(1);
    const rows = readFileSync(j.path, 'utf8').trim().split('\n').map(s => JSON.parse(s).event);
    expect(rows.map(x => x.type)).toEqual([undefined, 'decision', 'signed', 'outcome']);
    expect(rows[1].decision.bettorDecimal).toBe(2); expect(rows[1].reference.upstreamLastUpdated).toBe('2026-10-15T04:00:00Z');
    expect(rows[2].submissionAt).toBeTruthy(); expect(rows[3].receiptAt).toBeTruthy(); expect(rows[3].stakeWei6).toBe('1000000');
  });
  it('passes a too-large full quote and keeps looking for a smaller one, never clipping', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway([quote(1, '2000000'), quote(2, '1000000')]);
    await new Taker(c, j, g, () => now).tick(); expect(j.spentWei6).toBe(1_000_000n);
    const rows = readFileSync(j.path, 'utf8').trim().split('\n').map(s => JSON.parse(s).event);
    expect(rows[1].decision.reason).toBe('would exceed the cap by 1 USDC'); expect(rows[1].decision.stakeWei6).toBe('2000000'); expect(rows[1].txHash).toBeNull();
    expect(j.consumed(hash(1))).toBe(false); expect(j.consumed(hash(2))).toBe(true);
  });
  it('reports true headroom and required full size while no fitting quote exists', async () => {
    const c = config(); const j = new Journal(c, false, true);
    const result = await new Taker(c, j, gateway([quote(1, '2000000')]), () => now).tick();
    expect(result).toContain('remaining 1; next quote needs 2'); expect(j.spentWei6).toBe(0n);
  });
  it.each(['timeout', 'missing', 'pre-sign-crash'])('keeps %s uncertainty reserved across restart without resend', async mode => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway();
    g.receipt = vi.fn(async () => { if (mode === 'timeout') throw new Error('synthetic network error'); return null; });
    if (mode === 'pre-sign-crash') g.prepare = vi.fn(async q => ({ quote: q, sign: async (h: SignHooks) => { await h.beforeSign(q); throw new Error('crash'); } }));
    const t = new Taker(c, j, g, () => now); await t.tick();
    const restored = new Journal(c, false); await new Taker(c, restored, g, () => now).tick();
    expect(restored.reservedWei6).toBe(1_000_000n); expect(g.book).toHaveBeenCalledTimes(1); expect(g.prepare).toHaveBeenCalledTimes(1);
  });
  it('reconciles a final success on restart before ever reading the book', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway();
    g.receipt = vi.fn(async () => null); await new Taker(c, j, g, () => now).tick();
    g.receipt = vi.fn(async a => receipt(a)); const restored = new Journal(c, false);
    expect(await new Taker(c, restored, g, () => now).tick()).toContain('cap has been reached'); expect(g.book).toHaveBeenCalledTimes(1); expect(restored.spentWei6).toBe(1_000_000n);
  });
  it('releases only a proven reverted receipt, then can fund a new quote', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway();
    g.receipt = vi.fn(async a => receipt(a, 'reverted')); await new Taker(c, j, g, () => now).tick();
    expect(j.spentWei6).toBe(0n); expect(j.reservedWei6).toBe(0n);
    g.receipt = vi.fn(async a => receipt(a)); await new Taker(c, j, g, () => now).tick(); expect(j.spentWei6).toBe(1_000_000n);
  });
  it.each(['self', 'house', 'outsider'])('never prepares a %s maker even if server filters fail', async kind => {
    const c = config(); const j = new Journal(c, false, true); const q = quote();
    q.maker = kind === 'self' ? c.wallet.address : kind === 'house' ? c.houseWallets[0]!.address : `0x${'4'.repeat(40)}`;
    const g = gateway([q]); await new Taker(c, j, g, () => now).tick(); expect(g.prepare).not.toHaveBeenCalled(); expect(j.pending).toHaveLength(0);
  });
  it('records read failure as a pass, not a fabricated reference; never invokes signing', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway(); g.reference = vi.fn(async () => { throw new Error('no number'); });
    await new Taker(c, j, g, () => now).tick(); expect(j.pending).toHaveLength(0); expect(readFileSync(j.path, 'utf8')).toContain('missing or malformed reference');
  });
  it('shadow mode never signs, checks allowance, reserves money or alters live journal', async () => {
    const c = config(); const live = new Journal(c, false, true); const before = readFileSync(live.path, 'utf8');
    const shadow = new Journal(c, true, true); const sign = vi.fn(); const g = gateway(); g.prepare = vi.fn(async q => ({ quote: q, sign }));
    await new Taker(c, shadow, g, () => now).tick(); expect(sign).not.toHaveBeenCalled(); expect(g.allowance).not.toHaveBeenCalled(); expect(shadow.reservedWei6).toBe(0n); expect(readFileSync(live.path, 'utf8')).toBe(before);
  });
  it('signal before signing produces a pass and cannot stop or cancel the maker', async () => {
    const c = config(); const j = new Journal(c, false, true); const g = gateway(); let stop = false;
    g.reference = vi.fn(async () => { stop = true; return reference(); });
    await new Taker(c, j, g, () => now, () => stop).tick(); expect(j.pending).toHaveLength(0); expect(readFileSync(j.path, 'utf8')).toContain('stop requested');
  });
});
