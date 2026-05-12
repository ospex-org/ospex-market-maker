/**
 * `ospex-mm summary [--since <ts>] [--json]` — aggregate the NDJSON event logs
 * under `telemetry.logDir` into the §2.3 run metrics (DESIGN §11). Read-only.
 *
 * Mirrors `doctor` / `quote`: a function returning a typed report (here the
 * `RunSummary` itself) + JSON / text renderers + an exit-code helper. Always exits
 * `0` — a summary is a report, not a check; operational failures (an unreadable log
 * directory or file, a malformed `--since`) throw, and the CLI maps those to exit 1.
 *
 * In dry-run logs (all there are in v0) it computes the would-be-stale rate, the
 * quote-competitiveness numbers, the latent-exposure peak, the quote-age
 * distribution, the candidate-skip histogram, and the error counts. The live-mode
 * metrics — fill rate, P&L, gas, fees, settlement outcomes — are Phase 3 (the live
 * events and their payloads don't exist yet; they show up in `eventCounts`).
 *
 * The `listRunLogs` / `summarize` calls are injectable so the wiring is testable
 * without touching the filesystem.
 */

import type { Config } from '../config/index.js';
import { listRunLogs as listRunLogsImpl, summarize as summarizeImpl, type RunSummary } from '../telemetry/index.js';

export type { RunSummary };

// ── opts + deps ──────────────────────────────────────────────────────────────

export interface SummaryOpts {
  config: Config;
  /** `--since <ts>` — only aggregate events at/after this ISO-8601 timestamp. */
  sinceIso?: string;
}

/** Injectable seams so `runSummary` can be exercised without touching the filesystem. */
export interface SummaryDeps {
  listRunLogs?: (logDir: string) => string[];
  summarize?: (logPaths: readonly string[], opts?: { sinceIso?: string }) => RunSummary;
}

// ── the command ──────────────────────────────────────────────────────────────

/** Resolve the run-log files under `config.telemetry.logDir` and aggregate them into a {@link RunSummary}. Throws on an unreadable log dir/file or a malformed `--since`. */
export function runSummary(opts: SummaryOpts, deps: SummaryDeps = {}): RunSummary {
  const list = deps.listRunLogs ?? listRunLogsImpl;
  const aggregate = deps.summarize ?? summarizeImpl;
  const paths = list(opts.config.telemetry.logDir);
  return aggregate(paths, opts.sinceIso !== undefined ? { sinceIso: opts.sinceIso } : undefined);
}

/** A summary is informational — always exit `0`. (Operational failures throw; the CLI maps those to exit 1.) */
export function summaryExitCode(_summary: RunSummary): number {
  return 0;
}

// ── renderers ────────────────────────────────────────────────────────────────

/** Write the JSON envelope `{ schemaVersion: 1, summary: RunSummary }` to `out` — stable agent contract (DESIGN §11). */
export function renderSummaryReportJson(summary: RunSummary, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, summary })}\n`);
}

/** Write the human-readable summary to `out`. Not a stable contract — use `--json` for parsing. `logDir` is shown when there were no logs. */
export function renderSummaryReportText(summary: RunSummary, logDir: string, out: { write(s: string): void }): void {
  out.write(`ospex-mm summary\n\n`);
  if (summary.sources.length === 0) {
    out.write(`No event logs found under ${logDir} — run \`ospex-mm run --dry-run\` first.\n`);
    return;
  }

  out.write(`logs:      ${summary.sources.length} file(s) under ${logDir}\n`);
  out.write(`runs:      ${summary.runIds.join(', ') || '(none)'}\n`);
  out.write(`window:    ${summary.firstEventAt ?? '(empty)'} … ${summary.lastEventAt ?? '(empty)'}\n`);
  out.write(`lines:     ${summary.lines}${summary.malformedLines > 0 ? ` (+${summary.malformedLines} malformed, skipped)` : ''}\n`);
  out.write(`ticks:     ${summary.ticks}\n`);
  out.write(`shutdown:  ${summary.kill ? `${summary.kill.reason} after ${summary.kill.ticks} tick(s)` : '(no kill event — still running, or crashed)'}\n\n`);

  out.write(`Candidates: ${summary.candidates.total} considered — ${summary.candidates.tracked} tracked${histogramSuffix(summary.candidates.skipReasons, ', skipped:')}\n`);
  out.write(`Quote intents: ${summary.quoteIntents.total} (${summary.quoteIntents.canQuote} priced, ${summary.quoteIntents.refused} refused)\n`);
  out.write(`Would-be: submit ${summary.wouldSubmit}  replace ${summary.wouldReplace.total}${parenHistogram(summary.wouldReplace.byReason)}  soft-cancel ${summary.wouldSoftCancel.total}${parenHistogram(summary.wouldSoftCancel.byReason)}  expire ${summary.expired}\n`);
  out.write(`Stale-quote incidents: ${summary.staleQuoteIncidents}\n`);

  const qc = summary.quoteCompetitiveness;
  out.write(`\nQuote competitiveness (dry-run): ${qc.samples} sample(s)`);
  if (qc.samples > 0) {
    out.write(` — at/inside the book ${qc.atOrInsideBookCount}/${qc.samples} (${pctOrNa(qc.atOrInsideBookRate)})`);
    if (qc.vsReferenceTicks) out.write(`; vs reference (ticks): min ${qc.vsReferenceTicks.min} / p50 ${qc.vsReferenceTicks.p50} / mean ${qc.vsReferenceTicks.mean.toFixed(1)} / max ${qc.vsReferenceTicks.max}`);
  }
  if (qc.unavailable > 0) out.write(`; ${qc.unavailable} unavailable (orderbook not populated)`);
  out.write(`\n`);

  if (summary.quoteAgeSeconds) {
    const a = summary.quoteAgeSeconds;
    out.write(`Quote age (s) over ${a.samples} completed quote(s): p50 ${a.p50} / p90 ${a.p90} / max ${a.max}\n`);
  } else {
    out.write(`Quote age: no completed quotes\n`);
  }
  out.write(`Latent-exposure peak: ${formatUsdcWei6(summary.latentExposurePeakWei6)} USDC (${summary.latentExposurePeakWei6} wei6)\n`);

  out.write(`Degraded events: ${histogramText(summary.degradedByReason) || 'none'}\n`);
  out.write(`Errors: ${summary.errors.total}${summary.errors.total > 0 ? ` — by phase: ${histogramText(summary.errors.byPhase)}` : ''}\n`);

  out.write(`\nLive-mode metrics (fill rate, P&L, gas, fees, settlements): not computed yet — Phase 3 (those events show up in the event-count histogram below).\n`);
  out.write(`Event counts: ${histogramText(nonZero(summary.eventCounts)) || '(none)'}\n`);
}

// ── tiny render helpers ──────────────────────────────────────────────────────

function histogramText(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}
function histogramSuffix(m: Record<string, number>, prefix: string): string {
  const text = histogramText(m);
  return text === '' ? '' : `${prefix} ${text}`;
}
function parenHistogram(m: Record<string, number>): string {
  const text = histogramText(m);
  return text === '' ? '' : ` (${text})`;
}
function nonZero(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(m)) if (n > 0) out[k] = n;
  return out;
}
function pctOrNa(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}
/** A non-negative wei6 decimal string → a `USDC.dddddd` display. */
function formatUsdcWei6(wei6: string): string {
  const n = BigInt(wei6);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${frac}`;
}
