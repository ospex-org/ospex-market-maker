/**
 * The taker ↔ protocol-maker conversion boundary (DESIGN §5).
 *
 * The pricing and orders layers think in *taker* terms: "what price are we
 * offering someone who wants to back the away team / home team?" — a quote with a
 * half-spread baked in, so the taker gets slightly-worse-than-fair odds (and the
 * maker, taking the other side, holds the edge). The Ospex protocol stores a
 * commitment the other way round, as the *maker's* side and odds: `positionType`
 * (`Upper`/`0` = away/over, `Lower`/`1` = home/under — `OspexTypes.sol`) is the
 * side the maker wins on, `oddsTick` is the maker's decimal × 100, and a taker
 * who matches receives the *opposite* side at `inverseOddsTick(oddsTick)`.
 *
 * `toProtocolQuote` is the single place that conversion happens — a taker-facing
 * `{ side, oddsTick }` becomes the protocol commitment's `{ makerSide,
 * makerOddsTick, positionType }`. Pure: no SDK, no chain. Keeping it here, rather
 * than inlined at each call site, is what stops the maker-vs-taker side confusion
 * from leaking back into the codebase.
 */

import { inverseOddsTick } from './odds.js';

/** Protocol position type: `Upper` (`0`) = away/over, `Lower` (`1`) = home/under (`OspexTypes.sol`). */
export type PositionType = 0 | 1;

/** A moneyline outcome side. (Spread / total `over`/`under` support is future work.) */
export type Side = 'away' | 'home';

function assertSide(side: Side, name: string): void {
  if (side !== 'away' && side !== 'home') {
    throw new Error(`${name} must be "away" or "home", got ${String(side)}`);
  }
}

/** The other moneyline outcome. `away` ↔ `home`. */
export function oppositeSide(side: Side): Side {
  assertSide(side, 'oppositeSide: side');
  return side === 'away' ? 'home' : 'away';
}

/** The protocol `positionType` for a maker on `side`: `away` → `Upper` (`0`), `home` → `Lower` (`1`). */
export function positionTypeForSide(side: Side): PositionType {
  assertSide(side, 'positionTypeForSide: side');
  return side === 'away' ? 0 : 1;
}

/** The moneyline side a maker with `positionType` is on: `Upper` (`0`) → `away`, `Lower` (`1`) → `home`. */
export function sideForPositionType(positionType: PositionType): Side {
  if (positionType !== 0 && positionType !== 1) {
    throw new Error(`sideForPositionType: positionType must be 0 or 1, got ${String(positionType)}`);
  }
  return positionType === 0 ? 'away' : 'home';
}

/** A taker-facing quote: the side a taker would back, and the decimal-odds tick they'd receive for it. */
export interface TakerQuote {
  side: Side;
  oddsTick: number;
}

/** A protocol commitment's maker-side parameters. */
export interface ProtocolQuote {
  /** The side the maker is on (the maker wins if it wins) — the *opposite* of the taker's side. */
  makerSide: Side;
  /** The maker's odds tick (decimal × 100) — `inverseOddsTick` of the taker's tick. */
  makerOddsTick: number;
  /** The protocol `positionType` — `positionTypeForSide(makerSide)`. */
  positionType: PositionType;
}

/**
 * Convert a taker-facing quote to the protocol commitment's maker-side parameters:
 * `{ side: 'away', oddsTick: T }` → `{ makerSide: 'home', makerOddsTick:
 * inverseOddsTick(T), positionType: 1 }`. Offering a taker the away side means the
 * *maker* takes the home side, and the maker's odds are the inverse of what the
 * taker gets. Throws on a bad side or an out-of-range odds tick (the latter via
 * `inverseOddsTick`).
 */
export function toProtocolQuote(taker: TakerQuote): ProtocolQuote {
  const makerSide = oppositeSide(taker.side);
  return {
    makerSide,
    makerOddsTick: inverseOddsTick(taker.oddsTick),
    positionType: positionTypeForSide(makerSide),
  };
}
