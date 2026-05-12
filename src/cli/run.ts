/**
 * `ospex-mm run --dry-run` — the shadow loop (DESIGN §8, §14). Constructs a
 * `Runner` (the boot-time state-loss fail-safe + the full tick loop: discovery →
 * reference-odds → per-market reconcile → age-out → terminal-record prune → state
 * flush) and runs it until a kill-switch file appears or a SIGTERM / SIGINT
 * arrives. `run --live` is Phase 3 — not yet implemented.
 *
 * The two-key model (DESIGN §8): live requires *both* `mode.dryRun: false` in the
 * config *and* the `--live` flag. v0 ships only the `--dry-run` side; passing
 * `--live` (with or without the config flag) is refused with a clear message.
 * `--dry-run` always forces dry-run regardless of `config.mode.dryRun` — a stray
 * config edit can't put real money on the table, and a stray `--dry-run` can't be
 * silently overridden by the config. (The config-vs-flag mismatch is surfaced as a
 * log line, not an error: `--dry-run` wins, and the operator is told the config
 * intended otherwise.)
 *
 * Unlike `doctor` / `quote`, `run` produces no report and takes no `--json` — its
 * structured output is the NDJSON event log under `telemetry.logDir` (read it with
 * `ospex-mm summary`). This module is the thin wiring: pick the mode, build the
 * adapter / run-id / state-store, construct the runner, run it. Those factories and
 * the runner's clock / sleep / kill-probe / signal / log / random seams are
 * injectable (`RunDeps`) so the wiring is unit-testable without a live RPC.
 */

import type { Config } from '../config/index.js';
import { createOspexAdapter, readKeystoreAddress, type Hex, type OspexAdapter } from '../ospex/index.js';
import { Runner, type RunnerDeps } from '../runners/index.js';
import { StateStore } from '../state/index.js';
import { newRunId } from '../telemetry/index.js';

// ── opts + deps ──────────────────────────────────────────────────────────────

/** Which mode the operator asked for. The CLI enforces that exactly one of `--dry-run` / `--live` was passed. */
export type RunMode = 'dry-run' | 'live';

export interface RunOpts {
  config: Config;
  /** `'dry-run'` runs the shadow loop; `'live'` is Phase 3 (refused in v0). */
  mode: RunMode;
  /** `--address` — the maker wallet. Displayed in the boot banner; dry-run posts nothing, so it isn't otherwise needed (the keystore-derived signer + fill-detection are Phase 3). */
  address?: Hex;
  /** `--ignore-missing-state` — the operator attests no prior run left a still-matchable commitment; lifts the boot-time state-loss hold (DESIGN §12). */
  ignoreMissingState: boolean;
}

/** Injectable seams so `runRun` can be exercised without a live RPC / real signals. */
export interface RunDeps {
  /** Build the chain/API adapter. Default: {@link createOspexAdapter}. */
  createAdapter?: (config: Config) => OspexAdapter;
  /** Mint this run's id. Default: {@link newRunId}. */
  makeRunId?: () => string;
  /** Open the state store for `state.dir`. Default: `StateStore.at`. */
  makeStateStore?: (dir: string) => StateStore;
  /** Forwarded to the `Runner` (clock / sleep / kill-probe / signal registration / log / random). */
  runnerDeps?: Partial<RunnerDeps>;
  /** Bound the loop after this many ticks (tests). Default: unbounded — runs until killed. */
  maxTicks?: number;
  /** Where the human-readable boot banner / refusal context goes. Default: a line to `process.stderr`. */
  log?: (line: string) => void;
}

/**
 * Thrown by `runRun` when the requested mode isn't available — currently only
 * `--live` (Phase 3). The CLI catches it, prints the message to stderr, and exits
 * `1`; distinct from an operational failure (a thrown `Error` is "run failed").
 */
export class RunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRefused';
  }
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Run the market-maker loop. Resolves only on a graceful shutdown (the kill-switch
 * file appeared, or a SIGTERM / SIGINT was received) — the loop runs indefinitely
 * otherwise (or `deps.maxTicks` ticks, for tests). Throws `RunRefused` for an
 * unavailable mode (`--live`), or a plain `Error` if construction / the loop fails
 * (e.g. the telemetry directory can't be created, or the state can't be persisted —
 * an un-persistable state must crash, not be silently continued).
 */
export async function runRun(opts: RunOpts, deps: RunDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  if (opts.mode === 'live') {
    throw new RunRefused(
      '`ospex-mm run --live` is not yet implemented — live execution (the real submit / cancel / approve / settle / claim paths, fill detection, the keystore-derived signer) is Phase 3 (DESIGN §14). Phase 2 ships `run --dry-run` — the shadow loop, which does everything except the writes.',
    );
  }

  const { config } = opts;

  // `--dry-run` forces dry-run regardless of config (DESIGN §8). If the config
  // intended live (`mode.dryRun: false`), say so — `--dry-run` wins, but the
  // operator should know their config and flag disagree.
  if (!config.mode.dryRun) {
    log('[run] note: config has mode.dryRun=false, but --dry-run forces the shadow loop — not running live. (Live needs both mode.dryRun=false AND --live — DESIGN §8.)');
  }

  const adapter = (deps.createAdapter ?? createOspexAdapter)(config);

  // Resolve the maker wallet best-effort, for the boot banner only. Dry-run posts
  // nothing, so an unresolved address is fine here; `--address` ▸ the keystore's
  // (optional) `address` field ▸ unknown (Foundry-style keystores omit it).
  const address: Hex | null =
    opts.address ?? (config.wallet.keystorePath !== undefined ? readKeystoreAddress(config.wallet.keystorePath) : null);
  log(
    `[run] maker wallet: ${address ?? '(unresolved — dry-run does not need it; pass --address or use an ethers-style keystore for the Phase-3 live path)'}`,
  );

  const runId = (deps.makeRunId ?? newRunId)();
  const stateStore = (deps.makeStateStore ?? ((dir: string): StateStore => StateStore.at(dir)))(config.state.dir);

  const runner = new Runner({
    config,
    adapter,
    stateStore,
    runId,
    ignoreMissingState: opts.ignoreMissingState,
    ...(deps.maxTicks !== undefined ? { maxTicks: deps.maxTicks } : {}),
    ...(deps.runnerDeps !== undefined ? { deps: deps.runnerDeps } : {}),
  });

  await runner.run();
}
