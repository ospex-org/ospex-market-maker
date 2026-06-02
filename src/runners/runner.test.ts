import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type Config } from '../config/index.js';
import { inverseOddsTick } from '../pricing/index.js';
import {
  createLiveOspexAdapter,
  createOspexAdapter,
  OspexStreamError,
  type Commitment,
  type PublicVisibleCommitment,
  type ContestOddsSnapshot,
  type ContestView,
  type Hex,
  type MoneylineOdds,
  type ApprovalsSnapshot,
  type ApproveResult,
  type ApproveUSDCAmount,
  type CancelOnchainResult,
  type ClaimPositionResult,
  type EnsurePositionClaimedResult,
  type EnsureSpeculationSettledResult,
  type OddsSubscribeHandlers,
  type OspexAdapter,
  type PositionStatus,
  type Signer,
  type SpeculationView,
  type SubmitCommitmentArgs,
  type SubmitCommitmentResult,
  type Subscription,
} from '../ospex/index.js';
import { StateStore, emptyMakerState, type MakerCommitmentRecord, type MakerSide, type MakerState } from '../state/index.js';
import { Runner, interruptibleSleep, type RunnerDeps, type RunnerOptions } from './index.js';

// ── harness ──────────────────────────────────────────────────────────────────

const RUN_ID = 'test-run-1';

let stateDir: string;
let logDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ospex-mm-runner-state-'));
  logDir = mkdtempSync(join(tmpdir(), 'ospex-mm-runner-log-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

function cfg(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    rpcUrl: 'http://localhost:8545',
    telemetry: { logDir },
    state: { dir: stateDir },
    killSwitchFile: join(stateDir, 'KILL'),
    orders: { expirySeconds: 120 },
    ...overrides,
  });
}

function eventLogPath(id = RUN_ID): string {
  return join(logDir, `run-${id}.ndjson`);
}
function readEvents(id = RUN_ID): Array<Record<string, unknown>> {
  if (!existsSync(eventLogPath(id))) return [];
  return readFileSync(eventLogPath(id), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Quiet, deterministic deps: an immediate sleep, a fixed clock, no kill file, no signal wiring, a swallowed log, no discovery jitter (random → 0.5 ⇒ jitter factor 1).
const T0 = 1_900_000_000;
const noopDeps: Partial<RunnerDeps> = {
  now: () => T0,
  sleep: () => Promise.resolve(),
  killFileExists: () => false,
  registerShutdownSignals: () => () => {},
  log: () => {},
  random: () => 0.5,
};

function makeRunner(opts: { config?: Config; adapter?: OspexAdapter; runId?: string; ignoreMissingState?: boolean; maxTicks?: number; deps?: Partial<RunnerDeps>; makerAddress?: Hex } = {}): Runner {
  const config = opts.config ?? cfg();
  let adapter = opts.adapter;
  if (adapter === undefined) {
    // Tests that don't exercise discovery: stub the API so the discovery cycle finds nothing (no real HTTP).
    // The reference-odds steps are then no-ops (no tracked markets), but stub them too so an accidental track surfaces rather than hitting the network.
    adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'getContest').mockRejectedValue(new Error('makeRunner: getContest not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises discovery'));
    vi.spyOn(adapter, 'getOddsSnapshot').mockRejectedValue(new Error('makeRunner: getOddsSnapshot not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises odds'));
    vi.spyOn(adapter, 'subscribeOdds').mockRejectedValue(new Error('makeRunner: subscribeOdds not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises odds'));
    vi.spyOn(adapter, 'getSpeculation').mockRejectedValue(new Error('makeRunner: getSpeculation not stubbed — pass an `adapter` (see `spiedAdapter`) if your test exercises the reconcile'));
  }
  // Default the maker address to the fake signer's address for any live-mode test that
  // doesn't override it — keeps the live-execution tests (which all use the same fake
  // signer via `liveSpiedAdapter`) from each having to plumb the same constant.
  const makerAddress = opts.makerAddress ?? (adapter.isLive() ? (DEFAULT_FAKE_MAKER_ADDRESS as Hex) : undefined);
  const full: RunnerOptions = {
    config,
    adapter,
    stateStore: StateStore.at(config.state.dir),
    runId: opts.runId ?? RUN_ID,
    deps: { ...noopDeps, ...opts.deps },
  };
  if (opts.ignoreMissingState !== undefined) full.ignoreMissingState = opts.ignoreMissingState;
  if (opts.maxTicks !== undefined) full.maxTicks = opts.maxTicks;
  if (makerAddress !== undefined) full.makerAddress = makerAddress;
  return new Runner(full);
}

/** The fake signer's address used across the live-mode tests (`liveSpiedAdapter` → `fakeSigner` → this). Re-exported as `SIGNER_ADDRESS` inside the `live execution` describe for symmetry with earlier test additions. */
const DEFAULT_FAKE_MAKER_ADDRESS = '0x9999999999999999999999999999999999999999';

// ── async loop test harness (used by PR3 wakeable-loop + PR4a SSE wiring tests) ─

/** A controllable sleep harness: each call pushes the requested ms to
 * `sleepCalls` and returns a pending Promise that resolves on either signal
 * abort OR a manual `resolvers[i]()`. Tests advance the loop by either
 * triggering a wake (aborts the composed signal → resolves the pending
 * sleep) or calling `resolvers[i]()`. */
function controllableSleep() {
  const sleepCalls: number[] = [];
  const resolvers: Array<() => void> = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      sleepCalls.push(ms);
      if (signal.aborted) {
        resolve();
        return;
      }
      resolvers.push(resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return { sleep, sleepCalls, resolvers };
}

/** Wait until `predicate()` is true. Yields setImmediate between checks so
 * the runner's loop advances through its tick() awaits and into the next
 * `deps.sleep` call. Times out after ~1s to keep tests deterministic. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('waitFor: predicate did not become true within ~1s');
}

// ── discovery fixtures ───────────────────────────────────────────────────────

const FUTURE_ISO = '2099-01-01T00:00:00Z'; // far after the test clock (T0 ≈ 2030-03)
const PAST_ISO = '2020-01-01T00:00:00Z';

function contestView(overrides: Partial<ContestView> & { contestId: string }): ContestView {
  return {
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    sport: 'mlb',
    sportId: 0,
    matchTime: FUTURE_ISO,
    status: 'verified',
    referenceGameId: null, // list-endpoint default; `getContest` fills it
    speculations: [{ speculationId: `spec-${overrides.contestId}`, contestId: overrides.contestId, marketType: 'moneyline', lineTicks: null, line: null, open: true }],
    ...overrides, // (carries `contestId`; may override the speculations / referenceGameId / matchTime / sport above)
  };
}

// ── odds fixtures ────────────────────────────────────────────────────────────

function moneylineOdds(awayOddsAmerican: number | null, homeOddsAmerican: number | null): MoneylineOdds {
  return { market: 'moneyline', awayOddsAmerican, homeOddsAmerican, upstreamLastUpdated: '2026-01-01T00:00:00Z', pollCapturedAt: '2026-01-01T00:00:00Z', changedAt: '2026-01-01T00:00:00Z' };
}
/** A one-shot odds snapshot for a contest — the moneyline defaults to `-110 / -110`; pass `null` for "no moneyline row yet". Provider-neutral (0.3.0): no referenceGameId on the odds surface. The live `onChange` / `onRefresh` payloads use `moneylineOdds(...)` directly (the per-market shape). */
function oddsSnapshotView(contestId: string, moneyline: MoneylineOdds | null = moneylineOdds(-110, -110)): ContestOddsSnapshot {
  return { contestId, odds: { moneyline, spread: null, total: null } };
}
/** A `getSpeculation` view for a moneyline speculation — `open` defaults to true (the realistic case the per-market reconcile expects); `orderbook` defaults to `[]` (the detail endpoint always populates it — pass entries to exercise the competitiveness check, or `{ ...speculationView(id) }` without an `orderbook` override for the degraded case). */
function speculationView(speculationId: string, open = true, orderbook: Commitment[] = []): SpeculationView {
  return { speculationId, contestId: 'contest', marketType: 'moneyline', lineTicks: null, line: null, open, orderbook };
}
/** An orderbook entry (the SDK `Commitment` shape — every maker's, not just ours) — only `positionType` (0 = away/Upper, 1 = home/Lower) and `oddsTick` matter for the competitiveness check; everything else is filler. */
function orderbookEntry(
  overrides: Partial<PublicVisibleCommitment> = {},
): PublicVisibleCommitment {
  // SDK v0.5.0 (M5/PR1) made `Commitment` a discriminated union over
  // `visibility: 'visible' | 'hidden'` / `redacted: false | true`. The
  // matchable-payload fields (`scorer`, `oddsTick`, etc.) only exist on
  // the `PublicVisibleCommitment` branch; without the discriminators
  // the object literal can't narrow to that branch and TS rejects them
  // as unknown properties.
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: '0xob',
    maker: '0xothermaker',
    contestId: 'A',
    scorer: '0xscorer',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '100000',
    filledRiskAmount: '0',
    remainingRiskAmount: '100000',
    nonce: '1',
    expiry: '2099-01-01T00:00:00Z',
    speculationKey: 'sk-A',
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
function noopSubscription(): Subscription {
  return { unsubscribe: () => Promise.resolve() };
}

/**
 * A `subscribeOdds` stub that records each call (the handlers + a per-call
 * `unsubscribe` spy), keyed by `contestId` (0.3.0 odds streams are contest-id
 * native). By default every call succeeds; `rejectWhen(matcher)` makes matching
 * calls reject (e.g. the first attempt for a given contest).
 */
function makeSubscribeRecorder() {
  const handlers = new Map<string, OddsSubscribeHandlers<MoneylineOdds>>();
  const unsubs = new Map<string, ReturnType<typeof vi.fn>>();
  const calls: string[] = []; // contestId per successful subscribe, in order
  const attempts = new Map<string, number>();
  let rejectMatcher: ((contestId: string, attempt: number) => boolean) | null = null;
  // Typed as the adapter's generic method so it slots straight into mockImplementation.
  const subscribe: OspexAdapter['subscribeOdds'] = (args, h) => {
    const contestId = String(args.contestId);
    const attempt = (attempts.get(contestId) ?? 0) + 1;
    attempts.set(contestId, attempt);
    if (rejectMatcher !== null && rejectMatcher(contestId, attempt)) {
      return Promise.reject(new Error('subscribe failed (test)'));
    }
    const unsubscribe = vi.fn(); // a no-impl spy: `await unsubscribe()` resolves to undefined, which is fine
    // The harness is moneyline-only — the runner always subscribes with market: 'moneyline'.
    handlers.set(contestId, h as unknown as OddsSubscribeHandlers<MoneylineOdds>);
    unsubs.set(contestId, unsubscribe);
    calls.push(contestId);
    return Promise.resolve({ unsubscribe });
  };
  return {
    subscribe,
    rejectWhen(matcher: (contestId: string, attempt: number) => boolean): void { rejectMatcher = matcher; },
    handlersFor(contestId: string): OddsSubscribeHandlers<MoneylineOdds> | undefined { return handlers.get(contestId); },
    unsubscribeFor(contestId: string): ReturnType<typeof vi.fn> | undefined { return unsubs.get(contestId); },
    successfulCalls(): string[] { return [...calls]; },
    attemptsFor(contestId: string): number { return attempts.get(contestId) ?? 0; },
  };
}

/**
 * An `OspexAdapter` with `listContests` / `getContest` / `getOddsSnapshot` /
 * `subscribeOdds` / `getSpeculation` spied: `listContests` calls `listContests()`
 * each time; `getContest(id)` defaults to echoing a fresh `contestView` with
 * `referenceGameId` filled in; `getOddsSnapshot(id)` / `subscribeOdds` /
 * `getSpeculation(id)` default to a `-110 / -110` snapshot, a no-op channel, and an
 * open speculation (override via `odds`).
 */
function spiedAdapter(
  config: Config,
  listContests: () => Promise<ContestView[]>,
  getContest?: (id: string) => Promise<ContestView>,
  odds?: {
    snapshot?: (contestId: string) => Promise<ContestOddsSnapshot>;
    subscribe?: OspexAdapter['subscribeOdds'];
    getSpeculation?: (speculationId: string) => Promise<SpeculationView>;
  },
): OspexAdapter {
  const adapter = createOspexAdapter(config);
  vi.spyOn(adapter, 'listContests').mockImplementation(listContests);
  vi.spyOn(adapter, 'getContest').mockImplementation(getContest ?? ((id) => Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` }))));
  vi.spyOn(adapter, 'getOddsSnapshot').mockImplementation(odds?.snapshot ?? ((contestId) => Promise.resolve(oddsSnapshotView(contestId))));
  vi.spyOn(adapter, 'subscribeOdds').mockImplementation(odds?.subscribe ?? (() => Promise.resolve(noopSubscription())));
  vi.spyOn(adapter, 'getSpeculation').mockImplementation(odds?.getSpeculation ?? ((speculationId) => Promise.resolve(speculationView(speculationId))));
  return adapter;
}

/** A minimal `Signer` — deterministic address, dummy signatures (the live adapter never inspects them in these tests; the write methods are spied). */
function fakeSigner(): Signer {
  return {
    getAddress: () => Promise.resolve('0x9999999999999999999999999999999999999999' as Hex),
    signTypedData: () => Promise.resolve('0xsig' as Hex),
    signTransaction: () => Promise.resolve('0xtx' as Hex),
  };
}

/** A successful `submitCommitment` stub that hands back `0xlive<n>` hashes in call order. */
function submitRecorder(): { fn: (args: SubmitCommitmentArgs) => Promise<SubmitCommitmentResult>; calls: SubmitCommitmentArgs[] } {
  const calls: SubmitCommitmentArgs[] = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args);
      const hash = `0xlive${calls.length}` as Hex;
      // `SubmitCommitmentResult.commitment` is `PublicVisibleCommitment` after
      // the SDK v0.5.0 defensive narrow (M5/PR1) — `submitRaw` inserts
      // `book_visible=true` by construction. Derive the cast from the result
      // type so future SDK signature changes surface as a compile error
      // here. `signedPayload` (SDK v0.5.1) must be STRUCTURALLY VALID — the
      // runner pipes it through `toMakerSignedPayload` (`.toString()` on the
      // four bigint fields) on every successful submit (M6/A persistence
      // path), so an empty cast would crash with TypeError.
      return Promise.resolve({
        hash,
        commitment: {} as unknown as SubmitCommitmentResult['commitment'],
        signedPayload: {
          commitmentHash: hash,
          commitment: {
            maker: '0x'.padEnd(42, 'a') as Hex,
            contestId: BigInt(args.contestId),
            scorer: args.scorer,
            lineTicks: args.lineTicks,
            positionType: args.positionType,
            oddsTick: args.oddsTick,
            riskAmount: BigInt(args.riskAmount),
            nonce: 1n,
            expiry: args.expiry ?? 2_000_000_000n,
          },
          signature: ('0x' + 'cc'.repeat(65)) as Hex,
        },
      });
    },
  };
}

/**
 * A *signed* adapter (`createLiveOspexAdapter`, so `isLive()` is true) with the same
 * reads spied as {@link spiedAdapter}, plus the live writes: `submitCommitment`
 * defaults to rejecting (a test that triggers a submit must stub it via `writes`),
 * `cancelCommitmentOffchain` defaults to a no-op success, `listOpenCommitments`
 * defaults to `[]` and `getCommitment` defaults to rejecting (a test that exercises
 * fill detection overrides both via `reads`) — every adapter method is spied so a
 * live-mode test never makes a real network call.
 */
function liveSpiedAdapter(
  config: Config,
  listContests: () => Promise<ContestView[]>,
  writes?: {
    submitCommitment?: (args: SubmitCommitmentArgs) => Promise<SubmitCommitmentResult>;
    cancelCommitmentOffchain?: (hash: Hex) => Promise<void>;
    approveUSDC?: (amount: ApproveUSDCAmount) => Promise<ApproveResult>;
    settleSpeculation?: OspexAdapter['settleSpeculation'];
    ensureSpeculationSettled?: OspexAdapter['ensureSpeculationSettled'];
    claimPosition?: OspexAdapter['claimPosition'];
    ensurePositionClaimed?: OspexAdapter['ensurePositionClaimed'];
    cancelCommitmentOnchain?: OspexAdapter['cancelCommitmentOnchain'];
  },
  getContest?: (id: string) => Promise<ContestView>,
  odds?: {
    snapshot?: (contestId: string) => Promise<ContestOddsSnapshot>;
    subscribe?: OspexAdapter['subscribeOdds'];
    getSpeculation?: (speculationId: string) => Promise<SpeculationView>;
  },
  reads?: {
    listOpenCommitments?: (maker: string, limit: number) => Promise<Commitment[]>;
    getCommitment?: (hash: Hex) => Promise<Commitment>;
    getPositionStatus?: (owner: string) => Promise<PositionStatus>;
    readApprovals?: (owner: Hex) => Promise<ApprovalsSnapshot>;
    readBalances?: (owner: Hex) => Promise<{ owner: Hex; chainId: number; native: bigint; usdc: bigint; link: bigint; usdcAddress: Hex; linkAddress: Hex }>;
  },
): OspexAdapter {
  const adapter = createLiveOspexAdapter(config, fakeSigner());
  vi.spyOn(adapter, 'listContests').mockImplementation(listContests);
  vi.spyOn(adapter, 'getContest').mockImplementation(getContest ?? ((id) => Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` }))));
  vi.spyOn(adapter, 'getOddsSnapshot').mockImplementation(odds?.snapshot ?? ((contestId) => Promise.resolve(oddsSnapshotView(contestId))));
  vi.spyOn(adapter, 'subscribeOdds').mockImplementation(odds?.subscribe ?? (() => Promise.resolve(noopSubscription())));
  vi.spyOn(adapter, 'getSpeculation').mockImplementation(odds?.getSpeculation ?? ((speculationId) => Promise.resolve(speculationView(speculationId))));
  vi.spyOn(adapter, 'submitCommitment').mockImplementation(writes?.submitCommitment ?? (() => Promise.reject(new Error('liveSpiedAdapter: submitCommitment not stubbed — pass `writes.submitCommitment`'))));
  vi.spyOn(adapter, 'cancelCommitmentOffchain').mockImplementation(writes?.cancelCommitmentOffchain ?? (() => Promise.resolve()));
  vi.spyOn(adapter, 'approveUSDC').mockImplementation(writes?.approveUSDC ?? (() => Promise.reject(new Error('liveSpiedAdapter: approveUSDC not stubbed — pass `writes.approveUSDC`'))));
  vi.spyOn(adapter, 'settleSpeculation').mockImplementation(writes?.settleSpeculation ?? (() => Promise.reject(new Error('liveSpiedAdapter: settleSpeculation not stubbed — pass `writes.settleSpeculation`'))));
  vi.spyOn(adapter, 'ensureSpeculationSettled').mockImplementation(writes?.ensureSpeculationSettled ?? (() => Promise.reject(new Error('liveSpiedAdapter: ensureSpeculationSettled not stubbed — pass `writes.ensureSpeculationSettled`'))));
  vi.spyOn(adapter, 'claimPosition').mockImplementation(writes?.claimPosition ?? (() => Promise.reject(new Error('liveSpiedAdapter: claimPosition not stubbed — pass `writes.claimPosition`'))));
  vi.spyOn(adapter, 'ensurePositionClaimed').mockImplementation(writes?.ensurePositionClaimed ?? (() => Promise.reject(new Error('liveSpiedAdapter: ensurePositionClaimed not stubbed — pass `writes.ensurePositionClaimed`'))));
  vi.spyOn(adapter, 'cancelCommitmentOnchain').mockImplementation(writes?.cancelCommitmentOnchain ?? (() => Promise.reject(new Error('liveSpiedAdapter: cancelCommitmentOnchain not stubbed — pass `writes.cancelCommitmentOnchain`'))));
  vi.spyOn(adapter, 'listOpenCommitments').mockImplementation(reads?.listOpenCommitments ?? (() => Promise.resolve([])));
  vi.spyOn(adapter, 'getCommitment').mockImplementation(reads?.getCommitment ?? (() => Promise.reject(new Error('liveSpiedAdapter: getCommitment not stubbed — pass `reads.getCommitment`'))));
  vi.spyOn(adapter, 'getPositionStatus').mockImplementation(reads?.getPositionStatus ?? (() => Promise.resolve(EMPTY_POSITION_STATUS)));
  // Default `readApprovals` returns a saturated allowance — keeps existing tests (`autoApprove: false` by config default)
  // a no-op even if `applyAutoApprovals` is reached, and lets new auto-approve tests opt in by providing their own stub.
  vi.spyOn(adapter, 'readApprovals').mockImplementation(reads?.readApprovals ?? (() => Promise.resolve(approvalsSnapshotWith(2n ** 255n))));
  // Default `readBalances` returns saturated USDC so exact-mode auto-approve isn't wallet-bound below the cap ceiling
  // unless a test explicitly underfunds the wallet. Other balances are non-zero placeholders.
  vi.spyOn(adapter, 'readBalances').mockImplementation(reads?.readBalances ?? ((owner: Hex) => Promise.resolve({ owner, chainId: 137, native: 1_000_000_000_000_000_000n, usdc: 2n ** 255n, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex })));
  return adapter;
}

/** Build an `ApprovalsSnapshot` with the given `PositionModule` USDC raw allowance — every other field is filled with a safe non-zero placeholder. */
function approvalsSnapshotWith(positionModuleRaw: bigint): ApprovalsSnapshot {
  return {
    owner: '0xowner' as Hex,
    chainId: 137,
    usdc: {
      address: '0xusdc' as Hex,
      decimals: 6,
      allowances: {
        positionModule: { spender: '0xPositionModule' as Hex, spenderModule: 'positionModule', raw: positionModuleRaw },
        treasuryModule: { spender: '0xTreasuryModule' as Hex, spenderModule: 'treasuryModule', raw: 0n },
      },
    },
    link: {
      address: '0xlink' as Hex,
      decimals: 18,
      allowances: {
        oracleModule: { spender: '0xOracleModule' as Hex, spenderModule: 'oracleModule', raw: 0n },
      },
    },
  };
}

/** Empty `PositionStatus` — `liveSpiedAdapter`'s default `getPositionStatus` return so the position poll is a no-op unless a test overrides it. */
const EMPTY_POSITION_STATUS: PositionStatus = {
  active: [], pendingSettle: [], claimable: [],
  totals: { activeCount: 0, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
};

function commitmentRecord(overrides: Partial<MakerCommitmentRecord>): MakerCommitmentRecord {
  const NOW = 1_900_000_000;
  const hash = overrides.hash ?? '0xabc';
  return {
    hash,
    speculationId: 'spec-1',
    contestId: 'contest-1',
    sport: 'mlb',
    awayTeam: 'NYM',
    homeTeam: 'LAD',
    scorer: '0xscorer',
    makerSide: 'away',
    oddsTick: 250,
    riskAmountWei6: '250000',
    filledRiskWei6: '0',
    // M6/A — default fixture is `'present'` with a synthesized stub bundle
    // (most M6/A-era records carry the canonical payload from submitQuote).
    // Tests that exercise the migration / blocked-missing-payload path
    // override `signedPayloadStatus: 'missing-legacy'` AND drop `signedPayload`.
    signedPayloadStatus: 'present',
    signedPayload: {
      commitmentHash: hash,
      commitment: {
        maker: '0x'.padEnd(42, 'a'),
        contestId: '1',
        scorer: '0xscorer',
        lineTicks: 0,
        positionType: 0,
        oddsTick: 250,
        riskAmount: '250000',
        nonce: '1',
        expiry: String(NOW + 100),
      },
      signature: '0x' + 'cc'.repeat(65),
    },
    lifecycle: 'visibleOpen',
    expiryUnixSec: NOW + 100,
    postedAtUnixSec: NOW - 10,
    updatedAtUnixSec: NOW - 10,
    // Phase 2 PR1 — fills[] defaults empty (poll-path doesn't append; SSE
    // reducer in PR4 populates it).
    fills: [],
    ...overrides,
  };
}

// ── boot path — the state-loss fail-safe (DESIGN §12) ────────────────────────

describe('Runner — boot', () => {
  it('a cleanly-loaded state does not hold quoting', () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const runner = makeRunner();
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/loaded cleanly/);
    expect(runner.isHoldingQuoting()).toBe(false);
  });

  it('no state file + no prior telemetry = genuine first run — no hold', () => {
    const runner = makeRunner(); // stateDir + logDir both empty
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/genuine first run/);
  });

  it('no state file but prior telemetry = state loss — holds quoting until now + expirySeconds (fixed-seconds), and logs it', () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const now = 1_900_000_000;
    const lines: string[] = [];
    const runner = makeRunner({ config: cfg({ orders: { expirySeconds: 90 } }), deps: { now: () => now, log: (l) => lines.push(l) } });
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    expect(runner.bootAssessment.suggestedWaitSeconds).toBe(90);
    expect(runner.isHoldingQuoting()).toBe(true);
    expect(lines.some((l) => /holding quoting for 90s/.test(l))).toBe(true);
  });

  it('a corrupt state file holds quoting', () => {
    writeFileSync(join(stateDir, 'maker-state.json'), '{ this is not json', 'utf8');
    const runner = makeRunner();
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    expect(runner.bootAssessment.reason).toMatch(/blank slate/);
  });

  it('--ignore-missing-state lifts the hold on a corrupt state file', () => {
    writeFileSync(join(stateDir, 'maker-state.json'), '{ broken', 'utf8');
    const runner = makeRunner({ ignoreMissingState: true });
    expect(runner.bootAssessment.holdQuoting).toBe(false);
    expect(runner.bootAssessment.reason).toMatch(/ignore-missing-state/);
  });
});

// ── the state-loss hold is durable across restart (DESIGN §12) ───────────────

describe('Runner — state-loss hold durability', () => {
  it('a state-loss hold survives a restart before the deadline — the runner does not persist a clean state while held', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    // First boot: missing state + prior telemetry → hold (fixed-seconds, expirySeconds 120). Fixed clock at T0, so the deadline never elapses during the run.
    const runner1 = makeRunner({ runId: 'first', maxTicks: 3, deps: { now: () => T0 } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run();
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // never flushed — held the whole time

    // Restart before the deadline → state still missing → still detects the loss → still holds.
    const runner2 = makeRunner({ runId: 'second', deps: { now: () => T0 + 60 } });
    expect(runner2.bootAssessment.holdQuoting).toBe(true);
    expect(runner2.isHoldingQuoting()).toBe(true);
  });

  it('a state-loss hold releases once a continuous run survives past the deadline, so a later restart resumes', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    let t = T0;
    // expirySeconds 120; advance 90s per sleep → tick 3 runs at T0 + 180, past the T0 + 120 deadline → the hold has elapsed → flush.
    const runner1 = makeRunner({ runId: 'first', maxTicks: 3, deps: { now: () => t, sleep: () => { t += 90; return Promise.resolve(); } } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run();
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true); // flushed on tick 3, once the deadline had passed

    const runner2 = makeRunner({ runId: 'second', deps: { now: () => t + 10 } });
    expect(runner2.bootAssessment.holdQuoting).toBe(false); // clean (empty) state loaded → no hold
    expect(runner2.bootAssessment.reason).toMatch(/loaded cleanly/);
  });

  it('under match-time expiry, a state-loss hold is indefinite — it does not auto-release after expirySeconds; only --ignore-missing-state lifts it', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const T0 = 1_900_000_000;
    let t = T0;
    const runner1 = makeRunner({ runId: 'first', config: cfg({ orders: { expiryMode: 'match-time', expirySeconds: 120 } }), maxTicks: 3, deps: { now: () => t, sleep: () => { t += 500; return Promise.resolve(); } } });
    expect(runner1.bootAssessment.holdQuoting).toBe(true);
    await runner1.run(); // by tick 3 the clock is at T0 + 1000, way past expirySeconds — but the hold is indefinite
    expect(runner1.isHoldingQuoting()).toBe(true);
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // never flushed

    const runner2 = makeRunner({ runId: 'second', config: cfg({ orders: { expiryMode: 'match-time' } }), deps: { now: () => t } });
    expect(runner2.bootAssessment.holdQuoting).toBe(true); // a restart still detects the loss → still holds

    const runner3 = makeRunner({ runId: 'third', config: cfg({ orders: { expiryMode: 'match-time' } }), ignoreMissingState: true, deps: { now: () => t } });
    expect(runner3.bootAssessment.holdQuoting).toBe(false); // ...and --ignore-missing-state lifts it
    expect(runner3.isHoldingQuoting()).toBe(false);
  });
});

// ── the tick loop ────────────────────────────────────────────────────────────

describe('Runner — tick loop', () => {
  it('runs maxTicks ticks (emitting tick-start each), persists state, and does not emit kill on a normal exit', async () => {
    await makeRunner({ maxTicks: 3 }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start').map((e) => e.tick)).toEqual([1, 2, 3]);
    expect(events.some((e) => e.kind === 'kill')).toBe(false);
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(true);
  });

  it('clamps pollIntervalMs to the floor and logs the clamp once', async () => {
    const sleepMsCalls: number[] = [];
    const lines: string[] = [];
    await makeRunner({
      config: cfg({ pollIntervalMs: 5000 }),
      maxTicks: 3,
      deps: { sleep: (ms) => { sleepMsCalls.push(ms); return Promise.resolve(); }, log: (l) => lines.push(l) },
    }).run();
    expect(sleepMsCalls).toEqual([30000, 30000]); // 3 ticks → 2 sleeps (the loop exits after tick 3 before sleeping)
    expect(lines.filter((l) => /clamping to 30000ms/.test(l))).toHaveLength(1);
  });

  it('warns at boot when odds.maxRealtimeChannels + reserved own-state streams would exceed the core-api per-IP cap', () => {
    const lines: string[] = [];
    // 8 odds channels + 3 reserved own-state = 11 > the per-IP cap of 10.
    makeRunner({ config: cfg({ odds: { maxRealtimeChannels: 8 } }), deps: { log: (l) => lines.push(l) } });
    expect(lines.filter((l) => /per-IP cap/.test(l))).toHaveLength(1);
  });

  it('does not warn at the default stream caps (fits under the per-IP cap with own-state headroom)', () => {
    const lines: string[] = [];
    makeRunner({ config: cfg(), deps: { log: (l) => lines.push(l) } });
    expect(lines.filter((l) => /per-IP cap/.test(l))).toHaveLength(0);
  });

  it('a state-flush failure propagates (the runner must not keep ticking on an un-persistable state)', async () => {
    const stateStore = StateStore.at(stateDir);
    const flushSpy = vi.spyOn(stateStore, 'flush').mockImplementation(() => {
      throw new Error('disk full');
    });
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([])); // discovery finds nothing — no real HTTP
    const runner = new Runner({ config, adapter, stateStore, runId: RUN_ID, maxTicks: 5, deps: { ...noopDeps } });
    await expect(runner.run()).rejects.toThrow('disk full');
    flushSpy.mockRestore();
  });
});

// ── wakeable loop (Phase 2 PR3) ──────────────────────────────────────────────

describe('Runner — wakeable loop (Phase 2 PR3)', () => {
  // Hoisted to module scope below — used by PR3 and PR4a tests.

  it('a wake during the poll-deadline wait does NOT increment ticks (drain-only outcome)', async () => {
    const { sleep, sleepCalls, resolvers } = controllableSleep();
    let triggerKill!: () => void;
    const runner = makeRunner({
      maxTicks: 2,
      deps: {
        sleep,
        registerShutdownSignals: (onSignal) => { triggerKill = onSignal; return () => {}; },
      },
    });
    const runPromise = runner.run();

    // Wait for tick 1 to complete and the first main-wait sleep to be entered.
    await waitFor(() => sleepCalls.length >= 1);
    expect(sleepCalls[0]).toBe(30_000);

    runner.wake(); // aborts the composed signal → sleep 1 resolves via the abort listener
    await waitFor(() => sleepCalls.length >= 2);
    expect(sleepCalls[1]).toBe(500); // debounce sleep (the kill signal only — wake can't double-trigger here)

    // Manually resolve the debounce so the loop proceeds to drainShadow + next wait.
    const resolveDebounce = resolvers[1];
    if (resolveDebounce === undefined) throw new Error('expected debounce resolver');
    resolveDebounce();
    await waitFor(() => sleepCalls.length >= 3);
    expect(sleepCalls[2]).toBeLessThanOrEqual(30_000); // remaining wait of the original deadline

    // Kill the runner so the loop exits — verifies wake didn't promote to tick.
    triggerKill();
    await runPromise;

    const events = readEvents();
    const tickStarts = events.filter((e) => e.kind === 'tick-start');
    // Tick 1 fired; tick 2 didn't (the wake-outcome did NOT advance the tick counter).
    expect(tickStarts).toHaveLength(1);
    expect(tickStarts[0]?.tick).toBe(1);
  });

  it('multiple wakes between deadlines coalesce — one drain pass + one debounce per wake-outcome (not per wake call)', async () => {
    const { sleep, sleepCalls } = controllableSleep();
    let triggerKill!: () => void;
    const runner = makeRunner({
      maxTicks: 2,
      deps: {
        sleep,
        registerShutdownSignals: (onSignal) => { triggerKill = onSignal; return () => {}; },
      },
    });
    const runPromise = runner.run();

    await waitFor(() => sleepCalls.length >= 1);

    runner.wake();
    runner.wake();
    runner.wake();
    await waitFor(() => sleepCalls.filter((ms) => ms === 500).length >= 1);
    // Three wakes converged to ONE debounce.
    expect(sleepCalls.filter((ms) => ms === 500)).toHaveLength(1);

    triggerKill();
    await runPromise;
  });

  it('a wake during the debounce window is consumed by THAT drain — no redundant second debounce (Hermes PR #67 review)', async () => {
    // Without `clearPending` after drainShadow, a wake firing during the
    // debounce window would leave `pending: true` after the drain. The next
    // iteration's `beginWait` would return an already-aborted signal (Path B),
    // re-triggering the wake path with NO new events to drain — and under
    // sustained bursts this would loop forever, postponing the poll-deadline
    // tick indefinitely. This regression test asserts that wakes-during-debounce
    // are consumed by the same drain pass and the next iteration starts a
    // FRESH main-wait sleep (not another debounce).
    const { sleep, sleepCalls, resolvers } = controllableSleep();
    let triggerKill!: () => void;
    const runner = makeRunner({
      maxTicks: 2,
      deps: {
        sleep,
        registerShutdownSignals: (onSignal) => { triggerKill = onSignal; return () => {}; },
      },
    });
    const runPromise = runner.run();

    await waitFor(() => sleepCalls.length >= 1);
    expect(sleepCalls[0]).toBe(30_000); // main wait

    runner.wake(); // wake 1: aborts main wait → outcome wake
    await waitFor(() => sleepCalls.length >= 2);
    expect(sleepCalls[1]).toBe(500); // debounce 1

    // Fire wake 2 DURING the debounce window — its events would be covered by
    // the debounce-ending drainShadow (queue is empty in PR3 anyway).
    runner.wake();

    // Resolve the debounce so the loop proceeds to drainShadow + clearPending.
    const resolveDebounce = resolvers[1];
    if (resolveDebounce === undefined) throw new Error('expected debounce resolver');
    resolveDebounce();
    await waitFor(() => sleepCalls.length >= 3);

    // Critical: the third sleep is a FRESH remaining-time main wait, NOT a
    // second debounce. Wake 2 was consumed by the drain's clearPending.
    expect(sleepCalls[2]).not.toBe(500);
    expect(sleepCalls[2]).toBeGreaterThan(500);
    // Equivalently: there's still EXACTLY ONE debounce sleep so far.
    expect(sleepCalls.filter((ms) => ms === 500)).toHaveLength(1);

    triggerKill();
    await runPromise;
  });

  it('a poll-deadline outcome (no wake) — drainShadow runs pre+post tick, but no debounce', async () => {
    // With the default synchronous sleep, the loop runs maxTicks=2 without
    // any wake interruption. Each tick triggers 2 drainShadow calls (pre + post).
    // Critical: the test verifies the existing test pattern (which uses
    // `sleep: () => Promise.resolve()`) STILL works under the new loop shape —
    // behavior preservation for non-SSE runs.
    const sleepMsCalls: number[] = [];
    const runner = makeRunner({
      maxTicks: 3,
      deps: { sleep: (ms) => { sleepMsCalls.push(ms); return Promise.resolve(); } },
    });
    await runner.run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start').map((e) => e.tick)).toEqual([1, 2, 3]);
    // Same `[30000, 30000]` shape the pre-PR3 test (Runner — tick loop / clamps pollIntervalMs ...) asserted.
    expect(sleepMsCalls).toEqual([30_000, 30_000]);
  });
});

// ── ownStateQueue overflow telemetry (Phase 2 PR3) ───────────────────────────

describe('Runner — own-state queue overflow telemetry (Phase 2 PR3)', () => {
  it('a single overflow drain emits stream-health-degraded ONCE; further empty drains do not re-emit', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    // Force an overflow via the public enqueue surface.
    const cap = 10_000;
    for (let i = 0; i < cap; i++) {
      runner.enqueueOwnStateEvent({ kind: 'fill', body: { i } });
    }
    expect(runner.enqueueOwnStateEvent({ kind: 'fill', body: { overflow: true } })).toBe('overflow');

    await runner.run();
    const events = readEvents();
    const degraded = events.filter((e) => e.kind === 'stream-health-degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ reason: 'queue-overflow', shadowReady: false, queueCapacity: cap });
  });

  it('stream-would-hold is emitted iff open exposure > 0 (Phase 2 — does NOT actually hold)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    const cap = 10_000;
    for (let i = 0; i < cap; i++) runner.enqueueOwnStateEvent({ kind: 'fill', body: { i } });
    runner.enqueueOwnStateEvent({ kind: 'fill', body: {} });

    await runner.run();
    const events = readEvents();
    // No open exposure in the default empty-state runner → no stream-would-hold.
    expect(events.filter((e) => e.kind === 'stream-would-hold')).toHaveLength(0);
    // The degraded event still fires.
    expect(events.filter((e) => e.kind === 'stream-health-degraded')).toHaveLength(1);
  });

  it('overflow does NOT set fundingHold and does NOT block trading (Phase 2 shadow-only contract)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    const cap = 10_000;
    for (let i = 0; i < cap; i++) runner.enqueueOwnStateEvent({ kind: 'fill', body: { i } });
    runner.enqueueOwnStateEvent({ kind: 'fill', body: {} });
    await runner.run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'funding-hold')).toBe(false);
  });
});

// ── own-state SSE subscription wiring (Phase 2 PR4a) ─────────────────────────

describe('Runner — own-state SSE subscription wiring (Phase 2 PR4a)', () => {
  // Recorder that captures the handler set passed to subscribeOwnState +
  // exposes a `fire(...)` API so tests can simulate SDK callbacks. Typed
  // loosely (`unknown` body / handlers indexed by string) to keep the test
  // ergonomic — the runner-side types are checked by the production code.
  function makeOwnStateRecorder() {
    let capturedHandlers: Record<string, ((...args: unknown[]) => void) | undefined> = {};
    let unsubscribed = false;
    let capturedOptions: unknown;
    const sub = { unsubscribe: () => { unsubscribed = true; return Promise.resolve(); } };
    const subscribe = ((opts: unknown, handlers: unknown) => {
      capturedOptions = opts;
      capturedHandlers = handlers as Record<string, (...args: unknown[]) => void>;
      return sub;
    }) as unknown as OspexAdapter['subscribeOwnState'];
    return {
      sub,
      subscribe,
      get isUnsubscribed(): boolean { return unsubscribed; },
      /** The options object the runner passed to subscribeOwnState — e.g. `{ address, initialCursor }`. */
      get options(): unknown { return capturedOptions; },
      /**
       * Simulate an SDK callback. The SDK delivers `OwnStateEventMeta` as the
       * ONLY arg to `onReady` and as the 2nd arg to the body-carrying handlers
       * (`onSnapshot`/`onCommitment`/`onFill`/`onPositionStatus`); `onStatus`/
       * `onError` carry no meta. `meta` defaults to `{ cursor: '' }` so callers
       * that don't exercise cursor promotion need not supply it.
       */
      fire(name: string, arg?: unknown, meta: { cursor: string } = { cursor: '' }): void {
        const h = capturedHandlers[name];
        if (h === undefined) throw new Error(`recorder.fire: no handler for ${name}`);
        if (name === 'onReady') {
          h(meta);
        } else if (name === 'onSnapshot' || name === 'onCommitment' || name === 'onFill' || name === 'onPositionStatus') {
          h(arg, meta);
        } else {
          h(arg);
        }
      },
      handler(name: string): ((...args: unknown[]) => void) | undefined { return capturedHandlers[name]; },
    };
  }

  it('does NOT open the SSE subscription when config.ownState.subscribe=false (default)', async () => {
    const config = cfg(); // subscribe defaults false
    const recorder = makeOwnStateRecorder();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'subscribeOwnState').mockImplementation(recorder.subscribe);
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(recorder.handler('onReady')).toBeUndefined();
  });

  it('opens the SSE subscription on boot when config.ownState.subscribe=true', async () => {
    const config = cfg({ ownState: { subscribe: true } });
    const recorder = makeOwnStateRecorder();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'subscribeOwnState').mockImplementation(recorder.subscribe);
    const runner = makeRunner({ config, adapter, maxTicks: 1, makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex });
    await runner.run();
    expect(recorder.handler('onReady')).toBeDefined();
    // Shutdown sweeps unsubscribe
    expect(recorder.isUnsubscribed).toBe(true);
  });

  it('boot refuses subscribe=true without a maker address (dry-run can\'t mint the bearer token)', () => {
    const config = cfg({ ownState: { subscribe: true } }); // mode.dryRun stays true by default
    expect(() => makeRunner({ config })).toThrow(/own-state SSE stream is owner-authenticated/);
  });

  it('lifecycle invariant — a stale-sub handler must NOT mutate shadow / enqueue / wake (adversarial)', async () => {
    const config = cfg({ ownState: { subscribe: true } });
    const recorder = makeOwnStateRecorder();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'subscribeOwnState').mockImplementation(recorder.subscribe);
    const runner = makeRunner({ config, adapter, maxTicks: 1, makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex });
    const runPromise = runner.run();

    // Wait until the subscription has been opened (synchronous on the recorder,
    // but the runner enters run() async — flush a microtask).
    await new Promise<void>((r) => setImmediate(r));

    // Swap out currentOwnStateSubscription with a sentinel so the prior
    // subscription's handlers see `mySub !== current` and must no-op.
    const sentinelSub: Subscription = { unsubscribe: () => Promise.resolve() };
    runner.setCurrentOwnStateSubscriptionForTest(sentinelSub);

    const shadowBefore = JSON.parse(JSON.stringify(runner.ownStateShadowView()));

    // Fire every kind of handler with realistic-shaped payloads.
    recorder.fire('onSnapshot', { cursor: 'c1', commitments: [], positions: [], truncated: false, positionsTruncated: false });
    recorder.fire('onReady');
    recorder.fire('onCommitment', { commitmentHash: '0xstale', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false });
    recorder.fire('onPositionStatus', { address: '0xstale', speculationId: 'spec', positionType: 0, status: 'active', sourceUpdatedAt: '2025-01-01T00:00:00Z' });
    recorder.fire('onStatus', 'resync');
    recorder.fire('onError', { reason: 'fatal', message: 'simulated', constructor: { name: 'OspexStreamError' } });

    // Shadow must be byte-identical (no stale handler mutation).
    expect(JSON.parse(JSON.stringify(runner.ownStateShadowView()))).toEqual(shadowBefore);

    // Restore so shutdown unsubscribes cleanly.
    runner.setCurrentOwnStateSubscriptionForTest(recorder.sub);
    await runPromise;
  });

  /**
   * Builds a runner with ownState.subscribe wired against the recorder + a
   * controllable sleep + a trigger-kill seam. Returns the runner + a way to
   * wait for tick 1 to complete (subscription open + loop in
   * waitForNextPollDeadline) so tests can fire events while the loop is
   * paused mid-wait. Tests must call `triggerKill()` and `await runPromise`
   * to clean up.
   */
  async function makePausedSubscribedRunner() {
    const config = cfg({ ownState: { subscribe: true } });
    const recorder = makeOwnStateRecorder();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'subscribeOwnState').mockImplementation(recorder.subscribe);
    const { sleep, sleepCalls, resolvers } = controllableSleep();
    let triggerKill!: () => void;
    const runner = makeRunner({
      config, adapter, maxTicks: 100,
      makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex,
      deps: {
        sleep,
        registerShutdownSignals: (onSignal) => { triggerKill = onSignal; return () => {}; },
      },
    });
    const runPromise = runner.run();
    await waitFor(() => sleepCalls.length >= 1);
    return { runner, recorder, runPromise, sleepCalls, resolvers, triggerKill: () => triggerKill() };
  }

  it('multi-page snapshot accumulates into pendingBaseline; onReady atomically swaps into shadow.commitments + shadow.positions', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();

    // Page 1 (truncated=true) — accumulate commitment A + position P1
    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{ commitmentHash: '0xa', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [{ speculationId: 'spec-1', positionType: 0, riskAmountUSDC: 0.1, profitAmountUSDC: 0, status: 'active' }],
      truncated: true,
      positionsTruncated: false,
    });

    let shadow = runner.ownStateShadowView();
    expect(shadow.ready).toBe(false);
    expect(shadow.pendingBaseline).not.toBeNull();
    expect(Object.keys(shadow.pendingBaseline!.commitments)).toEqual(['0xa']);
    expect(Object.keys(shadow.pendingBaseline!.positions)).toEqual(['spec-1:away']);
    expect(shadow.commitments).toEqual({}); // not yet swapped
    expect(shadow.positions).toEqual({});

    // Page 2 (truncated=false) — accumulate commitment B
    recorder.fire('onSnapshot', {
      cursor: 'c2',
      commitments: [{ commitmentHash: '0xb', filledRiskAmount: '0', riskAmount: '200', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });

    shadow = runner.ownStateShadowView();
    expect(Object.keys(shadow.pendingBaseline!.commitments).sort()).toEqual(['0xa', '0xb']);

    // onReady: atomic swap.
    recorder.fire('onReady');
    shadow = runner.ownStateShadowView();
    expect(shadow.ready).toBe(true);
    expect(shadow.pendingBaseline).toBeNull();
    expect(Object.keys(shadow.commitments).sort()).toEqual(['0xa', '0xb']);
    expect(Object.keys(shadow.positions)).toEqual(['spec-1:away']);

    triggerKill();
    await runPromise;
  });

  it('onStatus(\'resync\') drops pendingBaseline + sets ready=false so a partial pre-resync snapshot does not swap in', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();

    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{ commitmentHash: '0xpre', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });
    recorder.fire('onReady');
    expect(runner.ownStateShadowView().ready).toBe(true);
    expect(Object.keys(runner.ownStateShadowView().commitments)).toEqual(['0xpre']);

    // resync mid-stream — drops the in-flight baseline + flags not-ready
    recorder.fire('onStatus', 'resync');
    const shadow = runner.ownStateShadowView();
    expect(shadow.ready).toBe(false);
    expect(shadow.pendingBaseline).toBeNull();
    expect(shadow.lastStatus).toBe('resync');
    // Pre-resync shadow.commitments PRESERVED — comparator suppresses via `ready` precondition.
    expect(Object.keys(shadow.commitments)).toEqual(['0xpre']);

    triggerKill();
    await runPromise;
  });

  it('onError(fatal) sets healthy=false; pre-existing shadow state PRESERVED (comparator suppression is PR5\'s job)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();

    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{ commitmentHash: '0xpre', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });
    recorder.fire('onReady');

    // Simulate a fatal error.
    recorder.fire('onError', Object.assign(new Error('boom'), { reason: 'fatal' }));
    const shadow = runner.ownStateShadowView();
    expect(shadow.healthy).toBe(false);
    expect(shadow.lastError?.reason).toBe('fatal');
    // Shadow state preserved as STALE — PR5 comparator's `healthy && ready` precondition is the suppression.
    expect(Object.keys(shadow.commitments)).toEqual(['0xpre']);

    triggerKill();
    await runPromise;
  });

  it('onCommitment / onFill / onPositionStatus enqueue events + wake the loop', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();

    // Fire each delta type — they enqueue + wake; queue is drained at next iter or pre-tick.
    recorder.fire('onCommitment', { commitmentHash: '0xc', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false });
    recorder.fire('onFill', { txHash: '0xtx', logIndex: 0, commitmentHash: '0xc', makerRiskAmount: '50' });
    recorder.fire('onPositionStatus', { address: '0xabc', speculationId: 'spec-1', positionType: 0, status: 'active', sourceUpdatedAt: '2025-01-01T00:00:00Z' });

    // No direct assertion on queue contents (private); but lastEventAtMs advanced.
    expect(runner.ownStateShadowView().lastEventAtMs).toBeGreaterThan(0);

    triggerKill();
    await runPromise;
  });

  // ── Hermes #68 round-2 regressions ───────────────────────────────────────

  it('queue overflow latches healthy=false; subsequent onStatus(\'connected\') does NOT restore healthy (Hermes #68 blocker 1)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    // Simulate a queue-overflow drain via the test seam (the production path
    // through `drainShadow` requires running the loop past the overflow).
    runner.setStreamOverflowDegradedForTest(true);
    // Mirror what `drainShadow` does on overflow:
    // (the explicit seam exercises the gating logic; the integration test
    // path is in "Runner — own-state queue overflow telemetry" above.)
    recorder.fire('onStatus', 'degraded');
    expect(runner.ownStateShadowView().healthy).toBe(false);
    recorder.fire('onStatus', 'connected');
    // Transport reconnected, but the overflow latch survives — healthy stays false.
    expect(runner.ownStateShadowView().healthy).toBe(false);
    expect(runner.streamOverflowDegradedForTest()).toBe(true);
    triggerKill();
    await runPromise;
  });

  it('onStatus(\'resync\') clears the overflow latch — the upcoming fresh snapshot is authoritative (Hermes #68 blocker 1)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    runner.setStreamOverflowDegradedForTest(true);
    recorder.fire('onStatus', 'resync');
    expect(runner.streamOverflowDegradedForTest()).toBe(false);
    // Ready also flips off — the next onReady restores healthy after a fresh baseline.
    expect(runner.ownStateShadowView().ready).toBe(false);
    triggerKill();
    await runPromise;
  });

  it('snapshot with positionsTruncated:true → shadow.positionsTruncated stays true after onReady; healthy=false (Hermes #68 blocker 2)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{ commitmentHash: '0xa', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: false,
      positionsTruncated: true, // server signaled the 200-row position cap
    });
    recorder.fire('onReady');
    const shadow = runner.ownStateShadowView();
    expect(shadow.ready).toBe(true);
    expect(shadow.positionsTruncated).toBe(true);
    // The truncated baseline must NOT be marked healthy — PR5 comparator's
    // `healthy && ready` precondition is the suppression.
    expect(shadow.healthy).toBe(false);
    // A subsequent `connected` status doesn't restore healthy until a
    // non-truncated baseline lands.
    recorder.fire('onStatus', 'connected');
    expect(runner.ownStateShadowView().healthy).toBe(false);
    triggerKill();
    await runPromise;
  });

  it('OR-latch positionsTruncated across snapshot pages — once any page reports it, the latch survives the final page (Hermes #68 blocker 2)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    // Page 1: positionsTruncated=true (server signaled the cap WAS hit, but
    // commitments still page).
    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{ commitmentHash: '0xa', filledRiskAmount: '0', riskAmount: '100', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: true,
      positionsTruncated: true,
    });
    // Page 2: positionsTruncated=false (later page doesn't repeat the flag,
    // but the upstream incompleteness is real).
    recorder.fire('onSnapshot', {
      cursor: 'c2',
      commitments: [{ commitmentHash: '0xb', filledRiskAmount: '0', riskAmount: '200', expiry: null, status: 'open', storedStatus: 'open', nonceInvalidated: false }],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });
    recorder.fire('onReady');
    expect(runner.ownStateShadowView().positionsTruncated).toBe(true);
    expect(runner.ownStateShadowView().healthy).toBe(false);
    triggerKill();
    await runPromise;
  });

  // ── PR4b — drainShadow dispatch + dedup-set boot construction ───────────

  it('drainShadow dispatches commitment/fill/positionStatus events to owner reducers (Phase 2 PR4b)', async () => {
    const { runner, recorder, runPromise, sleepCalls, resolvers, triggerKill } = await makePausedSubscribedRunner();

    // Fire a snapshot so the shadow is ready (otherwise the reducer mutations
    // would happen but be harder to observe without ready=true). Bring up
    // ready first so the dispatch path is meaningful.
    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [{
        ownerAuthorized: true, visibility: 'visible', redacted: false,
        commitmentHash: '0xabc', maker: DEFAULT_FAKE_MAKER_ADDRESS,
        contestId: '1', scorer: '0xscorer', lineTicks: 0, positionType: 0, oddsTick: 250,
        marketType: 'moneyline', riskAmount: '250000', filledRiskAmount: '0',
        remainingRiskAmount: '250000', nonce: '1',
        expiry: '2099-01-01T00:00:00.000Z', speculationKey: null, signature: null,
        status: 'open', storedStatus: 'open', source: 'sse', network: 'polygon',
        nonceInvalidated: false, isLive: true, createdAt: '2025-01-01T00:00:00.000Z',
      }],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });
    recorder.fire('onReady');

    // Fire a commitment delta — onCommitment enqueues; we wake to trigger
    // the loop's drain. The drain dispatches via reduceOwnerCommitmentObservation.
    recorder.fire('onCommitment', {
      ownerAuthorized: true, visibility: 'visible', redacted: false,
      commitmentHash: '0xabc', maker: DEFAULT_FAKE_MAKER_ADDRESS,
      contestId: '1', scorer: '0xscorer', lineTicks: 0, positionType: 0, oddsTick: 250,
      marketType: 'moneyline', riskAmount: '250000', filledRiskAmount: '100000',
      remainingRiskAmount: '150000', nonce: '1',
      expiry: '2099-01-01T00:00:00.000Z', speculationKey: null, signature: null,
      status: 'partially_filled', storedStatus: 'partially_filled', source: 'sse',
      network: 'polygon', nonceInvalidated: false, isLive: true,
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    // Fire a fill delta.
    recorder.fire('onFill', {
      speculationId: 'spec-1', contestId: 'contest-1', commitmentHash: '0xabc',
      maker: DEFAULT_FAKE_MAKER_ADDRESS, taker: '0xother',
      makerPositionType: 0, takerPositionType: 1,
      makerRiskAmount: '100000', takerRiskAmount: '150000',
      makerRiskUSDC: 0.1, takerRiskUSDC: 0.15, oddsTick: 250,
      filledAt: '2025-01-01T00:00:00.000Z', contestStarted: false,
      txHash: '0xtx1', logIndex: 0,
    });

    // The handlers fired wake() — the loop's main sleep aborted, debounce
    // started. Resolve the debounce so the wake-handler completes its
    // drainShadow → reducer dispatch path.
    await waitFor(() => sleepCalls.filter((ms) => ms === 500).length >= 1);
    const idx = sleepCalls.findIndex((ms) => ms === 500);
    const debounceResolve = resolvers[idx];
    if (debounceResolve === undefined) throw new Error('expected debounce resolver');
    debounceResolve();
    await waitFor(() => runner.ownStateShadowView().commitments['0xabc']?.lifecycle === 'partiallyFilled');

    const shadow = runner.ownStateShadowView();
    // Commitment delta → projection → lifecycle 'partiallyFilled', filledRiskWei6 = '100000'.
    expect(shadow.commitments['0xabc']?.lifecycle).toBe('partiallyFilled');
    expect(shadow.commitments['0xabc']?.filledRiskWei6).toBe('100000');
    // Fill delta → position created with maker-side risk.
    expect(shadow.positions['spec-1:away']?.riskAmountWei6).toBe('100000');

    triggerKill();
    await runPromise;
  });

  it('onStatus(\'resync\') drops pre-resync queued events — prevents double-count when post-resync baseline is applied (Hermes #69 blocker)', async () => {
    // Without the queue.clear() on resync, this sequence double-counts:
    //   1. SDK delivers a fill — runner queues it (drain pending).
    //   2. SDK delivers `event: resync` — runner clears pendingBaseline + ready
    //      but the fill stays in the queue.
    //   3. SDK cold-starts + delivers a fresh snapshot that INCLUDES the fill.
    //   4. drainShadow applies the stale queued fill on top of the fresh
    //      baseline → position risk doubled.
    // This test asserts step 2 actually clears the queue.
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();

    // Initial snapshot + ready so the shadow has a baseline.
    recorder.fire('onSnapshot', {
      cursor: 'c1',
      commitments: [],
      positions: [],
      truncated: false,
      positionsTruncated: false,
    });
    recorder.fire('onReady');

    // Fire a fill — it enqueues but the loop is paused at the debounce sleep.
    recorder.fire('onFill', {
      speculationId: 'spec-1', contestId: 'contest-1', commitmentHash: '0xa',
      maker: DEFAULT_FAKE_MAKER_ADDRESS, taker: '0xother',
      makerPositionType: 0, takerPositionType: 1,
      makerRiskAmount: '50000', takerRiskAmount: '75000',
      makerRiskUSDC: 0.05, takerRiskUSDC: 0.075, oddsTick: 250,
      filledAt: '2025-01-01T00:00:00.000Z', contestStarted: false,
      txHash: '0xtx1', logIndex: 0,
    });
    expect(runner.ownStateQueueSizeForTest()).toBe(1);

    // Resync — must clear the queued event.
    recorder.fire('onStatus', 'resync');
    expect(runner.ownStateQueueSizeForTest()).toBe(0);
    expect(runner.ownStateShadowView().ready).toBe(false);
    expect(runner.ownStateShadowView().pendingBaseline).toBeNull();

    triggerKill();
    await runPromise;
  });

  // ── PR1 — cursor promotion contract (own-state SSE plan §4.3) ────────────
  //
  // The resume cursor (`state.ownStateCursor`) advances ONLY when paired with a
  // real applied effect: a snapshot baseline whose `onReady` swap succeeded
  // (promoting the untruncated-page cursor), or a delta whose reducer applied
  // cleanly (contiguous-success prefix only). A truncated page, a baseline-less
  // onReady, a reducer throw, and a resync all leave (or clear) the cursor.

  const MINIMAL_COMMITMENT = (hash: string) => ({
    commitmentHash: hash, filledRiskAmount: '0', riskAmount: '100', expiry: null,
    status: 'open', storedStatus: 'open', nonceInvalidated: false,
  });

  it('promotes the untruncated-page cursor on a successful onReady baseline swap (§4.3)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    expect(runner.ownStateCursorForTest()).toBeUndefined();
    recorder.fire('onSnapshot', { commitments: [MINIMAL_COMMITMENT('0xa')], positions: [], truncated: false, positionsTruncated: false }, { cursor: 'snap-1' });
    // Before ready, the cursor is NOT yet promoted (only staged internally).
    expect(runner.ownStateCursorForTest()).toBeUndefined();
    recorder.fire('onReady', undefined, { cursor: 'ready-1' });
    // The staged baseline cursor wins over the onReady cursor.
    expect(runner.ownStateCursorForTest()).toBe('snap-1');
    triggerKill();
    await runPromise;
  });

  it('a truncated page does NOT stage a cursor; the final untruncated page does (§4.3)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    // Page 1 truncated — its cursor must NOT become the resume point.
    recorder.fire('onSnapshot', { commitments: [MINIMAL_COMMITMENT('0xa')], positions: [], truncated: true, positionsTruncated: false }, { cursor: 'page-1-truncated' });
    // Page 2 untruncated — this cursor pairs with the complete baseline.
    recorder.fire('onSnapshot', { commitments: [MINIMAL_COMMITMENT('0xb')], positions: [], truncated: false, positionsTruncated: false }, { cursor: 'page-2-final' });
    recorder.fire('onReady', undefined, { cursor: 'ready-x' });
    expect(runner.ownStateCursorForTest()).toBe('page-2-final');
    triggerKill();
    await runPromise;
  });

  it('does NOT promote a cursor on a baseline-less onReady (resume delivered no snapshot — cursor alone is not state)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    // onReady with NO prior snapshot → pendingBaseline is null → no durable
    // baseline → the cursor must NOT be promoted. (Commit 3 turns this branch
    // into the empty-baseline cold-restart guard.)
    recorder.fire('onReady', undefined, { cursor: 'ready-no-baseline' });
    expect(runner.ownStateCursorForTest()).toBeUndefined();
    triggerKill();
    await runPromise;
  });

  it('resync clears the staged + persisted cursor (a stale resume point must not survive a re-baseline)', async () => {
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    recorder.fire('onSnapshot', { commitments: [], positions: [], truncated: false, positionsTruncated: false }, { cursor: 'snap-1' });
    recorder.fire('onReady', undefined, { cursor: 'ready-1' });
    expect(runner.ownStateCursorForTest()).toBe('snap-1');
    recorder.fire('onStatus', 'resync');
    expect(runner.ownStateCursorForTest()).toBeUndefined();
    triggerKill();
    await runPromise;
  });

  it('promotes a delta cursor after its reducer applies (§4.3 delta track)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    runner.enqueueOwnStateEvent({ kind: 'commitment', body: MINIMAL_COMMITMENT('0xc'), cursor: 'delta-1' });
    await runner.run();
    expect(runner.ownStateCursorForTest()).toBe('delta-1');
  });

  it('freezes cursor promotion at the first reducer throw — a later success cannot leapfrog the failed event (contiguous-success, FM3)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    // Good → promote 'g1'.
    runner.enqueueOwnStateEvent({ kind: 'commitment', body: MINIMAL_COMMITMENT('0xg1'), cursor: 'g1' });
    // Bad fill (no maker/taker) → reducer throws → freeze promotion.
    runner.enqueueOwnStateEvent({ kind: 'fill', body: { txHash: '0x1', logIndex: 0 }, cursor: 'g2' });
    // Good → reduces cleanly, BUT promotion is frozen → its cursor is NOT taken.
    runner.enqueueOwnStateEvent({ kind: 'commitment', body: MINIMAL_COMMITMENT('0xg3'), cursor: 'g3' });
    await runner.run();
    // Cursor stays at the last CONTIGUOUS success before the throw, never 'g3'.
    expect(runner.ownStateCursorForTest()).toBe('g1');
  });

  it('an unknown event kind also freezes promotion (never advance past a skipped effect)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    runner.enqueueOwnStateEvent({ kind: 'commitment', body: MINIMAL_COMMITMENT('0xk1'), cursor: 'k1' });
    runner.enqueueOwnStateEvent({ kind: 'made-up-kind', body: {}, cursor: 'k2' });
    runner.enqueueOwnStateEvent({ kind: 'commitment', body: MINIMAL_COMMITMENT('0xk3'), cursor: 'k3' });
    await runner.run();
    expect(runner.ownStateCursorForTest()).toBe('k1');
  });

  it('drainShadow logs error + skips on unknown event kind (Phase 2 PR4b)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    runner.enqueueOwnStateEvent({ kind: 'made-up-kind', body: {} });
    await runner.run();
    const events = readEvents();
    const errs = events.filter((e) => e.kind === 'error' && e.class === 'UnknownOwnStateEventKind');
    expect(errs).toHaveLength(1);
  });

  it('reducer throw logs error + skips (Phase 2 PR4b — malformed body defensive path)', async () => {
    const runner = makeRunner({ maxTicks: 1 });
    // Synthetic fill body missing maker/taker — the reducer throws on toLowerCase().
    runner.enqueueOwnStateEvent({ kind: 'fill', body: { txHash: '0x1', logIndex: 0 } });
    await runner.run();
    const events = readEvents();
    const errs = events.filter((e) => e.kind === 'error' && typeof e.detail === 'string' && e.detail.includes('event.kind=fill'));
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  // ── PR5 — shadow comparator preconditions ────────────────────────────────

  it('comparator does NOT fire when subscribe=false (default — no SSE stream)', async () => {
    const runner = makeRunner({ maxTicks: 3 });
    await runner.run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'divergence')).toHaveLength(0);
  });

  it('comparator does NOT fire on the FIRST post-ready tick (firstPollAfterShadowReady latch)', async () => {
    // Set up: subscribed runner, fire snapshot + ready, then let the loop tick once.
    // The latch flips after this tick but the comparator should NOT have run yet
    // (canonical state was poll-derived BEFORE shadow.ready flipped true).
    const { recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    recorder.fire('onSnapshot', { cursor: 'c1', commitments: [], positions: [], truncated: false, positionsTruncated: false });
    recorder.fire('onReady');
    recorder.fire('onStatus', 'connected');

    // The first post-ready tick should set the latch but not emit divergence.
    triggerKill();
    await runPromise;
    const events = readEvents();
    // No divergence emitted — the canonical and shadow agree (both empty).
    expect(events.filter((e) => e.kind === 'divergence')).toHaveLength(0);
  });

  it('comparator preconditions exercised — shadow.ready + connected + queue=0 reachable through the handler path', async () => {
    // End-to-end smoke: verify the runner-wiring side of the comparator —
    // the precondition state can be advanced through the SSE handlers.
    // Detailed detection logic is in shadow-comparator.test.ts.
    const { runner, recorder, runPromise, triggerKill } = await makePausedSubscribedRunner();
    recorder.fire('onSnapshot', { cursor: 'c1', commitments: [], positions: [], truncated: false, positionsTruncated: false });
    recorder.fire('onReady');
    recorder.fire('onStatus', 'connected');
    expect(runner.ownStateShadowView().ready).toBe(true);
    expect(runner.ownStateShadowView().lastStatus).toBe('connected');
    expect(runner.ownStateShadowView().healthy).toBe(true);

    triggerKill();
    await runPromise;
  });

  it('sync throw from openOwnStateSubscription propagates AND runs the finally cleanup — unregister called (Hermes #68 blocker 3)', async () => {
    const config = cfg({ ownState: { subscribe: true } });
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    // SDK throws on subscribe (auth misconfiguration / network init failure).
    vi.spyOn(adapter, 'subscribeOwnState').mockImplementation((() => {
      throw new Error('synthetic subscribe failure');
    }) as unknown as OspexAdapter['subscribeOwnState']);

    let registered = false;
    let unregistered = false;
    const runner = makeRunner({
      config, adapter, maxTicks: 1,
      makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex,
      deps: {
        registerShutdownSignals: (_onSignal) => {
          registered = true;
          return () => { unregistered = true; };
        },
      },
    });
    await expect(runner.run()).rejects.toThrow('synthetic subscribe failure');
    expect(registered).toBe(true);
    // The finally block ran — unregister was called even though `subscribeOwnState`
    // threw before the loop started. Without the fix, this would be `false`
    // because openOwnStateSubscription was OUTSIDE the try/finally.
    expect(unregistered).toBe(true);
  });
});

// ── discovery (DESIGN §10) ───────────────────────────────────────────────────

describe('Runner — discovery', () => {
  it('discovers on tick 1, then every discovery.everyNTicks ticks (no jitter via random → 0.5)', async () => {
    let listCalls = 0;
    const config = cfg({ discovery: { everyNTicks: 3 } });
    const adapter = spiedAdapter(config, () => {
      listCalls += 1;
      return Promise.resolve([contestView({ contestId: 'A' })]);
    });
    const runner = makeRunner({ config, adapter, maxTicks: 8 });
    await runner.run();
    expect(listCalls).toBe(3); // ticks 1, 4, 7 (next at 10 > 8)
    expect(runner.trackedContestIds()).toEqual(['A']);
  });

  it('tracks contests with an open moneyline speculation + a reference-game id; skips the rest with the right candidate reasons', async () => {
    const config = cfg(); // sports: ['mlb'], default caps
    const A = contestView({ contestId: 'A' });
    const B = contestView({ contestId: 'B', speculations: [{ speculationId: 'spec-B', contestId: 'B', marketType: 'spread', lineTicks: -35, line: -3.5, open: true }] }); // no open moneyline spec
    const C = contestView({ contestId: 'C', sport: 'nba' }); // wrong sport — filtered out before any candidate event
    const D = contestView({ contestId: 'D' }); // looks fine in the list, but getContest(D) has no referenceGameId
    const E = contestView({ contestId: 'E', matchTime: PAST_ISO }); // already started
    const adapter = spiedAdapter(config, () => Promise.resolve([A, B, C, D, E]), (id) =>
      Promise.resolve(id === 'D' ? contestView({ contestId: 'D', referenceGameId: null }) : contestView({ contestId: id, referenceGameId: `GAME-${id}` })),
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(runner.trackedContestIds()).toEqual(['A']);
    const candidates = readEvents().filter((e) => e.kind === 'candidate');
    expect(candidates.map((e) => e.contestId).sort()).toEqual(['A', 'B', 'D', 'E']); // no event for C (wrong sport)
    expect(candidates.find((e) => e.contestId === 'A')?.skipReason).toBeUndefined(); // tracked
    expect(candidates.find((e) => e.contestId === 'B')?.skipReason).toBe('no-open-speculation');
    expect(candidates.find((e) => e.contestId === 'D')?.skipReason).toBe('no-reference-odds');
    expect(candidates.find((e) => e.contestId === 'E')?.skipReason).toBe('start-too-soon');
  });

  it('honours marketSelection.maxTrackedContests — tracks the soonest games, the rest get tracking-cap-reached', async () => {
    const config = cfg({ marketSelection: { sports: ['mlb'], maxTrackedContests: 2 } });
    const listed = [
      contestView({ contestId: 'A', matchTime: '2099-01-01T00:00:00Z' }),
      contestView({ contestId: 'B', matchTime: '2099-01-02T00:00:00Z' }),
      contestView({ contestId: 'C', matchTime: '2099-01-03T00:00:00Z' }),
      contestView({ contestId: 'D', matchTime: '2099-01-04T00:00:00Z' }),
      contestView({ contestId: 'E', matchTime: '2099-01-05T00:00:00Z' }),
    ];
    const adapter = spiedAdapter(config, () => Promise.resolve(listed));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A', 'B']); // the two earliest
    const capped = readEvents().filter((e) => e.kind === 'candidate' && e.skipReason === 'tracking-cap-reached');
    expect(capped.map((e) => e.contestId).sort()).toEqual(['C', 'D', 'E']);
  });

  it('untracks a contest that drops out of the candidate set (started / scored / out of window)', async () => {
    let listCount = 0;
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const adapter = spiedAdapter(config, () => {
      listCount += 1;
      return Promise.resolve(listCount === 1 ? [contestView({ contestId: 'A' }), contestView({ contestId: 'B' })] : [contestView({ contestId: 'A' })]);
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // B departed on the 2nd cycle
  });

  it('a listContests failure aborts the cycle (emits an error event, keeps the existing tracked set)', async () => {
    let listCount = 0;
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const adapter = spiedAdapter(config, () => {
      listCount += 1;
      return listCount === 1 ? Promise.resolve([contestView({ contestId: 'A' })]) : Promise.reject(new Error('api down'));
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // unchanged after the failed 2nd cycle
    const err = readEvents().find((e) => e.kind === 'error');
    expect(err).toMatchObject({ phase: 'discovery', detail: 'api down' });
  });

  it('a getContest failure for one candidate skips it (emits an error event), tracks the others', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]), (id) =>
      id === 'B' ? Promise.reject(new Error('boom')) : Promise.resolve(contestView({ contestId: id, referenceGameId: `GAME-${id}` })),
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']);
    expect(readEvents().find((e) => e.kind === 'error')).toMatchObject({ phase: 'discovery', contestId: 'B', detail: 'boom' });
  });

  it('honours the allow / deny lists (a denied / disallowed contest is filtered out before any candidate event)', async () => {
    const denyConfig = cfg({ marketSelection: { sports: ['mlb'], contestDenyList: ['B'] } });
    const denyAdapter = spiedAdapter(denyConfig, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]));
    const denyRunner = makeRunner({ config: denyConfig, adapter: denyAdapter, maxTicks: 1 });
    await denyRunner.run();
    expect(denyRunner.trackedContestIds()).toEqual(['A']);
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'B')).toBe(false);

    // (fresh logDir/stateDir from beforeEach won't reset mid-test, but a separate runId keeps the event logs apart)
    const allowConfig = cfg({ marketSelection: { sports: ['mlb'], contestAllowList: ['A'] } });
    const allowAdapter = spiedAdapter(allowConfig, () => Promise.resolve([contestView({ contestId: 'A' }), contestView({ contestId: 'B' })]));
    const allowRunner = makeRunner({ config: allowConfig, adapter: allowAdapter, runId: 'allow-run', maxTicks: 1 });
    await allowRunner.run();
    expect(allowRunner.trackedContestIds()).toEqual(['A']);
    expect(readEvents('allow-run').some((e) => e.kind === 'candidate' && e.contestId === 'B')).toBe(false);
  });

  it('jitters the discovery interval by ±jitterPct (random shifts how often discovery runs)', async () => {
    const config = cfg({ discovery: { everyNTicks: 4, jitterPct: 0.5 } });
    const listed = [contestView({ contestId: 'A' })];

    let shortCalls = 0;
    await makeRunner({ config, adapter: spiedAdapter(config, () => { shortCalls += 1; return Promise.resolve(listed); }), runId: 'short', maxTicks: 6, deps: { random: () => 0 } }).run();
    expect(shortCalls).toBe(3); // factor 0.5 ⇒ interval round(4*0.5)=2 ⇒ ticks 1, 3, 5 (next at 7)

    let longCalls = 0;
    await makeRunner({ config, adapter: spiedAdapter(config, () => { longCalls += 1; return Promise.resolve(listed); }), runId: 'long', maxTicks: 6, deps: { random: () => 1 } }).run();
    expect(longCalls).toBe(1); // factor 1.5 ⇒ interval round(4*1.5)=6 ⇒ tick 1 only (next at 7)
  });
});

// ── kill switch ──────────────────────────────────────────────────────────────

describe('Runner — kill switch', () => {
  it('a KILL file appearing stops the loop and emits kill with reason kill-file', async () => {
    let checks = 0;
    await makeRunner({ maxTicks: 20, deps: { killFileExists: () => { checks += 1; return checks >= 3; } } }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(2);
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ reason: 'kill-file', ticks: 2 });
  });

  it('a SIGTERM / SIGINT stops the loop and emits kill with reason signal', async () => {
    let onSignal: (() => void) | null = null;
    let sleeps = 0;
    await makeRunner({
      maxTicks: 20,
      deps: {
        registerShutdownSignals: (cb) => { onSignal = cb; return () => {}; },
        sleep: () => { sleeps += 1; if (sleeps === 2) onSignal?.(); return Promise.resolve(); },
      },
    }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(2);
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ reason: 'signal', ticks: 2 });
  });
});

// ── age-out (DESIGN §9) ──────────────────────────────────────────────────────

describe('Runner — age-out', () => {
  it('reclassifies expired visibleOpen / softCancelled / partiallyFilled records to expired (with an expire event); leaves future ones alone', async () => {
    const now = 1_900_000_000;
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        // Seeds sit past expiry + the 60s release grace so they're releasable (the grace window itself is covered by the two tests below).
        expiredOpen: commitmentRecord({ hash: 'expiredOpen', lifecycle: 'visibleOpen', expiryUnixSec: now - 100 }),
        expiredSc: commitmentRecord({ hash: 'expiredSc', lifecycle: 'softCancelled', expiryUnixSec: now - 100, makerSide: 'home' }),
        expiredPartial: commitmentRecord({ hash: 'expiredPartial', lifecycle: 'partiallyFilled', filledRiskWei6: '100000', expiryUnixSec: now - 100 }),
        futureOpen: commitmentRecord({ hash: 'futureOpen', lifecycle: 'visibleOpen', expiryUnixSec: now + 50 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1, deps: { now: () => now } }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments.expiredOpen?.lifecycle).toBe('expired');
    expect(reloaded.commitments.expiredSc?.lifecycle).toBe('expired');
    expect(reloaded.commitments.expiredPartial?.lifecycle).toBe('expired');
    expect(reloaded.commitments.futureOpen?.lifecycle).toBe('visibleOpen');
    expect(reloaded.commitments.expiredOpen?.updatedAtUnixSec).toBe(now);

    const expired = readEvents().filter((e) => e.kind === 'expire');
    expect(expired.map((e) => e.commitmentHash).sort()).toEqual(['expiredOpen', 'expiredPartial', 'expiredSc']);
  });

  it('does NOT age out a commitment inside the expiry-release grace window', async () => {
    const now = 1_900_000_000;
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { within: commitmentRecord({ hash: 'within', lifecycle: 'visibleOpen', expiryUnixSec: now - 30 }) } });
    await makeRunner({ maxTicks: 1, deps: { now: () => now } }).run(); // cfg() default grace 60; 30s past expiry ⇒ held
    expect(StateStore.at(stateDir).load().state.commitments.within?.lifecycle).toBe('visibleOpen');
    expect(readEvents().some((e) => e.kind === 'expire')).toBe(false);
  });

  it('ages out a commitment once it is past expiry + the grace window', async () => {
    const now = 1_900_000_000;
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { pastGrace: commitmentRecord({ hash: 'pastGrace', lifecycle: 'visibleOpen', expiryUnixSec: now - 61 }) } });
    await makeRunner({ maxTicks: 1, deps: { now: () => now } }).run(); // 61s past expiry > grace 60 ⇒ released
    expect(StateStore.at(stateDir).load().state.commitments.pastGrace?.lifecycle).toBe('expired');
    expect(readEvents().some((e) => e.kind === 'expire' && e.commitmentHash === 'pastGrace')).toBe(true);
  });
});

// ── prune of old terminal commitment records ─────────────────────────────────

describe('Runner — prune terminal commitments', () => {
  // Default orders.expirySeconds is 120, so the retention window is max(3600, 1200) = 3600s before `now`.
  const cutoff = T0 - 3600;

  it('drops terminal records (expired / filled / authoritativelyInvalidated) older than the retention window', async () => {
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        'old-expired': commitmentRecord({ hash: 'old-expired', lifecycle: 'expired', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 1 }),
        'old-filled': commitmentRecord({ hash: 'old-filled', lifecycle: 'filled', riskAmountWei6: '300000', filledRiskWei6: '300000', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 50 }),
        'old-invalidated': commitmentRecord({ hash: 'old-invalidated', lifecycle: 'authoritativelyInvalidated', expiryUnixSec: T0 - 4000, postedAtUnixSec: T0 - 4100, updatedAtUnixSec: cutoff - 999 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1 }).run();

    expect(Object.keys(StateStore.at(stateDir).load().state.commitments)).toEqual([]);
  });

  it('keeps recent terminal records, and all non-terminal records regardless of age', async () => {
    const state: MakerState = {
      ...emptyMakerState(),
      commitments: {
        // Terminal but within the retention window — kept.
        'recent-expired': commitmentRecord({ hash: 'recent-expired', lifecycle: 'expired', expiryUnixSec: T0 - 200, postedAtUnixSec: T0 - 300, updatedAtUnixSec: T0 - 100 }),
        // Non-terminal, ancient updatedAt, not past expiry — never pruned (softCancelled stays matchable on chain → the risk engine must keep counting it).
        'old-soft': commitmentRecord({ hash: 'old-soft', lifecycle: 'softCancelled', expiryUnixSec: T0 + 5000, postedAtUnixSec: T0 - 999_999, updatedAtUnixSec: T0 - 999_999 }),
        'old-visible': commitmentRecord({ hash: 'old-visible', lifecycle: 'visibleOpen', makerSide: 'home', expiryUnixSec: T0 + 5000, postedAtUnixSec: T0 - 999_999, updatedAtUnixSec: T0 - 999_999 }),
      },
    };
    StateStore.at(stateDir).flush(state);
    await makeRunner({ maxTicks: 1 }).run();

    expect(Object.keys(StateStore.at(stateDir).load().state.commitments).sort()).toEqual(['old-soft', 'old-visible', 'recent-expired']);
  });
});

// ── interruptibleSleep ───────────────────────────────────────────────────────

describe('interruptibleSleep', () => {
  it('resolves after the timeout when never aborted', async () => {
    await interruptibleSleep(0, new AbortController().signal); // resolves on the next macrotask — proves it doesn't hang
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await interruptibleSleep(60_000, ac.signal); // a broken impl would hang here for a minute
  });

  it('resolves promptly when the signal aborts before the timeout elapses', async () => {
    const ac = new AbortController();
    const p = interruptibleSleep(60_000, ac.signal);
    ac.abort();
    await p; // resolves via the abort listener, not the (1-minute) timer
  });
});

// ── odds subscriptions / stream guardrails (DESIGN §10) ────────────────────

describe('Runner — odds subscriptions', () => {
  it('seeds odds (snapshot-first) then opens an SSE odds stream for each newly-tracked market', async () => {
    const config = cfg(); // odds.subscribe defaults true, maxRealtimeChannels 5
    const recorder = makeSubscribeRecorder();
    let snapshotCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, moneylineOdds(-150, 130))); },
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(snapshotCalls).toBe(1); // seeded before subscribing
    expect(recorder.successfulCalls()).toEqual(['A']);
    expect(runner.trackedMarketView('A')).toMatchObject({
      subscribed: true,
      lastMoneylineOdds: { awayOddsAmerican: -150, homeOddsAmerican: 130 },
      lastOddsAt: T0,
      dirty: false, // seeded dirty, but the same tick's per-market reconcile picked it up and cleared the flag
    });
  });

  it('honours odds.maxRealtimeChannels — subscribes the soonest games, the rest get a degraded channel-cap event; a freed slot is taken on the next cycle', async () => {
    const config = cfg({ odds: { maxRealtimeChannels: 2 }, discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    const a = contestView({ contestId: 'A', matchTime: '2099-01-01T00:00:00Z' });
    const b = contestView({ contestId: 'B', matchTime: '2099-01-02T00:00:00Z' });
    const c = contestView({ contestId: 'C', matchTime: '2099-01-03T00:00:00Z' });
    let listCount = 0;
    const adapter = spiedAdapter(config, () => { listCount += 1; return Promise.resolve(listCount === 1 ? [a, b, c] : [b, c]); }, undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    // cycle 1: A, B, C tracked; A & B get channels (soonest), C is over the cap → degraded channel-cap.
    // cycle 2: A departs → its channel frees → C is subscribed.
    expect(runner.trackedContestIds()).toEqual(['B', 'C']);
    expect(runner.trackedMarketView('B')?.subscribed).toBe(true);
    expect(runner.trackedMarketView('C')?.subscribed).toBe(true);
    const capEvents = readEvents().filter((e) => e.kind === 'degraded' && e.reason === 'channel-cap');
    expect(capEvents.map((e) => e.contestId)).toEqual(['C']);
    expect(recorder.successfulCalls().filter((id) => id === 'C')).toHaveLength(1); // C subscribed once, on cycle 2
    expect(recorder.successfulCalls().filter((id) => id === 'A')).toHaveLength(1); // A subscribed cycle 1, then departed
  });

  it('a channel onChange updates the odds + marks the market dirty; onRefresh updates without marking dirty; a seed with no moneyline row leaves lastMoneylineOdds null', async () => {
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let t = T0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => Promise.resolve(oddsSnapshotView(contestId, null)), // no moneyline row at seed time
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => t } });
    await runner.run();

    // after the seed: subscribed, the feed responded (so lastOddsAt is set) but the response had no moneyline row, so no usable odds yet; not dirty (it had none before either).
    expect(runner.trackedMarketView('A')).toMatchObject({ subscribed: true, lastMoneylineOdds: null, lastOddsAt: T0, dirty: false });

    const handlers = recorder.handlersFor('A');
    expect(handlers).toBeDefined();

    // onRefresh: stores the odds + bumps freshness, but does NOT mark the market dirty.
    t = T0 + 5;
    handlers?.onRefresh?.(moneylineOdds(-120, 100));
    expect(runner.trackedMarketView('A')).toMatchObject({ lastMoneylineOdds: { awayOddsAmerican: -120, homeOddsAmerican: 100 }, lastOddsAt: T0 + 5, dirty: false });

    // onChange: updates the odds, bumps freshness, marks the market dirty.
    t = T0 + 10;
    handlers?.onChange(moneylineOdds(150, -180));
    expect(runner.trackedMarketView('A')).toMatchObject({ lastMoneylineOdds: { awayOddsAmerican: 150, homeOddsAmerican: -180 }, lastOddsAt: T0 + 10, dirty: true });
  });

  it('a fatal channel onError degrades the market (subscription cleared) + emits a degraded channel-error event; the next discovery cycle re-subscribes it', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('A')?.onError?.(new OspexStreamError('channel boom', { reason: 'fatal' })); return Promise.resolve(); } },
    });
    await runner.run();

    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // re-subscribed on cycle 2
    expect(recorder.successfulCalls()).toEqual(['A', 'A']);
    const degraded = readEvents().filter((e) => e.kind === 'degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ contestId: 'A', referenceGameId: 'GAME-A', reason: 'channel-error', detail: 'channel boom' });
  });

  it('a retryable (non-fatal) channel onError keeps the subscription alive (the SDK self-reconnects) and logs a breadcrumb — no teardown, no re-subscribe', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('A')?.onError?.(new OspexStreamError('blip', { reason: 'connection_failed' })); return Promise.resolve(); } },
    });
    await runner.run();

    // The transport is still reconnecting — the channel must NOT be torn down or re-subscribed.
    expect(runner.trackedMarketView('A')?.subscribed).toBe(true);
    expect(recorder.successfulCalls()).toEqual(['A']); // subscribed once; no re-subscribe
    expect(readEvents().some((e) => e.kind === 'degraded' && e.reason === 'channel-error')).toBe(false);
    // A breadcrumb is logged for observability — the class carries the stream reason.
    expect(readEvents().find((e) => e.kind === 'error' && e.phase === 'odds-stream')).toMatchObject({ class: 'stream-connection_failed', detail: 'blip', contestId: 'A' });
  });

  it('onStatus reconnecting / degraded emit stream-* degraded telemetry without tearing the channel down; connected is not a degraded signal', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) { const h = recorder.handlersFor('A'); h?.onStatus?.('reconnecting'); h?.onStatus?.('degraded'); h?.onStatus?.('connected'); } return Promise.resolve(); } },
    });
    await runner.run();

    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // status transitions never tear the channel down
    expect(recorder.successfulCalls()).toEqual(['A']); // no re-subscribe
    const reasons = readEvents().filter((e) => e.kind === 'degraded').map((e) => e.reason);
    expect(reasons).toContain('stream-reconnecting');
    expect(reasons).toContain('stream-degraded');
    expect(reasons).not.toContain('stream-connected'); // 'connected' is the healthy state, not a degraded signal
  });

  it('a subscribeOdds rejection (e.g. the initial SSE connect was rejected) degrades the market with a subscribe-failed event; the next discovery cycle retries', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    recorder.rejectWhen((contestId, attempt) => contestId === 'A' && attempt === 1);
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // succeeded on the 2nd attempt
    expect(recorder.attemptsFor('A')).toBe(2);
    expect(recorder.successfulCalls()).toEqual(['A']);
    const degraded = readEvents().filter((e) => e.kind === 'degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ contestId: 'A', reason: 'subscribe-failed', detail: 'subscribe failed (test)' });
  });

  it('a seed-snapshot failure logs an error but does not block the subscription; odds arrive on the first channel onChange', async () => {
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: () => Promise.reject(new Error('snapshot 503')),
      subscribe: recorder.subscribe,
    });
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    expect(runner.trackedMarketView('A')).toMatchObject({ subscribed: true, lastMoneylineOdds: null }); // channel up despite the seed failure
    expect(readEvents().find((e) => e.kind === 'error')).toMatchObject({ phase: 'odds-seed', contestId: 'A', detail: 'snapshot 503' });

    recorder.handlersFor('A')?.onChange(moneylineOdds(-200, 170));
    expect(runner.trackedMarketView('A')?.lastMoneylineOdds).toEqual({ awayOddsAmerican: -200, homeOddsAmerican: 170 });
  });

  it('a departed market has its odds channel unsubscribed', async () => {
    const config = cfg({ discovery: { everyNTicks: 1 } });
    const recorder = makeSubscribeRecorder();
    let listCount = 0;
    const adapter = spiedAdapter(config, () => { listCount += 1; return Promise.resolve(listCount === 1 ? [contestView({ contestId: 'A' }), contestView({ contestId: 'B' })] : [contestView({ contestId: 'A' })]); }, undefined, { subscribe: recorder.subscribe });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    expect(runner.trackedContestIds()).toEqual(['A']);
    expect(recorder.unsubscribeFor('B')).toHaveBeenCalledTimes(1);
    expect(recorder.unsubscribeFor('A')).not.toHaveBeenCalled(); // A is still tracked
    expect(runner.trackedMarketView('A')?.subscribed).toBe(true);
  });

  it('odds.subscribe: false → polling mode: snapshots every tracked market each tick, never opens an SSE odds stream', async () => {
    const config = cfg({ odds: { subscribe: false }, discovery: { everyNTicks: 10 } }); // discovery runs once (tick 1)
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, moneylineOdds(-130, 110))); },
      subscribe: () => { subscribeCalls += 1; return Promise.resolve(noopSubscription()); },
    });
    const runner = makeRunner({ config, adapter, maxTicks: 3 });
    await runner.run();

    expect(subscribeCalls).toBe(0); // no SSE stream in polling mode
    expect(snapshotCalls).toBe(3); // one snapshot per tick for the one tracked market
    expect(runner.trackedMarketView('A')).toMatchObject({
      subscribed: false,
      lastMoneylineOdds: { awayOddsAmerican: -130, homeOddsAmerican: 110 },
      lastOddsAt: T0,
    });
  });
});

// ── per-market reconcile (DESIGN §3 step 3, §8, §9) ──────────────────────────

describe('Runner — per-market reconcile', () => {
  it('a tracked market with reference odds gets a two-sided quote — a quote-intent, would-submit per side, synthetic visibleOpen records', async () => {
    StateStore.at(stateDir).flush(emptyMakerState()); // clean state → no boot hold
    const config = cfg(); // economics-mode pricing, conservative defaults
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    const events = readEvents();
    const submits = events.filter((e) => e.kind === 'would-submit');
    expect(submits.map((e) => e.takerSide).sort()).toEqual(['away', 'home']); // a quote per taker-offer side
    expect(submits.map((e) => e.makerSide).sort()).toEqual(['away', 'home']); // ...which on chain are maker-on-home (away offer) + maker-on-away (home offer)
    for (const e of submits) {
      expect(e).toMatchObject({ contestId: 'A', speculationId: 'spec-A', sport: 'mlb', riskAmountWei6: '250000', expiryUnixSec: T0 + 120 });
      // The conversion happened at the boundary: makerSide is the opposite of takerSide; makerOddsTick is inverseOddsTick of takerOddsTick; positionType matches makerSide (away → 0, home → 1).
      expect(e.makerSide).toBe(e.takerSide === 'away' ? 'home' : 'away');
      expect(e.makerOddsTick).toBe(inverseOddsTick(e.takerOddsTick as number));
      expect(e.positionType).toBe(e.makerSide === 'away' ? 0 : 1);
      expect(typeof e.takerImpliedProb).toBe('number');
    }
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: 'A', speculationId: 'spec-A', canQuote: true });
    // risk-verdict (Phase 3 h) — engine's per-market decision; emitted alongside quote-intent. Both sides allowed in this happy path; non-zero headroom on both.
    const verdict = events.find((e) => e.kind === 'risk-verdict');
    expect(verdict).toMatchObject({ contestId: 'A', speculationId: 'spec-A', allowed: true });
    expect(verdict?.awayOffer).toMatchObject({ allowed: true });
    expect(verdict?.homeOffer).toMatchObject({ allowed: true });
    expect((verdict?.awayOffer as { sizeUSDC: number }).sizeUSDC).toBeGreaterThan(0);
    expect((verdict?.homeOffer as { sizeUSDC: number }).sizeUSDC).toBeGreaterThan(0);
    expect((verdict?.awayOffer as { headroomUSDC: number }).headroomUSDC).toBeGreaterThan(0);

    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
    // Each synthetic record carries the *protocol* commitment params it would post — and matches its would-submit event.
    for (const r of records) {
      expect(r.lifecycle).toBe('visibleOpen');
      expect(r.speculationId).toBe('spec-A');
      expect(r.contestId).toBe('A');
      expect(r.sport).toBe('mlb');
      expect(r.riskAmountWei6).toBe('250000');
      expect(r.filledRiskWei6).toBe('0');
      expect(r.expiryUnixSec).toBe(T0 + 120);
      expect(r.postedAtUnixSec).toBe(T0);
      expect(r.scorer).toBe(adapter.addresses().scorers.moneyline);
      expect(r.oddsTick).toBeGreaterThanOrEqual(101);
      expect(r.oddsTick).toBeLessThanOrEqual(10100);
      const matchingSubmit = submits.find((e) => e.makerSide === r.makerSide);
      expect(matchingSubmit?.makerOddsTick).toBe(r.oddsTick);
    }
    expect(runner.trackedMarketView('A')).toMatchObject({ dirty: false, lastReconciledAt: T0 }); // the reconcile consumed the dirty flag
  });

  it('match-time expiry mode: a synthetic quote expires at the contest match time, not now + expirySeconds', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ orders: { expiryMode: 'match-time', expirySeconds: 120 } });
    const matchTimeSec = Math.floor(Date.parse(FUTURE_ISO) / 1000);
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    for (const r of records) expect(r.expiryUnixSec).toBe(matchTimeSec);
  });

  it('a stale incumbent gets replaced (would-replace; the old record → softCancelled; a fresh synthetic record); a missing side gets submitted', async () => {
    const stale = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, riskAmountWei6: '250000', expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': stale } });
    const config = cfg(); // default staleAfterSeconds 90 → posted 200s ago is stale
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    // `0xstaleAway` is `makerSide: 'away'` → a quote on the *home offer*; its replacement is the home offer's quote (also maker-on-away). The other (away) offer has no incumbent → fresh submit (a maker-on-home commitment).
    expect(events.find((e) => e.kind === 'would-replace')).toMatchObject({ replacedCommitmentHash: '0xstaleAway', takerSide: 'home', makerSide: 'away', reason: 'stale', speculationId: 'spec-A' });
    expect(events.find((e) => e.kind === 'would-submit')).toMatchObject({ takerSide: 'away', makerSide: 'home', speculationId: 'spec-A' });

    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('softCancelled'); // pulled, but still counted (matchable on chain)
    const records = Object.values(reloaded);
    expect(records).toHaveLength(3); // the old (softCancelled) + the away replacement + the home submit
    expect(records.filter((r) => r.lifecycle === 'visibleOpen').map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('a market the risk engine refuses gets a quote-intent with canQuote: false; its standing quotes are soft-cancelled (would-soft-cancel side-not-quoted)', async () => {
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    const onA = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xother': onOther, '0xaWay': onA } });
    const config = cfg({ risk: { maxOpenCommitments: 2 } }); // the open-commitment count is already 2 → market A is refused (count cap)
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: 'A', canQuote: false });
    // risk-verdict (Phase 3 h) — engine refused at the open-commitment count cap. Both sides allowed:false; the notes array carries the reason. sizeUSDC = 0 on a refused side.
    const verdict = events.find((e) => e.kind === 'risk-verdict');
    expect(verdict).toMatchObject({ contestId: 'A', speculationId: 'spec-A', allowed: false });
    expect(verdict?.awayOffer).toMatchObject({ allowed: false, sizeUSDC: 0 });
    expect(verdict?.homeOffer).toMatchObject({ allowed: false, sizeUSDC: 0 });
    expect(Array.isArray(verdict?.notes)).toBe(true);
    expect((verdict?.notes as string[]).join(' ')).toMatch(/open-commitment count/);
    expect(events.find((e) => e.kind === 'would-soft-cancel')).toMatchObject({ commitmentHash: '0xaWay', takerSide: 'home', makerSide: 'away', reason: 'side-not-quoted' }); // makerSide:'away' → a quote on the home offer
    expect(events.some((e) => e.kind === 'would-submit' || e.kind === 'would-replace')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-competitiveness' || e.kind === 'competitiveness-unavailable')).toBe(false); // a refused quote has nothing to assess
    expect(StateStore.at(stateDir).load().state.commitments['0xaWay']?.lifecycle).toBe('softCancelled');
  });

  it('risk-verdict (Phase 3 h) is NOT emitted when a pre-engine gate skips the market (no-reference-odds / no-open-speculation / etc.) — the engine never ran', async () => {
    // A contest tracked with no reference moneyline odds → the runner skips
    // before buildDesiredQuote. The risk-verdict event documents the engine's
    // verdict; not the pre-gate skips (which surface as `candidate` skipReasons).
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    // Override the odds snapshot so the moneyline row is absent → no-reference-odds gate trips before buildDesiredQuote runs.
    vi.spyOn(adapter, 'getOddsSnapshot').mockResolvedValue(oddsSnapshotView('A', null));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'risk-verdict')).toBe(false);
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'no-reference-odds')).toBeDefined();
  });

  it('when the open-commitment count budget runs out mid-plan a side is deferred — a cap-hit candidate, only the affordable side submitted', async () => {
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xother': onOther } });
    const config = cfg({ risk: { maxOpenCommitments: 2 } }); // count 1 < 2 → A allowed, but room for only 1 more new commitment → one side of the two-sided quote is deferred
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(1);
    const capHit = events.filter((e) => e.kind === 'candidate' && e.skipReason === 'cap-hit');
    expect(capHit).toHaveLength(1);
    expect(capHit[0]).toMatchObject({ contestId: 'A' });
    expect(['away', 'home']).toContain(capHit[0]?.takerSide);
    expect(events.filter((e) => e.kind === 'quote-competitiveness')).toHaveLength(2); // both sides' would-be prices are assessed — including the cap-deferred one
  });

  it('a quoted market emits a quote-competitiveness event per side — book depth, best taker-perspective tick, vs the reference, at/inside the book', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // The MM's offer ticks for a -110 / -110 reference land near 200 (a roughly even line, well inside [101, 10100]).
    // An *away offer* on chain is a maker-on-home (positionType 1) commitment, so it competes with the book's positionType-1
    // commitments; a *home offer* is a maker-on-away (positionType 0) commitment. The taker-perspective tick of a competing
    // commitment is inverseOddsTick(c.oddsTick), and a higher one is better for the taker — so `bestBookTakerTick` is the *max*
    // of those over the same-positionType commitments, and the MM's offer is at/inside iff its takerOddsTick is at least that high.
    //   Away offer (vs positionType-1): one competitor at maker tick 10100 → taker tick inverseOddsTick(10100) = 101 → the MM's
    //     ~200 is well ahead → at/inside; bookDepthOnSide 1, bestBookTakerTick 101.
    //   Home offer (vs positionType-0): two competitors at maker ticks 101 & 102 → taker ticks 10100 & 5100 → the MM's ~200 is
    //     far behind → not at/inside; bookDepthOnSide 2, bestBookTakerTick 10100.
    //   The non-live entry, and the null-positionType / null-tick (and out-of-range) ones, are skipped.
    const book: Commitment[] = [
      orderbookEntry({ commitmentHash: '0xob-pt0-1', positionType: 0, oddsTick: 101 }),
      orderbookEntry({ commitmentHash: '0xob-pt0-2', positionType: 0, oddsTick: 102 }),
      orderbookEntry({ commitmentHash: '0xob-pt1', positionType: 1, oddsTick: 10100 }),
      orderbookEntry({ commitmentHash: '0xob-dead', positionType: 0, oddsTick: 200, isLive: false }), // not matchable
      orderbookEntry({ commitmentHash: '0xob-np', positionType: null, oddsTick: 5000 }), // legacy: no position type
      orderbookEntry({ commitmentHash: '0xob-nt', positionType: 0, oddsTick: null }), // legacy: no tick
      orderbookEntry({ commitmentHash: '0xob-oor', positionType: 0, oddsTick: 100 }), // out of [101, 10100] — can't be a valid commitment; skipped
    ];
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (specId) => Promise.resolve({ ...speculationView(specId), orderbook: book }),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const comps = readEvents().filter((e) => e.kind === 'quote-competitiveness');
    expect(comps.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    const away = comps.find((e) => e.takerSide === 'away');
    const home = comps.find((e) => e.takerSide === 'home');
    expect(away).toMatchObject({ contestId: 'A', speculationId: 'spec-A', takerSide: 'away', makerSide: 'home', positionType: 1, bookDepthOnSide: 1, bestBookTakerTick: 101, atOrInsideBook: true });
    expect(home).toMatchObject({ contestId: 'A', speculationId: 'spec-A', takerSide: 'home', makerSide: 'away', positionType: 0, bookDepthOnSide: 2, bestBookTakerTick: 10100, atOrInsideBook: false });
    // The rest of the payload is present and well-formed.
    for (const c of comps) {
      expect(typeof c.takerOddsTick).toBe('number');
      expect((c.takerOddsTick as number) >= 101 && (c.takerOddsTick as number) <= 10100).toBe(true);
      expect(typeof c.takerImpliedProb).toBe('number');
      expect(typeof c.makerOddsTick).toBe('number');
      expect(typeof c.referenceTakerTick).toBe('number');
      expect(typeof c.referenceImpliedProb).toBe('number');
      expect(c.vsReferenceTicks).toBe((c.takerOddsTick as number) - (c.referenceTakerTick as number));
    }
  });

  it('a quoted market whose getSpeculation response carries no orderbook emits competitiveness-unavailable (but the quote itself still goes through)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // A SpeculationView without `orderbook` — getSpeculation normally always populates it, so this is the degraded read path.
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (specId): Promise<SpeculationView> => Promise.resolve({ speculationId: specId, contestId: 'A', marketType: 'moneyline', lineTicks: null, line: null, open: true }),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'competitiveness-unavailable')).toMatchObject({ contestId: 'A', speculationId: 'spec-A' });
    expect(events.some((e) => e.kind === 'quote-competitiveness')).toBe(false);
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // competitiveness is an observational extra, not a gate
  });

  it('a market starting within one expiry window is gated — a start-too-soon candidate, no quote', async () => {
    const config = cfg(); // expirySeconds 120
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // 60s past the test clock — past discovery's "started" gate, inside the reconcile's start-too-soon gate
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A', matchTime: SOON_ISO })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // tracked at discovery
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'start-too-soon')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a tracked market with no usable reference odds is gated — a no-reference-odds candidate, no quote', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { snapshot: () => Promise.reject(new Error('no odds')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a tracked market whose speculation has closed is gated — a no-open-speculation candidate, no quote', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { getSpeculation: (specId) => Promise.resolve(speculationView(specId, false)) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-open-speculation')).toBe(true);
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false);
  });

  it('a market whose reference odds have gone stale is gated — a stale-reference candidate', async () => {
    let t = T0;
    const config = cfg({ orders: { staleAfterSeconds: 1, staleReferenceAfterSeconds: 1 } });
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    // tick 1: seed odds (lastOddsAt = T0) + quote. sleep → clock advances 2s. tick 2 (now = T0+2): the odds are now 2s old > staleReferenceAfterSeconds(1) → stale-reference.
    await makeRunner({ config, adapter, maxTicks: 2, deps: { now: () => t, sleep: () => { t += 2; return Promise.resolve(); } } }).run();
    expect(readEvents().some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'stale-reference')).toBe(true);
  });

  it('a getSpeculation failure during the reconcile is logged (error, phase reconcile) and the market is skipped this pass', async () => {
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { getSpeculation: () => Promise.reject(new Error('spec read failed')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().find((e) => e.kind === 'error' && e.phase === 'reconcile')).toMatchObject({ contestId: 'A', detail: 'spec read failed' });
    expect(readEvents().some((e) => e.kind === 'would-submit')).toBe(false);
  });

  it('the per-market reconcile is skipped while the boot-time state-loss hold is active (DESIGN §12) — discovery + odds still run', async () => {
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8'); // prior telemetry, no state file → state loss → hold
    const config = cfg(); // fixed-seconds expiry; the fixed clock never reaches the deadline
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    const runner = makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => T0 } });
    expect(runner.bootAssessment.holdQuoting).toBe(true);
    await runner.run();
    expect(runner.trackedContestIds()).toEqual(['A']); // discovery runs while held
    expect(runner.trackedMarketView('A')?.subscribed).toBe(true); // odds subscription runs while held
    expect(readEvents().some((e) => e.kind === 'would-submit' || e.kind === 'quote-intent')).toBe(false); // but no quoting
    expect(existsSync(join(stateDir, 'maker-state.json'))).toBe(false); // not flushed while held
    expect(runner.trackedMarketView('A')?.dirty).toBe(true); // dirty stays armed — the reconcile never consumed it
  });

  it('an onChange between ticks re-arms a market that already has a fresh quote — it is reconciled again the next tick', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    // tick 1: track + seed + quote A (dirty consumed). sleep → an onChange re-arms A. tick 2: A is reconciled again (no discovery this tick).
    await makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('A')?.onChange(moneylineOdds(-110, -110)); return Promise.resolve(); } },
    }).run();
    expect(readEvents().filter((e) => e.kind === 'quote-intent' && e.contestId === 'A')).toHaveLength(2);
  });

  // ── unquoteable-market quote pulls (review-PR14) ───────────────────────────

  it('a market with visible quotes that loses its reference odds has them pulled (would-soft-cancel) — not left visible', async () => {
    const away = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-A', contestId: 'A', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 200, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    const home = commitmentRecord({ hash: '0xaHome', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 200, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xaWay': away, '0xaHome': home } });
    const config = cfg();
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { snapshot: (contestId) => Promise.resolve(oddsSnapshotView(contestId, null)) }); // no moneyline row → no usable reference odds
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls.map((e) => e.commitmentHash).sort()).toEqual(['0xaHome', '0xaWay']);
    expect(pulls.every((e) => e.reason === 'side-not-quoted')).toBe(true);
    expect(events.some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    expect(events.some((e) => e.kind === 'would-submit')).toBe(false);
    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect([reloaded['0xaWay']?.lifecycle, reloaded['0xaHome']?.lifecycle]).toEqual(['softCancelled', 'softCancelled']);
  });

  it('a market whose odds channel errors has its visible quotes pulled the next tick (would-soft-cancel) — a degraded channel must not keep stale quotes visible', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    const recorder = makeSubscribeRecorder();
    let sleeps = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, { subscribe: recorder.subscribe });
    // tick 1: track + seed + quote A (2 synthetic visibleOpen records). sleep → the channel errors. tick 2: A is unquoteable (channel down) → its visible quotes are pulled.
    await makeRunner({
      config,
      adapter,
      maxTicks: 2,
      deps: { sleep: () => { sleeps += 1; if (sleeps === 1) recorder.handlersFor('A')?.onError?.(new OspexStreamError('channel boom', { reason: 'fatal' })); return Promise.resolve(); } },
    }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // tick 1
    expect(events.some((e) => e.kind === 'degraded' && e.reason === 'channel-error')).toBe(true);
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls).toHaveLength(2); // tick 2 pulled both
    expect(pulls.every((e) => e.contestId === 'A' && e.reason === 'side-not-quoted')).toBe(true);
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.lifecycle === 'softCancelled')).toBe(true);
  });

  it('a transient getSpeculation failure after an odds move does not clear the dirty flag — the market retries the next tick', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    let getSpecCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      getSpeculation: (speculationId) => { getSpecCalls += 1; return getSpecCalls === 1 ? Promise.reject(new Error('spec read transient')) : Promise.resolve(speculationView(speculationId, true)); },
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(getSpecCalls).toBe(2); // tick 1 failed, tick 2 retried
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'reconcile')).toMatchObject({ contestId: 'A', detail: 'spec read transient' });
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // A got quoted on tick 2 — it would NOT if tick 1's failure had cleared dirty (the fixed clock means the staleAfterSeconds throttle never elapses)
  });

  it('polling mode: a market quoted on valid odds whose next snapshot has no moneyline row has its visible quotes pulled (would-soft-cancel) — a vanished reference must not leave quotes up', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ odds: { subscribe: false }, discovery: { everyNTicks: 10 } }); // discovery runs once (tick 1)
    let snapshotCalls = 0;
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]), undefined, {
      snapshot: (contestId) => { snapshotCalls += 1; return Promise.resolve(oddsSnapshotView(contestId, snapshotCalls === 1 ? moneylineOdds(-150, 130) : null)); }, // tick 1: valid moneyline → quote; tick 2: the moneyline row is gone
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // tick 1 quoted both sides
    const pulls = events.filter((e) => e.kind === 'would-soft-cancel');
    expect(pulls).toHaveLength(2); // tick 2 pulled both — the reference odds vanished
    expect(pulls.every((e) => e.contestId === 'A' && e.reason === 'side-not-quoted')).toBe(true);
    expect(events.some((e) => e.kind === 'candidate' && e.contestId === 'A' && e.skipReason === 'no-reference-odds')).toBe(true);
    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.lifecycle === 'softCancelled')).toBe(true);
  });
});

// ── live execution — the per-market reconcile's write path (Phase 3) ─────────
//
// `config.mode.dryRun: false` + a signed adapter (`createLiveOspexAdapter`). Same
// reconcile machinery as dry-run — only the leaves differ: submits go through
// `submitCommitment` (and the recorded hash is the real one), pulls go through
// `cancelCommitmentOffchain`, and the event kinds are `submit` / `replace` /
// `soft-cancel` rather than the `would-` counterparts. The `run --live` *on-switch*
// (CLI / config) lands in a later slice — until then live mode is reachable only
// here, with a fake adapter; a live-mode config with a read-only adapter is rejected.

describe('Runner — live execution', () => {
  it('a live-mode config with a read-only adapter is rejected at construction', () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    expect(() => makeRunner({ config: cfg({ mode: { dryRun: false } }) })).toThrow(/live mode .* requires a signed adapter/);
  });

  it('posts both sides via submitCommitment, records the real hashes, emits `submit` (not `would-submit`) — the protocol tuple flows through `toProtocolQuote`', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: submit.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.some((e) => e.kind === 'would-submit')).toBe(false);
    const submitEvents = events.filter((e) => e.kind === 'submit');
    expect(submitEvents.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    expect(submitEvents.map((e) => e.commitmentHash).sort()).toEqual(['0xlive1', '0xlive2']);

    expect(submit.calls).toHaveLength(2);
    for (const a of submit.calls) {
      expect(a).toMatchObject({ contestId: 1234n, scorer: adapter.addresses().scorers.moneyline, lineTicks: 0, expiry: BigInt(T0 + 120) });
      expect(typeof a.riskAmount).toBe('bigint');
      expect([0, 1]).toContain(a.positionType);
      expect(a.oddsTick).toBeGreaterThanOrEqual(101);
      expect(a.oddsTick).toBeLessThanOrEqual(10100);
    }
    // The conversion happened at the boundary, end to end: each submit event's makerSide is the opposite of its takerSide,
    // makerOddsTick is inverseOddsTick(takerOddsTick), positionType matches makerSide — and the submitCommitment call for that
    // positionType used that same oddsTick.
    for (const e of submitEvents) {
      expect(e.makerSide).toBe(e.takerSide === 'away' ? 'home' : 'away');
      expect(e.makerOddsTick).toBe(inverseOddsTick(e.takerOddsTick as number));
      expect(e.positionType).toBe(e.makerSide === 'away' ? 0 : 1);
      const call = submit.calls.find((a) => a.positionType === e.positionType);
      expect(call?.oddsTick).toBe(e.makerOddsTick);
      expect(call?.riskAmount).toBe(BigInt(e.riskAmountWei6 as string));
    }

    const records = Object.values(StateStore.at(stateDir).load().state.commitments);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.hash).sort()).toEqual(['0xlive1', '0xlive2']);
    expect(records.every((r) => r.lifecycle === 'visibleOpen' && r.expiryUnixSec === T0 + 120)).toBe(true);
    expect(records.map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('match-time expiry: submitCommitment is called with expiry = the contest match time', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false }, orders: { expiryMode: 'match-time', expirySeconds: 120 } });
    const matchTimeSec = Math.floor(Date.parse(FUTURE_ISO) / 1000);
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: submit.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(submit.calls).toHaveLength(2);
    for (const a of submit.calls) expect(a.expiry).toBe(BigInt(matchTimeSec));
  });

  it('a submitCommitment failure is logged (error, phase submit) and the tick continues — no record, no submit event', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), { submitCommitment: () => Promise.reject(new Error('relay 503')) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run(); // must not throw

    const events = readEvents();
    const submitErrors = events.filter((e) => e.kind === 'error' && e.phase === 'submit');
    expect(submitErrors).toHaveLength(2); // both sides attempted, both failed
    expect(submitErrors[0]).toMatchObject({ contestId: '1234', detail: 'relay 503' });
    expect(submitErrors.map((e) => e.takerSide).sort()).toEqual(['away', 'home']);
    expect(events.some((e) => e.kind === 'submit')).toBe(false);
    expect(Object.keys(StateStore.at(stateDir).load().state.commitments)).toHaveLength(0);
  });

  it('a stale incumbent is replaced — off-chain cancel then submit, a `replace` event, the old record softCancelled', async () => {
    const stale = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, riskAmountWei6: '250000', expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': stale } });
    const config = cfg({ mode: { dryRun: false } }); // default staleAfterSeconds 90 → posted 200s ago is stale
    const submit = submitRecorder();
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(cancels).toContain('0xstaleAway'); // the incumbent was pulled off the API book
    expect(events.find((e) => e.kind === 'replace')).toMatchObject({ replacedCommitmentHash: '0xstaleAway', takerSide: 'home', makerSide: 'away', reason: 'stale', speculationId: 'spec-1234' });
    expect(events.find((e) => e.kind === 'submit')).toMatchObject({ takerSide: 'away', makerSide: 'home', speculationId: 'spec-1234' });
    expect(events.some((e) => e.kind === 'would-replace' || e.kind === 'would-submit')).toBe(false);

    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('softCancelled');
    expect(submit.calls).toHaveLength(2); // the away offer's fresh submit + the home offer's replacement
    expect(Object.values(reloaded).filter((r) => r.lifecycle === 'visibleOpen').map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('an unquoteable-gate pull does a real off-chain cancel — a `soft-cancel` event, the record softCancelled', async () => {
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // 60s ahead — past discovery's "started" gate, inside the reconcile's start-too-soon gate (60 <= 120)
    const visible = commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xvisible': visible } });
    const config = cfg({ mode: { dryRun: false } });
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), {
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'start-too-soon')).toMatchObject({ contestId: '1234' });
    expect(cancels).toEqual(['0xvisible']);
    expect(events.find((e) => e.kind === 'soft-cancel')).toMatchObject({ commitmentHash: '0xvisible', reason: 'side-not-quoted' });
    expect(events.some((e) => e.kind === 'would-soft-cancel' || e.kind === 'submit')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xvisible']?.lifecycle).toBe('softCancelled');
  });

  it('a side the reconcile decides not to quote has its standing commitment pulled via a real off-chain cancel (`soft-cancel` side-not-quoted)', async () => {
    const onA = commitmentRecord({ hash: '0xaWay', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    const onOther = commitmentRecord({ hash: '0xother', speculationId: 'spec-other', contestId: 'B', sport: 'nba', awayTeam: 'BOS', homeTeam: 'NYY', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xaWay': onA, '0xother': onOther } });
    const config = cfg({ mode: { dryRun: false }, risk: { maxOpenCommitments: 2 } }); // count is already 2 → market 1234 is refused (count cap)
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'quote-intent')).toMatchObject({ contestId: '1234', canQuote: false });
    expect(cancels).toEqual(['0xaWay']);
    expect(events.find((e) => e.kind === 'soft-cancel')).toMatchObject({ commitmentHash: '0xaWay', reason: 'side-not-quoted' });
    expect(events.some((e) => e.kind === 'submit' || e.kind === 'replace')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xaWay']?.lifecycle).toBe('softCancelled');
  });

  it('a stale partiallyFilled remainder is RETAINED on reconcile — never off-chain-cancelled, never reposted over, emits a `partial-remainder-retained` candidate', async () => {
    // maker-on-away partial → serves the *home* offer; stale (posted 200s ago > staleAfterSeconds 90). The home offer
    // is occupied by it (noop); the away offer (maker-on-home) is empty → exactly one fresh submit, on the away offer.
    const stalePartial = commitmentRecord({ hash: '0xpartialHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialHome': stalePartial } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(cancels).toEqual([]); // the partial is NEVER off-chain-cancelled (the API would 409 COMMITMENT_MATCHED)
    expect(events.some((e) => e.kind === 'soft-cancel' && e.commitmentHash === '0xpartialHome')).toBe(false);
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'partial-remainder-retained')).toMatchObject({ commitmentHash: '0xpartialHome', makerSide: 'away', takerSide: 'home', reason: 'stale' });
    expect(submit.calls).toHaveLength(1); // only the empty away offer is posted — no same-side repost over the live partial
    expect(StateStore.at(stateDir).load().state.commitments['0xpartialHome']?.lifecycle).toBe('partiallyFilled'); // unchanged — rides to expiry
  });

  it('an unquoteable-gate pull RETAINS a partiallyFilled remainder — no off-chain cancel, a `partial-remainder-retained` candidate, lifecycle unchanged', async () => {
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // start-too-soon gate (60 <= expirySeconds 120)
    const partial = commitmentRecord({ hash: '0xpartial', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartial': partial } });
    const config = cfg({ mode: { dryRun: false } });
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), {
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'start-too-soon')).toMatchObject({ contestId: '1234' });
    expect(cancels).toEqual([]); // the partial is not off-chain-cancelled by the gate pull
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'partial-remainder-retained')).toMatchObject({ commitmentHash: '0xpartial', reason: 'side-not-quoted' });
    expect(events.some((e) => e.kind === 'soft-cancel')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xpartial']?.lifecycle).toBe('partiallyFilled');
  });

  it('an off-chain-cancel failure is logged (error, phase cancel) and the record stays visibleOpen for retry', async () => {
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString();
    const visible = commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xvisible': visible } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), {
      cancelCommitmentOffchain: () => Promise.reject(new Error('relay 500')),
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'cancel')).toMatchObject({ contestId: '1234', commitmentHash: '0xvisible', detail: 'relay 500' });
    expect(events.some((e) => e.kind === 'soft-cancel' || e.kind === 'would-soft-cancel')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xvisible']?.lifecycle).toBe('visibleOpen'); // still up — next pass retries the pull
  });

  it('a dry-run state directory reused for live is rejected at construction (a `dry:` synthetic commitment)', () => {
    const synthetic = commitmentRecord({ hash: 'dry:prior-run:1', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { 'dry:prior-run:1': synthetic } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]));
    expect(() => makeRunner({ config, adapter, maxTicks: 1 })).toThrow(/dry-run synthetic commitment/); // never gets near cancelCommitmentOffchain — the runner can't even construct
  });

  it('a prior live run\'s state (real `0x` commitment hashes) constructs fine — the dry-run guard does not false-positive', () => {
    const live = commitmentRecord({ hash: '0xrealhash', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealhash': live } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]));
    expect(() => makeRunner({ config, adapter, maxTicks: 1 })).not.toThrow();
  });

  it('a failed replace-cancel does not post the replacement and re-reconciles next tick (retries the cancel) — DESIGN §9', async () => {
    // Two stale incumbents (one per maker side) on spec-1234 → both are toReplace. With the cancel always failing,
    // the replacements must NOT go up (a second visible quote on a side the MM can't pull would violate DESIGN §9 and
    // wouldn't self-heal — needsReconcile would see a fresh two-sided quote and skip). Instead the market stays dirty
    // and tick 2 retries the cancels.
    const staleAway = commitmentRecord({ hash: '0xstaleAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'visibleOpen', oddsTick: 250, expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    const staleHome = commitmentRecord({ hash: '0xstaleHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', oddsTick: 250, expiryUnixSec: T0 + 50, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleAway': staleAway, '0xstaleHome': staleHome } });
    const config = cfg({ mode: { dryRun: false }, risk: { maxOpenCommitments: 8 } }); // count 2 < 8 → market 1234 allowed; default staleAfterSeconds 90 → posted 200s ago is stale
    const submit = submitRecorder();
    const cancels: string[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOffchain: (h) => { cancels.push(h); return Promise.reject(new Error('relay 500')); },
    });
    const runner = makeRunner({ config, adapter, maxTicks: 2 });
    await runner.run();

    const events = readEvents();
    expect([...cancels].sort()).toEqual(['0xstaleAway', '0xstaleAway', '0xstaleHome', '0xstaleHome']); // both attempted on tick 1, both retried on tick 2 — a failed pull doesn't stop the next tick
    expect(submit.calls).toHaveLength(0); // no replacement posted (and no fresh submit — both sides are occupied by their stale incumbents)
    expect(events.filter((e) => e.kind === 'error' && e.phase === 'cancel')).toHaveLength(4);
    expect(events.some((e) => e.kind === 'replace' || e.kind === 'submit')).toBe(false);
    const reloaded = StateStore.at(stateDir).load().state.commitments;
    expect(reloaded['0xstaleAway']?.lifecycle).toBe('visibleOpen'); // both incumbents still up — unchanged (only the original, never two)
    expect(reloaded['0xstaleHome']?.lifecycle).toBe('visibleOpen');
    expect(runner.trackedMarketView('1234')?.dirty).toBe(true); // never cleared — the reconcile kept returning transient-failure
  });
});

// ── fill detection (live only, Phase 3 (c-i)) ────────────────────────────────
//
// `tick()`'s new step (between odds refresh and reconcile, live mode only) —
// diffs `listOpenCommitments(maker)` against the local `visibleOpen`/`partiallyFilled`
// set, classifies disappeared hashes via `getCommitment(hash).status`, bumps
// still-listed commitments whose `filledRiskAmount` advanced, dirties the affected
// market so the same tick's reconcile re-prices the imbalance, and emits `fill` /
// `expire` events. `liveSpiedAdapter` defaults `listOpenCommitments → []` and
// `getCommitment → reject`, so every fill-detection test stubs `reads` explicitly.
// `DEFAULT_FAKE_MAKER_ADDRESS` (module scope, `0x9999…`) is the fake signer's
// address — used as the `Commitment.maker` value when an API row is the MM's own.

describe('Runner — fill detection', () => {
  it('dry-run mode: the fill-detection step is skipped — `listOpenCommitments` is never called, even with local records', async () => {
    const record = commitmentRecord({ hash: '0xtracked', makerSide: 'away', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 100 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg();
    const adapter = createOspexAdapter(config);
    vi.spyOn(adapter, 'listContests').mockResolvedValue([]);
    vi.spyOn(adapter, 'getContest').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'getOddsSnapshot').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'subscribeOdds').mockRejectedValue(new Error('unused'));
    vi.spyOn(adapter, 'getSpeculation').mockRejectedValue(new Error('unused'));
    const listOpenSpy = vi.spyOn(adapter, 'listOpenCommitments').mockResolvedValue([]);
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(listOpenSpy).not.toHaveBeenCalled();
  });

  it('a fully-filled commitment is reclassified `filled`, a position is created, the market is dirtied, and a `fill` event fires (partial:false)', async () => {
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => h === '0xrealAway' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('filled');
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']).toMatchObject({
      speculationId: 'spec-1234', contestId: '1234', side: 'home',
      riskAmountWei6: '250000',
      // (oddsTick − 100) / 100 × risk = (200 − 100) / 100 × 250000 = 250000
      counterpartyRiskWei6: '250000',
      status: 'active',
    });

    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      commitmentHash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234',
      takerSide: 'away', makerSide: 'home', positionType: 1, makerOddsTick: 200,
      newFillWei6: '250000', filledRiskWei6: '250000', partial: false,
    });
  });

  it('a partial-fill bump (still listed; `filledRiskAmount` advanced) → record reclassified `partiallyFilled`, position extended by the delta, market dirtied, `fill` event (partial:true)', async () => {
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '100000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    // Still listed; filledRiskAmount advanced 100000 → 300000 (delta 200000).
    const apiPartial: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '300000', remainingRiskAmount: '200000', status: 'partially_filled', isLive: true });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([apiPartial]) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('partiallyFilled');
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('300000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('200000'); // delta only — counts the *new* fill
    expect(reloaded.positions['spec-1234:home']?.counterpartyRiskWei6).toBe('200000'); // 200000 × (200 − 100) / 100

    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ partial: true, newFillWei6: '200000', filledRiskWei6: '300000' });
  });

  it('a disappeared commitment whose API status is `expired` → record reclassified `expired`, an `expire` event (no `fill`)', async () => {
    const record = commitmentRecord({ hash: '0xexpiry', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xexpiry': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiExpired: Commitment = orderbookEntry({ commitmentHash: '0xexpiry', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiExpired) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xexpiry']?.lifecycle).toBe('expired');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'expire' && e.commitmentHash === '0xexpiry')).toBeDefined();
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a disappeared commitment that is TRULY on-chain-cancelled (storedStatus `cancelled`) → record reclassified `authoritativelyInvalidated`, no event', async () => {
    const record = commitmentRecord({ hash: '0xcancelled', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xcancelled': record } });
    const config = cfg({ mode: { dryRun: false } });
    // A TRUE on-chain cancel: storedStatus 'cancelled' (NOT merely book-hidden, which would also report effective status 'cancelled' but keep storedStatus open/partially_filled).
    const apiCancelled: Commitment = orderbookEntry({ commitmentHash: '0xcancelled', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'cancelled', storedStatus: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiCancelled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xcancelled']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(readEvents().some((e) => e.kind === 'fill' || e.kind === 'expire')).toBe(false);
  });

  it('a disappeared commitment that is merely BOOK-HIDDEN (effective `cancelled`, but storedStatus `partially_filled`, not nonce-invalidated) → reclassified `softCancelled` (NOT released), the fill converged commitment-only, latent remainder preserved (Hermes review-2)', async () => {
    // Post-book-visibility-split, a hidden row (book_visible=false) reports effective status
    // 'cancelled' while its signed payload stays matchable on chain. detectFills must NOT read
    // that as an authoritative invalidation and release the headroom — it must classify off
    // storedStatus/nonceInvalidated and hand the row to reconcileSoftCancelledFills.
    const record = commitmentRecord({ hash: '0xhidden', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '0', lifecycle: 'partiallyFilled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xhidden': record } });
    const config = cfg({ mode: { dryRun: false } });
    // Effective 'cancelled' (book-hidden), but storedStatus 'partially_filled' + not nonce-invalidated + a cumulative on-chain fill of 200000 (< risk 500000).
    const apiHidden: Commitment = orderbookEntry({ commitmentHash: '0xhidden', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '200000', remainingRiskAmount: '300000', status: 'cancelled', storedStatus: 'partially_filled', nonceInvalidated: false, isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => (h === '0xhidden' ? Promise.resolve(apiHidden) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xhidden']?.lifecycle).toBe('softCancelled'); // NOT authoritativelyInvalidated — the remainder is still matchable on chain
    expect(reloaded.commitments['0xhidden']?.filledRiskWei6).toBe('200000'); // the observed fill converged commitment-only
    expect(reloaded.positions['spec-1234:home']).toBeUndefined(); // NO position created — pollPositionStatus owns positions (no double-count)
    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'softcancel-recovery', commitmentHash: '0xhidden', newFillWei6: '200000', filledRiskWei6: '200000', partial: true });
  });

  it('a disappeared commitment reported effective `cancelled` AND nonce-invalidated (storedStatus still `open`) → released `authoritativelyInvalidated` (a nonce-floor raise IS authoritative, even when storedStatus isn\'t `cancelled`)', async () => {
    // Under the current effective-status core-api a nonce-invalidated commitment reports effective
    // status 'cancelled'; the canonical signal is `nonceInvalidated`, which must still release.
    const record = commitmentRecord({ hash: '0xnonce', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xnonce': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiNonce: Commitment = orderbookEntry({ commitmentHash: '0xnonce', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'cancelled', storedStatus: 'open', nonceInvalidated: true, isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => (h === '0xnonce' ? Promise.resolve(apiNonce) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xnonce']?.lifecycle).toBe('authoritativelyInvalidated'); // nonce floor raised → headroom released
    expect(readEvents().some((e) => e.kind === 'fill' || e.kind === 'expire')).toBe(false);
  });

  // ── effective-status fallback: robust to a core-api that predates effective-status ──
  // When the API still reports the RAW status, an expired/invalidated commitment
  // drops off the open-book listing but get-by-hash returns 'open'/'partially_filled'.
  // detectFills falls back to the record's own expiry + the API nonceInvalidated flag.

  it('a disappeared PAST-expiry commitment still reported raw "open" (pre-effective-status API) → terminalized expired, expire event, NO UnexpectedFillStatus', async () => {
    const record = commitmentRecord({ hash: '0xstaleOpen', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleOpen': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiOpen: Commitment = orderbookEntry({ commitmentHash: '0xstaleOpen', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'open', isLive: false, expiry: PAST_ISO });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiOpen) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xstaleOpen']?.lifecycle).toBe('expired');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'expire' && e.commitmentHash === '0xstaleOpen')).toBeDefined();
    expect(events.some((e) => e.kind === 'error' && e.class === 'UnexpectedFillStatus')).toBe(false);
  });

  it('a disappeared FUTURE-expiry commitment reported raw "open" but nonce-invalidated → authoritativelyInvalidated, NO UnexpectedFillStatus', async () => {
    const record = commitmentRecord({ hash: '0xinvalidated', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xinvalidated': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiInvalidated: Commitment = orderbookEntry({ commitmentHash: '0xinvalidated', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'open', nonceInvalidated: true, isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiInvalidated) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xinvalidated']?.lifecycle).toBe('authoritativelyInvalidated');
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error' && e.class === 'UnexpectedFillStatus')).toBe(false);
    expect(events.some((e) => e.kind === 'expire')).toBe(false);
  });

  it('a disappeared FUTURE-expiry, non-invalidated commitment reported raw "open" → STILL logs UnexpectedFillStatus (genuine anomaly), state untouched', async () => {
    const record = commitmentRecord({ hash: '0xanomaly', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xanomaly': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiOpen: Commitment = orderbookEntry({ commitmentHash: '0xanomaly', maker: DEFAULT_FAKE_MAKER_ADDRESS, status: 'open', nonceInvalidated: false, isLive: true, expiry: FUTURE_ISO });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiOpen) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xanomaly']?.lifecycle).toBe('visibleOpen'); // untouched
    expect(readEvents().find((e) => e.kind === 'error' && e.class === 'UnexpectedFillStatus')).toMatchObject({ commitmentHash: '0xanomaly' });
  });

  it('a `listOpenCommitments` failure is logged (`error` phase fill-detection) and the tick continues; state unchanged', async () => {
    const record = commitmentRecord({ hash: '0xtracked', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.reject(new Error('API 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run(); // must not throw

    expect(StateStore.at(stateDir).load().state.commitments['0xtracked']?.lifecycle).toBe('visibleOpen');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection')).toMatchObject({ detail: 'API 503' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a per-hash `getCommitment` failure on a FUTURE-expiry record is logged (phase fill-detection-lookup) and other disappeared hashes are still processed — detectFills still returns true (the record stays live + counted, next tick retries)', async () => {
    const recordA = commitmentRecord({ hash: '0xfilled', speculationId: 'spec-A', contestId: 'A', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    const recordB = commitmentRecord({ hash: '0xbroken', speculationId: 'spec-B', contestId: 'B', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xfilled': recordA, '0xbroken': recordB } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xfilled', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: 'A', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => h === '0xfilled' ? Promise.resolve(apiFilled) : Promise.reject(new Error('lookup failed')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xfilled']?.lifecycle).toBe('filled'); // processed normally
    expect(reloaded.commitments['0xbroken']?.lifecycle).toBe('visibleOpen'); // unchanged — the lookup error skipped it
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection-lookup')).toMatchObject({ commitmentHash: '0xbroken', detail: 'lookup failed' });
    expect(events.filter((e) => e.kind === 'fill')).toHaveLength(1);
  });

  it('a per-hash `getCommitment` failure on a PAST-expiry disappeared record → detectFills fails closed (no reconcile, no ageOut); record stays visibleOpen for next-tick retry (Hermes review-PR23-late)', async () => {
    // The sharp case: without the per-hash status we can't tell if the disappeared
    // record filled-then-expired, expired cleanly, or was cancelled. ageOut would
    // otherwise terminalize it to `expired` and release its headroom, and the
    // reconcile would submit replacements on exposure that may have just filled.
    // Future-expiry lookup failures stay non-fatal (covered by the test above);
    // only past-expiry trips the gate.
    // (Numeric contestId so live `submitCommitment`'s `BigInt(contestId)` doesn't throw — the
    // absence of a submit must prove the fail-closed gate worked, not a downstream BigInt error.)
    const record = commitmentRecord({ hash: '0xpastExpiry', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpastExpiry': record } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.reject(new Error('lookup 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection-lookup')).toMatchObject({ commitmentHash: '0xpastExpiry', detail: 'lookup 503' });
    expect(submit.calls).toHaveLength(0); // reconcile skipped
    expect(events.some((e) => e.kind === 'submit' || e.kind === 'replace' || e.kind === 'soft-cancel')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-intent')).toBe(false); // reconcileMarkets never ran
    expect(events.some((e) => e.kind === 'expire')).toBe(false); // ageOut skipped — record NOT terminalized
    expect(StateStore.at(stateDir).load().state.commitments['0xpastExpiry']?.lifecycle).toBe('visibleOpen'); // unchanged
  });

  it('mixed past-expiry + future-expiry getCommitment failures → still fails closed (the past-expiry one is enough)', async () => {
    // If ANY past-expiry lookup fails, the tick fails closed even if other lookups succeed.
    const past = commitmentRecord({ hash: '0xpast', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200 });
    const future = commitmentRecord({ hash: '0xfuture', speculationId: 'spec-5678', contestId: '5678', makerSide: 'away', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpast': past, '0xfuture': future } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.reject(new Error('lookup down')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(submit.calls).toHaveLength(0); // reconcile skipped — the past-expiry failure trumped the future-expiry one
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'error' && e.phase === 'fill-detection-lookup')).toHaveLength(2); // both logged
    expect(events.some((e) => e.kind === 'expire')).toBe(false); // ageOut skipped, both records intact
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpast']?.lifecycle).toBe('visibleOpen');
    expect(reloaded.commitments['0xfuture']?.lifecycle).toBe('visibleOpen');
  });

  it('the `assessCompetitiveness` orderbook excludes the MM\'s own commitments (`c.maker === this.makerAddress` filter)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg();
    // One self-maker entry (positionType 0, the away-offer book) + one other-maker entry (positionType 1, the home-offer book).
    // The home offer (taker side `home`, the MM as maker on `away`, positionType 0) competes with positionType-0 commitments —
    // the only one (`0xself`) is filtered out → bookDepthOnSide 0. The away offer (taker side `away`, MM as maker on `home`,
    // positionType 1) competes with positionType-1 — only `0xother` (not self) → bookDepthOnSide 1.
    const book: Commitment[] = [
      orderbookEntry({ commitmentHash: '0xself', maker: DEFAULT_FAKE_MAKER_ADDRESS, positionType: 0, oddsTick: 101 }),
      orderbookEntry({ commitmentHash: '0xother', maker: '0xothermaker', positionType: 1, oddsTick: 200 }),
    ];
    const adapter = spiedAdapter(
      config, () => Promise.resolve([contestView({ contestId: 'A' })]),
      undefined, { getSpeculation: (id) => Promise.resolve(speculationView(id, true, book)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1, makerAddress: DEFAULT_FAKE_MAKER_ADDRESS as Hex }).run();

    const comps = readEvents().filter((e) => e.kind === 'quote-competitiveness');
    expect(comps).toHaveLength(2);
    const homeOffer = comps.find((e) => e.takerSide === 'home');
    expect(homeOffer).toMatchObject({ bookDepthOnSide: 0, bestBookTakerTick: null, atOrInsideBook: true });
    const awayOffer = comps.find((e) => e.takerSide === 'away');
    expect(awayOffer).toMatchObject({ bookDepthOnSide: 1, bestBookTakerTick: 200 });
  });
});

// ── review-PR23 fixes (fill-detection blockers + position-status poll) ───────

describe('Runner — fill detection — past-local-expiry classification (review-PR23 B1, B2)', () => {
  it('a visibleOpen record past local expiry whose API status is `filled` is reclassified BEFORE ageOut terminalizes it (the fill is not lost)', async () => {
    // The bug Hermes reproduced: tick order is detectFills → reconcile → ageOut, and the previous
    // detectFills skipped records past local expiry; ageOut then marked them `expired` without
    // calling getCommitment. A fill that landed right before expiry was permanently missed.
    const record = commitmentRecord({ hash: '0xrealAway', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 - 10 /* past-expiry */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrealAway': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xrealAway', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiFilled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrealAway']?.lifecycle).toBe('filled'); // detectFills classified it BEFORE ageOut got a chance to call it `expired`
    expect(reloaded.commitments['0xrealAway']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xrealAway')).toMatchObject({ partial: false, newFillWei6: '250000', source: 'commitment-diff' });
    expect(events.some((e) => e.kind === 'expire' && e.commitmentHash === '0xrealAway')).toBe(false); // ageOut's `expire` did not fire
  });

  it('a disappeared `expired` API status with prior unobserved filledRiskAmount applies the partial fill BEFORE terminalizing — the position records the matched portion', async () => {
    const record = commitmentRecord({ hash: '0xpartialThenExpired', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '0', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialThenExpired': record } });
    const config = cfg({ mode: { dryRun: false } });
    // Partial fill of 100000 wei6 landed before the commitment expired — neither was seen locally before now.
    const apiExpired: Commitment = orderbookEntry({ commitmentHash: '0xpartialThenExpired', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiExpired) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpartialThenExpired']?.lifecycle).toBe('expired'); // terminalized
    expect(reloaded.commitments['0xpartialThenExpired']?.filledRiskWei6).toBe('100000'); // the partial fill was applied
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('100000'); // position records the matched portion
    expect(reloaded.positions['spec-1234:home']?.counterpartyRiskWei6).toBe('100000'); // 100000 × (200 − 100) / 100
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xpartialThenExpired')).toMatchObject({ partial: false, newFillWei6: '100000' });
    expect(events.find((e) => e.kind === 'expire' && e.commitmentHash === '0xpartialThenExpired')).toBeDefined(); // expire still fires (the terminal status was 'expired')
  });

  it('a disappeared TRULY-cancelled (storedStatus `cancelled`) commitment with prior unobserved filledRiskAmount applies the partial fill BEFORE terminalizing', async () => {
    const record = commitmentRecord({ hash: '0xpartialThenCancelled', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', lifecycle: 'visibleOpen', filledRiskWei6: '0', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialThenCancelled': record } });
    const config = cfg({ mode: { dryRun: false } });
    const apiCancelled: Commitment = orderbookEntry({ commitmentHash: '0xpartialThenCancelled', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'cancelled', storedStatus: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiCancelled) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpartialThenCancelled']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xpartialThenCancelled']?.filledRiskWei6).toBe('100000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('100000');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.commitmentHash === '0xpartialThenCancelled')).toMatchObject({ partial: false, newFillWei6: '100000' });
    expect(events.some((e) => e.kind === 'expire' && e.commitmentHash === '0xpartialThenCancelled')).toBe(false); // cancelled is not expired
  });
});

// ── expiry-release grace margin (interleaving G — host/core-api clock can lead the chain clock) ──

describe('Runner — expiry-release grace', () => {
  it('a disappeared API `expired` status INSIDE the grace window is held (counted, not terminalized)', async () => {
    const now = T0;
    const record = commitmentRecord({ hash: '0xgrace', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: now - 30 /* 30s past expiry, inside the 60s grace */, postedAtUnixSec: now - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xgrace': record } });
    const config = cfg({ mode: { dryRun: false } }); // grace default 60
    const apiExpired: Commitment = orderbookEntry({ commitmentHash: '0xgrace', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '0', remainingRiskAmount: '250000', status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), undefined, undefined, undefined, { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiExpired) });
    await makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => now } }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xgrace']?.lifecycle).toBe('visibleOpen'); // 30s past expiry < grace 60 ⇒ may still match on chain ⇒ held + counted
    expect(readEvents().some((e) => e.kind === 'expire')).toBe(false);
  });

  it('a disappeared API `expired` status with a FULL cumulative fill becomes `filled` even inside the grace window (authoritative full fill wins)', async () => {
    const now = T0;
    const record = commitmentRecord({ hash: '0xgracefull', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: now - 30, postedAtUnixSec: now - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xgracefull': record } });
    const config = cfg({ mode: { dryRun: false } });
    // API reports effective 'expired', but the cumulative fill is FULL (== risk) — a full fill is authoritative and must become `filled`, never held as partiallyFilled.
    const apiFull: Commitment = orderbookEntry({ commitmentHash: '0xgracefull', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'expired', isLive: false });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), undefined, undefined, undefined, { listOpenCommitments: () => Promise.resolve([]), getCommitment: () => Promise.resolve(apiFull) });
    await makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => now } }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xgracefull']?.lifecycle).toBe('filled'); // full fill wins over the grace hold
    expect(reloaded.commitments['0xgracefull']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000');
    expect(readEvents().find((e) => e.kind === 'fill' && e.commitmentHash === '0xgracefull')).toMatchObject({ partial: false });
  });

  it('a thrown on-chain cancel (SDK rejects) leaves the commitment COUNTED — not authoritativelyInvalidated (fails closed)', async () => {
    // cancelMode: onchain routes a recovered soft-cancel (matched remainder) to an authoritative on-chain
    // cancel. If the SDK throws (e.g. its reconstructed-hash assertion fails), the record must stay
    // softCancelled — still counted by the risk engine — never authoritativelyInvalidated.
    const now = T0;
    const record = commitmentRecord({ hash: '0xrsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '100000', lifecycle: 'softCancelled', expiryUnixSec: now + 1000, postedAtUnixSec: now - 50 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xrsc': record } });
    const config = cfg({ mode: { dryRun: false }, orders: { cancelMode: 'onchain' } });
    const apiPartial: Commitment = orderbookEntry({ commitmentHash: '0xrsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'cancelled', storedStatus: 'partially_filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOnchain: () => Promise.reject(new Error('cancelOnchain: reconstructed hash mismatch')) },
      undefined, undefined,
      { getCommitment: (h) => (h === '0xrsc' ? Promise.resolve(apiPartial) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1, deps: { now: () => now } }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xrsc']?.lifecycle).toBe('softCancelled'); // fail closed — NOT authoritativelyInvalidated (still counted)
    expect(reloaded.commitments['0xrsc']?.filledRiskWei6).toBe('100000');
    expect(readEvents().some((e) => e.kind === 'onchain-cancel')).toBe(false); // no successful cancel
  });
});

// ── soft-cancelled-fill convergence (live only) ──────────────────────────────
//
// `reconcileSoftCancelledFills` — the tick step (after detectFills + the position poll,
// before settle/reconcile/ageOut, live mode only) that closes the split-brain where a
// commitment the MM soft-cancelled off-chain still matched on chain via its stale signed
// payload. `detectFills`'s commitment-list diff can't see soft-cancelled rows (they're
// API-hidden), so this step probes each `softCancelled` record's AUTHORITATIVE cumulative
// `filledRiskAmount` via `getCommitment(hash)` and converges the COMMITMENT record only
// (filledRiskWei6 + lifecycle) — never the position (that's `pollPositionStatus`'s job;
// touching it here would double-count). Convergence is cumulative (never additive, never
// decreasing), clamps to the commitment's risk, and derives lifecycle from the clamped
// amount (NOT from API status). Fail-closed: a `getCommitment` throw keeps the record
// softCancelled, emits `error` class SoftCancelledProbeFailed, and skips reconcile + ageOut.

describe('Runner — soft-cancelled-fill convergence', () => {
  it('a softCancelled record whose API cumulative fill is 0 → stays softCancelled, NO position mutation, no `fill` event (idempotent no-op)', async () => {
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // Never matched on chain — cumulative fill is 0. (A hidden row reports effective status 'cancelled'; the step ignores status and reads the cumulative.)
    const apiUnfilled: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '0', remainingRiskAmount: '250000', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiUnfilled) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // unchanged
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('0'); // unchanged
    expect(reloaded.commitments['0xsc']?.updatedAtUnixSec).toBe(T0 - 5); // not even touched
    expect(reloaded.positions['spec-1234:home']).toBeUndefined(); // NO position created
    expect(readEvents().some((e) => e.kind === 'fill')).toBe(false); // no fill event
  });

  it('a softCancelled record with a partial cumulative fill (0 < filled < risk) → filledRiskWei6 updated, lifecycle STAYS `softCancelled` (still book-hidden + matchable, just partially matched), market dirtied + same-tick reconcile re-prices, `fill` event {source: softcancel-recovery, partial: true}, NO position mutation', async () => {
    // Tracked market (discovery) so the convergence can dirty it and the same tick's reconcile re-prices.
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false }, odds: { subscribe: false } });
    // Cumulative on-chain fill of 200000 (< risk 500000) → stays softCancelled; the risk engine counts the 300000 remainder.
    const apiPartial: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '200000', remainingRiskAmount: '300000', status: 'cancelled', isLive: false });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]), // numeric so live submit can BigInt() it
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiPartial) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // STAYS softCancelled — a partial fill does not promote a book-hidden row into the visible set
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('200000');
    expect(reloaded.commitments['0xsc']?.updatedAtUnixSec).toBe(T0);
    expect(reloaded.positions['spec-1234:home']).toBeUndefined(); // NO position created by this path — pollPositionStatus owns positions

    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      source: 'softcancel-recovery', commitmentHash: '0xsc', speculationId: 'spec-1234', contestId: '1234',
      takerSide: 'away', makerSide: 'home', positionType: 1, makerOddsTick: 200,
      newFillWei6: '200000', filledRiskWei6: '200000', partial: true,
    });
    // The market was dirtied → the same-tick reconcile ran on it (submitted quotes); proof the dirty flag propagated.
    expect(submit.calls.length).toBeGreaterThan(0);
  });

  it('a softCancelled record whose API cumulative fill >= risk → clamp to risk, lifecycle `filled`, NO position mutation', async () => {
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // Fully matched — cumulative fill equals risk → filled.
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('filled');
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']).toBeUndefined(); // NO position created by this path
    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'softcancel-recovery', commitmentHash: '0xsc', newFillWei6: '250000', filledRiskWei6: '250000', partial: false });
    expect(readEvents().some((e) => e.kind === 'error' && e.class === 'SoftCancelledOverFillClamp')).toBe(false); // exactly-at-risk is not an over-fill
  });

  it('an API cumulative fill BELOW the local filledRiskWei6 → no decrease, idempotent no-op (never re-applies, never regresses)', async () => {
    // The record already reflects a 200000 fill (e.g. observed earlier). A stale/lower API read must not regress it.
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // API reports a LOWER cumulative (100000 < local 200000) — must be ignored.
    const apiLower: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '100000', remainingRiskAmount: '400000', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiLower) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('200000'); // unchanged — never decreased
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // unchanged
    expect(reloaded.commitments['0xsc']?.updatedAtUnixSec).toBe(T0 - 5); // not touched
    expect(readEvents().some((e) => e.kind === 'fill')).toBe(false);
  });

  it('an API cumulative fill ABOVE the commitment risk → clamp to risk + a warning telemetry (SoftCancelledOverFillClamp); lifecycle `filled`', async () => {
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // Anomalous: API cumulative (300000) exceeds the commitment's own risk (250000) — clamp to risk.
    const apiOverfill: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '300000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiOverfill) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('250000'); // CLAMPED to risk (the validator rejects filledRiskWei6 > riskAmountWei6)
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('filled');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.class === 'SoftCancelledOverFillClamp')).toMatchObject({ commitmentHash: '0xsc', phase: 'softcancel-recovery' });
    // The fill event reflects the clamped amounts, not the raw API cumulative.
    expect(events.find((e) => e.kind === 'fill')).toMatchObject({ source: 'softcancel-recovery', newFillWei6: '250000', filledRiskWei6: '250000', partial: false });
  });

  it('the visible detectFills path and the soft-cancel path see the same cumulative on the same commitment → whichever runs first applies it, the other no-ops (no double-count)', async () => {
    // A commitment that is BOTH visibleOpen-in-the-listing AND has a soft-cancelled twin would be a
    // contradiction; the real invariant is: each path converges to the same API cumulative, so re-running
    // convergence on an already-converged record is a no-op. Model it directly: a record already converged to
    // its full risk (e.g. detectFills bumped it to `filled` earlier this run), now soft-cancelled in state, and
    // the soft-cancel probe returns the SAME cumulative → second pass sees `apiFilled <= local` → no-op.
    const alreadyConverged = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '250000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': alreadyConverged } });
    const config = cfg({ mode: { dryRun: false } });
    const apiSameCumulative: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiSameCumulative) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('250000'); // still risk — not doubled to 500000
    expect(readEvents().some((e) => e.kind === 'fill')).toBe(false); // already at the cumulative → no second fill emitted
  });

  it('a `getCommitment` probe failure for a softCancelled record fails closed — the step returns false / the tick skips reconcile + ageOut, the record is PRESERVED softCancelled (not aged out, not zeroed), `error` SoftCancelledProbeFailed emitted', async () => {
    // The stale signed payload could have matched on chain at any moment; a probe failure must NOT be read as
    // "unfilled/resolved" or let ageOut terminalize the record. Past-local-expiry (so ageOut WOULD otherwise
    // expire it) makes the fail-closed bite — the record must stay softCancelled, not become `expired`.
    const stale = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 - 1, postedAtUnixSec: T0 - 100, updatedAtUnixSec: T0 - 100 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': stale } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getCommitment: () => Promise.reject(new Error('commitment API 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // PRESERVED — ageOut skipped, not terminalized to `expired`
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('0'); // not zeroed / not mutated
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.class === 'SoftCancelledProbeFailed')).toMatchObject({ commitmentHash: '0xsc', phase: 'softcancel-recovery', detail: 'commitment API 503' });
    expect(submit.calls).toHaveLength(0); // reconcile skipped — no replacement quotes on unverified exposure
    expect(events.some((e) => e.kind === 'expire')).toBe(false); // ageOut did not run
  });

  it('the soft-cancel path does NOT extend the position aggregate (decoupled from pollPositionStatus, which owns position convergence — no double-count)', async () => {
    // A softCancelled commitment that converges to `filled` here, with a pre-existing position record on the
    // same (speculationId, side). The position poll reports the SAME aggregate the position already holds (a
    // no-op for the poll); the soft-cancel step converges the commitment but must leave the position untouched.
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: { '0xsc': softCancelled },
      positions: {
        'spec-1234:home': { speculationId: 'spec-1234', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 5 },
      },
    });
    const config = cfg({ mode: { dryRun: false } });
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    // The position poll reports the position at its existing aggregate (0.25 USDC = 250000 wei6) → poll no-ops.
    const withPos: PositionStatus = {
      active: [{ positionId: '0xpos', speculationId: 'spec-1234', positionType: 1, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: 0.25, profitAmountUSDC: 0.25 }],
      pendingSettle: [], claimable: [],
      totals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPos), getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    // The position aggregate is UNCHANGED — the soft-cancel step never extended it (no 500000 double-count).
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000');
    expect(reloaded.positions['spec-1234:home']?.counterpartyRiskWei6).toBe('250000');
    // The commitment converged.
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('filled');
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('250000');
    // Exactly one fill — the soft-cancel recovery; the position-poll no-op'd (already caught up).
    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'softcancel-recovery' });
  });

  it('TWO TICKS: a softCancelled record recovered to a PARTIAL fill STAYS softCancelled on the next tick — never released to authoritativelyInvalidated, latent remainder preserved (Hermes review-2 regression)', async () => {
    // The blocker Hermes caught: tick 1 recovers the hidden soft-cancelled commitment; if recovery
    // promoted it to `partiallyFilled`, tick 2's detectFills would include it in localOpen, fail to
    // find it in the (book-filtered) listOpenCommitments, take the disappeared-hash path, read its
    // effective `cancelled` status, and wrongly release the still-matchable remainder. Keeping it
    // `softCancelled` (owned by reconcileSoftCancelledFills, never in detectFills's visible set) is
    // the invariant under test. Run two ticks against the SAME hidden partial cumulative.
    const softCancelled = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // Hidden partial cumulative, identical on both ticks: effective 'cancelled', storedStatus 'partially_filled', fill 200000 < risk 500000.
    const apiPartialHidden: Commitment = orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '500000', filledRiskAmount: '200000', remainingRiskAmount: '300000', status: 'cancelled', storedStatus: 'partially_filled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([]), getCommitment: (h) => (h === '0xsc' ? Promise.resolve(apiPartialHidden) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // after the 2nd tick — NOT authoritativelyInvalidated (the pre-fix bug)
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('200000'); // remainder (300000) still counted toward latent exposure
    // The recovery fired once (tick 1); tick 2 saw the same cumulative → no second fill, and detectFills never touched the softCancelled record.
    const fills = readEvents().filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'softcancel-recovery', filledRiskWei6: '200000', partial: true });
  });
});

describe('Runner — fail-closed on lost fill visibility (review-PR23 B3)', () => {
  it('live mode: a `listOpenCommitments` failure SKIPS reconcile (no live writes) and ageOut (no terminalization on unverified fill state); the market stays dirty for next-tick retry', async () => {
    // Without the fail-closed fix, the runner would proceed to reconcile on a tracked-quoteable market
    // with no fill visibility, submitting a fresh commitment based on stale exposure state.
    // (Numeric contestId so live `submitCommitment`'s `BigInt(contestId)` doesn't throw — the absence
    // of a submit must prove the *fail-closed gate* worked, not a downstream BigInt error.)
    const record = commitmentRecord({ hash: '0xtracked', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 1 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xtracked': record } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { listOpenCommitments: () => Promise.reject(new Error('API 503')) },
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    await runner.run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'fill-detection')).toMatchObject({ detail: 'API 503' });
    expect(submit.calls).toHaveLength(0); // reconcile was skipped — no submit despite the tracked market being quoteable
    expect(events.some((e) => e.kind === 'submit' || e.kind === 'replace' || e.kind === 'soft-cancel')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-intent')).toBe(false); // reconcileMarkets never ran
    expect(StateStore.at(stateDir).load().state.commitments['0xtracked']?.lifecycle).toBe('visibleOpen'); // ageOut didn't run either
  });

  it('dry-run mode: a `listOpenCommitments` failure is irrelevant — detectFills doesn\'t run in dry-run, so the reconcile proceeds normally', async () => {
    // Defensive: confirm the fail-closed gate is live-only — dry-run should never be blocked by it.
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg(); // dryRun:true
    const adapter = spiedAdapter(config, () => Promise.resolve([contestView({ contestId: 'A' })]));
    // listOpenCommitments isn't even spied on the read-only adapter (no live writes path); the
    // dry-run tick never calls it. We assert by exercising a full would-submit and seeing the loop run.
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'would-submit')).toHaveLength(2); // reconcile ran in dry-run despite the absence of fill detection
  });
});

describe('Runner — position-status poll (review-PR23 B4)', () => {
  /** A bare `getPositionStatus` response with one `active` position for `(speculationId, makerSide)`. */
  function withActivePosition(speculationId: string, positionType: 0 | 1, riskUSDC: number, profitUSDC: number, positionId = '0xpos'): PositionStatus {
    return {
      active: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC }],
      pendingSettle: [], claimable: [],
      totals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
  }

  it('a position the API reports but local state is missing → `MakerPositionRecord` created + `fill` event (source: position-poll). Context (contestId, sport, teams) is copied from the matching local commitment. The same soft-cancelled commitment ALSO converges via the soft-cancelled-fill step (its own `getCommitment` probe) — distinct telemetry, no double-counted position.', async () => {
    // Setup: a soft-cancelled commitment (a quote we pulled off-chain). A taker matched it via the
    // stale signed payload before expiry → the chain has a position the commitment-list diff can't see.
    // The position poll catches the POSITION; the soft-cancelled-fill step catches the COMMITMENT
    // (probing its authoritative cumulative fill via getCommitment) — the two paths are decoupled, so
    // the position is recorded exactly once (the poll) and the commitment record converges exactly once
    // (the new step) without double-counting.
    const softCancelled = commitmentRecord({ hash: '0xstaleSignedPayload', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleSignedPayload': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // The on-chain match fully filled the commitment → cumulative filledRiskAmount equals its risk.
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xstaleSignedPayload', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-1234', 1 /* home */, 0.25, 0.25)), getCommitment: (h) => (h === '0xstaleSignedPayload' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']).toMatchObject({
      speculationId: 'spec-1234', contestId: '1234', side: 'home',
      sport: softCancelled.sport, awayTeam: softCancelled.awayTeam, homeTeam: softCancelled.homeTeam, // copied from the source commitment
      riskAmountWei6: '250000', counterpartyRiskWei6: '250000', // 0.25 USDC × 1e6 — counted ONCE (the poll), not double-counted by the new step
      status: 'active',
    });
    // The commitment now converges from its authoritative cumulative fill — no longer stranded softCancelled.
    expect(reloaded.commitments['0xstaleSignedPayload']?.lifecycle).toBe('filled');
    expect(reloaded.commitments['0xstaleSignedPayload']?.filledRiskWei6).toBe('250000');
    const fills = readEvents().filter((e) => e.kind === 'fill');
    // Two fills, one per path — the position-poll (the position) and the soft-cancel recovery (the commitment).
    expect(fills.filter((e) => e.source === 'position-poll')).toHaveLength(1);
    expect(fills.find((e) => e.source === 'position-poll')).toMatchObject({ speculationId: 'spec-1234', makerSide: 'home', positionType: 1, newFillWei6: '250000', cumulativeRiskWei6: '250000' });
    expect(fills.filter((e) => e.source === 'softcancel-recovery')).toHaveLength(1);
    expect(fills.find((e) => e.source === 'softcancel-recovery')).toMatchObject({ commitmentHash: '0xstaleSignedPayload', speculationId: 'spec-1234', makerSide: 'home', positionType: 1, newFillWei6: '250000', filledRiskWei6: '250000', partial: false });
  });

  it('a `getPositionStatus` response that matches local state is a no-op (idempotent — no `fill` event, no position update on subsequent ticks)', async () => {
    // The position record already reflects the on-chain risk; subsequent polls shouldn't emit phantom fills.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xc': commitmentRecord({ hash: '0xc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, lifecycle: 'filled', riskAmountWei6: '250000', filledRiskWei6: '250000' }),
      },
      positions: {
        'spec-1234:home': { speculationId: 'spec-1234', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 5 },
      },
    });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-1234', 1, 0.25, 0.25)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'fill')).toBe(false); // already caught up
    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // unchanged
  });

  it('a position with no matching local commitment is skipped + logged (don\'t create an incomplete `MakerPositionRecord`)', async () => {
    // Setup: the API reports a position on a speculation we have NO commitment for (state pre-seeded
    // externally, or a long-running discrepancy). Refuse to create the record — the risk engine's
    // per-team/sport caps need real metadata.
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withActivePosition('spec-orphan', 0, 0.5, 0.5)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-orphan:away']).toBeUndefined();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ class: 'PositionWithoutCommitment' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a `getPositionStatus` failure with NO softCancelled records is logged (`error` phase position-poll) and the tick continues normally — reconcile still runs (detectFills already covered the maker\'s posted commitments)', async () => {
    StateStore.at(stateDir).flush(emptyMakerState());
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]), // numeric so live `submitCommitment` can BigInt() it
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getPositionStatus: () => Promise.reject(new Error('positions API 500')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ detail: 'positions API 500' });
    expect(submit.calls.length).toBeGreaterThan(0); // reconcile still ran — no softCancelled records, so the position poll failure isn't a lost-fill risk
  });

  it('a `getPositionStatus` failure WITH a non-terminal softCancelled record fails closed — reconcile + ageOut skipped, markets stay dirty for next-tick retry (review-PR23 round 2)', async () => {
    // Setup: a softCancelled commitment whose stale signed payload could have been
    // matched on chain at any point before expiry. The commitment-list diff (detectFills)
    // can't see soft-cancelled commitments — the position poll is the ONLY way to learn
    // about that match. If the poll fails, we MUST NOT (a) submit replacement quotes on
    // exposure we may already have, or (b) terminalize the record via ageOut while a
    // taker may have just filled it. Even a past-local-expiry record stays softCancelled
    // this tick — next tick retries the poll.
    const stale = commitmentRecord({ hash: '0xstaleSignedPayload', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'softCancelled', expiryUnixSec: T0 - 1, postedAtUnixSec: T0 - 100, updatedAtUnixSec: T0 - 100 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstaleSignedPayload': stale } });
    const config = cfg({ mode: { dryRun: false } });
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]),
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { getPositionStatus: () => Promise.reject(new Error('positions API 500')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ detail: 'positions API 500' });
    expect(submit.calls).toHaveLength(0); // reconcile skipped — no replacement quotes posted on unverified exposure
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xstaleSignedPayload']?.lifecycle).toBe('softCancelled'); // ageOut skipped — record NOT terminalized to `expired`
    expect(events.some((e) => e.kind === 'expire')).toBe(false);
  });
});

// ── position-status transitions (Phase 3 c-ii) ───────────────────────────────

describe('Runner — position-status transitions (Phase 3 c-ii)', () => {
  /** A `PositionStatus` with one `pendingSettle` position. The estimated payout = risk + profit (Ospex pays back the winner's risk + the counterparty's risk; this test only needs a self-consistent shape). */
  function withPendingSettlePosition(
    speculationId: string,
    positionType: 0 | 1,
    riskUSDC: number,
    profitUSDC: number,
    result: 'won' | 'push' | 'void' = 'won',
    predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push' = 'home',
    positionId = '0xpos',
  ): PositionStatus {
    const payout = riskUSDC + profitUSDC;
    const payoutWei6 = BigInt(Math.round(payout * 1_000_000)).toString();
    return {
      active: [],
      pendingSettle: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC, result, predictedWinSide, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6 }],
      claimable: [],
      totals: { activeCount: 0, pendingSettleCount: 1, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: payout, pendingSettlePayoutWei6: payoutWei6 },
    };
  }

  /** A `PositionStatus` with one `claimable` position. */
  function withClaimablePosition(
    speculationId: string,
    positionType: 0 | 1,
    riskUSDC: number,
    profitUSDC: number,
    result: 'won' | 'push' | 'void' = 'won',
    positionId = '0xpos',
  ): PositionStatus {
    const payout = riskUSDC + profitUSDC;
    const payoutWei6 = BigInt(Math.round(payout * 1_000_000)).toString();
    return {
      active: [],
      pendingSettle: [],
      claimable: [{ positionId, speculationId, positionType, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: riskUSDC, profitAmountUSDC: profitUSDC, result, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6 }],
      totals: { activeCount: 0, pendingSettleCount: 0, claimableCount: 1, estimatedPayoutUSDC: payout, estimatedPayoutWei6: payoutWei6, pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
  }

  /** Pre-seed an `active` `MakerPositionRecord` on `(speculationId, side='home')` matched to a `filled` commitment. The poll's transition path needs both to assemble context. */
  function seedActiveHomePosition(speculationId: string, contestId: string, riskWei6 = '250000', counterpartyRiskWei6 = '250000'): MakerState {
    const commitment = commitmentRecord({ hash: '0xc', speculationId, contestId, makerSide: 'home', oddsTick: 200, lifecycle: 'filled', riskAmountWei6: riskWei6, filledRiskWei6: riskWei6 });
    return {
      ...emptyMakerState(),
      commitments: { '0xc': commitment },
      positions: {
        [`${speculationId}:home`]: { speculationId, contestId, sport: commitment.sport, awayTeam: commitment.awayTeam, homeTeam: commitment.homeTeam, side: 'home', riskAmountWei6: riskWei6, counterpartyRiskWei6, status: 'active', updatedAtUnixSec: T0 - 60 },
      },
    };
  }

  it('a position the API has moved from active → pendingSettle is updated locally + emits `position-transition` (fromStatus active, toStatus pendingSettle, result, predictedWinSide)', async () => {
    StateStore.at(stateDir).flush(seedActiveHomePosition('spec-1234', '1234'));
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // risk unchanged — pure status transition
    // result is captured from the ClaimablePositionView.result on transition (PR g-iii-a) — closes the realized-P&L window-clip loophole when the position later auto-claims.
    expect(reloaded.positions['spec-1234:home']?.result).toBe('won');

    const events = readEvents();
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', positionType: 1, fromStatus: 'active', toStatus: 'pendingSettle', result: 'won', predictedWinSide: 'home' });
    expect(events.some((e) => e.kind === 'fill')).toBe(false); // status-only transition, no fill
  });

  it('a position the API has moved from pendingSettle → claimable is updated locally + emits `position-transition` (result carried, predictedWinSide omitted — claimable view does not surface it)', async () => {
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'pendingSettle';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable');
    const transitions = readEvents().filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'pendingSettle', toStatus: 'claimable', result: 'won' });
    expect(transitions[0]?.predictedWinSide).toBeUndefined(); // not on the claimable view
  });

  it('a position the API has moved from active → claimable (skipping pendingSettle within the poll window) is a single forward transition (one `position-transition` event)', async () => {
    StateStore.at(stateDir).flush(seedActiveHomePosition('spec-1234', '1234'));
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable');
    const transitions = readEvents().filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'claimable' });
  });

  it('a position first observed directly in claimable (no prior local record) is CREATED with status claimable + emits `fill` (the position\'s birth — NO `position-transition` event)', async () => {
    // The soft-cancelled-stale-payload path can land a position straight into pendingSettle/claimable
    // (the indexer is slow OR the speculation scored fast). We must record the maker's risk and at
    // the right status — but it's a birth, not a transition, so no transition event.
    const softCancelled = commitmentRecord({ hash: '0xstale', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, lifecycle: 'softCancelled', riskAmountWei6: '250000' });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xstale': softCancelled } });
    const config = cfg({ mode: { dryRun: false } });
    // The same stale-payload match the poll surfaces also converges the commitment via the
    // soft-cancelled-fill step (its own getCommitment probe → cumulative fill == risk → `filled`),
    // which emits its own `fill` (source: softcancel-recovery). This test is about the POSITION
    // birth path, so it asserts on the position-poll fill specifically (and the absence of a transition).
    const apiFilled: Commitment = orderbookEntry({ commitmentHash: '0xstale', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount: '250000', filledRiskAmount: '250000', remainingRiskAmount: '0', status: 'cancelled', isLive: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withClaimablePosition('spec-1234', 1, 0.25, 0.25, 'won')), getCommitment: (h) => (h === '0xstale' ? Promise.resolve(apiFilled) : Promise.reject(new Error('unknown hash'))) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']).toMatchObject({ status: 'claimable', riskAmountWei6: '250000', counterpartyRiskWei6: '250000' });
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'fill' && e.source === 'position-poll')).toHaveLength(1); // the position's birth — counted once
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
  });

  it('a backwards transition (API reports claimable as active) is refused + logged (`error` class BackwardsPositionTransition); the local status stays claimable', async () => {
    // This shouldn't happen in production — a settled speculation can't un-settle, claimed positions
    // disappear from the API. It signals state corruption (manual edit, version skew). The runner
    // refuses to revert the local record to a less-advanced status.
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'claimable';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const apiActive: PositionStatus = {
      active: [{ positionId: '0xpos', speculationId: 'spec-1234', positionType: 1, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: 0.25, profitAmountUSDC: 0.25 }],
      pendingSettle: [], claimable: [],
      totals: { activeCount: 1, pendingSettleCount: 0, claimableCount: 0, estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(apiActive) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('claimable'); // unchanged
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'position-poll')).toMatchObject({ class: 'BackwardsPositionTransition' });
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
  });

  it('a poll that matches local status + risk is a no-op across two ticks (idempotent — no `position-transition`, no `fill`)', async () => {
    const state = seedActiveHomePosition('spec-1234', '1234');
    state.positions['spec-1234:home']!.status = 'pendingSettle';
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(StateStore.at(stateDir).load().state.positions['spec-1234:home']?.status).toBe('pendingSettle');
    const events = readEvents();
    expect(events.some((e) => e.kind === 'position-transition')).toBe(false);
    expect(events.some((e) => e.kind === 'fill')).toBe(false);
  });

  it('a poll carrying BOTH a risk delta AND a forward status transition emits both `fill` and `position-transition`', async () => {
    // E.g. the speculation just scored AND the indexer just caught up on a prior fill the maker
    // missed — first poll observes the position with more risk AND in a non-`active` bucket.
    const state = seedActiveHomePosition('spec-1234', '1234', '100000', '100000'); // local: 0.10 USDC
    StateStore.at(stateDir).flush(state);
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) }, // API: 0.25 USDC risk, pendingSettle
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    expect(reloaded.positions['spec-1234:home']?.riskAmountWei6).toBe('250000'); // 0.10 + 0.15 delta

    const events = readEvents();
    const fills = events.filter((e) => e.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: 'position-poll', newFillWei6: '150000', cumulativeRiskWei6: '250000' });
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'pendingSettle' });
  });

  it('an existing position whose source commitment was pruned (long-running game) still transitions — context comes from the position record\'s own denormalized fields (Hermes review-PR24)', async () => {
    // The realistic case: maker fills a commitment at T=0; the commitment becomes `filled`;
    // `pruneTerminalCommitments` deletes the filled record after ~1h; the game scores T+hours
    // later and the API moves the position from `active` to `pendingSettle`. Requiring a
    // still-retained source commitment would strand the position in stale `active` status.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      // No commitments — the source commitment was pruned post-fill.
      positions: {
        'spec-1234:home': { speculationId: 'spec-1234', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 7200 },
      },
    });
    const config = cfg({ mode: { dryRun: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { getPositionStatus: () => Promise.resolve(withPendingSettlePosition('spec-1234', 1, 0.25, 0.25, 'won', 'home')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['spec-1234:home']?.status).toBe('pendingSettle');
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error' && e.class === 'PositionWithoutCommitment')).toBe(false); // no false alarm
    const transitions = events.filter((e) => e.kind === 'position-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: 'active', toStatus: 'pendingSettle', contestId: '1234', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD' }); // context from the existing record
  });
});

// ── boot-time auto-approve (Phase 3 d-i) ─────────────────────────────────────

describe('Runner — boot-time auto-approve (Phase 3 d-i)', () => {
  /** A successful `approveUSDC` stub with a recorder. The receipt's gas fields are real bigints so the `gasPolWei` derivation runs through. */
  function approveRecorder(): { fn: (amount: ApproveUSDCAmount) => Promise<ApproveResult>; calls: ApproveUSDCAmount[] } {
    const calls: ApproveUSDCAmount[] = [];
    return {
      calls,
      fn: (amount) => {
        calls.push(amount);
        // `viem`'s `TransactionReceipt` is wider than we touch — cast to the few fields `applyAutoApprovals` reads.
        const receipt = { gasUsed: 50_000n, effectiveGasPrice: 30_000_000_000n } as unknown as ApproveResult['receipt'];
        const onChainAmount = amount === 'max' ? 2n ** 256n - 1n : amount;
        return Promise.resolve({ txHash: '0xtx', receipt, spender: '0xPositionModule' as Hex, token: '0xusdc' as Hex, amount: onChainAmount });
      },
    };
  }

  it('dry-run skips the auto-approve flow entirely — no readApprovals call, no approveUSDC call, no `approval` event', async () => {
    const readApprovals = vi.fn(() => Promise.resolve(approvalsSnapshotWith(0n)));
    const approve = approveRecorder();
    // Dry-run uses the dry-run adapter (`makeRunner` default) — readApprovals isn't even on it. Just assert the events.
    await makeRunner({ config: cfg({ mode: { dryRun: true }, approvals: { autoApprove: true, mode: 'exact' } }), maxTicks: 1 }).run();
    expect(readApprovals).not.toHaveBeenCalled();
    expect(approve.calls).toHaveLength(0);
    expect(readEvents().some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + approvals.autoApprove=false skips the flow — no readApprovals call, no approveUSDC call, no `approval` event', async () => {
    const readApprovals = vi.fn(() => Promise.resolve(approvalsSnapshotWith(0n)));
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: false, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readApprovals).not.toHaveBeenCalled();
    expect(approve.calls).toHaveLength(0);
    expect(readEvents().some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + autoApprove=true + current allowance already meets the required ceiling → silent no-op (readApprovals called, no approveUSDC, no `approval` event)', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    // Default `liveSpiedAdapter.readApprovals` returns a saturated allowance (`2^255`) — well above any required ceiling.
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { approveUSDC: approve.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toHaveLength(0);
    expect(readEvents().some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + autoApprove=true + mode=exact + zero current allowance → approveUSDC(requiredWei6) + `approval` event with the wei6 ceiling, tx hash, and gasPolWei', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(1);
    expect(typeof approve.calls[0]).toBe('bigint'); // not 'max' — `mode:exact` sends a precise wei6 ceiling
    const approval = readEvents().find((e) => e.kind === 'approval');
    expect(approval).toMatchObject({
      purpose: 'positionModule', spender: '0xPositionModule', currentAllowance: '0', txHash: '0xtx',
      gasPolWei: (50_000n * 30_000_000_000n).toString(), // gasUsed * effectiveGasPrice
    });
    expect(typeof approval?.requiredAggregateAllowance).toBe('string');
    expect(BigInt(approval?.requiredAggregateAllowance as string) > 0n).toBe(true);
    expect(approval?.amountSetTo).toBe(approval?.requiredAggregateAllowance); // SDK echoes back what was set in exact mode
  });

  it('live + autoApprove=true + mode=exact + partial current allowance (< required) → approveUSDC(requiredWei6) — `approve(x)` SETS, doesn\'t add', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(1_000_000n)) }, // 1 USDC — almost certainly below the cap-ceiling
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toHaveLength(1);
    expect(typeof approve.calls[0]).toBe('bigint');
    expect(approve.calls[0]).not.toBe(1_000_000n); // does NOT match the current allowance — sends the full required ceiling
  });

  it('live + autoApprove=true + mode=unlimited → approveUSDC(\'max\') + `approval` event with amountSetTo = MaxUint256', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'unlimited' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toEqual(['max']);
    const approval = readEvents().find((e) => e.kind === 'approval');
    expect(approval?.amountSetTo).toBe((2n ** 256n - 1n).toString());
  });

  it('readApprovals throws → `error` event phase \'approve\' is logged, the tick continues, no approveUSDC call', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.reject(new Error('rpc 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toHaveLength(0);
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'approve')).toMatchObject({ detail: 'rpc 503' });
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(1); // tick still ran
    expect(events.some((e) => e.kind === 'approval')).toBe(false);
  });

  it('approveUSDC throws → `error` event phase \'approve\' is logged, the tick continues, no `approval` event', async () => {
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: () => Promise.reject(new Error('insufficient POL')) },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'approve')).toMatchObject({ detail: 'insufficient POL' });
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + autoApprove=true + boot-time state-loss hold ACTIVE → auto-approve is deferred (no readApprovals, no approveUSDC) — raising the allowance would risk re-activating latent soft-cancelled commitments (Hermes review-PR25 §1)', async () => {
    // Seed prior telemetry but no state file → constructor's boot fail-safe holds quoting.
    writeFileSync(join(logDir, 'run-prior.ndjson'), '{"ts":"x","runId":"prior","kind":"tick-start","tick":1}\n', 'utf8');
    const readApprovals = vi.fn(() => Promise.resolve(approvalsSnapshotWith(0n)));
    const readBalances = vi.fn(() => Promise.resolve({ owner: '0xowner' as Hex, chainId: 137, native: 10n ** 18n, usdc: 2n ** 255n, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex }));
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals, readBalances },
    );
    const runner = makeRunner({ config, adapter, maxTicks: 1 });
    expect(runner.isHoldingQuoting()).toBe(true);
    await runner.run();
    expect(readApprovals).not.toHaveBeenCalled();
    expect(readBalances).not.toHaveBeenCalled();
    expect(approve.calls).toHaveLength(0);
    expect(readEvents().some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + autoApprove=true + mode=exact + wallet USDC < required ceiling → approveUSDC called with the wallet balance (wallet-bounded target per DESIGN §6); `approval` event carries walletBalanceWei6 (Hermes review-PR25 §2)', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      {
        readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)),
        // Underfund the wallet: 1 USDC vs whatever the default risk-cap ceiling computes to (much larger).
        readBalances: (owner: Hex) => Promise.resolve({ owner, chainId: 137, native: 10n ** 18n, usdc: 1_000_000n, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex }),
      },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(1);
    expect(approve.calls[0]).toBe(1_000_000n); // target = min(ceiling, walletBalance) — bounded by the wallet
    const approval = readEvents().find((e) => e.kind === 'approval');
    expect(approval).toMatchObject({
      currentAllowance: '0',
      walletBalanceWei6: '1000000',
      amountSetTo: '1000000', // SDK echoes back what we sent
    });
    // requiredAggregateAllowance is the aspirational ceiling (uncapped), > the wallet bound:
    expect(BigInt(approval?.requiredAggregateAllowance as string) > 1_000_000n).toBe(true);
  });

  it('live + autoApprove=true + mode=exact + readBalances throws → fail closed (no approveUSDC, `error` phase \'approve\') — wallet bound is part of the safety contract (Hermes review-PR25 §2)', async () => {
    const approve = approveRecorder();
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      {
        readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)),
        readBalances: () => Promise.reject(new Error('rpc 503')),
      },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toHaveLength(0);
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'approve')).toMatchObject({ detail: 'rpc 503' });
    expect(events.some((e) => e.kind === 'approval')).toBe(false);
  });

  it('live + autoApprove=true + mode=unlimited → skips the wallet-balance read (operator confirmed via --yes) — approveUSDC(\'max\') still fires, `approval` event has NO walletBalanceWei6 field', async () => {
    const approve = approveRecorder();
    const readBalances = vi.fn(); // never called
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'unlimited' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)), readBalances },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(approve.calls).toEqual(['max']);
    expect(readBalances).not.toHaveBeenCalled();
    const approval = readEvents().find((e) => e.kind === 'approval');
    expect(approval?.walletBalanceWei6).toBeUndefined();
  });
});

// ── gas-budget verdict (Phase 3 d-ii) ────────────────────────────────────────

describe('Runner — gas-budget verdict gate (Phase 3 d-ii)', () => {
  /** A successful `approveUSDC` stub whose receipt produces a known `gasPolWei`. */
  function approveRecorderWithReceipt(gasUsed: bigint, effectiveGasPrice: bigint): { fn: (amount: ApproveUSDCAmount) => Promise<ApproveResult>; calls: ApproveUSDCAmount[] } {
    const calls: ApproveUSDCAmount[] = [];
    return {
      calls,
      fn: (amount) => {
        calls.push(amount);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as ApproveResult['receipt'];
        const onChainAmount = amount === 'max' ? 2n ** 256n - 1n : amount;
        return Promise.resolve({ txHash: '0xtx', receipt, spender: '0xPositionModule' as Hex, token: '0xusdc' as Hex, amount: onChainAmount });
      },
    };
  }

  /** Today's UTC `YYYY-MM-DD` for the test fixture's pinned clock (`noopDeps.now() === T0`) — same derivation as the runner's internal `todayUTCDateString`. */
  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  it('budget already exhausted (today\'s gasPolWei + reserve >= maxDailyGasPOL) → skip the approve, emit `candidate` `gas-budget-blocks-reapproval`, no on-chain write', async () => {
    const today = todayUTC();
    // Pre-seed today's counter at 0.9 POL of a 1 POL cap with 0.2 POL reserve → 0.9 + 0.2 = 1.1 > 1.0 → DENIED.
    const POL = 10n ** 18n;
    StateStore.at(stateDir).flush({ ...emptyMakerState(), dailyCounters: { [today]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } } });
    const approve = approveRecorderWithReceipt(50_000n, 30_000_000_000n);
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) }, // would need an approve if budget allowed
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(0); // gate fired BEFORE the write
    const candidate = readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-reapproval');
    expect(candidate).toMatchObject({ purpose: 'positionModule-approve' });
    expect(typeof candidate?.detail).toBe('string');
    expect(readEvents().some((e) => e.kind === 'approval')).toBe(false);
    // Counter unchanged — no spend.
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.dailyCounters[today]?.gasPolWei).toBe(((POL * 9n) / 10n).toString());
  });

  it('budget OK + auto-approve succeeds → state.dailyCounters[today].gasPolWei accumulates the approve\'s gas cost', async () => {
    const approve = approveRecorderWithReceipt(50_000n, 30_000_000_000n); // 50k × 30 gwei = 1.5e15 wei = 0.0015 POL
    const expectedGasCost = 50_000n * 30_000_000_000n;
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(1);
    const today = todayUTC();
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.dailyCounters[today]?.gasPolWei).toBe(expectedGasCost.toString());
    expect(reloaded.dailyCounters[today]?.feeUsdcWei6).toBe('0'); // not touched
  });

  it('budget OK + prior gas spent today + auto-approve succeeds → today\'s counter is prior + this approve\'s cost (additive, not replacing)', async () => {
    const today = todayUTC();
    const prior = 1_000_000_000_000_000n; // 0.001 POL prior spend
    StateStore.at(stateDir).flush({ ...emptyMakerState(), dailyCounters: { [today]: { gasPolWei: prior.toString(), feeUsdcWei6: '5000000' } } });
    const approve = approveRecorderWithReceipt(50_000n, 30_000_000_000n);
    const expectedGasCost = 50_000n * 30_000_000_000n;
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(1);
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.dailyCounters[today]?.gasPolWei).toBe((prior + expectedGasCost).toString());
    expect(reloaded.dailyCounters[today]?.feeUsdcWei6).toBe('5000000'); // preserved
  });

  it('an operator misconfig (reserve >= cap) is caught by the verdict → skip the approve + emit `candidate` `gas-budget-blocks-reapproval`', async () => {
    const approve = approveRecorderWithReceipt(50_000n, 30_000_000_000n);
    const config = cfg({ mode: { dryRun: false }, approvals: { autoApprove: true, mode: 'exact' }, gas: { maxDailyGasPOL: 0.2, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { approveUSDC: approve.fn },
      undefined, undefined,
      { readApprovals: () => Promise.resolve(approvalsSnapshotWith(0n)) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(approve.calls).toHaveLength(0);
    const candidate = readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-reapproval');
    expect(candidate).toBeDefined();
    expect(candidate?.detail).toMatch(/no spendable headroom/);
  });
});

// ── auto-settle + auto-claim (Phase 3 e-i) ───────────────────────────────────

describe('Runner — auto-settle + auto-claim (Phase 3 e-i)', () => {
  /** A stub `settleSpeculation` that records each call. The receipt's `gasUsed × effectiveGasPrice` produces a known `gasPolWei`. */
  // Records each settle call and returns a `settled` outcome (a real tx was
  // sent). The runner reaches this via `ensureSpeculationSettled`; a receipt
  // present ⇒ the runner debits gas + emits `settle`.
  function settleRecorder(gasUsed = 80_000n, effectiveGasPrice = 30_000_000_000n, winSide: EnsureSpeculationSettledResult['winSide'] = 'home'): { fn: OspexAdapter['ensureSpeculationSettled']; calls: bigint[]; gasPolWeiPerCall: bigint } {
    const calls: bigint[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      fn: (args) => {
        calls.push(args.speculationId);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as NonNullable<EnsureSpeculationSettledResult['receipt']>;
        return Promise.resolve({ speculationId: args.speculationId, outcome: 'settled', txHash: '0xsettletx', blockNumber: 1n, winSide, receipt });
      },
    };
  }

  /** A stub `claimPosition` that records each call + a payout. */
  function claimRecorder(gasUsed = 70_000n, effectiveGasPrice = 30_000_000_000n, payoutWei6 = 500_000n): { fn: OspexAdapter['claimPosition']; calls: { speculationId: bigint; positionType: 0 | 1 }[]; gasPolWeiPerCall: bigint } {
    const calls: { speculationId: bigint; positionType: 0 | 1 }[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      fn: (args) => {
        calls.push({ speculationId: args.speculationId, positionType: args.positionType });
        const receipt = { gasUsed, effectiveGasPrice } as unknown as ClaimPositionResult['receipt'];
        return Promise.resolve({ txHash: '0xclaimtx' as Hex, blockNumber: 1n, payoutWei6, payoutUSDC: Number(payoutWei6) / 1_000_000, receipt });
      },
    };
  }

  /** A stub `ensurePositionClaimed` that records each call + returns a fresh `claimed` outcome (txHash + receipt + event-sourced payout) — the idempotent-claim analog of `claimRecorder`. */
  function ensureClaimRecorder(gasUsed = 70_000n, effectiveGasPrice = 30_000_000_000n, payoutWei6 = 500_000n): { fn: OspexAdapter['ensurePositionClaimed']; calls: { speculationId: bigint; positionType: 0 | 1 }[]; gasPolWeiPerCall: bigint } {
    const calls: { speculationId: bigint; positionType: 0 | 1 }[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      fn: (args) => {
        calls.push({ speculationId: args.speculationId, positionType: args.positionType });
        const receipt = { gasUsed, effectiveGasPrice } as unknown as NonNullable<EnsurePositionClaimedResult['receipt']>;
        return Promise.resolve({ speculationId: args.speculationId, positionType: args.positionType, outcome: 'claimed' as const, txHash: '0xclaimtx' as Hex, blockNumber: 1n, payoutWei6, payoutUSDC: Number(payoutWei6) / 1_000_000, receipt });
      },
    };
  }

  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** A `pendingSettle` position record on `(speculationId, makerSide)`. The position-poll's `reducePolledPositionObservation` puts records here when the API reports them in the `pendingSettle` bucket. */
  function pendingSettleRecord(speculationId: string, contestId: string, side: MakerSide = 'home'): MakerState['positions'][string] {
    return { speculationId, contestId, sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side, riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'pendingSettle', updatedAtUnixSec: T0 - 60 };
  }

  function claimableRecord(speculationId: string, contestId: string, side: MakerSide = 'home'): MakerState['positions'][string] {
    return { speculationId, contestId, sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side, riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'claimable', updatedAtUnixSec: T0 - 60 };
  }

  it('autoSettleOwn=false and autoClaimOwn=false → no settle / claim calls, no telemetry (operator opted out)', async () => {
    const settle = settleRecorder();
    const claim = ensureClaimRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: { '1234:home': pendingSettleRecord('1234', '1234'), '5678:home': claimableRecord('5678', '5678') },
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(settle.calls).toHaveLength(0);
    expect(claim.calls).toHaveLength(0);
    const events = readEvents();
    expect(events.some((e) => e.kind === 'settle' || e.kind === 'claim')).toBe(false);
  });

  it('autoSettleOwn=true + a pendingSettle position → `settleSpeculation` is called with BigInt(speculationId); `settle` event carries winSide / txHash / gasPolWei; gas accumulates into today\'s counter', async () => {
    const settle = settleRecorder(80_000n, 30_000_000_000n, 'home');
    const claim = ensureClaimRecorder();
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '1234:home': pendingSettleRecord('1234', '1234') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(settle.calls).toEqual([1234n]); // BigInt converted from string speculationId
    expect(claim.calls).toHaveLength(0);
    const event = readEvents().find((e) => e.kind === 'settle');
    expect(event).toMatchObject({ speculationId: '1234', contestId: '1234', makerSide: 'home', winSide: 'home', txHash: '0xsettletx', gasPolWei: settle.gasPolWeiPerCall.toString() });
    // Status is NOT flipped — that's the position poll's job on the next tick.
    expect(StateStore.at(stateDir).load().state.positions['1234:home']?.status).toBe('pendingSettle');
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei).toBe(settle.gasPolWeiPerCall.toString());
  });

  it('autoClaimOwn=true + a claimable position → `claimPosition` is called with positionType (home=1) + BigInt(speculationId); `claim` event carries payoutWei6 / txHash / gasPolWei; local status is stamped `claimed`; gas accumulates', async () => {
    const settle = settleRecorder();
    const claim = ensureClaimRecorder(70_000n, 30_000_000_000n, 500_000n);
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '5678:home': claimableRecord('5678', '5678', 'home') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(settle.calls).toHaveLength(0);
    expect(claim.calls).toEqual([{ speculationId: 5678n, positionType: 1 }]); // home → 1
    const event = readEvents().find((e) => e.kind === 'claim');
    expect(event).toMatchObject({ speculationId: '5678', contestId: '5678', makerSide: 'home', positionType: 1, payoutWei6: '500000', txHash: '0xclaimtx', gasPolWei: claim.gasPolWeiPerCall.toString() });
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['5678:home']?.status).toBe('claimed'); // stamped locally
    expect(reloaded.dailyCounters[todayUTC()]?.gasPolWei).toBe(claim.gasPolWeiPerCall.toString());
  });

  it('positionType derivation: away-side claimable record → claimPosition called with positionType: 0', async () => {
    const claim = ensureClaimRecorder();
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '9:away': claimableRecord('9', '9', 'away') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(claim.calls).toEqual([{ speculationId: 9n, positionType: 0 }]); // away → 0
  });

  // ── claim.result enrichment (Phase 3 g-iii-a) ───────────────────────────

  it('claim event carries `result` from the position record (the outcome the position-poll observed) — closes Hermes review-PR33\'s realized-P&L window-clip loophole', async () => {
    const claim = ensureClaimRecorder(70_000n, 30_000_000_000n, 500_000n); // payout=500_000 (the stake — push refund)
    // Pre-seed the position with result:'push' as if the position-poll had
    // already captured it on the API's ClaimablePositionView.result.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: {
        '5678:home': { ...claimableRecord('5678', '5678', 'home'), result: 'push' },
      },
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const event = readEvents().find((e) => e.kind === 'claim');
    expect(event).toMatchObject({ speculationId: '5678', makerSide: 'home', result: 'push' });
  });

  it('claim event omits `result` when the position record\'s result is unset (older state or never-set) — backwards-compatible with logs from before (g-iii-a)', async () => {
    const claim = ensureClaimRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: { '5678:home': claimableRecord('5678', '5678', 'home') }, // no result field
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const event = readEvents().find((e) => e.kind === 'claim');
    expect(event).toBeDefined();
    expect((event as { result?: string }).result).toBeUndefined();
  });

  it('upgrade path: a pre-(g-iii-a) claimable record (status:claimable, result:undefined) gets `result` stamped when a fresh position-poll carries it, even though risk + status are unchanged — then auto-claim emits claim.result (Hermes review-PR34 blocker)', async () => {
    // Reproduces Hermes' upgrade-path repro: persisted state has a claimable
    // record from before this PR (no result field); the position-poll observes
    // it again with API result:'push'. The early-return gate must NOT short-
    // circuit on `!riskGrew && !statusChanged` alone — a result delta is also a
    // state change. Without the fix the runner returns early, never stamps
    // result, and auto-claim emits claim WITHOUT result.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: { '5678:home': claimableRecord('5678', '5678', 'home') }, // result: undefined
    });
    const claim = ensureClaimRecorder(70_000n, 30_000_000_000n, 250_000n); // payout=stake (refund)
    // The API poll returns the same claimable bucket + risk, plus result:'push'.
    // The view shape matches `ClaimablePositionView`: positionType 1 = home.
    const pollResponse: PositionStatus = {
      active: [],
      pendingSettle: [],
      claimable: [{ positionId: '0xp', speculationId: '5678', positionType: 1, team: 'X', opponent: 'Y', market: 'moneyline', oddsDecimal: null, riskAmountUSDC: 0.25, profitAmountUSDC: 0.25, result: 'push', estimatedPayoutUSDC: 0.25, estimatedPayoutWei6: '250000' }],
      totals: { activeCount: 0, pendingSettleCount: 0, claimableCount: 1, estimatedPayoutUSDC: 0.25, estimatedPayoutWei6: '250000', pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0' },
    };
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: claim.fn },
      undefined, undefined,
      { getPositionStatus: () => Promise.resolve(pollResponse) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    // The position record now has the API's result stamped.
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['5678:home']?.result).toBe('push');
    // And the auto-claim emit carries it, closing the realized-P&L loophole.
    const event = readEvents().find((e) => e.kind === 'claim');
    expect(event).toMatchObject({ speculationId: '5678', makerSide: 'home', result: 'push' });
  });

  it('budget already exhausted (no reserve allowance) + continueOnGasBudgetExhausted=false → settle is denied with `candidate` `gas-budget-blocks-settlement` `purpose: settleSpeculation`; no on-chain write', async () => {
    const POL = 10n ** 18n;
    const settle = settleRecorder();
    // Pre-seed today's counter at 0.9 POL of a 1 POL cap with 0.2 POL reserve → mayUseReserve=false denies (0.9 + 0.2 >= 1.0).
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: { '1234:home': pendingSettleRecord('1234', '1234') },
      dailyCounters: { [todayUTC()]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } },
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: true, continueOnGasBudgetExhausted: false }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, claimPosition: claimRecorder().fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(settle.calls).toHaveLength(0);
    const candidate = readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-settlement');
    expect(candidate).toMatchObject({ purpose: 'settleSpeculation', speculationId: '1234', mayUseReserve: false });
  });

  it('budget exhausted into the reserve + continueOnGasBudgetExhausted=true → settle proceeds (mayUseReserve unlocks the reserve)', async () => {
    const POL = 10n ** 18n;
    const settle = settleRecorder(80_000n, 30_000_000_000n);
    // Pre-seed at 0.9 POL — normal mode would deny, mayUseReserve mode allows (still 0.1 POL to the cap).
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: { '1234:home': pendingSettleRecord('1234', '1234') },
      dailyCounters: { [todayUTC()]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } },
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: true }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, claimPosition: claimRecorder().fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(settle.calls).toEqual([1234n]); // ran despite normal-mode budget exhaustion
    expect(readEvents().some((e) => e.kind === 'settle')).toBe(true);
  });

  it('ensureSpeculationSettled throws on a genuine failure (e.g. contest not yet scored) → `error` `phase: \'settle\'` is logged, tick continues; the local record stays `pendingSettle` for the next poll to reconcile', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '1234:home': pendingSettleRecord('1234', '1234') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: () => Promise.reject(new Error('contest not yet scored')), claimPosition: claimRecorder().fn },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'settle')).toMatchObject({ speculationId: '1234', detail: 'contest not yet scored' });
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(1); // tick continued
    expect(StateStore.at(stateDir).load().state.positions['1234:home']?.status).toBe('pendingSettle'); // unchanged
    // A genuine failure must NOT be downgraded to a settle-skip.
    expect(events.some((e) => e.kind === 'candidate' && e.skipReason === 'already-settled')).toBe(false);
  });

  it('ensureSpeculationSettled reports `alreadySettled` (no tx) → `candidate` `already-settled` (NOT an error); no gas debited; record stays `pendingSettle` for the poll to flip', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '1234:home': pendingSettleRecord('1234', '1234') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: (args) => Promise.resolve({ speculationId: args.speculationId, outcome: 'alreadySettled', winSide: 'home' }), claimPosition: claimRecorder().fn },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.some((e) => e.kind === 'settle')).toBe(false);
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'already-settled')).toMatchObject({
      purpose: 'settleSpeculation', speculationId: '1234', outcome: 'alreadySettled', winSide: 'home',
    });
    // No receipt ⇒ no gas debited.
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei ?? '0').toBe('0');
    expect(StateStore.at(stateDir).load().state.positions['1234:home']?.status).toBe('pendingSettle'); // unchanged — the poll flips it
  });

  it('ensureSpeculationSettled `recovered` with a reverted tx of ours → `candidate` `already-settled` carrying revertedTxHash; the reverted POL gas IS debited + reported (no error, no settle)', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '1234:home': pendingSettleRecord('1234', '1234') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const revertedGasPolWei = 60_000n * 30_000_000_000n;
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      {
        ensureSpeculationSettled: (args) =>
          Promise.resolve({
            speculationId: args.speculationId,
            outcome: 'recovered',
            winSide: 'away',
            revertedTxHash: '0xlostrace' as Hex,
            revertedReceipt: { gasUsed: 60_000n, effectiveGasPrice: 30_000_000_000n } as unknown as NonNullable<
              EnsureSpeculationSettledResult['revertedReceipt']
            >,
          }),
        claimPosition: claimRecorder().fn,
      },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.some((e) => e.kind === 'settle')).toBe(false);
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'already-settled')).toMatchObject({
      purpose: 'settleSpeculation', speculationId: '1234', outcome: 'recovered', winSide: 'away',
      revertedTxHash: '0xlostrace', gasPolWei: revertedGasPolWei.toString(),
    });
    // The reverted settle spent POL — it MUST hit the daily gas counter.
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei).toBe(revertedGasPolWei.toString());
  });

  it('recovered with revertedTxHash but no revertedReceipt (SDK receipt re-fetch failed) → flags `gasAccountingGap`, does not silently report zero gas', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '1234:home': pendingSettleRecord('1234', '1234') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: false, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: (args) => Promise.resolve({ speculationId: args.speculationId, outcome: 'recovered', winSide: 'away', revertedTxHash: '0xlostrace' as Hex }), claimPosition: claimRecorder().fn },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const skip = readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'already-settled');
    expect(skip).toMatchObject({ outcome: 'recovered', revertedTxHash: '0xlostrace', gasAccountingGap: true });
    expect(skip).not.toHaveProperty('gasPolWei'); // gas was spent but unknown — not faked as a number
    // Nothing billed (the gap flag is the honest signal that budget state isn't exact).
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei ?? '0').toBe('0');
  });

  it('ensurePositionClaimed throws on a GENUINE failure (e.g. NotSettled) → `error` `phase: \'claim\'` is logged, tick continues; the local record stays `claimable` (NOT stamped claimed); not downgraded to a claim-skip', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '9:home': claimableRecord('9', '9') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: () => Promise.reject(new Error('position requires settlement first')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'claim')).toMatchObject({ speculationId: '9', detail: 'position requires settlement first' });
    expect(events.filter((e) => e.kind === 'tick-start')).toHaveLength(1); // tick continued
    expect(StateStore.at(stateDir).load().state.positions['9:home']?.status).toBe('claimable'); // unchanged — a genuine failure does NOT stamp claimed
    // A genuine failure must NOT be downgraded to a claim-skip.
    expect(events.some((e) => e.kind === 'candidate' && e.skipReason === 'already-claimed')).toBe(false);
  });

  it('ensurePositionClaimed reports `alreadyClaimed` (claimed by a prior run / another script) → `candidate` `already-claimed` (NOT an error, NOT a `claim` event); no payout, no gas; record stamped `claimed` so the per-tick loop stops retrying', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '9:home': claimableRecord('9', '9') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: (args) => Promise.resolve({ speculationId: args.speculationId, positionType: args.positionType, outcome: 'alreadyClaimed' }) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.some((e) => e.kind === 'claim')).toBe(false); // never fake a claim event
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'already-claimed')).toMatchObject({
      purpose: 'claimPosition', speculationId: '9', makerSide: 'home', outcome: 'alreadyClaimed',
    });
    // No receipt ⇒ no gas debited; record stamped claimed (stops the per-tick retry).
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei ?? '0').toBe('0');
    expect(StateStore.at(stateDir).load().state.positions['9:home']?.status).toBe('claimed');
  });

  it('ensurePositionClaimed `recovered` with a reverted claim of ours → `candidate` `already-claimed` carrying revertedTxHash; the reverted POL gas IS debited; record stamped `claimed`; no claim event', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '9:home': claimableRecord('9', '9') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const revertedGasPolWei = 60_000n * 30_000_000_000n;
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      {
        ensureSpeculationSettled: settleRecorder().fn,
        ensurePositionClaimed: (args) =>
          Promise.resolve({
            speculationId: args.speculationId,
            positionType: args.positionType,
            outcome: 'recovered',
            revertedTxHash: '0xlostclaim' as Hex,
            revertedReceipt: { gasUsed: 60_000n, effectiveGasPrice: 30_000_000_000n } as unknown as NonNullable<
              EnsurePositionClaimedResult['revertedReceipt']
            >,
          }),
      },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.some((e) => e.kind === 'claim')).toBe(false);
    expect(events.find((e) => e.kind === 'candidate' && e.skipReason === 'already-claimed')).toMatchObject({
      purpose: 'claimPosition', speculationId: '9', outcome: 'recovered', revertedTxHash: '0xlostclaim', gasPolWei: revertedGasPolWei.toString(),
    });
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei).toBe(revertedGasPolWei.toString());
    expect(StateStore.at(stateDir).load().state.positions['9:home']?.status).toBe('claimed');
  });

  it('claim `recovered` with revertedTxHash but no revertedReceipt (SDK receipt re-fetch failed) → flags `gasAccountingGap`, does not silently report zero gas; still stamps claimed', async () => {
    StateStore.at(stateDir).flush({ ...emptyMakerState(), positions: { '9:home': claimableRecord('9', '9') } });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: false, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      { ensureSpeculationSettled: settleRecorder().fn, ensurePositionClaimed: (args) => Promise.resolve({ speculationId: args.speculationId, positionType: args.positionType, outcome: 'recovered', revertedTxHash: '0xlostclaim' as Hex }) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const skip = readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'already-claimed');
    expect(skip).toMatchObject({ outcome: 'recovered', revertedTxHash: '0xlostclaim', gasAccountingGap: true });
    expect(skip).not.toHaveProperty('gasPolWei'); // gas spent but unknown — not faked as a number
    expect(StateStore.at(stateDir).load().state.dailyCounters[todayUTC()]?.gasPolWei ?? '0').toBe('0');
    expect(StateStore.at(stateDir).load().state.positions['9:home']?.status).toBe('claimed'); // goal achieved even though gas can't be billed exactly
  });

  it('mixed batch: pendingSettle + claimable + active records → only the pendingSettle is settled and only the claimable is claimed; `active` is left alone', async () => {
    const settle = settleRecorder();
    const claim = ensureClaimRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      positions: {
        '1:home': pendingSettleRecord('1', '1'),
        '2:home': claimableRecord('2', '2'),
        '3:home': { speculationId: '3', contestId: '3', sport: 'mlb', awayTeam: 'NYM', homeTeam: 'LAD', side: 'home', riskAmountWei6: '250000', counterpartyRiskWei6: '250000', status: 'active', updatedAtUnixSec: T0 - 60 },
      },
    });
    const config = cfg({ mode: { dryRun: false }, settlement: { autoSettleOwn: true, autoClaimOwn: true, continueOnGasBudgetExhausted: false } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { ensureSpeculationSettled: settle.fn, ensurePositionClaimed: claim.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(settle.calls).toEqual([1n]);
    expect(claim.calls.map((c) => c.speculationId)).toEqual([2n]);
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.positions['3:home']?.status).toBe('active'); // untouched
  });
});

// ── on-chain kill path (Phase 3 e-ii) ────────────────────────────────────────

describe('Runner — on-chain kill path / killCancelOnChain (Phase 3 e-ii)', () => {
  /** A `cancelCommitmentOnchain` recorder that returns a fake receipt with known gas. */
  function cancelOnchainRecorder(gasUsed = 60_000n, effectiveGasPrice = 30_000_000_000n): { fn: OspexAdapter['cancelCommitmentOnchain']; calls: Hex[]; gasPolWeiPerCall: bigint } {
    const calls: Hex[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      // M6/A — adapter signature is `{ hash } | { signedCommitment }`.
      fn: (arg) => {
        const hash = ('hash' in arg ? arg.hash : arg.signedCommitment.commitmentHash) as Hex;
        calls.push(hash);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as CancelOnchainResult['receipt'];
        return Promise.resolve({ txHash: '0xkilltx', receipt, commitmentHash: hash });
      },
    };
  }

  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** Trigger an actual shutdown via a kill file appearing after the first tick. */
  function killFileAfterTick(triggerAtCheck: number): () => boolean {
    let checks = 0;
    return () => { checks += 1; return checks >= triggerAtCheck; };
  }

  it('killCancelOnChain=false (default soft stop) → no on-chain cancels, but the off-chain sweep still pulls every visibleOpen quote (reclassified softCancelled + `soft-cancel` `reason: shutdown` event) (Hermes review-PR29)', async () => {
    const cancel = cancelOnchainRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xa': commitmentRecord({ hash: '0xa', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
      },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: false });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn });
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(cancel.calls).toHaveLength(0); // on-chain sweep skipped (killCancelOnChain=false)
    expect(readEvents().some((e) => e.kind === 'onchain-cancel')).toBe(false);
    // Off-chain soft sweep ran (gasless, unconditional): record → softCancelled + `soft-cancel` `reason: shutdown` event.
    expect(StateStore.at(stateDir).load().state.commitments['0xa']?.lifecycle).toBe('softCancelled');
    expect(readEvents().find((e) => e.kind === 'soft-cancel')).toMatchObject({ reason: 'shutdown' });
  });

  it('soft-stop sweep RETAINS a partiallyFilled remainder — not off-chain-cancelled, a `partial-remainder-retained` `reason: shutdown` candidate, lifecycle unchanged', async () => {
    const cancel = cancelOnchainRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xpartial': commitmentRecord({ hash: '0xpartial', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, lifecycle: 'partiallyFilled', riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000 }),
      },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: false });
    const offchainCancels: Hex[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), {
      cancelCommitmentOnchain: cancel.fn,
      cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(offchainCancels).toEqual([]); // the partial is never off-chain-cancelled during the soft-stop sweep
    expect(cancel.calls).toHaveLength(0); // killCancelOnChain=false → no on-chain sweep either
    expect(StateStore.at(stateDir).load().state.commitments['0xpartial']?.lifecycle).toBe('partiallyFilled'); // retained — rides to expiry
    expect(readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'partial-remainder-retained')).toMatchObject({ commitmentHash: '0xpartial', reason: 'shutdown' });
    expect(readEvents().some((e) => e.kind === 'soft-cancel')).toBe(false);
  });

  it('killCancelOnChain=true + KILL file + non-terminal records → each is cancelOnchain\'d, stamped authoritativelyInvalidated, emits onchain-cancel, gas accumulated', async () => {
    const cancel = cancelOnchainRecorder(60_000n, 30_000_000_000n);
    const expectedGasPerCall = 60_000n * 30_000_000_000n;
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xvisible': commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
        '0xsoft': commitmentRecord({ hash: '0xsoft', speculationId: 'spec-5678', contestId: '5678', makerSide: 'away', oddsTick: 220, riskAmountWei6: '300000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000 }),
        '0xpartial': commitmentRecord({ hash: '0xpartial', speculationId: 'spec-9', contestId: '9', makerSide: 'home', oddsTick: 250, riskAmountWei6: '400000', filledRiskWei6: '100000', lifecycle: 'partiallyFilled', expiryUnixSec: T0 + 1000 }),
        '0xexpired': commitmentRecord({ hash: '0xexpired', speculationId: 'spec-11', contestId: '11', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'expired', expiryUnixSec: T0 - 1 }), // terminal — not cancelled
      },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn });
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(cancel.calls.sort()).toEqual(['0xpartial', '0xsoft', '0xvisible']); // terminal '0xexpired' skipped
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xvisible']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xsoft']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xpartial']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xexpired']?.lifecycle).toBe('expired'); // unchanged
    expect(reloaded.dailyCounters[todayUTC()]?.gasPolWei).toBe((3n * expectedGasPerCall).toString());

    const events = readEvents();
    expect(events.filter((e) => e.kind === 'onchain-cancel')).toHaveLength(3);
    expect(events.find((e) => e.kind === 'onchain-cancel' && e.commitmentHash === '0xvisible')).toMatchObject({ speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', txHash: '0xkilltx', gasPolWei: expectedGasPerCall.toString() });
    expect(events.find((e) => e.kind === 'kill')?.reason).toBe('kill-file'); // kill event still fires AFTER on-chain cancels
  });

  it('dry-run mode: killCancelOnChain=true is IGNORED (dry-run never writes to chain)', async () => {
    const cancel = cancelOnchainRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: { '0xa': commitmentRecord({ hash: '0xa', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }) },
    });
    const config = cfg({ killCancelOnChain: true }); // dryRun:true (default)
    // makeRunner's default uses a dry-run adapter; we don't need liveSpiedAdapter here.
    await makeRunner({ config, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(cancel.calls).toHaveLength(0); // never called — dry-run gated out
    expect(readEvents().some((e) => e.kind === 'onchain-cancel')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xa']?.lifecycle).toBe('visibleOpen');
  });

  it('killCancelOnChain=true + maxTicks reached (no shutdown signal, shutdownReason === null) → NO on-chain cancels (only fires on actual shutdown)', async () => {
    const cancel = cancelOnchainRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: { '0xa': commitmentRecord({ hash: '0xa', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }) },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn });
    // No kill-file trigger; maxTicks=1 exits naturally.
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toHaveLength(0);
    expect(readEvents().some((e) => e.kind === 'onchain-cancel')).toBe(false);
    expect(readEvents().some((e) => e.kind === 'kill')).toBe(false); // shutdownReason still null
  });

  it('gas budget exhausted (even the reserve) → emit `gas-budget-blocks-onchain-cancel`, break the loop, remaining records stay matchable', async () => {
    const POL = 10n ** 18n;
    const cancel = cancelOnchainRecorder();
    // Pre-seed today's counter past the full cap → mayUseReserve=true can't help.
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xa': commitmentRecord({ hash: '0xa', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
        '0xb': commitmentRecord({ hash: '0xb', speculationId: 'spec-5678', contestId: '5678', makerSide: 'away', oddsTick: 220, riskAmountWei6: '300000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
      },
      dailyCounters: { [todayUTC()]: { gasPolWei: POL.toString(), feeUsdcWei6: '0' } }, // already at cap
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn });
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(cancel.calls).toHaveLength(0); // on-chain gate fired before any write
    const candidates = readEvents().filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(candidates).toHaveLength(1); // ONE candidate then break — not one per record
    expect(candidates[0]?.commitmentHash).toBeDefined();
    // BUT the unconditional off-chain sweep still ran (gasless, runs before the on-chain gate),
    // so both records moved to softCancelled. The on-chain authoritative kill is what was blocked.
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xa']?.lifecycle).toBe('softCancelled');
    expect(reloaded.commitments['0xb']?.lifecycle).toBe('softCancelled');
    expect(readEvents().filter((e) => e.kind === 'soft-cancel' && e.reason === 'shutdown')).toHaveLength(2);
  });

  it('cancelCommitmentOnchain throws on one hash → logged as `error` `phase: onchain-cancel`, loop continues to the next record', async () => {
    let calls = 0;
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xbad': commitmentRecord({ hash: '0xbad', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
        '0xgood': commitmentRecord({ hash: '0xgood', speculationId: 'spec-5678', contestId: '5678', makerSide: 'away', oddsTick: 220, riskAmountWei6: '300000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
      },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), {
      cancelCommitmentOnchain: (arg) => {
        calls += 1;
        // M6/A — adapter signature is `{ hash } | { signedCommitment }`.
        const hash = ('hash' in arg ? arg.hash : arg.signedCommitment.commitmentHash) as Hex;
        if (hash === '0xbad') return Promise.reject(new Error('NotCommitmentMaker'));
        const receipt = { gasUsed: 60_000n, effectiveGasPrice: 30_000_000_000n } as unknown as CancelOnchainResult['receipt'];
        return Promise.resolve({ txHash: '0xtx', receipt, commitmentHash: hash });
      },
    });
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(calls).toBe(2); // both attempted
    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'onchain-cancel' && e.commitmentHash === '0xbad')).toMatchObject({ detail: 'NotCommitmentMaker' });
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xbad']?.lifecycle).toBe('softCancelled'); // off-chain pull succeeded; on-chain cancel failed → stayed softCancelled (not authoritativelyInvalidated)
    expect(reloaded.commitments['0xgood']?.lifecycle).toBe('authoritativelyInvalidated'); // both sweeps succeeded
  });

  it('killCancelOnChain=false + visibleOpen + partiallyFilled + softCancelled + expired → off-chain sweep pulls only visibleOpen (gasless); partiallyFilled is RETAINED (can\'t off-chain-cancel a matched commitment); softCancelled / expired untouched; no on-chain calls', async () => {
    const cancel = cancelOnchainRecorder();
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xvisible': commitmentRecord({ hash: '0xvisible', speculationId: 'spec-1', contestId: '1', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
        '0xpartial': commitmentRecord({ hash: '0xpartial', speculationId: 'spec-2', contestId: '2', makerSide: 'away', oddsTick: 220, riskAmountWei6: '400000', filledRiskWei6: '100000', lifecycle: 'partiallyFilled', expiryUnixSec: T0 + 1000 }),
        '0xsoft': commitmentRecord({ hash: '0xsoft', speculationId: 'spec-3', contestId: '3', makerSide: 'home', oddsTick: 200, riskAmountWei6: '300000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000 }),
        '0xexpired': commitmentRecord({ hash: '0xexpired', speculationId: 'spec-4', contestId: '4', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'expired', expiryUnixSec: T0 - 1 }),
      },
    });
    const offchainCalls: Hex[] = [];
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOnchain: cancel.fn, cancelCommitmentOffchain: (hash) => { offchainCalls.push(hash); return Promise.resolve(); } },
    );
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    expect(offchainCalls.sort()).toEqual(['0xvisible']); // only the visibleOpen pulled; partial retained, softCancelled (already pulled) + expired (terminal) skipped
    expect(cancel.calls).toHaveLength(0); // no on-chain calls — killCancelOnChain false
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xvisible']?.lifecycle).toBe('softCancelled');
    expect(reloaded.commitments['0xpartial']?.lifecycle).toBe('partiallyFilled'); // RETAINED — never off-chain-cancelled (rides to expiry; killCancelOnChain would authoritatively cancel it)
    expect(reloaded.commitments['0xsoft']?.lifecycle).toBe('softCancelled'); // unchanged
    expect(reloaded.commitments['0xexpired']?.lifecycle).toBe('expired'); // unchanged
    expect(readEvents().filter((e) => e.kind === 'soft-cancel' && e.reason === 'shutdown')).toHaveLength(1); // only 0xvisible pulled
    expect(readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'partial-remainder-retained')).toMatchObject({ commitmentHash: '0xpartial', reason: 'shutdown' });
  });

  it('off-chain sweep failure on one hash is logged (`error` `phase: cancel`) and the loop continues — failed record stays at original lifecycle; the on-chain sweep (if enabled) may still authoritatively cancel it', async () => {
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: {
        '0xbad': commitmentRecord({ hash: '0xbad', speculationId: 'spec-1', contestId: '1', makerSide: 'home', oddsTick: 200, riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
        '0xok': commitmentRecord({ hash: '0xok', speculationId: 'spec-2', contestId: '2', makerSide: 'away', oddsTick: 220, riskAmountWei6: '300000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000 }),
      },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: false });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOnchain: cancelOnchainRecorder().fn, cancelCommitmentOffchain: (hash) => hash === '0xbad' ? Promise.reject(new Error('API 503')) : Promise.resolve() },
    );
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    const events = readEvents();
    expect(events.find((e) => e.kind === 'error' && e.phase === 'cancel' && e.commitmentHash === '0xbad')).toMatchObject({ detail: 'API 503' });
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xbad']?.lifecycle).toBe('visibleOpen'); // failed pull — original lifecycle
    expect(reloaded.commitments['0xok']?.lifecycle).toBe('softCancelled'); // succeeded
  });

  // ── M6/A pre-pass regression (Hermes #63 round 2) ──────────────────────────
  // Two missing-legacy + visibleOpen records + gas-denied on the first
  // candidate. The fix's load-bearing invariant: BOTH records must keep
  // their off-chain skip even though the cancel loop broke after candidate 1.
  // Without it, candidate 2 would be off-chain-hidden by `offchainKillCancel`
  // and brick into BLOCKED for any future on-chain attempt.
  it('killCancelOnChain=true + TWO missing-legacy + visibleOpen + pre-pass gas-denied → BOTH records stay visibleOpen (touched-set covers later candidates too), offchainKillCancel does NOT hide either', async () => {
    const cancel = cancelOnchainRecorder();
    const a: MakerCommitmentRecord = commitmentRecord({
      hash: '0xaaa', speculationId: 'spec-a', contestId: 'a', makerSide: 'home', oddsTick: 200,
      riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000,
      signedPayloadStatus: 'missing-legacy',
    });
    delete a.signedPayload;
    const b: MakerCommitmentRecord = commitmentRecord({
      hash: '0xbbb', speculationId: 'spec-b', contestId: 'b', makerSide: 'away', oddsTick: 250,
      riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000,
      signedPayloadStatus: 'missing-legacy',
    });
    delete b.signedPayload;
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: { '0xaaa': a, '0xbbb': b },
      // Pre-seed today's gas spend at the daily cap so canSpendGas denies on the FIRST attempt.
      dailyCounters: { [todayUTC()]: { gasPolWei: '2000000000000000000', feeUsdcWei6: '0' } },
    });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true });
    let offchainCalls = 0;
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      {
        cancelCommitmentOnchain: cancel.fn,
        cancelCommitmentOffchain: () => { offchainCalls += 1; return Promise.resolve(); },
      },
      undefined,
      undefined,
      { getCommitment: () => Promise.reject(new Error('unused')) },
    );
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    // Pre-pass denied on first attempt → loop broke. Pre-population of the
    // touched set means BOTH records stay protected from offchainKillCancel.
    expect(offchainCalls).toBe(0);
    expect(cancel.calls).toEqual([]); // gas-denied before any cancel landed
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xaaa']?.lifecycle).toBe('visibleOpen');
    expect(reloaded.commitments['0xbbb']?.lifecycle).toBe('visibleOpen'); // ← THE KEY ASSERTION: NOT bricked into softCancelled
  });

  it('killCancelOnChain=true + missing-legacy + visibleOpen → PRE-PASS on-chain { hash } cancel runs BEFORE the off-chain sweep, record → authoritativelyInvalidated, off-chain DELETE never called on it', async () => {
    const cancel = cancelOnchainRecorder();
    const legacy: MakerCommitmentRecord = commitmentRecord({
      hash: '0xlegacy', speculationId: 'spec-9', contestId: '9', makerSide: 'home', oddsTick: 200,
      riskAmountWei6: '250000', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000,
      signedPayloadStatus: 'missing-legacy',
    });
    delete legacy.signedPayload;
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xlegacy': legacy } });
    const config = cfg({ mode: { dryRun: false }, killCancelOnChain: true });
    let offchainCalls = 0;
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([]),
      {
        cancelCommitmentOnchain: cancel.fn,
        cancelCommitmentOffchain: () => { offchainCalls += 1; return Promise.resolve(); },
      },
      undefined,
      undefined,
      { getCommitment: () => Promise.reject(new Error('unused')) },
    );
    await makeRunner({ config, adapter, maxTicks: 5, deps: { killFileExists: killFileAfterTick(2) } }).run();

    // Pre-pass intercepted the record BEFORE offchainKillCancel could DELETE it.
    expect(offchainCalls).toBe(0);
    expect(cancel.calls).toEqual(['0xlegacy']);
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xlegacy']?.lifecycle).toBe('authoritativelyInvalidated');
    // The blocked-missing-payload event must NOT fire — pre-pass intercepted before brick.
    expect(readEvents().some((e) => e.kind === 'cancel-blocked-missing-payload')).toBe(false);
  });
});

describe('Runner — cancelMode: onchain (D2 — authoritative cancel of retained partial remainders)', () => {
  const POL = 10n ** 18n;
  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function cancelOnchainRecorder(gasUsed = 60_000n, effectiveGasPrice = 30_000_000_000n): { fn: OspexAdapter['cancelCommitmentOnchain']; calls: Hex[]; gasPolWeiPerCall: bigint } {
    const calls: Hex[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      // M6/A — adapter signature is `{ hash } | { signedCommitment }`.
      fn: (arg) => {
        const hash = ('hash' in arg ? arg.hash : arg.signedCommitment.commitmentHash) as Hex;
        calls.push(hash);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as CancelOnchainResult['receipt'];
        return Promise.resolve({ txHash: '0xcanceltx' as Hex, commitmentHash: hash, receipt });
      },
    };
  }

  it('a stale retained partial is authoritatively cancelled on chain → authoritativelyInvalidated + onchain-cancel + gas accrued; the freed side re-quotes NEXT tick (never same-tick)', async () => {
    // maker-on-away stale partial → occupies the *home* offer. cancelMode:onchain frees it; the away offer (maker-on-home) submits tick 1.
    const stalePartial = commitmentRecord({ hash: '0xpartialHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialHome': stalePartial } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const submit = submitRecorder();
    const cancel = cancelOnchainRecorder();
    const offchainCancels: Hex[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOnchain: cancel.fn,
      cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(cancel.calls).toEqual(['0xpartialHome']); // authoritative on-chain cancel of the matched remainder
    expect(offchainCancels).not.toContain('0xpartialHome'); // never the off-chain DELETE (would 409)
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xpartialHome']?.lifecycle).toBe('authoritativelyInvalidated');
    const events = readEvents();
    expect(events.find((e) => e.kind === 'onchain-cancel' && e.commitmentHash === '0xpartialHome')).toMatchObject({ speculationId: 'spec-1234', makerSide: 'away', txHash: '0xcanceltx' });
    expect(reloaded.dailyCounters[todayUTC()]?.gasPolWei).toBe(cancel.gasPolWeiPerCall.toString()); // gas accrued
    // The freed side re-quotes next tick: by tick 2 both maker sides hold a fresh visibleOpen (away offer tick 1, home offer tick 2).
    expect(Object.values(reloaded.commitments).filter((r) => r.lifecycle === 'visibleOpen').map((r) => r.makerSide).sort()).toEqual(['away', 'home']);
  });

  it('gas-budget denial (mayUseReserve:false — routine refresh must not burn the reserve) → candidate gas-budget-blocks-onchain-cancel; partial stays partiallyFilled; no off-chain DELETE; no repost over it', async () => {
    const stalePartial = commitmentRecord({ hash: '0xpartialHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    // Spend 0.9 POL of a 1 POL cap with a 0.2 POL reserve: mayUseReserve:false denies (0.9 + 0.2 ≥ 1.0), but mayUseReserve:true WOULD allow (0.9 < 1.0) — proving the routine path passes false.
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialHome': stalePartial }, dailyCounters: { [todayUTC()]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const submit = submitRecorder();
    const cancel = cancelOnchainRecorder();
    const offchainCancels: Hex[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submit.fn,
      cancelCommitmentOnchain: cancel.fn,
      cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); },
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(cancel.calls).toEqual([]); // the on-chain cancel was gas-denied (proves mayUseReserve:false)
    expect(offchainCancels).not.toContain('0xpartialHome'); // no off-chain fallback for a matched commitment
    const events = readEvents();
    const gasDeniedCandidates = events.filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(gasDeniedCandidates).toHaveLength(1); // gas denial is APPLIED, not transient: throttled behind staleAfterSeconds, NOT retried every tick — across 2 ticks it fires once (contrast: an adapter throw retries next tick — see below)
    expect(gasDeniedCandidates[0]).toMatchObject({ commitmentHash: '0xpartialHome', makerSide: 'away' });
    expect(StateStore.at(stateDir).load().state.commitments['0xpartialHome']?.lifecycle).toBe('partiallyFilled'); // retained — rides to expiry
    expect(submit.calls).toHaveLength(1); // only the empty away offer — no repost over the still-live partial
  });

  it('a failed routine on-chain cancel (adapter throw) re-arms the market — the cancel RETRIES next tick, not throttled behind staleAfterSeconds (Hermes PR#44 blocker)', async () => {
    const stalePartial = commitmentRecord({ hash: '0xpartialHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialHome': stalePartial } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    let attempts = 0;
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submitRecorder().fn,
      cancelCommitmentOnchain: () => { attempts += 1; return Promise.reject(new Error('RPC down')); },
    });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(attempts).toBe(2); // retried on tick 2 (the bug throttled it to 1 — `applied` stamped lastReconciledAt, deferring to staleAfterSeconds)
    expect(StateStore.at(stateDir).load().state.commitments['0xpartialHome']?.lifecycle).toBe('partiallyFilled'); // still retained — never off-chain-cancelled, never reposted over
    expect(readEvents().filter((e) => e.kind === 'error' && e.phase === 'onchain-cancel' && e.commitmentHash === '0xpartialHome')).toHaveLength(2); // one error per attempt
  });

  it('gas-denied on-chain cancel in an UNQUOTEABLE gate (start-too-soon, only a retained partial) does NOT re-fire every tick — one candidate across 2 ticks (Hermes PR#44 re-review)', async () => {
    // Regression: the unquoteable-market gate (`marketUnquoteable && hasVisibleOpenQuotesOn`) must not count
    // the retained partial, or it re-fires every tick and re-emits the gas-denial candidate (spam).
    const SOON_ISO = new Date((T0 + 60) * 1000).toISOString(); // start-too-soon gate (60 <= expirySeconds 120)
    const stalePartial = commitmentRecord({ hash: '0xpartial', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    // Gas at 0.9 of a 1 POL cap with a 0.2 reserve → mayUseReserve:false denies.
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartial': stalePartial }, dailyCounters: { [todayUTC()]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: SOON_ISO })]), { cancelCommitmentOnchain: cancel.fn });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(cancel.calls).toEqual([]); // gas-denied — never attempted on chain
    const gasDeniedCandidates = readEvents().filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(gasDeniedCandidates).toHaveLength(1); // fires ONCE, not per-tick — the unquoteable gate no longer eagerly re-fires for a retained partial
    expect(StateStore.at(stateDir).load().state.commitments['0xpartial']?.lifecycle).toBe('partiallyFilled'); // retained — rides to expiry
  });

  it('a transient on-chain cancel via the unquoteable eager gate retries next tick even when lastReconciledAt is recent (Hermes PR#44 round 3)', async () => {
    // Round-3 hole: a market applies a reconcile (stamping lastReconciledAt), then becomes unquoteable and
    // re-enters reconcile via the visibleOpen eager gate (wasDirty=false); the visibleOpen is pulled off-chain and
    // the retained partial's on-chain cancel throws. The old `m.dirty = m.dirty || wasDirty` left dirty=false, and
    // with the visibleOpen now pulled the eager gate no longer fires, so the retry was throttled behind
    // staleAfterSeconds. The fix forces dirty=true on ANY transient → guaranteed next-tick retry.
    let clock = T0;
    const matchTimeSec = T0 + 150; // tick 1 (T0): 150 > expirySeconds 120 → quoteable; ticks 2-3 (clock advanced): start-too-soon
    // Fresh, on-tick partial occupant (makerSide away → home offer). Huge replaceOnOddsMoveBps ⇒ never "mispriced" and
    // fresh postedAt ⇒ not "stale", so it is NOT retained on the quoteable tick 1 → no on-chain cancel attempted there
    // → tick 1 applies and stamps lastReconciledAt (the precondition for the round-3 throttle hole).
    const partial = commitmentRecord({ hash: '0xpart', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpart': partial } });
    const config = cfg({ mode: { dryRun: false }, odds: { subscribe: false }, orders: { expirySeconds: 120, cancelMode: 'onchain', replaceOnOddsMoveBps: 100_000, staleAfterSeconds: 90 } });
    let attempts = 0;
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234', matchTime: new Date(matchTimeSec * 1000).toISOString() })]), {
      submitCommitment: submitRecorder().fn,
      cancelCommitmentOffchain: () => Promise.resolve(),
      cancelCommitmentOnchain: () => { attempts += 1; return Promise.reject(new Error('RPC down')); },
    }, undefined, undefined,
      // The visibleOpen quote tick 1 posts (hash `0xlive1`) gets pulled off-chain on tick 2 →
      // it becomes a softCancelled record. The soft-cancelled-fill convergence step probes it
      // via getCommitment on tick 3; a pulled-but-unmatched quote has filledRiskAmount '0', so
      // the probe succeeds + no-ops (stays softCancelled) and the reconcile proceeds — this
      // test is about the on-chain-cancel retry cadence, not about a fill. We return an
      // unmatched-and-still-`open` shape (filledRiskAmount '0', future expiry, not nonce-
      // invalidated): on tick 2 detectFills sees it disappear from the listing but, since it's
      // a future-expiry open row, leaves the record untouched (so the reconcile can pull it →
      // softCancelled); on tick 3 the convergence step reads cumulative fill '0' and no-ops.
      // The retained partial `0xpart` keeps the default (reject): it's future-expiry, so a
      // detectFills lookup failure on it is non-fatal and leaves it `partiallyFilled` (the
      // precondition the gate needs).
      { getCommitment: (h) => (h === '0xpart' ? Promise.reject(new Error('not stubbed for the partial')) : Promise.resolve(orderbookEntry({ commitmentHash: h, maker: DEFAULT_FAKE_MAKER_ADDRESS, riskAmount: '500000', filledRiskAmount: '0', remainingRiskAmount: '500000', status: 'open', nonceInvalidated: false, expiry: new Date((T0 + 1000) * 1000).toISOString() }))) },
    );
    // Advance the clock ~40s per inter-tick sleep: tick 1 quoteable, ticks 2-3 start-too-soon, and by tick 3 the
    // elapsed (80s) is still < staleAfterSeconds (90s), so the OLD code's cadence throttle would have blocked the retry.
    await makeRunner({ config, adapter, maxTicks: 3, deps: { now: () => clock, sleep: () => { clock += 40; return Promise.resolve(); } } }).run();

    expect(attempts).toBe(2); // tick 2 (gate fires via the visibleOpen) + tick 3 (forced dirty after the transient) — the old `|| wasDirty` produced 1
    expect(StateStore.at(stateDir).load().state.commitments['0xpart']?.lifecycle).toBe('partiallyFilled'); // still retained — never off-chain-cancelled
  });

  it('cancelMode:offchain (the default) does NOT on-chain-cancel a retained partial — it rides to expiry', async () => {
    const stalePartial = commitmentRecord({ hash: '0xpartialHome', speculationId: 'spec-1234', contestId: '1234', makerSide: 'away', lifecycle: 'partiallyFilled', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xpartialHome': stalePartial } });
    const config = cfg({ mode: { dryRun: false } }); // orders.cancelMode defaults to 'offchain'
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([contestView({ contestId: '1234' })]), {
      submitCommitment: submitRecorder().fn,
      cancelCommitmentOnchain: cancel.fn,
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual([]); // default mode never on-chain-cancels routinely
    expect(StateStore.at(stateDir).load().state.commitments['0xpartialHome']?.lifecycle).toBe('partiallyFilled');
    expect(readEvents().find((e) => e.kind === 'candidate' && e.skipReason === 'partial-remainder-retained')).toMatchObject({ commitmentHash: '0xpartialHome', reason: 'stale' });
  });
});

describe('Runner — cancelMode: onchain (PR3 — authoritative cancel of recovered soft-cancels)', () => {
  const POL = 10n ** 18n;
  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function cancelOnchainRecorder(gasUsed = 60_000n, effectiveGasPrice = 30_000_000_000n): { fn: OspexAdapter['cancelCommitmentOnchain']; calls: Hex[]; gasPolWeiPerCall: bigint } {
    const calls: Hex[] = [];
    return {
      calls,
      gasPolWeiPerCall: gasUsed * effectiveGasPrice,
      // M6/A: adapter signature is now `{ hash } | { signedCommitment }`.
      // The recorder normalizes both shapes to the hash for assertion
      // simplicity — most tests just check "the right hash got cancelled".
      fn: (arg) => {
        const hash = ('hash' in arg ? arg.hash : arg.signedCommitment.commitmentHash) as Hex;
        calls.push(hash);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as CancelOnchainResult['receipt'];
        return Promise.resolve({ txHash: '0xrecoverytx' as Hex, commitmentHash: hash, receipt });
      },
    };
  }
  // A recovered soft-cancel: the MM soft-cancelled a quote off-chain (→ softCancelled), then a taker
  // matched the stale signed payload on chain. reconcileSoftCancelledFills converges its cumulative
  // fill (it STAYS softCancelled with filledRiskWei6 > 0 — PR2); under cancelMode:onchain this step
  // authoritatively cancels the still-latent remainder rather than letting it ride to expiry.
  function recoveredScApi(filledRiskAmount: string, riskAmount = '500000', storedStatus: Commitment['storedStatus'] = 'partially_filled'): Commitment {
    return orderbookEntry({ commitmentHash: '0xsc', maker: DEFAULT_FAKE_MAKER_ADDRESS, contestId: '1234', positionType: 1, oddsTick: 200, riskAmount, filledRiskAmount, remainingRiskAmount: (BigInt(riskAmount) - BigInt(filledRiskAmount)).toString(), status: 'cancelled', storedStatus, isLive: false });
  }

  it('cancelMode:onchain: a recovered soft-cancel (matched after the off-chain pull) is authoritatively cancelled on chain → authoritativelyInvalidated + onchain-cancel + gas accrued; never the off-chain DELETE (it would 409)', async () => {
    // filledRiskWei6 starts 0; getCommitment reports a cumulative 200000 → reconcileSoftCancelledFills converges (stays softCancelled), then this step cancels the latent remainder.
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    const offchainCancels: Hex[] = [];
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), {
      cancelCommitmentOnchain: cancel.fn,
      cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); },
    }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual(['0xsc']); // authoritative on-chain cancel of the matched soft-cancel's remainder
    expect(offchainCancels).not.toContain('0xsc'); // never the off-chain DELETE (a matched commitment 409s)
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments['0xsc']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(reloaded.commitments['0xsc']?.filledRiskWei6).toBe('200000'); // the matched portion is recorded; the remainder is now cancelled
    const events = readEvents();
    expect(events.find((e) => e.kind === 'fill' && e.source === 'softcancel-recovery' && e.commitmentHash === '0xsc')).toBeDefined(); // the recovery fill fired first (the match)
    expect(events.find((e) => e.kind === 'onchain-cancel' && e.commitmentHash === '0xsc')).toMatchObject({ speculationId: 'spec-1234', makerSide: 'home', txHash: '0xrecoverytx' });
    expect(reloaded.dailyCounters[todayUTC()]?.gasPolWei).toBe(cancel.gasPolWeiPerCall.toString()); // gas accrued
  });

  it('cancelMode:offchain (the default): a recovered soft-cancel is NOT on-chain-cancelled — it stays softCancelled and rides to expiry', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: false } }); // orders.cancelMode defaults to 'offchain'
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual([]); // default mode never on-chain-cancels routinely
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // rides to expiry
    expect(readEvents().some((e) => e.kind === 'onchain-cancel')).toBe(false);
  });

  it('cancelMode:onchain: an UNMATCHED soft-cancel (filledRiskWei6 0) is NOT cancelled — it rides to expiry (gas economy; no point cancelling a quote that may never match)', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '0', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('0', '500000', 'open')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual([]); // unmatched → never cancelled
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('softCancelled');
  });

  it('cancelMode:onchain: a PAST-EXPIRY recovered soft-cancel is NOT cancelled (already unmatchable on chain — ageOut terminalizes it to expired; no gas wasted)', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 - 100 /* past expiry + the 60s grace */, postedAtUnixSec: T0 - 200, updatedAtUnixSec: T0 - 200 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual([]); // past-expiry → unmatchable on chain → not cancelled
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('expired'); // ageOut terminalized it
  });

  it('cancelMode:onchain: a sustained gas-budget denial surfaces `gas-budget-blocks-onchain-cancel` ONCE across ticks (not per-tick spam), keeps the record softCancelled, and never lands the cancel', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    // 0.9 POL spent of a 1 POL cap with a 0.2 reserve → mayUseReserve:false denies (0.9 + 0.2 ≥ 1.0).
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc }, dailyCounters: { [todayUTC()]: { gasPolWei: ((POL * 9n) / 10n).toString(), feeUsdcWei6: '0' } } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 3 }).run();

    expect(cancel.calls).toEqual([]); // gas-denied — never lands
    const gasDenied = readEvents().filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(gasDenied).toHaveLength(1); // surfaced ONCE across 3 ticks (warn-once throttle), NOT per-tick spam (the cancel is still re-attempted each tick)
    expect(gasDenied[0]).toMatchObject({ commitmentHash: '0xsc', makerSide: 'home' });
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // retained — rides to expiry
  });

  it('cancelMode:onchain: a transient on-chain cancel failure (adapter throw) retries every tick; the record stays softCancelled until it lands', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    let attempts = 0;
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: () => { attempts += 1; return Promise.reject(new Error('RPC down')); } }, undefined, undefined, { getCommitment: (h) => (h === '0xsc' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 2 }).run();

    expect(attempts).toBe(2); // every-tick scan retries on tick 2 (no throttle on transient failures)
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('softCancelled'); // still latent until the cancel lands
    expect(readEvents().filter((e) => e.kind === 'error' && e.phase === 'onchain-cancel' && e.commitmentHash === '0xsc')).toHaveLength(2); // one error per attempt
  });

  // M6/A — own-state SSE plan §M6: a softCancelled record without a captured
  // signed payload (legacy pre-M6/A) cannot be cancelled via the on-chain
  // path. The public commitments API redacts the signed payload for hidden
  // rows (M2), and `ownState.getCommitment` recovery is Phase 2 work. The
  // sweep emits `cancel-blocked-missing-payload` ONCE per stuck record
  // across ticks and never burns gas on a doomed adapter call.
  it('cancelMode:onchain: a recovered soft-cancel with signedPayloadStatus=missing-legacy is BLOCKED — emits cancel-blocked-missing-payload once across ticks, no cancel attempted, lifecycle stays softCancelled', async () => {
    // The default fixture is `present` with a stub payload — override to
    // `missing-legacy` and drop the payload to model the pre-M6/A record.
    const legacy: MakerCommitmentRecord = commitmentRecord({
      hash: '0xlegacy', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200,
      riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled',
      expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5,
      signedPayloadStatus: 'missing-legacy',
    });
    delete legacy.signedPayload; // shouldn't be set on 'missing-legacy' per the validator's consistency rule
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xlegacy': legacy } });
    const config = cfg({ mode: { dryRun: false }, orders: { expirySeconds: 120, cancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0.2 } });
    const cancel = cancelOnchainRecorder();
    // `getCommitment` mock is required so `reconcileSoftCancelledFills` (runs
    // BEFORE the recovered-soft-cancel sweep) can converge the on-chain
    // status; without it the runner short-circuits and the cancel sweep
    // never gets to dispatch. Same harness pattern as the sibling tests.
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn }, undefined, undefined, { getCommitment: (h) => (h === '0xlegacy' ? Promise.resolve(recoveredScApi('200000')) : Promise.reject(new Error('unknown hash'))) });
    await makeRunner({ config, adapter, maxTicks: 3 }).run();

    expect(cancel.calls).toEqual([]); // dispatch short-circuits BEFORE the adapter — no wasted gas / RPC on a doomed cancel
    const blocked = readEvents().filter((e) => e.kind === 'cancel-blocked-missing-payload');
    expect(blocked).toHaveLength(1); // warn-once across 3 ticks, like the sibling gas-denied throttle
    expect(blocked[0]).toMatchObject({
      commitmentHash: '0xlegacy',
      speculationId: 'spec-1234',
      contestId: '1234',
      makerSide: 'home',
      lifecycle: 'softCancelled',
      reason: 'missing-legacy-signed-payload-and-hidden',
    });
    expect(StateStore.at(stateDir).load().state.commitments['0xlegacy']?.lifecycle).toBe('softCancelled'); // unchanged — rides to expiry pending operator action
  });

  it('dry-run: never on-chain-cancels a recovered soft-cancel even under cancelMode:onchain', async () => {
    const sc = commitmentRecord({ hash: '0xsc', speculationId: 'spec-1234', contestId: '1234', makerSide: 'home', oddsTick: 200, riskAmountWei6: '500000', filledRiskWei6: '200000', lifecycle: 'softCancelled', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 5, updatedAtUnixSec: T0 - 5 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xsc': sc } });
    const config = cfg({ mode: { dryRun: true }, orders: { expirySeconds: 120, cancelMode: 'onchain' } });
    const cancel = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), { cancelCommitmentOnchain: cancel.fn });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    expect(cancel.calls).toEqual([]); // dry-run never writes to chain
    expect(StateStore.at(stateDir).load().state.commitments['0xsc']?.lifecycle).toBe('softCancelled');
  });
});

// ── funding guard (DESIGN §6): C1a hold/halt + C1b active cancel ──────────────
describe('Runner — funding guard', () => {
  const MAKER = DEFAULT_FAKE_MAKER_ADDRESS as Hex;

  /** Seed one matchable `visibleOpen` commitment into state (so `required` > 0) and return it. */
  function seedOne(over: Partial<MakerCommitmentRecord> = {}): MakerCommitmentRecord {
    const record = commitmentRecord({ hash: '0xfund', contestId: 'contest-fund', speculationId: 'spec-fund', makerSide: 'away', riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10, ...over });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { [record.hash]: record } });
    return record;
  }

  /** The `listOpenCommitments` fixture that keeps a seeded local record "live" through `detectFills` (still on the book, no new fill → stays counted in `required`). */
  function openFixture(record: MakerCommitmentRecord): Commitment {
    return orderbookEntry({
      commitmentHash: record.hash, maker: MAKER, status: 'open', storedStatus: 'open', isLive: true,
      riskAmount: record.riskAmountWei6, filledRiskAmount: record.filledRiskWei6,
      remainingRiskAmount: (BigInt(record.riskAmountWei6) - BigInt(record.filledRiskWei6)).toString(),
    });
  }

  /** A `readBalances` stub with the given wallet USDC (other balances are safe non-zero placeholders). */
  function balances(usdc: bigint): (owner: Hex) => Promise<{ owner: Hex; chainId: number; native: bigint; usdc: bigint; link: bigint; usdcAddress: Hex; linkAddress: Hex }> {
    return (owner) => Promise.resolve({ owner, chainId: 137, native: 10n ** 18n, usdc, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex });
  }

  function todayUTC(): string {
    const d = new Date(T0 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function cancelOnchainRecorder(gasUsed = 60_000n, effectiveGasPrice = 30_000_000_000n): { fn: OspexAdapter['cancelCommitmentOnchain']; calls: Hex[] } {
    const calls: Hex[] = [];
    return {
      calls,
      // M6/A — see the sibling cancelOnchainRecorder above for the
      // discriminated-arg normalization.
      fn: (arg) => {
        const hash = ('hash' in arg ? arg.hash : arg.signedCommitment.commitmentHash) as Hex;
        calls.push(hash);
        const receipt = { gasUsed, effectiveGasPrice } as unknown as CancelOnchainResult['receipt'];
        return Promise.resolve({ txHash: '0xkilltx', receipt, commitmentHash: hash });
      },
    };
  }

  // ── C1a: detect underfunding, enter the hold, halt NEW posting ───────────────

  it('C1a — underfunded (funding < required) enters the hold and halts posting: no quote-intent, no submit, even with a quotable market', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none' } }); // 'none' isolates the hold from the C1b cancel sweep
    const submit = submitRecorder();
    const adapter = liveSpiedAdapter(
      config,
      () => Promise.resolve([contestView({ contestId: '1234' })]), // a quotable market — the same setup posts both sides absent the hold (see 'posts both sides' above)
      { submitCommitment: submit.fn },
      undefined,
      undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: balances(100_000n) }, // wallet 0.10 USDC < required 0.25
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    const events = readEvents();
    const hold = events.filter((e) => e.kind === 'funding-hold');
    expect(hold).toHaveLength(1);
    expect(hold[0]).toMatchObject({ state: 'entered', reason: 'funding-shortfall', requiredWei6: '250000', fundingWei6: '100000' });
    expect(submit.calls).toHaveLength(0); // posting halted
    expect(events.some((e) => e.kind === 'submit')).toBe(false);
    expect(events.some((e) => e.kind === 'quote-intent')).toBe(false); // reconcileMarkets early-returned on the hold — never even priced
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).toBe('visibleOpen'); // mode 'none' → no active cancel
  });

  it('C1a — adequately funded (funding ≥ required) does not hold', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none' } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]) }, // default saturated balances/approvals → funding ≫ required
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(readEvents().some((e) => e.kind === 'funding-hold')).toBe(false);
  });

  it('C1a — fail-closed: a balance read error enters the hold (reason read-failed) when failClosedOnReadError', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none', failClosedOnReadError: true } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: () => Promise.reject(new Error('rpc 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.filter((e) => e.kind === 'funding-hold' && e.state === 'entered' && e.reason === 'read-failed')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'error' && e.phase === 'funding-check')).toBe(true);
  });

  it('C1a — failClosedOnReadError:false — a read error does NOT enter the hold, but is still logged', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none', failClosedOnReadError: false } });
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]), undefined, undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readApprovals: () => Promise.reject(new Error('rpc 503')) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'funding-hold')).toBe(false);
    expect(events.some((e) => e.kind === 'error' && e.phase === 'funding-check')).toBe(true);
  });

  it('C1a — no matchable exposure (required = 0) skips the balance/allowance reads entirely', async () => {
    StateStore.at(stateDir).flush(emptyMakerState()); // no commitments → required 0
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none' } });
    let balanceReads = 0;
    let approvalReads = 0;
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), undefined, undefined, undefined, {
      readBalances: (o) => { balanceReads += 1; return Promise.resolve({ owner: o, chainId: 137, native: 0n, usdc: 0n, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex }); },
      readApprovals: () => { approvalReads += 1; return Promise.resolve(approvalsSnapshotWith(0n)); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(balanceReads).toBe(0); // required-first short-circuit (autoApprove:false → no other reader)
    expect(approvalReads).toBe(0);
    expect(readEvents().some((e) => e.kind === 'funding-hold')).toBe(false);
  });

  // ── C1b: active cancel response per underfundedCancelMode ────────────────────

  it('C1b — offchain: pulls visible quotes off the relay (soft-cancel reason "funding"), no on-chain cancel, exposure still counted', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'offchain' } });
    const offchainCancels: Hex[] = [];
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); }, cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: balances(0n) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'funding-hold' && e.state === 'entered')).toBe(true);
    expect(offchainCancels).toEqual(['0xfund']); // pulled off the relay
    expect(cancelOnchain.calls).toEqual([]); // offchain mode → no authoritative cancel
    const sc = events.filter((e) => e.kind === 'soft-cancel' && e.reason === 'funding');
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({ commitmentHash: '0xfund', reason: 'funding' });
    // Pulled, but the signed payload stays matchable on chain → still `softCancelled` and still counted in `required`.
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).toBe('softCancelled');
  });

  it('C1b — onchain: soft-cancels then authoritatively cancels on chain → authoritativelyInvalidated (drops from required)', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'onchain' } });
    const offchainCancels: Hex[] = [];
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); }, cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: balances(0n) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(offchainCancels).toEqual(['0xfund']); // off-chain pull first
    expect(cancelOnchain.calls).toEqual(['0xfund']); // then authoritative cancel
    expect(events.some((e) => e.kind === 'onchain-cancel' && e.commitmentHash === '0xfund')).toBe(true);
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).toBe('authoritativelyInvalidated');
  });

  // ── M6/A pre-pass regression (Hermes #63 round 2) ──────────────────────────
  it('C1b — onchain + TWO missing-legacy + visibleOpen + pre-pass gas-denied → BOTH records stay visibleOpen (touched-set covers later candidates), off-chain pull does NOT hide either', async () => {
    const a: MakerCommitmentRecord = commitmentRecord({
      hash: '0xfund-a', contestId: 'contest-a', speculationId: 'spec-a', makerSide: 'away', riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10, signedPayloadStatus: 'missing-legacy',
    });
    delete a.signedPayload;
    const b: MakerCommitmentRecord = commitmentRecord({
      hash: '0xfund-b', contestId: 'contest-b', speculationId: 'spec-b', makerSide: 'home', riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10, signedPayloadStatus: 'missing-legacy',
    });
    delete b.signedPayload;
    const todayKey = new Date(T0 * 1000).toISOString().slice(0, 10);
    StateStore.at(stateDir).flush({
      ...emptyMakerState(),
      commitments: { [a.hash]: a, [b.hash]: b },
      // Daily cap exhausted → canSpendGas denies on the FIRST candidate.
      dailyCounters: { [todayKey]: { gasPolWei: '2000000000000000000', feeUsdcWei6: '0' } },
    });
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'onchain' } });
    const offchainCancels: Hex[] = [];
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); }, cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(a), openFixture(b)]), readBalances: balances(0n) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();

    // Pre-pass denied → no on-chain cancels. Off-chain pull was SKIPPED for
    // both records because the touched-set was pre-populated.
    expect(cancelOnchain.calls).toEqual([]);
    expect(offchainCancels).toEqual([]); // ← THE KEY ASSERTION: neither record was off-chain-hidden
    const reloaded = StateStore.at(stateDir).load().state;
    expect(reloaded.commitments[a.hash]?.lifecycle).toBe('visibleOpen');
    expect(reloaded.commitments[b.hash]?.lifecycle).toBe('visibleOpen'); // not bricked
  });

  it('C1b — onchain + missing-legacy + visibleOpen: PRE-PASS on-chain { hash } cancel runs BEFORE the off-chain pull, off-chain DELETE never called on the record, no BLOCKED telemetry', async () => {
    // `seedOne` calls flush() immediately, so build the record + flush manually
    // so the on-disk state is consistent (missing-legacy MUST have no
    // signedPayload — the validator rejects the inconsistency).
    const record: MakerCommitmentRecord = commitmentRecord({ hash: '0xfund', contestId: 'contest-fund', speculationId: 'spec-fund', makerSide: 'away', riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 1000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10, signedPayloadStatus: 'missing-legacy' });
    delete record.signedPayload;
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { [record.hash]: record } });
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'onchain' } });
    const offchainCancels: Hex[] = [];
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); }, cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: balances(0n) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    // Off-chain pull was SKIPPED for this record (touched-by-pre-pass set
    // prevents the hide); the on-chain pre-pass authoritatively invalidated it.
    expect(offchainCancels).toEqual([]);
    expect(cancelOnchain.calls).toEqual(['0xfund']);
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).toBe('authoritativelyInvalidated');
    expect(readEvents().some((e) => e.kind === 'cancel-blocked-missing-payload')).toBe(false);
  });

  it('C1b — none: holds but performs NO active cancel (quote rides to expiry)', async () => {
    const record = seedOne();
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'none' } });
    const offchainCancels: Hex[] = [];
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: (h) => { offchainCancels.push(h); return Promise.resolve(); }, cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      { listOpenCommitments: () => Promise.resolve([openFixture(record)]), readBalances: balances(0n) },
    );
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    const events = readEvents();
    expect(events.some((e) => e.kind === 'funding-hold' && e.state === 'entered')).toBe(true); // still holds
    expect(offchainCancels).toEqual([]);
    expect(cancelOnchain.calls).toEqual([]);
    expect(events.some((e) => e.kind === 'soft-cancel')).toBe(false);
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).toBe('visibleOpen');
  });

  it('C1b — onchain + gas budget exhausted: emits the gas-denial candidate ONCE per hold episode (not per tick), record not authoritatively cancelled', async () => {
    const POL = 10n ** 18n;
    const record = commitmentRecord({ hash: '0xfund', contestId: 'contest-fund', speculationId: 'spec-fund', makerSide: 'away', riskAmountWei6: '250000', filledRiskWei6: '0', lifecycle: 'visibleOpen', expiryUnixSec: T0 + 10_000, postedAtUnixSec: T0 - 10, updatedAtUnixSec: T0 - 10 });
    StateStore.at(stateDir).flush({ ...emptyMakerState(), commitments: { '0xfund': record }, dailyCounters: { [todayUTC()]: { gasPolWei: POL.toString(), feeUsdcWei6: '0' } } }); // today's spend already at the full cap
    const config = cfg({ mode: { dryRun: false }, fundingGuard: { underfundedCancelMode: 'onchain' }, gas: { maxDailyGasPOL: 1, emergencyReservePOL: 0 } });
    const cancelOnchain = cancelOnchainRecorder();
    const adapter = liveSpiedAdapter(
      config, () => Promise.resolve([]),
      { cancelCommitmentOffchain: () => Promise.resolve(), cancelCommitmentOnchain: cancelOnchain.fn },
      undefined, undefined,
      {
        listOpenCommitments: () => Promise.resolve([openFixture(record)]),
        getCommitment: (h) => (h === '0xfund' ? Promise.resolve(openFixture(record)) : Promise.reject(new Error('unknown hash'))), // tick-2 soft-cancelled-fill probe
        readBalances: balances(0n),
      },
    );
    await makeRunner({ config, adapter, maxTicks: 2 }).run(); // two held ticks — the warning must fire once, not per tick

    const events = readEvents();
    const denied = events.filter((e) => e.kind === 'candidate' && e.skipReason === 'gas-budget-blocks-onchain-cancel');
    expect(denied).toHaveLength(1); // warn-once per episode (break + fundingOnchainGasDeniedWarned)
    expect(cancelOnchain.calls).toEqual([]); // gas gate fired before any write
    expect(StateStore.at(stateDir).load().state.commitments['0xfund']?.lifecycle).not.toBe('authoritativelyInvalidated'); // the authoritative cancel never landed
  });

  it('C1b — dry-run: the funding guard never reads or holds (live-only)', async () => {
    seedOne();
    let reads = 0;
    const config = cfg({ mode: { dryRun: true }, fundingGuard: { underfundedCancelMode: 'onchain' } });
    const adapter = liveSpiedAdapter(config, () => Promise.resolve([]), undefined, undefined, undefined, {
      readBalances: (o) => { reads += 1; return Promise.resolve({ owner: o, chainId: 137, native: 0n, usdc: 0n, link: 0n, usdcAddress: '0xusdc' as Hex, linkAddress: '0xlink' as Hex }); },
    });
    await makeRunner({ config, adapter, maxTicks: 1 }).run();
    expect(reads).toBe(0);
    expect(readEvents().some((e) => e.kind === 'funding-hold')).toBe(false);
  });
});
