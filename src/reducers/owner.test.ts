import { describe, expect, it } from 'vitest';

import type {
  Fill,
  Hex,
  OwnerCommitment,
  PositionStatusEvent,
  SignedCommitmentPayload,
} from '../ospex/index.js';
import {
  emptyMakerState,
  toMakerSignedPayload,
  type MakerPositionRecord,
  type MakerPositionStatus,
} from '../state/index.js';

import {
  mapOwnerCommitmentToMaker,
  reduceOwnerCommitmentObservation,
  reduceOwnerFill,
  reduceOwnerPositionStatus,
} from './index.js';

// These reducers now write canonical `MakerState` directly (Phase 3 PR3b — the
// own-state SSE SOURCE FLIP). They project the SDK's owner payloads via the pure
// PR3a mappers (`mapOwner{Commitment,Position}ToMaker` /
// `mapPositionStatusEventToMaker`) and emit the same `mark-dirty` / `emit-fill`
// / `emit-position-transition` descriptors the poll reducers emit. The pure
// mapping logic (lifecycle routing, side derivation, terminal preservation) is
// covered in `owner-mapping.test.ts`; this file covers the reducers' STATE
// EFFECTS + descriptor emission against a `MakerState` target.

// ── fixtures ─────────────────────────────────────────────────────────────────

const OUR_ADDR = '0x9999999999999999999999999999999999999999';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';

/** A fully-populated, mappable `OwnerCommitment` (enriched per PR0b — mirrors owner-mapping.test.ts). */
function ownerCommitment(overrides: Partial<OwnerCommitment> = {}): OwnerCommitment {
  return {
    ownerAuthorized: true,
    visibility: 'visible',
    redacted: false,
    commitmentHash: '0xabc',
    maker: OUR_ADDR,
    contestId: '1',
    scorer: '0xscorer',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '250000',
    filledRiskAmount: '0',
    remainingRiskAmount: '250000',
    nonce: '1',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: null,
    signature: null,
    status: 'open',
    storedStatus: 'open',
    source: 'sse',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    speculationId: 'spec-1',
    sport: 'baseball_mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    updatedAtUnixSec: 1735689600,
    signedPayload: null,
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    speculationId: 'spec-1',
    contestId: 'contest-1',
    commitmentHash: '0xabc',
    maker: OUR_ADDR,
    taker: OTHER_ADDR,
    makerPositionType: 0,
    takerPositionType: 1,
    makerRiskAmount: '50000',
    takerRiskAmount: '75000',
    makerRiskUSDC: 0.05,
    takerRiskUSDC: 0.075,
    oddsTick: 250,
    filledAt: '2025-01-01T00:00:00.000Z',
    contestStarted: false,
    txHash: '0xtx1',
    logIndex: 0,
    ...overrides,
  };
}

function positionEvent(overrides: Partial<PositionStatusEvent> = {}): PositionStatusEvent {
  return {
    address: OUR_ADDR,
    speculationId: 'spec-1',
    positionType: 0,
    status: 'pendingSettle',
    sourceUpdatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A canonical `MakerPositionRecord` for `(spec-1, away)` at the given status. */
function makerPosition(status: MakerPositionStatus): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: '1',
    sport: 'baseball_mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    marketType: 'moneyline',
    lineTicks: 0,
    side: 'away',
    riskAmountWei6: '50000',
    counterpartyRiskWei6: '75000',
    status,
    updatedAtUnixSec: 1735689600,
  };
}

/** A canonical signed payload for the default `0xabc` commitment (hash must match the record key). */
const SIGNED_PAYLOAD: SignedCommitmentPayload = {
  commitmentHash: '0xabc' as Hex,
  commitment: {
    maker: OUR_ADDR as Hex,
    contestId: 1n,
    scorer: '0xscorer' as Hex,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    riskAmount: 250000n,
    nonce: 1n,
    expiry: 4070908800n,
  },
  signature: '0xsig' as Hex,
};

// ── reduceOwnerCommitmentObservation (canonical: writes MakerState.commitments) ─

describe('reduceOwnerCommitmentObservation', () => {
  it('inserts a previously-unseen commitment into canonical state', () => {
    const state = emptyMakerState();
    const descriptors = reduceOwnerCommitmentObservation(state, ownerCommitment({ commitmentHash: '0xnew' }));
    // visibleOpen is a lifecycle CHANGE from "no record" → mark-dirty
    expect(descriptors).toEqual([{ kind: 'mark-dirty', contestId: '1' }]);
    expect(state.commitments['0xnew']).toBeDefined();
    expect(state.commitments['0xnew']?.lifecycle).toBe('visibleOpen');
  });

  it('replaces an existing commitment when a delta event arrives, PRESERVING the observed fills[]', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    // simulate a fill having been observed against this commitment first
    state.commitments['0xabc']!.fills = [{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }];
    reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '100000' }));
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe('100000');
    expect(state.commitments['0xabc']?.lifecycle).toBe('partiallyFilled');
    // the replace must NOT wipe the SSE-fill audit/dedup array
    expect(state.commitments['0xabc']?.fills).toEqual([{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }]);
  });

  it('emits mark-dirty ONLY on a lifecycle change', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ filledRiskAmount: '100000' })); // partiallyFilled
    // same lifecycle (still partiallyFilled), only the cumulative grew → no mark-dirty
    const same = reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '120000' }));
    expect(same).toEqual([]);
    // now a real lifecycle move (partiallyFilled → filled) → mark-dirty
    const changed = reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '250000' }));
    expect(changed).toEqual([{ kind: 'mark-dirty', contestId: '1' }]);
    expect(state.commitments['0xabc']?.lifecycle).toBe('filled');
  });

  it('does NOT mutate state.positions', () => {
    const state = emptyMakerState();
    reduceOwnerCommitmentObservation(state, ownerCommitment({ filledRiskAmount: '100000' }));
    expect(state.positions).toEqual({});
  });

  it('throws OwnerMappingError on missing metadata (the runner drain catch handles it; reducers do NOT catch)', () => {
    const state = emptyMakerState();
    // empty sport is genuinely missing metadata. The reducer lets the mapper throw; the
    // runner drain catches + skips.
    expect(() => reduceOwnerCommitmentObservation(state, ownerCommitment({ sport: '' }))).toThrow();
    // With seeding OFF (the default 3rd arg) a null speculationId ALSO fails closed — a
    // matched commitment can only carry a null id transiently (indexer-lag join), which
    // must wait, not be mis-keyed to a seed placeholder.
    expect(() => reduceOwnerCommitmentObservation(state, ownerCommitment({ speculationId: null }))).toThrow();
    // state untouched on a throw
    expect(state.commitments).toEqual({});
  });

  it('a null-speculationId SEED (seeding ON) is written under its placeholder key (no throw, no cursor freeze)', () => {
    const state = emptyMakerState();
    // A seed total commitment posted before its speculation exists arrives with speculationId:null.
    const descriptors = reduceOwnerCommitmentObservation(
      state,
      ownerCommitment({ commitmentHash: '0xseed', speculationId: null, marketType: 'total', lineTicks: 85 }),
      true, // seedSpeculations
    );
    expect(descriptors).toEqual([{ kind: 'mark-dirty', contestId: '1' }]);
    const rec = state.commitments['0xseed'];
    expect(rec).toBeDefined();
    expect(rec?.speculationId).toBe('seed:1:total:85');
    expect(rec?.marketType).toBe('total');
    expect(rec?.lifecycle).toBe('visibleOpen');
  });

  it('seed → real-spec migration: a later delta carrying the real id replaces the placeholder record', () => {
    const state = emptyMakerState();
    // 1) pre-match: the seed lands under the placeholder (seeding on).
    reduceOwnerCommitmentObservation(
      state,
      ownerCommitment({ commitmentHash: '0xseed', speculationId: null, marketType: 'total', lineTicks: 85 }),
      true,
    );
    expect(state.commitments['0xseed']?.speculationId).toBe('seed:1:total:85');
    // 2) post-match: own-state re-delivers the SAME commitmentHash now carrying the real
    //    on-chain speculationId. The wholesale-replace adopts it (the keying is by hash).
    reduceOwnerCommitmentObservation(
      state,
      ownerCommitment({ commitmentHash: '0xseed', speculationId: '4217', marketType: 'total', lineTicks: 85, filledRiskAmount: '100000' }),
      true,
    );
    const rec = state.commitments['0xseed'];
    expect(rec?.speculationId).toBe('4217'); // real id adopted — no lingering placeholder
    expect(rec?.lifecycle).toBe('partiallyFilled');
  });

  it('PRESERVES a previously-captured signedPayload when a later delta arrives WITHOUT one (M#5)', () => {
    const state = emptyMakerState();
    // First observation carries the signed bundle → status 'present'.
    reduceOwnerCommitmentObservation(state, ownerCommitment({ signedPayload: SIGNED_PAYLOAD }));
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('present');
    expect(state.commitments['0xabc']?.signedPayload).toEqual(toMakerSignedPayload(SIGNED_PAYLOAD));
    // A later delta (e.g. a fill bump) arrives with signedPayload:null. The
    // captured bundle is the only handle for an authoritative on-chain cancel —
    // the wholesale replace must NOT downgrade it to 'missing-legacy'.
    reduceOwnerCommitmentObservation(
      state,
      ownerCommitment({ signedPayload: null, filledRiskAmount: '100000' }),
    );
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe('100000'); // the delta still applied
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('present'); // NOT downgraded
    expect(state.commitments['0xabc']?.signedPayload).toEqual(toMakerSignedPayload(SIGNED_PAYLOAD));
  });

  it('does NOT fabricate a payload for a commitment that never carried one (stays missing-legacy)', () => {
    const state = emptyMakerState();
    reduceOwnerCommitmentObservation(state, ownerCommitment({ signedPayload: null }));
    reduceOwnerCommitmentObservation(
      state,
      ownerCommitment({ signedPayload: null, filledRiskAmount: '100000' }),
    );
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('missing-legacy');
    expect(state.commitments['0xabc']?.signedPayload).toBeUndefined();
  });

  it('UPGRADES missing-legacy → present when a later delta DOES carry the payload', () => {
    const state = emptyMakerState();
    reduceOwnerCommitmentObservation(state, ownerCommitment({ signedPayload: null }));
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('missing-legacy');
    reduceOwnerCommitmentObservation(state, ownerCommitment({ signedPayload: SIGNED_PAYLOAD }));
    expect(state.commitments['0xabc']?.signedPayloadStatus).toBe('present');
    expect(state.commitments['0xabc']?.signedPayload).toEqual(toMakerSignedPayload(SIGNED_PAYLOAD));
  });
});

// ── reduceOwnerFill (canonical: writes MakerState.positions + commitment.fills[]) ─

describe('reduceOwnerFill — maker side (ourAddress matches fill.maker)', () => {
  it('creates the maker-side position with identity from the sibling commitment + appends commitment.fills[] + emits emit-fill{source:own-state-stream} + mark-dirty', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ filledRiskAmount: '50000' }));
    const beforeCommitmentFill = state.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill(), dedup, OUR_ADDR, 1);

    // mark-dirty + emit-fill
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toEqual({ kind: 'mark-dirty', contestId: '1' });
    const fillDesc = descriptors[1];
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') {
      expect(fillDesc.payload.source).toBe('own-state-stream');
      expect(fillDesc.payload.makerSide).toBe('away');
      expect(fillDesc.payload.takerSide).toBe('home');
      expect(fillDesc.payload.newFillWei6).toBe('50000');
      expect(fillDesc.payload.cumulativeRiskWei6).toBe('50000');
      // identity resolved from the sibling commitment (a Fill carries no sport/teams)
      expect(fillDesc.payload.sport).toBe('baseball_mlb');
      expect(fillDesc.payload.awayTeam).toBe('NYM');
      expect(fillDesc.payload.homeTeam).toBe('LAD');
      // moneyline commitment → the `market` tag is OMITTED (byte-identical NDJSON)
      expect('market' in fillDesc.payload).toBe(false);
    }

    // position created with the commitment's denormalized identity
    expect(state.positions['spec-1:away']).toMatchObject({
      speculationId: 'spec-1',
      contestId: '1',
      sport: 'baseball_mlb',
      awayTeam: 'NYM',
      homeTeam: 'LAD',
      side: 'away',
      riskAmountWei6: '50000', // our (maker) risk
      counterpartyRiskWei6: '75000', // taker risk
      status: 'active',
    });
    // commitment.fills[] appended, but commitment.filledRiskWei6 UNCHANGED
    // (that bump is owned by reduceOwnerCommitmentObservation — avoids double-count).
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe(beforeCommitmentFill);
    expect(state.commitments['0xabc']?.fills).toEqual([{ txHash: '0xtx1', logIndex: 0, amountWei6: '50000', ts: 1 }]);
    expect(dedup.size).toBe(1);
  });

  it('the created position inherits marketType / lineTicks from the sibling commitment, and the emit-fill carries the `market` tag (the only live fill source the summary buckets by)', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    expect(state.positions['spec-1:away']).toMatchObject({ marketType: 'spread', lineTicks: -15 });
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect(fillDesc.payload.market).toBe('spread');
  });

  it('dedup: same (txHash, logIndex) twice → second is a no-op', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const dedup = new Set<string>();
    reduceOwnerFill(state, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 1);
    const snap = JSON.parse(JSON.stringify(state));
    const descriptors = reduceOwnerFill(state, fill({ makerRiskAmount: '50000' }), dedup, OUR_ADDR, 2);
    expect(descriptors).toEqual([]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(snap);
  });

  it('different (txHash, logIndex) → position accumulates each fill; commitment cumulative still untouched', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const before = state.commitments['0xabc']?.filledRiskWei6;
    const dedup = new Set<string>();
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 0, makerRiskAmount: '30000', takerRiskAmount: '0' }), dedup, OUR_ADDR, 1);
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 1, makerRiskAmount: '20000', takerRiskAmount: '0' }), dedup, OUR_ADDR, 2);
    expect(state.positions['spec-1:away']?.riskAmountWei6).toBe('50000');
    expect(state.commitments['0xabc']?.fills).toHaveLength(2);
    expect(state.commitments['0xabc']?.filledRiskWei6).toBe(before);
  });

  // The EXTEND path (existing position) accumulates BOTH our risk AND the
  // counterparty risk, and the emit-fill descriptor's `cumulativeRiskWei6` is the
  // post-bump POSITION total — not the per-fill amount. Two fills on the same
  // (speculationId, side) with NON-ZERO taker risk pin both.
  it('extend path accumulates counterparty risk; the second emit-fill cumulativeRiskWei6 is the post-bump position total', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const dedup = new Set<string>();
    // Fill 1 creates the position (30000 ours / 45000 counterparty).
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 0, makerRiskAmount: '30000', takerRiskAmount: '45000' }), dedup, OUR_ADDR, 1);
    // Fill 2 EXTENDS it (+20000 ours / +30000 counterparty).
    const descriptors = reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 1, makerRiskAmount: '20000', takerRiskAmount: '30000' }), dedup, OUR_ADDR, 2);

    // Both legs accumulated: 30000+20000 ours, 45000+30000 counterparty.
    expect(state.positions['spec-1:away']?.riskAmountWei6).toBe('50000');
    expect(state.positions['spec-1:away']?.counterpartyRiskWei6).toBe('75000');

    // The SECOND emit-fill carries the post-bump POSITION total (50000), NOT the
    // per-fill amount (20000).
    const fillDesc = descriptors[1];
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') {
      expect(fillDesc.payload.newFillWei6).toBe('20000'); // this fill's own risk
      expect(fillDesc.payload.cumulativeRiskWei6).toBe('50000'); // the position total after the bump
    }
  });
});

// ── reduceOwnerFill — seed creation-fee attribution ──────────────────────────
//
// The seed-posting path writes `state.seedFeeBySpecKey[seedKey] = { feeUsdcWei6,
// charged: false, hashes: [<seed leg hash>] }` when it posts a seed. At the seed's
// FIRST match the reducer reconstructs that key from the sibling commitment's stable
// (contestId, marketType, lineTicks) AND requires the FILLING commitment's hash to be
// one of the marker's bound seed-leg hashes, stamps the fee on the emit-fill, and flips
// `charged` so the fee is attributed exactly once. The hash binding stops a later
// non-seed commitment at the same line from tripping a stale marker (a phantom fee).
// Here we PRE-SEED the marker (simulating that POST) to exercise the attribution in
// isolation. The default `ownerCommitment()` / `fill()` resolve to contestId `'1'`,
// commitmentHash `'0xabc'`.
describe('reduceOwnerFill — seed creation-fee attribution', () => {
  it('a fill whose (contestId, marketType, lineTicks) is a pending seed key AND whose hash is bound stamps feeUsdcWei6 on the emit-fill + flips charged', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    state.seedFeeBySpecKey['seed:1:spread:-15'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xabc'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect(fillDesc.payload.feeUsdcWei6).toBe('250000');
    expect(state.seedFeeBySpecKey['seed:1:spread:-15']?.charged).toBe(true);
  });

  it('does NOT charge a fill whose hash is NOT bound to the marker — a non-seed commitment at the same line never trips a stale marker (phantom-fee guard)', () => {
    const state = emptyMakerState();
    // An ordinary (non-seed) commitment 0xabc fills at the same (contest, market, line)
    // a prior, since-expired seed once used — its leg hash was 0xseedleg, not 0xabc.
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    state.seedFeeBySpecKey['seed:1:spread:-15'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xseedleg'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect('feeUsdcWei6' in fillDesc.payload).toBe(false);
    expect(state.seedFeeBySpecKey['seed:1:spread:-15']?.charged).toBe(false); // marker untouched — no phantom charge
  });

  it('records the ESTIMATE for a bound seed leg even when its commitment now carries a REAL speculationId (conservative — the MM cannot tell from own-state whether this match created the speculation)', () => {
    // Documented limitation (DESIGN §6 "Daily accounting"): the on-chain creation fee is
    // charged only when a fill lazily CREATES the speculation. The MM can't observe that, so
    // a bound seed leg's first matched fill records the estimate regardless of whether the
    // speculation was created by THIS fill (sole seeder — exact) or already existed because
    // another maker raced to create it first (the MM paid no fee — an over-estimate). This
    // pins that intentional behavior: a real, post-match speculationId on the commitment does
    // NOT change the attribution (it keys off the stable tuple + the bound hash).
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15, speculationId: '4217' }));
    state.seedFeeBySpecKey['seed:1:spread:-15'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xabc'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect(fillDesc.payload.feeUsdcWei6).toBe('250000');
    expect(state.seedFeeBySpecKey['seed:1:spread:-15']?.charged).toBe(true);
  });

  it('the fee is attributed exactly ONCE — a second fill on the same seeded speculation carries no fee', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    state.seedFeeBySpecKey['seed:1:spread:-15'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xabc'] };
    const dedup = new Set<string>();
    reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 0 }), dedup, OUR_ADDR, 1);
    const descriptors = reduceOwnerFill(state, fill({ txHash: '0xa', logIndex: 1 }), dedup, OUR_ADDR, 2);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    expect(fillDesc?.kind).toBe('emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect('feeUsdcWei6' in fillDesc.payload).toBe(false);
  });

  it('an already-charged seed key carries no fee (idempotent across a restart that reloaded the marker)', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    state.seedFeeBySpecKey['seed:1:spread:-15'] = { feeUsdcWei6: '250000', charged: true, hashes: ['0xabc'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect('feeUsdcWei6' in fillDesc.payload).toBe(false);
  });

  it('a fill on a NON-seeded speculation (empty seedFeeBySpecKey) carries no fee — byte-identical when seeding is off', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect('feeUsdcWei6' in fillDesc.payload).toBe(false);
  });

  it('keys off the commitment line, not just the contest: a pending seed entry at a DIFFERENT line is not charged', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment({ marketType: 'spread', lineTicks: -15 }));
    state.seedFeeBySpecKey['seed:1:spread:-20'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xabc'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect('feeUsdcWei6' in fillDesc.payload).toBe(false);
    expect(state.seedFeeBySpecKey['seed:1:spread:-20']?.charged).toBe(false);
  });

  it('a moneyline seed (lineTicks 0) is keyed seed:<contest>:moneyline:0 and charged', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment()); // moneyline default
    state.seedFeeBySpecKey['seed:1:moneyline:0'] = { feeUsdcWei6: '250000', charged: false, hashes: ['0xabc'] };
    const descriptors = reduceOwnerFill(state, fill(), new Set<string>(), OUR_ADDR, 1);
    const fillDesc = descriptors.find((d) => d.kind === 'emit-fill');
    if (fillDesc?.kind === 'emit-fill') expect(fillDesc.payload.feeUsdcWei6).toBe('250000');
    expect(state.seedFeeBySpecKey['seed:1:moneyline:0']?.charged).toBe(true);
  });
});

describe('reduceOwnerFill — taker side (ourAddress matches fill.taker)', () => {
  it('creates the taker-side position from the sibling commitment identity (our risk = takerRiskAmount, side = home)', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const descriptors = reduceOwnerFill(state, fill({ maker: OTHER_ADDR, taker: OUR_ADDR }), new Set<string>(), OUR_ADDR, 1);
    expect(descriptors).toHaveLength(2);
    expect(state.positions['spec-1:home']).toMatchObject({
      side: 'home', // takerPositionType 1 → home
      riskAmountWei6: '75000', // our (taker) risk
      counterpartyRiskWei6: '50000', // maker risk
      status: 'active',
    });
  });
});

describe('reduceOwnerFill — neither side matches (anomaly)', () => {
  it('emits OwnerFillForeignAddress error, does NOT mutate, but IS deduped', () => {
    const state = emptyMakerState();
    state.commitments['0xabc'] = mapOwnerCommitmentToMaker(ownerCommitment());
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill({ maker: '0xother1', taker: '0xother2' }), dedup, OUR_ADDR, 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerFillForeignAddress');
    }
    expect(state.positions).toEqual({});
    expect(state.commitments['0xabc']?.fills).toEqual([]);
    // Dedup set IS still updated — a re-delivery of the anomalous fill is a no-op.
    expect(dedup.size).toBe(1);
  });
});

describe('reduceOwnerFill — §7.2 unknown-own-fill (commitmentHash not in canonical state)', () => {
  it('returns a single signal-unknown-own-fill descriptor, mutates NOTHING, and is NOT deduped', () => {
    const state = emptyMakerState();
    const dedup = new Set<string>();
    const descriptors = reduceOwnerFill(state, fill(), dedup, OUR_ADDR, 1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('signal-unknown-own-fill');
    if (descriptors[0]?.kind === 'signal-unknown-own-fill') {
      expect(descriptors[0].payload).toEqual({
        commitmentHash: '0xabc',
        speculationId: 'spec-1',
        txHash: '0xtx1',
        logIndex: 0,
      });
    }
    // no position materialized — a Fill carries no sport/team identity (own-state SSE plan §7.2)
    expect(state.positions).toEqual({});
    expect(state.commitments).toEqual({});
    // NOT deduped — the cursor-less cold restart re-snapshots past it
    expect(dedup.size).toBe(0);
  });
});

// ── reduceOwnerPositionStatus (canonical: writes MakerState.positions) ──────────

describe('reduceOwnerPositionStatus — mapping + transitions', () => {
  function stateWith(status: MakerPositionStatus) {
    const state = emptyMakerState();
    state.positions['spec-1:away'] = makerPosition(status);
    return state;
  }

  it('forward transition active → pendingSettle updates status + emits emit-position-transition', () => {
    const state = stateWith('active');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'pendingSettle' }));
    expect(descriptors).toHaveLength(1);
    const desc = descriptors[0];
    expect(desc?.kind).toBe('emit-position-transition');
    if (desc?.kind === 'emit-position-transition') {
      expect(desc.payload.fromStatus).toBe('active');
      expect(desc.payload.toStatus).toBe('pendingSettle');
      expect(desc.payload.makerSide).toBe('away');
    }
    expect(state.positions['spec-1:away']?.status).toBe('pendingSettle');
  });

  // KEY INVERSION vs the old shadow tests: settledLost/void are now PRESERVED as
  // distinct terminals (own-state plan A7), NOT collapsed to 'claimed'.
  it('settledLost is PRESERVED as settledLost (NOT collapsed to claimed)', () => {
    const state = stateWith('claimable');
    reduceOwnerPositionStatus(state, positionEvent({ status: 'settledLost', result: 'lost' }));
    expect(state.positions['spec-1:away']?.status).toBe('settledLost');
  });

  it('void is PRESERVED as void (NOT collapsed to claimed)', () => {
    const state = stateWith('pendingSettle');
    reduceOwnerPositionStatus(state, positionEvent({ status: 'void', result: 'void' }));
    expect(state.positions['spec-1:away']?.status).toBe('void');
  });

  it('backwards transition claimable → active emits OwnerBackwardsPositionTransition and refuses', () => {
    const state = stateWith('claimable');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'active' }));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerBackwardsPositionTransition');
    }
    expect(state.positions['spec-1:away']?.status).toBe('claimable'); // unchanged
  });

  // TERMINAL IS IMMUTABLE: the terminal triple (claimed/settledLost/void) share
  // the TOP rank, so the rank check alone (`<`) would NOT catch a terminal→terminal
  // rewrite. The source's extra terminal clause refuses ANY change OUT of a terminal
  // status — a stale / out-of-order / corrupt event must not overwrite a settled
  // outcome. claimed → settledLost is the dangerous same-rank case.
  it('a terminal position (claimed) refuses ANY transition out — even another terminal (settledLost), same top rank', () => {
    const state = stateWith('claimed');
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'settledLost', result: 'lost' }));
    // The position STAYS claimed — not overwritten by the same-rank terminal.
    expect(state.positions['spec-1:away']?.status).toBe('claimed');
    // Refused via the backwards-transition error, NOT an emit-position-transition.
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerBackwardsPositionTransition');
    }
    expect(descriptors.some((d) => d.kind === 'emit-position-transition')).toBe(false);
  });

  it('unknown position → emits OwnerPositionStatusForUnknownPosition; does NOT insert', () => {
    const state = emptyMakerState();
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'active' }));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('emit-error');
    if (descriptors[0]?.kind === 'emit-error') {
      expect(descriptors[0].payload.class).toBe('OwnerPositionStatusForUnknownPosition');
    }
    expect(state.positions).toEqual({});
  });

  it('idempotent on no-status-change (no descriptor, state byte-identical apart from an ADVANCED updatedAtUnixSec)', () => {
    const state = stateWith('pendingSettle');
    const before = structuredClone(state.positions['spec-1:away']);
    // A DIFFERENT sourceUpdatedAt than the fixture (1735689600 = 2025-01-01) so the
    // updatedAtUnixSec actually moves — the old fixture collapsed it to a no-op,
    // proving nothing. 2025-06-01T00:00:00Z = 1748736000.
    const descriptors = reduceOwnerPositionStatus(state, positionEvent({ status: 'pendingSettle', sourceUpdatedAt: '2025-06-01T00:00:00.000Z' }));
    expect(descriptors).toEqual([]); // no status change → no descriptor
    const after = state.positions['spec-1:away'];
    // The record is identical to the original EXCEPT updatedAtUnixSec ADVANCED.
    expect(after?.updatedAtUnixSec).toBe(1748736000);
    expect(before?.updatedAtUnixSec).toBe(1735689600);
    expect(after).toEqual({ ...before, updatedAtUnixSec: 1748736000 });
  });
});
