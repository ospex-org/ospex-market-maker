/**
 * Risk engine.
 *
 * Worst-case-USDC-loss-by-outcome accounting over filled positions, `visibleOpen`
 * commitments, AND `softCancelled`-not-yet-expired commitments (latent matchable
 * exposure — an off-chain cancel does not invalidate a signed payload); cap
 * enforcement (per-commitment / contest / team / sport / bankroll / open-count /
 * gas / fee); the `PositionModule` aggregate-allowance target.
 *
 *   risk(inventory, proposedQuote, config) → { allowed, sizeUSDC } | { refused, reason }
 *
 * Implemented and unit-tested in Phase 1 (it gates Phase 3, even though no
 * Phase-1 path uses it yet). See docs/DESIGN.md §6.
 */
export {};
