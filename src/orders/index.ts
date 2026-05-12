/**
 * Order lifecycle — the *planning* layer (DESIGN §9). Phase 2 (`run --dry-run`):
 * build the desired quote for a market from the config + reference odds + the
 * current exposure headroom. Phase 2.x will add `inventoryFromState` (persisted
 * state → the risk engine's `Inventory`) and `reconcileBook` (current commitments
 * vs the desired quote → what to submit / soft-cancel / replace); Phase 3 adds
 * the *execution* layer (the actual SDK write calls + the authoritative on-chain
 * cancel / nonce-floor paths).
 *
 * Pure functions — no SDK, no chain. `buildDesiredQuote` is the single source of
 * truth for "config + reference odds + headroom → a two-sided quote"; both
 * `ospex-mm quote --dry-run` (with an empty inventory) and the Phase-2 runner
 * (with the live inventory) call it.
 */

import type { Config } from '../config/index.js';
import { americanToDecimal, computeQuote, decimalToImpliedProb, type QuoteInputs, type QuoteResult } from '../pricing/index.js';
import { headroomForSide, verdictForMarket, type Inventory, type Market, type RiskCaps } from '../risk/index.js';

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
