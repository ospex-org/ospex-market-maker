/**
 * Canonical own-state mappers (own-state SSE plan §6 / Phase 3 PR3a).
 *
 * Pure functions that project the SDK's enriched own-state payloads
 * (`OwnerCommitment`, `OwnerPosition`, `PositionStatusEvent` — populated
 * server-side by PR0b) into the MM's canonical {@link MakerCommitmentRecord} /
 * {@link MakerPositionRecord} shapes. The PR3b **source flip** wired these in:
 * the SSE stream is the canonical own-state writer (always-on in live mode
 * since OS-Phase 4), and `src/reducers/owner.ts` uses these mappers to write
 * `MakerState` directly while the per-tick probes serve only the 60s audit
 * cross-check.
 *
 * Design contract:
 * - **Pure + no IO.** No network, no clock, no telemetry emit (own-state plan
 *   §2.5 invariant 3). Every timestamp is sourced from the SDK payload
 *   (`createdAt` / `updatedAtUnixSec` / `sourceUpdatedAt`), which reflects the
 *   actual chain/indexer event time rather than wall-clock-at-map-time.
 * - **Fail closed.** A payload missing metadata the canonical record requires
 *   as non-null (e.g. a delivered commitment with an empty `sport` / null
 *   `contestId`, or an unparseable timestamp) throws {@link OwnerMappingError}
 *   carrying the offending `field` and the record's identifier (`commitmentHash`
 *   / `speculationId`) — never a partial or coerced record. The PR3b call site
 *   catches it, emits `owner-mapping-failed`, and skips the row.
 * - **Seed tolerance — gated on `seedSpeculations`.** When the caller passes
 *   `seedSpeculations: true`, a commitment with a null `speculationId` is treated
 *   as a SEED — one posted at a market's oracle line before any speculation
 *   exists there — and maps to the stable placeholder {@link seedSpeculationId}
 *   (reconstructed from the body's reliable `contestId` / `marketType` /
 *   `lineTicks`) rather than throwing, so a pre-match seed never freezes the
 *   own-state cursor; the real id is adopted by the wholesale-replace once the
 *   speculation is created on first match. With seeding OFF (the default) a null
 *   `speculationId` stays a fail-closed case — a real commitment can only reach
 *   own-state with a null id via a transient indexer-lag join (the speculations
 *   row briefly absent), which must WAIT (skip + cold-restart), not be mis-keyed
 *   to a placeholder. So the mapper is byte-identical to the pre-seed behavior
 *   whenever seeding is off.
 * - **Wei6 only.** Canonical records carry authoritative `*Wei6` decimal
 *   strings; the SDK's float `riskAmountUSDC` / `profitAmountUSDC` fields are
 *   ignored (they exist for other consumers' backwards-compat).
 */

import type { OwnerCommitment, OwnerPosition, PositionLifecycle, PositionStatusEvent } from '../ospex/index.js';
import { seedSpeculationId } from '../orders/seed.js';
import {
  type CommitmentLifecycle,
  type MakerCommitmentRecord,
  type MakerPositionRecord,
  type MakerPositionStatus,
  type MakerSide,
  type MarketType,
  type SignedPayloadStatus,
  toMakerSignedPayload,
} from '../state/index.js';

/**
 * Thrown by the canonical mappers when an own-state payload is missing metadata
 * a {@link MakerCommitmentRecord} / {@link MakerPositionRecord} requires. The
 * envelope mirrors the success-path record's identifiers so the PR3b call site
 * can emit the standard `{ class, detail, phase, commitmentHash?, speculationId? }`
 * error event (see `ErrorEventPayload`) and the operator can correlate the
 * skipped row. Exactly one of `commitmentHash` / `speculationId` is populated.
 */
export class OwnerMappingError extends Error {
  readonly field: string;
  readonly commitmentHash: string | undefined;
  readonly speculationId: string | undefined;

  constructor(
    message: string,
    ctx: { field: string; commitmentHash?: string; speculationId?: string },
  ) {
    super(message);
    this.name = 'OwnerMappingError';
    this.field = ctx.field;
    this.commitmentHash = ctx.commitmentHash;
    this.speculationId = ctx.speculationId;
  }
}

/**
 * Derive a commitment's {@link CommitmentLifecycle} from an SDK
 * `OwnerCommitment`.
 *
 * **Mirrors `projectOwnerCommitment` (src/reducers/owner.ts) and the poll-side
 * `reducePolledCommitmentObservation` — keep all three in sync.** The shadow
 * copy is removed at the PR3b source flip; consolidating the surviving
 * mapper + poll derivation is a deferred follow-up.
 *
 * Routing precedence:
 *   - FULL fill (`filledRiskAmount >= riskAmount`) → `'filled'`.
 *   - AUTH (`storedStatus === 'cancelled'` || `nonceInvalidated`) → `'authoritativelyInvalidated'`.
 *   - Effective `'expired'` → `'expired'`.
 *   - Effective `'cancelled'` (book-hidden but not AUTH) → `'softCancelled'`.
 *   - Effective `'filled'` (cumulative not at risk yet — trust the API) → `'filled'`.
 *   - Any remaining fill (`filledRiskAmount > 0`) → `'partiallyFilled'`.
 *   - Otherwise → `'visibleOpen'`.
 */
export function deriveCommitmentLifecycle(c: OwnerCommitment): CommitmentLifecycle {
  const filled = BigInt(c.filledRiskAmount);
  const risk = BigInt(c.riskAmount);
  if (filled >= risk) return 'filled';
  if (c.storedStatus === 'cancelled' || c.nonceInvalidated) return 'authoritativelyInvalidated';
  if (c.status === 'expired') return 'expired';
  if (c.status === 'cancelled') return 'softCancelled';
  if (c.status === 'filled') return 'filled';
  if (filled > 0n) return 'partiallyFilled';
  return 'visibleOpen';
}

/**
 * Map the SDK's `PositionLifecycle` to the canonical {@link MakerPositionStatus}.
 *
 * PRESERVES the terminal `'settledLost'` / `'void'` states (own-state plan A7):
 * they are distinct zero-payout terminals, not the same as a claimed win. (The
 * poll/audit path never produces them — the API has no settledLost/void bucket.)
 * This is possible now that {@link MAKER_POSITION_STATUSES} carries both states.
 *
 * Exhaustive over `PositionLifecycle` — if the SDK enum gains a state this stops
 * compiling, which is the intended forcing function.
 */
export function mapPositionLifecycleToMaker(s: PositionLifecycle): MakerPositionStatus {
  switch (s) {
    case 'active':
      return 'active';
    case 'pendingSettle':
      return 'pendingSettle';
    case 'claimable':
      return 'claimable';
    case 'claimed':
      return 'claimed';
    case 'settledLost':
      return 'settledLost';
    case 'void':
      return 'void';
  }
}

/**
 * `positionType` 0 = away, 1 = home — the canonical Ospex protocol mapping
 * (mirrors `projectOwnerPosition` and `MakerSide`).
 */
function sideFromPositionType(positionType: 0 | 1): MakerSide {
  return positionType === 0 ? 'away' : 'home';
}

/**
 * Project an SDK `OwnerCommitment` to a canonical {@link MakerCommitmentRecord}.
 *
 * Fail-closed on the nullable SDK fields the canonical record requires as
 * non-null (`contestId` / `scorer` / `positionType` / `oddsTick`), on empty
 * denormalized identity (`sport` / `awayTeam` / `homeTeam`), and on an
 * unparseable `createdAt` / `expiry`.
 *
 * **`speculationId` is the exception, gated on `seedSpeculations`** — with
 * seeding ON, a null one is a SEED (a commitment posted before its speculation
 * exists), not missing metadata, so it maps to the {@link seedSpeculationId}
 * placeholder rather than throwing (see the module docstring); with seeding OFF
 * (the default) a null one fails closed exactly as before. The fail-closed check
 * stays first (preserving the seeding-off error precedence); `contestId` is
 * validated before the placeholder is reconstructed from it.
 *
 * `fills` is always `[]` — the mapper does NOT enumerate fills; those are
 * appended by the `onFill` reducer as `Match` events arrive (own-state plan
 * §6.3). `signedPayloadStatus` follows the SDK's `signedPayload` presence.
 */
export function mapOwnerCommitmentToMaker(
  c: OwnerCommitment,
  seedSpeculations = false,
): MakerCommitmentRecord {
  const hash = c.commitmentHash;
  if (!c.speculationId && !seedSpeculations) {
    // Seeding OFF (the default): a null/empty speculationId is missing metadata, NOT a
    // seed — a real commitment can only reach own-state with a null id via a transient
    // indexer-lag join (the speculations row briefly absent), which must wait + cold-restart
    // rather than be mis-keyed to a placeholder. Fail closed exactly as the pre-seed mapper
    // did (this check stays first so the seeding-off error precedence is byte-identical).
    throw new OwnerMappingError(`commitment ${hash}: missing speculationId`, { field: 'speculationId', commitmentHash: hash });
  }
  // contestId is validated next: it is required to reconstruct a seed's placeholder
  // speculationId below (and the record needs it regardless of the seed/non-seed path).
  if (c.contestId === null) {
    throw new OwnerMappingError(`commitment ${hash}: null contestId`, { field: 'contestId', commitmentHash: hash });
  }
  // Sourced ONCE — both the record and a seed's placeholder need them. Semantics are
  // unchanged from the per-record defaults: a null marketType is the moneyline norm
  // (the only live market core-api leaves unclassified), a null lineTicks → 0 (no line).
  const marketType: MarketType = c.marketType ?? 'moneyline';
  const lineTicks = c.lineTicks ?? 0;
  // A matched commitment carries its real on-chain speculationId. With seeding ON, a SEED
  // commitment — posted at a market's oracle line before any speculation exists there —
  // arrives with speculationId null (core-api has no speculation row to join yet; see
  // enrich.ts), and maps to the SAME stable placeholder the discovery branch minted,
  // `seed:contestId:marketType:lineTicks`, so its exposure groups with the tracked seed
  // market; the real id is adopted by the wholesale-replace once the speculation is
  // created (post-match). The body carries reliable contestId / marketType / lineTicks
  // (core-api derives market_type from the scorer at POST and stores it on the commitment
  // row, independent of whether the speculation exists), so the placeholder is reproducible.
  const speculationId = c.speculationId
    ? c.speculationId
    : seedSpeculationId(c.contestId, marketType, lineTicks);
  if (c.scorer === null) {
    throw new OwnerMappingError(`commitment ${hash}: null scorer`, { field: 'scorer', commitmentHash: hash });
  }
  if (c.positionType === null) {
    throw new OwnerMappingError(`commitment ${hash}: null positionType`, { field: 'positionType', commitmentHash: hash });
  }
  if (c.oddsTick === null) {
    throw new OwnerMappingError(`commitment ${hash}: null oddsTick`, { field: 'oddsTick', commitmentHash: hash });
  }
  if (!c.sport) {
    throw new OwnerMappingError(`commitment ${hash}: empty sport`, { field: 'sport', commitmentHash: hash });
  }
  if (!c.awayTeam) {
    throw new OwnerMappingError(`commitment ${hash}: empty awayTeam`, { field: 'awayTeam', commitmentHash: hash });
  }
  if (!c.homeTeam) {
    throw new OwnerMappingError(`commitment ${hash}: empty homeTeam`, { field: 'homeTeam', commitmentHash: hash });
  }

  const postedAtUnixSec = Math.floor(Date.parse(c.createdAt) / 1000);
  if (!Number.isFinite(postedAtUnixSec)) {
    throw new OwnerMappingError(`commitment ${hash}: unparseable createdAt "${c.createdAt}"`, { field: 'createdAt', commitmentHash: hash });
  }
  // expiry is ISO-8601 or null; null → 0 (no on-chain deadline tracked).
  const expiryUnixSec = c.expiry === null ? 0 : Math.floor(Date.parse(c.expiry) / 1000);
  if (c.expiry !== null && !Number.isFinite(expiryUnixSec)) {
    throw new OwnerMappingError(`commitment ${hash}: unparseable expiry "${c.expiry}"`, { field: 'expiry', commitmentHash: hash });
  }

  const signedPayloadStatus: SignedPayloadStatus = c.signedPayload === null ? 'missing-legacy' : 'present';
  const record: MakerCommitmentRecord = {
    hash,
    speculationId,
    contestId: c.contestId,
    sport: c.sport,
    awayTeam: c.awayTeam,
    homeTeam: c.homeTeam,
    scorer: c.scorer,
    // marketType / lineTicks were sourced above (the seed placeholder needs them too).
    // `c.marketType` is core-api's scorer-derived classification (set at POST, stored on
    // the commitment row), so it IS the real market for any live commitment; the moneyline
    // default only applies to a genuinely-null legacy body. The risk engine groups exposure
    // by speculationId (the real id, or a seed's placeholder), so this default never affects
    // grouping; its only consequence is the per-team cap exemption — a `total` body wrongly
    // defaulted to moneyline would be (incorrectly) subjected to the per-team cap, which
    // over-states team exposure (conservative, not an under-state). (The state validator,
    // by contrast, fail-CLOSES on a present-but-unknown marketType.)
    marketType,
    lineTicks,
    makerSide: sideFromPositionType(c.positionType),
    oddsTick: c.oddsTick,
    riskAmountWei6: c.riskAmount,
    filledRiskWei6: c.filledRiskAmount,
    lifecycle: deriveCommitmentLifecycle(c),
    expiryUnixSec,
    postedAtUnixSec,
    updatedAtUnixSec: c.updatedAtUnixSec,
    signedPayloadStatus,
    fills: [],
  };
  if (c.signedPayload !== null) {
    record.signedPayload = toMakerSignedPayload(c.signedPayload);
  }
  return record;
}

/**
 * Project an SDK `OwnerPosition` (a snapshot row) to a canonical
 * {@link MakerPositionRecord}.
 *
 * The snapshot's `OwnerPosition` discriminant carries only the four
 * non-terminal-lost states (`active` / `pendingSettle` / `claimable` /
 * `claimed`) — the SDK drops zero-payout `settledLost` / `void` rows from the
 * snapshot and emits those transitions exclusively as `positionStatus` events
 * (handled by {@link mapPositionStatusEventToMaker}). So the four snapshot
 * states map 1:1.
 *
 * Fail-closed on a missing `speculationId` and, for the non-terminal states,
 * empty denormalized identity (`contestId` / `sport` / `awayTeam` /
 * `homeTeam`). **`claimed` rows are exempt from the identity check**: the SDK
 * emits those four as empty strings on `claimed` rows by contract (terminal,
 * recovery-only — they carry no contest join; see `OwnerPositionBase` in the
 * SDK's `ownState.d.ts`), so empty identity there is the documented norm, not
 * corruption. The empty strings pass through to the (terminal, zero-exposure)
 * record — `MakerPositionRecord` and the state validator both accept them.
 */
export function mapOwnerPositionToMaker(p: OwnerPosition): MakerPositionRecord {
  if (!p.speculationId) {
    throw new OwnerMappingError('position: empty speculationId', { field: 'speculationId', speculationId: p.speculationId });
  }
  // `claimed` rows carry empty contestId/sport/awayTeam/homeTeam by SDK contract
  // (terminal, recovery-only). Only the live states must have full identity.
  if (p.status !== 'claimed') {
    if (!p.contestId) {
      throw new OwnerMappingError(`position ${p.speculationId}: empty contestId`, { field: 'contestId', speculationId: p.speculationId });
    }
    if (!p.sport) {
      throw new OwnerMappingError(`position ${p.speculationId}: empty sport`, { field: 'sport', speculationId: p.speculationId });
    }
    if (!p.awayTeam) {
      throw new OwnerMappingError(`position ${p.speculationId}: empty awayTeam`, { field: 'awayTeam', speculationId: p.speculationId });
    }
    if (!p.homeTeam) {
      throw new OwnerMappingError(`position ${p.speculationId}: empty homeTeam`, { field: 'homeTeam', speculationId: p.speculationId });
    }
  }

  const record: MakerPositionRecord = {
    speculationId: p.speculationId,
    contestId: p.contestId,
    sport: p.sport,
    awayTeam: p.awayTeam,
    homeTeam: p.homeTeam,
    // marketType from the position body's `market` (always present). lineTicks is NOT on the
    // own-state position body (the core-api gap), so it is 0 here — correct for moneyline (no
    // line) and harmless for spread / total: the risk engine groups exposure by speculationId
    // (which this body always carries), NOT by the line, so a snapshot-rehydrated spread / total
    // position still keys to the right speculation group even with lineTicks 0. The 0 is therefore
    // informational only; sourcing the true line (for display / telemetry) can wait for core-api
    // to add lineTicks to the position body. The fill path stamps the real line from the commitment.
    marketType: p.market,
    lineTicks: 0,
    side: sideFromPositionType(p.positionType),
    riskAmountWei6: p.riskAmountWei6,
    counterpartyRiskWei6: p.counterpartyRiskWei6,
    status: p.status,
    updatedAtUnixSec: p.updatedAtUnixSec,
  };
  // `result` lives on the pendingSettle / claimable variants only.
  if (p.status === 'pendingSettle' || p.status === 'claimable') {
    record.result = p.result;
  }
  return record;
}

/**
 * Apply a `positionStatus` event to a canonical {@link MakerPositionRecord},
 * returning the updated record. A status event only advances `status` /
 * `result` / `updatedAtUnixSec`; the position's identity and risk amounts
 * (created by the snapshot / fill path) are preserved from `prev`.
 *
 * **Pure transform — does NOT enforce forward-only ordering.** Rejecting a
 * backwards transition (and refusing any change out of a terminal status) is
 * the caller's responsibility — `reduceOwnerPositionStatus` (src/reducers/owner.ts)
 * guards direction + terminal-immutability around this pure map. The caller is also responsible
 * for resolving `prev` for `(speculationId, side)` before calling.
 *
 * `result`: `PositionStatusEvent.result` includes `'lost'`, which has no
 * {@link MakerPositionRecord} `result` representation — the `'settledLost'`
 * STATUS conveys the loss. `won` / `push` / `void` map through; `'lost'` and an
 * absent result leave `prev.result` intact (a later transition must not erase a
 * settled outcome).
 */
export function mapPositionStatusEventToMaker(
  prev: MakerPositionRecord,
  ev: PositionStatusEvent,
): MakerPositionRecord {
  const updatedAtUnixSec = Math.floor(Date.parse(ev.sourceUpdatedAt) / 1000);
  if (!Number.isFinite(updatedAtUnixSec)) {
    throw new OwnerMappingError(
      `position-status ${ev.speculationId}: unparseable sourceUpdatedAt "${ev.sourceUpdatedAt}"`,
      { field: 'sourceUpdatedAt', speculationId: ev.speculationId },
    );
  }
  const record: MakerPositionRecord = {
    ...prev,
    status: mapPositionLifecycleToMaker(ev.status),
    updatedAtUnixSec,
  };
  if (ev.result === 'won' || ev.result === 'push' || ev.result === 'void') {
    record.result = ev.result;
  }
  return record;
}
