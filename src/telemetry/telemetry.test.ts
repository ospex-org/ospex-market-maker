import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANDIDATE_SKIP_REASONS, EventLog, eventLogsExist, newRunId, summarize, TELEMETRY_KINDS, type TelemetryKind } from './index.js';

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

describe('summarize', () => {
  it('is a Phase-3 stub — throws "not yet implemented"', () => {
    expect(() => summarize([])).toThrow(/not yet implemented/);
  });
});
