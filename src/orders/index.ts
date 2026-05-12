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
import { headroomForSide, type Inventory, type Market, type RiskCaps } from '../risk/index.js';

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

/** What `buildDesiredQuote` produces: the reference-odds breakdown, the per-side exposure headroom it priced against, and the `computeQuote` result. */
export interface DesiredQuote {
  referenceOdds: ReferenceOddsBreakdown;
  /** Max additional at-risk USDC on each side without breaching a cap (from `src/risk/headroomForSide`, given the inventory passed in). */
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
 * Price a two-sided moneyline quote for `market`: derive the exposure headroom on
 * each side from `inventory` + the config's caps, strip the consensus vig, derive
 * the spread (economics or direct mode per `config.pricing`), and size each side.
 * Pure — delegates to `src/risk/headroomForSide` and `src/pricing/computeQuote`.
 *
 * Refusals from the math (spread too wide, lopsided line, no headroom, …) come
 * back as `result.canQuote === false` with `result.notes`. Throws only on
 * malformed config-derived parameters (`computeQuote`'s caller-arg validation) —
 * which a parsed `Config` should never produce.
 */
export function buildDesiredQuote(
  config: Config,
  market: Market,
  refOdds: ReferenceMoneylineAmerican,
  inventory: Inventory,
): DesiredQuote {
  const caps = toRiskCaps(config);
  const awayHeadroomUSDC = headroomForSide(inventory, market, 'away', caps);
  const homeHeadroomUSDC = headroomForSide(inventory, market, 'home', caps);
  const referenceOdds = breakdownReferenceOdds(refOdds.away, refOdds.home);
  const inputs = buildQuoteInputs(config, referenceOdds, awayHeadroomUSDC, homeHeadroomUSDC);
  const result = computeQuote(inputs);
  return { referenceOdds, headroomUSDC: { away: awayHeadroomUSDC, home: homeHeadroomUSDC }, result };
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
