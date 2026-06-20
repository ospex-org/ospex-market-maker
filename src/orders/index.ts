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
 *   - `reconcileBook(currentRecords, desired, config, nowUnixSec, openCommitmentCount)`
 *     — given the maker's current commitments on a speculation and the quote it now
 *     wants, compute what to submit / replace / soft-cancel (DESIGN §6, §9), capped
 *     so the plan never pushes the maker over `risk.maxOpenCommitments` matchable
 *     commitments: a fresh quote on a wanted-but-empty side; a replacement for a
 *     stale or mispriced one; a pull for a side that's no longer quoted, a
 *     book-hygiene duplicate, or a stale/mispriced quote it can't yet afford to
 *     replace (those sides land in `deferredSides` for a retry next tick).
 *
 * Upstream reference-odds ingestion — the SDK per-market odds shape (`MoneylineOdds`
 * / `SpreadOdds` / `TotalOdds`) → the MM's usable `ReferenceOdds` — lives in
 * `./reference-odds.ts` (the foundation the spread / total strategies build on).
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
  inverseOddsTick,
  oppositeSide,
  priceSpread,
  priceTotal,
  tickToDecimal,
  wei6ToUSDC,
  type QuoteResult,
  type QuoteSide,
  type SpreadPricing,
} from '../pricing/index.js';
import { headroomForSide, verdictForMarket, type ExposureItem, type Inventory, type MakerSide, type Market, type RiskCaps } from '../risk/index.js';
import { isTerminalPositionStatus, type CommitmentLifecycle, type MakerCommitmentRecord, type MakerState } from '../state/index.js';
import type { ReferenceOdds } from './reference-odds.js';

// Reference-odds ingestion: the SDK per-market odds shape → the MM's usable
// `ReferenceOdds`. Re-exported so the spread / total pricing adapters and
// line-keyed discovery consume one entry point.
export { referenceOddsEqual, referenceOddsFromSdk, type ReferenceOdds } from './reference-odds.js';

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

/** What `buildDesiredQuote` produces: the reference-odds breakdown (`null` when the upstream odds were out of range — see `result.notes`), the per-**offer**-side exposure headroom it priced against, and the `computeQuote` result. */
export interface DesiredQuote {
  referenceOdds: ReferenceOddsBreakdown | null;
  /**
   * Max additional at-risk USDC each **taker offer** can carry without breaching a
   * per-{commitment,contest,team,sport} or bankroll cap. `away` is the headroom for
   * the *away offer* — which becomes a maker-on-*home* commitment, so it's the
   * risk engine's maker-on-home headroom (`headroomForSide(..., 'home', ...)`), and
   * vice versa. Always populated, even on a refusal.
   */
  headroomUSDC: { away: number; home: number };
  result: QuoteResult;
}

/** Why the runner would replace a commitment: pull it off-chain → post a fresh one at the current price. */
export type ReplaceReason =
  | 'stale' //       older than `orders.staleAfterSeconds`
  | 'mispriced'; //  the quoted tick has moved more than `orders.replaceOnOddsMoveBps` (in implied-probability terms) since it was posted

/** Why the runner would pull a commitment off-chain without re-posting it. */
export type SoftCancelReason =
  | 'side-not-quoted' //   the desired quote has no `QuoteSide` for that side (no headroom, or the whole quote was refused)
  | 'duplicate' //         more than one API-visible commitment on a `(speculation, side)` — keep the newest, pull the rest (book hygiene, DESIGN §9)
  | 'shutdown' //          the runner is shutting down — sweep every visible quote off-chain (gasless), regardless of `killCancelOnChain`; the latent (matchable until expiry) window stays until the on-chain kill path also fires (if `killCancelOnChain: true`) or natural expiry
  | 'funding' //           the funding guard is holding — the wallet can't back its matchable-commitment exposure, so pull every visible quote off the relay (DESIGN §6 / C1b). Off-chain only stops NEW relay fills; the signed payload stays matchable on chain until expiry (or an authoritative on-chain cancel under `fundingGuard.underfundedCancelMode: onchain`), so the latent risk — and the hold — persists until then.
  | 'stream-health' //     the §5.1 own-state-health gate is holding with open exposure (PR3b-ii) — the own-state SSE view is degraded, so the MM can't trust its commitment/fill/position book; pull every visible quote off the relay to stop NEW fills landing against a book it can't observe. Off-chain only stops NEW relay fills; the signed payload stays matchable on chain until expiry (or an authoritative on-chain cancel under `orders.cancelMode: onchain`), so the latent exposure — and the hold — persist until then.
  | ReplaceReason; //      a stale/mispriced `visibleOpen` quote we'd replace, but the open-commitment count budget is exhausted — pull it; a fresh post follows only if there's count headroom. (Never a `partiallyFilled` record — those can't be off-chain-cancelled; see `RetainedPartial`.)

/** A commitment to pull off-chain without re-posting. Always a `visibleOpen` record — a `partiallyFilled` remainder is never off-chain-cancelled (the API returns 409 `COMMITMENT_MATCHED` once a commitment has matched). */
export interface SoftCancelPlan {
  record: MakerCommitmentRecord;
  reason: SoftCancelReason;
}

/** Why a `partiallyFilled` remainder was *retained* in place rather than pulled — the reason it would have been actioned were it a `visibleOpen`: its side is no longer quoted (`side-not-quoted`), the remainder is `stale` / `mispriced`, or it was kept over a redundant same-side quote (`duplicate`). */
export type RetainedPartialReason = 'side-not-quoted' | 'stale' | 'mispriced' | 'duplicate';

/**
 * A `partiallyFilled` remainder the reconciler left in place. It is **never**
 * off-chain-cancelled (the API rejects a DELETE once a commitment has matched) and
 * **never** reposted over (a fresh same-side quote on top of it would double the
 * side's matchable exposure). The unfilled remainder stays matchable on chain and
 * the risk engine keeps counting it until expiry / fill / authoritative on-chain
 * cancel. The runner emits a `candidate` `partial-remainder-retained` per entry as
 * positive telemetry, and (under `cancelMode: onchain`) this is the set it routes
 * to a gas-gated authoritative cancel.
 */
export interface RetainedPartial {
  record: MakerCommitmentRecord;
  reason: RetainedPartialReason;
}

/** A `visibleOpen` commitment to replace: pull `stale` off-chain, then post `replacement` at the current price. */
export interface ReplacePlan {
  stale: MakerCommitmentRecord;
  reason: ReplaceReason;
  replacement: QuoteSide;
}

/**
 * The runner's plan for one speculation's visible book: which fresh quotes to
 * submit, which existing commitments to replace, which to soft-cancel outright,
 * and which sides it wanted to (re)post but couldn't this tick because the
 * open-commitment count budget was exhausted (`deferredSides` — the runner records
 * a `cap-hit` candidate and retries next tick once a slot frees up).
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
  /** `partiallyFilled` remainders left in place this tick (never off-chain-cancelled, never reposted over). The runner emits a `partial-remainder-retained` candidate per entry; under `cancelMode: onchain` it routes them to a gas-gated authoritative cancel. */
  retainedPartials: RetainedPartial[];
  /** Taker-offer sides (`'away'` / `'home'`) the plan wanted to (re)post but couldn't this tick — the open-commitment count budget was exhausted; the runner records a `cap-hit` candidate and retries. */
  deferredSides: MakerSide[];
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
  refOdds: ReferenceOdds,
  inventory: Inventory,
): DesiredQuote {
  const caps = toRiskCaps(config);
  // Headroom per *taker offer*: the away offer becomes a maker-on-home commitment
  // (it loses if away wins, counts toward the home-team cap), so it's sized by the
  // maker-on-home headroom — and vice versa. See `toProtocolQuote` / DESIGN §5–§6.
  // Spread cover sides are away/home like moneyline; total over/under map to the
  // away (Upper/over) and home (Lower/under) protocol sides — `priceTotal` is
  // relabelled back to away/home below so the planning chain stays two-outcome.
  // (The risk buckets are still moneyline-shaped here — per-market buckets land
  // with the risk-engine generalization; spread/total aren't quoted live yet.)
  const headroomUSDC = {
    away: headroomForSide(inventory, market, 'home', caps),
    home: headroomForSide(inventory, market, 'away', caps),
  };

  // The two-way reference juice (for the breakdown + the refusal message), in
  // protocol-side order: moneyline / spread away/home, total over/under.
  const [side1American, side2American] =
    refOdds.market === 'total'
      ? [refOdds.overOddsAmerican, refOdds.underOddsAmerican]
      : [refOdds.awayOddsAmerican, refOdds.homeOddsAmerican];
  const referenceOdds = tryBreakdownReferenceOdds(side1American, side2American);

  const verdict = verdictForMarket(inventory, market, caps);
  if (!verdict.allowed) {
    return { referenceOdds, headroomUSDC, result: refusedResult([`REFUSE: ${verdict.reason}`]) };
  }
  if (referenceOdds === null) {
    return {
      referenceOdds: null,
      headroomUSDC,
      result: refusedResult([`REFUSE: reference ${refOdds.market} odds are invalid / out of range (side1=${side1American}, side2=${side2American})`]),
    };
  }

  const pricing = buildMarketPricing(config, headroomUSDC.away, headroomUSDC.home);
  let result: QuoteResult;
  switch (refOdds.market) {
    case 'moneyline':
      result = computeQuote({ ...pricing, consensusAwayDecimal: referenceOdds.awayDecimal, consensusHomeDecimal: referenceOdds.homeDecimal });
      break;
    case 'spread':
      result = priceSpread(
        { awayLine: refOdds.awayLine, homeLine: refOdds.homeLine, awayOddsAmerican: refOdds.awayOddsAmerican, homeOddsAmerican: refOdds.homeOddsAmerican },
        pricing,
      ).result;
      break;
    case 'total': {
      // Relabel the over/under quote back to the two-outcome away/home `QuoteResult`
      // the planning chain (`reconcileBook`) expects: over = away/Upper, under = home/Lower.
      const tq = priceTotal({ line: refOdds.line, overOddsAmerican: refOdds.overOddsAmerican, underOddsAmerican: refOdds.underOddsAmerican }, pricing);
      result = {
        canQuote: tq.canQuote,
        away: tq.over,
        home: tq.under,
        fair: tq.fair,
        spread: tq.spread,
        targetMonthlyReturnUSDC: tq.targetMonthlyReturnUSDC,
        expectedMonthlyFilledVolumeUSDC: tq.expectedMonthlyFilledVolumeUSDC,
        notes: tq.notes,
      };
      break;
    }
  }
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
 * Is a commitment releasable / terminal by the local clock yet? The contract keeps a
 * commitment matchable until `block.timestamp >= expiry` (strict); the MM host / core-api
 * clock can lead the Polygon block timestamp, so headroom is released (and the side freed
 * for a repost) only once `nowUnixSec` is at least `graceSeconds` past the local
 * `expiryUnixSec`. Single source of truth for the expiry-release predicate — used by
 * `inventoryFromState` here and by the runner's `ageOut` / `detectFills` terminalizations,
 * so they cannot drift. `graceSeconds: 0` releases exactly at expiry (the pre-grace behavior).
 */
export function isExpiredForRelease(expiryUnixSec: number, nowUnixSec: number, graceSeconds: number): boolean {
  return nowUnixSec >= expiryUnixSec + graceSeconds;
}

/**
 * Translate the persisted state into the risk engine's `Inventory` — the
 * aggregate exposure the caps bind (DESIGN §6). The runner builds the inventory it
 * hands `buildDesiredQuote` from this each tick.
 *
 * Commitments: keep `visibleOpen` / `softCancelled` / `partiallyFilled` whose
 * `expiryUnixSec` is still in the future, at their *remaining* risk
 * (`riskAmountWei6 - filledRiskWei6` — the filled portion has become a position,
 * counted separately); drop `filled` / `expired` / `authoritativelyInvalidated`
 * (their headroom is released) and anything past `expiry + graceSeconds` (dead on chain
 * even allowing for host/chain clock skew — see {@link isExpiredForRelease}; a
 * past-local-expiry commitment is still counted through the grace window).
 * `openCommitmentCount` is the count of those kept
 * commitments — what the `maxOpenCommitments` cap binds.
 *
 * Positions: keep everything except the TERMINAL statuses
 * ({@link isTerminalPositionStatus} — `claimed` / `settledLost` / `void`), which
 * carry no remaining live exposure (collected win / realized loss / returned
 * stake). The kept non-terminal states (`active` / `pendingSettle` /
 * `claimable`) are counted in full: `pendingSettle` / `claimable` are
 * short-lived (the runner settles / claims promptly in live mode), and a
 * `claimable` position has actually *won* so it can't lose — counting it
 * slightly over-states worst-case exposure, but over-counting errs toward
 * quoting *less*, which is the safe side.
 *
 * Amounts are wei6 decimal strings; the `risk - filled` subtraction is done in
 * `BigInt` (exact), then the result → `Number` for `wei6ToUSDC` (the USDC caps
 * here are tiny — well inside `Number.MAX_SAFE_INTEGER`). A commitment with
 * `filledRiskWei6 > riskAmountWei6` is impossible; `StateStore.load` already
 * rejects such a record as corrupt, and this **throws** if one reaches it anyway
 * (an in-memory corruption) rather than silently dropping it — fail closed; the
 * dropped-and-undercounted path would under-state latent exposure.
 */
export function inventoryFromState(state: MakerState, nowUnixSec: number, graceSeconds: number): Inventory {
  const items: ExposureItem[] = [];
  let openCommitmentCount = 0;

  for (const record of Object.values(state.commitments)) {
    if (RELEASED_LIFECYCLES.includes(record.lifecycle)) continue;
    if (isExpiredForRelease(record.expiryUnixSec, nowUnixSec, graceSeconds)) continue; // past expiry + grace — dead on chain even allowing for clock skew; headroom released
    const riskWei6 = BigInt(record.riskAmountWei6);
    const filledWei6 = BigInt(record.filledRiskWei6);
    if (filledWei6 > riskWei6) {
      throw new Error(`orders: commitment ${record.hash} has filledRiskWei6 (${record.filledRiskWei6}) > riskAmountWei6 (${record.riskAmountWei6}) — corrupt inventory`);
    }
    const remainingWei6 = riskWei6 - filledWei6;
    if (remainingWei6 === 0n) continue; // fully filled — the filled portion is a position; no latent risk left here
    items.push({
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      makerSide: record.makerSide,
      riskAmountUSDC: wei6ToUSDC(Number(remainingWei6)),
    });
    openCommitmentCount += 1;
  }

  for (const record of Object.values(state.positions)) {
    if (isTerminalPositionStatus(record.status)) continue; // claimed / settledLost / void — no live exposure
    const riskWei6 = BigInt(record.riskAmountWei6);
    if (riskWei6 === 0n) continue; // a zero-stake position carries no exposure
    items.push({
      contestId: record.contestId,
      sport: record.sport,
      awayTeam: record.awayTeam,
      homeTeam: record.homeTeam,
      makerSide: record.side,
      riskAmountUSDC: wei6ToUSDC(Number(riskWei6)),
    });
  }

  return { items, openCommitmentCount };
}

/**
 * Gross matchable-commitment risk in wei6 — the funding guard's `required`.
 *
 * Σ of remaining maker risk (`riskAmountWei6 - filledRiskWei6`) over every
 * commitment that could STILL be filled on chain — `visibleOpen` / `softCancelled`
 * / `partiallyFilled`, not past `expiry + graceSeconds` — mirroring
 * {@link inventoryFromState}'s commitment filter exactly (same
 * {@link RELEASED_LIFECYCLES} drop, same {@link isExpiredForRelease} grace, same
 * corrupt-record fail-closed).
 *
 * It is deliberately NOT the risk engine's `totalWorstCaseUSDC`:
 *   - **Gross, not outcome-netted.** Each commitment that matches pulls its own
 *     remaining maker risk from the wallet via `PositionModule.recordFill`
 *     INDEPENDENTLY; if every open commitment fills, the wallet pays the full sum.
 *     Netting opposing outcomes (the P&L worst-case) would *under*-state the cash
 *     the wallet must hold — the one error a solvency guard must never make.
 *   - **Commitments only — no positions.** A filled position's USDC was already
 *     pulled on chain at fill time, so it is not a future wallet obligation.
 *
 * This is the exposure a funding guard keeps `min(walletUSDC,
 * positionModuleAllowance)` at or above. Exact BigInt wei6 (no USDC/Number lossiness).
 */
export function matchableCommitmentRiskWei6(
  state: MakerState,
  nowUnixSec: number,
  graceSeconds: number,
): bigint {
  let total = 0n;
  for (const record of Object.values(state.commitments)) {
    if (RELEASED_LIFECYCLES.includes(record.lifecycle)) continue;
    if (isExpiredForRelease(record.expiryUnixSec, nowUnixSec, graceSeconds)) continue;
    const riskWei6 = BigInt(record.riskAmountWei6);
    const filledWei6 = BigInt(record.filledRiskWei6);
    if (filledWei6 > riskWei6) {
      throw new Error(
        `orders: commitment ${record.hash} has filledRiskWei6 (${record.filledRiskWei6}) > riskAmountWei6 (${record.riskAmountWei6}) — corrupt inventory`,
      );
    }
    total += riskWei6 - filledWei6;
  }
  return total;
}

// ── reconcileBook ────────────────────────────────────────────────────────────

const SIDES = ['away', 'home'] as const;

/** What the reconciler wants to do on a side, before the open-commitment-count budget is allocated. */
type SideAction =
  | { kind: 'noop' } //                                          keep what's there (or nothing's wanted) — no new commitment
  | { kind: 'submit'; quoteSide: QuoteSide } //                  post a fresh quote (no incumbent visible quote to refresh)
  | { kind: 'replace'; stale: MakerCommitmentRecord; reason: ReplaceReason; replacement: QuoteSide }; // refresh a stale/mispriced `visibleOpen` incumbent in place

/**
 * Reconcile the maker's *current* commitments on one speculation against the
 * *desired* quote, **without ever planning more new matchable commitments than the
 * count cap allows** (DESIGN §6, §9). `currentRecords` = the maker's commitments on
 * that one speculation (the caller filters by `speculationId`).
 * `openCommitmentCount` = the maker's current *aggregate* live-commitment count
 * (`inventoryFromState(state, now).openCommitmentCount`, before this plan applies);
 * every new matchable commitment the plan creates — each `toSubmit`, and each
 * `toReplace` (a replacement is net +1, since the off-chain-cancelled old quote
 * stays matchable until expiry) — must fit in `config.risk.maxOpenCommitments -
 * openCommitmentCount`. When the budget runs out, would-be replaces degrade to
 * plain soft-cancels (pull the stale/mispriced quote — it must not stay visibly
 * mispriced — and post nothing) and would-be fresh submits are dropped; both put
 * the side in `deferredSides` so the runner records a `cap-hit` candidate and
 * retries next tick. Replaces take budget priority over fresh submits.
 *
 * Only non-expired records matter (an expired commitment is dead on chain — the
 * runner ages it out). **A live `partiallyFilled` remainder occupies its maker
 * side**: it is never off-chain-cancelled (the API returns 409 `COMMITMENT_MATCHED`
 * once a commitment has matched) and never reposted over (a fresh same-side quote on
 * top of it would double the side's matchable exposure), so while one is live the
 * side does `noop` — its unfilled remainder rides to expiry (or an authoritative
 * on-chain cancel under `cancelMode: onchain`) and the risk engine keeps counting
 * it. Any redundant `visibleOpen` on that side is pulled (`duplicate`, gasless), and
 * the retained partial is surfaced in `retainedPartials`. Absent a live partial, the
 * reconciler keeps the newest `visibleOpen` and soft-cancels the rest as
 * `duplicate`; a kept `visibleOpen` incumbent that's `stale` (`now - postedAtUnixSec
 * > orders.staleAfterSeconds`) or `mispriced` (its tick's implied probability differs
 * from the desired tick's by more than `orders.replaceOnOddsMoveBps / 10000`) is
 * replaced in place. When the side isn't quoted (`desired.result[side] === null` — no
 * headroom, or the whole quote was refused), every non-expired `visibleOpen` on it is
 * soft-cancelled (`side-not-quoted`) and any partial remainder is retained. A wanted
 * side with no live record gets a fresh submit.
 *
 * **Taker vs maker sides:** `desired.result.away` / `.home` are *taker offers* —
 * the side a taker would back by matching the resulting commitment. The commitment
 * that serves the away offer is maker-on-*home* (the maker loses if away wins), so
 * the reconciler matches the away offer against the maker's `makerSide: 'home'`
 * records (and vice versa), and the `mispriced` check converts the desired
 * (taker-facing) `quoteTick` to its maker tick via `inverseOddsTick` before
 * comparing it to the incumbent's (maker-space) `oddsTick`. See `toProtocolQuote`.
 *
 * **v0 caveat:** the `mispriced` test compares the *incumbent's tick* to the
 * *desired tick* (both in maker space) — a proxy for "fair value has moved", since
 * a quote tick = fair + (roughly constant) half-spread, so the two move together.
 *
 * Pure — no SDK, no state mutation; the runner executes / logs the plan.
 */
export function reconcileBook(
  currentRecords: readonly MakerCommitmentRecord[],
  desired: DesiredQuote,
  config: Config,
  nowUnixSec: number,
  openCommitmentCount: number,
): BookReconciliation {
  const toSubmit: QuoteSide[] = [];
  const toReplace: ReplacePlan[] = [];
  const toSoftCancel: SoftCancelPlan[] = [];
  const retainedPartials: RetainedPartial[] = [];
  const deferredSides: MakerSide[] = [];

  const live = currentRecords.filter((r) => r.expiryUnixSec > nowUnixSec); // expired records are dead on chain — the runner ages them out
  const actions = new Map<MakerSide, SideAction>();

  // Pass 1 — per taker-offer side: classify what (if anything) to post, and emit off-chain
  // soft-cancels for VISIBLE-OPEN records only. A live `partiallyFilled` remainder is never
  // off-chain-cancelled (the API rejects a DELETE once a commitment has matched — 409
  // COMMITMENT_MATCHED) and never reposted over (a fresh same-side quote on top of it would
  // double the side's matchable exposure — the original partial-fill bug): it OCCUPIES its
  // maker side until expiry / authoritative on-chain cancel, with the risk engine counting its
  // remaining risk the whole time. Retained partials surface in `retainedPartials`.
  for (const offerSide of SIDES) {
    const desiredSide: QuoteSide | null = offerSide === 'away' ? desired.result.away : desired.result.home;
    // The commitment that serves the away offer is maker-on-*home* (it loses if away wins), so the
    // away offer's records are the maker's `makerSide: 'home'` ones — and vice versa.
    const onSide = live.filter((r) => r.makerSide === oppositeSide(offerSide));
    const visibleOpen = onSide.filter((r) => r.lifecycle === 'visibleOpen').sort(newestFirst);
    const partiallyFilled = onSide.filter((r) => r.lifecycle === 'partiallyFilled').sort(newestFirst);

    if (desiredSide === null) {
      // Side no longer quoted: pull every visible-open quote off-chain (gasless, valid); retain
      // any partial remainder — it can't be off-chain-cancelled, so it rides to expiry.
      for (const r of visibleOpen) toSoftCancel.push({ record: r, reason: 'side-not-quoted' });
      for (const r of partiallyFilled) retainedPartials.push({ record: r, reason: 'side-not-quoted' });
      actions.set(offerSide, { kind: 'noop' });
      continue;
    }

    const occupant = partiallyFilled[0]; // newest non-expired partial remainder on this side, if any
    if (occupant !== undefined) {
      // A live partial remainder OCCUPIES this side. Don't off-chain-cancel it and don't stack a
      // fresh same-side quote over it. Pull any redundant visible-open quotes (gasless, valid); the
      // side reopens for a fresh quote only once the partial expires / is authoritatively cancelled.
      for (const r of visibleOpen) toSoftCancel.push({ record: r, reason: 'duplicate' });
      const occupantStale = nowUnixSec - occupant.postedAtUnixSec > config.orders.staleAfterSeconds;
      const occupantMispriced = oddsMovedTooFar(occupant.oddsTick, inverseOddsTick(desiredSide.quoteTick), config.orders.replaceOnOddsMoveBps);
      // Surface the occupant only when there's something to act on (it's stale/mispriced, or it
      // suppressed a redundant same-side quote). A fresh, on-tick, lone occupant is normal
      // steady-state — surfacing it would emit a candidate every reconcile tick while it lives.
      const occupantReason: RetainedPartialReason | null = occupantStale
        ? 'stale'
        : occupantMispriced
          ? 'mispriced'
          : visibleOpen.length > 0 || partiallyFilled.length > 1
            ? 'duplicate'
            : null;
      if (occupantReason !== null) retainedPartials.push({ record: occupant, reason: occupantReason });
      for (const r of partiallyFilled.slice(1)) retainedPartials.push({ record: r, reason: 'duplicate' }); // extra partials (shouldn't normally arise) — retained too
      actions.set(offerSide, { kind: 'noop' });
      continue;
    }

    // No live partial occupies the side — the visible-open-only path.
    const incumbent = visibleOpen[0];
    if (incumbent === undefined) {
      actions.set(offerSide, { kind: 'submit', quoteSide: desiredSide });
      continue;
    }
    // Book hygiene (DESIGN §9): exactly one visible quote per (speculation, side) — pull the rest.
    for (const r of visibleOpen) {
      if (r !== incumbent) toSoftCancel.push({ record: r, reason: 'duplicate' });
    }
    const stale = nowUnixSec - incumbent.postedAtUnixSec > config.orders.staleAfterSeconds;
    // Compare in the protocol's *maker* space: the incumbent stores a maker tick; convert the
    // desired (taker-facing) `quoteTick` to its maker tick — one `inverseOddsTick` hop, no round-trip.
    const mispriced = oddsMovedTooFar(incumbent.oddsTick, inverseOddsTick(desiredSide.quoteTick), config.orders.replaceOnOddsMoveBps);
    if (!stale && !mispriced) {
      actions.set(offerSide, { kind: 'noop' }); // incumbent is fresh and correctly priced — leave it
    } else {
      // a stale/mispriced `visibleOpen` incumbent — refresh it in place (pull off-chain, repost fresh).
      actions.set(offerSide, { kind: 'replace', stale: incumbent, reason: stale ? 'stale' : 'mispriced', replacement: desiredSide });
    }
  }

  // Pass 2 — allocate the open-commitment-count budget: replaces first (refreshing a stale/mispriced quote beats adding new liquidity), then fresh submits.
  let budget = Math.max(0, config.risk.maxOpenCommitments - openCommitmentCount);
  for (const side of SIDES) {
    const action = actions.get(side);
    if (action === undefined || action.kind !== 'replace') continue;
    if (budget > 0) {
      toReplace.push({ stale: action.stale, reason: action.reason, replacement: action.replacement });
      budget -= 1;
    } else {
      toSoftCancel.push({ record: action.stale, reason: action.reason }); // can't afford the new post — pull the stale/mispriced quote anyway
      deferredSides.push(side);
    }
  }
  for (const side of SIDES) {
    const action = actions.get(side);
    if (action === undefined || action.kind !== 'submit') continue;
    if (budget > 0) {
      toSubmit.push(action.quoteSide);
      budget -= 1;
    } else {
      deferredSides.push(side);
    }
  }

  return { toSubmit, toReplace, toSoftCancel, retainedPartials, deferredSides };
}

function newestFirst(a: MakerCommitmentRecord, b: MakerCommitmentRecord): number {
  return b.postedAtUnixSec - a.postedAtUnixSec;
}

/** Have the odds moved more than `thresholdBps` basis points (of implied probability) from `fromTick` to `toTick`? Both are protocol *maker* ticks — the caller converts a taker-facing quote tick via `inverseOddsTick` before passing it here, so the comparison is apples-to-apples. */
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
function tryBreakdownReferenceOdds(side1American: number, side2American: number): ReferenceOddsBreakdown | null {
  try {
    return breakdownReferenceOdds(side1American, side2American);
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

/**
 * The pricing scalars + spread-derivation mode shared by every market's quote
 * construction (`computeQuote` for moneyline, `priceSpread` / `priceTotal` for the
 * others) — everything `computeQuote` needs EXCEPT the reference odds, which each
 * market sources from its own juice. Mirrors `SpreadPricing` / `TotalPricing`.
 */
function buildMarketPricing(config: Config, awayHeadroomUSDC: number, homeHeadroomUSDC: number): SpreadPricing {
  const { capitalUSDC, ...economicsRest } = config.pricing.economics;
  const common = {
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
