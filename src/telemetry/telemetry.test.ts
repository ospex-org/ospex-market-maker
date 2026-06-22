import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANDIDATE_SKIP_REASONS, EventLog, eventLogsExist, listRunLogs, marketTag, newRunId, summarize, TELEMETRY_KINDS, type TelemetryKind } from './index.js';

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('marketTag', () => {
  it('OMITS the market for moneyline (the unmarked default → byte-identical NDJSON)', () => {
    expect(marketTag('moneyline')).toEqual({});
  });
  it('carries the market for spread / total', () => {
    expect(marketTag('spread')).toEqual({ market: 'spread' });
    expect(marketTag('total')).toEqual({ market: 'total' });
  });
});

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

  it('rejects a payload that shadows a reserved key (ts / runId / kind / maker)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('error', { ts: 'spoofed' })).toThrow(/reserved key "ts"/);
    expect(() => log.emit('error', { runId: 'spoofed' })).toThrow(/reserved key "runId"/);
    expect(() => log.emit('error', { kind: 'spoofed' })).toThrow(/reserved key "kind"/);
    expect(() => log.emit('error', { maker: 'spoofed' })).toThrow(/reserved key "maker"/);
  });

  it('stamps the maker on every line when opened with one (lowercased); omits it otherwise', () => {
    const withMaker = EventLog.open(dir, 'live', '0xABCDEF0123456789abcdef0123456789ABCDEF01');
    withMaker.emit('tick-start');
    const line = JSON.parse(readFileSync(withMaker.path, 'utf8').trim()) as { maker?: string; kind: string };
    expect(line.maker).toBe('0xabcdef0123456789abcdef0123456789abcdef01'); // lowercased
    expect(line.kind).toBe('tick-start');

    const noMaker = EventLog.open(dir, 'dry');
    noMaker.emit('tick-start');
    expect('maker' in (JSON.parse(readFileSync(noMaker.path, 'utf8').trim()) as object)).toBe(false);
  });

  it('rejects a maker that is not a 0x-prefixed 40-hex address', () => {
    expect(() => EventLog.open(dir, 'r', 'not-an-address')).toThrow(/40-hex address/);
    expect(() => EventLog.open(dir, 'r', '0x123')).toThrow(/40-hex address/);
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

  // ── signing-material denylist (own-state SSE plan §M6/B) ───────────────────
  //
  // The MM persists the SDK's canonical `SignedCommitmentPayload` (M6/A) — the
  // same input `MatchingModule.matchCommitment` needs to fill a commitment. The
  // wire boundary fails closed on any payload key that could carry that bundle,
  // at any depth, so a careless `...record` spread of a `MakerCommitmentRecord`
  // is caught before it lands in the NDJSON event log (or the scorecard
  // artifact it feeds). The keys are exactly `signature` / `signedPayload` /
  // `commitment` / `nonce` — names like `commitmentHash` / `commitmentLifecycle`
  // / `nonceFloor` are unaffected (they don't carry signing material).
  it('rejects "signature" at the top level (a stray EIP-712 ECDSA signature)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('submit', { signature: '0x' + 'a'.repeat(130) })).toThrow(/signing-material/);
  });

  it('rejects "signedPayload" — the MakerSignedPayload wrapper itself', () => {
    const log = EventLog.open(dir, 'r');
    expect(() =>
      log.emit('submit', {
        commitmentHash: '0xabc',
        signedPayload: {
          commitmentHash: '0xabc',
          commitment: { maker: '0x1', contestId: '1', scorer: '0x2', lineTicks: 0, positionType: 0, oddsTick: 200, riskAmount: '1', nonce: '1', expiry: '1' },
          signature: '0xdead',
        },
      }),
    ).toThrow(/signing-material|signedPayload/);
  });

  it('rejects the bare "commitment" key (the inner EIP-712 typed-data struct)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() =>
      log.emit('submit', {
        commitment: { maker: '0x1', contestId: '1', scorer: '0x2', lineTicks: 0, positionType: 0, oddsTick: 200, riskAmount: '1', nonce: '1', expiry: '1' },
      }),
    ).toThrow(/signing-material|commitment/);
  });

  it('rejects "nonce" — the EIP-712 nonce, even as a flat top-level field', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('submit', { nonce: '42' })).toThrow(/signing-material|nonce/);
  });

  it('rejects denied keys nested inside an array of objects (not just direct child)', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('candidate', { records: [{ commitmentHash: '0xabc', signature: '0xdead' }] })).toThrow(/signing-material|signature/);
  });

  it('rejects denied keys nested inside an object multiple levels deep', () => {
    const log = EventLog.open(dir, 'r');
    expect(() => log.emit('error', { detail: { meta: { signedPayload: {} } } })).toThrow(/signing-material|signedPayload/);
  });

  it('does NOT reject "commitmentHash" / "commitmentLifecycle" / "nonceFloor" (substrings of denied keys)', () => {
    const log = EventLog.open(dir, 'r');
    // None of these should throw — they're the actual telemetry fields callers use.
    log.emit('submit', { commitmentHash: '0xabc', commitmentLifecycle: 'visibleOpen', nonceFloor: '5' });
    expect(readLines(log.path)[0]).toMatchObject({ kind: 'submit', commitmentHash: '0xabc', commitmentLifecycle: 'visibleOpen', nonceFloor: '5' });
  });

  it('rejects a denied key before reporting wire-safety errors on its nested value (the diagnostic points at the real bug)', () => {
    const log = EventLog.open(dir, 'r');
    // commitment.riskAmount is a bigint, which would normally trip the wire-safety check — but the
    // denied-key check runs first so the operator sees "signing-material" not "bigint".
    expect(() => log.emit('submit', { commitment: { riskAmount: 5n } })).toThrow(/signing-material|commitment/);
  });

  // ── sensitive-string redaction (own-state SSE plan §M6/B; Hermes PR #64 r1) ─
  //
  // The denied-key check above catches structural misuse. But a signature can
  // also leak as a SUBSTRING of a string value — e.g. an RPC error message
  // that quotes the offending bytes, a serialized state fragment passed
  // through errMessage(err), etc. The wire boundary redacts these inline so
  // an incidental contamination doesn't land in the NDJSON event log.
  //
  // Three patterns, applied recursively to every string value:
  //   1. [hex]{130,}  — a bare 65-byte (or longer) ECDSA-signature-length hex run
  //      anywhere in the string, whether or not a literal `0x` precedes it.
  //   2. JSON-shape signature key with any 0x-prefixed hex value (catches truncated).
  //   3. JSON-shape signedPayload key marker (structural-leak tag).
  it('redacts a bare 65-byte ECDSA signature embedded in a string value', () => {
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + 'a'.repeat(130);
    log.emit('error', { detail: `tx reverted: signature was ${fakeSig}` });
    const line = readLines(log.path)[0];
    // The 130-hex sequence must not appear anywhere in the serialized line.
    expect(JSON.stringify(line)).not.toContain(fakeSig);
    // The redaction marker must appear in place of it.
    expect(String(line?.detail)).toMatch(/REDACTED:ecdsa-signature/);
  });

  it('redacts a JSON-shape signature key with a full 130-hex value', () => {
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + 'b'.repeat(130);
    // Build the literal "sig"+colon+space+quote+0x... at runtime so this test
    // doesn't itself contain the secret-scan-flagged literal shape.
    const sigKey = '"' + 'signature' + '"';
    log.emit('error', { detail: `state: ${sigKey}: "${fakeSig}"` });
    const line = readLines(log.path)[0];
    expect(JSON.stringify(line)).not.toContain(fakeSig);
    expect(String(line?.detail)).toMatch(/REDACTED/);
  });

  it('redacts a JSON-shape signature key with a truncated (sub-130) hex value', () => {
    const log = EventLog.open(dir, 'r');
    const sigKey = '"' + 'signature' + '"';
    // Only 8 hex chars after 0x — not replayable on its own, but its
    // presence is a contamination signal worth redacting.
    log.emit('error', { detail: `state: ${sigKey}: "0xdeadbeef"` });
    const line = readLines(log.path)[0];
    expect(String(line?.detail)).not.toContain('0xdeadbeef');
    expect(String(line?.detail)).toMatch(/REDACTED/);
  });

  it('flags a JSON-shape signedPayload key marker (structural-leak signal)', () => {
    const log = EventLog.open(dir, 'r');
    const spKey = '"' + 'signedPayload' + '"';
    log.emit('error', { detail: `serialized state: ${spKey}: { ... }` });
    const line = readLines(log.path)[0];
    // The bare structural marker should be tagged in the output.
    expect(String(line?.detail)).toMatch(/REDACTED-FIELD/);
  });

  it('redacts every match of multiple 130-hex signatures in the same string', () => {
    const log = EventLog.open(dir, 'r');
    const sig1 = '0x' + 'c'.repeat(130);
    const sig2 = '0x' + 'd'.repeat(130);
    log.emit('error', { detail: `two sigs in one line: ${sig1} and also ${sig2}` });
    const line = readLines(log.path)[0];
    expect(String(line?.detail)).not.toContain(sig1);
    expect(String(line?.detail)).not.toContain(sig2);
    // Both occurrences get the marker (a single occurrence test would pass even with a bug).
    const matches = String(line?.detail).match(/REDACTED:ecdsa-signature/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('redacts a 130-hex signature run NOT prefixed by 0x (embedded mid-hex-blob)', () => {
    const log = EventLog.open(dir, 'r');
    // A signature's bytes appearing mid-run in a longer serialized hex blob,
    // with NO `0x` immediately preceding the 130-hex stretch. The old
    // 0x-anchored pattern missed this; the relaxed `[hex]{130,}` catches it.
    const bareHexSig = 'a'.repeat(130);
    log.emit('error', { detail: `calldata fragment: deadbeef${bareHexSig}` });
    const line = readLines(log.path)[0];
    expect(String(line?.detail)).not.toContain(bareHexSig);
    expect(String(line?.detail)).toMatch(/REDACTED:ecdsa-signature/);
  });

  it('redacts sensitive content nested deep inside object string values (recursive walk)', () => {
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + 'e'.repeat(130);
    log.emit('error', { detail: { meta: { rpc: { error: `bad sig: ${fakeSig}` } } } });
    const line = readLines(log.path)[0];
    expect(JSON.stringify(line)).not.toContain(fakeSig);
  });

  it('redacts sensitive content inside array string values', () => {
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + 'f'.repeat(130);
    log.emit('error', { detail: { items: [`first ${fakeSig}`, 'clean', `second one too`] } });
    const line = readLines(log.path)[0];
    expect(JSON.stringify(line)).not.toContain(fakeSig);
  });

  it('reproduces Hermes PR #64 round 1: serialized signed payload in error detail', () => {
    // This is the exact reproduction Hermes ran against pre-fix source:
    // an error message containing a JSON-shape signedPayload + signature
    // ended up in NDJSON intact. Post-fix, the 130-hex is redacted out.
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + '1'.repeat(130);
    const spKey = '"' + 'signedPayload' + '"';
    const sigKey = '"' + 'signature' + '"';
    log.emit('error', { detail: `${spKey}: { ${sigKey}: "${fakeSig}" }` });
    const line = readLines(log.path)[0];
    // The actual bearer credential — the 130-hex — must NOT appear anywhere.
    expect(JSON.stringify(line)).not.toContain(fakeSig);
    // Either redaction marker (ECDSA marker or JSON-shape marker) must be present.
    expect(String(line?.detail)).toMatch(/REDACTED/);
  });

  it('does NOT redact short hex literals like 0xdead, transaction hashes (64 hex), or commitment hashes', () => {
    const log = EventLog.open(dir, 'r');
    // 64-hex tx hash — half the length of a signature, used legitimately in fill telemetry.
    const txHash = '0x' + '7'.repeat(64);
    log.emit('candidate', { contestId: 'c1', txHash, commitmentHash: '0xabcd', short: '0xdead' });
    const line = readLines(log.path)[0];
    expect(line?.txHash).toBe(txHash);
    expect(line?.commitmentHash).toBe('0xabcd');
    expect(line?.short).toBe('0xdead');
  });

  it('does not mutate the caller-supplied payload object (redaction is on a copy)', () => {
    const log = EventLog.open(dir, 'r');
    const fakeSig = '0x' + '2'.repeat(130);
    const payload = { detail: `leak: ${fakeSig}` };
    log.emit('error', payload);
    // The caller's object should be unchanged — useful if the caller logs the
    // same payload elsewhere and expects to see its original content.
    expect(payload.detail).toBe(`leak: ${fakeSig}`);
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

  describe('maker-scoped (live state-loss check)', () => {
    const MINE = '0x1111111111111111111111111111111111111111';
    const THEIRS = '0x2222222222222222222222222222222222222222';

    it('matches only this maker’s prior logs — a sibling maker’s logs do NOT count', () => {
      EventLog.open(dir, 'theirs', THEIRS).emit('tick-start');
      expect(eventLogsExist(dir, MINE)).toBe(false); // only a foreign maker present
      EventLog.open(dir, 'mine', MINE).emit('tick-start');
      expect(eventLogsExist(dir, MINE)).toBe(true); // now this maker has a prior log
    });

    it('ignores a maker-less (legacy / dry-run) log when scoped to a maker, but counts it dir-wide', () => {
      writeFileSync(join(dir, 'run-legacy.ndjson'), '{"ts":"x","runId":"legacy","kind":"tick-start"}\n', 'utf8');
      expect(eventLogsExist(dir, MINE)).toBe(false); // unattributable → not this instance's
      expect(eventLogsExist(dir)).toBe(true); // dir-wide (dry-run) still sees it
    });

    it('counts an unparseable run log conservatively (errs toward the hold)', () => {
      writeFileSync(join(dir, 'run-corrupt.ndjson'), 'not json\n', 'utf8');
      expect(eventLogsExist(dir, MINE)).toBe(true);
    });
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
    for (const r of ['no-reference-odds', 'no-open-speculation', 'reference-line-mismatch', 'fee-budget-exhausted', 'cap-hit', 'gas-budget-blocks-reapproval'] as const) {
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
        byMarket: {
          // all events are moneyline (no `market` tag) → the moneyline bucket equals the aggregate.
          moneyline: { quotedUsdcWei6: '1200000', filledUsdcWei6: '500000', fillRate: 500000 / 1200000 },
          spread: { quotedUsdcWei6: '0', filledUsdcWei6: '0', fillRate: null },
          total: { quotedUsdcWei6: '0', filledUsdcWei6: '0', fillRate: null },
        },
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

    it('sums a fill\'s `feeUsdcWei6` (the seed lazy-creation fee) into totalFeeUsdcWei6; only the fee-carrying fill contributes', () => {
      const path = writeLog('run-fee.ndjson', [
        // a seed FIRST-MATCH fill carrying the maker's 0.25 USDC creation-fee share
        { kind: 'fill', source: 'own-state-stream', commitmentHash: '0xseed', speculationId: '4217', contestId: 'C1', makerSide: 'home', newFillWei6: '500000', feeUsdcWei6: '250000', market: 'total' },
        // a LATER fill on the now-created speculation — no fee
        { kind: 'fill', source: 'own-state-stream', commitmentHash: '0xseed', speculationId: '4217', contestId: 'C1', makerSide: 'home', newFillWei6: '300000', market: 'total' },
        // a moneyline fill — no fee field at all
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xml', speculationId: 'spec-ML', contestId: 'C2', makerSide: 'away', newFillWei6: '100000' },
      ]);
      expect(summarize([path]).liveMetrics.totalFeeUsdcWei6).toBe('250000');
    });

    it('totalFeeUsdcWei6 stays 0 when no fill carries a fee (the current build — byte-identical)', () => {
      const path = writeLog('run-nofee.ndjson', [
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '200000', filledRiskWei6: '200000', partial: false },
      ]);
      expect(summarize([path]).liveMetrics.totalFeeUsdcWei6).toBe('0');
    });

    it('breaks fills + realized P&L down by market via the `market` tag (the aggregate equals the sum across markets; absent tag ⇒ moneyline)', () => {
      const path = writeLog('run-multimarket.ndjson', [
        // moneyline (NO `market` tag) — quote 1.0, fully filled, won (claim 1.8 → +0.8)
        { kind: 'submit', commitmentHash: '0xml', speculationId: 'spec-ML', contestId: 'C1', makerSide: 'home', oddsTick: 180, riskAmountWei6: '1000000' },
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xml', speculationId: 'spec-ML', contestId: 'C1', makerSide: 'home', newFillWei6: '1000000', filledRiskWei6: '1000000', partial: false },
        { kind: 'claim', speculationId: 'spec-ML', contestId: 'C1', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', makerSide: 'home', positionType: 1, payoutWei6: '1800000', result: 'won', txHash: '0xc1' },
        // spread — quote 0.5, filled, lost (settle away ≠ maker home, no claim) → -0.5
        { kind: 'submit', commitmentHash: '0xsp', speculationId: 'spec-SP', contestId: 'C1', makerSide: 'home', oddsTick: 190, riskAmountWei6: '500000', market: 'spread' },
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xsp', speculationId: 'spec-SP', contestId: 'C1', makerSide: 'home', newFillWei6: '500000', filledRiskWei6: '500000', partial: false, market: 'spread' },
        { kind: 'settle', speculationId: 'spec-SP', contestId: 'C1', sport: 'mlb', awayTeam: 'A', homeTeam: 'B', makerSide: 'home', winSide: 'away', txHash: '0xs2', market: 'spread' },
        // total — quote 0.4, partially filled 0.2, unsettled
        { kind: 'submit', commitmentHash: '0xto', speculationId: 'spec-TO', contestId: 'C1', makerSide: 'home', oddsTick: 195, riskAmountWei6: '400000', market: 'total' },
        { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xto', speculationId: 'spec-TO', contestId: 'C1', makerSide: 'home', newFillWei6: '200000', filledRiskWei6: '200000', partial: true, market: 'total' },
      ]);
      const s = summarize([path]);

      // fills.byMarket — quoted/filled attributed by each event's tag
      expect(s.liveMetrics.fills.byMarket.moneyline).toEqual({ quotedUsdcWei6: '1000000', filledUsdcWei6: '1000000', fillRate: 1 });
      expect(s.liveMetrics.fills.byMarket.spread).toEqual({ quotedUsdcWei6: '500000', filledUsdcWei6: '500000', fillRate: 1 });
      expect(s.liveMetrics.fills.byMarket.total).toEqual({ quotedUsdcWei6: '400000', filledUsdcWei6: '200000', fillRate: 0.5 });
      // aggregate == sum across markets
      expect(s.liveMetrics.fills.quotedUsdcWei6).toBe('1900000'); // 1.0 + 0.5 + 0.4
      expect(s.liveMetrics.fills.filledUsdcWei6).toBe('1700000'); // 1.0 + 0.5 + 0.2

      // realizedPnl.byMarket — each position bucketed by its speculation's market
      expect(s.liveMetrics.realizedPnl.byMarket.moneyline).toMatchObject({ netUsdcWei6: '800000', claimedProfitUsdcWei6: '800000', wonCount: 1, lostCount: 0, unsettledCount: 0 });
      expect(s.liveMetrics.realizedPnl.byMarket.spread).toMatchObject({ netUsdcWei6: '-500000', realizedLossUsdcWei6: '500000', wonCount: 0, lostCount: 1, unsettledCount: 0 });
      expect(s.liveMetrics.realizedPnl.byMarket.total).toMatchObject({ netUsdcWei6: '0', wonCount: 0, lostCount: 0, unsettledCount: 1 });
      // aggregate == sum across markets
      expect(s.liveMetrics.realizedPnl.netUsdcWei6).toBe('300000'); // +0.8 − 0.5
      expect(s.liveMetrics.realizedPnl.wonCount).toBe(1);
      expect(s.liveMetrics.realizedPnl.lostCount).toBe(1);
      expect(s.liveMetrics.realizedPnl.unsettledCount).toBe(1);
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

    it('folds recovered-race settle gas (candidate/already-settled, purpose settleSpeculation) into gas.byKind.settle WITHOUT bumping settleCount', () => {
      const path = writeLog('run-recovered-gas.ndjson', [
        // Recovered inclusion-time race: our settle reverted (gas spent); the runner billed it here.
        { kind: 'candidate', skipReason: 'already-settled', purpose: 'settleSpeculation', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', outcome: 'recovered', winSide: 'away', revertedTxHash: '0xrev', gasPolWei: '1800000000000000' }, // 0.0018 POL
        // Reverted tx but receipt unavailable → no gasPolWei, gap flagged.
        { kind: 'candidate', skipReason: 'already-settled', purpose: 'settleSpeculation', speculationId: 'spec-B', contestId: 'B', makerSide: 'away', outcome: 'recovered', revertedTxHash: '0xrev2', gasAccountingGap: true },
        // Pre-flight already-settled skip: no tx, no gas.
        { kind: 'candidate', skipReason: 'already-settled', purpose: 'settleSpeculation', speculationId: 'spec-C', contestId: 'C', makerSide: 'home', outcome: 'alreadySettled', winSide: 'home' },
      ]);
      const s = summarize([path]);
      // The reverted settle's gas is in the totals (under `settle`) — matching the
      // state daily counter the runner debited; the gap / no-tx skips add nothing.
      expect(s.liveMetrics.gas.byKind.settle).toBe('1800000000000000');
      expect(s.liveMetrics.gas.totalPolWei).toBe('1800000000000000');
      // None of these is a successful settle.
      expect(s.liveMetrics.settlements.settleCount).toBe(0);
      // All three are still counted as already-settled skips.
      expect(s.candidates.skipReasons['already-settled']).toBe(3);
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

      it('push (realistic — auto-claim emits a claim event with payout=stake; classifier must NOT treat that as won) — Hermes review-PR33 blocker', () => {
        // The SDK's ClaimablePositionView.result is 'won' | 'push' | 'void';
        // the runner's auto-claim path claims every `claimable` record
        // regardless of outcome (a push refunds the stake). So a push position
        // emits: fill → settle(winSide=push) → claim(payoutWei6=stake). Without
        // the outcome-first classification, the classifier would miscount this
        // as wonCount=1.
        const path = writeLog('run-push-claim.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'push', txHash: '0xtxS' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC' }, // payout = stake (refund)
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0); // crucial — the claim event must not promote it to won
        expect(r.lostCount).toBe(0);
        expect(r.claimedProfitUsdcWei6).toBe('0');
        expect(r.netUsdcWei6).toBe('0');
      });

      it('void (same posture as push — auto-claimed with payout=stake; classifier honours the outcome over the claim event)', () => {
        const path = writeLog('run-void-claim.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'void', txHash: '0xtxS' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0');
      });

      it('push without a claim — same classification (sometimes the auto-claim hasn\'t ticked yet for the push refund)', () => {
        const path = writeLog('run-push-no-claim.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'push', txHash: '0xtx' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0');
      });

      // ── claim.result enrichment (Phase 3 g-iii-a) ────────────────────────────

      it('claim.result=push classifies as push EVEN WHEN settle.winSide is missing from the window (--since clipped the settle; closes Hermes review-PR33 follow-up note)', () => {
        // The previously-documented limitation: a --since window catching
        // the claim (with payout=stake refund) but clipping the settle event.
        // Before claim.result, this counted as `won-with-zero-profit`. The
        // runner-emitted claim.result is now authoritative.
        const path = writeLog('run-claim-result-push.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          // NO settle event in this window.
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC', result: 'push' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
        expect(r.claimedProfitUsdcWei6).toBe('0');
        expect(r.netUsdcWei6).toBe('0');
      });

      it('claim.result=void same posture as push (refund), without settle in the window', () => {
        const path = writeLog('run-claim-result-void.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC', result: 'void' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
      });

      it('claim.result=won classifies as won (authoritative; doesn\'t need settle in the window)', () => {
        const path = writeLog('run-claim-result-won.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '900000', txHash: '0xtxC', result: 'won' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(1);
        expect(r.pushCount).toBe(0);
        expect(r.claimedProfitUsdcWei6).toBe('400000'); // 0.9 − 0.5 = 0.4
        expect(r.netUsdcWei6).toBe('400000');
      });

      it('older log without claim.result + settle in window → falls back to settle-based classification (push)', () => {
        // Regression of the existing g-ii push-with-claim behaviour: when the
        // runner-emitted result field is absent (a log written before
        // (g-iii-a)), the classifier still gets it right via settle.winSide.
        const path = writeLog('run-no-claim-result.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'push', txHash: '0xtxS' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC' }, // no `result` field
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
      });

      it('claim.result=push overrides settle.winSide=won (extremely unlikely edge — but documents that the runner-emitted result is the source of truth)', () => {
        // This isn't expected to happen in real telemetry — the runner sets
        // result from the same API observation that produced the settle event
        // — but covers the contract: when both are present, claim.result wins.
        const path = writeLog('run-result-precedence.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', winSide: 'away', txHash: '0xtxS' }, // "settle says we won"
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'away', positionType: 0, payoutWei6: '500000', txHash: '0xtxC', result: 'push' }, // "claim says push"
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.pushCount).toBe(1);
        expect(r.wonCount).toBe(0);
      });

      it('malformed claim.result value is dropped (forward-compat: a future result value doesn\'t corrupt classification — falls back to settle.winSide)', () => {
        const path = writeLog('run-malformed-result.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtxS' },
          { kind: 'claim', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', positionType: 1, payoutWei6: '900000', txHash: '0xtxC', result: 'mystery-future-value' },
        ]);
        const r = summarize([path]).liveMetrics.realizedPnl;
        expect(r.wonCount).toBe(1); // falls back to settle.winSide === makerSide
        expect(r.claimedProfitUsdcWei6).toBe('400000');
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

      it('alreadyClaimed — settle.winSide=makerSide but the position was found ALREADY claimed (candidate already-claimed, no claim event) → counted as alreadyClaimed (NOT wonUnclaimed); no net P&L (no event-sourced payout)', () => {
        const path = writeLog('run-already-claimed.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'settle', speculationId: 'spec-A', contestId: 'A', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', makerSide: 'home', winSide: 'home', txHash: '0xtx' },
          // Auto-claim found it already claimed (a prior run / another caller) —
          // a candidate skip, NOT a claim event (no event-sourced payout).
          { kind: 'candidate', skipReason: 'already-claimed', purpose: 'claimPosition', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', outcome: 'alreadyClaimed' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.alreadyClaimedCount).toBe(1);
        expect(r.wonUnclaimedCount).toBe(0); // NOT misclassified as genuinely-unswept
        expect(r.wonCount).toBe(0);
        expect(r.netUsdcWei6).toBe('0'); // no event-sourced payout — never derived
      });

      it('alreadyClaimed with NO settle event in the window (outcome unknown) → still alreadyClaimed (NOT unsettled) — the candidate proves it was claimed', () => {
        const path = writeLog('run-already-claimed-no-settle.ndjson', [
          { kind: 'fill', source: 'commitment-diff', commitmentHash: '0xa', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', newFillWei6: '500000' },
          { kind: 'candidate', skipReason: 'already-claimed', purpose: 'claimPosition', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', outcome: 'recovered' },
        ]);
        const s = summarize([path]);
        const r = s.liveMetrics.realizedPnl;
        expect(r.alreadyClaimedCount).toBe(1);
        expect(r.unsettledCount).toBe(0); // NOT misclassified as unsettled
        expect(r.netUsdcWei6).toBe('0');
      });

      it('a recovered CLAIM race (already-claimed + purpose claimPosition + gasPolWei) folds its reverted gas into the `claim` gas bucket (matches the daily counter)', () => {
        const path = writeLog('run-recovered-claim-gas.ndjson', [
          { kind: 'candidate', skipReason: 'already-claimed', purpose: 'claimPosition', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', outcome: 'recovered', revertedTxHash: '0xrev', gasPolWei: '1800000000000000' },
        ]);
        const s = summarize([path]);
        expect(s.liveMetrics.gas.byKind.claim).toBe('1800000000000000'); // reverted-claim gas billed under `claim`
        expect(s.candidates.skipReasons['already-claimed']).toBe(1);
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
