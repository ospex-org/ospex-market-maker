/**
 * The Ospex SDK adapter — the ONLY module that imports `@ospex/sdk`.
 *
 * Exposes the narrow set of calls the MM needs: reads (contests, speculations,
 * commitments, positions), the odds subscription + snapshot, commitment submit /
 * off-chain cancel / on-chain cancel / nonce-floor raise, fill polling, settle /
 * claim, allowance read + set. The SDK's provider-specific wire-field names are
 * confined to this module and mapped to neutral MM terms (`referenceGameId` /
 * `upstreamGameId`). See docs/DESIGN.md §3 and §4.
 *
 * Phase 1 wires only the read-only surface; the SDK's write methods are NOT
 * wired here until Phase 2+.
 */
export {};
