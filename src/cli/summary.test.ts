import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import type { RunSummary } from '../telemetry/index.js';
import { renderSummaryReportJson, renderSummaryReportText, runSummary, summaryExitCode } from './summary.js';

// ── harness ──────────────────────────────────────────────────────────────────

let logDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'ospex-mm-cli-summary-'));
});
afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ rpcUrl: 'http://localhost:8545', telemetry: { logDir }, ...overrides });
}
function collect(): { sink: { write(s: string): void }; text: () => string } {
  let buf = '';
  return { sink: { write: (s: string) => { buf += s; } }, text: () => buf };
}
/** A plausible `RunSummary` for renderer / exit-code tests. */
function fakeSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    schemaVersion: 1,
    generatedAt: '2030-01-01T00:10:00.000Z',
    sources: [join(logDir, 'run-r1.ndjson')],
    lines: 12,
    malformedLines: 0,
    runIds: ['r1'],
    firstEventAt: '2030-01-01T00:00:00.000Z',
    lastEventAt: '2030-01-01T00:05:00.000Z',
    ticks: 5,
    eventCounts: { 'tick-start': 5, candidate: 3, 'quote-competitiveness': 2, 'would-submit': 2, expire: 1, fill: 0, 'risk-verdict': 0 },
    candidates: { total: 3, tracked: 1, skipReasons: { 'no-reference-odds': 2 } },
    quoteIntents: { total: 1, canQuote: 1, refused: 0 },
    wouldSubmit: 2,
    wouldReplace: { total: 0, byReason: {} },
    wouldSoftCancel: { total: 1, byReason: { 'side-not-quoted': 1 } },
    expired: 1,
    quoteCompetitiveness: { samples: 2, atOrInsideBookCount: 1, atOrInsideBookRate: 0.5, vsReferenceTicks: { min: 5, p50: 6, mean: 6, max: 7 }, unavailable: 0 },
    quoteAgeSeconds: { samples: 2, p50: 30, p90: 60, max: 60 },
    latentExposurePeakWei6: '500000',
    staleQuoteIncidents: 0,
    degradedByReason: {},
    errors: { total: 0, byPhase: {} },
    kill: { reason: 'kill-file', ticks: 5 },
    liveMetrics: {
      fills: { quotedUsdcWei6: '0', filledUsdcWei6: '0', fillRate: null },
      gas: { totalPolWei: '0', byKind: { approval: '0', onchainCancel: '0', settle: '0', claim: '0' }, totalUsdcEquivWei6: null },
      settlements: { settleCount: 0, claimCount: 0, totalClaimedPayoutWei6: '0' },
      totalFeeUsdcWei6: '0',
    },
    ...over,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('runSummary', () => {
  it('lists the run logs under config.telemetry.logDir and aggregates them; passes --since through', () => {
    const list = vi.fn((_dir: string) => [join(logDir, 'run-r1.ndjson')]);
    const summarized = fakeSummary();
    const aggregate = vi.fn(() => summarized);
    const result = runSummary({ config: cfg(), sinceIso: '2030-01-01T00:01:00Z' }, { listRunLogs: list, summarize: aggregate });
    expect(list).toHaveBeenCalledWith(logDir);
    // The CLI threads through both `sinceIso` AND `polToUsdcRate` — the latter from `config.gas.nativeTokenUSDCPrice` iff `config.gas.reportInUSDC: true` (the default).
    expect(aggregate).toHaveBeenCalledWith([join(logDir, 'run-r1.ndjson')], { sinceIso: '2030-01-01T00:01:00Z', polToUsdcRate: expect.any(Number) as unknown as number });
    expect(result).toBe(summarized);
  });

  it('passes an empty opts object to summarize when --since is not given (a no-USDC-equiv config supplies no polToUsdcRate either)', () => {
    const aggregate = vi.fn(() => fakeSummary({ sources: [] }));
    runSummary({ config: cfg({ gas: { reportInUSDC: false } }) }, { listRunLogs: () => [], summarize: aggregate });
    expect(aggregate).toHaveBeenCalledWith([], {}); // neither sinceIso nor polToUsdcRate
  });

  it('threads config.gas.nativeTokenUSDCPrice as polToUsdcRate when reportInUSDC:true', () => {
    const aggregate = vi.fn(() => fakeSummary());
    runSummary({ config: cfg({ gas: { reportInUSDC: true, nativeTokenUSDCPrice: 0.42 } }) }, { listRunLogs: () => [], summarize: aggregate });
    expect(aggregate).toHaveBeenCalledWith([], { polToUsdcRate: 0.42 });
  });

  it('omits polToUsdcRate when reportInUSDC:false', () => {
    const aggregate = vi.fn(() => fakeSummary());
    runSummary({ config: cfg({ gas: { reportInUSDC: false, nativeTokenUSDCPrice: 0.42 } }) }, { listRunLogs: () => [], summarize: aggregate });
    expect(aggregate).toHaveBeenCalledWith([], {});
  });

  it('with no stubs, summarizes the real run logs under config.telemetry.logDir', () => {
    writeFileSync(join(logDir, 'run-real.ndjson'), JSON.stringify({ ts: '2030-01-01T00:00:00Z', runId: 'real', kind: 'tick-start', tick: 1 }) + '\n', 'utf8');
    const s = runSummary({ config: cfg() });
    expect(s.sources).toEqual([join(logDir, 'run-real.ndjson')]);
    expect(s.runIds).toEqual(['real']);
    expect(s.ticks).toBe(1);
  });

  it('with no logs → an all-zero summary (sources empty)', () => {
    const s = runSummary({ config: cfg() });
    expect(s.sources).toEqual([]);
    expect(s.ticks).toBe(0);
    expect(s.latentExposurePeakWei6).toBe('0');
  });
});

describe('summaryExitCode', () => {
  it('is always 0 — a summary is a report, not a check', () => {
    expect(summaryExitCode(fakeSummary())).toBe(0);
    expect(summaryExitCode(fakeSummary({ errors: { total: 99, byPhase: { tick: 99 } }, malformedLines: 7 }))).toBe(0);
  });
});

describe('renderSummaryReport*', () => {
  it('JSON envelope is { schemaVersion: 1, summary: RunSummary }', () => {
    const { sink, text } = collect();
    renderSummaryReportJson(fakeSummary(), sink);
    const parsed = JSON.parse(text()) as { schemaVersion: number; summary: RunSummary };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.summary.ticks).toBe(5);
    expect(parsed.summary.latentExposurePeakWei6).toBe('500000');
    expect(parsed.summary.liveMetrics.fills.fillRate).toBeNull();
    expect(parsed.summary.liveMetrics.gas.totalPolWei).toBe('0');
  });

  it('text render shows the key sections', () => {
    const { sink, text } = collect();
    renderSummaryReportText(fakeSummary(), logDir, sink);
    const out = text();
    expect(out).toMatch(/^ospex-mm summary/);
    expect(out).toMatch(/ticks:\s+5/);
    expect(out).toContain('Candidates: 3 considered — 1 tracked, skipped: no-reference-odds=2');
    expect(out).toContain('at/inside the book 1/2 (50.0%)');
    expect(out).toContain('vs reference (ticks): min 5 / p50 6 / mean 6.0 / max 7');
    expect(out).toContain('Quote age (s) over 2 completed quote(s): p50 30 / p90 60 / max 60');
    expect(out).toContain('Latent-exposure peak: 0.500000 USDC (500000 wei6)');
    expect(out).toMatch(/Live-mode metrics:/);
    expect(out).toMatch(/no live activity/); // the fakeSummary has zero-valued live metrics
    expect(out).toMatch(/realized \+ unrealized P&L are still landing/);
    expect(out).toContain('Event counts:');
  });

  it('text render handles an empty summary (no logs found)', () => {
    const { sink, text } = collect();
    renderSummaryReportText(fakeSummary({ sources: [], runIds: [], lines: 0, ticks: 0, firstEventAt: null, lastEventAt: null }), logDir, sink);
    expect(text()).toContain(`No event logs found under ${logDir}`);
  });
});
