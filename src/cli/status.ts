/**
 * `ospex-mm status [--address <0x…>] [--json]` — read-only snapshot of the MM's
 * persisted state plus an optional live position-status read (DESIGN §14).
 * Distinct from `doctor` (a readiness probe — one-line checks + a "Ready to"
 * matrix) and from `summary` (an NDJSON-log aggregator — telemetry-derived run
 * metrics): `status` reads the on-disk `maker-state.json` and reports
 * commitments by lifecycle, positions by local `MakerPositionStatus` (with
 * per-status USDC sums), today's `dailyCounters`, the PnL snapshot, the last
 * run id, and — if a maker address can be resolved without decrypting the
 * keystore — the SDK's `positions.status(maker)` totals (a cheap, signer-free
 * read).
 *
 * Strictly read-only. No keystore unlock; no signer. The maker address comes
 * from `--address` (read-only convenience, mirrors `doctor`) or — when the
 * configured keystore is an ethers-style v3 with a plaintext `address` field —
 * `readKeystoreAddress`. A Foundry keystore omits that field for privacy, so
 * the live position read is skipped (with a clear reason) unless `--address`
 * is passed. The skip is informational, not an error.
 *
 * State-loss posture: this command **reports** state-loss situations (fresh +
 * prior telemetry, or a corrupt state file), it does NOT refuse on them. The
 * whole point of `status` is to tell the operator what's going on — refusing
 * on the broken state would hide the diagnostic. The integrity field in the
 * report makes the loss explicit; `run --live` / `cancel-stale` are the
 * commands that fail-closed on the same conditions.
 *
 * Exit code: always `0`. Operational failures during the optional live read
 * are surfaced in `livePositionsSkipReason` (still exit 0). Genuine throws
 * (state can't be read at all for an IO reason other than `lost`, an injected
 * dep throws unexpectedly) propagate up and the CLI wrapper maps them to
 * `status failed: …` exit 1, same as the other read-only commands.
 */

import type { Config } from '../config/index.js';
import {
  createOspexAdapter,
  readKeystoreAddress as readKeystoreAddressImpl,
  type Hex,
  type OspexAdapter,
  type PositionStatus,
} from '../ospex/index.js';
import {
  type CommitmentLifecycle,
  type MakerPositionStatus,
  type MakerState,
  type PnlSnapshot,
  type StateLoadResult,
  StateStore,
} from '../state/index.js';

// ── report shape ─────────────────────────────────────────────────────────────

/** Counts per `CommitmentLifecycle` bucket plus the distinct-contests-on-non-terminal cardinality (a proxy for "markets currently exposed"). */
export interface CommitmentSummary {
  total: number;
  byLifecycle: Record<CommitmentLifecycle, number>;
  /** Distinct `contestId`s across `visibleOpen` / `softCancelled` / `partiallyFilled` records — markets where the maker currently has matchable exposure. */
  distinctContestsNonTerminal: number;
}

/** Per-`MakerPositionStatus` count and own-risk USDC sum (wei6 decimal string). */
export interface PositionStatusBucket {
  count: number;
  /** Sum of `MakerPositionRecord.riskAmountWei6` across this bucket — own staked USDC (wei6 decimal string). */
  ownRiskWei6: string;
}

export interface PositionsSummary {
  total: number;
  byStatus: Record<MakerPositionStatus, PositionStatusBucket>;
}

export interface DailyCountersSnapshot {
  /** UTC date the snapshot was taken on (`YYYY-MM-DD`). */
  today: string;
  /** Today's gas spend in POL wei18 (decimal string). `"0"` if no counter for today. */
  todayGasPolWei: string;
  /** Today's protocol fees in USDC wei6 (decimal string). `"0"` in v0 (no lazy speculation creation). */
  todayFeeUsdcWei6: string;
  /** Lifetime gas spend across every dailyCounter entry (POL wei18 decimal string) — for "how much have I burned cumulatively". */
  lifetimeGasPolWei: string;
  /** Lifetime protocol fees (USDC wei6 decimal string). */
  lifetimeFeeUsdcWei6: string;
}

/** A summary of the live `getPositionStatus(maker)` totals — counts and payout sums (wei6). Mirrors `PositionStatusTotals` from the SDK. */
export interface LivePositionTotals {
  activeCount: number;
  pendingSettleCount: number;
  claimableCount: number;
  /** Sum of `claimable` payouts (USDC wei6 decimal string) — ready to sweep right now. */
  claimablePayoutWei6: string;
  /** Sum of `pendingSettle` predicted payouts (USDC wei6 decimal string) — require `settleSpeculation` first. */
  pendingSettlePayoutWei6: string;
}

export interface StatusReport {
  schemaVersion: 1;
  configPath: string;
  /** Absolute(-ish) path of the state file (informational). */
  statePath: string;
  /** State-file integrity — `'loaded'` (file present + valid), `'fresh'` (no file), or `'lost'` (file present but unreadable / corrupt). Same vocabulary the runner's fail-safe uses. */
  stateIntegrity: 'loaded' | 'fresh' | 'lost';
  /** Present when `stateIntegrity === 'lost'` — the load-time reason. */
  stateLostReason: string | null;
  /** When the state was last flushed (ISO-8601), or `null` for a never-flushed state. */
  lastFlushedAt: string | null;
  /** The `runId` of the run that last wrote this state — `null` for a fresh state. */
  lastRunId: string | null;
  commitments: CommitmentSummary;
  positions: PositionsSummary;
  dailyCounters: DailyCountersSnapshot;
  pnl: PnlSnapshot;
  /** Resolved maker address (from `--address` or a v3-keystore plaintext field). `null` when neither yielded one; the live position read is then skipped. */
  makerAddress: Hex | null;
  /** Where the resolved address came from. */
  makerAddressSource: 'flag' | 'keystore' | 'unknown';
  /** Live `getPositionStatus(maker)` totals — present only when a maker address resolved AND the call succeeded. */
  livePositionTotals: LivePositionTotals | null;
  /** Human-readable reason the live position read didn't produce totals (no address resolved, the call threw, …). `null` when `livePositionTotals` is set. */
  livePositionsSkipReason: string | null;
}

// ── opts + deps ──────────────────────────────────────────────────────────────

export interface StatusOpts {
  config: Config;
  /** Path of the loaded config (informational — appears in the report). */
  configPath: string;
  /** The read-only chain/API adapter. Reuse `createOspexAdapter(config)` from the CLI wrapper. */
  adapter: OspexAdapter;
  /** `--address` — read-only override for the maker wallet. Used to resolve the live position read without prompting for a passphrase. */
  address?: Hex;
}

/** Injectable seams — tests / alternate environments. */
export interface StatusDeps {
  /** Open the state store for `state.dir`. Default: `StateStore.at`. */
  makeStateStore?: (dir: string) => StateStore;
  /** Read the keystore's plaintext `address` field without decryption (a v3 / ethers-style keystore convenience). Default: {@link readKeystoreAddressImpl}. */
  readKeystoreAddress?: (path: string) => Hex | null;
  /** Wall clock — unix seconds. Default: `Math.floor(Date.now() / 1000)`. Used to key today's `dailyCounters` entry. */
  now?: () => number;
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Build a {@link StatusReport}. Reads the state file (never throws on a `lost`
 * file — the report carries the integrity verdict). Resolves the maker address
 * from `--address` ▸ keystore plaintext ▸ unresolved. When resolved, calls the
 * adapter's signer-free `getPositionStatus(maker)` — on success the totals
 * land in the report; on failure the reason lands in `livePositionsSkipReason`
 * and we exit 0 anyway (this is a report, not a check).
 */
export async function runStatus(opts: StatusOpts, deps: StatusDeps = {}): Promise<StatusReport> {
  const makeStateStore = deps.makeStateStore ?? ((dir: string): StateStore => StateStore.at(dir));
  const readKeystoreAddress = deps.readKeystoreAddress ?? readKeystoreAddressImpl;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  const stateStore = makeStateStore(opts.config.state.dir);
  const loadResult: StateLoadResult = stateStore.load();
  const state = loadResult.state;

  // Resolve the maker address read-only. `--address` wins; else try the
  // keystore's plaintext `address` field (Foundry-style keystores omit it,
  // so this returns null there — `status` then skips the live read).
  let makerAddress: Hex | null = null;
  let makerAddressSource: StatusReport['makerAddressSource'] = 'unknown';
  if (opts.address !== undefined) {
    makerAddress = opts.address;
    makerAddressSource = 'flag';
  } else if (opts.config.wallet.keystorePath !== undefined) {
    const ks = readKeystoreAddress(opts.config.wallet.keystorePath);
    if (ks !== null) {
      makerAddress = ks;
      makerAddressSource = 'keystore';
    }
  }

  // ── state-derived sections ───────────────────────────────────────────────
  const commitments = summarizeCommitments(state);
  const positions = summarizePositions(state);
  const dailyCounters = summarizeDailyCounters(state, now());
  const pnl: PnlSnapshot = state.pnl;

  // ── optional live position-status read ───────────────────────────────────
  let livePositionTotals: LivePositionTotals | null = null;
  let livePositionsSkipReason: string | null = null;
  if (makerAddress === null) {
    livePositionsSkipReason = 'no maker address — pass --address, or use a v3 keystore with a plaintext `address` field (Foundry keystores omit it for privacy)';
  } else {
    try {
      const ps: PositionStatus = await opts.adapter.getPositionStatus(makerAddress);
      livePositionTotals = {
        activeCount: ps.totals.activeCount,
        pendingSettleCount: ps.totals.pendingSettleCount,
        claimableCount: ps.totals.claimableCount,
        claimablePayoutWei6: ps.totals.estimatedPayoutWei6,
        pendingSettlePayoutWei6: ps.totals.pendingSettlePayoutWei6,
      };
    } catch (err) {
      livePositionsSkipReason = `getPositionStatus failed: ${(err as Error).message}`;
    }
  }

  return {
    schemaVersion: 1,
    configPath: opts.configPath,
    statePath: stateStore.statePath,
    stateIntegrity: loadResult.status.kind,
    stateLostReason: loadResult.status.kind === 'lost' ? loadResult.status.reason : null,
    lastFlushedAt: state.lastFlushedAt,
    lastRunId: state.lastRunId,
    commitments,
    positions,
    dailyCounters,
    pnl,
    makerAddress,
    makerAddressSource,
    livePositionTotals,
    livePositionsSkipReason,
  };
}

/** A successful `status` run always exits `0` — a snapshot is a report, not a check. Operational failures (state IO that isn't `lost`) propagate and the CLI maps them to exit 1. */
export function statusExitCode(_report: StatusReport): number {
  return 0;
}

// ── state summarizers (pure, exported for tests) ─────────────────────────────

const COMMITMENT_LIFECYCLES: readonly CommitmentLifecycle[] = [
  'visibleOpen', 'softCancelled', 'partiallyFilled', 'filled', 'expired', 'authoritativelyInvalidated',
];

const POSITION_STATUSES: readonly MakerPositionStatus[] = [
  'active', 'pendingSettle', 'claimable', 'claimed',
];

const NON_TERMINAL_LIFECYCLES: ReadonlySet<CommitmentLifecycle> = new Set(['visibleOpen', 'softCancelled', 'partiallyFilled']);

function summarizeCommitments(state: MakerState): CommitmentSummary {
  const byLifecycle: Record<CommitmentLifecycle, number> = {
    visibleOpen: 0, softCancelled: 0, partiallyFilled: 0, filled: 0, expired: 0, authoritativelyInvalidated: 0,
  };
  const contestsNonTerminal = new Set<string>();
  for (const r of Object.values(state.commitments)) {
    byLifecycle[r.lifecycle] = (byLifecycle[r.lifecycle] ?? 0) + 1;
    if (NON_TERMINAL_LIFECYCLES.has(r.lifecycle)) contestsNonTerminal.add(r.contestId);
  }
  return {
    total: Object.keys(state.commitments).length,
    byLifecycle,
    distinctContestsNonTerminal: contestsNonTerminal.size,
  };
}

function summarizePositions(state: MakerState): PositionsSummary {
  const byStatus: Record<MakerPositionStatus, PositionStatusBucket> = {
    active: { count: 0, ownRiskWei6: '0' },
    pendingSettle: { count: 0, ownRiskWei6: '0' },
    claimable: { count: 0, ownRiskWei6: '0' },
    claimed: { count: 0, ownRiskWei6: '0' },
  };
  const sums: Record<MakerPositionStatus, bigint> = { active: 0n, pendingSettle: 0n, claimable: 0n, claimed: 0n };
  for (const p of Object.values(state.positions)) {
    byStatus[p.status].count += 1;
    sums[p.status] += BigInt(p.riskAmountWei6);
  }
  for (const s of POSITION_STATUSES) byStatus[s].ownRiskWei6 = sums[s].toString();
  return {
    total: Object.keys(state.positions).length,
    byStatus,
  };
}

function summarizeDailyCounters(state: MakerState, nowUnixSec: number): DailyCountersSnapshot {
  const today = todayUTCDateString(nowUnixSec);
  const todays = state.dailyCounters[today];
  let lifetimeGas = 0n;
  let lifetimeFee = 0n;
  for (const counter of Object.values(state.dailyCounters)) {
    lifetimeGas += BigInt(counter.gasPolWei);
    lifetimeFee += BigInt(counter.feeUsdcWei6);
  }
  return {
    today,
    todayGasPolWei: todays?.gasPolWei ?? '0',
    todayFeeUsdcWei6: todays?.feeUsdcWei6 ?? '0',
    lifetimeGasPolWei: lifetimeGas.toString(),
    lifetimeFeeUsdcWei6: lifetimeFee.toString(),
  };
}

/** The UTC date `YYYY-MM-DD` for `unixSec` — local copy of the runner's helper to keep this module dependency-free of `src/runners/`. */
function todayUTCDateString(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── renderers ────────────────────────────────────────────────────────────────

/** Write the JSON envelope `{ schemaVersion: 1, status: StatusReport }` to `out` — stable agent contract. */
export function renderStatusReportJson(report: StatusReport, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, status: report })}\n`);
}

/** Write the human-readable report to `out`. Not a stable contract — use `--json` for parsing. */
export function renderStatusReportText(report: StatusReport, out: { write(s: string): void }): void {
  out.write(`ospex-mm status\n\n`);
  out.write(`config:           ${report.configPath}\n`);
  out.write(`state file:       ${report.statePath} (${report.stateIntegrity}${report.stateLostReason ? ` — ${report.stateLostReason}` : ''})\n`);
  out.write(`last flushed:     ${report.lastFlushedAt ?? '(never)'}\n`);
  out.write(`last run id:      ${report.lastRunId ?? '(none)'}\n`);
  out.write(`wallet:           ${report.makerAddress ?? '(unresolved)'}${report.makerAddress !== null ? ` (${report.makerAddressSource})` : ''}\n\n`);

  out.write(`Commitments:      ${report.commitments.total} tracked (${report.commitments.distinctContestsNonTerminal} distinct contest(s) with non-terminal exposure)\n`);
  for (const lc of COMMITMENT_LIFECYCLES) {
    const n = report.commitments.byLifecycle[lc];
    if (n > 0) out.write(`  ${lc.padEnd(28)} ${n}\n`);
  }

  out.write(`\nPositions:        ${report.positions.total} tracked\n`);
  for (const s of POSITION_STATUSES) {
    const b = report.positions.byStatus[s];
    if (b.count > 0) out.write(`  ${s.padEnd(15)} ${b.count}  own-risk ${formatUsdcWei6(b.ownRiskWei6)} USDC\n`);
  }

  out.write(`\nToday (${report.dailyCounters.today}):\n`);
  out.write(`  gas spent          ${formatPolWei18(report.dailyCounters.todayGasPolWei)} POL\n`);
  out.write(`  fees paid          ${formatUsdcWei6(report.dailyCounters.todayFeeUsdcWei6)} USDC\n`);
  out.write(`Lifetime:\n`);
  out.write(`  gas spent          ${formatPolWei18(report.dailyCounters.lifetimeGasPolWei)} POL\n`);
  out.write(`  fees paid          ${formatUsdcWei6(report.dailyCounters.lifetimeFeeUsdcWei6)} USDC\n`);

  out.write(`\nPnL (${report.pnl.asOfUnixSec === 0 ? 'never computed' : `as of unix ${report.pnl.asOfUnixSec}`}):\n`);
  out.write(`  realized           ${formatSignedUsdcWei6(report.pnl.realizedUsdcWei6)} USDC\n`);
  out.write(`  unrealized         ${formatSignedUsdcWei6(report.pnl.unrealizedUsdcWei6)} USDC\n`);

  out.write(`\nLive position status (from API):\n`);
  if (report.livePositionTotals === null) {
    out.write(`  skipped — ${report.livePositionsSkipReason}\n`);
  } else {
    const t = report.livePositionTotals;
    out.write(`  active             ${t.activeCount}\n`);
    out.write(`  pendingSettle      ${t.pendingSettleCount}  predicted payout ${formatUsdcWei6(t.pendingSettlePayoutWei6)} USDC\n`);
    out.write(`  claimable          ${t.claimableCount}  payout ${formatUsdcWei6(t.claimablePayoutWei6)} USDC\n`);
  }
}

// ── tiny formatters ─────────────────────────────────────────────────────────

/** USDC wei6 decimal string → `D.dddddd` display. */
function formatUsdcWei6(wei6: string): string {
  const n = BigInt(wei6);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${frac}`;
}

/** Signed USDC wei6 decimal string (`-…` for losses) → `±D.dddddd` display. */
function formatSignedUsdcWei6(wei6: string): string {
  if (wei6.startsWith('-')) return `-${formatUsdcWei6(wei6.slice(1))}`;
  return formatUsdcWei6(wei6);
}

/** POL wei18 decimal string → `D.dddddd...` display (6 fractional digits — POL gas costs round to ~1e-6 POL of precision in practice). */
function formatPolWei18(wei18: string): string {
  const n = BigInt(wei18);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole.toString()}.${frac}`;
}

// ── factory (handy for the CLI wrapper) ──────────────────────────────────────

/** Build an adapter shaped for `status` — a read-only `OspexAdapter` (no signer). Mirrors `runDoctor` / `runQuote`'s factory call site. */
export function defaultStatusAdapter(config: Config): OspexAdapter {
  return createOspexAdapter(config);
}
