/**
 * `ospex-mm quote --dry-run <contestId>` — produces a sane two-sided moneyline
 * quote breakdown for a contest (DESIGN §14). Read-only; never posts.
 *
 * The pipeline:
 *   1. Fetch the contest + reference odds via the adapter.
 *   2. Validate the contest is quotable (status; an open moneyline speculation
 *      exists — v0 refuses lazy-creation paths).
 *   3. Build the desired quote via `src/orders/buildDesiredQuote` (strip the vig,
 *      derive the spread, size against the per-side headroom over an *empty
 *      inventory* — the runner reconciles against real positions in Phase 2's
 *      `run`).
 *
 * Operational failures (contest 404, network) throw — the CLI catches and exits
 * 1. Logical refusals (no speculation, no reference odds, …) return a structured
 * `{ pipeline: 'refused', reason }` so the caller can render the context that
 * led to the refusal. The math's own refusal (e.g. spread > maxReasonableSpread
 * or both sides at cap) is encoded by `result.canQuote === false` and is
 * reported as part of the computed pipeline.
 */

import type { Config } from '../config/index.js';
import { buildDesiredQuote, type ReferenceOddsBreakdown } from '../orders/index.js';
import type { OspexAdapter, OddsSnapshotView } from '../ospex/index.js';
import type { QuoteResult } from '../pricing/index.js';

// ── report shape ─────────────────────────────────────────────────────────────

/** Context every report carries — the contest the quote is about. */
export interface QuoteContext {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  /** ISO-8601. */
  matchTime: string;
  /** `'unverified' | 'verified' | 'scored' | 'voided'` (SDK widens to string). */
  status: string;
  /** Upstream reference-game id (neutral term — DESIGN §16). `null` if no upstream linkage. */
  referenceGameId: string | null;
}

/**
 * `runQuote`'s return: either an upstream refusal (contest closed / no
 * speculation / no reference odds) or a fully-computed quote breakdown.
 * `pipeline === 'computed' && result.canQuote === true` is the only outcome
 * that exits `0`.
 */
export type QuoteReport =
  | {
      pipeline: 'refused';
      contestId: string;
      reason: string;
      context: QuoteContext;
    }
  | {
      pipeline: 'computed';
      contestId: string;
      context: QuoteContext;
      referenceOdds: ReferenceOddsBreakdown;
      spreadMode: 'economics' | 'direct';
      result: QuoteResult;
      /** Reminds the operator that headroom was computed from `{}` — the runner reconciles in `run`. */
      inventoryNote: string;
    };

const INVENTORY_NOTE =
  'Headroom computed from an empty inventory. `run --dry-run` (Phase 2) reconciles against your actual positions and open commitments; this preview is the per-quote ceiling.';

// ── opts ─────────────────────────────────────────────────────────────────────

export interface QuoteOpts {
  contestId: string;
  config: Config;
  adapter: OspexAdapter;
}

// ── pipeline ─────────────────────────────────────────────────────────────────

export async function runQuote(opts: QuoteOpts): Promise<QuoteReport> {
  const { contestId, config, adapter } = opts;

  // 1. Fetch contest + reference odds in parallel. Either failure throws → CLI exits 1.
  const [contest, snapshot] = await Promise.all([
    adapter.getContest(contestId),
    adapter.getOddsSnapshot(contestId),
  ]);

  const context: QuoteContext = {
    contestId: contest.contestId,
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
    sport: contest.sport,
    matchTime: contest.matchTime,
    status: contest.status,
    referenceGameId: contest.referenceGameId,
  };

  // 2. Validate the contest is still quotable.
  if (contest.status === 'scored' || contest.status === 'voided') {
    return refused(contestId, `contest ${contestId} is ${contest.status} — quoting is closed`, context);
  }

  const spec = contest.speculations.find((s) => s.marketType === 'moneyline');
  if (spec === undefined) {
    return refused(
      contestId,
      `no moneyline speculation on contest ${contestId} — v0 quotes only existing speculations (lazy-creation paths are refused — DESIGN §6); seed one separately if you need it`,
      context,
    );
  }
  if (!spec.open) {
    return refused(
      contestId,
      `moneyline speculation ${spec.speculationId} on contest ${contestId} is closed (settled/scored)`,
      context,
    );
  }

  const odds = extractMoneylineOdds(snapshot);
  if (odds === null) {
    return refused(
      contestId,
      `no reference moneyline odds for contest ${contestId} — can't quote without a reference price (DESIGN §10)`,
      context,
    );
  }
  if (odds.awayOddsAmerican === null || odds.homeOddsAmerican === null) {
    return refused(
      contestId,
      `reference moneyline odds for contest ${contestId} are incomplete (away=${odds.awayOddsAmerican}, home=${odds.homeOddsAmerican})`,
      context,
    );
  }

  // 3. Build the desired quote — config + reference odds + headroom over an empty inventory.
  const market = {
    contestId: contest.contestId,
    sport: contest.sport,
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
  };
  const desired = buildDesiredQuote(
    config,
    market,
    { away: odds.awayOddsAmerican, home: odds.homeOddsAmerican },
    { items: [], openCommitmentCount: 0 },
  );

  return {
    pipeline: 'computed',
    contestId,
    context,
    referenceOdds: desired.referenceOdds,
    spreadMode: config.pricing.mode,
    result: desired.result,
    inventoryNote: INVENTORY_NOTE,
  };
}

/** Exit `0` iff the pipeline computed a quote *and* the math said it could quote at least one side. */
export function quoteExitCode(report: QuoteReport): number {
  if (report.pipeline === 'refused') return 1;
  return report.result.canQuote ? 0 : 1;
}

// ── pieces ───────────────────────────────────────────────────────────────────

function refused(contestId: string, reason: string, context: QuoteContext): QuoteReport {
  return { pipeline: 'refused', contestId, reason, context };
}

function extractMoneylineOdds(snapshot: OddsSnapshotView): { awayOddsAmerican: number | null; homeOddsAmerican: number | null } | null {
  const m = snapshot.odds.moneyline;
  if (m === null) return null;
  return { awayOddsAmerican: m.awayOddsAmerican, homeOddsAmerican: m.homeOddsAmerican };
}

// ── renderers ────────────────────────────────────────────────────────────────

/** Write the JSON envelope `{ schemaVersion: 1, quote: QuoteReport }` to `out` — stable agent contract. */
export function renderQuoteReportJson(report: QuoteReport, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, quote: report })}\n`);
}

/** Write the human-readable report to `out`. Not a stable contract — use `--json` for parsing (AGENT_CONTRACT §1). */
export function renderQuoteReportText(report: QuoteReport, out: { write(s: string): void }): void {
  out.write(`ospex-mm quote --dry-run ${report.contestId}\n\n`);
  renderContext(report.context, out);
  out.write('\n');
  if (report.pipeline === 'refused') {
    out.write(`Refused: ${report.reason}\n`);
    return;
  }
  renderReferenceOdds(report.referenceOdds, out);
  out.write('\n');
  renderQuoteResult(report.result, report.spreadMode, out);
  out.write(`\n${report.inventoryNote}\n`);
}

function renderContext(c: QuoteContext, out: { write(s: string): void }): void {
  out.write(`Contest:        ${c.awayTeam} @ ${c.homeTeam} (${c.sport})\n`);
  out.write(`Contest id:     ${c.contestId}\n`);
  out.write(`Match time:     ${c.matchTime}\n`);
  out.write(`Status:         ${c.status}\n`);
  out.write(`Reference game: ${c.referenceGameId ?? '(unlinked)'}\n`);
}

function renderReferenceOdds(r: ReferenceOddsBreakdown, out: { write(s: string): void }): void {
  const pct = (p: number): string => `${(p * 100).toFixed(2)}%`;
  out.write(`Reference odds (moneyline):\n`);
  out.write(`  Away:  ${signed(r.awayOddsAmerican)}  decimal ${r.awayDecimal.toFixed(3)}  implied ${pct(r.awayImpliedProb)}\n`);
  out.write(`  Home:  ${signed(r.homeOddsAmerican)}  decimal ${r.homeDecimal.toFixed(3)}  implied ${pct(r.homeImpliedProb)}\n`);
  out.write(`  Overround: ${pct(r.overround)}\n`);
}

function renderQuoteResult(r: QuoteResult, mode: 'economics' | 'direct', out: { write(s: string): void }): void {
  if (r.fair !== null) {
    const pct = (p: number): string => `${(p * 100).toFixed(2)}%`;
    out.write(`Fair value (vig-stripped):\n`);
    out.write(`  Away:  ${pct(r.fair.awayFairProb)}  decimal ${(1 / r.fair.awayFairProb).toFixed(3)}\n`);
    out.write(`  Home:  ${pct(r.fair.homeFairProb)}  decimal ${(1 / r.fair.homeFairProb).toFixed(3)}\n`);
  }
  if (r.spread !== null) {
    out.write(`Spread:         ${(r.spread * 100).toFixed(2)}%  (${mode} mode)\n`);
    if (r.targetMonthlyReturnUSDC !== null) {
      out.write(`  Target monthly return:           ${r.targetMonthlyReturnUSDC.toFixed(4)} USDC\n`);
    }
    if (r.expectedMonthlyFilledVolumeUSDC !== null) {
      out.write(`  Expected monthly filled volume:  ${r.expectedMonthlyFilledVolumeUSDC.toFixed(2)} USDC\n`);
    }
  }
  out.write('\n');
  if (!r.canQuote) {
    out.write(`Quote: REFUSED — ${r.notes.join('; ') || '(no notes)'}\n`);
    return;
  }
  out.write(`Quote (clean inventory):\n`);
  if (r.away !== null) {
    out.write(
      `  Away:  ${signed(r.away.quoteAmerican)}  tick ${r.away.quoteTick}  decimal ${r.away.quoteDecimal.toFixed(3)}  prob ${(r.away.quoteProb * 100).toFixed(2)}%  size ${r.away.sizeUSDC.toFixed(6)} USDC (${r.away.sizeWei6} wei6)\n`,
    );
  } else {
    out.write(`  Away:  (pulled — no headroom or size rounded to zero)\n`);
  }
  if (r.home !== null) {
    out.write(
      `  Home:  ${signed(r.home.quoteAmerican)}  tick ${r.home.quoteTick}  decimal ${r.home.quoteDecimal.toFixed(3)}  prob ${(r.home.quoteProb * 100).toFixed(2)}%  size ${r.home.sizeUSDC.toFixed(6)} USDC (${r.home.sizeWei6} wei6)\n`,
    );
  } else {
    out.write(`  Home:  (pulled — no headroom or size rounded to zero)\n`);
  }
  if (r.notes.length > 0) {
    out.write(`Notes:\n`);
    for (const n of r.notes) out.write(`  - ${n}\n`);
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
