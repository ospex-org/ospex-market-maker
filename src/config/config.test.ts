import { describe, expect, it } from 'vitest';

import { loadConfig, parseConfig } from './index.js';

describe('parseConfig', () => {
  it('a minimal config (just rpcUrl) → all defaults applied', () => {
    const c = parseConfig({ rpcUrl: 'https://rpc.example' }, {});
    expect(c.rpcUrl).toBe('https://rpc.example');
    expect(c.apiUrl).toBeUndefined();
    expect(c.wallet.keystorePath).toBeUndefined();
    expect(c.chainId).toBe(137);
    expect(c.mode.dryRun).toBe(true);
    expect(c.pollIntervalMs).toBe(30_000);
    expect(c.marketSelection.markets).toEqual(['moneyline']);
    expect(c.marketSelection.sports).toEqual(['mlb']);
    expect(c.marketSelection.maxTrackedContests).toBe(30);
    expect(c.discovery.everyNTicks).toBe(10);
    expect(c.odds.subscribe).toBe(true);
    expect(c.pricing.mode).toBe('economics');
    expect(c.pricing.quoteBothSides).toBe(true);
    expect(c.pricing.economics.capitalUSDC).toBe(50);
    expect(c.pricing.economics.fillRateAssumption).toBe(0.3);
    expect(c.pricing.direct.spreadBps).toBe(300);
    expect(c.pricing.maxPerQuotePctOfCapital).toBe(0.05);
    expect(c.risk.bankrollUSDC).toBe(50);
    expect(c.risk.maxOpenCommitments).toBe(10);
    expect(c.risk.maxDailyFeeUSDC).toBe(0);
    expect(c.gas.maxDailyGasPOL).toBe(1);
    expect(c.approvals.autoApprove).toBe(false);
    expect(c.approvals.mode).toBe('exact');
    expect(c.orders.expiryMode).toBe('fixed-seconds');
    expect(c.orders.cancelMode).toBe('offchain');
    expect(c.settlement.autoSettleOwn).toBe(true);
    expect(c.telemetry.logLevel).toBe('info');
    expect(c.killSwitchFile).toBe('./KILL');
    expect(c.killCancelOnChain).toBe(false);
  });

  it('rpcUrl is required (here or via OSPEX_RPC_URL)', () => {
    expect(() => parseConfig({}, {})).toThrow(/rpcUrl/);
    expect(() => parseConfig({ rpcUrl: '   ' }, {})).toThrow(/rpcUrl/);
    expect(parseConfig({}, { OSPEX_RPC_URL: 'https://env-rpc' }).rpcUrl).toBe('https://env-rpc');
  });

  it('env overrides: OSPEX_CHAIN_ID / OSPEX_API_URL / OSPEX_KEYSTORE_PATH', () => {
    const c = parseConfig(
      { rpcUrl: 'https://rpc' },
      { OSPEX_CHAIN_ID: '80002', OSPEX_API_URL: 'https://api.example', OSPEX_KEYSTORE_PATH: '/keys/mm' },
    );
    expect(c.chainId).toBe(80002);
    expect(c.apiUrl).toBe('https://api.example');
    expect(c.wallet.keystorePath).toBe('/keys/mm');
  });

  it('rejects v0-unsupported markets and single-sided quoting', () => {
    expect(() => parseConfig({ rpcUrl: 'x', marketSelection: { markets: ['spread'] } }, {})).toThrow(/not supported in v0/);
    expect(() => parseConfig({ rpcUrl: 'x', marketSelection: { markets: ['moneyline', 'total'] } }, {})).toThrow(/not supported in v0/);
    expect(() => parseConfig({ rpcUrl: 'x', pricing: { quoteBothSides: false } }, {})).toThrow(/quoteBothSides/);
  });

  it('rejects out-of-range / mistyped values with a clear message', () => {
    expect(() => parseConfig({ rpcUrl: 'x', chainId: 999 }, {})).toThrow(/137/);
    expect(() => parseConfig({ rpcUrl: 'x', pricing: { maxPerQuotePctOfCapital: 2 } }, {})).toThrow(/maxPerQuotePctOfCapital/);
    expect(() => parseConfig({ rpcUrl: 'x', pricing: { economics: { fillRateAssumption: 0 } } }, {})).toThrow(/fillRateAssumption/);
    expect(() => parseConfig({ rpcUrl: 'x', risk: { bankrollUSDC: 'fifty' } }, {})).toThrow(/bankrollUSDC/);
    expect(() => parseConfig({ rpcUrl: 'x', risk: { maxOpenCommitments: 10.5 } }, {})).toThrow(/maxOpenCommitments/);
    expect(() => parseConfig({ rpcUrl: 'x', marketSelection: { sports: ['cricket'] } }, {})).toThrow(/not a known sport/);
    expect(() => parseConfig({ rpcUrl: 'x', approvals: { mode: 'whatever' } }, {})).toThrow(/approvals\.mode/);
    expect(() => parseConfig({ rpcUrl: 'x', mode: 'oops' }, {})).toThrow(/mode/);
    expect(() => parseConfig('not an object', {})).toThrow(/must be an object/);
    expect(() => parseConfig(undefined, {})).toThrow(/must be an object/);
  });

  it('accepts string-or-number amounts and partial sections (merging over defaults)', () => {
    const c = parseConfig(
      {
        rpcUrl: 'x',
        risk: { bankrollUSDC: '100', maxRiskPerCommitmentUSDC: 0.5 },
        mode: { dryRun: false },
        marketSelection: { sports: ['mlb', 'nba'] },
      },
      {},
    );
    expect(c.risk.bankrollUSDC).toBe(100);
    expect(c.risk.maxRiskPerCommitmentUSDC).toBe(0.5);
    expect(c.risk.maxRiskPerContestUSDC).toBe(1); // defaulted
    expect(c.risk.maxOpenCommitments).toBe(10); // defaulted
    expect(c.mode.dryRun).toBe(false);
    expect(c.marketSelection.sports).toEqual(['mlb', 'nba']);
    expect(c.marketSelection.markets).toEqual(['moneyline']); // defaulted
  });

  it('rejects unknown / misspelled keys at any level — fails closed so a mistyped cap cannot silently default', () => {
    expect(() => parseConfig({ rpcUrl: 'x', chainID: 80002 }, {})).toThrow(/chainID/);
    expect(() => parseConfig({ rpcUrl: 'x', risk: { maxRiskPerCommitmentUSD: '0.01' } }, {})).toThrow(/maxRiskPerCommitmentUSD\b/);
    expect(() => parseConfig({ rpcUrl: 'x', pricing: { maxPerQuotePctOfCapitol: 0.005 } }, {})).toThrow(/maxPerQuotePctOfCapitol/);
    expect(() => parseConfig({ rpcUrl: 'x', pricing: { economics: { capitolUSDC: 100 } } }, {})).toThrow(/capitolUSDC/);
    expect(() => parseConfig({ rpcUrl: 'x', totallyMadeUp: true }, {})).toThrow(/totallyMadeUp/);
    // a section parsed by YAML as a Date (e.g. `risk: 2024-01-01`) is rejected, not treated as `{}`
    expect(() => parseConfig({ rpcUrl: 'x', risk: new Date('2024-01-01') }, {})).toThrow(/risk.*must be an object/);
  });
});

describe('loadConfig', () => {
  it('the shipped ospex-mm.example.yaml is valid against the schema', () => {
    // The example ships with rpcUrl / apiUrl blank (the operator fills rpcUrl in);
    // supply rpcUrl via the env so we exercise the rest of the schema.
    const c = loadConfig('ospex-mm.example.yaml', { OSPEX_RPC_URL: 'https://rpc.example' });
    expect(c.rpcUrl).toBe('https://rpc.example');
    expect(c.apiUrl).toBeUndefined(); // blank in the example → uses the SDK default
    expect(c.chainId).toBe(137);
    expect(c.mode.dryRun).toBe(true);
    expect(c.pollIntervalMs).toBe(30_000);
    expect(c.marketSelection.sports).toEqual(['mlb']);
    expect(c.marketSelection.markets).toEqual(['moneyline']);
    expect(c.pricing.mode).toBe('economics');
    expect(c.pricing.economics.capitalUSDC).toBe(50);
    expect(c.risk.bankrollUSDC).toBe(50);
    expect(c.orders.expiryMode).toBe('fixed-seconds');
  });

  it('a missing config file throws a clear error', () => {
    expect(() => loadConfig('does-not-exist.yaml', { OSPEX_RPC_URL: 'x' })).toThrow(/could not read/);
  });
});
