/**
 * Pricing: strip the consensus vig → fair value → quoting spread (economics or
 * direct mode) → two-sided quote prices → odds-tick conversion + bounds checks.
 * Per-market-type strategies live under `strategies/` (moneyline first; spread /
 * total are stubs that throw "not yet implemented"). Pure functions, heavily
 * unit-tested. See docs/DESIGN.md §5.
 */
export {};
