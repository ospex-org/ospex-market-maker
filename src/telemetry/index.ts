/**
 * Telemetry — the append-only NDJSON event log (DESIGN §11) and the
 * `ospex-mm summary` aggregator (dry-run metrics + live-mode fill rate / gas /
 * fees / settlement outcomes / realized P&L — see {@link LiveMetrics}; only
 * unrealized P&L over still-active positions remains as a follow-up).
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

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
  'position-transition', //         a tracked position's status moved forward (active → pendingSettle → claimable; claimed is set by the auto-claim path, not by the poll)
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
  'gas-budget-blocks-settlement', // on-chain settleSpeculation / claimPosition denied by canSpendGas (mayUseReserve = settlement.continueOnGasBudgetExhausted); `purpose` distinguishes `settleSpeculation` vs `claimPosition`
  'gas-budget-blocks-onchain-cancel', // shutdown-time on-chain cancelCommitment denied by canSpendGas (with mayUseReserve: true since `killCancelOnChain: true` is operator-explicit); the candidate's `commitmentHash` identifies the record that couldn't be cancelled
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

// ── run summary (the `ospex-mm summary` aggregator — DESIGN §11, §2.3) ────────

/**
 * List the event-log files under `logDir` (`run-*.ndjson`), sorted. A missing
 * `logDir` yields `[]` (no logs yet — a fresh setup); an unreadable one (anything
 * other than ENOENT) throws — `summarize([])` is "no events", which would be
 * misleading if the logs are actually there but unreadable. `ospex-mm summary`
 * feeds the result to {@link summarize}.
 */
export function listRunLogs(logDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => /^run-.+\.ndjson$/.test(name))
    .sort()
    .map((name) => join(logDir, name));
}

/**
 * The `ospex-mm summary` report (DESIGN §11) — the §2.3 run metrics aggregated
 * from one or more NDJSON event logs. The **dry-run** metrics (would-be-stale rate,
 * quote competitiveness, quote-age distribution, latent-exposure peak, the
 * candidate-skip and error histograms) are fully computed; the **live-mode**
 * ones (fill rate, gas, fees, settlement outcomes, realized P&L — DESIGN §2.3)
 * are also computed by the live-event walk (`submit` / `replace` / `fill` /
 * `settle` / `claim` / `approval` / `onchain-cancel`) and exposed on
 * {@link RunSummary.liveMetrics}; only unrealized P&L over still-active
 * positions remains as a Phase-3 follow-up.
 *
 * This is the MM's *own* report; the cross-agent platform-viability scorecard
 * (DESIGN §16) consumes the raw NDJSON, not this.
 */
export interface RunSummary {
  schemaVersion: 1;
  /** ISO-8601 — when this summary was generated. */
  generatedAt: string;
  /** The event-log file paths aggregated, in the order given. */
  sources: string[];
  /** Structurally-valid event lines aggregated (after any `--since` filter). */
  lines: number;
  /** Lines that weren't a JSON object with string `ts` / `runId` / `kind` and a parseable `ts` — skipped. */
  malformedLines: number;
  /** Distinct `runId`s across the aggregated lines, sorted. */
  runIds: string[];
  /** Earliest / latest `ts` across the aggregated lines; `null` if there were none. */
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** Count of `tick-start` events (= ticks the loop ran). */
  ticks: number;
  /** Per-`kind` event count — zero-filled for every {@link TELEMETRY_KINDS}, plus any other `kind` strings seen (forward-compat). */
  eventCounts: Record<string, number>;
  /** `candidate` events: `tracked` = those with no `skipReason` (a contest taken on); `skipReasons` = a histogram of the `skipReason` strings on the rest. */
  candidates: { total: number; tracked: number; skipReasons: Record<string, number> };
  /** `quote-intent` events: how many priced a quote (`canQuote: true`) vs refused. */
  quoteIntents: { total: number; canQuote: number; refused: number };
  /** Dry-run "would-be" activity. */
  wouldSubmit: number;
  wouldReplace: { total: number; byReason: Record<string, number> };
  wouldSoftCancel: { total: number; byReason: Record<string, number> };
  /** `expire` events — tracked commitments that hit expiry (headroom released). */
  expired: number;
  /** Quote competitiveness (dry-run — DESIGN §2.3 / §8). The rate / tick-delta stats are `null` when there were no samples. */
  quoteCompetitiveness: {
    samples: number;
    atOrInsideBookCount: number;
    atOrInsideBookRate: number | null;
    vsReferenceTicks: { min: number; p50: number; mean: number; max: number } | null;
    unavailable: number;
  };
  /** How long would-be quotes stayed up before being soft-cancelled / replaced / expired, in seconds — over *completed* quotes (still-open ones at end of log are excluded). `null` if there were none. */
  quoteAgeSeconds: { samples: number; p50: number; p90: number; max: number } | null;
  /** The largest `visibleOpen + softCancelled-not-yet-expired` aggregate risk reached (USDC wei6, decimal string), reconstructed from the `would-submit` / `would-replace` / `expire` stream. `"0"` if nothing was posted. */
  latentExposurePeakWei6: string;
  /** Stale-quote incidents: `candidate[skipReason='stale-reference']` + `would-replace[reason='stale']` + `would-soft-cancel[reason='stale']`. */
  staleQuoteIncidents: number;
  /** `degraded` events by `reason` (`'channel-error'` / `'subscribe-failed'` / `'channel-cap'`). */
  degradedByReason: Record<string, number>;
  /** `error` events: total + a histogram by `phase` (`'(none)'` for errors without one). */
  errors: { total: number; byPhase: Record<string, number> };
  /** The `kill` event ending the run, if the log has one (graceful shutdown); `null` otherwise (still running, or crashed). */
  kill: { reason: string; ticks: number } | null;
  /**
   * Live-mode metrics — fill rate / gas / fees / settlement outcomes /
   * realized P&L (DESIGN §2.3, §11). Always populated, but zero-valued under
   * a pure dry-run log (the live events — `submit` / `replace` / `fill` /
   * `settle` / `claim` / `approval` / `onchain-cancel` — only get emitted
   * in live mode). Unrealized P&L over still-active positions lands in a
   * later Phase-3 slice (requires `summarize` to accept an `OspexAdapter`).
   */
  liveMetrics: LiveMetrics;
}

/**
 * Per-on-chain-op gas attribution — POL wei18 decimal strings, summed across
 * every event of each kind that carried `gasPolWei`.
 */
export interface LiveGasByKind {
  /** Boot-time `PositionModule` USDC allowance bumps — `approval` events. */
  approval: string;
  /** Shutdown-time `cancelCommitmentOnchain` + `cancel-stale --authoritative` — `onchain-cancel` events. */
  onchainCancel: string;
  /** Auto-settle's `settleSpeculation` calls — `settle` events. */
  settle: string;
  /** Auto-claim's `claimPosition` calls — `claim` events. */
  claim: string;
}

/**
 * Realized P&L over closed positions (DESIGN §11). Computed by cross-event
 * correlation: `fill.newFillWei6` accumulates per-(speculationId, makerSide)
 * cumulative own stake; `settle.winSide` identifies the per-speculation
 * outcome; `claim.payoutWei6` is the maker's swept payout on a winning
 * position. For each position with at least one fill:
 *
 *   - **won** — a `claim` event exists for that `(speculationId, makerSide)`;
 *     profit = `payoutWei6 - cumulativeStake`, contributes to `netUsdcWei6`.
 *   - **lost** — settle exists with `winSide !== makerSide` AND `winSide !==
 *     'push' / 'void'`, and no claim; -stake contributes to `netUsdcWei6`.
 *   - **push** — settle's `winSide` is `'push'` or `'void'`; P&L = 0,
 *     contributes nothing.
 *   - **wonUnclaimed** — settle's `winSide === makerSide` BUT no claim has
 *     fired in this log window (auto-claim disabled, hasn't ticked yet, or
 *     threw). Counted but does NOT contribute to `netUsdcWei6` — the payout
 *     isn't known yet. Operators should consult `ospex-mm status` for live
 *     `getPositionStatus` payout totals.
 *   - **unsettled** — position has fills but no settle event in the window.
 *     Held over for the (g-iii) unrealized-P&L slice.
 *
 * Unrealized P&L (active positions marked to current fair) is the remaining
 * Phase-3 follow-up and requires `summarize` to accept an `OspexAdapter`.
 */
export interface RealizedPnl {
  /** Net realized P&L in USDC wei6 (SIGNED decimal string — leading `-` for losses; `"0"` for zero). Sum of `won` profits minus `lost` stakes; `push` and `wonUnclaimed` contribute nothing. */
  netUsdcWei6: string;
  /** Sum of `payoutWei6 - cumulativeStake` across `won` positions (always non-negative — a claim only fires on winning positions). */
  claimedProfitUsdcWei6: string;
  /** Sum of stakes lost across `lost` positions (non-negative; subtracted from `claimedProfitUsdcWei6` to get net). */
  realizedLossUsdcWei6: string;
  /** Positions closed in the maker's favor with a `claim` event in this window. */
  wonCount: number;
  /** Positions whose `settle.winSide` ≠ `makerSide` (and ≠ push/void). */
  lostCount: number;
  /** Positions whose `settle.winSide ∈ {'push', 'void'}` — stake refunded, P&L = 0. */
  pushCount: number;
  /** Positions whose `settle.winSide === makerSide` but no `claim` event fired in this window — paper profit, not yet swept. Use `ospex-mm status` for the live payout figure. */
  wonUnclaimedCount: number;
  /** Positions with fills whose speculation has not settled in this window — held over for the (g-iii) unrealized-P&L slice. */
  unsettledCount: number;
}

/**
 * Live-mode run metrics (DESIGN §2.3 / §11). The fill / settlement / gas /
 * fees / realized-P&L aggregators populated by the `submit` / `replace` /
 * `fill` / `settle` / `claim` / `approval` / `onchain-cancel` walk. Wei
 * amounts are decimal strings — the AGENT_CONTRACT numeric rule.
 */
export interface LiveMetrics {
  /**
   * Fill rate (DESIGN §2.3). `quotedUsdcWei6` sums `riskAmountWei6` across
   * every `submit` and `replace` event (USDC the maker actually committed
   * onto the book); `filledUsdcWei6` sums `newFillWei6` across every `fill`
   * event (USDC of that committed risk that takers matched). `fillRate` is
   * `filledUsdc / quotedUsdc` as a number in [0, 1+]; `null` when nothing
   * was quoted (division-by-zero). Future per-sport / per-time-to-tip
   * bucketing is a follow-up (`bucketed: …`).
   */
  fills: {
    quotedUsdcWei6: string;
    filledUsdcWei6: string;
    fillRate: number | null;
  };
  /**
   * Gas spent on chain. `totalPolWei` is the sum across every on-chain op
   * that carried a `gasPolWei` field; `byKind` attributes it per event
   * kind. `totalUsdcEquivWei6` is the optional `POL → USDC` conversion
   * (only present when the caller of {@link summarize} supplied a
   * `polToUsdcRate`; the CLI feeds it `config.gas.nativeTokenUSDCPrice`
   * iff `config.gas.reportInUSDC: true`).
   */
  gas: {
    totalPolWei: string;
    byKind: LiveGasByKind;
    totalUsdcEquivWei6: string | null;
  };
  /**
   * Settlement outcomes. `settleCount` is the number of `settle` events
   * (`speculationSettle` calls); `claimCount` is the number of `claim`
   * events; `totalClaimedPayoutWei6` is the sum of `payoutWei6` across
   * those claims — USDC the maker actually swept back. The maker's net
   * settled P&L (claimed payouts − staked risk on the claimed positions)
   * is on {@link realizedPnl} below.
   */
  settlements: {
    settleCount: number;
    claimCount: number;
    totalClaimedPayoutWei6: string;
  };
  /**
   * Realized P&L over closed positions (see {@link RealizedPnl} for the
   * cross-event correlation rules and bucket definitions). Net P&L is
   * `claimedProfit − realizedLoss`. Unrealized P&L over still-active
   * positions is the remaining Phase-3 follow-up (needs adapter).
   */
  realizedPnl: RealizedPnl;
  /**
   * Total protocol fees paid by the maker (USDC wei6 decimal string).
   * Genuinely `"0"` in v0 — v0 refuses lazy-creation commitments so there's
   * no `TreasuryModule` creation fee. Kept here for forward-compat: a future
   * event may emit a `feeUsdcWei6` field that gets summed here.
   */
  totalFeeUsdcWei6: string;
}

interface ParsedLine {
  ts: string;
  tsMs: number;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** A tracked would-be quote, for the latent-exposure / quote-age walk: its risk, when it was posted, whether its visible-life age has been recorded, whether it's still in the latent bucket. */
interface WalkedQuote {
  riskWei6: bigint;
  submitTsSec: number;
  ageRecorded: boolean;
  alive: boolean;
}

/** A non-negative-integer wei amount as a decimal string — `"0"`, `"250000"`. (Local copy; `src/state/`'s `isDecimalString` isn't exported.) */
function isWei6String(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
}

function parseSinceOrThrow(sinceIso: string): number {
  const ms = Date.parse(sinceIso);
  if (!Number.isFinite(ms)) {
    throw new Error(`telemetry.summarize: --since must be an ISO-8601 timestamp (e.g. 2026-05-12T14:00:00Z), got ${JSON.stringify(sinceIso)}`);
  }
  return ms;
}

function readAndParse(logPaths: readonly string[], sinceMs: number | null): { kept: ParsedLine[]; lines: number; malformed: number } {
  const kept: ParsedLine[] = [];
  let lines = 0;
  let malformed = 0;
  for (const path of logPaths) {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformed += 1;
        continue;
      }
      if (!isPlainObject(parsed)) {
        malformed += 1;
        continue;
      }
      const { ts, runId, kind } = parsed;
      if (typeof ts !== 'string' || typeof runId !== 'string' || typeof kind !== 'string') {
        malformed += 1;
        continue;
      }
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs)) {
        malformed += 1;
        continue;
      }
      if (sinceMs !== null && tsMs < sinceMs) continue; // before `--since` — filtered out, not counted as malformed or aggregated
      lines += 1;
      kept.push({ ts, tsMs, runId, kind, payload: parsed });
    }
  }
  kept.sort((a, b) => a.tsMs - b.tsMs); // stable sort → same-`ts` lines keep file (= emission) order, so the walk sees events causally
  return { kept, lines, malformed };
}

function quartiles(values: readonly number[]): { min: number; p50: number; p90: number; max: number; mean: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return { min: s[0] as number, p50: at(0.5), p90: at(0.9), max: s[s.length - 1] as number, mean: sum / values.length };
}

/** Record a would-be quote's visible-life age (seconds it was on the visible book) on its *first* terminal event (soft-cancel / replace-of / expire). No-op if the hash wasn't seen as a `would-submit`/`would-replace`-new (e.g. it predates the log window), or if its age is already recorded, or if the computed age is negative (clock skew). */
function recordAgeIfFirst(quotes: Map<string, WalkedQuote>, hash: string, terminalTsSec: number, completedAges: number[]): void {
  const q = quotes.get(hash);
  if (q === undefined || q.ageRecorded) return;
  q.ageRecorded = true;
  const age = terminalTsSec - q.submitTsSec;
  if (age >= 0) completedAges.push(age);
}

/**
 * Aggregate one or more NDJSON event logs into a {@link RunSummary} (DESIGN §11,
 * §2.3). `logPaths` are read in order; their lines are merged, parsed (a line that
 * isn't a JSON object with string `ts`/`runId`/`kind` and a parseable `ts` is
 * counted in `malformedLines` and skipped), optionally filtered to events at/after
 * `opts.sinceIso`, then walked in `ts` order to reconstruct the latent-exposure
 * peak and the per-quote visible-life ages, and counted into the §2.3 metrics. Pure
 * apart from `readFileSync` on each path (a missing/unreadable path throws — the CLI
 * resolves paths via {@link listRunLogs}, which returns only existing files).
 *
 * Dry-run metrics + the live-mode metrics (fill rate / gas / fees /
 * settlement outcomes / realized P&L — see {@link LiveMetrics}) are fully
 * computed; only unrealized P&L over still-active positions remains as a
 * Phase-3 follow-up (it requires `summarize` to accept an `OspexAdapter`).
 *
 * If `opts.polToUsdcRate` is supplied, `liveMetrics.gas.totalUsdcEquivWei6`
 * is populated by converting `totalPolWei` through that rate. The CLI feeds
 * `config.gas.nativeTokenUSDCPrice` iff `config.gas.reportInUSDC: true`;
 * otherwise the field stays `null`.
 */
export function summarize(logPaths: readonly string[], opts: { sinceIso?: string; polToUsdcRate?: number } = {}): RunSummary {
  const sinceMs = opts.sinceIso !== undefined ? parseSinceOrThrow(opts.sinceIso) : null;
  const { kept, lines, malformed } = readAndParse(logPaths, sinceMs);

  const eventCounts: Record<string, number> = {};
  for (const k of TELEMETRY_KINDS) eventCounts[k] = 0;
  const runIdSet = new Set<string>();
  let ticks = 0;
  let candTotal = 0;
  let candTracked = 0;
  const candSkipReasons: Record<string, number> = {};
  let qiTotal = 0;
  let qiCanQuote = 0;
  let qiRefused = 0;
  let wouldSubmit = 0;
  let wouldReplaceTotal = 0;
  const wouldReplaceByReason: Record<string, number> = {};
  let wouldSoftCancelTotal = 0;
  const wouldSoftCancelByReason: Record<string, number> = {};
  let expired = 0;
  let compSamples = 0;
  let compAtOrInside = 0;
  const compVsRef: number[] = [];
  let compUnavailable = 0;
  let staleQuoteIncidents = 0;
  const degradedByReason: Record<string, number> = {};
  let errTotal = 0;
  const errByPhase: Record<string, number> = {};
  let kill: { reason: string; ticks: number } | null = null;

  // Live-mode metric accumulators (DESIGN §2.3 / §11). `submit` + `replace`
  // contribute to `quotedUsdcWei6` (USDC the maker committed); `fill` events
  // contribute to `filledUsdcWei6`. The on-chain ops (`approval` /
  // `onchain-cancel` / `settle` / `claim`) sum `gasPolWei` into the per-kind
  // gas attribution. `settle` / `claim` contribute to the settlement counts;
  // `claim.payoutWei6` sums into `totalClaimedPayoutWei6`. All zero under a
  // pure dry-run log (those events don't get emitted).
  let quotedWei6 = 0n;
  let filledWei6 = 0n;
  let settleCount = 0;
  let claimCount = 0;
  let totalClaimedPayoutWei6 = 0n;
  // `totalFeeUsdcWei6` is genuinely zero in v0 (no maker-side USDC fees — no
  // lazy-creation path) but the aggregator is kept so a future fee-bearing
  // event can sum into it without a walker change. `const` because no `let`
  // path mutates it yet.
  const totalFeeUsdcWei6 = 0n;
  const gasByKind: LiveGasByKind = { approval: '0', onchainCancel: '0', settle: '0', claim: '0' };
  const addGas = (kind: keyof LiveGasByKind, gasPolWei: bigint): void => {
    gasByKind[kind] = (BigInt(gasByKind[kind]) + gasPolWei).toString();
  };
  /** Helper: read a `gasPolWei` decimal-string field from a payload, returning 0n when missing/malformed. */
  const readGas = (v: unknown): bigint => (isWei6String(v) ? BigInt(v) : 0n);

  // Realized-P&L cross-event correlation tables. For each unique
  // `(speculationId, makerSide)` position seen in this log: track cumulative
  // own stake from `fill` events. Track per-speculation `winSide` from
  // `settle` events (a contest-level outcome — same value on both sides). Track
  // per-position `{payout, result?}` from `claim` events — `result` (added in
  // PR (g-iii-a)) is the definitive `'won' | 'push' | 'void'` outcome from the
  // SDK's `ClaimablePositionView.result`, captured by the runner during the
  // position poll and propagated through the claim payload. The post-walk
  // pass combines these into win / loss / push / wonUnclaimed / unsettled
  // buckets — `claim.result` takes precedence over `settle.winSide` for the
  // bucket verdict (a `--since` window can clip the settle event but the
  // claim event carries the outcome directly).
  const stakesByPosition = new Map<string, bigint>(); // key = `${speculationId}:${makerSide}`
  const outcomeBySpeculation = new Map<string, string>(); // speculationId → winSide ('away' | 'home' | 'push' | 'void' | …)
  const claimByPosition = new Map<string, { payout: bigint; result?: 'won' | 'push' | 'void' }>();
  const isMakerSide = (v: unknown): v is 'away' | 'home' => v === 'away' || v === 'home';
  const isClaimResult = (v: unknown): v is 'won' | 'push' | 'void' => v === 'won' || v === 'push' || v === 'void';

  // The `ts`-ordered walk: track each posted would-be quote by its synthetic hash to
  // reconstruct the running `visibleOpen + softCancelled-not-yet-expired` risk (peak)
  // and the per-quote visible-life ages. A `would-soft-cancel` / `would-replace`-of /
  // `expire` records the quote's visible age; only `expire` removes it from the latent
  // bucket (an off-chain cancel leaves the signed payload matchable until expiry).
  const quotes = new Map<string, WalkedQuote>();
  let runningLatentWei6 = 0n;
  let peakLatentWei6 = 0n;
  const completedAges: number[] = [];
  const bump = (m: Record<string, number>, k: string): void => void (m[k] = (m[k] ?? 0) + 1);

  for (const ln of kept) {
    runIdSet.add(ln.runId);
    eventCounts[ln.kind] = (eventCounts[ln.kind] ?? 0) + 1;
    const p = ln.payload;
    const tsSec = Math.floor(ln.tsMs / 1000);
    switch (ln.kind) {
      case 'tick-start':
        ticks += 1;
        break;
      case 'candidate': {
        candTotal += 1;
        if (typeof p.skipReason === 'string') {
          bump(candSkipReasons, p.skipReason);
          if (p.skipReason === 'stale-reference') staleQuoteIncidents += 1;
        } else {
          candTracked += 1;
        }
        break;
      }
      case 'quote-intent':
        qiTotal += 1;
        if (p.canQuote === true) qiCanQuote += 1;
        else qiRefused += 1;
        break;
      case 'quote-competitiveness':
        compSamples += 1;
        if (p.atOrInsideBook === true) compAtOrInside += 1;
        if (typeof p.vsReferenceTicks === 'number' && Number.isFinite(p.vsReferenceTicks)) compVsRef.push(p.vsReferenceTicks);
        break;
      case 'competitiveness-unavailable':
        compUnavailable += 1;
        break;
      case 'would-submit': {
        wouldSubmit += 1;
        if (typeof p.commitmentHash === 'string' && isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotes.set(p.commitmentHash, { riskWei6: risk, submitTsSec: tsSec, ageRecorded: false, alive: true });
          runningLatentWei6 += risk;
          if (runningLatentWei6 > peakLatentWei6) peakLatentWei6 = runningLatentWei6;
        }
        break;
      }
      case 'would-replace': {
        wouldReplaceTotal += 1;
        if (typeof p.reason === 'string') {
          bump(wouldReplaceByReason, p.reason);
          if (p.reason === 'stale') staleQuoteIncidents += 1;
        }
        if (typeof p.replacedCommitmentHash === 'string') recordAgeIfFirst(quotes, p.replacedCommitmentHash, tsSec, completedAges);
        if (typeof p.newCommitmentHash === 'string' && isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotes.set(p.newCommitmentHash, { riskWei6: risk, submitTsSec: tsSec, ageRecorded: false, alive: true });
          runningLatentWei6 += risk;
          if (runningLatentWei6 > peakLatentWei6) peakLatentWei6 = runningLatentWei6;
        }
        break;
      }
      case 'would-soft-cancel': {
        wouldSoftCancelTotal += 1;
        if (typeof p.reason === 'string') {
          bump(wouldSoftCancelByReason, p.reason);
          if (p.reason === 'stale') staleQuoteIncidents += 1;
        }
        if (typeof p.commitmentHash === 'string') recordAgeIfFirst(quotes, p.commitmentHash, tsSec, completedAges);
        break;
      }
      case 'expire': {
        expired += 1;
        if (typeof p.commitmentHash === 'string') {
          recordAgeIfFirst(quotes, p.commitmentHash, tsSec, completedAges); // if it expired while still visibleOpen, this is its first terminal event
          const q = quotes.get(p.commitmentHash);
          if (q !== undefined && q.alive) {
            q.alive = false;
            runningLatentWei6 -= q.riskWei6;
            if (runningLatentWei6 < 0n) runningLatentWei6 = 0n;
          }
        }
        break;
      }
      case 'degraded':
        if (typeof p.reason === 'string') bump(degradedByReason, p.reason);
        break;
      case 'error': {
        errTotal += 1;
        bump(errByPhase, typeof p.phase === 'string' ? p.phase : '(none)');
        break;
      }
      case 'kill': {
        const reason = typeof p.reason === 'string' ? p.reason : 'unknown';
        const t = typeof p.ticks === 'number' && Number.isFinite(p.ticks) ? p.ticks : 0;
        kill = { reason, ticks: t };
        break;
      }
      // ── live-mode (Phase 3 g-i) — fill rate / gas / settlements / fees ──
      case 'submit': {
        if (isWei6String(p.riskAmountWei6)) quotedWei6 += BigInt(p.riskAmountWei6);
        break;
      }
      case 'replace': {
        if (isWei6String(p.riskAmountWei6)) quotedWei6 += BigInt(p.riskAmountWei6);
        break;
      }
      case 'fill': {
        if (isWei6String(p.newFillWei6)) {
          const delta = BigInt(p.newFillWei6);
          filledWei6 += delta;
          // Realized-P&L: accumulate per-position own stake. Both commitment-diff
          // and position-poll `fill` sources carry `speculationId` + `makerSide`.
          if (typeof p.speculationId === 'string' && isMakerSide(p.makerSide)) {
            const key = `${p.speculationId}:${p.makerSide}`;
            stakesByPosition.set(key, (stakesByPosition.get(key) ?? 0n) + delta);
          }
        }
        break;
      }
      case 'approval': {
        addGas('approval', readGas(p.gasPolWei));
        break;
      }
      case 'onchain-cancel': {
        addGas('onchainCancel', readGas(p.gasPolWei));
        break;
      }
      case 'settle': {
        settleCount += 1;
        addGas('settle', readGas(p.gasPolWei));
        // Realized-P&L: capture the contest-level outcome. Last-write-wins on a
        // duplicate (a maker quoting both sides emits two `settle` events for
        // the same speculation, but they both carry the same `winSide` — the
        // contest's outcome is contest-level, not per-position).
        if (typeof p.speculationId === 'string' && typeof p.winSide === 'string') {
          outcomeBySpeculation.set(p.speculationId, p.winSide);
        }
        break;
      }
      case 'claim': {
        claimCount += 1;
        addGas('claim', readGas(p.gasPolWei));
        if (isWei6String(p.payoutWei6)) {
          const payout = BigInt(p.payoutWei6);
          totalClaimedPayoutWei6 += payout;
          // Realized-P&L: per-position payout + result. Idempotent on a
          // duplicate (the claim event only fires once per position on chain;
          // this is just defense against an over-eager log replay). `result`
          // is the runner-emitted outcome from `ClaimablePositionView.result`
          // (added in PR (g-iii-a)); absent on logs from before that PR
          // and on `--since` windows that clip the position-poll observation
          // — in either case the classifier falls back to settle.winSide.
          if (typeof p.speculationId === 'string' && isMakerSide(p.makerSide)) {
            const entry: { payout: bigint; result?: 'won' | 'push' | 'void' } = { payout };
            if (isClaimResult(p.result)) entry.result = p.result;
            claimByPosition.set(`${p.speculationId}:${p.makerSide}`, entry);
          }
        }
        break;
      }
      default:
        break; // `fair-value` / `risk-verdict` / `soft-cancel` / `nonce-floor-raise` / `position-transition` — counted in `eventCounts` only (no derived metric here in g-i)
    }
  }

  const vsRefStats = quartiles(compVsRef);
  const ageStats = quartiles(completedAges);

  // Compose the live metrics. `fillRate` is null when nothing was quoted
  // (division-by-zero on the empty dry-run case). `totalUsdcEquivWei6` is
  // null unless the caller supplied a POL→USDC rate (the CLI passes
  // `config.gas.nativeTokenUSDCPrice` iff `config.gas.reportInUSDC: true`).
  // Convert POL wei18 × rate to USDC wei6: usdcWei6 = round(polWei18 × rate × 10^-12).
  const totalPolWei = BigInt(gasByKind.approval) + BigInt(gasByKind.onchainCancel) + BigInt(gasByKind.settle) + BigInt(gasByKind.claim);
  let totalUsdcEquivWei6: string | null = null;
  if (opts.polToUsdcRate !== undefined && Number.isFinite(opts.polToUsdcRate) && opts.polToUsdcRate >= 0) {
    // wei18 (POL) × USDC-per-POL → USDC wei6 = wei18 × rate / 10^12. Do the
    // float multiply on (wei18 / 1e18) × rate × 1e6 so the rate's significant
    // figures survive without bigint↔float gymnastics; a daily-budget POL
    // figure fits well within Number range.
    const polFloat = Number(totalPolWei) / 1e18;
    const usdcWei6 = BigInt(Math.round(polFloat * opts.polToUsdcRate * 1e6));
    totalUsdcEquivWei6 = usdcWei6.toString();
  }
  // ── realized-P&L post-walk ──────────────────────────────────────────────
  // For each position with at least one fill, classify by what we know.
  // **The runner-emitted `claim.result` (PR (g-iii-a)) is the authoritative
  // outcome when present** — it comes from the SDK's
  // `ClaimablePositionView.result` (`'won' | 'push' | 'void'`) captured during
  // the position-status poll, so it doesn't depend on a `settle` event being
  // in the same `--since` window. When it's absent (older logs, or a
  // window-clipped position-poll observation), the classifier falls back to
  // `settle.winSide`-derivation — which itself orders push/void before "claim
  // = won" so the runner's auto-claim on a refund doesn't miscount (Hermes
  // review-PR33 blocker, preserved).
  //
  // Final order:
  //   1. claim.result ∈ {'push', 'void'} → push (whatever payout came with it
  //      was a refund, ignored).
  //   2. settle.winSide ∈ {'push', 'void'} → push (no claim.result; falls back
  //      to the contest-level verdict; same posture as above).
  //   3. claim.result === 'won' → won (use payout).
  //   4. claim present without `result` AND (settle missing OR settle agrees) →
  //      won. Outcome-unknown is the externally-settled / window-clipped case;
  //      outcome-matches is the normal winning path.
  //   5. no settle and no claim → unsettled.
  //   6. settle.winSide ≠ makerSide (and not push/void) → lost. A stray
  //      claim in this case is anomalous; the outcome verdict wins.
  //   7. settle.winSide === makerSide and no claim → wonUnclaimed.
  let netRealizedPnlWei6 = 0n;
  let claimedProfitWei6 = 0n;
  let realizedLossWei6 = 0n;
  let wonCount = 0;
  let lostCount = 0;
  let pushCount = 0;
  let wonUnclaimedCount = 0;
  let unsettledCount = 0;
  for (const [key, stake] of stakesByPosition) {
    const idx = key.indexOf(':');
    const speculationId = key.slice(0, idx);
    const makerSide = key.slice(idx + 1); // 'away' | 'home'
    const outcome = outcomeBySpeculation.get(speculationId);
    const claim = claimByPosition.get(key);

    // (1) claim.result is authoritative — push / void here means the claim
    // was a refund, regardless of whether settle.winSide is in the window.
    if (claim?.result === 'push' || claim?.result === 'void') {
      pushCount += 1;
      continue;
    }
    // (2) push / void from the settle event (claim.result absent — older logs
    // or window-clipped). Discards any claim event that may have fired for
    // the refund.
    if (outcome === 'push' || outcome === 'void') {
      pushCount += 1;
      continue;
    }
    // (3) claim.result === 'won' — authoritative win.
    if (claim?.result === 'won') {
      const profit = claim.payout - stake;
      netRealizedPnlWei6 += profit;
      claimedProfitWei6 += profit;
      wonCount += 1;
      continue;
    }
    // (4) winning claim without result (older log): trust the claim when the
    // outcome is unknown (externally settled / `--since`-clipped) or agrees
    // with makerSide.
    if (claim !== undefined && (outcome === undefined || outcome === makerSide)) {
      const profit = claim.payout - stake;
      netRealizedPnlWei6 += profit;
      claimedProfitWei6 += profit;
      wonCount += 1;
      continue;
    }
    // (5) no settle and no claim → unsettled.
    if (outcome === undefined) {
      unsettledCount += 1;
      continue;
    }
    // (6) settled against the maker (and not push/void) → lost. A stray
    // claim event in this case is anomalous; the outcome verdict wins.
    if (outcome !== makerSide) {
      netRealizedPnlWei6 -= stake;
      realizedLossWei6 += stake;
      lostCount += 1;
      continue;
    }
    // (7) outcome === makerSide AND no claim — paper profit; payout pending.
    wonUnclaimedCount += 1;
  }

  const liveMetrics: LiveMetrics = {
    fills: {
      quotedUsdcWei6: quotedWei6.toString(),
      filledUsdcWei6: filledWei6.toString(),
      fillRate: quotedWei6 === 0n ? null : Number(filledWei6) / Number(quotedWei6),
    },
    gas: {
      totalPolWei: totalPolWei.toString(),
      byKind: gasByKind,
      totalUsdcEquivWei6,
    },
    settlements: {
      settleCount,
      claimCount,
      totalClaimedPayoutWei6: totalClaimedPayoutWei6.toString(),
    },
    realizedPnl: {
      netUsdcWei6: netRealizedPnlWei6.toString(),
      claimedProfitUsdcWei6: claimedProfitWei6.toString(),
      realizedLossUsdcWei6: realizedLossWei6.toString(),
      wonCount,
      lostCount,
      pushCount,
      wonUnclaimedCount,
      unsettledCount,
    },
    totalFeeUsdcWei6: totalFeeUsdcWei6.toString(),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [...logPaths],
    lines,
    malformedLines: malformed,
    runIds: [...runIdSet].sort(),
    firstEventAt: kept[0]?.ts ?? null,
    lastEventAt: kept[kept.length - 1]?.ts ?? null,
    ticks,
    eventCounts,
    candidates: { total: candTotal, tracked: candTracked, skipReasons: candSkipReasons },
    quoteIntents: { total: qiTotal, canQuote: qiCanQuote, refused: qiRefused },
    wouldSubmit,
    wouldReplace: { total: wouldReplaceTotal, byReason: wouldReplaceByReason },
    wouldSoftCancel: { total: wouldSoftCancelTotal, byReason: wouldSoftCancelByReason },
    expired,
    quoteCompetitiveness: {
      samples: compSamples,
      atOrInsideBookCount: compAtOrInside,
      atOrInsideBookRate: compSamples > 0 ? compAtOrInside / compSamples : null,
      vsReferenceTicks: vsRefStats === null ? null : { min: vsRefStats.min, p50: vsRefStats.p50, mean: vsRefStats.mean, max: vsRefStats.max },
      unavailable: compUnavailable,
    },
    quoteAgeSeconds: ageStats === null ? null : { samples: completedAges.length, p50: ageStats.p50, p90: ageStats.p90, max: ageStats.max },
    latentExposurePeakWei6: peakLatentWei6.toString(),
    staleQuoteIncidents,
    degradedByReason,
    errors: { total: errTotal, byPhase: errByPhase },
    kill,
    liveMetrics,
  };
}
