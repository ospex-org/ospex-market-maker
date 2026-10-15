import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig } from '../src/taker/config.js';
import { Journal } from '../src/taker/store.js';
import { evaluate } from '../src/taker/policy.js';
import yaml from 'js-yaml';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the actual entry point, but ONLY its local init/status commands.
// Synthetic addresses, nonexistent keystore, invalid endpoints, no credentials.
const root = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(dryRun: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'taker-cli-')); dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: { dryRun }, chainId: 137,
    apiUrl: 'https://example.invalid', rpcUrl: 'https://example.invalid', stateDir: './state',
    wallet: { address: `0x${'1'.repeat(40)}`, keystorePath: './does-not-exist.json' },
    makers: [{ address: `0x${'2'.repeat(40)}`, label: 'synthetic outside', controller: 'synthetic' }],
    houseWallets: [{ address: `0x${'3'.repeat(40)}`, label: 'synthetic house', controller: 'synthetic' }],
    distancePp: 0, capUSDC: '1', minSecondsLeft: 30, pollIntervalMs: 1000 }));
  return path;
}
function cli(command: string, config: string, live = false) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/taker/cli.ts', command, '--config', config, ...(live ? ['--live'] : [])],
    { cwd: root, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, TMPDIR: tmpdir() } });
}

describe('separate CLI entry point', () => {
  it.each([
    { dryRun: true, live: false, shadow: true },
    { dryRun: true, live: true, shadow: true },
    { dryRun: false, live: false, shadow: true },
    { dryRun: false, live: true, shadow: false },
  ])('selects its own journal with both keys: %j', ({ dryRun, live, shadow }) => {
    const dir = mkdtempSync(join(tmpdir(), 'taker-cli-')); dirs.push(dir);
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({
      schemaVersion: 1, mode: { dryRun }, chainId: 137,
      apiUrl: 'https://example.invalid', rpcUrl: 'https://example.invalid', stateDir: './state',
      wallet: { address: `0x${'1'.repeat(40)}`, keystorePath: './does-not-exist.json' },
      makers: [{ address: `0x${'2'.repeat(40)}`, label: 'synthetic outside', controller: 'synthetic' }],
      houseWallets: [{ address: `0x${'3'.repeat(40)}`, label: 'synthetic house', controller: 'synthetic' }],
      distancePp: 0, capUSDC: '1', minSecondsLeft: 30, pollIntervalMs: 1000,
    }));
    const invoke = (command: string) => execFileSync(process.execPath, [
      '--import', 'tsx', 'src/taker/cli.ts', command, '--config', config, ...(live ? ['--live'] : []),
    ], { cwd: root, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, TMPDIR: tmpdir() } });
    expect(invoke('init')).toContain(`Initialized ${shadow ? 'shadow' : 'live'} journal`);
    const path = join(dir, 'state', shadow ? 'shadow.ndjson' : 'live.ndjson');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, 'state', shadow ? 'live.ndjson' : 'shadow.ndjson'))).toBe(false);
    const before = readFileSync(path, 'utf8');
    expect(invoke('status')).toContain('spent 0 USDC; reserved 0; cap 1; unresolved takes 0');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'state', 'taker.lock'))).toBe(false);
    expect(existsSync(join(dir, 'does-not-exist.json'))).toBe(false);
  }, 45_000); // Two actual TS/SDK process startups can exceed 5s under full-suite load.
});


it('reports the invalid config field without its secret value or unknown key', () => {
  const p = fixture(true); const raw = yaml.load(readFileSync(p, 'utf8')) as Record<string, unknown>;
  raw.capUSDC = 'secret-config-value'; writeFileSync(p, yaml.dump(raw));
  let result = cli('status', p); expect(result.status).toBe(1); expect(result.stderr).toContain('TAKER_CONFIG');
  expect(result.stderr).toContain('capUSDC'); expect(result.stderr).not.toContain('secret-config-value');
  raw.capUSDC = '1'; raw['secret-key-token'] = 'secret-value'; writeFileSync(p, yaml.dump(raw));
  result = cli('status', p); expect(result.stderr).toContain('unknown key'); expect(result.stderr).not.toContain('secret-key-token');
}, 45_000);
it('classifies malformed YAML, missing journal, stale lock and corrupt history distinctly', () => {
  const p = fixture(true); const original = readFileSync(p, 'utf8');
  writeFileSync(p, 'wallet: [secret-yaml-value');
  let result = cli('status', p); expect(result.stderr).toContain('TAKER_CONFIG'); expect(result.stderr).not.toContain('secret-yaml-value');
  writeFileSync(p, original);
  result = cli('status', p); expect(result.stderr).toContain('TAKER_JOURNAL'); expect(result.stderr).toContain('missing');
  expect(cli('init', p).status).toBe(0);
  const dir = join(p, '..', 'state'); writeFileSync(join(dir, 'taker.lock'), 'private-lock-payload');
  result = cli('status', p); expect(result.stderr).toContain('TAKER_LOCK'); expect(result.stderr).not.toContain('private-lock-payload');
  rmSync(join(dir, 'taker.lock')); writeFileSync(join(dir, 'shadow.ndjson'), 'private-corrupt-payload\n');
  result = cli('status', p); expect(result.stderr).toContain('TAKER_JOURNAL'); expect(result.stderr).toContain('corrupt'); expect(result.stderr).not.toContain('private-corrupt-payload');
}, 45_000);
it('provides signer-free explicit reconciliation and lists pending IDs', () => {
  const p = fixture(false); const c = loadConfig(p); const j = new Journal(c, false, true);
  const at = '2026-10-15T12:00:00Z';
  const q = { hash: `0x${'a'.repeat(64)}`, maker: c.makers[0]!.address, contestId: '1', market: 'moneyline' as const, lineTicks: 0, makerSide: 0 as const, makerOddsTick: 200, remainingMakerWei6: '1000000', expiry: '2026-10-15T13:00:00Z' };
  const ref = { contestId: '1', market: 'moneyline' as const, homeOddsAmerican: 100, awayOddsAmerican: 100, upstreamLastUpdated: at, pollCapturedAt: at, changedAt: at };
  j.append({ type: 'decision', id: 'pending-test', at, dryRun: false, quote: q, reference: ref, decision: evaluate(q, ref, c, Date.parse(at), 0n), makerLabel: 'Synthetic maker', makerController: 'Test operator', capWei6: '1000000', distanceLimitPp: 0, txHash: null, submissionAt: null, receiptAt: null });
  expect(cli('status', p, true).stdout).toContain('pending-test');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/taker/cli.ts', 'reconcile', '--config', p, '--live', '--id', 'pending-test'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OSPEX_TAKER_PASSPHRASE: '' } });
  expect(result.status).toBe(0); expect(result.stdout).toContain('No transaction signed or sent');
  expect(new Journal(c, false).reservedWei6).toBe(0n); expect(existsSync(c.wallet.keystorePath)).toBe(false);
}, 45_000);
