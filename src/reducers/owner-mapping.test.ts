import { describe, expect, it } from 'vitest';

import type {
  Hex,
  OwnerCommitment,
  OwnerPosition,
  PositionStatusEvent,
  SignedCommitmentPayload,
} from '../ospex/index.js';
import type { MakerPositionRecord } from '../state/index.js';
import {
  OwnerMappingError,
  deriveCommitmentLifecycle,
  mapOwnerCommitmentToMaker,
  mapOwnerPositionToMaker,
  mapPositionLifecycleToMaker,
  mapPositionStatusEventToMaker,
} from './owner-mapping.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const OUR_ADDR = '0x1111111111111111111111111111111111111111';

/** A fully-populated, mappable `OwnerCommitment` (enriched per PR0b). */
function commitment(overrides: Partial<OwnerCommitment> = {}): OwnerCommitment {
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

const BASE_POSITION = {
  positionId: 'p1',
  speculationId: 'spec-1',
  positionType: 0 as 0 | 1,
  team: 'NYM',
  opponent: 'LAD',
  market: 'moneyline' as const,
  oddsDecimal: 2.5,
  riskAmountUSDC: 0.1,
  profitAmountUSDC: 0.15,
  contestId: '1',
  sport: 'baseball_mlb',
  awayTeam: 'NYM',
  homeTeam: 'LAD',
  riskAmountWei6: '100000',
  counterpartyRiskWei6: '150000',
  updatedAtUnixSec: 1735689600,
};

const ACTIVE_POSITION: OwnerPosition = { ...BASE_POSITION, status: 'active' };
const PENDING_POSITION: OwnerPosition = {
  ...BASE_POSITION,
  status: 'pendingSettle',
  result: 'won',
  predictedWinSide: 'home',
  estimatedPayoutUSDC: 0.25,
  estimatedPayoutWei6: '250000',
};
const CLAIMABLE_POSITION: OwnerPosition = {
  ...BASE_POSITION,
  status: 'claimable',
  result: 'push',
  estimatedPayoutUSDC: 0.1,
  estimatedPayoutWei6: '100000',
};
const CLAIMED_POSITION: OwnerPosition = {
  ...BASE_POSITION,
  status: 'claimed',
  claimedAt: '2025-01-02T00:00:00.000Z',
};
// The shape the SDK ACTUALLY emits for claimed rows: terminal + recovery-only,
// so contestId/sport/awayTeam/homeTeam are empty strings by contract (see
// OwnerPositionBase in @ospex/sdk ownState.d.ts). speculationId stays populated.
const CLAIMED_POSITION_EMPTY_IDENTITY: OwnerPosition = {
  ...BASE_POSITION,
  contestId: '',
  sport: '',
  awayTeam: '',
  homeTeam: '',
  team: '',
  opponent: '',
  status: 'claimed',
  claimedAt: '2025-01-02T00:00:00.000Z',
};

function positionStatusEvent(overrides: Partial<PositionStatusEvent> = {}): PositionStatusEvent {
  return {
    address: OUR_ADDR,
    speculationId: 'spec-1',
    positionType: 0,
    status: 'pendingSettle',
    sourceUpdatedAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makerPosition(overrides: Partial<MakerPositionRecord> = {}): MakerPositionRecord {
  return {
    speculationId: 'spec-1',
    contestId: '1',
    sport: 'baseball_mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    marketType: 'moneyline',
    lineTicks: 0,
    side: 'away',
    riskAmountWei6: '100000',
    counterpartyRiskWei6: '150000',
    status: 'active',
    updatedAtUnixSec: 1735689600,
    ...overrides,
  };
}

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

// ── deriveCommitmentLifecycle ─────────────────────────────────────────────────

describe('deriveCommitmentLifecycle', () => {
  it('full fill (filled >= risk) → filled (takes precedence over everything)', () => {
    expect(deriveCommitmentLifecycle(commitment({ filledRiskAmount: '250000', riskAmount: '250000', status: 'cancelled' })))
      .toBe('filled');
  });

  it('storedStatus cancelled → authoritativelyInvalidated', () => {
    expect(deriveCommitmentLifecycle(commitment({ storedStatus: 'cancelled' }))).toBe('authoritativelyInvalidated');
  });

  it('nonceInvalidated → authoritativelyInvalidated', () => {
    expect(deriveCommitmentLifecycle(commitment({ nonceInvalidated: true, status: 'open' }))).toBe('authoritativelyInvalidated');
  });

  it('status expired → expired', () => {
    expect(deriveCommitmentLifecycle(commitment({ status: 'expired' }))).toBe('expired');
  });

  it('status cancelled (not AUTH) → softCancelled', () => {
    expect(deriveCommitmentLifecycle(commitment({ status: 'cancelled' }))).toBe('softCancelled');
  });

  it('AUTH (nonceInvalidated) wins over effective-expired (precedence)', () => {
    expect(deriveCommitmentLifecycle(commitment({ nonceInvalidated: true, status: 'expired' }))).toBe('authoritativelyInvalidated');
  });

  it('partial fill → partiallyFilled', () => {
    expect(deriveCommitmentLifecycle(commitment({ status: 'open', filledRiskAmount: '100000' }))).toBe('partiallyFilled');
  });

  it('open, no fill → visibleOpen', () => {
    expect(deriveCommitmentLifecycle(commitment({ status: 'open', filledRiskAmount: '0' }))).toBe('visibleOpen');
  });
});

// ── mapPositionLifecycleToMaker ───────────────────────────────────────────────

describe('mapPositionLifecycleToMaker', () => {
  it('maps the four non-terminal-lost states 1:1', () => {
    expect(mapPositionLifecycleToMaker('active')).toBe('active');
    expect(mapPositionLifecycleToMaker('pendingSettle')).toBe('pendingSettle');
    expect(mapPositionLifecycleToMaker('claimable')).toBe('claimable');
    expect(mapPositionLifecycleToMaker('claimed')).toBe('claimed');
  });

  it('PRESERVES settledLost / void as distinct terminals — does NOT collapse to claimed (A7)', () => {
    expect(mapPositionLifecycleToMaker('settledLost')).toBe('settledLost');
    expect(mapPositionLifecycleToMaker('void')).toBe('void');
    // the terminal triple is three distinct values
    expect(new Set(['claimed', 'settledLost', 'void']).size).toBe(3);
  });
});

// ── mapOwnerCommitmentToMaker ─────────────────────────────────────────────────

describe('mapOwnerCommitmentToMaker', () => {
  it('maps a fully-populated commitment to the canonical record (wei6, side, timestamps, empty fills)', () => {
    const r = mapOwnerCommitmentToMaker(commitment());
    expect(r).toEqual({
      hash: '0xabc',
      speculationId: 'spec-1',
      contestId: '1',
      sport: 'baseball_mlb',
      awayTeam: 'NYM',
      homeTeam: 'LAD',
      scorer: '0xscorer',
      marketType: 'moneyline',
      lineTicks: 0,
      makerSide: 'away', // positionType 0
      oddsTick: 250,
      riskAmountWei6: '250000',
      filledRiskWei6: '0',
      lifecycle: 'visibleOpen',
      expiryUnixSec: Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000),
      postedAtUnixSec: Math.floor(Date.parse('2025-01-01T00:00:00.000Z') / 1000),
      updatedAtUnixSec: 1735689600,
      signedPayloadStatus: 'missing-legacy',
      fills: [],
    });
  });

  it('positionType 1 → makerSide home', () => {
    expect(mapOwnerCommitmentToMaker(commitment({ positionType: 1 })).makerSide).toBe('home');
  });

  it('carries marketType / lineTicks through, defaulting a null body value to moneyline / 0', () => {
    expect(mapOwnerCommitmentToMaker(commitment({ marketType: 'spread', lineTicks: -15 }))).toMatchObject({ marketType: 'spread', lineTicks: -15 });
    // A null marketType / lineTicks (legacy or not-yet-populated body) collapses to the moneyline default.
    expect(mapOwnerCommitmentToMaker(commitment({ marketType: null, lineTicks: null }))).toMatchObject({ marketType: 'moneyline', lineTicks: 0 });
  });

  it('wires the lifecycle through deriveCommitmentLifecycle', () => {
    expect(mapOwnerCommitmentToMaker(commitment({ filledRiskAmount: '250000' })).lifecycle).toBe('filled');
  });

  it('signedPayload present → status present + round-tripped envelope (decimal strings)', () => {
    const r = mapOwnerCommitmentToMaker(commitment({ signedPayload: SIGNED_PAYLOAD }));
    expect(r.signedPayloadStatus).toBe('present');
    expect(r.signedPayload).toEqual({
      commitmentHash: '0xabc',
      commitment: {
        maker: OUR_ADDR,
        contestId: '1',
        scorer: '0xscorer',
        lineTicks: 0,
        positionType: 0,
        oddsTick: 250,
        riskAmount: '250000',
        nonce: '1',
        expiry: '4070908800',
      },
      signature: '0xsig',
    });
  });

  it('signedPayload null → status missing-legacy + no signedPayload key', () => {
    const r = mapOwnerCommitmentToMaker(commitment({ signedPayload: null }));
    expect(r.signedPayloadStatus).toBe('missing-legacy');
    expect('signedPayload' in r).toBe(false);
  });

  it('null expiry → expiryUnixSec 0 (no on-chain deadline), no throw', () => {
    expect(mapOwnerCommitmentToMaker(commitment({ expiry: null })).expiryUnixSec).toBe(0);
  });

  describe('fail-closed on missing required metadata', () => {
    const cases: ReadonlyArray<[string, Partial<OwnerCommitment>, string]> = [
      ['null speculationId', { speculationId: null }, 'speculationId'],
      ['null contestId', { contestId: null }, 'contestId'],
      ['null scorer', { scorer: null }, 'scorer'],
      ['null positionType', { positionType: null }, 'positionType'],
      ['null oddsTick', { oddsTick: null }, 'oddsTick'],
      ['empty sport', { sport: '' }, 'sport'],
      ['empty awayTeam', { awayTeam: '' }, 'awayTeam'],
      ['empty homeTeam', { homeTeam: '' }, 'homeTeam'],
      ['unparseable createdAt', { createdAt: 'not-a-date' }, 'createdAt'],
      ['unparseable expiry', { expiry: 'not-a-date' }, 'expiry'],
    ];
    for (const [name, override, field] of cases) {
      it(`${name} → OwnerMappingError{field:'${field}', commitmentHash}`, () => {
        let thrown: unknown;
        try {
          mapOwnerCommitmentToMaker(commitment(override));
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(OwnerMappingError);
        const err = thrown as OwnerMappingError;
        expect(err.field).toBe(field);
        expect(err.commitmentHash).toBe('0xabc');
        expect(err.speculationId).toBeUndefined();
      });
    }
  });
});

// ── mapOwnerPositionToMaker ───────────────────────────────────────────────────

describe('mapOwnerPositionToMaker', () => {
  it('active → canonical record, wei6 sourcing, side, no result', () => {
    const r = mapOwnerPositionToMaker(ACTIVE_POSITION);
    expect(r).toEqual({
      speculationId: 'spec-1',
      contestId: '1',
      sport: 'baseball_mlb',
      awayTeam: 'NYM',
      homeTeam: 'LAD',
      marketType: 'moneyline', // from the position body's `market`
      lineTicks: 0, // the position body carries no line — 0 (correct for moneyline)
      side: 'away', // positionType 0
      riskAmountWei6: '100000',
      counterpartyRiskWei6: '150000',
      status: 'active',
      updatedAtUnixSec: 1735689600,
    });
    expect('result' in r).toBe(false);
  });

  it('position marketType comes from the body `market`; lineTicks is 0 (the body carries no line)', () => {
    // A spread position body: marketType flows through, lineTicks stays 0 (the own-state position
    // body has no line — the per-market risk re-key sources spread/total lines from the commitment).
    const r = mapOwnerPositionToMaker({ ...ACTIVE_POSITION, market: 'spread' } as OwnerPosition);
    expect(r).toMatchObject({ marketType: 'spread', lineTicks: 0 });
  });

  it('positionType 1 → side home', () => {
    expect(mapOwnerPositionToMaker({ ...ACTIVE_POSITION, positionType: 1 } as OwnerPosition).side).toBe('home');
  });

  it('pendingSettle → result captured', () => {
    expect(mapOwnerPositionToMaker(PENDING_POSITION).result).toBe('won');
  });

  it('claimable → result captured', () => {
    expect(mapOwnerPositionToMaker(CLAIMABLE_POSITION).result).toBe('push');
  });

  it('claimed → no result (the claimed variant carries none)', () => {
    expect('result' in mapOwnerPositionToMaker(CLAIMED_POSITION)).toBe(false);
  });

  it('claimed row with SDK-real empty identity maps cleanly (empty identity is the documented norm, NOT corruption)', () => {
    const r = mapOwnerPositionToMaker(CLAIMED_POSITION_EMPTY_IDENTITY);
    expect(r.status).toBe('claimed');
    // empty identity preserved (the canonical record + validator accept it); the
    // mapper must NOT fail-close on a claimed row's documented-empty identity
    expect(r.contestId).toBe('');
    expect(r.sport).toBe('');
    expect(r.awayTeam).toBe('');
    expect(r.homeTeam).toBe('');
    expect(r.speculationId).toBe('spec-1');
    expect(r.side).toBe('away'); // still derived from positionType
    expect('result' in r).toBe(false);
  });

  it('a NON-claimed row with empty identity still fail-closes (claimed exemption does not leak)', () => {
    expect(() => mapOwnerPositionToMaker({ ...ACTIVE_POSITION, contestId: '' } as OwnerPosition)).toThrow(OwnerMappingError);
  });

  it('wei6 only — uses riskAmountWei6, ignores the float riskAmountUSDC', () => {
    // float would round to 999999; wei6 is the authoritative 1000000
    const r = mapOwnerPositionToMaker({ ...ACTIVE_POSITION, riskAmountUSDC: 0.999999, riskAmountWei6: '1000000' } as OwnerPosition);
    expect(r.riskAmountWei6).toBe('1000000');
  });

  describe('fail-closed on empty identity', () => {
    const cases: ReadonlyArray<[string, Partial<OwnerPosition>, string]> = [
      ['empty speculationId', { speculationId: '' }, 'speculationId'],
      ['empty contestId', { contestId: '' }, 'contestId'],
      ['empty sport', { sport: '' }, 'sport'],
      ['empty awayTeam', { awayTeam: '' }, 'awayTeam'],
      ['empty homeTeam', { homeTeam: '' }, 'homeTeam'],
    ];
    for (const [name, override, field] of cases) {
      it(`${name} → OwnerMappingError{field:'${field}', speculationId}`, () => {
        let thrown: unknown;
        try {
          mapOwnerPositionToMaker({ ...ACTIVE_POSITION, ...override } as OwnerPosition);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(OwnerMappingError);
        const err = thrown as OwnerMappingError;
        expect(err.field).toBe(field);
        expect(err.commitmentHash).toBeUndefined();
        // the envelope must carry the correlating speculationId (it's the only
        // identifier the PR3b emit site has for a skipped position row)
        expect(err.speculationId).toBe(field === 'speculationId' ? '' : 'spec-1');
      });
    }
  });
});

// ── mapPositionStatusEventToMaker ─────────────────────────────────────────────

describe('mapPositionStatusEventToMaker', () => {
  const EV_UNIX = Math.floor(Date.parse('2025-06-01T00:00:00.000Z') / 1000);

  it('advances status + updatedAtUnixSec; preserves identity and risk from prev', () => {
    const prev = makerPosition({ status: 'active', updatedAtUnixSec: 1735689600 });
    const r = mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'pendingSettle' }));
    expect(r.status).toBe('pendingSettle');
    expect(r.updatedAtUnixSec).toBe(EV_UNIX);
    // identity + risk untouched
    expect(r.speculationId).toBe('spec-1');
    expect(r.contestId).toBe('1');
    expect(r.awayTeam).toBe('NYM');
    expect(r.homeTeam).toBe('LAD');
    expect(r.side).toBe('away');
    expect(r.riskAmountWei6).toBe('100000');
    expect(r.counterpartyRiskWei6).toBe('150000');
  });

  it('terminal triple → three DISTINCT statuses (settledLost / void / claimed not collapsed)', () => {
    const prev = makerPosition({ status: 'pendingSettle' });
    expect(mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'settledLost', result: 'lost' })).status).toBe('settledLost');
    expect(mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'void', result: 'void' })).status).toBe('void');
    expect(mapPositionStatusEventToMaker(makerPosition({ status: 'claimable' }), positionStatusEvent({ status: 'claimed' })).status).toBe('claimed');
  });

  it('result won/push/void map through', () => {
    const prev = makerPosition({ status: 'pendingSettle' });
    expect(mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'claimable', result: 'won' })).result).toBe('won');
    expect(mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'claimable', result: 'push' })).result).toBe('push');
    expect(mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'void', result: 'void' })).result).toBe('void');
  });

  it("result 'lost' is dropped (settledLost status conveys the loss); prev.result left intact", () => {
    const prev = makerPosition({ status: 'pendingSettle' }); // no prior result
    const r = mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'settledLost', result: 'lost' }));
    expect('result' in r).toBe(false);
  });

  it('absent ev.result preserves a previously-settled result (no erase)', () => {
    const prev = makerPosition({ status: 'claimable', result: 'won' });
    const r = mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'claimed' })); // claimed event carries no result
    expect(r.result).toBe('won');
  });

  it('unparseable sourceUpdatedAt → OwnerMappingError{field:sourceUpdatedAt, speculationId}', () => {
    let thrown: unknown;
    try {
      mapPositionStatusEventToMaker(makerPosition(), positionStatusEvent({ sourceUpdatedAt: 'not-a-date' }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OwnerMappingError);
    const err = thrown as OwnerMappingError;
    expect(err.field).toBe('sourceUpdatedAt');
    expect(err.speculationId).toBe('spec-1');
    expect(err.commitmentHash).toBeUndefined();
  });

  it('does NOT mutate the prev record (returns a fresh object)', () => {
    const prev = makerPosition({ status: 'active' });
    const r = mapPositionStatusEventToMaker(prev, positionStatusEvent({ status: 'pendingSettle' }));
    expect(prev.status).toBe('active'); // prev untouched
    expect(r).not.toBe(prev);
  });
});

// ── OwnerMappingError ─────────────────────────────────────────────────────────

describe('OwnerMappingError', () => {
  it('is an Error subclass carrying field + the success-path identifier', () => {
    const err = new OwnerMappingError('boom', { field: 'speculationId', commitmentHash: '0xdead' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OwnerMappingError');
    expect(err.message).toBe('boom');
    expect(err.field).toBe('speculationId');
    expect(err.commitmentHash).toBe('0xdead');
    expect(err.speculationId).toBeUndefined();
  });
});
