/**
 * `ospex-mm run` — the market-maker loop. `--dry-run` is the Phase-2 shadow loop
 * (boots through the state-loss fail-safe, then ticks discovery → reference-odds
 * tracking → per-market reconcile → age-out → terminal-record prune → state flush;
 * posts nothing). `--live` (Phase 3) is the same loop with the reconcile's writes
 * wired through the SDK — submits via `commitments.submitRaw`, off-chain cancels
 * via `commitments.cancel`. (Fill detection, gas budgeting in POL, auto-settle /
 * auto-claim, the kill switch's on-chain cancel, and `cancel-stale` / `status` are
 * still landing in later Phase-3 slices.) Either mode runs until a kill-switch
 * file appears or a SIGTERM / SIGINT arrives.
 *
 * The two-key model (DESIGN §8): live requires *both* `mode.dryRun: false` in the
 * config *and* the `--live` flag. Either alone runs the shadow loop, and `--live`
 * with config `mode.dryRun: true` is refused — the operator should set the config
 * flag explicitly before opting in (a stray flag or a stray config edit shouldn't
 * be enough on its own). `--dry-run` always forces dry-run regardless of config;
 * the config-vs-flag mismatch is surfaced as a log line, not an error.
 *
 * In live mode, the keystore passphrase is read from `OSPEX_KEYSTORE_PASSPHRASE`
 * (preferred for non-interactive runs — worker dynos / CI / secret managers) or,
 * on a TTY, an interactive no-echo prompt. The signer's address determines the
 * maker wallet — `--address` is rejected with `--live` (the keystore is the
 * source of truth in live mode; pass `--address` only for `doctor` / dry-run).
 *
 * Unlike `doctor` / `quote`, `run` produces no report and takes no `--json` — its
 * structured output is the NDJSON event log under `telemetry.logDir` (read it with
 * `ospex-mm summary`). This module is the thin wiring: pick the mode, build the
 * adapter / run-id / state-store (live mode also unlocks the signer first),
 * construct the runner, run it. Those factories and the runner's clock / sleep /
 * kill-probe / signal / log / random seams are injectable (`RunDeps`) so the
 * wiring is unit-testable without a TTY / live RPC / real scrypt.
 */

import type { Config } from '../config/index.js';
import {
  createLiveOspexAdapter,
  createOspexAdapter,
  readKeystoreAddress,
  unlockKeystoreSigner,
  type Hex,
  type OspexAdapter,
  type Signer,
} from '../ospex/index.js';
import { Runner, type RunnerDeps } from '../runners/index.js';
import { StateStore } from '../state/index.js';
import { newRunId } from '../telemetry/index.js';

// ── opts + deps ──────────────────────────────────────────────────────────────

/** Which mode the operator asked for. The CLI enforces that exactly one of `--dry-run` / `--live` was passed. */
export type RunMode = 'dry-run' | 'live';

export interface RunOpts {
  config: Config;
  /** `'dry-run'` runs the shadow loop; `'live'` posts on chain (gated by the two-key model — also requires `config.mode.dryRun: false`). */
  mode: RunMode;
  /**
   * `--address` — the maker wallet. Used in dry-run only (the boot banner; dry-run posts nothing).
   * In live mode the address is the signer's; passing `--address` is refused (the keystore is the source of truth).
   */
  address?: Hex;
  /** `--ignore-missing-state` — the operator attests no prior run left a still-matchable commitment; lifts the boot-time state-loss hold (DESIGN §12). */
  ignoreMissingState: boolean;
  /** `--yes` — operator confirmation for dangerous defaults (currently: `approvals.mode: 'unlimited'` while `--live` and `autoApprove`). No effect otherwise. */
  confirmUnlimited: boolean;
}

/** Injectable seams so `runRun` can be exercised without a TTY / live RPC / real scrypt. */
export interface RunDeps {
  /** Build the *read-only* chain/API adapter (used in dry-run). Default: {@link createOspexAdapter}. */
  createAdapter?: (config: Config) => OspexAdapter;
  /** Build the *signed* chain/API adapter (used in live mode). Default: {@link createLiveOspexAdapter}. */
  createLiveAdapter?: (config: Config, signer: Signer) => OspexAdapter;
  /** Decrypt the keystore at `keystorePath` with `passphrase` and return the unlocked signer. Default: {@link unlockKeystoreSigner}. */
  unlockSigner?: (keystorePath: string, passphrase: string) => Promise<Signer>;
  /** Prompt the operator for the keystore passphrase (no-echo, TTY only). Default: {@link defaultPromptPassphrase}. Only called in live mode when `OSPEX_KEYSTORE_PASSPHRASE` is unset. */
  promptPassphrase?: () => Promise<string>;
  /** Environment for `OSPEX_KEYSTORE_PASSPHRASE` (and any future env keys). Default: `process.env`. */
  env?: Record<string, string | undefined>;
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
 * Thrown by `runRun` when the requested mode / config combination is refused
 * before any work starts — a missing two-key match, a missing precondition (no
 * keystore path, no passphrase), or an explicitly incompatible flag combination.
 * Distinct from a plain `Error` (which is "run failed: <message>"); the CLI
 * catches `RunRefused` and prints the message verbatim, then exits `1`.
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
 * otherwise (or `deps.maxTicks` ticks, for tests). Throws `RunRefused` for a
 * preconditions failure (the two-key gate, missing keystore path, missing
 * passphrase, `--address` with `--live`), or a plain `Error` for an operational
 * failure (a bad passphrase from the keystore decryptor; the telemetry directory
 * can't be created; the state can't be persisted; etc.).
 *
 * Before constructing anything downstream it normalizes the *effective* config so
 * `config.mode.dryRun` matches the resolved mode — `--dry-run` wins over a stale
 * `mode.dryRun: false`, so the adapter, the `Runner`, the runner's boot banner,
 * and any mode-aware code agree there's no live path.
 */
export async function runRun(opts: RunOpts, deps: RunDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  // The two-key gate (DESIGN §8): `--live` *requires* `config.mode.dryRun: false`.
  // A stray `--live` against a `dryRun: true` config is refused — the operator
  // must opt in via the config too.
  if (opts.mode === 'live' && opts.config.mode.dryRun) {
    throw new RunRefused(
      'refusing to run live: --live passed but config has mode.dryRun=true. The two-key model (DESIGN §8) requires BOTH the --live flag AND mode.dryRun=false in the config — set mode.dryRun=false in your config to opt in.',
    );
  }
  // `approvals.mode: 'unlimited'` + `autoApprove: true` + `--live` would set the
  // `PositionModule` USDC allowance to `MaxUint256` at boot. Rarely desirable
  // (any future bug or compromised key could pull arbitrary USDC); demand explicit
  // operator confirmation via `--yes`. `autoApprove: false` skips the whole
  // auto-approve flow, so `mode: unlimited` is inert there — no refusal.
  if (opts.mode === 'live' && opts.config.approvals.autoApprove && opts.config.approvals.mode === 'unlimited' && !opts.confirmUnlimited) {
    throw new RunRefused(
      "refusing to run live: approvals.autoApprove=true with approvals.mode=unlimited would set the PositionModule USDC allowance to MaxUint256. Pass --yes to confirm, or set approvals.mode=exact in your config (recommended — raises only to min(risk-cap ceiling, current wallet USDC) instead).",
    );
  }
  // `--address` is for read-only contexts (`doctor` / dry-run banners). In live
  // mode the maker address is the signer's — accepting an `--address` here would
  // create a confusing mismatch (the CLI's `--address` value vs the signer's
  // actual address). Refuse it.
  if (opts.mode === 'live' && opts.address !== undefined) {
    throw new RunRefused(
      '--address is incompatible with --live: the maker address in live mode is the signer\'s. Drop --address (the keystore determines it).',
    );
  }

  // `--dry-run` forces dry-run regardless of config (DESIGN §8). If the config
  // intended live (`mode.dryRun: false`), say so — `--dry-run` wins.
  if (opts.mode === 'dry-run' && !opts.config.mode.dryRun) {
    log('[run] note: config has mode.dryRun=false, but --dry-run forces the shadow loop — not running live. (Live needs both mode.dryRun=false AND --live — DESIGN §8.)');
  }
  // Normalize the effective config to the resolved mode so every downstream
  // component sees a self-consistent config (`--dry-run` → dryRun:true; `--live`
  // — which only got here past the two-key gate — keeps dryRun:false).
  const effectiveDryRun = opts.mode === 'dry-run';
  const config: Config = opts.config.mode.dryRun === effectiveDryRun ? opts.config : { ...opts.config, mode: { ...opts.config.mode, dryRun: effectiveDryRun } };

  // Live mode: unlock the signer first (passphrase from env, else a TTY prompt),
  // build the signed adapter, resolve the maker address from the signer for the
  // boot banner. Anything that throws below is either a `RunRefused` (a clean
  // refusal) or a plain `Error` (e.g. wrong passphrase, malformed keystore — the
  // CLI prints it under "run failed: …").
  let adapter: OspexAdapter;
  let bootAddress: string;
  let liveMakerAddress: Hex | null = null; // set in live mode (from `signer.getAddress()`) — passed to the Runner for fill detection + competitiveness self-exclusion
  if (opts.mode === 'live') {
    if (config.wallet.keystorePath === undefined) {
      throw new RunRefused(
        'live mode requires wallet.keystorePath in the config (or the OSPEX_KEYSTORE_PATH env, or --keystore on the command line). Set it before running with --live.',
      );
    }
    const env = deps.env ?? process.env;
    const promptPassphrase = deps.promptPassphrase ?? defaultPromptPassphrase;
    let passphrase: string;
    const envPassphrase = env.OSPEX_KEYSTORE_PASSPHRASE;
    if (envPassphrase !== undefined && envPassphrase.length > 0) {
      passphrase = envPassphrase;
    } else {
      try {
        passphrase = await promptPassphrase();
      } catch (err) {
        throw new RunRefused(
          `live mode needs the keystore passphrase: ${(err as Error).message}. Set OSPEX_KEYSTORE_PASSPHRASE in the environment to unlock non-interactively.`,
        );
      }
    }
    const unlockSigner = deps.unlockSigner ?? unlockKeystoreSigner;
    const signer = await unlockSigner(config.wallet.keystorePath, passphrase); // a bad passphrase / malformed keystore throws a plain Error — the CLI surfaces it as "run failed: …"
    liveMakerAddress = await signer.getAddress();
    bootAddress = liveMakerAddress;
    adapter = (deps.createLiveAdapter ?? createLiveOspexAdapter)(config, signer);
  } else {
    adapter = (deps.createAdapter ?? createOspexAdapter)(config);
    // Resolve the maker wallet best-effort, for the boot banner only. Dry-run
    // posts nothing, so an unresolved address is fine here; `--address` ▸ the
    // keystore's (optional) `address` field ▸ unknown (Foundry-style keystores
    // omit it for privacy).
    const resolved: Hex | null = opts.address ?? (config.wallet.keystorePath !== undefined ? readKeystoreAddress(config.wallet.keystorePath) : null);
    bootAddress = resolved ?? '(unresolved — dry-run does not need it; pass --address or use an ethers-style keystore)';
  }
  log(`[run] maker wallet: ${bootAddress}`);

  const runId = (deps.makeRunId ?? newRunId)();
  const stateStore = (deps.makeStateStore ?? ((dir: string): StateStore => StateStore.at(dir)))(config.state.dir);

  const runner = new Runner({
    config,
    adapter,
    stateStore,
    runId,
    ignoreMissingState: opts.ignoreMissingState,
    ...(liveMakerAddress !== null ? { makerAddress: liveMakerAddress } : {}),
    ...(deps.maxTicks !== undefined ? { maxTicks: deps.maxTicks } : {}),
    ...(deps.runnerDeps !== undefined ? { deps: deps.runnerDeps } : {}),
  });

  await runner.run();
}

// ── default passphrase prompt ────────────────────────────────────────────────

/**
 * Default `promptPassphrase` implementation: a no-echo TTY prompt. Rejects with
 * a clear `Error` when `stdin` isn't a TTY (e.g. a worker dyno, a piped invocation,
 * a CI without a controlling terminal) — the caller wraps that in a `RunRefused`
 * telling the operator to set `OSPEX_KEYSTORE_PASSPHRASE`. Tests inject a fake
 * via `RunDeps.promptPassphrase`; this default is exercised manually.
 *
 * Handles `Enter` (resolve), `Ctrl-C` (reject `'prompt cancelled'`), `Backspace` /
 * `DEL` (erase one char), and discards other control bytes. Restores cooked mode
 * and pauses stdin in every exit path so the parent process can exit cleanly.
 */
function defaultPromptPassphrase(): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('cannot prompt for keystore passphrase: stdin is not a TTY'));
  }
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(buf);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          stdout.write('\n');
          reject(new Error('keystore passphrase prompt cancelled'));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        if (code < 0x20) continue; // ignore other control chars
        buf += ch;
      }
    };
    stdout.write('Keystore passphrase: ');
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
