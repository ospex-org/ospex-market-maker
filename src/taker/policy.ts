/**
 * Pure, fail-closed policy for the separate house taker. The reference is the raw
 * posted American price on the bettor's exact side, never a no-vig probability.
 * Float-valued outputs are display only; price, stake, cap and expiry gates use
 * exact integer/rational comparisons. Nothing here opens a wallet or writes state.
 */
import { capWei6, formatUSDC, parseConfig, type TakerConfig } from './config.js';

export interface Quote {
  hash: string;
  maker: string;
  contestId: string;
  market: 'moneyline' | 'spread' | 'total';
  lineTicks: number;
  /** Protocol maker position: 0 = away/over, 1 = home/under. */
  makerSide: 0 | 1;
  makerOddsTick: number;
  remainingMakerWei6: string;
  /** SDK public commitment expiry: a validated ISO-8601 timestamp. */
  expiry: string;
}

export interface Reference {
  contestId: string;
  market: 'moneyline' | 'spread' | 'total';
  awayLine?: number | null;
  homeLine?: number | null;
  line?: number | null;
  awayOddsAmerican?: number | null;
  homeOddsAmerican?: number | null;
  overOddsAmerican?: number | null;
  underOddsAmerican?: number | null;
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

export interface Decision {
  take: boolean;
  reason: string;
  /** Full taker stake, including on a cap refusal; never clipped to headroom. */
  stakeWei6: string;
  bettorSide: 'away' | 'home' | 'over' | 'under' | null;
  bettorDecimal: number | null;
  referenceAmerican: number | null;
  referenceProbability: number | null;
  /** Upstream price timestamp. Poll/changed timestamps must also be valid. */
  referenceObservedAt: string | null;
  secondsLeft: number | null;
  /** Actual signed (taker probability - raw reference probability) * 100. */
  distancePp: number | null;
  /** Nonnegative available headroom before this proposed take. */
  remainingCapWei6: string;
}

interface Rational { numerator: bigint; denominator: bigint }
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value && !/\s|\0/.test(value);
}

function uint256(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.trim() !== value || !/^(?:0|[1-9]\d*)$/.test(value) || value.length > 78) return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

/** Exact rational of the numeric field's decimal representation, including exponents. */
function decimalRational(value: number): Rational {
  const [coefficient = '0', exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole = '0', fraction = ''] = coefficient.split('.');
  const numerator = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? { numerator, denominator: 10n ** BigInt(scale) }
    : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n };
}

/** Display conversion only. The fallback avoids Infinity/Infinity on extreme finite inputs. */
function displayRatio(numerator: bigint, denominator: bigint): number {
  const n = Number(numerator);
  const d = Number(denominator);
  if (Number.isFinite(n) && Number.isFinite(d)) return n / d;
  const scale = 10n ** 18n;
  return Number(numerator * scale / denominator) / Number(scale);
}

function americanProbability(value: unknown): Rational | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return null;
  const odds = decimalRational(value);
  return value > 0
    ? { numerator: 100n * odds.denominator, denominator: odds.numerator + 100n * odds.denominator }
    : { numerator: -odds.numerator, denominator: -odds.numerator + 100n * odds.denominator };
}

function exactLineTicks(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const line = decimalRational(value);
  const scaled = line.numerator * 10n;
  return scaled % line.denominator === 0n ? scaled / line.denominator : null;
}

/** Require an actual RFC3339 calendar date, not Date.parse's permissive rollovers. */
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/** No I/O, time reads, market-maker risk imports, price normalization, or stake clipping. */
export function evaluate(
  quote: Quote,
  reference: Reference | null,
  config: TakerConfig,
  nowMs: number,
  spentAndReservedWei6: bigint,
): Decision {
  const decision: Decision = {
    take: false,
    reason: '',
    stakeWei6: '0',
    bettorSide: null,
    bettorDecimal: null,
    referenceAmerican: null,
    referenceProbability: null,
    referenceObservedAt: null,
    secondsLeft: null,
    distancePp: null,
    remainingCapWei6: '0',
  };
  const pass = (reason: string): Decision => ({ ...decision, take: false, reason });

  // Revalidate here too: a typed caller can bypass parseConfig or mutate its result.
  let cfg: TakerConfig;
  try {
    cfg = parseConfig(config);
  } catch {
    return pass('invalid taker config');
  }
  if (typeof spentAndReservedWei6 !== 'bigint' || spentAndReservedWei6 < 0n) {
    return pass('invalid spent and reserved amount');
  }
  const remaining = capWei6(cfg) - spentAndReservedWei6;
  decision.remainingCapWei6 = (remaining > 0n ? remaining : 0n).toString();

  if (!isObject(quote)) return pass('malformed quote');
  if (typeof quote.hash !== 'string' || quote.hash.length !== 66 || !HASH.test(quote.hash)) return pass('malformed commitment hash');
  if (typeof quote.maker !== 'string' || quote.maker.length !== 42 || !ADDRESS.test(quote.maker) || quote.maker.toLowerCase() === ZERO_ADDRESS) {
    return pass('malformed maker address');
  }
  if (!identifier(quote.contestId)) return pass('malformed contest identifier');
  if (!['moneyline', 'spread', 'total'].includes(quote.market)) return pass('unsupported market');
  if (quote.makerSide !== 0 && quote.makerSide !== 1) return pass('malformed maker side');
  decision.bettorSide = quote.market === 'total'
    ? (quote.makerSide === 0 ? 'under' : 'over')
    : (quote.makerSide === 0 ? 'home' : 'away');

  const maker = quote.maker.toLowerCase();
  if (maker === cfg.wallet.address) return pass('self maker is excluded');
  if (cfg.houseWallets.some((entry) => entry.address === maker)) return pass('house maker is excluded');
  if (!cfg.makers.some((entry) => entry.address === maker)) return pass('maker is not in the allowlist');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return pass('invalid current timestamp');
  if (!Number.isInteger(quote.lineTicks) || quote.lineTicks < -2_147_483_648 || quote.lineTicks > 2_147_483_647) {
    return pass('malformed line ticks');
  }
  if (quote.market === 'moneyline' && quote.lineTicks !== 0) return pass('moneyline requires zero line ticks');
  // Protocol odds are stored maker ticks, constrained to [101, 10100].
  const tick = quote.makerOddsTick;
  if (!Number.isInteger(tick) || tick < 101 || tick > 10_100) return pass('malformed maker odds tick');
  const makerWei6 = uint256(quote.remainingMakerWei6);
  if (makerWei6 === null || makerWei6 <= 0n || makerWei6 % 100n !== 0n) {
    return pass('maker remainder must be positive integer wei6 in 100-wei6 lots');
  }
  const stake = makerWei6 * BigInt(tick - 100) / 100n;
  if (stake > UINT256_MAX) return pass('full taker stake exceeds uint256');
  decision.stakeWei6 = stake.toString();
  decision.bettorDecimal = tick / (tick - 100); // NEVER a rounded inverse tick.

  if (!timestamp(quote.expiry)) return pass('malformed expiry: expected an ISO-8601 timestamp');
  // Match the SDK public-book representation and its Date.parse millisecond semantics.
  const millisecondsLeft = BigInt(Date.parse(quote.expiry)) - BigInt(nowMs);
  decision.secondsLeft = Number(millisecondsLeft) / 1_000;
  const minimum = decimalRational(cfg.minSecondsLeft);
  if (millisecondsLeft * minimum.denominator < minimum.numerator * 1_000n) {
    return pass('not enough seconds left before expiry');
  }

  if (!isObject(reference)) return pass('missing or malformed reference');
  if (reference.contestId !== quote.contestId) return pass('reference contest does not match');
  if (reference.market !== quote.market) return pass('reference market does not match');
  if (!timestamp(reference.upstreamLastUpdated) || !timestamp(reference.pollCapturedAt) || !timestamp(reference.changedAt)) {
    return pass('missing or invalid reference timestamp');
  }
  // Intentionally no maximum age: old but valid posted prices are valid references.
  decision.referenceObservedAt = reference.upstreamLastUpdated;
  if (quote.market === 'spread') {
    const away = exactLineTicks(reference.awayLine);
    const home = exactLineTicks(reference.homeLine);
    if (away === null || home === null || away !== -home || away !== BigInt(quote.lineTicks)) {
      return pass('reference spread line does not match the away-perspective line');
    }
  } else if (quote.market === 'total' && exactLineTicks(reference.line) !== BigInt(quote.lineTicks)) {
    return pass('reference total line does not match');
  }

  const american = {
    away: reference.awayOddsAmerican,
    home: reference.homeOddsAmerican,
    over: reference.overOddsAmerican,
    under: reference.underOddsAmerican,
  }[decision.bettorSide];
  const probability = americanProbability(american);
  if (probability === null || typeof american !== 'number') return pass('missing or invalid exact-side reference odds');
  decision.referenceAmerican = american;
  decision.referenceProbability = displayRatio(probability.numerator, probability.denominator);
  const tickUnits = BigInt(tick);
  // p(taker) = (T - 100) / T; raw p(reference) is NOT de-vigged or complemented.
  const difference = (tickUnits - 100n) * probability.denominator - probability.numerator * tickUnits;
  const denominator = tickUnits * probability.denominator;
  decision.distancePp = displayRatio(difference * 100n, denominator);

  const tolerance = decimalRational(cfg.distancePp);
  // Signed, inclusive comparison: better prices always pass, however far below reference.
  if (difference * 100n * tolerance.denominator > tolerance.numerator * denominator) {
    return pass(`price is worse than the raw reference by more than ${cfg.distancePp} pp`);
  }
  if (stake > remaining) return pass(`would exceed the cap by ${formatUSDC(stake - remaining)} USDC`);
  return { ...decision, take: true, reason: 'within the raw reference price tolerance' };
}
