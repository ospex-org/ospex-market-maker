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
