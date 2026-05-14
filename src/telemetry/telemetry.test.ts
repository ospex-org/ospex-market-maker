import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANDIDATE_SKIP_REASONS, EventLog, eventLogsExist, listRunLogs, newRunId, summarize, TELEMETRY_KINDS, type TelemetryKind } from './index.js';

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('EventLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-telemetry-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one NDJSON line per emit, in order, each with ts / runId / kind + the payload', () => {
    const log = EventLog.open(dir, 'test-run');
    expect(log.path).toBe(join(dir, 'run-test-run.ndjson'));
    log.emit('tick-start', { tick: 1 });
    log.emit('fill', { hash: '0xabc', riskWei6: '1000000', side: 'away' });

    const lines = readLines(log.path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ runId: 'test-run', kind: 'tick-start', tick: 1 });
    expect(typeof lines[0]?.ts).toBe('string');
    expect(lines[1]).toMatchObject({ runId: 'test-run', kind: 'fill', hash: '0xabc', riskWei6: '1000000', side: 'away' });
    // wei6 amounts stay strings, never re-numbered
    expect(lines[1]?.riskWei6).toBe('1000000');
  });

  it('appends across multiple EventLog handles on the same path', () => {
    const a = EventLog.open(dir, 'r');
    a.emit('tick-start');
    const b = EventLog.open(dir, 'r');
    b.emit('kill');
    expect(readLines(a.path).map((l) => l.kind)).toEqual(['tick-start', 'kill']);
  });

  it('rejects a runId that is not filename-safe (no path separators / dot-segments / spaces)', () => {
    expect(() => EventLog.open(dir, 'x/../../escape')).toThrow(/filename-safe/);
    expect(() => EventLog.open(dir, '..')).toThrow(/filename-safe/);
    expect(() => EventLog.open(dir, '')).toThrow(/filename-safe/);
    expect(() => EventLog.open(dir, 'has space')).toThrow(/filename-safe/);
    expect(() => EventLog.open(dir, newRunId())).not.toThrow();
  });

  it('rejects an unknown event kind (fail closed — the kind vocabulary is a stable contract)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('not-a-kind' as TelemetryKind)).toThrow(/unknown event kind/);
  });

  it('rejects a payload that shadows a reserved key (ts / runId / kind)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('error', { ts: 'spoofed' })).toThrow(/reserved key "ts"/);
    expect(() => log.emit('error', { runId: 'spoofed' })).toThrow(/reserved key "runId"/);
    expect(() => log.emit('error', { kind: 'spoofed' })).toThrow(/reserved key "kind"/);
  });

  it('rejects payload values JSON.stringify would drop / mangle / lose precision on (fail closed — stable wire contract)', () => {
    const log = EventLog.open(dir, 'r');
    // bigint — the AGENT_CONTRACT numeric rule (stringify wei6 first)
    expect(() => log.emit('fill', { riskWei6: 1_000_000n })).toThrow(/bigint/);
    expect(() => log.emit('fill', { nested: { riskWei6: 5n } })).toThrow(/bigint/);
    expect(() => log.emit('fill', { amounts: ['0', 7n] })).toThrow(/bigint/);
    // non-finite numbers — would serialize to null
    expect(() => log.emit('fair-value', { p: Number.NaN })).toThrow(/NaN|finite/);
    expect(() => log.emit('fair-value', { p: Number.POSITIVE_INFINITY })).toThrow(/Infinity|finite/);
    // an integer beyond Number.MAX_SAFE_INTEGER — loses precision; emit it as a decimal string
    expect(() => log.emit('fill', { blockNumber: 2 ** 53 })).toThrow(/MAX_SAFE_INTEGER|decimal string/);
    // undefined / function / symbol — dropped or nulled by JSON.stringify
    expect(() => log.emit('error', { detail: undefined })).toThrow(/undefined|JSON-representable/);
    expect(() => log.emit('error', { fn: () => 1 })).toThrow(/function|JSON-representable/);
    expect(() => log.emit('error', { s: Symbol('x') })).toThrow(/symbol|JSON-representable/);
    // non-plain objects — Map / Date / Error / class instances: JSON.stringify loses or mangles them
    expect(() => log.emit('error', { m: new Map() })).toThrow(/Map|non-plain|flatten/);
    expect(() => log.emit('degraded', { since: new Date() })).toThrow(/Date|non-plain|flatten/);
    expect(() => log.emit('error', { caught: new Error('boom') })).toThrow(/Error|non-plain|flatten/);
  });

  it('rejects a payload that is not a plain object', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('error', 'oops' as unknown as Record<string, unknown>)).toThrow(/payload must be a plain object/);
    expect(() => log.emit('error', [1, 2] as unknown as Record<string, unknown>)).toThrow(/payload must be a plain object/);
    expect(() => log.emit('error', new Map() as unknown as Record<string, unknown>)).toThrow(/payload must be a plain object/);
  });

  it('accepts ordinary JSON-able payloads (strings, numbers, nested objects, arrays)', () => {
    const log = EventLog.open(dir, 'r');
    log.emit('quote-intent', { side: 'home', oddsTick: 191, sizeUSDC: 0.25, sizes: ['100', '200'], meta: { spread: 0.01 } });
    expect(readLines(log.path)[0]).toMatchObject({ kind: 'quote-intent', side: 'home', oddsTick: 191, sizeUSDC: 0.25, sizes: ['100', '200'], meta: { spread: 0.01 } });
  });
});

describe('eventLogsExist', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ospex-mm-eventlogs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false for a non-existent directory', () => {
    expect(eventLogsExist(join(dir, 'does-not-exist'))).toBe(false);
  });
  it('is false for an empty directory or one with no run-*.ndjson files', () => {
    expect(eventLogsExist(dir)).toBe(false);
    writeFileSync(join(dir, 'notes.txt'), 'hi', 'utf8');
    writeFileSync(join(dir, 'config.json'), '{}', 'utf8');
    expect(eventLogsExist(dir)).toBe(false);
  });
  it('is true once an EventLog has written a line', () => {
    const log = EventLog.open(dir, 'somerun');
    log.emit('tick-start');
    expect(eventLogsExist(dir)).toBe(true);
  });
});

describe('newRunId', () => {
  it('is filename-safe (no ":" or "."), roughly time-sortable, and unique across calls', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toMatch(/[:.]/);
    expect(a).not.toBe(b);
    // ISO-ish prefix, sortable as a string
    expect(a.slice(0, 4)).toMatch(/^\d{4}$/);
  });
});

describe('vocabulary', () => {
  it('TELEMETRY_KINDS covers the DESIGN §11 kinds', () => {
    for (const k of ['tick-start', 'candidate', 'fair-value', 'risk-verdict', 'would-submit', 'soft-cancel', 'approval', 'fill', 'degraded', 'kill'] as const) {
      expect(TELEMETRY_KINDS).toContain(k);
    }
  });
  it('CANDIDATE_SKIP_REASONS covers the DESIGN §11 skip reasons', () => {
    for (const r of ['no-reference-odds', 'no-open-speculation', 'would-create-lazy-speculation', 'cap-hit', 'gas-budget-blocks-reapproval'] as const) {
      expect(CANDIDATE_SKIP_REASONS).toContain(r);
    }
  });
});

describe('listRunLogs', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ospex-mm-listlogs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the run-*.ndjson files, sorted; other files ignored', () => {
    writeFileSync(join(dir, 'run-b.ndjson'), '', 'utf8');
    writeFileSync(join(dir, 'run-a.ndjson'), '', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'hi', 'utf8');
    writeFileSync(join(dir, 'run-a.ndjson.bak'), '', 'utf8'); // not `run-*.ndjson`
    expect(listRunLogs(dir)).toEqual([join(dir, 'run-a.ndjson'), join(dir, 'run-b.ndjson')]);
  });
  it('returns [] for a non-existent directory and for an empty one', () => {
    expect(listRunLogs(join(dir, 'nope'))).toEqual([]);
    expect(listRunLogs(dir)).toEqual([]);
  });
});

describe('summarize', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ospex-mm-summarize-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Write an NDJSON log; if a line has no `ts`, it gets a monotonic default (1s apart from `1_900_000_000_000`) so the walk sees events in order. */
  function writeLog(name: string, events: Array<{ kind: string; ts?: string } & Record<string, unknown>>): string {
    const path = join(dir, name);
    const lines = events.map((e, i) => {
      const { kind, ts, ...payload } = e;
      return JSON.stringify({ ts: ts ?? new Date(1_900_000_000_000 + (i + 1) * 1000).toISOString(), runId: 'r1', kind, ...payload });
    });
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    return path;
  }

  it('an empty input yields an all-zero summary', () => {
    const s = summarize([]);
    expect(s).toMatchObject({
      schemaVersion: 1,
      sources: [],
      lines: 0,
      malformedLines: 0,
      runIds: [],
      firstEventAt: null,
      lastEventAt: null,
      ticks: 0,
      candidates: { total: 0, tracked: 0, skipReasons: {} },
      quoteIntents: { total: 0, canQuote: 0, refused: 0 },
      wouldSubmit: 0,
      wouldReplace: { total: 0, byReason: {} },
      wouldSoftCancel: { total: 0, byReason: {} },
      expired: 0,
      quoteCompetitiveness: { samples: 0, atOrInsideBookCount: 0, atOrInsideBookRate: null, vsReferenceTicks: null, unavailable: 0 },
      quoteAgeSeconds: null,
      latentExposurePeakWei6: '0',
      staleQuoteIncidents: 0,
      degradedByReason: {},
      errors: { total: 0, byPhase: {} },
      kill: null,
      liveMetrics: {
        fills: { quotedUsdcWei6: '0', filledUsdcWei6: '0', fillRate: null },
        gas: { totalPolWei: '0', byKind: { approval: '0', onchainCancel: '0', settle: '0', claim: '0' }, totalUsdcEquivWei6: null },
        settlements: { settleCount: 0, claimCount: 0, totalClaimedPayoutWei6: '0' },
        realizedPnl: { netUsdcWei6: '0', claimedProfitUsdcWei6: '0', realizedLossUsdcWei6: '0', wonCount: 0, lostCount: 0, pushCount: 0, wonUnclaimedCount: 0, unsettledCount: 0 },
        totalFeeUsdcWei6: '0',
      },
    });
    expect(s.eventCounts['tick-start']).toBe(0);
    expect(s.eventCounts['would-submit']).toBe(0);
    expect(Object.keys(s.eventCounts).sort()).toEqual([...TELEMETRY_KINDS].sort()); // zero-filled for every known kind, nothing extra
    expect(typeof s.generatedAt).toBe('string');
  });

  it('counts the dry-run metrics from a realistic log (candidates, quote-intents, would-* by reason, competitiveness, stale incidents, degraded, errors, kill, the latent-exposure peak, quote ages)', () => {
    const path = writeLog('run-r1.ndjson', [
      { kind: 'tick-start', tick: 1 },
      { kind: 'candidate', contestId: 'A', sport: 'mlb', matchTime: '2099-01-01T00:00:00Z', speculationId: 'spec-A' }, // tracked
      { kind: 'candidate', contestId: 'B', skipReason: 'no-reference-odds' },
      { kind: 'candidate', contestId: 'C', skipReason: 'start-too-soon' },
      { kind: 'candidate', contestId: 'D', skipReason: 'stale-reference' },
      { kind: 'quote-intent', contestId: 'A', speculationId: 'spec-A', canQuote: true, away: { oddsTick: 198 }, home: { oddsTick: 196 }, notes: [] },
      { kind: 'quote-competitiveness', contestId: 'A', speculationId: 'spec-A', side: 'away', quoteTick: 198, quoteProb: 0.505, referenceTick: 191, referenceProb: 0.524, vsReferenceTicks: 7, bookDepthOnSide: 0, bestBookTick: null, atOrInsideBook: true },
      { kind: 'quote-competitiveness', contestId: 'A', speculationId: 'spec-A', side: 'home', quoteTick: 196, quoteProb: 0.51, referenceTick: 191, referenceProb: 0.524, vsReferenceTicks: 5, bookDepthOnSide: 1, bestBookTick: 150, atOrInsideBook: false },
      { kind: 'would-submit', commitmentHash: 'dry:r1:1', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', oddsTick: 198, riskAmountWei6: '250000', expiryUnixSec: 1_900_000_120 },
      { kind: 'would-submit', commitmentHash: 'dry:r1:2', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', oddsTick: 196, riskAmountWei6: '250000', expiryUnixSec: 1_900_000_120 },
      { kind: 'quote-intent', contestId: 'B', speculationId: 'spec-B', canQuote: false, away: null, home: null, notes: ['REFUSE: …'] },
      { kind: 'competitiveness-unavailable', contestId: 'A', speculationId: 'spec-A', reason: 'orderbook-not-populated' },
      { kind: 'tick-start', tick: 2 },
      { kind: 'would-soft-cancel', commitmentHash: 'dry:r1:1', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', oddsTick: 198, reason: 'side-not-quoted' },
      { kind: 'would-replace', replacedCommitmentHash: 'dry:r1:2', newCommitmentHash: 'dry:r1:3', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', reason: 'stale', fromOddsTick: 196, toOddsTick: 197, riskAmountWei6: '300000', expiryUnixSec: 1_900_000_240 },
      { kind: 'expire', commitmentHash: 'dry:r1:1', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', oddsTick: 198 },
      { kind: 'degraded', contestId: 'A', referenceGameId: 'GAME-A', reason: 'channel-error', detail: 'boom' },
      { kind: 'error', class: 'TypeError', detail: 'oops', phase: 'reconcile', contestId: 'A' },
      { kind: 'kill', reason: 'kill-file', ticks: 2 },
    ]);
    const s = summarize([path]);
    expect(s.sources).toEqual([path]);
    expect(s.runIds).toEqual(['r1']);
    expect(s.lines).toBe(19);
    expect(s.malformedLines).toBe(0);
    expect(s.ticks).toBe(2);
    expect(s.candidates).toMatchObject({ total: 4, tracked: 1, skipReasons: { 'no-reference-odds': 1, 'start-too-soon': 1, 'stale-reference': 1 } });
    expect(s.quoteIntents).toEqual({ total: 2, canQuote: 1, refused: 1 });
    expect(s.wouldSubmit).toBe(2);
    expect(s.wouldReplace).toEqual({ total: 1, byReason: { stale: 1 } });
    expect(s.wouldSoftCancel).toEqual({ total: 1, byReason: { 'side-not-quoted': 1 } });
    expect(s.expired).toBe(1);
    expect(s.quoteCompetitiveness).toMatchObject({ samples: 2, atOrInsideBookCount: 1, atOrInsideBookRate: 0.5, unavailable: 1 });
    expect(s.quoteCompetitiveness.vsReferenceTicks).toEqual({ min: 5, p50: 5, mean: 6, max: 7 });
    expect(s.staleQuoteIncidents).toBe(2); // candidate[stale-reference] + would-replace[stale]
    expect(s.degradedByReason).toEqual({ 'channel-error': 1 });
    expect(s.errors).toEqual({ total: 1, byPhase: { reconcile: 1 } });
    expect(s.kill).toEqual({ reason: 'kill-file', ticks: 2 });
    expect(s.eventCounts).toMatchObject({ 'tick-start': 2, candidate: 4, 'quote-intent': 2, 'quote-competitiveness': 2, 'competitiveness-unavailable': 1, 'would-submit': 2, 'would-replace': 1, 'would-soft-cancel': 1, expire: 1, degraded: 1, error: 1, kill: 1, 'risk-verdict': 0, fill: 0 });
    // latent-exposure: +250000 (dry:r1:1) → +250000 (dry:r1:2) = 500000 peak → soft-cancel dry:r1:1 (stays latent) → would-replace: dry:r1:2 stays + new dry:r1:3 +300000 = 800000 peak → expire dry:r1:1 −250000 = 550000.
    expect(s.latentExposurePeakWei6).toBe('800000');
    // quote ages: dry:r1:1 submitted then soft-cancelled 5s later; dry:r1:2 submitted then replaced-of 5s later; dry:r1:3 never terminal'd → not recorded.
    expect(s.quoteAgeSeconds).toEqual({ samples: 2, p50: 5, p90: 5, max: 5 });
    expect(typeof s.firstEventAt).toBe('string');
    expect(typeof s.lastEventAt).toBe('string');
  });

  it('counts malformed lines and skips them; blank lines are ignored, not counted', () => {
    const path = join(dir, 'run-m.ndjson');
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: '2030-01-01T00:00:00Z', runId: 'r1', kind: 'tick-start', tick: 1 }), // valid
        'not json at all', // not JSON → malformed
        '[1, 2, 3]', // JSON but not an object → malformed
        JSON.stringify({ runId: 'r1', kind: 'tick-start' }), // no `ts` → malformed
        JSON.stringify({ ts: 'not-a-timestamp', runId: 'r1', kind: 'tick-start' }), // unparseable `ts` → malformed
        JSON.stringify({ ts: '2030-01-01T00:00:01Z', runId: 'r1', kind: 42 }), // `kind` not a string → malformed
        '   ', // blank → ignored
        JSON.stringify({ ts: '2030-01-01T00:00:02Z', runId: 'r1', kind: 'tick-start', tick: 2 }), // valid
      ].join('\n') + '\n',
      'utf8',
    );
    const s = summarize([path]);
    expect(s.lines).toBe(2);
    expect(s.malformedLines).toBe(5);
    expect(s.ticks).toBe(2);
  });

  it('--since filters events to those at/after the timestamp', () => {
    const path = join(dir, 'run-s.ndjson');
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: '2030-01-01T00:00:00Z', runId: 'r1', kind: 'tick-start', tick: 1 }),
        JSON.stringify({ ts: '2030-01-01T00:00:00Z', runId: 'r1', kind: 'would-submit', commitmentHash: 'h1', riskAmountWei6: '100000' }),
        JSON.stringify({ ts: '2030-01-01T01:00:00Z', runId: 'r1', kind: 'tick-start', tick: 2 }),
        JSON.stringify({ ts: '2030-01-01T01:00:00Z', runId: 'r1', kind: 'would-submit', commitmentHash: 'h2', riskAmountWei6: '200000' }),
      ].join('\n') + '\n',
      'utf8',
    );
    expect(summarize([path])).toMatchObject({ lines: 4, ticks: 2, wouldSubmit: 2 });
    expect(summarize([path], { sinceIso: '2030-01-01T00:30:00Z' })).toMatchObject({ lines: 2, ticks: 1, wouldSubmit: 1 });
  });

  it('--since rejects a malformed timestamp', () => {
    expect(() => summarize([], { sinceIso: 'not-a-timestamp' })).toThrow(/ISO-8601/);
  });

  it('aggregates multiple log files — distinct runIds, merged + ts-sorted', () => {
    const a = join(dir, 'run-aa.ndjson');
    const b = join(dir, 'run-bb.ndjson');
    writeFileSync(a, JSON.stringify({ ts: '2030-01-01T00:00:00Z', runId: 'aa', kind: 'tick-start', tick: 1 }) + '\n', 'utf8');
    writeFileSync(b, JSON.stringify({ ts: '2030-01-02T00:00:00Z', runId: 'bb', kind: 'tick-start', tick: 1 }) + '\n', 'utf8');
    const s = summarize([a, b]);
    expect(s.sources).toEqual([a, b]);
    expect(s.runIds).toEqual(['aa', 'bb']);
    expect(s.ticks).toBe(2);
    expect(s.firstEventAt).toBe('2030-01-01T00:00:00Z');
    expect(s.lastEventAt).toBe('2030-01-02T00:00:00Z');
  });

  // ── live-mode metrics (Phase 3 g-i) ─────────────────────────────────────────

  describe('liveMetrics', () => {
    it('walks `submit` + `replace` for quoted USDC and `fill` for filled USDC; computes fillRate', () => {
      const path = writeLog('run-live.ndjson', [
        { kind: 'submit', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', oddsTick: 191, riskAmountWei6: '500000' }, // 0.5 USDC quoted
        { kind: 'submit', commitmentHash: '0xb', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', oddsTick: 196, riskAmountWei6: '300000' }, // 0.3 USDC quoted
        { kind: 'replace', replacedCommitmentHash: '0xb', newCommitmentHash: '0xc', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', reason: 'mispriced', riskAmountWei6: '400000' }, // 0.4 USDC quoted (replacement)
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '200000', filledRiskWei6: '200000', partial: true }, // 0.2 USDC filled
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '300000', filledRiskWei6: '500000', partial: false }, // 0.3 USDC filled
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.fills).toEqual({
        quotedUsdcWei6: '1200000', // 0.5 + 0.3 + 0.4
        filledUsdcWei6: '500000', //  0.2 + 0.3
        fillRate: 500000 / 1200000,
      });
    });

    it('fillRate is null when nothing was quoted (division-by-zero guard)', () => {
      const path = writeLog('run-empty.ndjson', [
        { kind: 'fill', source: 'position-poll', positionId: 'p1', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '100000' }, // a stale-payload fill the maker didn't quote in this window
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.fills.quotedUsdcWei6).toBe('0');
      expect(s.liveMetrics.fills.filledUsdcWei6).toBe('100000');
      expect(s.liveMetrics.fills.fillRate).toBeNull();
    });

    it('sums `gasPolWei` across `approval` / `onchain-cancel` / `settle` / `claim` events into per-kind + total POL wei18', () => {
      const path = writeLog('run-gas.ndjson', [
        { kind: 'approval', purpose: 'positionModule', spender: '0xPM', currentAllowance: '0', requiredAggregateAllowance: '5000000', amountSetTo: '5000000', txHash: '0xtx1', gasPolWei: '3000000000000000' }, // 0.003 POL
        { kind: 'onchain-cancel', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', txHash: '0xtx2', gasPolWei: '2500000000000000' }, // 0.0025 POL
        { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx3', gasPolWei: '4000000000000000' }, // 0.004 POL
        { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '2000000', txHash: '0xtx4', gasPolWei: '6000000000000000' }, // 0.006 POL
        { kind: 'claim', speculationId: 'spec-B', contestId: 'B', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '1500000', txHash: '0xtx5', gasPolWei: '6000000000000000' }, // 0.006 POL
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.gas.byKind).toEqual({
        approval: '3000000000000000',
        onchainCancel: '2500000000000000',
        settle: '4000000000000000',
        claim: '12000000000000000', // 2 claims × 0.006 POL
      });
      expect(s.liveMetrics.gas.totalPolWei).toBe('21500000000000000'); // sum of the above (0.0215 POL)
      expect(s.liveMetrics.gas.totalUsdcEquivWei6).toBeNull(); // no rate supplied
    });

    it('populates `gas.totalUsdcEquivWei6` when `polToUsdcRate` is supplied (CLI threads `config.gas.nativeTokenUSDCPrice`)', () => {
      const path = writeLog('run-gas-usdc.ndjson', [
        { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx', gasPolWei: '1000000000000000000' }, // 1 POL
      ]);
      const s = summarize([path], { polToUsdcRate: 0.42 }); // 1 POL ≈ 0.42 USDC
      expect(s.liveMetrics.gas.totalPolWei).toBe('1000000000000000000');
      expect(s.liveMetrics.gas.totalUsdcEquivWei6).toBe('420000'); // 0.42 USDC = 420_000 wei6
    });

    it('counts `settle` and `claim` events and sums `payoutWei6` across claims', () => {
      const path = writeLog('run-set.ndjson', [
        { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtxA' },
        { kind: 'settle', speculationId: 'spec-B', contestId: 'B', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'away', txHash: '0xtxB' },
        { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '2500000', txHash: '0xtxAc' }, // 2.5 USDC
        { kind: 'claim', speculationId: 'spec-B', contestId: 'B', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '1750000', txHash: '0xtxBc' }, // 1.75 USDC
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.settlements).toEqual({
        settleCount: 2,
        claimCount: 2,
        totalClaimedPayoutWei6: '4250000', // 2.5 + 1.75 = 4.25 USDC
      });
    });

    it('skips malformed `riskAmountWei6` / `newFillWei6` / `gasPolWei` / `payoutWei6` values (forward-compat: a future schema oddity does not corrupt the aggregate)', () => {
      const path = writeLog('run-malformed.ndjson', [
        { kind: 'submit', commitmentHash: '0xa', riskAmountWei6: 'NaN' }, // not a wei6 string
        { kind: 'submit', commitmentHash: '0xb', riskAmountWei6: '500000' }, // valid → counted
        { kind: 'fill', commitmentHash: '0xb', newFillWei6: -100 as unknown as string }, // not a wei6 string
        { kind: 'fill', commitmentHash: '0xb', newFillWei6: '200000' }, // valid → counted
        { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', makerSide: 'away', winSide: 'home', txHash: '0x', gasPolWei: 'not-a-number' }, // counted as 0 gas, but the settleCount still increments
        { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', makerSide: 'away', positionType: 0, payoutWei6: '-1', txHash: '0x' }, // negative wei6 → not counted
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.fills.quotedUsdcWei6).toBe('500000');
      expect(s.liveMetrics.fills.filledUsdcWei6).toBe('200000');
      expect(s.liveMetrics.gas.byKind.settle).toBe('0'); // gasPolWei was non-numeric, not summed
      expect(s.liveMetrics.settlements.settleCount).toBe(1); // count still incremented
      expect(s.liveMetrics.settlements.totalClaimedPayoutWei6).toBe('0'); // negative payout rejected
      expect(s.liveMetrics.settlements.claimCount).toBe(1); // claim still counted
    });

    it('a pure dry-run log produces zero live metrics (the live events are absent — confirms the new walker does not pick up `would-*` etc.)', () => {
      const path = writeLog('run-dry.ndjson', [
        { kind: 'would-submit', commitmentHash: 'dry:r1:1', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', makerSide: 'away', oddsTick: 198, riskAmountWei6: '250000', expiryUnixSec: 1_900_000_120 },
        { kind: 'would-soft-cancel', commitmentHash: 'dry:r1:1', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', reason: 'side-not-quoted' },
      ]);
      const s = summarize([path]);
      expect(s.liveMetrics.fills.quotedUsdcWei6).toBe('0');
      expect(s.liveMetrics.fills.filledUsdcWei6).toBe('0');
      expect(s.liveMetrics.settlements.settleCount).toBe(0);
      expect(s.liveMetrics.gas.totalPolWei).toBe('0');
    });

    // ── realized P&L (Phase 3 g-ii) ────────────────────────────────────────

    describe('realizedPnl', () => {
      it('won — claim event → profit = payout − cumulativeStake; positive contribution to net', () => {
        const path = writeLog('run-won.ndjson', [
          // 2 fills on spec-A:home totaling 0.5 USDC stake
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '200000' },
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '300000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '900000', txHash: '0xtxC' }, // 0.9 USDC payout
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(1);
        expect(r.lostCount).toBe(0);
        expect(r.pushCount).toBe(0);
        expect(r.unsettledCount).toBe(0);
        expect(r.wonUnclaimedCount).toBe(0);
        // payout 0.9 − stake 0.5 = +0.4 profit
        expect(r.claimedProfitUsdcWei6).toBe('400000');
        expect(r.realizedLossUsdcWei6).toBe('0');
        expect(r.netUsdcWei6).toBe('400000');
      });

      it('lost — settle.winSide ≠ makerSide, no claim → −stake contribution to net', () => {
        const path = writeLog('run-lost.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' }, // 0.5 USDC staked on away
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'home', txHash: '0xtx' }, // home won, away (maker's side) lost
          // no claim event — losing positions don't claim
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(0);
        expect(r.lostCount).toBe(1);
        expect(r.realizedLossUsdcWei6).toBe('500000');
        expect(r.netUsdcWei6).toBe('-500000'); // signed
        expect(r.claimedProfitUsdcWei6).toBe('0');
      });

      it('push — settle.winSide=push → P&L 0; stake refunded (no claim emitted, but stake is also not counted as loss)', () => {
        const path = writeLog('run-push.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'push', txHash: '0xtx' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
        expect(r.lostCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0');
      });

      it('wonUnclaimed — settle.winSide=makerSide but no claim in the window → count incremented, NO net P&L contribution (payout unknown until claim fires)', () => {
        const path = writeLog('run-paper.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx' },
          // no claim event yet — auto-claim either disabled, hasn't ticked, or threw
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.wonUnclaimedCount).toBe(1);
        expect(r.wonCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0'); // payout unknown — don't guess
      });

      it('unsettled — fills exist but no settle event → counted in unsettled (held over to unrealized P&L)', () => {
        const path = writeLog('run-open.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.unsettledCount).toBe(1);
        expect(r.wonCount + r.lostCount + r.pushCount + r.wonUnclaimedCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0');
      });

      it('a maker quoting BOTH sides of one contest: home wins → home position won (profit), away position lost (-stake); two independent positions tracked', () => {
        const path = writeLog('run-both-sides.ndjson', [
          // Maker on both sides of spec-A. Both sides get filled.
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xb', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          // Speculation settles: home wins. Runner emits a settle event from each position's perspective (auto-settle iterates state.positions); both carry winSide='home'.
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx1' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'home', txHash: '0xtx2' },
          // Only the home position claims (away lost — no claim).
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '900000', txHash: '0xtxC' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(1); // home
        expect(r.lostCount).toBe(1); // away
        expect(r.claimedProfitUsdcWei6).toBe('400000'); // 0.9 - 0.5 = 0.4 profit on home
        expect(r.realizedLossUsdcWei6).toBe('500000'); // 0.5 loss on away
        expect(r.netUsdcWei6).toBe('-100000'); // 0.4 - 0.5 = -0.1 net (the maker ate the spread the wrong way)
      });

      it('mixes the buckets: 1 won + 1 lost + 1 push + 1 unsettled', () => {
        const path = writeLog('run-mixed.ndjson', [
          // spec-A: won
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '100000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtxA' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '180000', txHash: '0xtxAc' }, // +0.08 profit
          // spec-B: lost
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xb', speculationId: 'spec-B', contestId: 'B', makerSide: 'away', newFillWei6: '200000' },
          { kind: 'settle', speculationId: 'spec-B', contestId: 'B', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'home', txHash: '0xtxB' }, // -0.2 loss
          // spec-C: push
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xc', speculationId: 'spec-C', contestId: 'C', makerSide: 'home', newFillWei6: '50000' },
          { kind: 'settle', speculationId: 'spec-C', contestId: 'C', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'push', txHash: '0xtxC' },
          // spec-D: unsettled (still open)
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xd', speculationId: 'spec-D', contestId: 'D', makerSide: 'home', newFillWei6: '300000' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(1);
        expect(r.lostCount).toBe(1);
        expect(r.pushCount).toBe(1);
        expect(r.unsettledCount).toBe(1);
        expect(r.wonUnclaimedCount).toBe(0);
        expect(r.claimedProfitUsdcWei6).toBe('80000'); // 0.18 - 0.10 = 0.08 profit
        expect(r.realizedLossUsdcWei6).toBe('200000'); // 0.2 loss
        expect(r.netUsdcWei6).toBe('-120000'); // 0.08 - 0.20 = -0.12 net
      });
    });
  });
});
