/**
 * Config loading + validation. The schema is in `./types.ts` (DESIGN §7); the
 * annotated reference config is `ospex-mm.example.yaml` at the repo root.
 *
 * Almost everything has a default (matching the example), so a minimal config
 * needs only `rpcUrl` (here or via `OSPEX_RPC_URL`). Whatever the operator sets
 * is validated; an invalid / mistyped field — including an unknown / misspelled
 * key at any level — throws a clear `Error` (the CLI catches it and exits 1).
 * v0-specific rejections: `marketSelection.markets` must be `["moneyline"]`;
 * `pricing.quoteBothSides` must be `true`.
 *
 * `parseConfig(raw, env)` is deterministic — `env` defaults to `{}` (no overrides).
 * `loadConfig(path, env)` defaults `env` to `process.env`.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import {
  APPROVAL_MODES,
  CANCEL_MODES,
  CHAIN_IDS,
  EXPIRY_MODES,
  KNOWN_SPORTS,
  LOG_LEVELS,
  POLL_INTERVAL_FLOOR_MS,
  SPREAD_MODES,
  SUPPORTED_MARKETS,
  type ApprovalMode,
  type ApprovalsConfig,
  type CancelMode,
  type ChainId,
  type Config,
  type DirectConfig,
  type DiscoveryConfig,
  type EconomicsConfig,
  type ExpiryMode,
  type GasConfig,
  type LogLevel,
  type MarketSelectionConfig,
  type MarketType,
  type ModeConfig,
  type OddsConfig,
  type OrdersConfig,
  type PricingConfig,
  type RiskConfig,
  type SettlementConfig,
  type Sport,
  type SpreadMode,
  type StateConfig,
  type TelemetryConfig,
  type WalletConfig,
} from './types.js';

export * from './types.js';

type EnvLike = Record<string, string | undefined>;

function fail(name: string, detail: string): never {
  throw new Error(`config: \`${name}\` ${detail}`);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'object') {
    const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === 'string' && name !== 'Object' && name !== '' ? name : 'object';
  }
  return typeof v;
}

/** A plain `{}` object (a YAML mapping) — not `null`, not an array, not a `Date` / `RegExp` / class instance. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function asObject(v: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(name, `must be an object, got ${describe(v)}`);
  return v;
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') fail(name, `must be a string, got ${describe(v)}`);
  return v;
}

function asNonEmptyString(v: unknown, name: string): string {
  const s = asString(v, name);
  if (s.trim() === '') fail(name, 'must not be empty');
  return s;
}

function asBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(name, `must be a boolean (true / false), got ${describe(v)}`);
  return v;
}

function asNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(name, `must be a finite number, got ${describe(v)}`);
  return v;
}

function asPositiveNumber(v: unknown, name: string): number {
  const n = asNumber(v, name);
  if (!(n > 0)) fail(name, `must be > 0, got ${n}`);
  return n;
}

function asNonNegativeNumber(v: unknown, name: string): number {
  const n = asNumber(v, name);
  if (!(n >= 0)) fail(name, `must be ≥ 0, got ${n}`);
  return n;
}

function asPositiveInt(v: unknown, name: string): number {
  const n = asPositiveNumber(v, name);
  if (!Number.isInteger(n)) fail(name, `must be an integer, got ${n}`);
  return n;
}

function asNumberInRange(
  v: unknown,
  name: string,
  min: number,
  max: number,
  opts: { minInclusive: boolean; maxInclusive: boolean },
): number {
  const n = asNumber(v, name);
  const lowOk = opts.minInclusive ? n >= min : n > min;
  const highOk = opts.maxInclusive ? n <= max : n < max;
  if (!lowOk || !highOk) {
    fail(name, `must be in ${opts.minInclusive ? '[' : '('}${min}, ${max}${opts.maxInclusive ? ']' : ')'}, got ${n}`);
  }
  return n;
}

function asEnum<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(name, `must be one of: ${allowed.join(', ')} — got ${describe(v)}`);
  }
  return v as T;
}

function asStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) fail(name, `must be an array, got ${describe(v)}`);
  return v.map((item, i) => asString(item, `${name}[${i}]`));
}

/** A USDC / POL amount: a string or number that coerces to a finite, ≥ 0 number. */
function asAmount(v: unknown, name: string): number {
  if (typeof v === 'string' && v.trim() === '') fail(name, 'must not be empty');
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(name, `must be a number (or numeric string), got ${describe(v)}`);
  if (!(n >= 0)) fail(name, `must be ≥ 0, got ${n}`);
  return n;
}

function asPositiveAmount(v: unknown, name: string): number {
  const n = asAmount(v, name);
  if (!(n > 0)) fail(name, `must be > 0, got ${n}`);
  return n;
}

function asSportArray(v: unknown, name: string): Sport[] {
  const arr = asStringArray(v, name);
  if (arr.length === 0) fail(name, 'must list at least one sport');
  for (const s of arr) {
    if (!(KNOWN_SPORTS as readonly string[]).includes(s)) {
      fail(name, `"${s}" is not a known sport — supported: ${KNOWN_SPORTS.join(', ')}`);
    }
  }
  return arr as Sport[];
}

function asMarketArray(v: unknown, name: string): MarketType[] {
  const arr = asStringArray(v, name);
  if (arr.length === 0) fail(name, 'must list at least one market type');
  for (const m of arr) {
    if (!(SUPPORTED_MARKETS as readonly string[]).includes(m)) {
      fail(name, `"${m}" is not supported in v0 — only "moneyline" is implemented (spread / total are future work; see DESIGN §5)`);
    }
  }
  return arr as MarketType[];
}

function asChainId(v: unknown, name: string): ChainId {
  const n = asNumber(v, name);
  if (n !== 137 && n !== 80002) fail(name, `must be one of: ${CHAIN_IDS.join(', ')} (137 = Polygon mainnet, 80002 = Amoy) — got ${n}`);
  return n;
}

/** Treat an undefined-or-blank-string value as "not configured" (the caller decides whether that's an error). */
function isBlank(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.trim() === '');
}

function def<T>(value: unknown, fallback: T, validate: (v: unknown) => T): T {
  return value === undefined ? fallback : validate(value);
}

// Known keys at every object level — anything else is a misspelling / stale field and fails closed.
const ROOT_KEYS = [
  'wallet', 'rpcUrl', 'apiUrl', 'chainId', 'marketSelection', 'discovery', 'odds', 'pricing',
  'risk', 'gas', 'approvals', 'orders', 'settlement', 'telemetry', 'state', 'killSwitchFile',
  'killCancelOnChain', 'pollIntervalMs', 'mode',
] as const;
const WALLET_KEYS = ['keystorePath'] as const;
const MARKET_SELECTION_KEYS = [
  'sports', 'markets', 'maxStartsWithinHours', 'maxTrackedContests', 'requireReferenceOdds',
  'requireOpenSpeculation', 'contestAllowList', 'contestDenyList',
] as const;
const DISCOVERY_KEYS = ['everyNTicks', 'jitterPct'] as const;
const ODDS_KEYS = ['subscribe', 'maxRealtimeChannels'] as const;
const PRICING_KEYS = ['mode', 'economics', 'direct', 'quoteBothSides', 'minEdgeBps', 'maxPerQuotePctOfCapital'] as const;
const ECONOMICS_KEYS = [
  'capitalUSDC', 'targetMonthlyReturnPct', 'daysHorizon', 'estGamesPerDay', 'fillRateAssumption',
  'capitalTurnoverPerDay', 'maxReasonableSpread',
] as const;
const DIRECT_KEYS = ['spreadBps'] as const;
const RISK_KEYS = [
  'bankrollUSDC', 'maxBankrollUtilizationPct', 'maxRiskPerCommitmentUSDC', 'maxRiskPerContestUSDC',
  'maxRiskPerTeamUSDC', 'maxRiskPerSportUSDC', 'maxOpenCommitments', 'maxDailyFeeUSDC',
] as const;
const GAS_KEYS = ['maxDailyGasPOL', 'emergencyReservePOL', 'reportInUSDC', 'nativeTokenUSDCPrice'] as const;
const APPROVALS_KEYS = ['autoApprove', 'mode'] as const;
const ORDERS_KEYS = [
  'expiryMode', 'expirySeconds', 'staleAfterSeconds', 'staleReferenceAfterSeconds', 'replaceOnOddsMoveBps', 'cancelMode',
] as const;
const SETTLEMENT_KEYS = ['autoSettleOwn', 'autoClaimOwn', 'continueOnGasBudgetExhausted'] as const;
const TELEMETRY_KEYS = ['logDir', 'logLevel'] as const;
const STATE_KEYS = ['dir'] as const;
const MODE_KEYS = ['dryRun'] as const;

function assertKnownKeys(obj: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${name}.${key}`, 'is not a known config field — see ospex-mm.example.yaml / DESIGN §7 for the schema');
    }
  }
}

/** Read a sub-section: `undefined` → `{}`; else must be a plain object with only known keys. */
function section(parent: Record<string, unknown>, key: string, allowed: readonly string[]): Record<string, unknown> {
  const v = parent[key];
  if (v === undefined) return {};
  const obj = asObject(v, key);
  assertKnownKeys(obj, key, allowed);
  return obj;
}

function applyEnvOverrides(root: Record<string, unknown>, env: EnvLike): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...root };
  if (env.OSPEX_RPC_URL !== undefined) merged.rpcUrl = env.OSPEX_RPC_URL;
  if (env.OSPEX_API_URL !== undefined) merged.apiUrl = env.OSPEX_API_URL;
  if (env.OSPEX_CHAIN_ID !== undefined) {
    const n = Number(env.OSPEX_CHAIN_ID);
    if (!Number.isFinite(n)) fail('OSPEX_CHAIN_ID', `(env var) must be numeric, got "${env.OSPEX_CHAIN_ID}"`);
    merged.chainId = n;
  }
  if (env.OSPEX_KEYSTORE_PATH !== undefined) {
    const wallet = isPlainObject(merged.wallet) ? { ...merged.wallet } : {};
    wallet.keystorePath = env.OSPEX_KEYSTORE_PATH;
    merged.wallet = wallet;
  }
  return merged;
}

/**
 * Validate + default a raw config object (e.g. parsed from YAML). Throws a clear
 * `Error` on any problem (including an unknown / misspelled key at any level).
 * Deterministic: `env` (default `{}`) supplies the env overrides — `OSPEX_RPC_URL`
 * / `OSPEX_API_URL` / `OSPEX_CHAIN_ID` / `OSPEX_KEYSTORE_PATH`.
 */
export function parseConfig(raw: unknown, env: EnvLike = {}): Config {
  const root = applyEnvOverrides(asObject(raw, 'config'), env);
  assertKnownKeys(root, 'config', ROOT_KEYS);

  const walletObj = section(root, 'wallet', WALLET_KEYS);
  const wallet: WalletConfig = {};
  if (!isBlank(walletObj.keystorePath)) wallet.keystorePath = asNonEmptyString(walletObj.keystorePath, 'wallet.keystorePath');

  if (isBlank(root.rpcUrl)) {
    fail('rpcUrl', 'is required — set it here or via the OSPEX_RPC_URL env var (there is no public-RPC default)');
  }
  const rpcUrl = asNonEmptyString(root.rpcUrl, 'rpcUrl');

  const apiUrl = isBlank(root.apiUrl) ? undefined : asNonEmptyString(root.apiUrl, 'apiUrl');

  const chainId = def<ChainId>(root.chainId, 137, (v) => asChainId(v, 'chainId'));

  const ms = section(root, 'marketSelection', MARKET_SELECTION_KEYS);
  const marketSelection: MarketSelectionConfig = {
    sports: def<Sport[]>(ms.sports, ['mlb'], (v) => asSportArray(v, 'marketSelection.sports')),
    markets: def<MarketType[]>(ms.markets, ['moneyline'], (v) => asMarketArray(v, 'marketSelection.markets')),
    maxStartsWithinHours: def(ms.maxStartsWithinHours, 24, (v) => asPositiveNumber(v, 'marketSelection.maxStartsWithinHours')),
    maxTrackedContests: def(ms.maxTrackedContests, 30, (v) => asPositiveInt(v, 'marketSelection.maxTrackedContests')),
    requireReferenceOdds: def(ms.requireReferenceOdds, true, (v) => asBoolean(v, 'marketSelection.requireReferenceOdds')),
    requireOpenSpeculation: def(ms.requireOpenSpeculation, true, (v) => asBoolean(v, 'marketSelection.requireOpenSpeculation')),
    contestAllowList: def<string[]>(ms.contestAllowList, [], (v) => asStringArray(v, 'marketSelection.contestAllowList')),
    contestDenyList: def<string[]>(ms.contestDenyList, [], (v) => asStringArray(v, 'marketSelection.contestDenyList')),
  };

  const d = section(root, 'discovery', DISCOVERY_KEYS);
  const discovery: DiscoveryConfig = {
    everyNTicks: def(d.everyNTicks, 10, (v) => asPositiveInt(v, 'discovery.everyNTicks')),
    jitterPct: def(d.jitterPct, 0.2, (v) => asNumberInRange(v, 'discovery.jitterPct', 0, 1, { minInclusive: true, maxInclusive: false })),
  };

  const o = section(root, 'odds', ODDS_KEYS);
  const odds: OddsConfig = {
    subscribe: def(o.subscribe, true, (v) => asBoolean(v, 'odds.subscribe')),
    maxRealtimeChannels: def(o.maxRealtimeChannels, 60, (v) => asPositiveInt(v, 'odds.maxRealtimeChannels')),
  };

  const p = section(root, 'pricing', PRICING_KEYS);
  const econObj = section(p, 'economics', ECONOMICS_KEYS);
  const economics: EconomicsConfig = {
    capitalUSDC: def(econObj.capitalUSDC, 50, (v) => asPositiveAmount(v, 'pricing.economics.capitalUSDC')),
    targetMonthlyReturnPct: def(econObj.targetMonthlyReturnPct, 0.005, (v) => asPositiveNumber(v, 'pricing.economics.targetMonthlyReturnPct')),
    daysHorizon: def(econObj.daysHorizon, 30, (v) => asPositiveNumber(v, 'pricing.economics.daysHorizon')),
    estGamesPerDay: def(econObj.estGamesPerDay, 8, (v) => asPositiveNumber(v, 'pricing.economics.estGamesPerDay')),
    fillRateAssumption: def(econObj.fillRateAssumption, 0.3, (v) => asNumberInRange(v, 'pricing.economics.fillRateAssumption', 0, 1, { minInclusive: false, maxInclusive: true })),
    capitalTurnoverPerDay: def(econObj.capitalTurnoverPerDay, 1, (v) => asPositiveNumber(v, 'pricing.economics.capitalTurnoverPerDay')),
    maxReasonableSpread: def(econObj.maxReasonableSpread, 0.05, (v) => asNumberInRange(v, 'pricing.economics.maxReasonableSpread', 0, 1, { minInclusive: false, maxInclusive: true })),
  };
  const directObj = section(p, 'direct', DIRECT_KEYS);
  const direct: DirectConfig = {
    spreadBps: def(directObj.spreadBps, 300, (v) => asPositiveNumber(v, 'pricing.direct.spreadBps')),
  };
  const quoteBothSides = def(p.quoteBothSides, true, (v) => asBoolean(v, 'pricing.quoteBothSides'));
  if (!quoteBothSides) fail('pricing.quoteBothSides', 'must be true — single-sided quoting is not implemented in v0');
  const pricing: PricingConfig = {
    mode: def<SpreadMode>(p.mode, 'economics', (v) => asEnum(v, 'pricing.mode', SPREAD_MODES)),
    economics,
    direct,
    quoteBothSides,
    minEdgeBps: def(p.minEdgeBps, 0, (v) => asNonNegativeNumber(v, 'pricing.minEdgeBps')),
    maxPerQuotePctOfCapital: def(p.maxPerQuotePctOfCapital, 0.05, (v) => asNumberInRange(v, 'pricing.maxPerQuotePctOfCapital', 0, 1, { minInclusive: false, maxInclusive: true })),
  };

  const r = section(root, 'risk', RISK_KEYS);
  const risk: RiskConfig = {
    bankrollUSDC: def(r.bankrollUSDC, 50, (v) => asPositiveAmount(v, 'risk.bankrollUSDC')),
    maxBankrollUtilizationPct: def(r.maxBankrollUtilizationPct, 0.5, (v) => asNumberInRange(v, 'risk.maxBankrollUtilizationPct', 0, 1, { minInclusive: false, maxInclusive: true })),
    maxRiskPerCommitmentUSDC: def(r.maxRiskPerCommitmentUSDC, 0.25, (v) => asPositiveAmount(v, 'risk.maxRiskPerCommitmentUSDC')),
    maxRiskPerContestUSDC: def(r.maxRiskPerContestUSDC, 1, (v) => asPositiveAmount(v, 'risk.maxRiskPerContestUSDC')),
    maxRiskPerTeamUSDC: def(r.maxRiskPerTeamUSDC, 2, (v) => asPositiveAmount(v, 'risk.maxRiskPerTeamUSDC')),
    maxRiskPerSportUSDC: def(r.maxRiskPerSportUSDC, 5, (v) => asPositiveAmount(v, 'risk.maxRiskPerSportUSDC')),
    maxOpenCommitments: def(r.maxOpenCommitments, 10, (v) => asPositiveInt(v, 'risk.maxOpenCommitments')),
    maxDailyFeeUSDC: def(r.maxDailyFeeUSDC, 0, (v) => asAmount(v, 'risk.maxDailyFeeUSDC')),
  };

  const g = section(root, 'gas', GAS_KEYS);
  const gas: GasConfig = {
    maxDailyGasPOL: def(g.maxDailyGasPOL, 1, (v) => asPositiveAmount(v, 'gas.maxDailyGasPOL')),
    emergencyReservePOL: def(g.emergencyReservePOL, 0.2, (v) => asAmount(v, 'gas.emergencyReservePOL')),
    reportInUSDC: def(g.reportInUSDC, true, (v) => asBoolean(v, 'gas.reportInUSDC')),
    nativeTokenUSDCPrice: def(g.nativeTokenUSDCPrice, 0.25, (v) => asPositiveAmount(v, 'gas.nativeTokenUSDCPrice')),
  };

  const a = section(root, 'approvals', APPROVALS_KEYS);
  const approvals: ApprovalsConfig = {
    autoApprove: def(a.autoApprove, false, (v) => asBoolean(v, 'approvals.autoApprove')),
    mode: def<ApprovalMode>(a.mode, 'exact', (v) => asEnum(v, 'approvals.mode', APPROVAL_MODES)),
  };

  const ord = section(root, 'orders', ORDERS_KEYS);
  const orders: OrdersConfig = {
    expiryMode: def<ExpiryMode>(ord.expiryMode, 'fixed-seconds', (v) => asEnum(v, 'orders.expiryMode', EXPIRY_MODES)),
    expirySeconds: def(ord.expirySeconds, 120, (v) => asPositiveInt(v, 'orders.expirySeconds')),
    staleAfterSeconds: def(ord.staleAfterSeconds, 90, (v) => asPositiveInt(v, 'orders.staleAfterSeconds')),
    staleReferenceAfterSeconds: def(ord.staleReferenceAfterSeconds, 300, (v) => asPositiveInt(v, 'orders.staleReferenceAfterSeconds')),
    replaceOnOddsMoveBps: def(ord.replaceOnOddsMoveBps, 50, (v) => asPositiveNumber(v, 'orders.replaceOnOddsMoveBps')),
    cancelMode: def<CancelMode>(ord.cancelMode, 'offchain', (v) => asEnum(v, 'orders.cancelMode', CANCEL_MODES)),
  };

  const s = section(root, 'settlement', SETTLEMENT_KEYS);
  const settlement: SettlementConfig = {
    autoSettleOwn: def(s.autoSettleOwn, true, (v) => asBoolean(v, 'settlement.autoSettleOwn')),
    autoClaimOwn: def(s.autoClaimOwn, true, (v) => asBoolean(v, 'settlement.autoClaimOwn')),
    continueOnGasBudgetExhausted: def(s.continueOnGasBudgetExhausted, true, (v) => asBoolean(v, 'settlement.continueOnGasBudgetExhausted')),
  };

  const t = section(root, 'telemetry', TELEMETRY_KEYS);
  const telemetry: TelemetryConfig = {
    logDir: def(t.logDir, './telemetry', (v) => asNonEmptyString(v, 'telemetry.logDir')),
    logLevel: def<LogLevel>(t.logLevel, 'info', (v) => asEnum(v, 'telemetry.logLevel', LOG_LEVELS)),
  };

  const st = section(root, 'state', STATE_KEYS);
  const state: StateConfig = {
    dir: def(st.dir, './state', (v) => asNonEmptyString(v, 'state.dir')),
  };

  const m = section(root, 'mode', MODE_KEYS);
  const mode: ModeConfig = {
    dryRun: def(m.dryRun, true, (v) => asBoolean(v, 'mode.dryRun')),
  };

  const config: Config = {
    wallet,
    rpcUrl,
    chainId,
    marketSelection,
    discovery,
    odds,
    pricing,
    risk,
    gas,
    approvals,
    orders,
    settlement,
    telemetry,
    state,
    killSwitchFile: def(root.killSwitchFile, './KILL', (v) => asNonEmptyString(v, 'killSwitchFile')),
    killCancelOnChain: def(root.killCancelOnChain, false, (v) => asBoolean(v, 'killCancelOnChain')),
    pollIntervalMs: def(root.pollIntervalMs, POLL_INTERVAL_FLOOR_MS, (v) => asPositiveInt(v, 'pollIntervalMs')),
    mode,
  };
  if (apiUrl !== undefined) config.apiUrl = apiUrl;
  return config;
}

/** Read a YAML config file and validate it. Throws a clear `Error` on a missing file, bad YAML, or an invalid config. */
export function loadConfig(path: string, env: EnvLike = process.env): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`config: could not read ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new Error(`config: ${path} is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw, env);
}
