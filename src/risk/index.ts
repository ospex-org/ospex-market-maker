/**
 * Risk engine (DESIGN §6).
 *
 * Exposure is **worst-case USDC loss by outcome**, not a simple sum: a filled
 * position (or an open / soft-cancelled-not-yet-expired commitment) on side X
 * loses its `riskAmountUSDC` if X loses. The caps bind those outcome buckets:
 * per-commitment, per-contest, per-team, per-sport, and total bankroll. All pure
 * functions — no SDK, no chain. The orders / runner layer builds the `Inventory`
 * (from positions + commitments) and the `RiskCaps` (from the parsed `Config`).
 *
 * This module is the money-risk boundary, so every exported entry point validates
 * its numeric inputs at runtime: amounts must be finite and non-negative, counts
 * must be non-negative integers, `makerSide` must be `"away"` / `"home"`. A
 * malformed value throws — it does not fail open (a NaN / negative would otherwise
 * slip past the cap comparisons). Internal helpers trust their (already-validated)
 * callers.
 */

import type {
  ExposureItem,
  Inventory,
  MakerSide,
  Market,
  MarketType,
  OutcomeLoss,
  RiskCaps,
  RiskVerdict,
} from './types.js';

export * from './types.js';

// ── runtime guards (this module gates money — never trust caller numerics) ────

function fail(detail: string): never {
  throw new Error(`risk: ${detail}`);
}

function describe(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `"${v}"`;
  return typeof v;
}

function requireFiniteNonNeg(v: unknown, name: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    fail(`${name} must be a finite, non-negative number, got ${describe(v)}`);
  }
}

function requireNonNegInt(v: unknown, name: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    fail(`${name} must be a non-negative integer, got ${describe(v)}`);
  }
}

function validateMakerSide(side: MakerSide, name: string): void {
  if (side !== 'away' && side !== 'home') fail(`${name} must be "away" or "home", got ${describe(side)}`);
}

const MARKET_TYPES: readonly MarketType[] = ['moneyline', 'spread', 'total'];

// `speculationId` is the exposure GROUP KEY and `marketType` drives the per-team cap
// exemption, so both are money-critical inputs — validate them at the boundary like
// every other input, never trusting the caller. `speculationId` must be a non-empty
// string (a real on-chain id is a positive integer string; a blank one would silently
// collapse distinct speculations into one group).
function validateSpeculationId(v: unknown, name: string): void {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string, got ${describe(v)}`);
}

function validateMarketType(v: unknown, name: string): void {
  if (typeof v !== 'string' || !(MARKET_TYPES as readonly string[]).includes(v)) {
    fail(`${name} must be one of ${MARKET_TYPES.map((m) => `"${m}"`).join(' / ')}, got ${describe(v)}`);
  }
}

function validateItems(items: readonly ExposureItem[]): void {
  if (!Array.isArray(items)) fail(`inventory.items must be an array, got ${describe(items)}`);
  items.forEach((it, i) => {
    validateMakerSide(it.makerSide, `inventory.items[${i}].makerSide`);
    requireFiniteNonNeg(it.riskAmountUSDC, `inventory.items[${i}].riskAmountUSDC`);
    validateSpeculationId(it.speculationId, `inventory.items[${i}].speculationId`);
    validateMarketType(it.marketType, `inventory.items[${i}].marketType`);
  });
}

/** Validate the `Market`'s exposure-group selectors (the fields that drive money grouping). */
function validateMarket(market: Market): void {
  validateSpeculationId(market.speculationId, 'market.speculationId');
  validateMarketType(market.marketType, 'market.marketType');
}

function validateInventory(inv: Inventory): void {
  validateItems(inv.items);
  requireNonNegInt(inv.openCommitmentCount, 'inventory.openCommitmentCount');
}

function validateCaps(caps: RiskCaps): void {
  requireFiniteNonNeg(caps.bankrollUSDC, 'caps.bankrollUSDC');
  requireFiniteNonNeg(caps.maxRiskPerCommitmentUSDC, 'caps.maxRiskPerCommitmentUSDC');
  requireFiniteNonNeg(caps.maxRiskPerContestUSDC, 'caps.maxRiskPerContestUSDC');
  requireFiniteNonNeg(caps.maxRiskPerTeamUSDC, 'caps.maxRiskPerTeamUSDC');
  requireFiniteNonNeg(caps.maxRiskPerSportUSDC, 'caps.maxRiskPerSportUSDC');
  requireNonNegInt(caps.maxOpenCommitments, 'caps.maxOpenCommitments');
  const u: unknown = caps.maxBankrollUtilizationPct;
  if (typeof u !== 'number' || !Number.isFinite(u) || !(u > 0) || u > 1) {
    fail(`caps.maxBankrollUtilizationPct must be in (0, 1], got ${describe(u)}`);
  }
}

// ── exposure accounting (the `*Unchecked` cores assume already-validated items) ──
//
// Exposure is grouped by SPECULATION (`speculationId`). A speculation is exactly one
// `(contestId, scorer, lineTicks)` — moneyline, spread, and total (and distinct
// spread/total lines) are independent speculations that can all lose at once, so each
// is its own worst-case bucket. Within a speculation the two maker sides are mutually
// exclusive outcomes, so its worst case is `max(ifAwayWins, ifHomeWins)`; a contest's
// worst case SUMS its speculations' worst cases (conservative independence — never net
// one market's win against another's loss); sport / bankroll worst cases sum across
// the relevant speculations. A moneyline-only contest has exactly one speculation, so
// every sum collapses to the prior per-contest `max(...)` — moneyline accounting stays
// byte-identical. Grouping by the speculation id (always present on every record +
// own-state body) rather than a reconstructed `(marketType, lineTicks)` tuple means a
// position rehydrated from an own-state snapshot — whose body omits the line — still
// keys to the right group, so there is no missing-line under-statement.

interface GroupExposure {
  contestId: string;
  sport: string;
  loss: OutcomeLoss;
}

/** Bucket every item by its `speculationId`, summing each maker side's at-risk USDC. */
function groupExposures(items: readonly ExposureItem[]): Map<string, GroupExposure> {
  const groups = new Map<string, GroupExposure>();
  for (const it of items) {
    let g = groups.get(it.speculationId);
    if (g === undefined) {
      g = { contestId: it.contestId, sport: it.sport, loss: { ifAwayWins: 0, ifHomeWins: 0 } };
      groups.set(it.speculationId, g);
    }
    // maker on this group's home/under side → loses on the away/over outcome, and vice versa:
    if (it.makerSide === 'home') g.loss.ifAwayWins += it.riskAmountUSDC;
    else g.loss.ifHomeWins += it.riskAmountUSDC;
  }
  return groups;
}

const groupWorstCase = (loss: OutcomeLoss): number => Math.max(loss.ifAwayWins, loss.ifHomeWins);

function contestWorstCaseUnchecked(items: readonly ExposureItem[], contestId: string): number {
  let total = 0;
  for (const g of groupExposures(items).values()) {
    if (g.contestId === contestId) total += groupWorstCase(g.loss);
  }
  return total;
}

function totalWorstCaseUnchecked(items: readonly ExposureItem[]): number {
  let total = 0;
  for (const g of groupExposures(items).values()) total += groupWorstCase(g.loss);
  return total;
}

function sportWorstCaseUnchecked(items: readonly ExposureItem[], sport: string): number {
  let total = 0;
  for (const g of groupExposures(items).values()) {
    if (g.sport === sport) total += groupWorstCase(g.loss);
  }
  return total;
}

// Per-team directional exposure EXCLUDES total markets — over/under isn't a bet on a
// team. Moneyline + spread cover sides count toward the team the maker is backing
// (away side → away team, home side → home team).
function teamExposureUnchecked(items: readonly ExposureItem[], team: string): number {
  let total = 0;
  for (const it of items) {
    if (it.marketType === 'total') continue; // over/under carries no team
    const makerSideTeam = it.makerSide === 'away' ? it.awayTeam : it.homeTeam;
    if (makerSideTeam === team) total += it.riskAmountUSDC;
  }
  return total;
}

// ── public exposure accessors ────────────────────────────────────────────────

/**
 * The maker-side loss buckets for a contest, **summed across all its markets by
 * maker side** — a moneyline-axis projection (away-side items vs home-side items),
 * NOT the per-cap contest worst case. For a moneyline-only contest the two coincide;
 * for a multi-market contest the cap-bound worst case is {@link contestWorstCaseUSDC}
 * (Σ over the contest's speculations of each one's `max(...)`), which this does not
 * compute — spread cover / total over-under don't share moneyline's away-wins /
 * home-wins axis. Diagnostic accessor; the caps use the group-based helpers, not this.
 */
export function worstCaseByOutcome(items: readonly ExposureItem[], contestId: string): OutcomeLoss {
  validateItems(items);
  let ifAwayWins = 0;
  let ifHomeWins = 0;
  for (const it of items) {
    if (it.contestId !== contestId) continue;
    if (it.makerSide === 'home') ifAwayWins += it.riskAmountUSDC; // maker on home → loses if away wins
    else ifHomeWins += it.riskAmountUSDC; //                         maker on away → loses if home wins
  }
  return { ifAwayWins, ifHomeWins };
}

/** Worst-case USDC loss for one contest — Σ over its speculations of each one's `max(ifAwayWins, ifHomeWins)` (conservative independence across markets). This is what `maxRiskPerContestUSDC` binds. */
export function contestWorstCaseUSDC(items: readonly ExposureItem[], contestId: string): number {
  validateItems(items);
  return contestWorstCaseUnchecked(items, contestId);
}

/** Total worst-case USDC loss across everything (conservative — speculations are independent, so this sums every speculation's worst case). */
export function totalWorstCaseUSDC(items: readonly ExposureItem[]): number {
  validateItems(items);
  return totalWorstCaseUnchecked(items);
}

/** Current directional exposure to a team — the at-risk USDC the maker loses if that team loses (moneyline + spread cover sides backing the team; total over/under excluded — it carries no team). */
export function teamExposureUSDC(items: readonly ExposureItem[], team: string): number {
  validateItems(items);
  return teamExposureUnchecked(items, team);
}

const bankrollCeilingUSDC = (caps: RiskCaps): number => caps.bankrollUSDC * caps.maxBankrollUtilizationPct;

// ── headroom / verdict / allowance target ────────────────────────────────────

/**
 * Max *additional* at-risk USDC the maker may take on `makerSide` of `market`
 * without breaching any exposure cap (DESIGN §6). Bounded by the per-commitment
 * cap and the per-contest / per-team / per-sport / bankroll headroom — never
 * over-estimates (fail closed). Always a finite number ≥ 0.
 *
 * The new risk lands in `market`'s speculation. The per-contest term reserves room
 * for the contest's OTHER speculations' worst cases (independent markets that can also
 * lose) plus the target speculation's current bucket the new risk adds to:
 *   `maxRiskPerContest − (Σ other speculations' max + target's loss-on-this-side)`.
 * A moneyline-only contest has one speculation, so this collapses to the prior
 * `maxRiskPerContest − currentLossInThatBucket` — byte-identical. A `total` market
 * has no team, so the per-team cap doesn't bind it.
 */
export function headroomForSide(inventory: Inventory, market: Market, makerSide: MakerSide, caps: RiskCaps): number {
  validateInventory(inventory);
  validateCaps(caps);
  validateMarket(market);
  validateMakerSide(makerSide, 'makerSide');
  const { items } = inventory;

  // Split the contest's speculations into the target one (this quote's, by speculationId)
  // and the rest. Adding Δ to `makerSide` raises the target's loss-bucket for the OTHER
  // outcome (maker on away → loses if home wins → raises ifHomeWins).
  let otherGroupsWorstCase = 0;
  let targetLoss: OutcomeLoss = { ifAwayWins: 0, ifHomeWins: 0 };
  for (const [speculationId, g] of groupExposures(items)) {
    if (g.contestId !== market.contestId) continue;
    if (speculationId === market.speculationId) targetLoss = g.loss;
    else otherGroupsWorstCase += groupWorstCase(g.loss);
  }
  const targetBucketLoss = makerSide === 'away' ? targetLoss.ifHomeWins : targetLoss.ifAwayWins;

  // A total (over/under) bet is on no team, so the per-team cap doesn't apply to it
  // (and `teamExposureUnchecked` already excludes total items from any team's sum).
  const teamHeadroom =
    market.marketType === 'total'
      ? Number.POSITIVE_INFINITY
      : caps.maxRiskPerTeamUSDC - teamExposureUnchecked(items, makerSide === 'away' ? market.awayTeam : market.homeTeam);

  return Math.max(
    0,
    Math.min(
      caps.maxRiskPerCommitmentUSDC,
      caps.maxRiskPerContestUSDC - (otherGroupsWorstCase + targetBucketLoss),
      teamHeadroom,
      caps.maxRiskPerSportUSDC - sportWorstCaseUnchecked(items, market.sport),
      bankrollCeilingUSDC(caps) - totalWorstCaseUnchecked(items),
    ),
  );
}

/** Should the maker even try to quote `market` now? Refuses on a global cap (open-commitment count, bankroll ceiling) or if neither side has headroom. */
export function verdictForMarket(inventory: Inventory, market: Market, caps: RiskCaps): RiskVerdict {
  validateInventory(inventory);
  validateCaps(caps);
  validateMarket(market);
  if (inventory.openCommitmentCount >= caps.maxOpenCommitments) {
    return {
      allowed: false,
      reason: `at the max open-commitment count (${inventory.openCommitmentCount} / ${caps.maxOpenCommitments})`,
    };
  }
  const total = totalWorstCaseUnchecked(inventory.items);
  const ceiling = bankrollCeilingUSDC(caps);
  if (total >= ceiling) {
    return {
      allowed: false,
      reason: `at the bankroll exposure ceiling (${total.toFixed(2)} / ${ceiling.toFixed(2)} USDC worst-case)`,
    };
  }
  if (headroomForSide(inventory, market, 'away', caps) <= 0 && headroomForSide(inventory, market, 'home', caps) <= 0) {
    return { allowed: false, reason: `no exposure headroom on either side of contest ${market.contestId}` };
  }
  return { allowed: true };
}

/**
 * The aggregate `PositionModule` USDC allowance the maker should hold — the
 * maximum aggregate matchable risk the configured caps could ever require
 * (DESIGN §6). `approve(x)` *sets* the allowance, so this is an absolute target,
 * never a per-quote shortfall; the approvals layer further clamps it by the
 * wallet's actual USDC balance, and never sets `MaxUint256` unless explicitly
 * configured + confirmed.
 */
export function requiredPositionModuleAllowanceUSDC(caps: RiskCaps): number {
  validateCaps(caps);
  return Math.min(caps.maxOpenCommitments * caps.maxRiskPerCommitmentUSDC, bankrollCeilingUSDC(caps));
}

/**
 * Verdict gate for an outgoing on-chain transaction (DESIGN §6). The MM has a
 * daily POL budget `maxDailyGasPolWei` with `emergencyReservePolWei` held back
 * at all times. A single tx is NOT pre-estimated (Polygon gas is tiny + EIP-1559
 * makes a cheap `estimateGas` awkward); the verdict refuses ONLY once today's
 * spend has crossed the relevant floor. Posting commitments and routine
 * off-chain cancels are gasless and are NOT gated by this verdict.
 *
 * **Two modes**:
 *   - `mayUseReserve = false` (default) — normal ops (e.g. boot-time auto-approve).
 *     Allowed when `todayGasSpentPolWei + emergencyReservePolWei < maxDailyGasPolWei`,
 *     i.e. there's headroom above the reserve floor.
 *   - `mayUseReserve = true` — reserve-eligible ops (settle / claim with
 *     `settlement.continueOnGasBudgetExhausted: true`, the on-chain kill path).
 *     Allowed when `todayGasSpentPolWei < maxDailyGasPolWei`, i.e. there's any
 *     headroom up to the full cap. The reserve is consumable for these
 *     finalize-positions ops because forfeiting access to the maker's settled
 *     payouts costs more than the gas does.
 *
 * All amounts are in **POL wei18** (POL has 18 decimals). The caller converts
 * float POL from config via `BigInt(Math.round(p * 1e18))`.
 *
 * Returns `{allowed: false, reason}` when:
 *   - `todayGasSpentPolWei < 0` (defense-in-depth — state corruption / caller bug)
 *   - `maxDailyGasPolWei <= 0` (budget disabled / zero / negative)
 *   - `emergencyReservePolWei < 0` (negative reserve)
 *   - `emergencyReservePolWei >= maxDailyGasPolWei` AND `!mayUseReserve` (operator
 *     misconfig — reserve equals or exceeds the cap, leaving zero spendable
 *     headroom for normal ops; reserve-eligible ops can still spend up to the cap)
 *   - the relevant floor is reached for the mode (see above)
 * Otherwise `{allowed: true}`.
 */
export function canSpendGas(args: {
  todayGasSpentPolWei: bigint;
  maxDailyGasPolWei: bigint;
  emergencyReservePolWei: bigint;
  /** Default `false` — opt-in for ops the operator considers more important than the daily cap (settle/claim when `continueOnGasBudgetExhausted: true`, the on-chain kill path). */
  mayUseReserve?: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  const { todayGasSpentPolWei, maxDailyGasPolWei, emergencyReservePolWei, mayUseReserve = false } = args;
  // Defense-in-depth — the state validator (`src/state/`) already rejects negative
  // decimal strings on load, but `canSpendGas` is the money/gas safety boundary
  // for the whole runner; refuse the call rather than silently allow when a caller
  // somehow constructs a negative spent value (state corruption, future caller bug).
  if (todayGasSpentPolWei < 0n) {
    return { allowed: false, reason: `todayGasSpentPolWei must be >= 0; got ${todayGasSpentPolWei.toString()} wei (state corruption?)` };
  }
  if (maxDailyGasPolWei <= 0n) {
    return { allowed: false, reason: `gas.maxDailyGasPOL must be > 0; got ${maxDailyGasPolWei.toString()} wei` };
  }
  if (emergencyReservePolWei < 0n) {
    return { allowed: false, reason: `gas.emergencyReservePOL must be >= 0; got ${emergencyReservePolWei.toString()} wei` };
  }
  if (!mayUseReserve && emergencyReservePolWei >= maxDailyGasPolWei) {
    return { allowed: false, reason: `gas.emergencyReservePOL (${emergencyReservePolWei.toString()} wei) >= gas.maxDailyGasPOL (${maxDailyGasPolWei.toString()} wei); no spendable headroom for normal ops` };
  }
  if (mayUseReserve) {
    if (todayGasSpentPolWei >= maxDailyGasPolWei) {
      return { allowed: false, reason: `today's gas spend ${todayGasSpentPolWei.toString()} wei has reached the daily cap ${maxDailyGasPolWei.toString()} wei (reserve already consumed)` };
    }
  } else {
    if (todayGasSpentPolWei + emergencyReservePolWei >= maxDailyGasPolWei) {
      return { allowed: false, reason: `today's gas spend ${todayGasSpentPolWei.toString()} wei + reserve ${emergencyReservePolWei.toString()} wei has reached the daily cap ${maxDailyGasPolWei.toString()} wei` };
    }
  }
  return { allowed: true };
}
