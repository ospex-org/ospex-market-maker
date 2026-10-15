/** Independent, explicit house-taker configuration. No maker config or state is reused. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { TakerError } from './errors.js';

export interface TakerConfig {
  schemaVersion: 1;
  mode: { dryRun: boolean };
  chainId: 137 | 80002;
  apiUrl: string;
  rpcUrl: string;
  wallet: { address: string; keystorePath: string };
  makers: Array<{ address: string; label: string; controller: string }>;
  houseWallets: Array<{ address: string; label: string; controller: string }>;
  distancePp: number;
  capUSDC: string;
  minSecondsLeft: number;
  pollIntervalMs: number;
  stateDir: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const USDC_SCALE = 1_000_000n;
const DECIMAL_6 = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

function fail(path: string, detail: string): never {
  // Report the field, never its value: a mistyped config can contain credentials.
  throw new TakerError('TAKER_CONFIG', `taker config: ${path} ${detail}`);
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be a mapping');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain mapping');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(path, 'has unknown key; compare the supported schema');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail(path, 'must be a nonempty string');
  }
  return value;
}

function address(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length !== 42 || !ADDRESS.test(value) || value.toLowerCase() === ZERO_ADDRESS) {
    fail(path, 'must be a nonzero 0x-prefixed 40-hex-character address');
  }
  return value.toLowerCase();
}

function url(value: unknown, path: string): string {
  const raw = text(value, path);
  if (/\s/.test(raw) || !/^https?:\/\//i.test(raw)) fail(path, 'must be an HTTP(S) URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(path, 'must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname === '') {
    fail(path, 'must be an HTTP(S) URL');
  }
  return raw;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return value;
}

function listedWallets(value: unknown, path: string): TakerConfig['makers'] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a nonempty array');
  const seen = new Set<string>();
  return Array.from(value, (entry: unknown, index) => {
    const entryPath = `${path}[${index}]`;
    const row = object(entry, entryPath, ['address', 'label', 'controller']);
    const canonical = address(row['address'], `${entryPath}.address`);
    if (seen.has(canonical)) fail(`${entryPath}.address`, 'is a duplicate address');
    seen.add(canonical);
    return {
      address: canonical,
      label: text(row['label'], `${entryPath}.label`),
      controller: text(row['controller'], `${entryPath}.controller`),
    };
  });
}

function parseCap(value: unknown): bigint {
  if (typeof value !== 'string' || value.trim() !== value || !DECIMAL_6.test(value)) {
    fail('capUSDC', 'must be a positive quoted decimal string with at most 6 decimal places');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const units = BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) fail('capUSDC', 'must be positive');
  return units;
}

/** Parse without defaults, environment overrides, filesystem access, or input mutation. */
export function parseConfig(value: unknown): TakerConfig {
  const root = object(value, 'root', [
    'schemaVersion', 'mode', 'chainId', 'apiUrl', 'rpcUrl', 'wallet', 'makers',
    'houseWallets', 'distancePp', 'capUSDC', 'minSecondsLeft', 'pollIntervalMs', 'stateDir',
  ]);
  if (root['schemaVersion'] !== 1) fail('schemaVersion', 'must be 1');
  const mode = object(root['mode'], 'mode', ['dryRun']);
  const dryRun = mode['dryRun'];
  if (typeof dryRun !== 'boolean') fail('mode.dryRun', 'must be an explicit boolean');
  const chainId = root['chainId'];
  if (chainId !== 137 && chainId !== 80002) fail('chainId', 'must be explicitly 137 or 80002');

  const wallet = object(root['wallet'], 'wallet', ['address', 'keystorePath']);
  const ownAddress = address(wallet['address'], 'wallet.address');
  const makers = listedWallets(root['makers'], 'makers');
  const houseWallets = listedWallets(root['houseWallets'], 'houseWallets');
  const houseAddresses = new Set(houseWallets.map((entry) => entry.address));
  for (const maker of makers) {
    if (maker.address === ownAddress) fail('makers', 'must not contain the taker wallet itself');
    if (houseAddresses.has(maker.address)) fail('makers', 'must not overlap houseWallets');
  }

  const distancePp = finiteNumber(root['distancePp'], 'distancePp');
  if (distancePp < 0 || distancePp > 100 || !DECIMAL_6.test(String(distancePp))) {
    fail('distancePp', 'must be in [0, 100] with at most 6 decimal places');
  }
  const capUSDC = text(root['capUSDC'], 'capUSDC');
  parseCap(capUSDC);
  const minSecondsLeft = finiteNumber(root['minSecondsLeft'], 'minSecondsLeft');
  if (minSecondsLeft <= 0) fail('minSecondsLeft', 'must be positive');
  const pollIntervalMs = finiteNumber(root['pollIntervalMs'], 'pollIntervalMs');
  if (pollIntervalMs < 1) fail('pollIntervalMs', 'must be at least 1');

  return {
    schemaVersion: 1,
    mode: { dryRun },
    chainId,
    apiUrl: url(root['apiUrl'], 'apiUrl'),
    rpcUrl: url(root['rpcUrl'], 'rpcUrl'),
    wallet: { address: ownAddress, keystorePath: text(wallet['keystorePath'], 'wallet.keystorePath') },
    makers,
    houseWallets,
    distancePp,
    capUSDC,
    minSecondsLeft,
    pollIntervalMs,
    stateDir: text(root['stateDir'], 'stateDir'),
  };
}

/** Only read this config file. Paths are config-relative; no keystore/state is opened or initialized. */
export function loadConfig(path: string): TakerConfig {
  const absolutePath = resolve(path);
  let source: string;
  try { source = readFileSync(absolutePath, 'utf8'); }
  catch { throw new TakerError('TAKER_CONFIG', 'Cannot read the taker config file. Check its path and permissions.'); }
  let value: unknown;
  try { value = yaml.load(source, { schema: yaml.CORE_SCHEMA }); }
  catch { throw new TakerError('TAKER_CONFIG', 'Malformed taker YAML. Check syntax; source values are hidden.'); }
  const config = parseConfig(value);
  const base = dirname(absolutePath);
  return {
    ...config,
    wallet: { ...config.wallet, keystorePath: resolve(base, config.wallet.keystorePath) },
    stateDir: resolve(base, config.stateDir),
  };
}

/** Exact integer micro-USDC, including when the cap exceeds Number.MAX_SAFE_INTEGER. */
export function capWei6(config: TakerConfig): bigint {
  return parseCap(config.capUSDC);
}

/** Lossless signed decimal display, without redundant trailing fractional zeroes. */
export function formatUSDC(wei6: bigint): string {
  const sign = wei6 < 0n ? '-' : '';
  const magnitude = wei6 < 0n ? -wei6 : wei6;
  const fraction = (magnitude % USDC_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${magnitude / USDC_SCALE}${fraction === '' ? '' : `.${fraction}`}`;
}
