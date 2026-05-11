/**
 * Telemetry — the append-only NDJSON event log (DESIGN §11) and (a stub for) the
 * `ospex-mm summary` aggregator.
 *
 * Every line of the event log is `{ ts, runId, kind, ...payload }`. **This NDJSON
 * shape is a stable contract** — a future external scorecard consumes it unchanged
 * (DESIGN §11, §16), so this module is treated as a wire boundary and fails closed:
 * `kind` must be a known kind; the `runId` must be filename-safe (it names the
 * file); the payload must be a plain object with none of the reserved keys (`ts` /
 * `runId` / `kind`); and every payload value must be JSON-safe and deterministic —
 * `bigint`s, non-finite / unsafe-integer numbers, `undefined`, functions, symbols,
 * and non-plain objects (`Map`, `Date`, class instances, …) all throw rather than
 * being silently dropped or mangled by `JSON.stringify`. Anything that can exceed
 * `Number.MAX_SAFE_INTEGER` (risk in wei6, block numbers, …) is a decimal string —
 * the AGENT_CONTRACT numeric rule.
 *
 * No SDK, no chain. Phase 2's runner is the first real consumer; this slice ships
 * the writer + the `kind` vocabulary so that vocabulary is locked early.
 */

import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
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

  /**
   * Open (creating `logDir` if needed) the event-log file for `runId`. The file
   * itself is created on the first `emit`. `runId` must be filename-safe — only
   * letters, digits, `_` and `-` (no path separators, no `..`) — since it becomes
   * part of the file name; use `newRunId()` for a safe one.
   */
  static open(logDir: string, runId: string): EventLog {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error(`telemetry: runId "${runId}" is not filename-safe — use only letters, digits, "_" and "-" (it becomes part of the log file name); call newRunId() for a safe one`);
    }
    mkdirSync(logDir, { recursive: true });
    return new EventLog(runId, join(logDir, `run-${runId}.ndjson`));
  }

  /**
   * Append one event line. Fails closed — throws if `kind` isn't a known kind, if
   * `payload` isn't a plain object, if `payload` shadows a reserved key (`ts` /
   * `runId` / `kind`), or if any (nested) payload value isn't JSON-safe-and-
   * deterministic (a `bigint`, a non-finite or unsafe-integer number, `undefined`,
   * a function, a symbol, or a non-plain object like a `Map` / `Date` / class
   * instance). Stringify wei6 / block numbers; flatten objects (incl. `Error`s).
   */
  emit(kind: TelemetryKind, payload: TelemetryPayload = {}): void {
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(`telemetry: unknown event kind "${String(kind)}" — must be one of ${TELEMETRY_KINDS.join(', ')}`);
    }
    if (!isPlainObject(payload)) {
      throw new Error(`telemetry: payload must be a plain object, got ${describeValue(payload)}`);
    }
    for (const k of RESERVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        throw new Error(`telemetry: payload must not set the reserved key "${k}" (the writer owns ts / runId / kind)`);
      }
    }
    for (const [key, value] of Object.entries(payload)) assertWireSafe(value, `payload.${key}`);
    const line = JSON.stringify({ ts: new Date().toISOString(), runId: this.runId, kind, ...payload });
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }
}

/**
 * Is there evidence of a prior run under `logDir` — at least one event-log file
 * (`run-*.ndjson`)? The boot path feeds this to `assessStateLoss`'s
 * `hasPriorTelemetry`: a missing state file plus prior telemetry = state loss, not
 * a first run (DESIGN §12). A missing `logDir` means no prior run (`false`); an
 * unreadable one is treated conservatively as a prior run (`true`).
 */
export function eventLogsExist(logDir: string): boolean {
  try {
    return readdirSync(logDir).some((name) => /^run-.+\.ndjson$/.test(name));
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false;
    return true;
  }
}

/** Recursively reject anything `JSON.stringify` would drop / mangle / can't represent precisely — the event log is a stable wire contract, so fail closed (DESIGN §11, AGENT_CONTRACT). */
function assertWireSafe(value: unknown, path: string): void {
  if (typeof value === 'bigint') {
    throw new Error(`telemetry: ${path} is a bigint (${value}n) — stringify it (the AGENT_CONTRACT numeric rule: wei6 / block numbers are decimal strings)`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    const what = value === undefined ? 'undefined' : `a ${typeof value}`;
    throw new Error(`telemetry: ${path} is ${what} — not JSON-representable; emit a string, number, boolean, null, plain object, or array`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`telemetry: ${path} is ${value} — NaN / Infinity serialize to null; emit a finite number or a string`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`telemetry: ${path} is ${value}, an integer beyond Number.MAX_SAFE_INTEGER — emit it as a decimal string (AGENT_CONTRACT numeric rule)`);
    }
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertWireSafe(v, `${path}[${i}]`));
    return;
  }
  // a non-null, non-array object
  if (!isPlainObject(value)) {
    throw new Error(`telemetry: ${path} is ${describeValue(value)} — JSON.stringify would lose or mangle it; flatten it to a plain object first`);
  }
  for (const [k, v] of Object.entries(value)) assertWireSafe(v, `${path}.${k}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name ? `a ${name}` : 'an unusual object';
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
