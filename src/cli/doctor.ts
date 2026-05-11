/**
 * `ospex-mm doctor` — readiness probe (DESIGN §14). Mirrors `ospex doctor`'s
 * shape: a list of check results plus a "Ready to" matrix telling the operator
 * what they're set up for right now.
 *
 * Read-only. Address-aware (passes `{ owner }` to `adapter.readBalances` /
 * `readApprovals` so no signer is touched — the call stays read-only and never
 * triggers a Foundry-keystore passphrase prompt). When neither `--address` nor an
 * ethers-style keystore yields an address, the chain-side checks gracefully
 * `SKIP` and the doctor still reports the things it could verify.
 *
 * Exits `0` unless a check FAILed (something is broken — API unreachable, RPC
 * errored, keystore path set but file missing, …). A WARN — no keystore yet, low
 * POL, allowance below the cap ceiling, a `lost` state file — does NOT fail the
 * exit; it's advisory. The "Ready to" matrix (`dryRunShadow` / `postCommitments`)
 * is informational and does not gate the exit code.
 */

import { existsSync } from 'node:fs';

import type { Config } from '../config/index.js';
import {
  type ApprovalsSnapshot,
  type BalancesSnapshot,
  type Hex,
  type OspexAdapter,
  readKeystoreAddress as readKeystoreAddressImpl,
} from '../ospex/index.js';
import { requiredPositionModuleAllowanceUSDC, type RiskCaps } from '../risk/index.js';
import {
  assessStateLoss,
  StateStore,
  type StateLoadResult,
  type StateLossAssessment,
} from '../state/index.js';
import { eventLogsExist as eventLogsExistImpl } from '../telemetry/index.js';

// ── report shape ─────────────────────────────────────────────────────────────

export const DOCTOR_CHECK_NAMES = [
  'config',
  'keystore',
  'wallet',
  'api',
  'rpc',
  'pol-balance',
  'usdc-balance',
  'allowance',
  'state',
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

/** A single check's outcome. `skipped` means we couldn't run it (no input), NOT that it failed. */
export type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  /** One-line human description, also embedded in the JSON envelope for agents. */
  detail: string;
}

export interface DoctorReadiness {
  ok: boolean;
  /** Always present; explains an `ok: false` and frames an `ok: true` (e.g. "no FAILs"). */
  reason: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  configPath: string;
  chainId: number;
  apiUrl: string;
  /** `null` when neither `--address` nor an ethers-style keystore yielded one. */
  walletAddress: Hex | null;
  walletAddressSource: 'flag' | 'keystore' | 'unknown';
  /** The configured `mode.dryRun` — relevant for `postCommitments.ok`. */
  configDryRun: boolean;
  checks: DoctorCheck[];
  ready: {
    /** Can the MM run `run --dry-run`? — what gates the exit code. */
    dryRunShadow: DoctorReadiness;
    /** Could the MM run `run --live`? — informational; not gating. */
    postCommitments: DoctorReadiness;
  };
}

// ── opts + deps ──────────────────────────────────────────────────────────────

export interface DoctorOpts {
  config: Config;
  /** Path of the loaded config (for display in the report). */
  configPath: string;
  adapter: OspexAdapter;
  /** Overrides keystore-derived address; keeps the chain reads fully signer-free. */
  address?: Hex;
}

/** Filesystem / disk-touching helpers — injected so tests can mock them. */
export interface DoctorDeps {
  readKeystoreAddress?: (path: string) => Hex | null;
  loadState?: (dir: string) => StateLoadResult;
  eventLogsExist?: (dir: string) => boolean;
  keystoreFileExists?: (path: string) => boolean;
}

interface ResolvedDeps {
  readKeystoreAddress: (path: string) => Hex | null;
  loadState: (dir: string) => StateLoadResult;
  eventLogsExist: (dir: string) => boolean;
  keystoreFileExists: (path: string) => boolean;
}

function resolveDeps(deps: DoctorDeps | undefined): ResolvedDeps {
  return {
    readKeystoreAddress: deps?.readKeystoreAddress ?? readKeystoreAddressImpl,
    loadState: deps?.loadState ?? ((dir) => StateStore.at(dir).load()),
    eventLogsExist: deps?.eventLogsExist ?? eventLogsExistImpl,
    keystoreFileExists: deps?.keystoreFileExists ?? existsSync,
  };
}

// ── the check ────────────────────────────────────────────────────────────────

export async function runDoctor(opts: DoctorOpts, deps?: DoctorDeps): Promise<DoctorReport> {
  const resolved = resolveDeps(deps);
  const { config, configPath, adapter } = opts;

  // 1. Wallet — `--address` first, then keystore's optional `address` field.
  const walletAddressResolution = resolveWallet(opts.address, config.wallet.keystorePath, resolved);

  // 2. Static checks — config + keystore (file system).
  const configCheck: DoctorCheck = {
    name: 'config',
    status: 'ok',
    detail: `loaded from ${configPath} (chainId=${config.chainId}, pricing.mode=${config.pricing.mode}, mode.dryRun=${config.mode.dryRun})`,
  };
  const keystoreCheck = checkKeystore(config.wallet.keystorePath, resolved);
  const walletCheck: DoctorCheck = {
    name: 'wallet',
    status: walletAddressResolution.address !== null ? 'ok' : 'skipped',
    detail:
      walletAddressResolution.address !== null
        ? `${walletAddressResolution.address} (from ${walletAddressResolution.source})`
        : 'address unknown — pass --address <0x…> or use an ethers-style keystore (Foundry omits the `address` field)',
  };

  // 3. API — fail-soft via `checkApiHealth`.
  const apiOk = await adapter.checkApiHealth();
  const apiCheck: DoctorCheck = {
    name: 'api',
    status: apiOk ? 'ok' : 'fail',
    detail: apiOk ? `reachable at ${adapter.apiUrl}` : `health check failed at ${adapter.apiUrl}`,
  };

  // 4. Chain-side reads — gated on having a wallet address.
  const chainReads = await fetchChainReads(adapter, walletAddressResolution.address);

  const rpcCheck = buildRpcCheck(chainReads, adapter.chainId);
  const polCheck = buildPolBalanceCheck(chainReads, config);
  const usdcCheck = buildUsdcBalanceCheck(chainReads, config);
  const allowanceCheck = buildAllowanceCheck(chainReads, config, adapter);

  // 5. State + the boot-time fail-safe.
  const stateCheck = buildStateCheck(config, resolved);

  const checks: DoctorCheck[] = [
    configCheck,
    keystoreCheck,
    walletCheck,
    apiCheck,
    rpcCheck,
    polCheck,
    usdcCheck,
    allowanceCheck,
    stateCheck,
  ];

  // 6. Readiness matrix.
  const ready = computeReadiness(checks, walletAddressResolution.address, config);

  return {
    schemaVersion: 1,
    configPath,
    chainId: config.chainId,
    apiUrl: adapter.apiUrl,
    walletAddress: walletAddressResolution.address,
    walletAddressSource: walletAddressResolution.source,
    configDryRun: config.mode.dryRun,
    checks,
    ready,
  };
}

/** Exit `0` unless a check FAILed (something is broken). WARNs are advisory and don't fail the exit. */
export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some((c) => c.status === 'fail') ? 1 : 0;
}

// ── pieces ───────────────────────────────────────────────────────────────────

function resolveWallet(
  flagAddress: Hex | undefined,
  keystorePath: string | undefined,
  deps: ResolvedDeps,
): { address: Hex | null; source: 'flag' | 'keystore' | 'unknown' } {
  if (flagAddress !== undefined) return { address: flagAddress, source: 'flag' };
  if (keystorePath !== undefined) {
    const fromKeystore = deps.readKeystoreAddress(keystorePath);
    if (fromKeystore !== null) return { address: fromKeystore, source: 'keystore' };
  }
  return { address: null, source: 'unknown' };
}

function checkKeystore(keystorePath: string | undefined, deps: ResolvedDeps): DoctorCheck {
  if (keystorePath === undefined) {
    return {
      name: 'keystore',
      status: 'warn',
      detail: 'no keystore configured — set wallet.keystorePath or OSPEX_KEYSTORE_PATH (required for `run` flows; harmless for `doctor` / `quote --dry-run`)',
    };
  }
  if (!deps.keystoreFileExists(keystorePath)) {
    return { name: 'keystore', status: 'fail', detail: `keystore file not found at ${keystorePath}` };
  }
  return { name: 'keystore', status: 'ok', detail: `at ${keystorePath}` };
}

interface ChainReads {
  balances: BalancesSnapshot | null;
  balancesError: string | null;
  approvals: ApprovalsSnapshot | null;
  approvalsError: string | null;
  skipped: boolean;
}

async function fetchChainReads(adapter: OspexAdapter, owner: Hex | null): Promise<ChainReads> {
  if (owner === null) {
    return { balances: null, balancesError: null, approvals: null, approvalsError: null, skipped: true };
  }
  // Issue in parallel — one failure shouldn't block the other.
  const [bRes, aRes] = await Promise.allSettled([adapter.readBalances(owner), adapter.readApprovals(owner)]);
  return {
    balances: bRes.status === 'fulfilled' ? bRes.value : null,
    balancesError: bRes.status === 'rejected' ? (bRes.reason as Error).message : null,
    approvals: aRes.status === 'fulfilled' ? aRes.value : null,
    approvalsError: aRes.status === 'rejected' ? (aRes.reason as Error).message : null,
    skipped: false,
  };
}

function buildRpcCheck(reads: ChainReads, chainId: number): DoctorCheck {
  if (reads.skipped) {
    return { name: 'rpc', status: 'skipped', detail: 'no wallet address — RPC is probed via a balance read; pass --address to enable' };
  }
  // The balance read drives the RPC probe; allowance also hits the chain but its error case is reported separately.
  if (reads.balances !== null) return { name: 'rpc', status: 'ok', detail: `reachable; configured for chain ${chainId}` };
  if (reads.balancesError !== null) return { name: 'rpc', status: 'fail', detail: `balance read failed (${reads.balancesError})` };
  // unreachable — `skipped: false` implies a settled balance promise
  return { name: 'rpc', status: 'fail', detail: 'balance read produced no result' };
}

function buildPolBalanceCheck(reads: ChainReads, config: Config): DoctorCheck {
  if (reads.skipped || reads.balances === null) {
    return { name: 'pol-balance', status: 'skipped', detail: 'no balances snapshot — pass --address or repair RPC' };
  }
  const polDisplay = formatUnits(reads.balances.native, 18, 6);
  const reservePol = config.gas.emergencyReservePOL;
  if (reads.balances.native === 0n) {
    return { name: 'pol-balance', status: 'fail', detail: `0 POL — the wallet can't send any transaction; fund it` };
  }
  // Compare against emergencyReservePOL (configured as a POL float).
  const reserveWei = BigInt(Math.floor(reservePol * 1e18));
  if (reads.balances.native < reserveWei) {
    return {
      name: 'pol-balance',
      status: 'warn',
      detail: `${polDisplay} POL — below the configured emergency reserve of ${reservePol} POL (gas.emergencyReservePOL); fund the wallet`,
    };
  }
  return { name: 'pol-balance', status: 'ok', detail: `${polDisplay} POL (above the ${reservePol} POL reserve)` };
}

function buildUsdcBalanceCheck(reads: ChainReads, config: Config): DoctorCheck {
  if (reads.skipped || reads.balances === null) {
    return { name: 'usdc-balance', status: 'skipped', detail: 'no balances snapshot — pass --address or repair RPC' };
  }
  const usdcDisplay = formatUnits(reads.balances.usdc, 6, 6);
  const requiredUsdc = requiredPositionModuleAllowanceUSDC(toRiskCaps(config));
  const requiredWei = BigInt(Math.floor(requiredUsdc * 1e6));
  if (reads.balances.usdc < requiredWei) {
    return {
      name: 'usdc-balance',
      status: 'warn',
      detail: `${usdcDisplay} USDC — below the configured cap ceiling of ${requiredUsdc.toFixed(6)} USDC; the effective bankroll caps at the wallet balance`,
    };
  }
  return { name: 'usdc-balance', status: 'ok', detail: `${usdcDisplay} USDC (≥ the ${requiredUsdc.toFixed(6)} USDC required)` };
}

function buildAllowanceCheck(reads: ChainReads, config: Config, adapter: OspexAdapter): DoctorCheck {
  if (reads.skipped) {
    return { name: 'allowance', status: 'skipped', detail: 'no wallet address — pass --address to read the allowance' };
  }
  if (reads.approvals === null) {
    return {
      name: 'allowance',
      status: reads.approvalsError !== null ? 'fail' : 'skipped',
      detail: reads.approvalsError !== null ? `allowance read failed (${reads.approvalsError})` : 'no approvals snapshot',
    };
  }
  const allowanceRaw = reads.approvals.usdc.allowances.positionModule.raw;
  const allowanceDisplay = formatUnits(allowanceRaw, 6, 6);
  const requiredUsdc = requiredPositionModuleAllowanceUSDC(toRiskCaps(config));
  const requiredWei = BigInt(Math.floor(requiredUsdc * 1e6));
  const positionModule = adapter.addresses().positionModule;
  if (allowanceRaw < requiredWei) {
    const hint = config.approvals.autoApprove
      ? 'the MM will set it on `run --live` (approvals.autoApprove: true).'
      : 'set it yourself (`ospex approvals setup` / `ospex commitments approve`), or flip approvals.autoApprove to true.';
    return {
      name: 'allowance',
      status: 'warn',
      detail: `${allowanceDisplay} USDC allowed to PositionModule (${positionModule}), need ≥ ${requiredUsdc.toFixed(6)} USDC — ${hint}`,
    };
  }
  return {
    name: 'allowance',
    status: 'ok',
    detail: `${allowanceDisplay} USDC allowed to PositionModule (${positionModule})`,
  };
}

function buildStateCheck(config: Config, deps: ResolvedDeps): DoctorCheck {
  const loadResult = deps.loadState(config.state.dir);
  const hasPriorTelemetry = deps.eventLogsExist(config.telemetry.logDir);
  const assessment: StateLossAssessment = assessStateLoss(loadResult.status, {
    hasPriorTelemetry,
    ignoreMissingStateOverride: false,
    expirySeconds: config.orders.expirySeconds,
  });

  if (loadResult.status.kind === 'fresh' && !hasPriorTelemetry) {
    return { name: 'state', status: 'ok', detail: `no prior state at ${config.state.dir} — fresh start` };
  }
  if (loadResult.status.kind === 'loaded') {
    const counts = `${Object.keys(loadResult.state.commitments).length} commitments / ${Object.keys(loadResult.state.positions).length} positions`;
    const flushed = loadResult.state.lastFlushedAt ?? 'unknown';
    return { name: 'state', status: 'ok', detail: `loaded; last flushed ${flushed}; ${counts}` };
  }
  // Either `lost`, or `fresh` with prior telemetry — the fail-safe holds quoting.
  return {
    name: 'state',
    status: 'warn',
    detail: `${assessment.reason}; the boot-time fail-safe will hold quoting until you replay telemetry, wait ${assessment.suggestedWaitSeconds ?? config.orders.expirySeconds}s, or pass --ignore-missing-state`,
  };
}

function computeReadiness(
  checks: readonly DoctorCheck[],
  walletAddress: Hex | null,
  config: Config,
): DoctorReport['ready'] {
  const fails = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const failureReason = (): string => `failed checks: ${fails.join(', ')}`;
  if (fails.length > 0) {
    return {
      dryRunShadow: { ok: false, reason: failureReason() },
      postCommitments: { ok: false, reason: failureReason() },
    };
  }

  // dryRunShadow needs a keystore (run-time signing for fill-detection) — but the file just has to be present + readable.
  const keystoreStatus = checks.find((c) => c.name === 'keystore')?.status;
  const dryRunShadow: DoctorReadiness =
    keystoreStatus === 'ok'
      ? { ok: true, reason: 'no FAILs; keystore in place — `ospex-mm run --dry-run` should boot' }
      : {
          ok: false,
          reason: 'no keystore configured — `run --dry-run` needs one for fill-detection (set wallet.keystorePath or OSPEX_KEYSTORE_PATH)',
        };

  // postCommitments is dryRunShadow + the live prereqs.
  const postReasons: string[] = [];
  if (!dryRunShadow.ok) postReasons.push('dry-run-shadow prerequisites not met');
  if (walletAddress === null) postReasons.push('wallet address unresolved (pass --address or use an ethers-style keystore)');
  if (config.mode.dryRun) postReasons.push('config has mode.dryRun: true (flip to false; you would also pass --live at run time)');
  const balanceWarn = checks.find((c) => c.name === 'pol-balance')?.status === 'warn';
  const usdcWarn = checks.find((c) => c.name === 'usdc-balance')?.status === 'warn';
  const allowanceWarn = checks.find((c) => c.name === 'allowance')?.status === 'warn';
  if (balanceWarn) postReasons.push('POL balance below the emergency reserve');
  if (usdcWarn) postReasons.push('USDC balance below the configured cap ceiling');
  if (allowanceWarn) postReasons.push('PositionModule allowance below the required aggregate');

  const postCommitments: DoctorReadiness =
    postReasons.length === 0
      ? { ok: true, reason: 'all live prerequisites met — pass --live to `run` to go live' }
      : { ok: false, reason: postReasons.join('; ') };

  return { dryRunShadow, postCommitments };
}

// ── renderers ────────────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<DoctorCheckStatus, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' };
const NAME_PAD = 13;
const STATUS_PAD = 5;

/** Write the JSON envelope `{ schemaVersion: 1, doctor: DoctorReport }` to `out` — stable agent contract. */
export function renderDoctorReportJson(report: DoctorReport, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, doctor: report })}\n`);
}

/** Write the human-readable report to `out`. Not a stable contract — use `--json` for parsing (AGENT_CONTRACT §1). */
export function renderDoctorReportText(report: DoctorReport, out: { write(s: string): void }): void {
  out.write(`ospex-mm doctor — readiness check\n\n`);
  out.write(`config:    ${report.configPath}\n`);
  out.write(`chain:     ${report.chainId}\n`);
  out.write(`api:       ${report.apiUrl}\n`);
  out.write(`wallet:    ${report.walletAddress ?? '(unresolved)'}\n\n`);
  for (const c of report.checks) {
    out.write(`${c.name.padEnd(NAME_PAD)} ${STATUS_DISPLAY[c.status].padEnd(STATUS_PAD)} ${c.detail}\n`);
  }
  out.write(`\nReady to:\n`);
  out.write(`  dry-run shadow    ${report.ready.dryRunShadow.ok ? 'YES' : 'NO '}  ${report.ready.dryRunShadow.reason}\n`);
  out.write(`  post commitments  ${report.ready.postCommitments.ok ? 'YES' : 'NO '}  ${report.ready.postCommitments.reason}\n`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toRiskCaps(config: Config): RiskCaps {
  return {
    bankrollUSDC: config.risk.bankrollUSDC,
    maxBankrollUtilizationPct: config.risk.maxBankrollUtilizationPct,
    maxRiskPerCommitmentUSDC: config.risk.maxRiskPerCommitmentUSDC,
    maxRiskPerContestUSDC: config.risk.maxRiskPerContestUSDC,
    maxRiskPerTeamUSDC: config.risk.maxRiskPerTeamUSDC,
    maxRiskPerSportUSDC: config.risk.maxRiskPerSportUSDC,
    maxOpenCommitments: config.risk.maxOpenCommitments,
  };
}

function formatUnits(raw: bigint, decimals: number, displayDp: number): string {
  const div = 10n ** BigInt(decimals);
  const whole = raw / div;
  const frac = raw % div;
  if (displayDp === 0) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayDp);
  return `${whole.toString()}.${fracStr}`;
}
