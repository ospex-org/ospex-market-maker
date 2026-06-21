/**
 * Seed-speculation identity (DESIGN §6) — the exposure group key for a **seed**
 * commitment: one posted at a market's oracle-primary line *before* any on-chain
 * speculation exists there, lazily creating the speculation on first match.
 *
 * The on-chain `speculationId` is an **auto-incrementing counter**
 * (`SpeculationModule.s_speculationIdCounter`), assigned only when the
 * speculation is created — at the seed commitment's FIRST MATCH. So a seed has
 * **no real id until then**, and the value is not derivable off chain. The risk
 * engine groups exposure by `speculationId` (any non-empty string — see
 * `ExposureItem`), so a seed needs a stable LOCAL placeholder to key its exposure
 * until the real id is observed (via own-state, post-match) and reconciled in.
 *
 * The placeholder is `seed:${contestId}:${marketType}:${lineTicks}`:
 * - **stable** per `(contest, market, line)`, so every record of one seed shares
 *   the same group key (its commitment, and — until reconciled — anything derived
 *   from it);
 * - **collision-proof** against a real id: a real `speculationId` is a decimal
 *   counter string (`"1"`, `"4217"`), and the `seed:` prefix is non-numeric, so a
 *   placeholder can never equal a real id.
 *
 * It is purely an **MM-internal** record / exposure key. The EIP-712 commitment
 * struct carries `(contestId, scorer, lineTicks)` — NOT a `speculationId` — so a
 * placeholder is never sent on chain; a seed commitment is posted by the tuple,
 * and the protocol assigns the real id at match.
 *
 * **Seed-safety invariant.** A placeholder lives only on a seed COMMITMENT record
 * pre-creation. Positions are born from own-state (the real id, post-match), so a
 * position never carries a placeholder — which is why the only numeric parses of
 * `speculationId` (auto-settle / auto-claim, which iterate `state.positions`)
 * never see one. When the real id is first observed, the seed's records are
 * reconciled onto it (the seed-lifecycle slice) so its exposure collapses into the
 * real-id group and never double-counts.
 */

import type { MarketType } from '../state/index.js';

const SEED_PREFIX = 'seed:';

/** The placeholder `speculationId` for a seed at `(contestId, marketType, lineTicks)` — stable per market+line, collision-proof vs a real (decimal) id. */
export function seedSpeculationId(contestId: string, marketType: MarketType, lineTicks: number): string {
  return `${SEED_PREFIX}${contestId}:${marketType}:${lineTicks}`;
}

/** Is `speculationId` a seed placeholder (not yet a real on-chain id)? `true` iff it was minted by {@link seedSpeculationId}. */
export function isSeedSpeculationId(speculationId: string): boolean {
  return speculationId.startsWith(SEED_PREFIX);
}
