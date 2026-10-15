import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the actual entry point, but ONLY its local init/status commands.
// Synthetic addresses, nonexistent keystore, invalid endpoints, no credentials.
const root = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
