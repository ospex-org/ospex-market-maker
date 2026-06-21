/**
 * Persistent inventory (DESIGN §12) — the MM's local cache of its own commitments,
 * positions, P&L, and daily POL-gas / fee counters, plus the boot-time
 * state-loss fail-safe.
 *
 * One JSON file under `state.dir`, written atomically (temp + rename), pretty-
 * printed so it's human-inspectable. **NOT multi-process safe — one MM per state
 * directory.**  Chain / API is truth; on boot the runner loads this file and
 * reconciles the rest against on-chain / API reality — *except* the `softCancelled`
 * set, which is **not** reconstructible from chain/API (an off-chain DELETE pulls a
 * quote from the API but doesn't invalidate the signed payload — a taker holding it
 * can still match it on chain until expiry / on-chain-cancel / nonce-floor raise).
 * So if this file is lost or corrupt, latent matchable exposure is under-counted →
 * the boot-time fail-safe (`assessStateLoss`) holds quoting.
 *
 * Big numbers (risk in USDC 6-decimal wei, gas in POL wei, the 4 EIP-712
 * commitment bigints on a persisted `signedPayload`) are stored as decimal strings
 * — same convention as the SDK's AGENT_CONTRACT (they can exceed
 * `Number.MAX_SAFE_INTEGER`, and `JSON.stringify` refuses native `bigint`). The SDK
 * import here is type-only — `SignedCommitmentPayload` (M5/PR2) is the protocol
 * canonical bigint shape; this module holds its on-disk variant
 * ({@link MakerSignedPayload}, with bigints as decimal strings) plus the
 * conversion helpers used at the submit / cancel boundaries (own-state SSE plan §M6).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

import type { SignedCommitmentPayload, Hex } from '@ospex/sdk';

// The single-process `state.dir` lock (DESIGN §12) lives in its own module; re-export
// its surface here so callers import it from the same `../state/index.js` barrel as
// `StateStore`.
export {
  acquireStateLock,
  StateLockError,
  STATE_LOCK_FILE,
  type StateLock,
  type StateLockDeps,
  type StateLockIdentity,
} from './lock.js';

// ── commitment lifecycle (DESIGN §9) ─────────────────────────────────────────

/**
 * A posted commitment moves through these states. Only `filled` /
 * `partiallyFilled` (its filled portion), `expired`, and
 * `authoritativelyInvalidated` move risk out of the latent/open exposure bucket
 * — `softCancelled` does NOT (an off-chain DELETE leaves the signed payload
 * matchable on chain). The runner's risk accounting (`src/risk/`) implements the
 * bucket math; this enum is just the persisted state.
 */
export const COMMITMENT_LIFECYCLE_STATES = [
  'visibleOpen', //                  API-visible, matchable
  'softCancelled', //                pulled from the API, STILL matchable on chain until expiry / on-chain-cancel / nonce-raise
  'partiallyFilled', //              some risk matched; the remainder is still open/matchable
  'filled', //                       fully matched → a position
  'expired', //                      past its expiry — dead on chain, headroom released
  'authoritativelyInvalidated', //   on-chain cancelCommitment or a nonce-floor raise landed — headroom released
] as const;
export type CommitmentLifecycle = (typeof COMMITMENT_LIFECYCLE_STATES)[number];

/**
 * A position's status — a (cached) view of the SDK's lifecycle. The runner
 * reconciles this from `positions.status` (chain is truth). The terminal triple
 * `claimed` / `settledLost` / `void` stays DISTINCT (own-state SSE plan A7): a
 * claimed win, a settled loss, and a voided contest are different zero/positive
 * payout terminals, not interchangeable. `settledLost` / `void` enter only via
 * the canonical `positionStatus` mapper (`src/reducers/owner-mapping.ts`) — the
 * poll path and the audit-only shadow never produce them (the shadow collapses
 * them to `claimed`).
 */
export const MAKER_POSITION_STATUSES = [
  'active', //                       the speculation is still open
  'pendingSettle', //                scored but not yet settled
  'claimable', //                    settled, this side won, not yet claimed
  'claimed', //                      claimed a winning payout
  'settledLost', //                  settled, this side lost — terminal, zero payout, nothing to claim
  'void', //                         contest voided — terminal, stake returned, distinct from a loss
] as const;
export type MakerPositionStatus = (typeof MAKER_POSITION_STATUSES)[number];

/**
 * The terminal position statuses — no further on-chain transition is possible
 * and the maker has NO remaining live exposure: `claimed` (won + collected),
 * `settledLost` (loss realized, stake gone), `void` (stake returned). Every
 * exposure / inventory accounting site that excludes settled positions must
 * exclude this whole set, not just `claimed` — keep them deriving the
 * "is this position done?" signal from {@link isTerminalPositionStatus} so a
 * future status addition forces a single re-audit here rather than silently
 * over-counting at each call site.
 */
export const TERMINAL_POSITION_STATUSES: ReadonlySet<MakerPositionStatus> = new Set(['claimed', 'settledLost', 'void']);

/** Whether a position is in a terminal, zero-live-exposure state — see {@link TERMINAL_POSITION_STATUSES}. */
export function isTerminalPositionStatus(status: MakerPositionStatus): boolean {
  return TERMINAL_POSITION_STATUSES.has(status);
}

/** Which side of a contest a maker item is on (mirrors `src/risk/`'s `MakerSide`). */
export type MakerSide = 'away' | 'home';

/** The wager's market type (mirrors the SDK's `MarketType`; defined locally to keep the state layer decoupled). Persisted on commitment / position records so the risk engine can key exposure per market without re-deriving it from the `scorer` address. */
export const MARKET_TYPES = ['moneyline', 'spread', 'total'] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

// ── signed payload (own-state SSE plan §M6) ──────────────────────────────────

/**
 * Disk-friendly form of {@link SignedCommitmentPayload}. The protocol-canonical
 * type the SDK returns from `submitRaw` / `submitPrepared` (and consumes on
 * `cancelOnchainSigned`) uses `bigint` for `contestId` / `riskAmount` / `nonce`
 * / `expiry`, which `JSON.stringify` rejects. The MM persists those four fields
 * as decimal strings — same convention as the existing `riskAmountWei6`
 * etc. — and the {@link toMakerSignedPayload} / {@link toSdkSignedPayload}
 * helpers below bridge the two shapes at the submit / cancel boundaries.
 *
 * Stored verbatim on `MakerCommitmentRecord.signedPayload` so the cancel paths
 * can authoritatively cancel a book-hidden row WITHOUT round-tripping the
 * public commitments API (which, post v0.5.0/M2 redaction, refuses to leak the
 * signed payload for `book_visible=false` rows). The 9 EIP-712 fields plus
 * `commitmentHash` + `signature` are exactly what
 * `MatchingModule.cancelCommitment` needs.
 */
export interface MakerSignedPayload {
  commitmentHash: string;
  commitment: {
    maker: string;
    /** uint256 as decimal string. */
    contestId: string;
    scorer: string;
    lineTicks: number;
    positionType: 0 | 1;
    oddsTick: number;
    /** uint256 wei6 as decimal string. */
    riskAmount: string;
    /** uint256 as decimal string. */
    nonce: string;
    /** uint256 (unix seconds) as decimal string. */
    expiry: string;
  };
  signature: string;
}

/**
 * Whether {@link MakerCommitmentRecord.signedPayload} is populated.
 *
 * - `'present'`: the record was submitted under v0.5.1+ (M6/A) — the canonical
 *   signed bundle was captured on `submitQuote` and is available for
 *   `cancelOnchainSigned`. Cancel paths use the local payload, NO public API
 *   fetch.
 * - `'missing-legacy'`: the record predates M6/A (loaded from an older state
 *   file, OR a dry-run synthetic commitment that never went on chain). Cancel
 *   paths fall back to the SDK's `cancelOnchain({ hash })` for *visible* rows
 *   (the SDK fetches + reconstructs from the public API), but for *hidden*
 *   rows (`lifecycle === 'softCancelled'`) there is no recovery path in M6/A
 *   scope: the cancel is BLOCKED, telemetry fires
 *   (`cancel-blocked-missing-payload`), and operator action is required.
 *   Owner-auth `ownState.getCommitment` recovery is queued for Phase 2 when
 *   the snapshot is already in flight.
 */
export const SIGNED_PAYLOAD_STATUSES = ['present', 'missing-legacy'] as const;
export type SignedPayloadStatus = (typeof SIGNED_PAYLOAD_STATUSES)[number];

/**
 * Convert the SDK's canonical {@link SignedCommitmentPayload} (bigints) to the
 * MM's on-disk {@link MakerSignedPayload} (decimal strings). Called by
 * `submitQuote` after a successful submit — the bundle is captured verbatim
 * (no hashing / re-signing) for round-trip-safe persistence.
 */
export function toMakerSignedPayload(p: SignedCommitmentPayload): MakerSignedPayload {
  return {
    commitmentHash: p.commitmentHash,
    commitment: {
      maker: p.commitment.maker,
      contestId: p.commitment.contestId.toString(),
      scorer: p.commitment.scorer,
      lineTicks: p.commitment.lineTicks,
      positionType: p.commitment.positionType,
      oddsTick: p.commitment.oddsTick,
      riskAmount: p.commitment.riskAmount.toString(),
      nonce: p.commitment.nonce.toString(),
      expiry: p.commitment.expiry.toString(),
    },
    signature: p.signature,
  };
}

/**
 * Convert a persisted {@link MakerSignedPayload} (decimal strings) back to the
 * SDK's canonical {@link SignedCommitmentPayload} (bigints) for
 * `cancelOnchainSigned`. The decimal-string fields were last validated at
 * state-load time ({@link validateMakerSignedPayload}); `BigInt(...)` would
 * still throw on a corrupt value, but the validator's regex already excluded
 * that.
 */
export function toSdkSignedPayload(p: MakerSignedPayload): SignedCommitmentPayload {
  return {
    commitmentHash: p.commitmentHash as Hex,
    commitment: {
      maker: p.commitment.maker as Hex,
      contestId: BigInt(p.commitment.contestId),
      scorer: p.commitment.scorer as Hex,
      lineTicks: p.commitment.lineTicks,
      positionType: p.commitment.positionType,
      oddsTick: p.commitment.oddsTick,
      riskAmount: BigInt(p.commitment.riskAmount),
      nonce: BigInt(p.commitment.nonce),
      expiry: BigInt(p.commitment.expiry),
    },
    signature: p.signature as Hex,
  };
}

/**
 * The cancel-path dispatch for one {@link MakerCommitmentRecord} — what the
 * runner / CLI should hand to {@link OspexAdapter.cancelCommitmentOnchain},
 * or `blocked-missing-payload` if the record is unreachable via any cancel
 * path the MM owns. Centralized here so all three on-chain cancel call sites
 * (`onchainCancelCommitment`, `onchainKillCancel`, `cli/cancel-stale.ts`)
 * route identically — own-state SSE plan §M6.
 *
 * Decision tree:
 * 1. `signedPayloadStatus === 'present'` → use the captured signed bundle.
 *    Skips every public API fetch — works for any `book_visible` state, which
 *    is the whole point of M6.
 * 2. `signedPayloadStatus === 'missing-legacy'` AND `lifecycle === 'softCancelled'`
 *    (book-hidden) → BLOCKED. The public commitments API redacts the signed
 *    fields for hidden rows (M2), so `cancelOnchain({ hash })` would refuse.
 *    No local payload, no own-state snapshot recovery in M6/A scope.
 *    The cancel is unreachable until the operator manually recovers the
 *    payload via owner-auth own-state (Phase 2) or the commitment expires.
 * 3. `signedPayloadStatus === 'missing-legacy'` AND any other lifecycle
 *    (visible: `visibleOpen` / `partiallyFilled`) → use the bare hash; the
 *    SDK's `cancelOnchain({ hash })` fetches the visible row from the public
 *    API and reconstructs the signed bundle there. The migration fallback.
 */
export type CancelDispatch =
  | { kind: 'use-signed-payload'; payload: SignedCommitmentPayload }
  | { kind: 'use-hash'; hash: Hex }
  | { kind: 'blocked-missing-payload' };

/**
 * Compute the {@link CancelDispatch} for `record`. Pure — returns the dispatch
 * shape; the caller is responsible for the actual `adapter.cancelCommitmentOnchain`
 * call (or the blocked-telemetry emit). See {@link CancelDispatch} for the
 * decision tree.
 */
export function dispatchCancel(record: MakerCommitmentRecord): CancelDispatch {
  if (record.signedPayloadStatus === 'present' && record.signedPayload !== undefined) {
    return { kind: 'use-signed-payload', payload: toSdkSignedPayload(record.signedPayload) };
  }
  if (record.lifecycle === 'softCancelled') {
    return { kind: 'blocked-missing-payload' };
  }
  return { kind: 'use-hash', hash: record.hash as Hex };
}

// ── fill history (own-state SSE plan §2.5.3 / Phase 2 PR1) ───────────────────

/**
 * One observed on-chain fill for the maker — appended to
 * {@link MakerCommitmentRecord.fills} when the SSE `fill` reducer applies it.
 * This is an append-only audit/history record of observed fills; the runtime
 * dedup of overlap re-deliveries is keyed on `(txHash, logIndex)` (see
 * {@link fillDedupKey}) in the in-memory dedup set, NOT reconstructed from this
 * array. (own-state-sse-plan §2.5.3 proposed a cold-start reconstruction from
 * `fills[]`; it was removed as dead-in-practice — the first `onReady` re-grounds
 * from a fresh snapshot that already subsumes prior fills.)
 *
 * Per Phase 2 plan PR1 (Hermes-endorsed Q1): the **poll path does NOT append**
 * to this array. Commitment-diff observations don't carry `(txHash, logIndex)`.
 * Fills accumulate here only when Phase 2 PR4's owner-fill reducer applies an
 * SSE `fill` event.
 */
export interface MakerCommitmentFill {
  /** The matching transaction hash that produced this fill (`0x`-prefixed hex). */
  txHash: string;
  /** The log index within the tx (non-negative integer). */
  logIndex: number;
  /** The amount of this fill in USDC wei6 (decimal string). NOT the post-fill cumulative. */
  amountWei6: string;
  /** Unix seconds when the MM observed and applied this fill. */
  ts: number;
}

/**
 * The canonical dedup key for a fill event — the pair `(txHash, logIndex)`
 * uniquely identifies an on-chain `Match` log event in the protocol. Used by the
 * SSE `fill` reducer (Phase 2 PR4) to dedup overlap re-deliveries. Stable, no
 * escaping concerns (both fields are constrained shape).
 */
export function fillDedupKey(txHash: string, logIndex: number): string {
  return `${txHash}:${logIndex}`;
}

// ── records ──────────────────────────────────────────────────────────────────

/** One posted commitment, tracked by its EIP-712 hash. */
export interface MakerCommitmentRecord {
  /** EIP-712 commitment hash — also the key under `MakerState.commitments`. */
  hash: string;
  speculationId: string;
  contestId: string;
  /** The contest's sport (e.g. `"mlb"`) — denormalized so the risk engine's per-sport cap doesn't need a contest re-fetch, and so the state is self-describing. */
  sport: string;
  /** The away team's name — denormalized for the per-team cap + telemetry. */
  awayTeam: string;
  /** The home team's name — denormalized for the per-team cap + telemetry. */
  homeTeam: string;
  /** The scorer module the wager points at (a moneyline scorer address in v0). */
  scorer: string;
  /** The wager's market type — denormalized (it's implied by `scorer`, but stored so the risk engine keys exposure per market without a scorer→market lookup). Migrated to `'moneyline'` on records from a pre-this-field state file. */
  marketType: MarketType;
  /** The speculation's line in away-perspective ticks (10×-scaled): `0` for moneyline (no line), the spread / total line otherwise. Denormalized from the on-chain commitment. Migrated to `0` on legacy records (all of which are moneyline). */
  lineTicks: number;
  /** Which side the maker is on — if this side loses, the maker loses the at-risk amount. */
  makerSide: MakerSide;
  /** uint16 odds tick the commitment was posted at. */
  oddsTick: number;
  /** The commitment's risk in USDC 6-decimal wei units, as a decimal string. */
  riskAmountWei6: string;
  /** For `partiallyFilled`: risk matched so far (USDC wei6, decimal string). `"0"` otherwise. */
  filledRiskWei6: string;
  lifecycle: CommitmentLifecycle;
  /** Unix seconds. After this the commitment is dead on chain even if `softCancelled`. */
  expiryUnixSec: number;
  /** Unix seconds — when this commitment was posted. */
  postedAtUnixSec: number;
  /** Unix seconds — when `lifecycle` last changed. */
  updatedAtUnixSec: number;
  /**
   * The signed bundle the SDK returned from `submitRaw` (M6/A, own-state SSE
   * plan §M6) — captured at submit time so cancel paths can use
   * `cancelOnchainSigned(payload)` instead of round-tripping the public API
   * (which redacts the signed payload for book-hidden rows post M2). Absent on
   * dry-run records (no signing happened) and on records loaded from a pre-
   * M6/A state file (the migration case). The {@link signedPayloadStatus}
   * discriminant is authoritative.
   */
  signedPayload?: MakerSignedPayload;
  /**
   * Whether {@link signedPayload} is populated for this record. `'present'`
   * iff the record was captured under v0.5.1+ on a live submit; otherwise
   * `'missing-legacy'` (dry-run synthetic, or a record from an older state
   * file). Cancel paths dispatch on this discriminant — see
   * {@link SIGNED_PAYLOAD_STATUSES}.
   */
  signedPayloadStatus: SignedPayloadStatus;
  /**
   * Observed on-chain fills against this commitment, append-only, in arrival
   * order. The `(txHash, logIndex)` pair is the canonical dedup key — see
   * {@link MakerCommitmentFill} and {@link fillDedupKey}. Populated by Phase
   * 2's SSE `fill` reducer (PR4); the poll path does NOT append to this array
   * (no `txHash` available, synthetic entries provide no protective value).
   *
   * Pre-Phase-2-PR1 state files load with `fills: []` via the validator's
   * migration default; legacy records (no field present) and new records
   * without observed fills are indistinguishable on disk.
   */
  fills: MakerCommitmentFill[];
}

/** One position the maker holds (one side of a matched pair on a speculation). */
export interface MakerPositionRecord {
  speculationId: string;
  contestId: string;
  /** The contest's sport (e.g. `"mlb"`) — denormalized so the risk engine's per-sport cap doesn't need a contest re-fetch. */
  sport: string;
  /** The away team's name — denormalized for the per-team cap + telemetry. */
  awayTeam: string;
  /** The home team's name — denormalized for the per-team cap + telemetry. */
  homeTeam: string;
  /** The maker's side — loses this stake if this side loses. */
  side: MakerSide;
  /** The maker's own staked risk (USDC wei6, decimal string). */
  riskAmountWei6: string;
  /** The counterparty's staked risk (USDC wei6, decimal string). Settlement pays the winner `1 + counterparty/own` in decimal terms. */
  counterpartyRiskWei6: string;
  status: MakerPositionStatus;
  /**
   * The position's settled outcome from the API's `ClaimablePositionView.result`
   * — captured during the position-status poll once the API view advances to
   * `pendingSettle` or `claimable`. Absent on `active` positions (the contest
   * hasn't settled), and on records loaded from older state files (the field
   * was added as an optional in PR (g-iii-a) — `undefined` flows through the
   * validator). Used to disambiguate `won` / `push` / `void` at claim time and
   * is included in the `claim` telemetry event payload so the summary walker
   * can classify the position without depending on a `settle` event being in
   * the same `--since` window.
   */
  result?: 'won' | 'push' | 'void';
  /** Unix seconds — when `status` last changed. */
  updatedAtUnixSec: number;
}

/** Running P&L. `realized` over settled/claimed positions; `unrealized` over active positions marked to current fair. Signed decimal strings (a leading `-` for a loss). */
export interface PnlSnapshot {
  realizedUsdcWei6: string;
  unrealizedUsdcWei6: string;
  /** Unix seconds — when this snapshot was computed. */
  asOfUnixSec: number;
}

/** A day's gas / fee spend, keyed by `YYYY-MM-DD` (UTC) under `MakerState.dailyCounters`. */
export interface DailyCounters {
  /** POL gas spent that day, in 18-decimal wei (decimal string). */
  gasPolWei: string;
  /** Protocol fees paid that day, in USDC wei6 (decimal string). Genuinely `"0"` in v0 — no lazy creation (DESIGN §6). */
  feeUsdcWei6: string;
}

export const MAKER_STATE_VERSION = 1;

/** The whole persisted blob. */
export interface MakerState {
  version: number;
  /** The `runId` of the run that last wrote this state — used to scope a telemetry-replay reconstruction after a loss. */
  lastRunId: string | null;
  /** Posted commitments, keyed by EIP-712 hash. */
  commitments: Record<string, MakerCommitmentRecord>;
  /** Positions, keyed by `<speculationId>:<side>`. */
  positions: Record<string, MakerPositionRecord>;
  pnl: PnlSnapshot;
  /** Daily POL-gas / fee counters, keyed by `YYYY-MM-DD` (UTC). */
  dailyCounters: Record<string, DailyCounters>;
  /** ISO-8601 — when this state was last flushed. `null` for a never-flushed (fresh) state. */
  lastFlushedAt: string | null;
}

export function emptyMakerState(): MakerState {
  return {
    version: MAKER_STATE_VERSION,
    lastRunId: null,
    commitments: {},
    positions: {},
    pnl: { realizedUsdcWei6: '0', unrealizedUsdcWei6: '0', asOfUnixSec: 0 },
    dailyCounters: {},
    lastFlushedAt: null,
  };
}

// ── load / persist ───────────────────────────────────────────────────────────

/**
 * How a state load went — the input to the boot-time fail-safe (DESIGN §12).
 *
 * - `fresh` — no state file. First run; nothing to lose; quote freely.
 * - `loaded` — a state file parsed cleanly. Resume from it (the runner reconciles
 *   the rebuildable parts against chain/API).
 * - `lost` — a state file existed but was unreadable / not valid JSON / failed the
 *   schema check. A prior run may have left soft-cancelled-but-still-matchable
 *   commitments we no longer know about → the fail-safe applies.
 */
export type StateLoadStatus =
  | { kind: 'fresh' }
  | { kind: 'loaded' }
  | { kind: 'lost'; reason: string };

export interface StateLoadResult {
  /** A usable state — the loaded one for `loaded`, an empty one for `fresh` / `lost`. */
  state: MakerState;
  status: StateLoadStatus;
}

const STATE_FILE = 'maker-state.json';
const STATE_TMP = 'maker-state.json.tmp';

/**
 * The on-disk state store: a single JSON file under `dir`, written atomically
 * (write a temp file, then `rename` it over the target). NOT multi-process safe —
 * one MM per directory (DESIGN §12).
 */
export class StateStore {
  readonly dir: string;
  private constructor(dir: string) {
    this.dir = dir;
  }

  static at(dir: string): StateStore {
    return new StateStore(dir);
  }

  /** Absolute-ish path of the state file (for diagnostics — e.g. `ospex-mm doctor`). */
  get statePath(): string {
    return join(this.dir, STATE_FILE);
  }

  /**
   * Load the state, classifying the outcome for the fail-safe. **Never throws** —
   * an unreadable / garbled / schema-mismatched file is reported as `lost` (not an
   * exception) so the boot path can apply `assessStateLoss` rather than crash.
   */
  load(): StateLoadResult {
    const path = this.statePath;
    if (!existsSync(path)) return { state: emptyMakerState(), status: { kind: 'fresh' } };

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      return { state: emptyMakerState(), status: { kind: 'lost', reason: `state file is unreadable: ${(err as Error).message}` } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { state: emptyMakerState(), status: { kind: 'lost', reason: `state file is not valid JSON: ${(err as Error).message}` } };
    }

    const validated = validateMakerState(parsed);
    if (!validated.ok) {
      return { state: emptyMakerState(), status: { kind: 'lost', reason: `state file failed validation: ${validated.reason}` } };
    }
    return { state: validated.state, status: { kind: 'loaded' } };
  }

  /**
   * Persist `state` atomically (temp file → `rename`). Creates `dir` if needed;
   * stamps `lastFlushedAt`. Pretty-printed for human inspection.
   *
   * The persisted blob carries the maker's signed EIP-712 commitment payloads
   * (M6/A) — the same signing material `MatchingModule.matchCommitment` needs
   * to fill the commitment — so the temp file is created at `0o600` (owner
   * read/write only) **at creation time**, not chmod'd after the fact. The
   * `O_WRONLY|O_CREAT|O_EXCL` (`flag: 'wx'`) sequence below makes the mode
   * apply at the kernel-level `open` syscall, so there's no window between
   * "file exists" and "file is locked down" for a concurrent reader to
   * observe (Hermes PR #64 round 1).
   *
   * Three guarantees:
   * 1. **No stale-temp inheritance** — if a prior crash left the temp at a
   *    permissive mode, `writeFileSync` on the existing file would silently
   *    keep the old mode (Node's `mode` option only applies when creating).
   *    We `unlinkSync` first; `wx` then creates a fresh inode at `0o600`.
   * 2. **Fresh mode from birth** — `mode: 0o600` is applied via `O_CREAT`. The
   *    process umask cannot widen owner-only bits (`0o600 & ~umask = 0o600`
   *    for every conceivable umask), so the file lands at exactly `0o600`.
   * 3. **POSIX sanity check** — some filesystems (FAT, certain network mounts)
   *    silently drop mode bits even on Linux. We `statSync` after creation
   *    and throw if the mode isn't `0o600`; the partial temp is unlinked
   *    before throwing so the next flush can retry. **No silent fallback to
   *    a weak-mode publish.** Operators must host `state.dir` on a
   *    permission-aware filesystem; `OPERATOR_SAFETY.md` calls this out.
   *
   * Windows: `mode` bits don't map to ACLs, so the sanity check is skipped
   * and the operator is responsible for restricting the parent-directory ACL
   * (`OPERATOR_SAFETY.md`).
   */
  flush(state: MakerState): void {
    mkdirSync(this.dir, { recursive: true });
    const out: MakerState = { ...state, version: MAKER_STATE_VERSION, lastFlushedAt: new Date().toISOString() };
    const tmp = join(this.dir, STATE_TMP);

    // Remove a stale temp file from a prior crash. Without this, the next
    // writeFileSync would land on an existing file and ignore our mode
    // option, publishing the new contents at the OLD mode (Hermes #64 r1).
    // ENOENT is fine — the common case (no prior crash). Any other error
    // (permissions, busy) is fatal: better to fail the flush than to leave
    // signing material on a weak-mode file.
    try {
      unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // `flag: 'wx'` = O_WRONLY|O_CREAT|O_EXCL → throw on exists. Paired with
    // the unlink above, this races safely: if the unlink succeeded the
    // create is fresh; if someone else creates the temp between our unlink
    // and write (multi-MM-per-dir, which the boot-time `state.dir` lock in
    // `lock.ts` now refuses — DESIGN §12), we fail loudly rather than
    // truncating their file.
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    // POSIX-only sanity check. On a filesystem that supports POSIX modes,
    // mode 0o600 is what the kernel applied — but if the filesystem dropped
    // the bits silently (FAT, some network mounts) we'd be about to publish
    // signing material at a weak mode. Fail closed.
    if (platform !== 'win32') {
      const stats = statSync(tmp);
      const actualMode = stats.mode & 0o777;
      if (actualMode !== 0o600) {
        // Clean up the bad-mode temp before throwing so a retry can succeed.
        try {
          unlinkSync(tmp);
        } catch {
          // Best-effort — the throw below is the real signal.
        }
        throw new Error(
          `StateStore.flush: temp file landed at mode 0o${actualMode.toString(8).padStart(3, '0')}; required 0o600. The filesystem under state.dir may not support POSIX permissions (FAT / certain network mounts). Persisted state carries EIP-712 signing material — host state.dir on a permission-aware filesystem (own-state SSE plan §M6/B).`,
        );
      }
    }

    // `rename` over an existing file is atomic on POSIX and works on Windows
    // (Node handles the replace). POSIX preserves the source's mode across
    // the rename, so the live statePath lands at 0o600 too.
    renameSync(tmp, this.statePath);
  }
}

// ── shallow-but-fail-closed validation ───────────────────────────────────────
//
// Deep per-field reconciliation is the runner's job (chain is truth). This check
// is just "is this plausibly *our* state file, intact?" — anything that isn't
// (truncated/garbled past a clean JSON.parse, an older/newer schema, a malformed
// record) is treated as `lost` rather than trusted, because trusting a partial
// soft-cancelled set under-counts latent exposure (DESIGN §12).

type Validated = { ok: true; state: MakerState } | { ok: false; reason: string };

function validateMakerState(parsed: unknown): Validated {
  if (!isPlainObject(parsed)) return fail('top-level value is not a plain object');
  if (parsed.version !== MAKER_STATE_VERSION) {
    return fail(`unsupported state version ${describe(parsed.version)} (this MM writes version ${MAKER_STATE_VERSION})`);
  }
  if (!isPlainObject(parsed.commitments)) return fail('`commitments` is not an object');
  if (!isPlainObject(parsed.positions)) return fail('`positions` is not an object');
  if (!isPlainObject(parsed.dailyCounters)) return fail('`dailyCounters` is not an object');
  if (!isPlainObject(parsed.pnl)) return fail('`pnl` is not an object');

  const commitments: Record<string, MakerCommitmentRecord> = {};
  for (const [key, value] of Object.entries(parsed.commitments)) {
    const c = validateCommitmentRecord(key, value);
    if (!c.ok) return fail(`commitments["${key}"]: ${c.reason}`);
    commitments[key] = c.record;
  }

  const positions: Record<string, MakerPositionRecord> = {};
  for (const [key, value] of Object.entries(parsed.positions)) {
    const p = validatePositionRecord(value);
    if (!p.ok) return fail(`positions["${key}"]: ${p.reason}`);
    positions[key] = p.record;
  }

  const dailyCounters: Record<string, DailyCounters> = {};
  for (const [key, value] of Object.entries(parsed.dailyCounters)) {
    if (!isPlainObject(value) || !isDecimalString(value.gasPolWei) || !isDecimalString(value.feeUsdcWei6)) {
      return fail(`dailyCounters["${key}"] is malformed`);
    }
    dailyCounters[key] = { gasPolWei: value.gasPolWei, feeUsdcWei6: value.feeUsdcWei6 };
  }

  const pnl = parsed.pnl;
  if (!isSignedDecimalString(pnl.realizedUsdcWei6) || !isSignedDecimalString(pnl.unrealizedUsdcWei6) || !isNonNegInt(pnl.asOfUnixSec)) {
    return fail('`pnl` is malformed');
  }

  // NOTE: a legacy state file may carry an `ownStateCursor` key (the pre-cold-
  // restart-retirement resume cursor) — like any other unknown key it is simply
  // not picked up here. Process restarts always cold-start the own-state stream
  // from a fresh snapshot, so there is nothing to resume.
  return {
    ok: true,
    state: {
      version: MAKER_STATE_VERSION,
      lastRunId: typeof parsed.lastRunId === 'string' ? parsed.lastRunId : null,
      commitments,
      positions,
      pnl: { realizedUsdcWei6: pnl.realizedUsdcWei6, unrealizedUsdcWei6: pnl.unrealizedUsdcWei6, asOfUnixSec: pnl.asOfUnixSec },
      dailyCounters,
      lastFlushedAt: typeof parsed.lastFlushedAt === 'string' ? parsed.lastFlushedAt : null,
    },
  };
}

function validateCommitmentRecord(
  key: string,
  value: unknown,
): { ok: true; record: MakerCommitmentRecord } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  if (value.hash !== key) return { ok: false, reason: `hash field ${describe(value.hash)} does not match its key` };
  if (typeof value.speculationId !== 'string' || typeof value.contestId !== 'string' || typeof value.scorer !== 'string') {
    return { ok: false, reason: 'speculationId / contestId / scorer must be strings' };
  }
  if (typeof value.sport !== 'string' || typeof value.awayTeam !== 'string' || typeof value.homeTeam !== 'string') {
    return { ok: false, reason: 'sport / awayTeam / homeTeam must be strings' };
  }
  if (value.makerSide !== 'away' && value.makerSide !== 'home') return { ok: false, reason: `makerSide ${describe(value.makerSide)} is not "away"/"home"` };
  if (!isOddsTick(value.oddsTick)) return { ok: false, reason: `oddsTick ${describe(value.oddsTick)} is not an integer in the protocol's [${MIN_ODDS_TICK}, ${MAX_ODDS_TICK}] range` };
  if (!isDecimalString(value.riskAmountWei6) || !isDecimalString(value.filledRiskWei6)) return { ok: false, reason: 'riskAmountWei6 / filledRiskWei6 must be decimal strings' };
  if (BigInt(value.riskAmountWei6) < BigInt(value.filledRiskWei6)) return { ok: false, reason: `filledRiskWei6 (${value.filledRiskWei6}) exceeds riskAmountWei6 (${value.riskAmountWei6}) — impossible; a fill cannot exceed the commitment` };
  if (!(COMMITMENT_LIFECYCLE_STATES as readonly string[]).includes(value.lifecycle as string)) {
    return { ok: false, reason: `lifecycle ${describe(value.lifecycle)} is not a known state` };
  }
  if (!isNonNegInt(value.expiryUnixSec) || !isNonNegInt(value.postedAtUnixSec) || !isNonNegInt(value.updatedAtUnixSec)) {
    return { ok: false, reason: 'expiryUnixSec / postedAtUnixSec / updatedAtUnixSec must be non-negative integers' };
  }
  // signedPayload + signedPayloadStatus (M6/A — own-state SSE plan §M6).
  // Migration: a record from a pre-M6/A state file has neither field — accept
  // and downgrade to 'missing-legacy' (the discriminant tells cancel paths to
  // route around the missing bundle). The status / payload pair MUST be
  // consistent — `'present'` requires a structurally-valid payload, and a
  // `'missing-legacy'` record must NOT carry a payload (that would be an
  // internal inconsistency: the bundle exists but the record claims it
  // doesn't, which would silently hide an authoritative cancel path).
  const hasStatus = value.signedPayloadStatus !== undefined;
  const hasPayload = value.signedPayload !== undefined;
  let signedPayloadStatus: SignedPayloadStatus;
  let signedPayload: MakerSignedPayload | undefined;
  if (!hasStatus && !hasPayload) {
    // Legacy state file (pre-M6/A) — accept and downgrade.
    signedPayloadStatus = 'missing-legacy';
    signedPayload = undefined;
  } else {
    if (!hasStatus) return { ok: false, reason: 'signedPayload is set but signedPayloadStatus is missing (record is from M6/A or later — both fields must be present together)' };
    if (typeof value.signedPayloadStatus !== 'string' || !(SIGNED_PAYLOAD_STATUSES as readonly string[]).includes(value.signedPayloadStatus)) {
      return { ok: false, reason: `signedPayloadStatus ${describe(value.signedPayloadStatus)} is not a known status (expected ${SIGNED_PAYLOAD_STATUSES.map((s) => `"${s}"`).join(' or ')})` };
    }
    signedPayloadStatus = value.signedPayloadStatus as SignedPayloadStatus;
    if (signedPayloadStatus === 'present') {
      if (!hasPayload) return { ok: false, reason: 'signedPayloadStatus is "present" but signedPayload is missing' };
      const sp = validateMakerSignedPayload(value.signedPayload);
      if (!sp.ok) return { ok: false, reason: `signedPayload is malformed: ${sp.reason}` };
      // Cross-check: the payload's commitmentHash must equal the record's
      // hash. A drift here means the bundle is for a different commitment —
      // signing it would mark the wrong slot in MatchingModule's
      // s_cancelledCommitments.
      if (sp.payload.commitmentHash !== key) return { ok: false, reason: `signedPayload.commitmentHash ${describe(sp.payload.commitmentHash)} does not match the record hash ${describe(key)}` };
      signedPayload = sp.payload;
    } else {
      // status = 'missing-legacy' — payload MUST be absent.
      if (hasPayload) return { ok: false, reason: 'signedPayloadStatus is "missing-legacy" but signedPayload is set (internal inconsistency — would hide the bundle from cancel paths)' };
      signedPayload = undefined;
    }
  }
  // fills[] (Phase 2 PR1 — own-state SSE plan §2.5.3). Migration: a pre-PR1
  // record has no `fills` field — default to []. Newer records MUST carry a
  // valid array. Each element validated by `validateMakerCommitmentFill`.
  let fills: MakerCommitmentFill[];
  if (value.fills === undefined) {
    fills = [];
  } else if (!Array.isArray(value.fills)) {
    return { ok: false, reason: `fills ${describe(value.fills)} is not an array` };
  } else {
    fills = [];
    for (let i = 0; i < value.fills.length; i++) {
      const f = validateMakerCommitmentFill(value.fills[i]);
      if (!f.ok) return { ok: false, reason: `fills[${i}]: ${f.reason}` };
      fills.push(f.fill);
    }
  }
  // marketType + lineTicks (per-market risk re-key) — a PAIRED migration: both fields were
  // added in the same slice, so a record carries NEITHER (a pre-this-field state file →
  // migrate to the moneyline default; every legacy record is moneyline) or BOTH. Exactly one
  // present is a half-written / hand-edited record → fail closed: normalizing it would
  // produce an inconsistent self-describing shape (spread/0, or moneyline/-15) that the risk
  // re-key would mis-group. When both are present, validate them — including the invariant
  // that moneyline has no line (lineTicks must be 0).
  const hasMarketType = value.marketType !== undefined;
  const hasLineTicks = value.lineTicks !== undefined;
  let marketType: MarketType;
  let lineTicks: number;
  if (!hasMarketType && !hasLineTicks) {
    marketType = 'moneyline';
    lineTicks = 0;
  } else if (hasMarketType !== hasLineTicks) {
    return { ok: false, reason: `marketType and lineTicks must be present together — only ${hasMarketType ? 'marketType' : 'lineTicks'} is set; a partial record is rejected rather than normalized to an inconsistent shape` };
  } else {
    if (typeof value.marketType !== 'string' || !(MARKET_TYPES as readonly string[]).includes(value.marketType)) {
      return { ok: false, reason: `marketType ${describe(value.marketType)} is not a known market type (expected ${MARKET_TYPES.map((m) => `"${m}"`).join(' / ')})` };
    }
    if (typeof value.lineTicks !== 'number' || !Number.isInteger(value.lineTicks)) {
      return { ok: false, reason: `lineTicks ${describe(value.lineTicks)} must be an integer` };
    }
    marketType = value.marketType as MarketType;
    lineTicks = value.lineTicks;
    if (marketType === 'moneyline' && lineTicks !== 0) {
      return { ok: false, reason: `marketType 'moneyline' has no line — lineTicks must be 0, got ${lineTicks}` };
    }
  }
  const record: MakerCommitmentRecord = {
    hash: key,
    speculationId: value.speculationId,
    contestId: value.contestId,
    sport: value.sport,
    awayTeam: value.awayTeam,
    homeTeam: value.homeTeam,
    scorer: value.scorer,
    marketType,
    lineTicks,
    makerSide: value.makerSide,
    oddsTick: value.oddsTick,
    riskAmountWei6: value.riskAmountWei6,
    filledRiskWei6: value.filledRiskWei6,
    lifecycle: value.lifecycle as CommitmentLifecycle,
    expiryUnixSec: value.expiryUnixSec,
    postedAtUnixSec: value.postedAtUnixSec,
    updatedAtUnixSec: value.updatedAtUnixSec,
    signedPayloadStatus,
    fills,
  };
  if (signedPayload !== undefined) record.signedPayload = signedPayload;
  return { ok: true, record };
}

/**
 * Validate a persisted {@link MakerCommitmentFill}. Fail-closed: a malformed
 * fill rejects the entire commitment record (so a corrupt history can't
 * silently coexist with otherwise-valid state). Loose on `txHash` shape
 * (`typeof string`, no hex-length constraint) so the validator accepts both
 * real `0x[64hex]` mainnet tx hashes and shorter test-fixture stubs.
 */
function validateMakerCommitmentFill(
  value: unknown,
): { ok: true; fill: MakerCommitmentFill } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  if (typeof value.txHash !== 'string') return { ok: false, reason: `txHash ${describe(value.txHash)} must be a string` };
  if (!isNonNegInt(value.logIndex)) return { ok: false, reason: `logIndex ${describe(value.logIndex)} must be a non-negative integer` };
  if (!isDecimalString(value.amountWei6)) return { ok: false, reason: `amountWei6 ${describe(value.amountWei6)} must be a non-negative decimal string` };
  if (!isNonNegInt(value.ts)) return { ok: false, reason: `ts ${describe(value.ts)} must be a non-negative integer` };
  return {
    ok: true,
    fill: {
      txHash: value.txHash,
      logIndex: value.logIndex,
      amountWei6: value.amountWei6,
      ts: value.ts,
    },
  };
}

/**
 * Validate a persisted {@link MakerSignedPayload} (decimal-string-encoded
 * bigints, hex-string-encoded addresses + signature). Returns the validated
 * payload on success — does NOT cross-check against the parent record (the
 * caller does the `commitmentHash === record.hash` check). Fail-closed: any
 * malformed field rejects the whole payload.
 */
function validateMakerSignedPayload(
  value: unknown,
): { ok: true; payload: MakerSignedPayload } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  if (typeof value.commitmentHash !== 'string') return { ok: false, reason: 'commitmentHash must be a string' };
  if (typeof value.signature !== 'string') return { ok: false, reason: 'signature must be a string' };
  if (!isPlainObject(value.commitment)) return { ok: false, reason: 'commitment must be an object' };
  const c = value.commitment;
  if (typeof c.maker !== 'string' || typeof c.scorer !== 'string') return { ok: false, reason: 'commitment.maker / commitment.scorer must be strings' };
  if (!isDecimalString(c.contestId)) return { ok: false, reason: `commitment.contestId ${describe(c.contestId)} must be a non-negative decimal string` };
  if (!isDecimalString(c.riskAmount)) return { ok: false, reason: `commitment.riskAmount ${describe(c.riskAmount)} must be a non-negative decimal string` };
  if (!isDecimalString(c.nonce)) return { ok: false, reason: `commitment.nonce ${describe(c.nonce)} must be a non-negative decimal string` };
  if (!isDecimalString(c.expiry)) return { ok: false, reason: `commitment.expiry ${describe(c.expiry)} must be a non-negative decimal string` };
  if (typeof c.lineTicks !== 'number' || !Number.isInteger(c.lineTicks)) return { ok: false, reason: `commitment.lineTicks ${describe(c.lineTicks)} must be an integer` };
  if (c.positionType !== 0 && c.positionType !== 1) return { ok: false, reason: `commitment.positionType ${describe(c.positionType)} must be 0 or 1` };
  if (!isOddsTick(c.oddsTick)) return { ok: false, reason: `commitment.oddsTick ${describe(c.oddsTick)} is not an integer in the protocol's [${MIN_ODDS_TICK}, ${MAX_ODDS_TICK}] range` };
  return {
    ok: true,
    payload: {
      commitmentHash: value.commitmentHash,
      commitment: {
        maker: c.maker,
        contestId: c.contestId,
        scorer: c.scorer,
        lineTicks: c.lineTicks,
        positionType: c.positionType as 0 | 1,
        oddsTick: c.oddsTick,
        riskAmount: c.riskAmount,
        nonce: c.nonce,
        expiry: c.expiry,
      },
      signature: value.signature,
    },
  };
}

function validatePositionRecord(value: unknown): { ok: true; record: MakerPositionRecord } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  if (typeof value.speculationId !== 'string' || typeof value.contestId !== 'string') return { ok: false, reason: 'speculationId / contestId must be strings' };
  if (typeof value.sport !== 'string' || typeof value.awayTeam !== 'string' || typeof value.homeTeam !== 'string') {
    return { ok: false, reason: 'sport / awayTeam / homeTeam must be strings' };
  }
  if (value.side !== 'away' && value.side !== 'home') return { ok: false, reason: `side ${describe(value.side)} is not "away"/"home"` };
  if (!isDecimalString(value.riskAmountWei6) || !isDecimalString(value.counterpartyRiskWei6)) return { ok: false, reason: 'riskAmountWei6 / counterpartyRiskWei6 must be decimal strings' };
  if (!(MAKER_POSITION_STATUSES as readonly string[]).includes(value.status as string)) return { ok: false, reason: `status ${describe(value.status)} is not a known status` };
  if (!isNonNegInt(value.updatedAtUnixSec)) return { ok: false, reason: 'updatedAtUnixSec must be a non-negative integer' };
  // `result` is optional (added in g-iii-a). Reject malformed values rather
  // than silently dropping — fail-closed is the validator's posture.
  let result: 'won' | 'push' | 'void' | undefined;
  if (value.result !== undefined) {
    if (value.result === 'won' || value.result === 'push' || value.result === 'void') {
      result = value.result;
    } else {
      return { ok: false, reason: `result ${describe(value.result)} is not "won"/"push"/"void"` };
    }
  }
  const record: MakerPositionRecord = {
    speculationId: value.speculationId,
    contestId: value.contestId,
    sport: value.sport,
    awayTeam: value.awayTeam,
    homeTeam: value.homeTeam,
    side: value.side,
    riskAmountWei6: value.riskAmountWei6,
    counterpartyRiskWei6: value.counterpartyRiskWei6,
    status: value.status as MakerPositionStatus,
    updatedAtUnixSec: value.updatedAtUnixSec,
  };
  if (result !== undefined) record.result = result;
  return { ok: true, record };
}

// ── boot-time state-loss fail-safe (DESIGN §12) ──────────────────────────────

export interface AssessStateLossOptions {
  /**
   * Whether there's evidence of a *prior run* beyond the state file — in practice,
   * whether `telemetry.logDir` holds any event-log file (use `eventLogsExist` from
   * `src/telemetry/`). This is what separates a genuine first run (no state, no
   * telemetry → quote freely) from state loss (no state *but* prior telemetry → a
   * prior run's soft-cancelled set is gone → hold). A corrupt state file always
   * means a prior run, so this flag doesn't matter there.
   */
  hasPriorTelemetry: boolean;
  /**
   * The operator passed `--ignore-missing-state` — they attest no prior run left
   * an open / soft-cancelled commitment that could still match on chain. Use only
   * after verifying that (block explorer / `ospex commitments list`), or on a
   * genuine first run.
   */
  ignoreMissingStateOverride: boolean;
  /** The configured `orders.expirySeconds` — how long any prior soft-cancelled `fixed-seconds` quote takes to lapse. (Insufficient under `match-time` expiry — there the runner must reconstruct from telemetry or use the override.) */
  expirySeconds: number;
}

export interface StateLossAssessment {
  /**
   * `true` → the runner must NOT resume quoting on a blank slate. It should first
   * try to reconstruct the `softCancelled` set by replaying recent telemetry;
   * failing that, wait `suggestedWaitSeconds` (one full expiry window — only
   * sufficient under `fixed-seconds` expiry) before posting; or proceed only on
   * the explicit operator override.
   */
  holdQuoting: boolean;
  reason: string;
  /** Present only when `holdQuoting` and the simplest mitigation is to wait — seconds for any prior soft-cancelled `fixed-seconds` quote to have lapsed. */
  suggestedWaitSeconds?: number;
}

/**
 * Decide, from a state-load outcome, whether the boot path must hold quoting until
 * it has mitigated the latent-exposure blind spot (DESIGN §12).
 *
 * A *missing* state file is not assumed safe: it's a genuine first run only when
 * there's also no prior telemetry. If state is missing but prior event logs exist,
 * a prior run's `softCancelled` set is gone — hold. A *corrupt* state file always
 * holds. Either hold is lifted by `--ignore-missing-state`. (Edge: if the operator
 * wiped *both* the state and telemetry directories there's no signal of a prior run
 * — this is treated as a first run; after a deliberate wipe that might have left
 * `match-time` quotes still matchable, pass `--ignore-missing-state` only once
 * you've confirmed no prior commitment is still open.)
 *
 * Pure — the runner implements the chosen mitigation (telemetry replay / wait /
 * override); this reports the verdict and the simplest mitigation.
 */
export function assessStateLoss(status: StateLoadStatus, opts: AssessStateLossOptions): StateLossAssessment {
  if (status.kind === 'loaded') return { holdQuoting: false, reason: 'state loaded cleanly' };

  if (status.kind === 'fresh' && !opts.hasPriorTelemetry) {
    return { holdQuoting: false, reason: 'no prior state and no prior telemetry — genuine first run, nothing to under-count' };
  }

  // State is lost: the file is missing but prior telemetry shows a run happened, or the file is present but corrupt.
  const lossDesc =
    status.kind === 'fresh'
      ? 'the state file is missing but prior telemetry shows a prior run — its soft-cancelled set is gone'
      : `state was lost (${status.reason})`;
  if (opts.ignoreMissingStateOverride) {
    return {
      holdQuoting: false,
      reason: `${lossDesc}; --ignore-missing-state was passed — proceeding (latent matchable exposure may be under-counted until any prior soft-cancelled quotes expire)`,
    };
  }
  return {
    holdQuoting: true,
    reason: `${lossDesc} — must not resume quoting on a blank slate (a prior soft-cancelled quote may still be matchable on chain). Reconstruct the soft-cancelled set from telemetry, wait one expiry window, or pass --ignore-missing-state.`,
    suggestedWaitSeconds: opts.expirySeconds,
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** A non-negative-integer wei amount serialized as a decimal string: `"0"`, `"100"`, `"250000"` — no sign, no decimal point, no leading zeros (except `"0"` itself). */
function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
}

/** Like `isDecimalString` but allows a leading `-` (P&L can be negative): `"0"`, `"-5"`, `"123"`. */
function isSignedDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^-?(0|[1-9][0-9]*)$/.test(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** uint16 odds tick within MatchingModule's `[MIN_ODDS, MAX_ODDS]` range: `1.01×` (101) … `101.00×` (10100). */
const MIN_ODDS_TICK = 101;
const MAX_ODDS_TICK = 10_100;
function isOddsTick(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_ODDS_TICK && v <= MAX_ODDS_TICK;
}

function describe(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return typeof v;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
