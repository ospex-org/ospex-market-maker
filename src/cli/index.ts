#!/usr/bin/env node
/**
 * `ospex-mm` — reference market maker CLI for Ospex.
 *
 * Command surface (DESIGN §3): `doctor`, `quote`, `run`, `cancel-stale`, `status`,
 * `summary`. Wired so far: `doctor` + `quote --dry-run` (strictly read-only),
 * `run --dry-run` (the shadow loop — posts nothing) + `run --live` (executes the
 * reconcile's submits / off-chain cancels on chain — the two-key model from
 * DESIGN §8 gates it; later Phase-3 slices add fill detection, gas budgeting,
 * auto-settle / auto-claim, the on-chain kill path), and `summary` (the NDJSON-log
 * aggregator). `cancel-stale` / `status` still exit 1 with "not yet implemented".
 *
 * CLI conventions (mirroring the SDK's AGENT_CONTRACT):
 *   - `--json` prints a `{ schemaVersion: 1, … }` envelope on stdout; everything
 *     else goes to stderr. (`run` has no `--json` — it's a loop, not a query; its
 *     structured output is the NDJSON event log under `telemetry.logDir`.)
 *   - exit `0` on success, `1` on any failure (config load, operational error, a
 *     "no" answer from `doctor`'s dry-run-shadow readiness or `quote`'s `canQuote`,
 *     an unavailable `run` mode).
 *
 * The per-command logic lives in `./doctor.ts` / `./quote.ts` / `./run.ts` /
 * `./summary.ts` as functions returning typed reports (or, for `run`, just running
 * the loop); this module is the thin commander wrapper — parse args, load config,
 * build the adapter, call the function, render, exit.
 */

import { Command } from 'commander';

import { loadConfig, type Config } from '../config/index.js';
import { createOspexAdapter, type Hex } from '../ospex/index.js';
import { doctorExitCode, renderDoctorReportJson, renderDoctorReportText, runDoctor } from './doctor.js';
import { quoteExitCode, renderQuoteReportJson, renderQuoteReportText, runQuote } from './quote.js';
import { RunRefused, runRun } from './run.js';
import { renderSummaryReportJson, renderSummaryReportText, runSummary, summaryExitCode, type RunSummary } from './summary.js';

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
      fail('`quote` is dry-run-only in v0 — pass --dry-run. (Posting quotes is `ospex-mm run --live`.)');
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

program
  .command('run')
  .description('Run the market-maker loop. --dry-run is the shadow loop (discovers, prices, reconciles, logs would-be quotes; posts nothing). --live posts real commitments (and also requires mode.dryRun: false in the config — the two-key model, DESIGN §8); the keystore passphrase comes from OSPEX_KEYSTORE_PASSPHRASE, else a TTY prompt.')
  .option('-c, --config <path>', 'path to the config YAML', DEFAULT_CONFIG_PATH)
  .option('--dry-run', 'run the shadow loop — everything except the writes (DESIGN §8)')
  .option('--live', 'post real commitments — also requires mode.dryRun: false in the config (the two-key model); reads the keystore passphrase from OSPEX_KEYSTORE_PASSPHRASE, else prompts on a TTY')
  .option('-a, --address <addr>', 'maker wallet address (dry-run only; in live mode the address is the signer\'s — passing it with --live is refused)')
  .option('-k, --keystore <path>', 'path to a v3 keystore — overrides config wallet.keystorePath / OSPEX_KEYSTORE_PATH')
  .option('--ignore-missing-state', 'proceed even if the persisted state is missing/corrupt — attests no prior run left a still-matchable commitment (DESIGN §12)')
  .option('--yes', 'confirm dangerous defaults — currently: approvals.mode=unlimited under --live with autoApprove=true (sets the PositionModule USDC allowance to MaxUint256). No effect otherwise')
  .action(async (opts: { config: string; dryRun?: boolean; live?: boolean; address?: string; keystore?: string; ignoreMissingState?: boolean; yes?: boolean }) => {
    const wantDry = opts.dryRun === true;
    const wantLive = opts.live === true;
    if (wantDry && wantLive) fail('pass exactly one of --dry-run / --live, not both');
    if (!wantDry && !wantLive) fail('pass --dry-run (the shadow loop) or --live (post real commitments — also requires mode.dryRun: false in the config)');
    let config = loadConfigOrExit(opts.config);
    if (opts.keystore !== undefined) config = { ...config, wallet: { ...config.wallet, keystorePath: opts.keystore } };
    const address = parseAddressOrExit(opts.address);
    await runRun({
      config,
      mode: wantLive ? 'live' : 'dry-run',
      ...(address !== undefined ? { address } : {}),
      ignoreMissingState: opts.ignoreMissingState === true,
      confirmUnlimited: opts.yes === true,
    }).catch((e: unknown): never => {
      if (e instanceof RunRefused) return fail(e.message);
      return fail(`run failed: ${(e as Error).message}`);
    });
    // `runRun` returns only on a graceful shutdown (kill-switch file / SIGTERM / SIGINT).
    process.exit(0);
  });

program
  .command('summary')
  .description('Aggregate the NDJSON event logs under telemetry.logDir into the run metrics (quote competitiveness, quote age, latent-exposure peak, candidate/error counts, …).')
  .option('-c, --config <path>', 'path to the config YAML', DEFAULT_CONFIG_PATH)
  .option('--since <ts>', 'only aggregate events at/after this ISO-8601 timestamp (e.g. 2026-05-12T14:00:00Z)')
  .option('--json', 'emit a JSON envelope { schemaVersion: 1, summary: … } on stdout')
  .action((opts: { config: string; since?: string; json?: boolean }) => {
    const config = loadConfigOrExit(opts.config);
    let summary: RunSummary;
    try {
      summary = runSummary({ config, ...(opts.since !== undefined ? { sinceIso: opts.since } : {}) });
    } catch (e) {
      return fail(`summary failed: ${(e as Error).message}`);
    }
    if (opts.json === true) renderSummaryReportJson(summary, stdout);
    else renderSummaryReportText(summary, config.telemetry.logDir, stdout);
    process.exit(summaryExitCode(summary));
  });

// ── Phase 3+ stubs — present so `--help` lists them and a stray invocation fails clearly ──

const STUBS: ReadonlyArray<readonly [name: string, note: string]> = [
  ['cancel-stale', 'Phase 3'],
  ['status', 'Phase 3'],
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
