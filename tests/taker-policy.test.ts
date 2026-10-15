import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { capWei6, formatUSDC, loadConfig, parseConfig, type TakerConfig } from '../src/taker/config.js';
import { evaluate, type Quote, type Reference } from '../src/taker/policy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WALLET = `0x${'1'.repeat(40)}`;
const MAKER = `0x${'ab'.repeat(20)}`;
const HOUSE = `0x${'cd'.repeat(20)}`;
const OTHER = `0x${'e'.repeat(40)}`;
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const OBSERVED = '2026-10-15T04:00:00.000Z';
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<TakerConfig> = {}): TakerConfig {
  return {
    schemaVersion: 1,
    mode: { dryRun: true },
    chainId: 80002,
    apiUrl: 'https://api.example.invalid',
    rpcUrl: 'https://rpc.example.invalid',
    wallet: { address: WALLET, keystorePath: './keys/taker.json' },
    makers: [{ address: MAKER, label: 'Synthetic independent maker', controller: 'External test operator' }],
    houseWallets: [{ address: HOUSE, label: 'Synthetic house wallet', controller: 'House test operator' }],
    distancePp: 0,
    capUSDC: '100',
    minSecondsLeft: 30,
    pollIntervalMs: 1_000,
    stateDir: './state/house-taker',
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    hash: `0x${'a'.repeat(64)}`,
    maker: MAKER,
    contestId: '123',
    market: 'moneyline',
    lineTicks: 0,
    makerSide: 0,
    makerOddsTick: 200,
    remainingMakerWei6: '10000000',
    expiry: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

function reference(overrides: Partial<Reference> = {}): Reference {
  return {
    contestId: '123',
    market: 'moneyline',
    awayOddsAmerican: 100,
    homeOddsAmerican: 100,
    upstreamLastUpdated: OBSERVED,
    pollCapturedAt: '2026-10-15T11:59:59.000Z',
    changedAt: OBSERVED,
    ...overrides,
  };
}

function fixtureFile(raw: unknown): string {
  // Use the task scratch directory, never the system temporary directory.
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? dirname(ROOT), 'taker-config-test-'));
  scratchDirs.push(dir);
  const path = join(dir, 'taker.yaml');
  writeFileSync(path, yaml.dump(raw));
  return path;
}

it('checks price before cap when both would refuse the quote', () => {
  const result = evaluate(quote({ makerOddsTick: 300 }), reference(), config({ capUSDC: '1' }), NOW, 0n);
  expect(result.take).toBe(false);
  expect(result.reason).toContain('price is worse');
});

describe('house-taker config', () => {
  it('requires an explicit, independent schema and canonicalizes address case without mutating input', () => {
    const raw = config();
    raw.makers[0]!.address = `0x${'AB'.repeat(20)}`;
    raw.houseWallets[0]!.address = `0x${'CD'.repeat(20)}`;
    const parsed = parseConfig(raw);
    expect(parsed.makers[0]!.address).toBe(MAKER);
    expect(parsed.houseWallets[0]!.address).toBe(HOUSE);
    expect(raw.makers[0]!.address).not.toBe(MAKER);
    expect(parsed.mode.dryRun).toBe(true);
    expect(parsed).not.toBe(raw);
    expect(parsed.wallet).not.toBe(raw.wallet);
  });

  it.each([137, 80002] as const)('accepts explicit supported chain %s', (chainId) => {
    expect(parseConfig(config({ chainId })).chainId).toBe(chainId);
  });

  it('parses an explicit live config without activating any live action', () => {
    expect(parseConfig(config({ mode: { dryRun: false } })).mode.dryRun).toBe(false);
  });

  it.each(Object.keys(config()))('rejects missing required root field %s', (key) => {
    const raw = { ...config() } as Record<string, unknown>;
    delete raw[key];
    expect(() => parseConfig(raw)).toThrow();
  });

  it.each([null, [], 'yaml text', 1, true, new Date()])('rejects non-mapping %s', (raw) => {
    expect(() => parseConfig(raw)).toThrow();
  });

  it.each([
    { extra: 1 },
    { mode: { dryRun: true, live: true } },
    { wallet: { address: WALLET, keystorePath: 'a.json', privateKey: 'not-a-key' } },
    { makers: [{ address: MAKER, label: 'maker', controller: 'external', allowHouse: true }] },
    { houseWallets: [{ address: HOUSE, label: 'house', controller: 'house', disabled: true }] },
  ])('rejects unknown keys at every nesting level: %j', (overrides) => {
    expect(() => parseConfig({ ...config(), ...overrides })).toThrow(/unknown/i);
  });

  it.each([
    { schemaVersion: 2 }, { schemaVersion: '1' }, { chainId: 1 }, { chainId: '137' },
    { mode: { dryRun: 'false' } }, { mode: {} }, { mode: [] },
    { wallet: [] }, { wallet: { address: WALLET } },
    { wallet: { address: WALLET, keystorePath: '  ' } },
    { stateDir: '' }, { stateDir: null },
    { minSecondsLeft: 0 }, { minSecondsLeft: -1 }, { minSecondsLeft: NaN },
    { minSecondsLeft: Infinity }, { minSecondsLeft: '30' },
    { pollIntervalMs: 0 }, { pollIntervalMs: 0.5 }, { pollIntervalMs: Infinity },
    { distancePp: -0.000001 }, { distancePp: 100.000001 }, { distancePp: NaN },
    { distancePp: Infinity }, { distancePp: '1' }, { distancePp: 0.0000001 },
    { distancePp: 1.1234567 },
  ])('rejects malformed scalar/nested configuration: %j', (overrides) => {
    expect(() => parseConfig({ ...config(), ...overrides })).toThrow();
  });

  it.each([0, 0.000001, 0.123456, 1, 99.999999, 100])('accepts exact bounded distance %s pp', (distancePp) => {
    expect(parseConfig(config({ distancePp })).distancePp).toBe(distancePp);
  });

  it('accepts a positive fractional expiry threshold and a one-ms polling interval', () => {
    expect(parseConfig(config({ minSecondsLeft: 0.5, pollIntervalMs: 1 })).minSecondsLeft).toBe(0.5);
  });

  it.each(['apiUrl', 'rpcUrl'] as const)('validates HTTP(S) URLs for %s', (key) => {
    for (const value of ['http://localhost:8000/v1', 'https://host.invalid/path?key=synthetic']) {
      expect(parseConfig({ ...config(), [key]: value })[key]).toBe(value);
    }
    for (const value of ['', 'not a URL', 'host.invalid', 'file:///etc/config', 'ws://host.invalid', 'ftp://host.invalid', 'https://ho\nst.invalid']) {
      expect(() => parseConfig({ ...config(), [key]: value })).toThrow();
    }
  });

  it.each(['wallet', 'makers', 'houseWallets'] as const)('rejects malformed or zero addresses in %s', (field) => {
    for (const address of ['', `0x${'0'.repeat(40)}`, `0x${'g'.repeat(40)}`, `0x${'1'.repeat(39)}`, `0x${'1'.repeat(41)}`, MAKER.slice(2), ` ${MAKER}`, `${MAKER}\n`]) {
      const raw = config();
      if (field === 'wallet') raw.wallet.address = address;
      else raw[field][0]!.address = address;
      expect(() => parseConfig(raw)).toThrow(/address/i);
    }
  });

  it.each(['makers', 'houseWallets'] as const)('requires a nonempty labeled %s list with unique addresses', (field) => {
    for (const value of [[], new Array<unknown>(1), null, {}, [{ address: MAKER, label: 'maker' }], [{ address: MAKER, controller: 'operator' }]]) {
      expect(() => parseConfig({ ...config(), [field]: value })).toThrow();
    }
    for (const key of ['label', 'controller'] as const) {
      for (const bad of ['', ' \n ', 17, null]) {
        const entry = { ...config()[field][0]!, [key]: bad };
        expect(() => parseConfig({ ...config(), [field]: [entry] })).toThrow();
      }
    }
    const raw = config();
    const entry = raw[field][0]!;
    raw[field].push({ ...entry, address: `0x${entry.address.slice(2).toUpperCase()}` });
    expect(() => parseConfig(raw)).toThrow(/duplicate/i);
  });

  it('rejects overlap and own maker case-insensitively, but can identify the taker as a house wallet', () => {
    const overlap = config();
    overlap.houseWallets[0]!.address = `0x${'AB'.repeat(20)}`;
    expect(() => parseConfig(overlap)).toThrow(/overlap|house/i);
    const own = config({ wallet: { address: MAKER, keystorePath: 'keys.json' } });
    expect(() => parseConfig(own)).toThrow(/self|own|wallet/i);
    expect(parseConfig(config({ houseWallets: [{ address: WALLET, label: 'Taker', controller: 'House' }] }))).toBeDefined();
  });

  it.each([100, 0, null, '', '0', '0.000000', '-1', '+1', '.1', '1.', '01', '1e3', '1_000', '1,000', ' 1', '1 ', '1\n', '1.0000001', 'NaN', 'Infinity'])('rejects nonpositive, non-string or nondecimal cap %s', (capUSDC) => {
    expect(() => parseConfig({ ...config(), capUSDC })).toThrow(/capUSDC/i);
  });

  it.each([
    ['0.000001', 1n], ['0.100001', 100001n], ['1', 1000000n],
    ['1.000000', 1000000n], ['9007199254740993.123456', 9007199254740993123456n],
  ] as const)('uses exact integer units for cap %s', (capUSDC, expected) => {
    expect(capWei6(parseConfig(config({ capUSDC })))).toBe(expected);
  });

  it.each([
    [0n, '0'], [1n, '0.000001'], [100n, '0.0001'], [1234500n, '1.2345'],
    [1000000n, '1'], [-1n, '-0.000001'], [-1200000n, '-1.2'],
    [9007199254740993123456n, '9007199254740993.123456'],
  ] as const)('formats integer wei6 %s without float loss', (units, expected) => {
    expect(formatUSDC(units)).toBe(expected);
  });

  it('validates capWei6 even when callers bypass parseConfig', () => {
    expect(() => capWei6(config({ capUSDC: '1e3' }))).toThrow();
  });

  it('loads YAML and resolves relative paths against the config directory, not the CWD', () => {
    const path = fixtureFile(config());
    const loaded = loadConfig(path);
    expect(loaded.wallet.keystorePath).toBe(resolve(dirname(path), 'keys/taker.json'));
    expect(loaded.stateDir).toBe(resolve(dirname(path), 'state/house-taker'));
  });

  it('preserves absolute paths and does not read the keystore or initialize state', () => {
    const keystorePath = resolve(dirname(ROOT), 'synthetic-never-opened-key.json');
    const stateDir = resolve(dirname(ROOT), 'synthetic-never-initialized-state');
    const path = fixtureFile(config({ wallet: { address: WALLET, keystorePath }, stateDir }));
    expect(loadConfig(path).wallet.keystorePath).toBe(keystorePath);
    expect(loadConfig(path).stateDir).toBe(stateDir);
  });

  it('rejects unquoted numeric caps and duplicate YAML keys', () => {
    expect(() => loadConfig(fixtureFile({ ...config(), capUSDC: 100 }))).toThrow();
    const path = fixtureFile(config());
    writeFileSync(path, `${readFileSync(path, 'utf8')}capUSDC: '200'\n`);
    expect(() => loadConfig(path)).toThrow();
  });

  it('ships a parseable synthetic dry-run example with a test-only 1 pp tolerance and first-live zero warning', () => {
    const path = join(ROOT, 'ospex-taker.example.yaml');
    const example = loadConfig(path);
    expect(example.mode.dryRun).toBe(true);
    expect(example.distancePp).toBe(1);
    expect(example.stateDir).not.toContain('maker-state');
    expect(readFileSync(path, 'utf8')).toMatch(/first live[^\n]*0/i);
  });
});

describe('house-taker raw-reference price policy', () => {
  it.each([
    ['moneyline', 0, 'home', 0], ['moneyline', 1, 'away', 0],
    ['spread', 0, 'home', -15], ['spread', 1, 'away', -15],
    ['total', 0, 'under', 75], ['total', 1, 'over', 75],
  ] as const)('matches %s maker side %s to exact bettor side %s', (market, makerSide, bettorSide, lineTicks) => {
    const ref = reference({ market, awayLine: -1.5, homeLine: 1.5, line: 7.5,
      awayOddsAmerican: bettorSide === 'away' ? -150 : 400,
      homeOddsAmerican: bettorSide === 'home' ? -150 : 400,
      overOddsAmerican: bettorSide === 'over' ? -150 : 400,
      underOddsAmerican: bettorSide === 'under' ? -150 : 400,
    });
    const decision = evaluate(quote({ market, makerSide, lineTicks, makerOddsTick: 250 }), ref, config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.bettorSide).toBe(bettorSide);
    expect(decision.bettorDecimal).toBeCloseTo(5 / 3, 14);
    expect(decision.referenceAmerican).toBe(-150);
    expect(decision.referenceProbability).toBe(0.6);
    expect(decision.distancePp).toBe(0);
    expect(decision.stakeWei6).toBe('15000000');
  });

  it('uses the raw posted odds, not no-vig probabilities', () => {
    const decision = evaluate(quote({ makerOddsTick: 210 }), reference({ awayOddsAmerican: -110, homeOddsAmerican: -110 }), config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.referenceProbability).toBeCloseTo(110 / 210, 14);
    expect(decision.referenceProbability).not.toBe(0.5);
    expect(decision.distancePp).toBe(0);
  });

  it('does not require the unused opposite reference price', () => {
    expect(evaluate(quote(), reference({ awayOddsAmerican: null }), config(), NOW, 0n).take).toBe(true);
    expect(evaluate(quote({ makerSide: 1 }), reference({ homeOddsAmerican: null }), config(), NOW, 0n).take).toBe(true);
  });

  it.each([101, 150, 199, 200, 207, 250, 625, 10100])('inverts maker tick %s exactly rather than rounding the inverse tick', (makerOddsTick) => {
    const decision = evaluate(quote({ makerOddsTick, remainingMakerWei6: '100' }), reference(), config({ distancePp: 100 }), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.bettorDecimal).toBe(makerOddsTick / (makerOddsTick - 100));
    expect(decision.stakeWei6).toBe(String(makerOddsTick - 100));
  });

  it('accepts a quote that rounded inverse odds would incorrectly reject', () => {
    const decision = evaluate(quote({ makerOddsTick: 207 }), reference(), config({ distancePp: 1.7 }), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.distancePp).toBeCloseTo(100 * (107 / 207 - 0.5), 12);
  });

  it('rejects a quote that rounded inverse odds would incorrectly accept', () => {
    const decision = evaluate(quote({ makerOddsTick: 250 }), reference(), config({ distancePp: 9.9 }), NOW, 0n);
    expect(decision.take).toBe(false);
    expect(decision.distancePp).toBe(10);
  });

  it('includes the exact tolerance boundary even when binary subtraction would overshoot', () => {
    expect(0.8 - 0.5).toBeGreaterThan(0.3);
    const decision = evaluate(quote({ makerOddsTick: 500 }), reference(), config({ distancePp: 30 }), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.distancePp).toBe(30);
    expect(evaluate(quote({ makerOddsTick: 501 }), reference(), config({ distancePp: 30 }), NOW, 0n).take).toBe(false);
    expect(evaluate(quote({ makerOddsTick: 500 }), reference(), config({ distancePp: 29.999999 }), NOW, 0n).take).toBe(false);
  });

  it('includes exact fractional-pp equality and rejects one millionth pp below it', () => {
    expect(evaluate(quote({ makerOddsTick: 640 }), reference(), config({ distancePp: 34.375 }), NOW, 0n).take).toBe(true);
    expect(evaluate(quote({ makerOddsTick: 640 }), reference(), config({ distancePp: 34.374999 }), NOW, 0n).take).toBe(false);
  });

  it('always accepts better signed prices, even outside the absolute tolerance band', () => {
    const decision = evaluate(quote({ makerOddsTick: 150 }), reference({ homeOddsAmerican: -200 }), config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.distancePp).toBeCloseTo(-100 / 3, 12);
  });

  it('uses positive American odds directly', () => {
    const decision = evaluate(quote({ makerOddsTick: 150 }), reference({ homeOddsAmerican: 200 }), config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.referenceProbability).toBe(1 / 3);
    expect(decision.distancePp).toBe(0);
  });

  it('preserves fractional American odds in the rational comparison', () => {
    const ref = reference({ homeOddsAmerican: -150.5 });
    expect(evaluate(quote({ makerOddsTick: 250 }), ref, config(), NOW, 0n).take).toBe(true);
    expect(evaluate(quote({ makerOddsTick: 251 }), ref, config(), NOW, 0n).take).toBe(false);
  });

  it('does not mix contests, market types, or moneyline lines', () => {
    expect(evaluate(quote(), reference({ contestId: '124' }), config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote(), reference({ contestId: '0123' }), config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote(), reference({ market: 'spread' }), config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote({ lineTicks: 1 }), reference(), config(), NOW, 0n).take).toBe(false);
  });

  it.each([0, 1] as const)('requires exact away-perspective spread ticks for maker side %s', (makerSide) => {
    const ref = reference({ market: 'spread', awayLine: -1.5, homeLine: 1.5 });
    expect(evaluate(quote({ market: 'spread', makerSide, lineTicks: -15 }), ref, config(), NOW, 0n).take).toBe(true);
    expect(evaluate(quote({ market: 'spread', makerSide, lineTicks: 15 }), ref, config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote({ market: 'spread', makerSide, lineTicks: -15 }), { ...ref, awayLine: -1.51, homeLine: 1.51 }, config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote({ market: 'spread', makerSide, lineTicks: -15 }), { ...ref, homeLine: -1.5 }, config(), NOW, 0n).take).toBe(false);
    expect(evaluate(quote({ market: 'spread', makerSide, lineTicks: -15 }), { ...ref, homeLine: null }, config(), NOW, 0n).take).toBe(false);
  });

  it('accepts exactly representable tenth-point lines without rounding nearby lines', () => {
    const ref = reference({ market: 'spread', awayLine: -2.3, homeLine: 2.3 });
    expect(evaluate(quote({ market: 'spread', lineTicks: -23 }), ref, config(), NOW, 0n).take).toBe(true);
    expect(evaluate(quote({ market: 'spread', lineTicks: -23 }), { ...ref, awayLine: -2.3000000000000003 }, config(), NOW, 0n).take).toBe(false);
  });

  it.each([0, 1] as const)('requires exact total line for maker side %s', (makerSide) => {
    const q = quote({ market: 'total', makerSide, lineTicks: 75 });
    const ref = reference({ market: 'total', line: 7.5, overOddsAmerican: 100, underOddsAmerican: 100 });
    expect(evaluate(q, ref, config(), NOW, 0n).take).toBe(true);
    for (const line of [null, 7, 7.51, NaN, Infinity]) {
      expect(evaluate(q, { ...ref, line }, config(), NOW, 0n).take).toBe(false);
    }
  });

  it('accepts eight-hour-old valid reference timestamps without an age limit', () => {
    const decision = evaluate(quote(), reference({ pollCapturedAt: OBSERVED }), config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.referenceObservedAt).toBe(OBSERVED);
  });

  it.each(['upstreamLastUpdated', 'pollCapturedAt', 'changedAt'] as const)('requires a valid %s timestamp with no fallback', (field) => {
    for (const bad of [null, undefined, '', 'yesterday', '2026-02-30T04:00:00Z', '2026-10-15', '2026-10-15T04:00:00']) {
      expect(evaluate(quote(), { ...reference(), [field]: bad } as Reference, config(), NOW, 0n).take).toBe(false);
    }
  });

  it('accepts valid leap days and timestamp offsets', () => {
    expect(evaluate(quote(), reference({ upstreamLastUpdated: '2024-02-29T23:59:59.123456+05:30' }), config(), NOW, 0n).take).toBe(true);
  });

  it('requires minimum remaining expiry time, including the exact boundary without flooring now', () => {
    const q = quote({ expiry: new Date(NOW + 30_000).toISOString() });
    const exact = evaluate(q, reference(), config(), NOW, 0n);
    expect(exact.take).toBe(true);
    expect(exact.secondsLeft).toBe(30);
    const short = evaluate(q, reference(), config(), NOW + 1, 0n);
    expect(short.take).toBe(false);
    expect(short.secondsLeft).toBe(29.999);
    expect(evaluate(quote({ expiry: new Date(NOW).toISOString() }), reference(), config(), NOW, 0n).take).toBe(false);
    expect(evaluate(q, reference(), config({ minSecondsLeft: 0.5 }), NOW + 29500, 0n).take).toBe(true);
  });

  it.each([
    '2026-10-15T12:01:00Z',
    '2026-10-15T12:01:00.000Z',
    '2026-10-15T17:31:00+05:30',
    '2026-10-15T07:01:00-05:00',
  ])('reads SDK ISO expiry %s as epoch milliseconds', (expiry) => {
    const decision = evaluate(quote({ expiry }), reference(), config(), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.secondsLeft).toBe(60);
  });

  it('keeps fractional ISO expiry milliseconds for the exact threshold check', () => {
    const q = quote({ expiry: '2026-10-15T12:00:30.001Z' });
    expect(evaluate(q, reference(), config(), NOW + 1, 0n).take).toBe(true);
    expect(evaluate(q, reference(), config(), NOW + 2, 0n).take).toBe(false);
  });
});

describe('house-taker full-size cap and fail-closed gates', () => {
  it('takes the entire remainder at exact cap equality and includes existing reservations', () => {
    const decision = evaluate(quote(), reference(), config({ capUSDC: '15' }), NOW, 5000000n);
    expect(decision.take).toBe(true);
    expect(decision.stakeWei6).toBe('10000000');
    expect(decision.remainingCapWei6).toBe('10000000');
  });

  it('never clips a full-size take, and reports the excess over actual remaining cap', () => {
    const decision = evaluate(quote(), reference(), config({ capUSDC: '15' }), NOW, 5000001n);
    expect(decision.take).toBe(false);
    expect(decision.stakeWei6).toBe('10000000');
    expect(decision.remainingCapWei6).toBe('9999999');
    expect(decision.reason).toBe('would exceed the cap by 0.000001 USDC');
  });

  it('reports true total excess even when prior spend is already above the cap', () => {
    const decision = evaluate(quote(), reference(), config({ capUSDC: '15' }), NOW, 16000000n);
    expect(decision.take).toBe(false);
    expect(decision.remainingCapWei6).toBe('0');
    expect(decision.reason).toBe('would exceed the cap by 11 USDC');
  });

  it('calculates the taker stake rather than applying the cap to maker risk', () => {
    const q = quote({ makerOddsTick: 150 });
    const decision = evaluate(q, reference(), config({ capUSDC: '5' }), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.stakeWei6).toBe('5000000');
    const tooLarge = evaluate(quote({ makerOddsTick: 300 }), reference({ homeOddsAmerican: -200 }), config({ capUSDC: '10' }), NOW, 0n);
    expect(tooLarge.take).toBe(false);
    expect(tooLarge.stakeWei6).toBe('20000000');
    expect(tooLarge.reason).toBe('would exceed the cap by 10 USDC');
  });

  it('accepts a one-wei6 taker stake when the maker has one valid lot', () => {
    const decision = evaluate(quote({ makerOddsTick: 101, remainingMakerWei6: '100' }), reference(), config({ capUSDC: '0.000001' }), NOW, 0n);
    expect(decision.take).toBe(true);
    expect(decision.stakeWei6).toBe('1');
  });

  it('retains integer precision above MAX_SAFE_INTEGER for stake, cap, and excess', () => {
    const q = quote({ remainingMakerWei6: '9007199254740993100', makerOddsTick: 201 });
    const fullStake = 9007199254740993100n * 101n / 100n;
    const cfg = config({ distancePp: 1, capUSDC: formatUSDC(fullStake + 17n) });
    expect(evaluate(q, reference(), cfg, NOW, 17n).take).toBe(true);
    const failed = evaluate(q, reference(), cfg, NOW, 18n);
    expect(failed.take).toBe(false);
    expect(failed.stakeWei6).toBe(fullStake.toString());
    expect(failed.reason).toBe('would exceed the cap by 0.000001 USDC');
  });

  it('enforces allowlist, house exclusion, and self-exclusion case-insensitively', () => {
    expect(evaluate(quote({ maker: `0x${'AB'.repeat(20)}` }), reference(), config(), NOW, 0n).take).toBe(true);
    for (const maker of [OTHER, HOUSE, `0x${'CD'.repeat(20)}`, WALLET]) {
      expect(evaluate(quote({ maker }), reference(), config(), NOW, 0n).take).toBe(false);
    }
    const overlap = config();
    overlap.makers.push({ address: HOUSE, label: 'Unsafe overlap', controller: 'House' });
    expect(evaluate(quote({ maker: HOUSE }), reference(), overlap, NOW, 0n).take).toBe(false);
    const self = config();
    self.makers.push({ address: WALLET, label: 'Self', controller: 'House' });
    expect(evaluate(quote({ maker: WALLET }), reference(), self, NOW, 0n).take).toBe(false);
  });

  it.each([
    { hash: '' }, { hash: 'not-a-hash' }, { hash: `0x${'a'.repeat(64)}\n` },
    { maker: '0x123' }, { maker: `${MAKER}\n` }, { contestId: '' },
    { market: 'unknown' }, { makerSide: 2 }, { makerSide: '0' },
    { makerOddsTick: 100 }, { makerOddsTick: 10101 }, { makerOddsTick: 200.5 },
    { makerOddsTick: NaN }, { makerOddsTick: Infinity }, { makerOddsTick: '200' },
    { lineTicks: NaN }, { lineTicks: 0.1 }, { lineTicks: 2 ** 31 },
    { remainingMakerWei6: '0' }, { remainingMakerWei6: '-100' },
    { remainingMakerWei6: '101' }, { remainingMakerWei6: '99' },
    { remainingMakerWei6: '1.00' }, { remainingMakerWei6: '1e6' },
    { remainingMakerWei6: '0100' }, { remainingMakerWei6: ' 100' }, { remainingMakerWei6: '100\n' },
    { remainingMakerWei6: 100 }, { remainingMakerWei6: (2n ** 256n).toString() },
    { expiry: '' }, { expiry: 'abc' }, { expiry: '-1' }, { expiry: '1.5' },
    { expiry: String(NOW / 1_000 + 60) }, { expiry: String(NOW + 60_000) },
    { expiry: '2026-02-30T12:01:00Z' }, { expiry: '2026-10-15T12:01:00' },
    { expiry: '2026-10-15' }, { expiry: (2n ** 256n).toString() },
  ])('refuses malformed quote fields without throwing: %j', (bad) => {
    const decision = evaluate({ ...quote(), ...bad } as Quote, reference(), config(), NOW, 0n);
    expect(decision.take).toBe(false);
    expect(decision.reason).not.toBe('');
  });

  it.each([null, undefined, {}, [], 'quote'])('refuses malformed quote objects: %j', (bad) => {
    expect(evaluate(bad as Quote, reference(), config(), NOW, 0n).take).toBe(false);
  });

  it.each([null, undefined, {}, [], 'reference'])('refuses missing or malformed reference objects: %j', (bad) => {
    expect(evaluate(quote(), bad as Reference, config(), NOW, 0n).take).toBe(false);
  });

  it.each([undefined, null, 0, NaN, Infinity, '100'])('refuses missing or malformed exact bettor price %s', (homeOddsAmerican) => {
    expect(evaluate(quote(), { ...reference(), homeOddsAmerican } as Reference, config(), NOW, 0n).take).toBe(false);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid current millisecond clock %s', (nowMs) => {
    expect(evaluate(quote(), reference(), config(), nowMs, 0n).take).toBe(false);
  });

  it.each([-1n, 0, '0', null])('refuses invalid spend/reservation units %s', (spent) => {
    expect(evaluate(quote(), reference(), config(), NOW, spent as bigint).take).toBe(false);
  });

  it('fails closed on malformed config even if parseConfig was bypassed', () => {
    expect(evaluate(quote(), reference(), config({ distancePp: NaN }), NOW, 0n).take).toBe(false);
    expect(evaluate(quote(), reference(), config({ capUSDC: '1e9' }), NOW, 0n).take).toBe(false);
    expect(evaluate(quote(), reference(), null as unknown as TakerConfig, NOW, 0n).take).toBe(false);
  });

  it('does not mutate input data or depend on wall-clock time', () => {
    const q = quote();
    const r = reference();
    const c = config();
    const before = JSON.stringify({ q, r, c });
    const a = evaluate(q, r, c, NOW, 0n);
    expect(evaluate(q, r, c, NOW, 0n)).toEqual(a);
    expect(JSON.stringify({ q, r, c })).toBe(before);
  });
});
