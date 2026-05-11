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

function validateItems(items: readonly ExposureItem[]): void {
  if (!Array.isArray(items)) fail(`inventory.items must be an array, got ${describe(items)}`);
  items.forEach((it, i) => {
    validateMakerSide(it.makerSide, `inventory.items[${i}].makerSide`);
    requireFiniteNonNeg(it.riskAmountUSDC, `inventory.items[${i}].riskAmountUSDC`);
  });
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

function outcomeLossUnchecked(items: readonly ExposureItem[], contestId: string): OutcomeLoss {
  let ifAwayWins = 0;
  let ifHomeWins = 0;
  for (const it of items) {
    if (it.contestId !== contestId) continue;
    if (it.makerSide === 'home') ifAwayWins += it.riskAmountUSDC; // maker on home → loses if away wins
    else ifHomeWins += it.riskAmountUSDC; //                         maker on away → loses if home wins
  }
  return { ifAwayWins, ifHomeWins };
}

function contestWorstCaseUnchecked(items: readonly ExposureItem[], contestId: string): number {
  const { ifAwayWins, ifHomeWins } = outcomeLossUnchecked(items, contestId);
  return Math.max(ifAwayWins, ifHomeWins);
}

function contestIds(items: readonly ExposureItem[]): Set<string> {
  return new Set(items.map((it) => it.contestId));
}

function totalWorstCaseUnchecked(items: readonly ExposureItem[]): number {
  let total = 0;
  for (const id of contestIds(items)) total += contestWorstCaseUnchecked(items, id);
  return total;
}

function sportWorstCaseUnchecked(items: readonly ExposureItem[], sport: string): number {
  let total = 0;
  for (const id of contestIds(items)) {
    if (items.some((it) => it.contestId === id && it.sport === sport)) total += contestWorstCaseUnchecked(items, id);
  }
  return total;
}

function teamExposureUnchecked(items: readonly ExposureItem[], team: string): number {
  let total = 0;
  for (const it of items) {
    const makerSideTeam = it.makerSide === 'away' ? it.awayTeam : it.homeTeam;
    if (makerSideTeam === team) total += it.riskAmountUSDC;
  }
  return total;
}

// ── public exposure accessors ────────────────────────────────────────────────

/** Worst-case loss for a contest, per outcome — sum the at-risk USDC of items on the *losing* side in each outcome. */
export function worstCaseByOutcome(items: readonly ExposureItem[], contestId: string): OutcomeLoss {
  validateItems(items);
  return outcomeLossUnchecked(items, contestId);
}

/** Total worst-case USDC loss across all contests (conservative — contests are independent, so this sums their per-contest worst cases). */
export function totalWorstCaseUSDC(items: readonly ExposureItem[]): number {
  validateItems(items);
  return totalWorstCaseUnchecked(items);
}

/** Current directional exposure to a team — the at-risk USDC the maker loses if that team loses (summed across all contests). */
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
 */
export function headroomForSide(inventory: Inventory, market: Market, makerSide: MakerSide, caps: RiskCaps): number {
  validateInventory(inventory);
  validateCaps(caps);
  validateMakerSide(makerSide, 'makerSide');
  const { items } = inventory;
  const loss = outcomeLossUnchecked(items, market.contestId);
  // adding Δ to `makerSide` raises the outcome bucket where that side loses:
  const currentLossInThatBucket = makerSide === 'away' ? loss.ifHomeWins : loss.ifAwayWins;
  const team = makerSide === 'away' ? market.awayTeam : market.homeTeam;
  return Math.max(
    0,
    Math.min(
      caps.maxRiskPerCommitmentUSDC,
      caps.maxRiskPerContestUSDC - currentLossInThatBucket,
      caps.maxRiskPerTeamUSDC - teamExposureUnchecked(items, team),
      caps.maxRiskPerSportUSDC - sportWorstCaseUnchecked(items, market.sport),
      bankrollCeilingUSDC(caps) - totalWorstCaseUnchecked(items),
    ),
  );
}

/** Should the maker even try to quote `market` now? Refuses on a global cap (open-commitment count, bankroll ceiling) or if neither side has headroom. */
export function verdictForMarket(inventory: Inventory, market: Market, caps: RiskCaps): RiskVerdict {
  validateInventory(inventory);
  validateCaps(caps);
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
