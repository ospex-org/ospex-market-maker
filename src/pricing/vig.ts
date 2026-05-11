import { decimalToImpliedProb } from './odds.js';

/** Fair (vig-stripped) odds for a two-way moneyline. */
export interface FairOdds {
  awayFairProb: number;
  homeFairProb: number;
  awayFairDecimal: number;
  homeFairDecimal: number;
  /** The consensus overround (the "vig") — how much the reference implied probs sum over 1. */
  consensusOverround: number;
}

/**
 * Strip the consensus vig from a two-way moneyline by **proportional normalization**.
 *
 * The reference implied probabilities sum to slightly more than 1; the excess is
 * the overround. Dividing each implied prob by the sum recovers fair probabilities.
 * (Proportional normalization is the v0 method — Shin / power / log-odds corrections
 * for favourite–longshot bias are future work; see DESIGN §5.)
 *
 * Throws if the reference odds don't make sense (implied probs sum ≤ 1 — a
 * "negative vig" book, almost always a data error). `computeQuote` turns this
 * into a "refuse — bad reference data" decision rather than guessing a price.
 */
export function stripVig(awayDecimal: number, homeDecimal: number): FairOdds {
  const awayImplied = decimalToImpliedProb(awayDecimal);
  const homeImplied = decimalToImpliedProb(homeDecimal);
  const total = awayImplied + homeImplied;
  if (!(total > 1)) {
    throw new Error(
      `stripVig: reference implied probabilities sum to ${total.toFixed(6)} (≤ 1) — odds look wrong (away=${awayDecimal}, home=${homeDecimal})`,
    );
  }
  const awayFairProb = awayImplied / total;
  const homeFairProb = homeImplied / total;
  return {
    awayFairProb,
    homeFairProb,
    awayFairDecimal: 1 / awayFairProb,
    homeFairDecimal: 1 / homeFairProb,
    consensusOverround: total - 1,
  };
}
