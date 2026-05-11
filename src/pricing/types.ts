import type { FairOdds } from './vig.js';

export type SpreadMode = 'economics' | 'direct';

/** Operator economics, used in `mode: 'economics'` to derive the quoting spread. */
export interface EconomicsInputs {
  /** Target return on capital per month, as a fraction. `0.005` = 0.5%/month. */
  targetMonthlyReturnPct: number;
  /** Days the operator has to hit the target. */
  daysHorizon: number;
  /** Rough count of quotable games per day across the configured sports. */
  estGamesPerDay: number;
  /** Fraction of quoted USDC assumed to fill. FLAGGED ASSUMPTION (DESIGN §5). */
  fillRateAssumption: number;
  /** How many times capital recycles per day. ~1.0 for same-day-settling sports. */
  capitalTurnoverPerDay: number;
  /** Refuse to start if the derived spread exceeds this fraction. ~0.05 = 5%. */
  maxReasonableSpread: number;
}

/** Direct-mode spread input — the embedded spread, in basis points. */
export interface DirectInputs {
  spreadBps: number;
}

/** The spread-derivation discriminant (one of the two modes carries its params). */
export type SpreadConfig =
  | { mode: 'economics'; economics: EconomicsInputs }
  | { mode: 'direct'; direct: DirectInputs };

/** Inputs common to both spread modes. */
export interface QuoteCommonInputs {
  /** Reference (consensus) decimal odds for the away side. */
  consensusAwayDecimal: number;
  /** Reference (consensus) decimal odds for the home side. */
  consensusHomeDecimal: number;
  /** Total capital allocated to the maker (USDC). */
  capitalUSDC: number;
  /** Per-quote concentration cap, as a fraction of capital. ~0.05 = 5%. */
  maxPerQuotePctOfCapital: number;
  /** Require at least this much spread (bps) to bother quoting. `0` = no minimum. */
  minEdgeBps: number;
  /** Whether to quote both sides. v0 supports only `true`. */
  quoteBothSides: boolean;
  /**
   * Headroom (USDC) for *additional* risk on each side of this market — computed
   * by the risk engine from the worst-case-by-outcome caps (DESIGN §6). Tests and
   * direct callers pass the available headroom on each side directly.
   */
  awayHeadroomUSDC: number;
  homeHeadroomUSDC: number;
}

/** Full input to `computeQuote` for a single moneyline market. */
export type QuoteInputs = QuoteCommonInputs & SpreadConfig;

/** A quoted side of a market. */
export interface QuoteSide {
  side: 'away' | 'home';
  /** The probability we're quoting (fair + half-spread). */
  quoteProb: number;
  /** Decimal odds (`1 / quoteProb`). */
  quoteDecimal: number;
  /** American odds. */
  quoteAmerican: number;
  /** uint16 odds tick (`round(quoteDecimal × 100)`). */
  quoteTick: number;
  /** Quoted size, USDC — the quantized amount actually quoted. */
  sizeUSDC: number;
  /** Quoted size in wei6 — a valid risk amount (multiple of `RISK_LOT_WEI6`). */
  sizeWei6: number;
}

/** Result of `computeQuote`. */
export interface QuoteResult {
  /** True if at least one side has a quote. */
  canQuote: boolean;
  /** The away-side quote, or `null` if that side is pulled / the quote was refused. */
  away: QuoteSide | null;
  /** The home-side quote, or `null` if that side is pulled / the quote was refused. */
  home: QuoteSide | null;
  /** Fair (vig-stripped) odds, or `null` if the reference odds were rejected. */
  fair: FairOdds | null;
  /** The quoting spread (fraction), or `null` if refused before deriving one. */
  spread: number | null;
  /** Target monthly return (USDC) — economics mode only, else `null`. */
  targetMonthlyReturnUSDC: number | null;
  /** Expected monthly filled volume (USDC) — economics mode only, else `null`. */
  expectedMonthlyFilledVolumeUSDC: number | null;
  /** Human-readable diagnostics: refusal reasons (prefixed `REFUSE:`), upsize notes, etc. */
  notes: string[];
}
