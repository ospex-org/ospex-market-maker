/**
 * Off-chain line-sanity rail (locked decision #1, DESIGN §5).
 *
 * A single conservative magnitude bound on a speculation's `lineTicks` — the
 * int32, 10×-scaled line value (a `-3.5` run line is `-35`; a `220.5` total is
 * `2205`). The market-maker REFUSES to sign or quote a commitment whose line
 * falls outside this band: a fat-finger / operator-error rail, deliberately far
 * tighter than the SDK's catastrophic-overflow `MAX_LINE_TICKS` floor
 * (`±1,000,000` ticks = `±100,000.0`).
 *
 * Why a hard rail and not a cosmetic check: the *deployed* `SpreadScorerModule`
 * computes `adjustedAway = scaledAway + lineTicks` in CHECKED `int32` arithmetic
 * with NO on-chain magnitude bound, so a pathological spread line permanently
 * reverts settlement and locks the escrow of every position on that speculation
 * (the protocol is zero-admin / non-upgradeable; the contract fix is staged but
 * not yet deployed). The MM must never put its name on such a line. Real oracle
 * lines (run lines `±1.5`, totals `7`–`260`) sit two-to-three orders of magnitude
 * inside this band, so legitimate quoting is unaffected; moneyline — `lineTicks`
 * is always `0` — always passes.
 *
 * The single global magnitude is intentionally coarse: it catches thousands-scale
 * fat-fingers across every sport without per-(sport, market) tables. Tightening to
 * per-market bands is a noted future refinement, not part of this rail.
 */

import { MM_MAX_SANE_LINE_TICKS } from './constants.js';

/**
 * Thrown when a `lineTicks` falls outside the market-maker's line-sanity band.
 * Carries the offending value + the bound so callers can log / classify it.
 */
export class LineOutOfSanityBandError extends Error {
  readonly lineTicks: number;
  readonly maxAbsLineTicks: number;
  constructor(lineTicks: number) {
    super(
      `lineTicks ${lineTicks} is outside the market-maker line-sanity band ` +
        `(|lineTicks| must be an integer <= ${MM_MAX_SANE_LINE_TICKS}, i.e. |line| <= ${MM_MAX_SANE_LINE_TICKS / 10})`,
    );
    this.name = 'LineOutOfSanityBandError';
    this.lineTicks = lineTicks;
    this.maxAbsLineTicks = MM_MAX_SANE_LINE_TICKS;
  }
}

/**
 * `true` if `lineTicks` is an integer within the MM's conservative line-sanity
 * band (`|lineTicks| <= MM_MAX_SANE_LINE_TICKS`). Moneyline (`0`) is always within
 * band. A non-integer, non-finite, or out-of-band value is rejected.
 */
export function isLineWithinSanityBand(lineTicks: number): boolean {
  return Number.isInteger(lineTicks) && Math.abs(lineTicks) <= MM_MAX_SANE_LINE_TICKS;
}

/**
 * Return `lineTicks` unchanged if it is within the MM's line-sanity band, else
 * throw {@link LineOutOfSanityBandError}. The pure hard backstop that stops the MM
 * from ever signing a fat-finger / fund-lockable line.
 */
export function assertLineWithinSanityBand(lineTicks: number): number {
  if (!isLineWithinSanityBand(lineTicks)) throw new LineOutOfSanityBandError(lineTicks);
  return lineTicks;
}
