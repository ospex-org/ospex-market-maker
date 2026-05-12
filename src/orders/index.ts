/**
 * Order lifecycle — the *planning* layer (DESIGN §6, §9). All pure functions —
 * no SDK, no chain. Three pieces:
 *
 *   - `buildDesiredQuote(config, market, refOdds, inventory)` — the single source
 *     of truth for "config + reference odds + per-side exposure headroom → a
 *     two-sided quote". Used by `ospex-mm quote --dry-run` (over an empty
 *     inventory) and by the runner (over the live inventory).
 *   - `inventoryFromState(state, nowUnixSec)` — translate the persisted commitments
 *     + positions into the risk engine's `Inventory` (the aggregate exposure the
 *     caps bind). The runner builds the inventory it hands `buildDesiredQuote`
 *     from this each tick.
 *   - `reconcileBook(currentRecords, desired, config, nowUnixSec)` — given the
 *     maker's current commitments on a speculation and the quote it now wants,
 *     compute what to submit / replace / soft-cancel (DESIGN §9): a fresh quote on
 *     a wanted-but-empty side, a replacement for a stale or mispriced one, a pull
 *     for a side that's no longer quoted or a book-hygiene duplicate.
 *
 * The runner (a later step of the dry-run plan) wires these together; `run --live`
 * (Phase 3) adds the *execution* layer — the actual SDK write calls behind each
 * plan item, plus the authoritative on-chain cancel / nonce-floor paths. In
 * dry-run nothing is posted: the runner logs `would-submit` / `would-replace` /
 * `would-soft-cancel` and mutates the persisted (hypothetical) inventory instead.
 */

import type { Config } from '../config/index.js';
import {
  americanToDecimal,
  computeQuote,
  decimalToImpliedProb,
  tickToDecimal,
  wei6ToUSDC,
  type QuoteInputs,
  type QuoteResult,
  type QuoteSide,
} from '../pricing/index.js';
import { headroomForSide, verdictForMarket, type ExposureItem, type Inventory, type Market, type RiskCaps } from '../risk/index.js';
import type { CommitmentLifecycle, MakerCommitmentRecord, MakerState } from '../state/index.js';

// ── types ────────────────────────────────────────────────────────────────────

/** Reference (consensus) moneyline odds, broken down into both formats + the overround. */
export interface ReferenceOddsBreakdown {
  awayOddsAmerican: number;
  homeOddsAmerican: number;
  awayDecimal: number;
  homeDecimal: number;
  awayImpliedProb: number;
  homeImpliedProb: number;
  /** `awayImpliedProb + homeImpliedProb - 1` — the consensus vig. */
  overround: number;
}

/** What `buildDesiredQuote` produces: the reference-odds breakdown (`null` when the upstream odds were out of range — see `result.notes`), the per-side exposure headroom it priced against, and the `computeQuote` result. */
export interface DesiredQuote {
  referenceOdds: ReferenceOddsBreakdown | null;
  /** Max additional at-risk USDC on each side without breaching a per-{commitment,contest,team,sport} or bankroll cap (`src/risk/headroomForSide`, given the inventory passed in). Always populated, even on a refusal. */
  headroomUSDC: { away: number; home: number };
  result: QuoteResult;
}

/** Reference moneyline odds as the upstream surfaces them (American). `null` per side when not populated. */
export interface ReferenceMoneylineAmerican {
  away: number;
  home: number;
}

/** Why the runner would pull a `visibleOpen` commitment off-chain without re-posting it. */
export type SoftCancelReason =
  | 'side-not-quoted' //   the desired quote has no `QuoteSide` for that side (no headroom, or the whole quote was refused)
  | 'duplicate'; //        more than one `visibleOpen` commitment on a `(speculation, side)` — keep the newest, pull the rest (book hygiene, DESIGN §9)

/** Why the runner would replace a `visibleOpen` commitment: pull it off-chain → post a fresh one at the current price. */
export type ReplaceReason =
  | 'stale' //       older than `orders.staleAfterSeconds`
  | 'mispriced'; //  the quoted tick has moved more than `orders.replaceOnOddsMoveBps` (in implied-probability terms) since it was posted

/** A `visibleOpen` commitment to pull off-chain without re-posting. */
export interface SoftCancelPlan {
  record: MakerCommitmentRecord;
  reason: SoftCancelReason;
}

/** A `visibleOpen` commitment to replace: pull `stale` off-chain, then post `replacement` at the current price. */
export interface ReplacePlan {
  stale: MakerCommitmentRecord;
  reason: ReplaceReason;
  replacement: QuoteSide;
}

/**
 * The runner's plan for one speculation's visible book: which fresh quotes to
 * submit, which existing commitments to replace, which to soft-cancel outright.
 * In dry-run these become `would-submit` / `would-replace` / `would-soft-cancel`
 * telemetry + hypothetical-inventory mutations; live mode (Phase 3) executes them
 * via the SDK. Per DESIGN §9 the *visible* surface ends with ≤ 1 commitment per
 * `(speculation, side)` (transient `softCancelled`-not-yet-expired generations are
 * fine — they're pulled from the API, so not on the visible surface).
 */
export interface BookReconciliation {
  toSubmit: QuoteSide[];
  toReplace: ReplacePlan[];
  toSoftCancel: SoftCancelPlan[];
}

// ── buildDesiredQuote ────────────────────────────────────────────────────────

/**
 * Price a two-sided moneyline quote for `market`. Order: gate on the risk verdict
 * (`verdictForMarket` — the open-commitment count cap, the bankroll exposure
 * ceiling, and "does either side have any headroom?"; `headroomForSide` alone
 * enforces the per-{commitment,contest,team,sport} *size* caps but NOT the count
 * cap — DESIGN §6); then strip the consensus vig, derive the spread (economics or
 * direct mode per `config.pricing`), and size each side against its headroom.
 * Pure — delegates to `src/risk/{verdictForMarket,headroomForSide}` and
 * `src/pricing/computeQuote`.
 *
 * Every operational refusal comes back as `result.canQuote === false` with
 * `result.notes` (each `REFUSE:`-prefixed): the risk verdict refused (count cap /
 * bankroll ceiling / no headroom on either side); the upstream reference odds were
 * out of range (then `referenceOdds` is also `null`); or the math itself refused
 * (spread too wide, lopsided line, out-of-range tick). Throws only on malformed
 * *config-derived* parameters (`computeQuote`'s caller-arg validation) or a
 * malformed `inventory` (the risk engine's runtime guards) — neither of which a
 * parsed `Config` + an `inventoryFromState` result should produce.
 */
export function buildDesiredQuote(
  config: Config,
  market: Market,
  refOdds: ReferenceMoneylineAmerican,
  inventory: Inventory,
): DesiredQuote {
  const caps = toRiskCaps(config);
  const headroomUSDC = {
    away: headroomForSide(inventory, market, 'away', caps),
    home: headroomForSide(inventory, market, 'home', caps),
  };
  const referenceOdds = tryBreakdownReferenceOdds(refOdds);

  const verdict = verdictForMarket(inventory, market, caps);
  if (!verdict.allowed) {
    return { referenceOdds, headroomUSDC, result: refusedResult([`REFUSE: ${verdict.reason}`]) };
  }
  if (referenceOdds === null) {
    return {
      referenceOdds: null,
      headroomUSDC,
      result: refusedResult([`REFUSE: reference moneyline odds are invalid / out of range (away=${refOdds.away}, home=${refOdds.home})`]),
    };
  }

  const inputs = buildQuoteInputs(config, referenceOdds, headroomUSDC.away, headroomUSDC.home);
  const result = computeQuote(inputs);
  return { referenceOdds, headroomUSDC, result };
}

// ── inventoryFromState ───────────────────────────────────────────────────────

/**
 * Commitment lifecycle states whose risk has *left* the latent/open exposure
 * bucket — `inventoryFromState` drops these. (`softCancelled` is deliberately NOT
 * here: an off-chain cancel doesn't invalidate the signed payload, so a
 * pulled-but-not-expired quote is still matchable on chain — DESIGN §6.)
 */
const RELEASED_LIFECYCLES: readonly CommitmentLifecycle[] = ['filled', 'expired', 'authoritativelyInvalidated'];

/**
 * Translate the persisted state into the risk engine's `Inventory` — the
 * aggregate exposure the caps bind (DESIGN §6). The runner builds the inventory it
 * hands `buildDesiredQuote` from this each tick.
 *
 * Commitments: keep `visibleOpen` / `softCancelled` / `partiallyFilled` whose
 * `expiryUnixSec` is still in the future, at their *remaining* risk
 * (`riskAmountWei6 - filledRiskWei6` — the filled portion has become a position,
 * counted separately); drop `filled` / `expired` / `authoritativelyInvalidated`
 * (their headroom is released) and anything past its expiry (dead on chain even if
 * not yet reclassified). `openCommitmentCount` is the count of those kept
 * commitments — what the `maxOpenCommitments` cap binds.
 *
 * Positions: keep everything except `claimed`. `pendingSettle` / `claimable` are
 * short-lived (the runner settles / claims promptly in live mode) and counting
 * them is the conservative direction — a `claimable` position has actually *won*,
 * so it can't lose; counting it slightly over-states worst-case exposure, but
 * over-counting errs toward quoting *less*, which is the safe side.
 *
 * Big amounts are decimal strings; this goes via `Number(...)` (the USDC caps here
 * are tiny — well inside `Number.MAX_SAFE_INTEGER`). `riskAmountUSDC` is clamped
 * to ≥ 0 (a `filled > risk` record would be a logic bug, not a parse failure).
 */
export function inventoryFromState(state: MakerState, nowUnixSec: number): Inventory {
  const items: ExposureItem[] = [];
  let openCommitmentCount = 0;

  for (const record of Object.values(state.commitments)) {
    if (RELEASED_LIFECYCLES.includes(record.lifecycle)) continue;
    if (record.expiryUnixSec <= nowUnixSec) continue; // expired but not yet reclassified — dead on chain, headroom released
    const remainingWei6 = Math.max(0, Number(record.riskAmountWei6) - Number(record.filledRiskWei6));
    if (remainingWei6 <= 0) continue; // fully consumed — effectively `filled`, no latent risk left
    items.push({
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      makerSide: record.makerSide,
      riskAmountUSDC: wei6ToUSDC(remainingWei6),
    });
    openCommitmentCount += 1;
  }

  for (const record of Object.values(state.positions)) {
    if (record.status === 'claimed') continue;
    const riskAmountUSDC = wei6ToUSDC(Math.max(0, Number(record.riskAmountWei6)));
    if (riskAmountUSDC <= 0) continue;
    items.push({
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      makerSide: record.side,
      riskAmountUSDC,
    });
  }

  return { items, openCommitmentCount };
}

// ── reconcileBook ────────────────────────────────────────────────────────────

const SIDES = ['away', 'home'] as const;

/**
 * Reconcile the maker's *current* commitments on one speculation against the
 * *desired* quote (DESIGN §9). `currentRecords` must be the maker's commitments on
 * that one speculation (the caller filters by `speculationId`). Only `visibleOpen`
 * records still in the future (`expiryUnixSec > nowUnixSec`) form "the visible
 * book", and non-expired `partiallyFilled` records count as occupying their side
 * (they're API-visible too — don't double-post over them — but v0 doesn't
 * reconcile partials; their remainder fills or ages out). `softCancelled` /
 * `filled` / `expired` / `authoritativelyInvalidated` and expired records are
 * ignored — they aren't on the visible surface (and an expired one is dead on
 * chain; the runner ages it out).
 *
 * Per side, given the desired `QuoteSide` (or `null` when that side isn't quoted —
 * no headroom, or the whole quote was refused): pull every `visibleOpen` on a side
 * that's `null` as `side-not-quoted`; on a side that's wanted, keep the newest
 * `visibleOpen`, soft-cancel the rest as `duplicate`, and replace the kept one if
 * it's `stale` (`now - postedAtUnixSec > orders.staleAfterSeconds`) or `mispriced`
 * (the kept tick's implied probability differs from the desired tick's by more than
 * `orders.replaceOnOddsMoveBps / 10000`); if a wanted side has no `visibleOpen` and
 * no `partiallyFilled`, submit a fresh quote.
 *
 * **v0 caveat:** the `mispriced` test compares the *posted quote tick* to the
 * *desired quote tick* — a proxy for "fair value has moved", since the quote tick =
 * fair + (roughly constant) half-spread, so the two move together. A dedicated
 * fair-value-delta check is a possible refinement.
 *
 * Pure — no SDK, no state mutation; the runner executes / logs the plan.
 */
export function reconcileBook(
  currentRecords: readonly MakerCommitmentRecord[],
  desired: DesiredQuote,
  config: Config,
  nowUnixSec: number,
): BookReconciliation {
  const toSubmit: QuoteSide[] = [];
  const toReplace: ReplacePlan[] = [];
  const toSoftCancel: SoftCancelPlan[] = [];

  const live = currentRecords.filter((r) => r.expiryUnixSec > nowUnixSec);

  for (const side of SIDES) {
    const desiredSide: QuoteSide | null = side === 'away' ? desired.result.away : desired.result.home;
    const visibleOpen = live
      .filter((r) => r.makerSide === side && r.lifecycle === 'visibleOpen')
      .sort((a, b) => b.postedAtUnixSec - a.postedAtUnixSec); // newest first

    if (desiredSide === null) {
      for (const r of visibleOpen) toSoftCancel.push({ record: r, reason: 'side-not-quoted' });
      continue;
    }

    if (visibleOpen.length === 0) {
      const occupiedByPartialFill = live.some((r) => r.makerSide === side && r.lifecycle === 'partiallyFilled');
      if (!occupiedByPartialFill) toSubmit.push(desiredSide);
      continue;
    }

    // Book hygiene (DESIGN §9): keep the newest visible quote on this side, soft-cancel any older ones.
    for (const r of visibleOpen.slice(1)) toSoftCancel.push({ record: r, reason: 'duplicate' });
    const keep = visibleOpen[0] as MakerCommitmentRecord; // non-empty: visibleOpen.length checked above

    if (nowUnixSec - keep.postedAtUnixSec > config.orders.staleAfterSeconds) {
      toReplace.push({ stale: keep, reason: 'stale', replacement: desiredSide });
    } else if (oddsMovedTooFar(keep.oddsTick, desiredSide.quoteTick, config.orders.replaceOnOddsMoveBps)) {
      toReplace.push({ stale: keep, reason: 'mispriced', replacement: desiredSide });
    }
  }

  return { toSubmit, toReplace, toSoftCancel };
}

/** Has the quoted tick moved more than `thresholdBps` basis points (of implied probability) from `fromTick` to `toTick`? */
function oddsMovedTooFar(fromTick: number, toTick: number, thresholdBps: number): boolean {
  return Math.abs(tickImpliedProb(fromTick) - tickImpliedProb(toTick)) * 10_000 > thresholdBps;
}

/** A uint16 odds tick → its implied probability. `250` → `0.40`. */
function tickImpliedProb(tick: number): number {
  return decimalToImpliedProb(tickToDecimal(tick));
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function breakdownReferenceOdds(awayOddsAmerican: number, homeOddsAmerican: number): ReferenceOddsBreakdown {
  const awayDecimal = americanToDecimal(awayOddsAmerican);
  const homeDecimal = americanToDecimal(homeOddsAmerican);
  const awayImpliedProb = decimalToImpliedProb(awayDecimal);
  const homeImpliedProb = decimalToImpliedProb(homeDecimal);
  return {
    awayOddsAmerican,
    homeOddsAmerican,
    awayDecimal,
    homeDecimal,
    awayImpliedProb,
    homeImpliedProb,
    overround: awayImpliedProb + homeImpliedProb - 1,
  };
}

/** Like `breakdownReferenceOdds`, but returns `null` (instead of throwing) when the upstream odds are out of `americanToDecimal`'s acceptable range — the caller turns that into a refusal rather than crashing the tick (DESIGN §2.2 — refuse on bad reference data). */
function tryBreakdownReferenceOdds(refOdds: ReferenceMoneylineAmerican): ReferenceOddsBreakdown | null {
  try {
    return breakdownReferenceOdds(refOdds.away, refOdds.home);
  } catch {
    return null;
  }
}

/** A `QuoteResult` carrying only a refusal — used for the risk-verdict and bad-reference-odds refusals (the pricing module produces its own for the math-level refusals). `notes` should be `REFUSE:`-prefixed. */
function refusedResult(notes: string[]): QuoteResult {
  return {
    canQuote: false,
    away: null,
    home: null,
    fair: null,
    spread: null,
    targetMonthlyReturnUSDC: null,
    expectedMonthlyFilledVolumeUSDC: null,
    notes,
  };
}

/** Translate a parsed `Config`'s risk block into the risk engine's `RiskCaps` (drops `maxDailyFeeUSDC`, which the engine doesn't take). */
export function toRiskCaps(config: Config): RiskCaps {
  return {
    bankrollUSDC: config.risk.bankrollUSDC,
    maxBankrollUtilizationPct: config.risk.maxBankrollUtilizationPct,
    maxRiskPerCommitmentUSDC: config.risk.maxRiskPerCommitmentUSDC,
    maxRiskPerContestUSDC: config.risk.maxRiskPerContestUSDC,
    maxRiskPerTeamUSDC: config.risk.maxRiskPerTeamUSDC,
    maxRiskPerSportUSDC: config.risk.maxRiskPerSportUSDC,
    maxOpenCommitments: config.risk.maxOpenCommitments,
  };
}

function buildQuoteInputs(
  config: Config,
  refOdds: ReferenceOddsBreakdown,
  awayHeadroomUSDC: number,
  homeHeadroomUSDC: number,
): QuoteInputs {
  const { capitalUSDC, ...economicsRest } = config.pricing.economics;
  const common = {
    consensusAwayDecimal: refOdds.awayDecimal,
    consensusHomeDecimal: refOdds.homeDecimal,
    capitalUSDC,
    maxPerQuotePctOfCapital: config.pricing.maxPerQuotePctOfCapital,
    minEdgeBps: config.pricing.minEdgeBps,
    quoteBothSides: config.pricing.quoteBothSides,
    awayHeadroomUSDC,
    homeHeadroomUSDC,
  };
  if (config.pricing.mode === 'economics') {
    return { ...common, mode: 'economics', economics: economicsRest };
  }
  return { ...common, mode: 'direct', direct: { spreadBps: config.pricing.direct.spreadBps } };
}
