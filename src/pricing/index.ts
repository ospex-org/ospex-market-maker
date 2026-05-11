/**
 * Pricing: strip the consensus vig → fair value → quoting spread (economics or
 * direct mode) → two-sided quote prices → odds-tick conversion + bounds checks →
 * size each side by per-quote cap and exposure headroom. Pure functions, no SDK,
 * no chain. See DESIGN §5. (Per-market-type strategies under `strategies/` —
 * moneyline ships first; spread / total are future work.)
 */

export {
  ODDS_SCALE,
  MIN_ODDS_TICK,
  MAX_ODDS_TICK,
  USDC_DECIMALS,
  USDC_UNIT_WEI6,
  RISK_LOT_WEI6,
} from './constants.js';

export {
  americanToDecimal,
  decimalToAmerican,
  decimalToImpliedProb,
  impliedProbToDecimal,
  decimalToTick,
  tickToDecimal,
  isTickInRange,
  quantizeRiskWei6,
  wei6ToUSDC,
} from './odds.js';

export { stripVig, type FairOdds } from './vig.js';

export {
  expectedMonthlyFilledVolumeUSDC,
  deriveSpreadEconomics,
  deriveSpreadDirect,
  type DeriveSpreadResult,
  type SpreadEconomicsDiagnostics,
} from './spread.js';

export { computeQuote } from './quote.js';

export type {
  SpreadMode,
  EconomicsInputs,
  DirectInputs,
  SpreadConfig,
  QuoteCommonInputs,
  QuoteInputs,
  QuoteSide,
  QuoteResult,
} from './types.js';
