import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANDIDATE_SKIP_REASONS, EventLog, newRunId, summarize, TELEMETRY_KINDS, type TelemetryKind } from './index.js';

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

  it('rejects a bigint anywhere in the payload (the AGENT_CONTRACT numeric rule — stringify wei6 first)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('fill', { riskWei6: 1_000_000n })).toThrow(/bigint/);
    expect(() => log.emit('fill', { nested: { riskWei6: 5n } })).toThrow(/bigint/);
    expect(() => log.emit('fill', { amounts: ['0', 7n] })).toThrow(/bigint/);
  });

  it('accepts ordinary JSON-able payloads (strings, numbers, nested objects, arrays)', () => {
    const log = EventLog.open(dir, 'r');
    log.emit('quote-intent', { side: 'home', oddsTick: 191, sizeUSDC: 0.25, sizes: ['100', '200'], meta: { spread: 0.01 } });
    expect(readLines(log.path)[0]).toMatchObject({ kind: 'quote-intent', side: 'home', oddsTick: 191, sizeUSDC: 0.25, sizes: ['100', '200'], meta: { spread: 0.01 } });
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
