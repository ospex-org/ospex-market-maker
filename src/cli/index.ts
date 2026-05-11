#!/usr/bin/env node
/**
 * `ospex-mm` — reference market maker CLI for Ospex.
 *
 * Command surface (DESIGN §3): `doctor`, `quote`, `run`, `cancel-stale`, `status`,
 * `summary`. Phase 1 wires `doctor` + `quote --dry-run` (both strictly read-only);
 * `run` / `cancel-stale` / `status` / `summary` are stubs that exit 1 with a
 * "not yet implemented" message.
 *
 * CLI conventions (mirroring the SDK's AGENT_CONTRACT):
 *   - `--json` prints a `{ schemaVersion: 1, … }` envelope on stdout; everything
 *     else goes to stderr.
 *   - exit `0` on success, `1` on any failure (config load, operational error, a
 *     "no" answer from `doctor`'s dry-run-shadow readiness or `quote`'s `canQuote`).
 *
 * The per-command logic lives in `./doctor.ts` / `./quote.ts` as pure(-ish)
 * functions returning typed reports; this module is the thin commander wrapper —
 * parse args, load config, build the adapter, call the function, render, exit.
 */

import { Command } from 'commander';

import { loadConfig, type Config } from '../config/index.js';
import { createOspexAdapter, type Hex } from '../ospex/index.js';
import { doctorExitCode, renderDoctorReportJson, renderDoctorReportText, runDoctor } from './doctor.js';
import { quoteExitCode, renderQuoteReportJson, renderQuoteReportText, runQuote } from './quote.js';

const DEFAULT_CONFIG_PATH = './ospex-mm.yaml';

// ── small helpers ────────────────────────────────────────────────────────────

const stdout = { write: (s: string): void => void process.stdout.write(s) };

/** Print to stderr and exit 1. Used for config-load failures and operational errors. */
function fail(message: string): never {
  process.stderr.write(`ospex-mm: ${message}\n`);
  process.exit(1);
}

function loadConfigOrExit(path: string): Config {
  try {
    return loadConfig(path);
  } catch (e) {
    return fail(`failed to load config from ${path}: ${(e as Error).message}`);
  }
}

function parseAddressOrExit(raw: string | undefined): Hex | undefined {
  if (raw === undefined) return undefined;
  const hex = raw.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) return fail(`--address must be a 0x-prefixed 40-hex-char wallet address, got "${raw}"`);
  return `0x${hex}` as Hex;
}

// ── program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name('ospex-mm')
  .description('Reference market maker for the Ospex protocol — clone, configure, run.')
  .showHelpAfterError();

program
  .command('doctor')
  .description('Readiness check: config, keystore, API, RPC, balances, allowances, state — plus a "Ready to" matrix.')
  .option('-c, --config <path>', 'path to the config YAML', DEFAULT_CONFIG_PATH)
  .option('-a, --address <addr>', 'wallet address to check (defaults to the keystore; passing it avoids a passphrase prompt and keeps the call read-only)')
  .option('--json', 'emit a JSON envelope { schemaVersion: 1, doctor: … } on stdout')
  .action(async (opts: { config: string; address?: string; json?: boolean }) => {
    const config = loadConfigOrExit(opts.config);
    const address = parseAddressOrExit(opts.address);
    const adapter = createOspexAdapter(config);
    const report = await runDoctor({
      config,
      configPath: opts.config,
      adapter,
      ...(address !== undefined ? { address } : {}),
    }).catch((e: unknown): never => fail(`doctor failed: ${(e as Error).message}`));
    if (opts.json === true) renderDoctorReportJson(report, stdout);
    else renderDoctorReportText(report, stdout);
    process.exit(doctorExitCode(report));
  });

program
  .command('quote')
  .description('Compute a two-sided moneyline quote for a contest. Dry-run only in v0 — never posts.')
  .argument('<contestId>', 'the contest to price')
  .option('-c, --config <path>', 'path to the config YAML', DEFAULT_CONFIG_PATH)
  .option('--dry-run', 'required — `quote` is a preview in v0 (posting quotes is `run --live`, Phase 3)')
  .option('--json', 'emit a JSON envelope { schemaVersion: 1, quote: … } on stdout')
  .action(async (contestId: string, opts: { config: string; dryRun?: boolean; json?: boolean }) => {
    if (opts.dryRun !== true) {
      fail('`quote` is dry-run-only in v0 — pass --dry-run. (Posting quotes is `ospex-mm run --live`, Phase 3.)');
    }
    const config = loadConfigOrExit(opts.config);
    const adapter = createOspexAdapter(config);
    const report = await runQuote({ contestId, config, adapter }).catch((e: unknown): never =>
      fail(`quote failed for contest ${contestId}: ${(e as Error).message}`),
    );
    if (opts.json === true) renderQuoteReportJson(report, stdout);
    else renderQuoteReportText(report, stdout);
    process.exit(quoteExitCode(report));
  });

// ── Phase 2+ stubs — present so `--help` lists them and a stray invocation fails clearly ──

const STUBS: ReadonlyArray<readonly [name: string, note: string]> = [
  ['run', 'Phase 2 for --dry-run shadow mode; Phase 3 for --live'],
  ['cancel-stale', 'Phase 3'],
  ['status', 'Phase 3'],
  ['summary', 'Phase 3'],
];
for (const [name, note] of STUBS) {
  program
    .command(name)
    .description(`(not yet implemented — ${note})`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      process.stderr.write(`ospex-mm ${name}: not yet implemented (${note}) — see docs/DESIGN.md §14\n`);
      process.exit(1);
    });
}

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`ospex-mm: ${(e as Error).message}\n`);
  process.exit(1);
});
