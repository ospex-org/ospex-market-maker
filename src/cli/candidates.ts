/**
 * `ospex-mm candidates` — read-only operator preflight (no DESIGN § yet; spec'd
 * for the live-test setup workflow). Answers two questions in one listing:
 *
 *   (a) which contests could the MM quote *right now* (`quote_ready` — verified,
 *       open moneyline speculation, reference odds when required), and
 *   (b) which upcoming games could be *turned into* quotable contests
 *       (`setup` — uncreated, creatable, priced upstream), plus the
 *       in-between states (`needs_verification`, `needs_moneyline_speculation`).
 *
 * Strictly read-only and signer-free: built on the read-only adapter, it never
 * writes, never touches a keystore, and never prompts. Discovery shows the
 * whole window — unlike the run loop it does NOT hide anything by allow-list
 * (items are annotated with `inContestAllowList` instead so the operator can
 * see what a live run would actually quote); the deny-list DOES skip.
 *
 * An empty listing is a valid answer (exit 0) — contests exist only after
 * someone creates and verifies them on chain, and an off-season board is
 * legitimately empty. Operational failures (config load, API unreachable)
 * throw — the CLI catches and exits 1.
 */

import type { Config, Sport } from '../config/index.js';
import { KNOWN_SPORTS } from '../config/index.js';
import type { ContestView, GameView, GamesListOptions, OspexAdapter } from '../ospex/index.js';

// ── report shape (the `{ schemaVersion: 1, candidates: … }` JSON contract) ───

export type CandidateKind =
  | 'quote_ready'
  | 'needs_moneyline_speculation'
  | 'needs_verification'
  | 'setup'
  | 'skipped';

/**
 * Why an in-window item is not actionable. Names align with the runner's
 * `CandidateSkipReason` vocabulary where the semantics match
 * (`no-reference-odds`); the rest are discovery-specific.
 */
export const CANDIDATES_SKIP_REASONS = [
  'started-or-live', //                  game status live/final, or a contest whose matchTime has passed
  'no-odds', //                          uncreated game with hasOdds=false — nothing to price against
  'no-reference-odds', //                quote-path reference odds missing, incomplete, or the snapshot fetch failed
  'cannot-create-contest', //            uncreated game with canCreateContest=false
  'deny-list', //                        contestId in marketSelection.contestDenyList
  'not-quotable-status', //              contest scored/voided — quoting is closed
  'game-status-postponed-or-cancelled',
] as const;
export type CandidatesSkipReason = (typeof CANDIDATES_SKIP_REASONS)[number];

/** Latest reference moneyline for a quote-ready contest (either side can be null if the upstream hasn't priced it). */
export interface ReferenceMoneyline {
  awayAmerican: number | null;
  homeAmerican: number | null;
}

/**
 * Fields every candidate item carries. Game-derived fields (`gameId`, `slug`,
 * `status`, `hasOdds`, `canCreateContest`) are `null` when a contest in the
 * window has no game row to join (the schedule and the contest list are
 * separate sources); `slug` is display-only and mutable — key on `gameId`.
 */
export interface CandidateItemBase {
  gameId: string | null;
  slug: string | null;
  sport: string;
  /** Full team name (never a bare home/away label). */
  awayTeam: string;
  /** Full team name (never a bare home/away label). */
  homeTeam: string;
  /** ISO-8601 UTC. */
  matchTime: string;
  /** Game status (`upcoming` / `live` / `final` / `postponed` / `cancelled`); null when no game row joined. */
  status: string | null;
  hasOdds: boolean | null;
  canCreateContest: boolean | null;
  contestCreated: boolean;
  contestId: string | null;
  /** The open moneyline speculation id, when one exists on a verified contest. */
  moneylineSpeculationId: string | null;
  /**
   * Present on contest-backed items iff `marketSelection.contestAllowList` is
   * non-empty — discovery hides nothing by allow-list; this flags what a live
   * run would actually quote.
   */
  inContestAllowList?: boolean | undefined;
}

export interface QuoteReadyCandidate extends CandidateItemBase {
  kind: 'quote_ready';
  recommendedAction: 'quote';
  contestStatus: string;
  /** Null only when `requireReferenceOdds: false` let a contest through without complete odds. */
  referenceOdds: ReferenceMoneyline | null;
}

export interface NeedsMoneylineSpeculationCandidate extends CandidateItemBase {
  kind: 'needs_moneyline_speculation';
  recommendedAction: 'seed_moneyline_speculation';
  contestStatus: string;
}

export interface NeedsVerificationCandidate extends CandidateItemBase {
  kind: 'needs_verification';
  recommendedAction: 'wait_for_verification';
  /** Usually `'unverified'`; null when the game row says contestCreated but the contest row isn't visible in the window yet (creation/indexer lag). */
  contestStatus: string | null;
}

export interface SetupCandidate extends CandidateItemBase {
  kind: 'setup';
  recommendedAction: 'create_contest_then_seed_moneyline';
}

export interface SkippedCandidate extends CandidateItemBase {
  kind: 'skipped';
  recommendedAction: null;
  skipReason: CandidatesSkipReason;
  contestStatus?: string | undefined;
}

export type CandidateItem =
  | QuoteReadyCandidate
  | NeedsMoneylineSpeculationCandidate
  | NeedsVerificationCandidate
  | SetupCandidate
  | SkippedCandidate;

export interface CandidatesSummary {
  /** Count of `setup` items — upcoming, uncreated, creatable, priced upstream. */
  gamesAvailableToCreate: number;
  quoteReady: number;
  /** Planning-doc parity alias — always equals `gamesAvailableToCreate`. */
  needsContest: number;
  needsMoneylineSpeculation: number;
  needsVerification: number;
  /** Only nonzero reasons appear. */
  skipped: Partial<Record<CandidatesSkipReason, number>>;
}

export interface CandidatesReport {
  generatedAt: string;
  config: {
    sports: Sport[];
    hours: number;
    /**
     * The contests leg's effective window: `min(hours, 168)` — the contests
     * API caps its window at 168h while the games API allows 720h. Beyond
     * 168h only game rows are visible, so a created game out there classifies
     * `needs_verification` with `contestStatus: null` (its contest row can't
     * be listed) rather than its true contest status.
     */
    contestsHours: number;
    maxTrackedMarkets: number;
    requireReferenceOdds: boolean;
    contestAllowListSize: number;
  };
  summary: CandidatesSummary;
  /** True iff a pagination bound was hit (games or contests) — the listing may be incomplete; never let a bound read as a complete answer. */
  truncated: boolean;
  items: CandidateItem[];
}

// ── CLI flag resolution (exported so the validation paths are unit-testable) ─

export const MIN_HOURS = 1;
/** The games API's maximum look-ahead window. */
export const MAX_HOURS = 720;
/**
 * The contests API's maximum look-ahead window — narrower than the games API's
 * {@link MAX_HOURS} (a request above it is rejected with a 400, not clamped).
 * The contests leg of the listing is capped here so a long `--hours` window
 * still returns the full games/setup side; the report's `config.contestsHours`
 * carries the effective value.
 */
export const MAX_CONTEST_HOURS = 168;

/** Resolve `--sport` (validated against the known sports) or fall back to the config's sports. Throws on an unknown value — the CLI maps it to `fail()`. */
export function resolveSports(flag: string | undefined, config: Config): Sport[] {
  if (flag === undefined) return config.marketSelection.sports;
  const sport = flag.toLowerCase();
  if (!(KNOWN_SPORTS as readonly string[]).includes(sport)) {
    throw new Error(`--sport must be one of ${KNOWN_SPORTS.join(', ')}; got "${flag}"`);
  }
  return [sport as Sport];
}

/** Resolve `--hours` (integer 1–720) or fall back to `marketSelection.maxStartsWithinHours`. Throws on out-of-bounds — the CLI maps it to `fail()`. */
export function resolveHours(flag: string | undefined, config: Config): number {
  if (flag === undefined) {
    const h = config.marketSelection.maxStartsWithinHours;
    if (!Number.isInteger(h) || h < MIN_HOURS || h > MAX_HOURS) {
      throw new Error(
        `config marketSelection.maxStartsWithinHours (${h}) is outside the games-window bounds ${MIN_HOURS}-${MAX_HOURS} — pass --hours <n> explicitly`,
      );
    }
    return h;
  }
  const h = Number(flag);
  if (!Number.isInteger(h) || h < MIN_HOURS || h > MAX_HOURS) {
    throw new Error(`--hours must be an integer between ${MIN_HOURS} and ${MAX_HOURS}; got "${flag}"`);
  }
  return h;
}

// ── opts ─────────────────────────────────────────────────────────────────────

export interface CandidatesOpts {
  config: Config;
  adapter: OspexAdapter;
  /** Resolved sports filter ({@link resolveSports}). */
  sports: Sport[];
  /** Resolved look-ahead window in hours ({@link resolveHours}). */
  hours: number;
  /** Injectable clock for tests. Default: `() => new Date()`. */
  now?: (() => Date) | undefined;
}

// ── pagination ────────────────────────────────────────────────────────────────

/** Server-side maximum page size on both `/v1/games` and `/v1/contests` (larger values are rejected, not clamped). */
const PAGE_LIMIT = 200;
/** Hard bound on pages per source; hitting it sets `truncated: true` rather than silently dropping the tail. */
const MAX_PAGES = 10;

async function fetchGamesWindow(
  adapter: OspexAdapter,
  sports: Sport[],
  hours: number,
): Promise<{ games: GameView[]; truncated: boolean }> {
  // availableOnly defaults to true on the API (only uncreated, creatable,
  // upcoming games) — we need the FULL schedule to classify created/started
  // games, so pass false explicitly.
  const base: GamesListOptions = { hours, availableOnly: false };
  const only = sports.length === 1 ? sports[0] : undefined;
  if (only !== undefined) base.sport = only;

  const seen = new Set<string>();
  const games: GameView[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await adapter.listGames({ ...base, limit: PAGE_LIMIT, offset: page * PAGE_LIMIT });
    for (const g of batch) {
      if (seen.has(g.gameId)) continue; // offset pagination over a moving window can re-deliver a row
      seen.add(g.gameId);
      games.push(g);
    }
    if (batch.length < PAGE_LIMIT) return { games, truncated: false };
  }
  return { games, truncated: true };
}

async function fetchContestsWindow(
  adapter: OspexAdapter,
  sports: Sport[],
  hours: number,
): Promise<{ contests: ContestView[]; truncated: boolean }> {
  // No status filter — needs_verification wants unverified rows and
  // not-quotable-status wants scored/voided rows, so take all statuses
  // in the window and classify locally.
  const base: { sport?: string; hours: number } = { hours };
  const only = sports.length === 1 ? sports[0] : undefined;
  if (only !== undefined) base.sport = only;

  const seen = new Set<string>();
  const contests: ContestView[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await adapter.listContests({ ...base, limit: PAGE_LIMIT, offset: page * PAGE_LIMIT });
    for (const c of batch) {
      if (seen.has(c.contestId)) continue;
      seen.add(c.contestId);
      contests.push(c);
    }
    if (batch.length < PAGE_LIMIT) return { contests, truncated: false };
  }
  return { contests, truncated: true };
}

// ── pipeline ─────────────────────────────────────────────────────────────────

export async function runCandidates(opts: CandidatesOpts): Promise<CandidatesReport> {
  const { config, adapter, sports, hours } = opts;
  const now = opts.now ?? ((): Date => new Date());
  const generated = now();
  const nowMs = generated.getTime();
  const windowEndMs = nowMs + hours * 3_600_000;
  // The contests API rejects windows above 168h (the games API allows 720) —
  // cap the contests leg rather than letting one 400 kill the whole preflight.
  const contestsHours = Math.min(hours, MAX_CONTEST_HOURS);

  // 1. Fetch the full schedule window + the contests window (all statuses).
  const [gamesResult, contestsResult] = await Promise.all([
    fetchGamesWindow(adapter, sports, hours),
    fetchContestsWindow(adapter, sports, contestsHours),
  ]);

  const sportSet = new Set<string>(sports);
  const games = gamesResult.games.filter((g) => sportSet.has(g.sport.toLowerCase()));
  const contests = contestsResult.contests.filter(
    (c) => sportSet.has(c.sport.toLowerCase()) && Date.parse(c.matchTime) <= windowEndMs,
  );

  // 2. Join: a game's contestId is the primary key (contest list rows don't
  //    carry referenceGameId — it's detail-endpoint-only); the reverse
  //    referenceGameId → gameId join is a fallback for rows that do carry it.
  const contestsById = new Map<string, ContestView>();
  const contestsByRefGameId = new Map<string, ContestView>();
  for (const c of contests) {
    contestsById.set(c.contestId, c);
    if (c.referenceGameId !== null) contestsByRefGameId.set(c.referenceGameId, c);
  }

  const denySet = new Set(config.marketSelection.contestDenyList);
  const allowSet = new Set(config.marketSelection.contestAllowList);
  const annotateAllowList = allowSet.size > 0;
  /** Stamp `inContestAllowList` on contest-backed items when the allow-list is in play (discovery never hides by allow-list). */
  const finalize = <T extends CandidateItem>(item: T): T => {
    if (annotateAllowList && item.contestId !== null) {
      return { ...item, inContestAllowList: allowSet.has(item.contestId) };
    }
    return item;
  };

  const items: CandidateItem[] = [];
  /** Contests classified quote-ready-so-far — confirmed against an odds snapshot in step 4. */
  const pendingQuoteReady: Array<{ base: CandidateItemBase; contestStatus: string }> = [];

  // 3. Classify every game (joined with its contest where one exists), then
  //    every contest no game row claimed.
  const consumedContestIds = new Set<string>();
  for (const game of games) {
    const contest =
      (game.contestId !== null ? contestsById.get(game.contestId) : undefined) ??
      contestsByRefGameId.get(game.gameId);
    if (contest !== undefined) consumedContestIds.add(contest.contestId);
    classify(baseFromGame(game, contest), game, contest);
  }
  for (const contest of contests) {
    if (consumedContestIds.has(contest.contestId)) continue;
    classify(baseFromContest(contest), undefined, contest);
  }

  /** Exactly one kind per item. Order of gates: deny-list → game/contest liveness → contest lifecycle → speculation → odds (deferred). */
  function classify(base: CandidateItemBase, game: GameView | undefined, contest: ContestView | undefined): void {
    const contestStatus = contest?.status;

    if (base.contestId !== null && denySet.has(base.contestId)) {
      items.push(finalize(skipped(base, 'deny-list', contestStatus)));
      return;
    }
    if (game !== undefined) {
      if (game.status === 'postponed' || game.status === 'cancelled') {
        items.push(finalize(skipped(base, 'game-status-postponed-or-cancelled', contestStatus)));
        return;
      }
      if (game.status !== 'upcoming') {
        items.push(finalize(skipped(base, 'started-or-live', contestStatus)));
        return;
      }
    }
    if (Date.parse(base.matchTime) < nowMs) {
      // matchTime has passed — every item, game-backed or contest-only. Covers
      // the writer's status-poll lag (a just-started game can briefly still
      // read `upcoming`): nothing past its start is ever actionable.
      items.push(finalize(skipped(base, 'started-or-live', contestStatus)));
      return;
    }

    if (contest !== undefined) {
      if (contest.status === 'scored' || contest.status === 'voided') {
        items.push(finalize(skipped(base, 'not-quotable-status', contest.status)));
        return;
      }
      if (contest.status !== 'verified') {
        items.push(finalize({ ...base, kind: 'needs_verification', recommendedAction: 'wait_for_verification', contestStatus: contest.status }));
        return;
      }
      const spec = contest.speculations.find((s) => s.marketType === 'moneyline' && s.open);
      if (spec === undefined) {
        items.push(finalize({ ...base, kind: 'needs_moneyline_speculation', recommendedAction: 'seed_moneyline_speculation', contestStatus: contest.status }));
        return;
      }
      pendingQuoteReady.push({ base: { ...base, moneylineSpeculationId: spec.speculationId }, contestStatus: contest.status });
      return;
    }

    // No contest row in the window. A created game without one is awaiting
    // creation indexing / verification — same operator action either way —
    // or sits beyond the contests leg's 168h cap, where contest rows can't
    // be listed at all.
    if (game !== undefined && (game.contestCreated || game.contestId !== null)) {
      items.push(finalize({ ...base, kind: 'needs_verification', recommendedAction: 'wait_for_verification', contestStatus: null }));
      return;
    }
    if (game !== undefined) {
      if (!game.hasOdds) {
        items.push(finalize(skipped(base, 'no-odds')));
        return;
      }
      if (!game.canCreateContest) {
        items.push(finalize(skipped(base, 'cannot-create-contest')));
        return;
      }
      items.push(finalize({ ...base, kind: 'setup', recommendedAction: 'create_contest_then_seed_moneyline' }));
    }
  }

  // 4. Confirm reference odds per quote-ready-so-far contest. An individual
  //    snapshot failure degrades that item to `no-reference-odds` — it must
  //    never fail the command.
  await Promise.all(
    pendingQuoteReady.map(async ({ base, contestStatus }) => {
      let reference: ReferenceMoneyline | null = null;
      if (base.contestId !== null) {
        try {
          const snapshot = await adapter.getOddsSnapshot(base.contestId);
          const m = snapshot.odds.moneyline;
          if (m !== null) reference = { awayAmerican: m.awayOddsAmerican, homeAmerican: m.homeOddsAmerican };
        } catch {
          reference = null; // degrade, don't throw — reported as no-reference-odds below (when required)
        }
      }
      const complete = reference !== null && reference.awayAmerican !== null && reference.homeAmerican !== null;
      if (config.marketSelection.requireReferenceOdds && !complete) {
        items.push(finalize(skipped(base, 'no-reference-odds', contestStatus)));
        return;
      }
      items.push(finalize({ ...base, kind: 'quote_ready', recommendedAction: 'quote', contestStatus, referenceOdds: reference }));
    }),
  );

  // 5. Deterministic order: kind priority, then matchTime, then id.
  items.sort(compareItems);

  return {
    generatedAt: generated.toISOString(),
    config: {
      sports,
      hours,
      contestsHours,
      maxTrackedMarkets: config.marketSelection.maxTrackedMarkets,
      requireReferenceOdds: config.marketSelection.requireReferenceOdds,
      contestAllowListSize: config.marketSelection.contestAllowList.length,
    },
    summary: summarize(items),
    truncated: gamesResult.truncated || contestsResult.truncated,
    items,
  };
}

/** `candidates` is informational — a successful listing (even an empty one) exits 0; operational failures throw and the CLI maps them to 1. */
export function candidatesExitCode(_report: CandidatesReport): number {
  return 0;
}

// ── pieces ───────────────────────────────────────────────────────────────────

function baseFromGame(game: GameView, contest: ContestView | undefined): CandidateItemBase {
  return {
    gameId: game.gameId,
    slug: game.slug,
    sport: game.sport,
    awayTeam: game.awayTeam.name,
    homeTeam: game.homeTeam.name,
    matchTime: game.matchTime,
    status: game.status,
    hasOdds: game.hasOdds,
    canCreateContest: game.canCreateContest,
    contestCreated: game.contestCreated || contest !== undefined,
    contestId: contest?.contestId ?? game.contestId,
    moneylineSpeculationId: null,
  };
}

function baseFromContest(contest: ContestView): CandidateItemBase {
  return {
    gameId: contest.referenceGameId, // usually null — list rows don't carry the linkage
    slug: null,
    sport: contest.sport,
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
    matchTime: contest.matchTime,
    status: null,
    hasOdds: null,
    canCreateContest: null,
    contestCreated: true,
    contestId: contest.contestId,
    moneylineSpeculationId: null,
  };
}

function skipped(base: CandidateItemBase, skipReason: CandidatesSkipReason, contestStatus?: string | undefined): SkippedCandidate {
  return {
    ...base,
    kind: 'skipped',
    recommendedAction: null,
    skipReason,
    ...(contestStatus !== undefined ? { contestStatus } : {}),
  };
}

const KIND_ORDER: Record<CandidateKind, number> = {
  quote_ready: 0,
  needs_moneyline_speculation: 1,
  needs_verification: 2,
  setup: 3,
  skipped: 4,
};

function compareItems(a: CandidateItem, b: CandidateItem): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  const byTime = Date.parse(a.matchTime) - Date.parse(b.matchTime);
  if (byTime !== 0) return byTime;
  return (a.contestId ?? a.gameId ?? '').localeCompare(b.contestId ?? b.gameId ?? '');
}

function summarize(items: CandidateItem[]): CandidatesSummary {
  const counts: Record<CandidateKind, number> = {
    quote_ready: 0,
    needs_moneyline_speculation: 0,
    needs_verification: 0,
    setup: 0,
    skipped: 0,
  };
  const skippedByReason: Partial<Record<CandidatesSkipReason, number>> = {};
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.kind === 'skipped') {
      skippedByReason[item.skipReason] = (skippedByReason[item.skipReason] ?? 0) + 1;
    }
  }
  return {
    gamesAvailableToCreate: counts.setup,
    quoteReady: counts.quote_ready,
    needsContest: counts.setup,
    needsMoneylineSpeculation: counts.needs_moneyline_speculation,
    needsVerification: counts.needs_verification,
    skipped: skippedByReason,
  };
}

// ── renderers ────────────────────────────────────────────────────────────────

/** Write the JSON envelope `{ schemaVersion: 1, candidates: CandidatesReport }` to `out` — stable agent contract. */
export function renderCandidatesReportJson(report: CandidatesReport, out: { write(s: string): void }): void {
  out.write(`${JSON.stringify({ schemaVersion: 1, candidates: report })}\n`);
}

/** Write the human-readable listing to `out`. Not a stable contract — use `--json` for parsing (AGENT_CONTRACT §1). All times ISO UTC. */
export function renderCandidatesReportText(report: CandidatesReport, out: { write(s: string): void }): void {
  const c = report.config;
  out.write(`ospex-mm candidates — generated ${report.generatedAt}\n`);
  const windowNote = c.contestsHours < c.hours ? ` (contests leg capped at ${c.contestsHours}h — the contests API max)` : '';
  out.write(
    `Sports: ${c.sports.join(', ')}   Window: next ${c.hours}h${windowNote}   requireReferenceOdds: ${c.requireReferenceOdds}   allow-list: ${
      c.contestAllowListSize === 0 ? '(empty)' : `${c.contestAllowListSize} id(s) — annotated, never filtered`
    }\n\n`);

  const s = report.summary;
  out.write(`Quote-ready: ${s.quoteReady}   Needs moneyline speculation: ${s.needsMoneylineSpeculation}   Needs verification: ${s.needsVerification}   Setup (creatable games): ${s.gamesAvailableToCreate}   Skipped: ${skippedTotal(s)}\n`);
  if (report.truncated) {
    out.write(`WARNING: pagination bound hit — this listing may be incomplete; narrow the window with --hours or --sport.\n`);
  }
  out.write('\n');

  if (report.items.length === 0) {
    out.write('No games or contests in the window. An empty board is a valid state — outside game hours (or off-season) there may be nothing to set up or quote.\n');
    return;
  }

  const rows = report.items.map((item) => [
    item.kind,
    `${item.awayTeam} @ ${item.homeTeam} (${item.sport})`,
    item.matchTime,
    item.contestId ?? '—',
    detailFor(item),
  ]);
  const header = ['KIND', 'AWAY @ HOME', 'MATCH TIME (UTC)', 'CONTEST', 'ACTION / REASON'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ').trimEnd();
  out.write(`${line(header)}\n`);
  for (const row of rows) out.write(`${line(row)}\n`);
}

function skippedTotal(s: CandidatesSummary): number {
  return Object.values(s.skipped).reduce((acc: number, n) => acc + (n ?? 0), 0);
}

function detailFor(item: CandidateItem): string {
  const allowTag = item.inContestAllowList === undefined ? '' : item.inContestAllowList ? ' [allow-listed]' : ' [NOT allow-listed]';
  switch (item.kind) {
    case 'quote_ready': {
      const r = item.referenceOdds;
      const ref = r === null ? 'ref n/a' : `ref away ${signed(r.awayAmerican)} / home ${signed(r.homeAmerican)}`;
      return `quote — ${ref}${allowTag}`;
    }
    case 'needs_moneyline_speculation':
      return `seed_moneyline_speculation${allowTag}`;
    case 'needs_verification':
      return `wait_for_verification${allowTag}`;
    case 'setup':
      return 'create_contest_then_seed_moneyline';
    case 'skipped':
      return `skipped: ${item.skipReason}${allowTag}`;
  }
}

function signed(n: number | null): string {
  if (n === null) return 'n/a';
  return n >= 0 ? `+${n}` : `${n}`;
}
