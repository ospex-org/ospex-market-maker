/**
 * Risk engine (DESIGN §6).
 *
 * Exposure is **worst-case USDC loss by outcome**, not a simple sum: a filled
 * position (or an open / soft-cancelled-not-yet-expired commitment) on side X
 * loses its `riskAmountUSDC` if X loses. The caps bind those outcome buckets:
 * per-commitment, per-contest, per-team, per-sport, and total bankroll. All pure
 * functions — no SDK, no chain. The orders / runner layer builds the `Inventory`
 * (from positions + commitments) and the `RiskCaps` (from the parsed `Config`).
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

/** Worst-case loss for a contest, per outcome — sum the at-risk USDC of items on the *losing* side in each outcome. */
export function worstCaseByOutcome(items: readonly ExposureItem[], contestId: string): OutcomeLoss {
  let ifAwayWins = 0;
  let ifHomeWins = 0;
  for (const it of items) {
    if (it.contestId !== contestId) continue;
    if (it.makerSide === 'home') ifAwayWins += it.riskAmountUSDC; // maker on home → loses if away wins
    else ifHomeWins += it.riskAmountUSDC; //                         maker on away → loses if home wins
  }
  return { ifAwayWins, ifHomeWins };
}

/** A contest's worst-case loss = max over its two outcomes. */
function contestWorstCase(items: readonly ExposureItem[], contestId: string): number {
  const { ifAwayWins, ifHomeWins } = worstCaseByOutcome(items, contestId);
  return Math.max(ifAwayWins, ifHomeWins);
}

function contestIds(items: readonly ExposureItem[]): Set<string> {
  return new Set(items.map((it) => it.contestId));
}

/** Total worst-case USDC loss across all contests (conservative — contests are independent, so this sums their per-contest worst cases). */
export function totalWorstCaseUSDC(items: readonly ExposureItem[]): number {
  let total = 0;
  for (const id of contestIds(items)) total += contestWorstCase(items, id);
  return total;
}

/** Total worst-case USDC loss across all contests belonging to `sport`. */
function sportWorstCaseUSDC(items: readonly ExposureItem[], sport: string): number {
  let total = 0;
  for (const id of contestIds(items)) {
    if (items.some((it) => it.contestId === id && it.sport === sport)) total += contestWorstCase(items, id);
  }
  return total;
}

/** Current directional exposure to a team — the at-risk USDC the maker loses if that team loses (summed across all contests). */
export function teamExposureUSDC(items: readonly ExposureItem[], team: string): number {
  let total = 0;
  for (const it of items) {
    const makerSideTeam = it.makerSide === 'away' ? it.awayTeam : it.homeTeam;
    if (makerSideTeam === team) total += it.riskAmountUSDC;
  }
  return total;
}

const bankrollCeilingUSDC = (caps: RiskCaps): number => caps.bankrollUSDC * caps.maxBankrollUtilizationPct;

/**
 * Max *additional* at-risk USDC the maker may take on `makerSide` of `market`
 * without breaching any exposure cap (DESIGN §6). Bounded by the per-commitment
 * cap and the per-contest / per-team / per-sport / bankroll headroom — never
 * over-estimates (fail closed). Always ≥ 0.
 */
export function headroomForSide(inventory: Inventory, market: Market, makerSide: MakerSide, caps: RiskCaps): number {
  const { items } = inventory;
  const loss = worstCaseByOutcome(items, market.contestId);
  // adding Δ to `makerSide` raises the bucket where that side loses:
  const currentLossInThatBucket = makerSide === 'away' ? loss.ifHomeWins : loss.ifAwayWins;
  const team = makerSide === 'away' ? market.awayTeam : market.homeTeam;
  return Math.max(
    0,
    Math.min(
      caps.maxRiskPerCommitmentUSDC,
      caps.maxRiskPerContestUSDC - currentLossInThatBucket,
      caps.maxRiskPerTeamUSDC - teamExposureUSDC(items, team),
      caps.maxRiskPerSportUSDC - sportWorstCaseUSDC(items, market.sport),
      bankrollCeilingUSDC(caps) - totalWorstCaseUSDC(items),
    ),
  );
}

/** Should the maker even try to quote `market` now? Refuses on a global cap (open-commitment count, bankroll ceiling) or if neither side has headroom. */
export function verdictForMarket(inventory: Inventory, market: Market, caps: RiskCaps): RiskVerdict {
  if (inventory.openCommitmentCount >= caps.maxOpenCommitments) {
    return {
      allowed: false,
      reason: `at the max open-commitment count (${inventory.openCommitmentCount} / ${caps.maxOpenCommitments})`,
    };
  }
  const total = totalWorstCaseUSDC(inventory.items);
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
  return Math.min(caps.maxOpenCommitments * caps.maxRiskPerCommitmentUSDC, bankrollCeilingUSDC(caps));
}
