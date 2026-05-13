/**
 * `ospex-mm cancel-stale [--authoritative]` — one-shot operator command that pulls
 * every tracked commitment whose age has crossed `orders.staleAfterSeconds`. Two
 * flavours, distinguished by `--authoritative`:
 *
 *   - default — gasless off-chain cancels only (`adapter.cancelCommitmentOffchain`).
 *     Removes the quotes from the API book so takers stop seeing them, but anyone
 *     holding a still-signed payload can match them on chain until natural expiry.
 *     Records move `visibleOpen` → `softCancelled` (latent exposure stays counted
 *     in the risk engine until the record expires or is on-chain-cancelled).
 *
 *   - `--authoritative` — same off-chain step (or a skip for already-softCancelled
 *     records), then an on-chain `cancelCommitmentOnchain` per non-terminal record.
 *     `MatchingModule.cancelCommitment` flips `s_cancelledCommitments[hash]`, after
 *     which a `matchCommitment` call against that hash reverts. Records move to
 *     `authoritativelyInvalidated` (headroom released). Each on-chain cancel is
 *     gas-gated by the same `canSpendGas` verdict the runner uses, with
 *     `mayUseReserve: true` — `--authoritative` is operator-explicit "burn the
 *     reserve to make sure latent exposure is killed", just like the shutdown's
 *     on-chain kill path. A denied verdict emits `candidate`
 *     `gas-budget-blocks-onchain-cancel` and BREAKS the loop (today's spend only
 *     grows — subsequent records would deny the same way). The operator can top
 *     up POL and re-run.
 *
 * The command refuses if `config.mode.dryRun: true` — the same two-key principle
 * as `run --live`: the operator must have explicitly switched the config to the
 * live posture before invoking real writes (gasless or not). The keystore unlock
 * mirrors `run --live`: passphrase from `OSPEX_KEYSTORE_PASSPHRASE` (preferred for
 * non-interactive use) else a no-echo TTY prompt; `--address` is rejected (the
 * maker address is the signer's). State is loaded from `state.dir` — a missing
 * state file is treated as "nothing tracked" (exit 0); a corrupt state file
 * refuses (the operator should diagnose first rather than have us write blind).
 *
 * Single-writer caveat: the JSON state file isn't multi-process safe (DESIGN §12).
 * **Stop a running `ospex-mm run --live` first** — running both concurrently
 * against the same `state.dir` races on the flush. The command help and
 * `OPERATOR_SAFETY.md` say so explicitly.
 *
 * Emits its events to a fresh `run-<runId>.ndjson` log under `telemetry.logDir`,
 * so `ospex-mm summary` aggregates them alongside the runner's logs. Returns a
 * typed `CancelStaleReport` (counts of inspected / off-chain-cancelled /
 * on-chain-cancelled / gas-denied / errored records) so the CLI can render it
 * (`--json` envelope or human text), and so tests can assert on the outcome.
 */

import type { Config } from '../config/index.js';
import {
  createLiveOspexAdapter,
  unlockKeystoreSigner,
  type Hex,
  type OspexAdapter,
  type Signer,
} from '../ospex/index.js';
import { canSpendGas } from '../risk/index.js';
import { polFloatToWei18, softCancelEventPayload, todayUTCDateString } from '../runners/index.js';
import { StateStore, type MakerState } from '../state/index.js';
import { EventLog, newRunId } from '../telemetry/index.js';

// ── opts + deps ──────────────────────────────────────────────────────────────

export interface CancelStaleOpts {
  config: Config;
  /** `--authoritative` — also issue on-chain `cancelCommitment` per record (costs POL gas, gas-gated with `mayUseReserve: true`). Default `false` — off-chain DELETE only (gasless). */
  authoritative: boolean;
}

/** Injectable seams so `runCancelStale` can be exercised without a TTY / live RPC / real scrypt / real filesystem outside the temp dirs. Same shape as `RunDeps`. */
export interface CancelStaleDeps {
  /** Build the signed adapter. Default: {@link createLiveOspexAdapter}. */
  createLiveAdapter?: (config: Config, signer: Signer) => OspexAdapter;
  /** Decrypt the keystore. Default: {@link unlockKeystoreSigner}. */
  unlockSigner?: (keystorePath: string, passphrase: string) => Promise<Signer>;
  /** Prompt the operator for the keystore passphrase (no-echo TTY). Default: shared with `run --live` — re-implemented here to avoid an import cycle. */
  promptPassphrase?: () => Promise<string>;
  /** Environment lookup for `OSPEX_KEYSTORE_PASSPHRASE`. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Mint this command's run id. Default: {@link newRunId}. */
  makeRunId?: () => string;
  /** Open the state store for `state.dir`. Default: `StateStore.at`. */
  makeStateStore?: (dir: string) => StateStore;
  /** Wall clock — unix seconds. Default: `Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /** Human-readable diagnostics. Default: a line to `process.stderr`. */
  log?: (line: string) => void;
}

/**
 * Thrown by `runCancelStale` when the command is refused before any work starts
 * — a missing two-key match, a missing precondition (no keystore path, no
 * passphrase), or a corrupt state file. Distinct from a plain `Error` (which is
 * "cancel-stale failed: …"); the CLI catches `CancelStaleRefused` and prints the
 * message verbatim, then exits `1`.
 */
export class CancelStaleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelStaleRefused';
  }
}

// ── report shape ─────────────────────────────────────────────────────────────

/** What `runCancelStale` did. The CLI renders this; tests assert on it. Counts and lifecycle decisions are deterministic from the loaded state + the configured staleness threshold + the (mockable) clock. */
export interface CancelStaleReport {
  /** Total records that matched the stale filter. */
  inspected: number;
  /** Records that successfully had their off-chain DELETE land. */
  offchainCancelled: number;
  /** Records skipped off-chain because they were already `softCancelled`. */
  offchainSkippedAlready: number;
  /** Records that successfully had their on-chain `cancelCommitment` land. Always `0` when `--authoritative` was not passed. */
  onchainCancelled: number;
  /** Records the gas-budget verdict refused (only meaningful with `--authoritative`). */
  gasDenied: number;
  /** Records whose off-chain or on-chain cancel threw. */
  errored: number;
  /** Total POL gas spent on the command's on-chain cancels (wei18, decimal string). `"0"` without `--authoritative` or when nothing landed on chain. */
  gasPolWei: string;
  /** This command's run id (filename part of the event log under `telemetry.logDir`). */
  runId: string;
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Run the cancel-stale command. Resolves with the {@link CancelStaleReport};
 * throws `CancelStaleRefused` for a preconditions failure (config not in live
 * posture, no keystore, no passphrase, corrupt state, `--address` not allowed
 * (none is taken)), or a plain `Error` for an operational failure (a bad
 * passphrase, the telemetry directory can't be created, the state can't be
 * flushed).
 *
 * Never throws on a per-record cancel failure — counted in `errored` and the
 * loop continues (an `error` event lands in the log with `phase: 'cancel'` /
 * `'onchain-cancel'`).
 */
export async function runCancelStale(opts: CancelStaleOpts, deps: CancelStaleDeps = {}): Promise<CancelStaleReport> {
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  // Two-key gate (the same principle as `run --live`'s DESIGN §8): a real
  // cancel-stale invocation writes to chain (off-chain DELETE is signed too).
  // Refuse unless the config has explicitly opted into the live posture — a
  // stray invocation against a `dryRun: true` config shouldn't be enough.
  if (opts.config.mode.dryRun) {
    throw new CancelStaleRefused(
      'refusing to cancel-stale: config has mode.dryRun=true. cancel-stale always writes (off-chain DELETE is a signed action; --authoritative also writes on chain) — set mode.dryRun=false in your config to opt in to the live posture first.',
    );
  }
  if (opts.config.wallet.keystorePath === undefined) {
    throw new CancelStaleRefused(
      'cancel-stale requires wallet.keystorePath in the config (or the OSPEX_KEYSTORE_PATH env, or --keystore on the command line). Set it before running.',
    );
  }

  // Unlock the signer (passphrase from env, else a TTY prompt) — same code
  // path as `run --live` (duplicated rather than imported to avoid a cycle
  // through `run.ts`; both call into the same `unlockKeystoreSigner`).
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
      throw new CancelStaleRefused(
        `cancel-stale needs the keystore passphrase: ${(err as Error).message}. Set OSPEX_KEYSTORE_PASSPHRASE in the environment to unlock non-interactively.`,
      );
    }
  }
  const unlockSigner = deps.unlockSigner ?? unlockKeystoreSigner;
  const signer = await unlockSigner(opts.config.wallet.keystorePath, passphrase); // bad passphrase / malformed keystore → plain Error (CLI surfaces "cancel-stale failed: …")
  const makerAddress = await signer.getAddress();
  log(`[cancel-stale] maker wallet: ${makerAddress}`);

  // Load state. A `fresh` state (no file) means "nothing tracked, nothing to do"
  // — exit successfully. A `lost` state (corrupt) refuses — operating on an
  // unknown set of soft-cancelled records would be writing blind; the operator
  // should diagnose first.
  const stateStore = (deps.makeStateStore ?? ((dir: string): StateStore => StateStore.at(dir)))(opts.config.state.dir);
  const loadResult = stateStore.load();
  if (loadResult.status.kind === 'lost') {
    throw new CancelStaleRefused(
      `cancel-stale refuses to run with a corrupt state file (${loadResult.status.reason}). Fix the state at ${stateStore.statePath} before invoking — operating without an accurate softCancelled set would be writing blind.`,
    );
  }
  const state = loadResult.state;

  const adapter = (deps.createLiveAdapter ?? createLiveOspexAdapter)(opts.config, signer);
  const runId = (deps.makeRunId ?? newRunId)();
  const eventLog = EventLog.open(opts.config.telemetry.logDir, runId);

  // Identify stale records: tracked commitments whose age (wall-clock since
  // posted) has crossed `orders.staleAfterSeconds`. Includes both `visibleOpen`
  // (still in the API book) and `softCancelled` (already pulled off chain but
  // still matchable until expiry) — the on-chain leg is what makes
  // `--authoritative` distinct, so `softCancelled` records belong in the set
  // for that leg too. `partiallyFilled` records are excluded — a partial fill
  // means a taker has already matched some of the risk; pulling the remainder
  // is a runner concern (the reconcile leaves them alone), not an
  // operator-driven cleanup.
  const wallNow = now();
  const staleAfter = opts.config.orders.staleAfterSeconds;
  const stale = Object.values(state.commitments).filter(
    (r) =>
      (r.lifecycle === 'visibleOpen' || r.lifecycle === 'softCancelled') &&
      r.postedAtUnixSec + staleAfter <= wallNow,
  );

  const report: CancelStaleReport = {
    inspected: stale.length,
    offchainCancelled: 0,
    offchainSkippedAlready: 0,
    onchainCancelled: 0,
    gasDenied: 0,
    errored: 0,
    gasPolWei: '0',
    runId,
  };
  if (stale.length === 0) {
    log(`[cancel-stale] nothing to do — no tracked commitments older than orders.staleAfterSeconds (${staleAfter}s).`);
    stateStore.flush(state); // best-effort no-op flush; refreshes lastFlushedAt
    return report;
  }
  log(`[cancel-stale] ${stale.length} stale commitment(s) — running off-chain cancels${opts.authoritative ? ' + on-chain authoritative cancels' : ''}.`);

  // ── off-chain leg (always) ───────────────────────────────────────────────
  // Already-softCancelled records skip the off-chain step (they're already
  // gone from the API book) but stay in the set for the on-chain leg. A
  // failed off-chain DELETE for a `visibleOpen` record is logged but does NOT
  // exclude that record from the on-chain leg — the off-chain failure could
  // be a transient API blip; the on-chain cancel is the authoritative path
  // (`MatchingModule.cancelCommitment` operates on chain regardless of book
  // visibility), which is exactly the reason for `--authoritative`.
  for (const r of stale) {
    if (r.lifecycle === 'softCancelled') {
      report.offchainSkippedAlready += 1;
      continue;
    }
    try {
      await adapter.cancelCommitmentOffchain(r.hash as Hex);
    } catch (err) {
      report.errored += 1;
      eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'cancel', commitmentHash: r.hash });
      continue;
    }
    r.lifecycle = 'softCancelled';
    r.updatedAtUnixSec = wallNow;
    report.offchainCancelled += 1;
    eventLog.emit('soft-cancel', softCancelEventPayload(r, 'stale'));
  }

  // ── on-chain leg (only with --authoritative) ────────────────────────────
  // Iterates every stale record (regardless of off-chain outcome). Gas-gated
  // with `mayUseReserve: true` — `--authoritative` is operator-explicit, like
  // the shutdown's on-chain kill path. Verdict denial emits `candidate`
  // `gas-budget-blocks-onchain-cancel` and BREAKS the loop (today's spend only
  // grows). Adapter throws emit `error` `phase: 'onchain-cancel'` and CONTINUE
  // (different failure modes — gas is monotonic, reverts are per-hash).
  // Successful cancels stamp the record `authoritativelyInvalidated` (headroom
  // released).
  if (opts.authoritative) {
    let totalGasPolWei = 0n;
    const maxDailyGasPolWei = polFloatToWei18(opts.config.gas.maxDailyGasPOL);
    const emergencyReservePolWei = polFloatToWei18(opts.config.gas.emergencyReservePOL);

    for (const r of stale) {
      // Skip already-authoritatively-cancelled records (paranoia — only
      // possible via state edits while we run; the stale filter above only
      // admits `visibleOpen` / `softCancelled`).
      if (r.lifecycle === 'authoritativelyInvalidated') continue;
      const today = todayUTCDateString(wallNow);
      const todayGasSpentPolWei = BigInt(state.dailyCounters[today]?.gasPolWei ?? '0');
      const verdict = canSpendGas({ todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve: true });
      if (!verdict.allowed) {
        report.gasDenied += 1;
        eventLog.emit('candidate', {
          skipReason: 'gas-budget-blocks-onchain-cancel',
          commitmentHash: r.hash,
          speculationId: r.speculationId,
          makerSide: r.makerSide,
          todayGasSpentPolWei: todayGasSpentPolWei.toString(),
          maxDailyGasPolWei: maxDailyGasPolWei.toString(),
          emergencyReservePolWei: emergencyReservePolWei.toString(),
          detail: verdict.reason,
        });
        break; // subsequent records would deny the same way; the operator must top up POL and re-run
      }

      let result: Awaited<ReturnType<OspexAdapter['cancelCommitmentOnchain']>>;
      try {
        result = await adapter.cancelCommitmentOnchain(r.hash as Hex);
      } catch (err) {
        report.errored += 1;
        eventLog.emit('error', { class: errClass(err), detail: errMessage(err), phase: 'onchain-cancel', commitmentHash: r.hash });
        continue;
      }
      const gasPolWei = BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice);
      recordGasSpentToday(state, today, gasPolWei);
      totalGasPolWei += gasPolWei;
      r.lifecycle = 'authoritativelyInvalidated';
      r.updatedAtUnixSec = wallNow;
      report.onchainCancelled += 1;
      eventLog.emit('onchain-cancel', {
        commitmentHash: r.hash,
        speculationId: r.speculationId,
        contestId: r.contestId,
        makerSide: r.makerSide,
        txHash: result.txHash,
        gasPolWei: gasPolWei.toString(),
      });
    }
    report.gasPolWei = totalGasPolWei.toString();
  }

  // Persist the lifecycle changes (always — even a fully-erroring run may have
  // landed some records, and `lastFlushedAt` always advances).
  stateStore.flush(state);
  return report;
}

// ── renderers ────────────────────────────────────────────────────────────────

/** A successful cancel-stale run always exits `0`; per-record failures are surfaced in the report (`errored`), not the exit code. Operational failures throw and the CLI maps those to `1`. */
export function cancelStaleExitCode(_report: CancelStaleReport): number {
  return 0;
}

/** Write the JSON envelope `{ schemaVersion: 1, cancelStale: CancelStaleReport }` to `out`. */
export function renderCancelStaleReportJson(report: CancelStaleReport, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, cancelStale: report })}\n`);
}

/** Write the human-readable cancel-stale report to `out`. Not a stable contract — use `--json` for parsing. */
export function renderCancelStaleReportText(report: CancelStaleReport, out: { write(s: string): void }): void {
  out.write(`ospex-mm cancel-stale (run ${report.runId})\n\n`);
  out.write(`inspected:                  ${report.inspected}\n`);
  out.write(`off-chain cancelled:        ${report.offchainCancelled}\n`);
  out.write(`off-chain skipped (already softCancelled): ${report.offchainSkippedAlready}\n`);
  out.write(`on-chain cancelled:         ${report.onchainCancelled}\n`);
  out.write(`gas-budget denied:          ${report.gasDenied}\n`);
  out.write(`errored:                    ${report.errored}\n`);
  out.write(`gas spent (POL wei18):      ${report.gasPolWei}\n`);
}

// ── helpers (duplicated from runners/ to keep this module free of runner imports) ──

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Add `gasPolWei` to today's `state.dailyCounters` counter (additive; preserves `feeUsdcWei6`; lazy-creates the entry). Mirrors `Runner.recordGasSpentToday`. */
function recordGasSpentToday(state: MakerState, today: string, gasPolWei: bigint): void {
  const existing = state.dailyCounters[today];
  const prior = existing !== undefined ? BigInt(existing.gasPolWei) : 0n;
  state.dailyCounters[today] = {
    gasPolWei: (prior + gasPolWei).toString(),
    feeUsdcWei6: existing !== undefined ? existing.feeUsdcWei6 : '0',
  };
}

/** Default `promptPassphrase` for non-injected callers — same no-echo TTY pattern as `run --live`. Duplicated rather than imported from `./run.js` to avoid an import cycle. */
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
          cleanup();
          stdout.write('\n');
          reject(new Error('keystore passphrase prompt cancelled'));
          return;
        }
        if (code === 127 || code === 8) {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        if (code < 0x20) continue;
        buf += ch;
      }
    };
    stdout.write('Keystore passphrase: ');
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

