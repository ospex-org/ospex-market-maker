/**
 * Telemetry — the append-only NDJSON event log (DESIGN §11) and (a stub for) the
 * `ospex-mm summary` aggregator.
 *
 * Every line of the event log is `{ ts, runId, kind, ...payload }`. **This NDJSON
 * shape is a stable contract** — a future external scorecard consumes it unchanged
 * (DESIGN §11, §16), so this module is treated as a wire boundary: `kind` must be
 * one of the known kinds, the reserved keys (`ts` / `runId` / `kind`) can't be
 * shadowed by a payload, and any value that can exceed `Number.MAX_SAFE_INTEGER`
 * (risk in wei6, block numbers, …) must already be a string — a `bigint` in a
 * payload throws rather than emit a value `JSON.stringify` can't represent (the
 * AGENT_CONTRACT numeric rule).
 *
 * No SDK, no chain. Phase 2's runner is the first real consumer; this slice ships
 * the writer + the `kind` vocabulary so that vocabulary is locked early.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `kind` vocabulary for event-log lines (DESIGN §11). Adding a kind is an
 * additive change; removing or renaming one is a breaking change to the scorecard
 * contract — don't.
 */
export const TELEMETRY_KINDS = [
  'tick-start',
  'candidate', //                  a contest considered; carries `skipReason` (a CandidateSkipReason) if skipped
  'fair-value',
  'risk-verdict', //               { allowed, sizeUSDC } | { allowed: false, reason }
  'quote-intent',
  'quote-competitiveness',
  'competitiveness-unavailable',
  'submit',
  'would-submit', //               dry-run counterpart of `submit`
  'soft-cancel',
  'would-soft-cancel',
  'replace',
  'would-replace',
  'onchain-cancel',
  'nonce-floor-raise',
  'expire', //                     a tracked commitment hit expiry — headroom released
  'approval', //                   { purpose, spender, currentAllowance, requiredAggregateAllowance, amountSetTo }
  'fill',
  'settle',
  'claim',
  'degraded', //                   a market's odds channel errored
  'error', //                      { class, detail }
  'kill',
] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

/** Skip reasons carried on a `candidate` event when the MM declined to quote a market (DESIGN §11). */
export const CANDIDATE_SKIP_REASONS = [
  'no-reference-odds',
  'no-open-speculation',
  'would-create-lazy-speculation',
  'stale-reference',
  'start-too-soon',
  'cap-hit',
  'refused-pricing',
  'tracking-cap-reached',
  'gas-budget-blocks-reapproval',
] as const;
export type CandidateSkipReason = (typeof CANDIDATE_SKIP_REASONS)[number];

/** Free-form payload for an event-log line — merged into `{ ts, runId, kind }`. See the bigint / reserved-key rules. */
export type TelemetryPayload = Record<string, unknown>;

const RESERVED_KEYS = ['ts', 'runId', 'kind'] as const;
const KNOWN_KINDS: ReadonlySet<string> = new Set(TELEMETRY_KINDS);

/**
 * A run identifier — filename-safe and roughly time-sortable. Two runs started in
 * the same millisecond still differ (the random suffix), so two MMs sharing a log
 * directory won't clobber each other's file (though they must NOT share a state
 * directory — DESIGN §12).
 */
export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // 2026-05-11T14-30-00-123Z
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/**
 * Append-only NDJSON event log — one file per run, `<logDir>/run-<runId>.ndjson`.
 * Synchronous appends (`appendFileSync` per line): the event volume is a handful
 * of lines per ~30 s tick, so a write stream would be premature; this also keeps
 * every line durably on disk the moment it's emitted (no buffered flush to lose on
 * a crash). Single-writer per file.
 */
export class EventLog {
  readonly runId: string;
  readonly path: string;

  private constructor(runId: string, path: string) {
    this.runId = runId;
    this.path = path;
  }

  /** Open (creating `logDir` if needed) the event-log file for `runId`. The file itself is created on the first `emit`. */
  static open(logDir: string, runId: string): EventLog {
    mkdirSync(logDir, { recursive: true });
    return new EventLog(runId, join(logDir, `run-${runId}.ndjson`));
  }

  /**
   * Append one event line. Throws if `kind` is not a known kind, if `payload`
   * shadows a reserved key, or if any (nested) payload value is a `bigint` — all
   * three would corrupt the stable scorecard contract, so fail closed.
   */
  emit(kind: TelemetryKind, payload: TelemetryPayload = {}): void {
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(`telemetry: unknown event kind "${String(kind)}" — must be one of ${TELEMETRY_KINDS.join(', ')}`);
    }
    for (const k of RESERVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        throw new Error(`telemetry: payload must not set the reserved key "${k}" (the writer owns ts / runId / kind)`);
      }
    }
    assertNoBigints(payload, 'payload');
    const line = JSON.stringify({ ts: new Date().toISOString(), runId: this.runId, kind, ...payload });
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }
}

function assertNoBigints(value: unknown, path: string): void {
  if (typeof value === 'bigint') {
    throw new Error(
      `telemetry: ${path} is a bigint (${value}n) — stringify it before emitting (the AGENT_CONTRACT numeric rule: wei6 / block numbers are decimal strings)`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoBigints(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigints(v, `${path}.${k}`);
  }
}

// ── run summary (the `ospex-mm summary` aggregator — Phase 3) ─────────────────

/**
 * The `ospex-mm summary` envelope (DESIGN §11). Phase 3 fills in the §2.3 metrics
 * (P&L, fill rate, gas, stale-quote incidents, the latent-exposure peak, …); for
 * now this is the minimal stable frame so the shape is reserved.
 */
export interface RunSummary {
  schemaVersion: 1;
  /** ISO-8601. */
  generatedAt: string;
  /** The event-log file paths this summary was aggregated from. */
  sources: string[];
}

/** Aggregate one or more NDJSON event logs into a `RunSummary`. Not yet implemented (Phase 3 — DESIGN §11, §14). */
export function summarize(_logPaths: readonly string[]): RunSummary {
  throw new Error('telemetry.summarize: not yet implemented — the `ospex-mm summary` aggregator lands in Phase 3 (DESIGN §11, §14)');
}
