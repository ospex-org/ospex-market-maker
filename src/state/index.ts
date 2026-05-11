/**
 * Persistent inventory (DESIGN §12) — the MM's local cache of its own commitments,
 * positions, P&L, and daily POL-gas / fee counters, plus the boot-time
 * state-loss fail-safe.
 *
 * One JSON file under `state.dir`, written atomically (temp + rename), pretty-
 * printed so it's human-inspectable. **NOT multi-process safe — one MM per state
 * directory.** Chain / API is truth; on boot the runner loads this file and
 * reconciles the rest against on-chain / API reality — *except* the `softCancelled`
 * set, which is **not** reconstructible from chain/API (an off-chain DELETE pulls a
 * quote from the API but doesn't invalidate the signed payload — a taker holding it
 * can still match it on chain until expiry / on-chain-cancel / nonce-floor raise).
 * So if this file is lost or corrupt, latent matchable exposure is under-counted →
 * the boot-time fail-safe (`assessStateLoss`) holds quoting.
 *
 * Big numbers (risk in USDC 6-decimal wei, gas in POL wei) are stored as decimal
 * strings — same convention as the SDK's AGENT_CONTRACT (they can exceed
 * `Number.MAX_SAFE_INTEGER`). No SDK import here; the runner (Phase 2) is the first
 * real consumer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** A position's status — a (cached) view of the SDK's three-bucket status plus the claimed terminal. The runner reconciles this from `positions.status` (chain is truth). */
export const MAKER_POSITION_STATUSES = [
  'active', //                       the speculation is still open
  'pendingSettle', //                scored but not yet settled
  'claimable', //                    settled, this side won, not yet claimed
  'claimed', //                      claimed (or: a losing side that settled with nothing to claim)
] as const;
export type MakerPositionStatus = (typeof MAKER_POSITION_STATUSES)[number];

/** Which side of a contest a maker item is on (mirrors `src/risk/`'s `MakerSide`). */
export type MakerSide = 'away' | 'home';

// ── records ──────────────────────────────────────────────────────────────────

/** One posted commitment, tracked by its EIP-712 hash. */
export interface MakerCommitmentRecord {
  /** EIP-712 commitment hash — also the key under `MakerState.commitments`. */
  hash: string;
  speculationId: string;
  contestId: string;
  /** The scorer module the wager points at (a moneyline scorer address in v0). */
  scorer: string;
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
}

/** One position the maker holds (one side of a matched pair on a speculation). */
export interface MakerPositionRecord {
  speculationId: string;
  contestId: string;
  /** The maker's side — loses this stake if this side loses. */
  side: MakerSide;
  /** The maker's own staked risk (USDC wei6, decimal string). */
  riskAmountWei6: string;
  /** The counterparty's staked risk (USDC wei6, decimal string). Settlement pays the winner `1 + counterparty/own` in decimal terms. */
  counterpartyRiskWei6: string;
  status: MakerPositionStatus;
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

  /** Persist `state` atomically (temp file → `rename`). Creates `dir` if needed; stamps `lastFlushedAt`. Pretty-printed for human inspection. */
  flush(state: MakerState): void {
    mkdirSync(this.dir, { recursive: true });
    const out: MakerState = { ...state, version: MAKER_STATE_VERSION, lastFlushedAt: new Date().toISOString() };
    const tmp = join(this.dir, STATE_TMP);
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    // `rename` over an existing file is atomic on POSIX and works on Windows (Node handles the replace).
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
  if (value.makerSide !== 'away' && value.makerSide !== 'home') return { ok: false, reason: `makerSide ${describe(value.makerSide)} is not "away"/"home"` };
  if (!isNonNegInt(value.oddsTick)) return { ok: false, reason: 'oddsTick must be a non-negative integer' };
  if (!isDecimalString(value.riskAmountWei6) || !isDecimalString(value.filledRiskWei6)) return { ok: false, reason: 'riskAmountWei6 / filledRiskWei6 must be decimal strings' };
  if (!(COMMITMENT_LIFECYCLE_STATES as readonly string[]).includes(value.lifecycle as string)) {
    return { ok: false, reason: `lifecycle ${describe(value.lifecycle)} is not a known state` };
  }
  if (!isNonNegInt(value.expiryUnixSec) || !isNonNegInt(value.postedAtUnixSec) || !isNonNegInt(value.updatedAtUnixSec)) {
    return { ok: false, reason: 'expiryUnixSec / postedAtUnixSec / updatedAtUnixSec must be non-negative integers' };
  }
  return {
    ok: true,
    record: {
      hash: key,
      speculationId: value.speculationId,
      contestId: value.contestId,
      scorer: value.scorer,
      makerSide: value.makerSide,
      oddsTick: value.oddsTick,
      riskAmountWei6: value.riskAmountWei6,
      filledRiskWei6: value.filledRiskWei6,
      lifecycle: value.lifecycle as CommitmentLifecycle,
      expiryUnixSec: value.expiryUnixSec,
      postedAtUnixSec: value.postedAtUnixSec,
      updatedAtUnixSec: value.updatedAtUnixSec,
    },
  };
}

function validatePositionRecord(value: unknown): { ok: true; record: MakerPositionRecord } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  if (typeof value.speculationId !== 'string' || typeof value.contestId !== 'string') return { ok: false, reason: 'speculationId / contestId must be strings' };
  if (value.side !== 'away' && value.side !== 'home') return { ok: false, reason: `side ${describe(value.side)} is not "away"/"home"` };
  if (!isDecimalString(value.riskAmountWei6) || !isDecimalString(value.counterpartyRiskWei6)) return { ok: false, reason: 'riskAmountWei6 / counterpartyRiskWei6 must be decimal strings' };
  if (!(MAKER_POSITION_STATUSES as readonly string[]).includes(value.status as string)) return { ok: false, reason: `status ${describe(value.status)} is not a known status` };
  if (!isNonNegInt(value.updatedAtUnixSec)) return { ok: false, reason: 'updatedAtUnixSec must be a non-negative integer' };
  return {
    ok: true,
    record: {
      speculationId: value.speculationId,
      contestId: value.contestId,
      side: value.side,
      riskAmountWei6: value.riskAmountWei6,
      counterpartyRiskWei6: value.counterpartyRiskWei6,
      status: value.status as MakerPositionStatus,
      updatedAtUnixSec: value.updatedAtUnixSec,
    },
  };
}

// ── boot-time state-loss fail-safe (DESIGN §12) ──────────────────────────────

export interface AssessStateLossOptions {
  /** The operator passed `--ignore-missing-state` — used only when they know no prior run left open commitments. */
  ignoreMissingStateOverride: boolean;
  /** The configured `orders.expirySeconds` — how long it takes any prior soft-cancelled quote to lapse. */
  expirySeconds: number;
}

export interface StateLossAssessment {
  /**
   * `true` → the runner must NOT resume quoting on a blank slate. It should first
   * try to reconstruct the `softCancelled` set by replaying recent telemetry;
   * failing that, wait `suggestedWaitSeconds` (one full expiry window) before
   * posting; or proceed only on the explicit operator override.
   */
  holdQuoting: boolean;
  reason: string;
  /** Present only when `holdQuoting` and the simplest mitigation is to wait — seconds for any prior soft-cancelled quote to have expired. */
  suggestedWaitSeconds?: number;
}

/**
 * Decide, from a state-load outcome, whether the boot path must hold quoting until
 * it has mitigated the latent-exposure blind spot (DESIGN §12). Pure — the runner
 * implements the chosen mitigation; this just reports the verdict and the simplest
 * one.
 */
export function assessStateLoss(status: StateLoadStatus, opts: AssessStateLossOptions): StateLossAssessment {
  if (status.kind === 'fresh') return { holdQuoting: false, reason: 'no prior state — fresh start, nothing to under-count' };
  if (status.kind === 'loaded') return { holdQuoting: false, reason: 'state loaded cleanly' };
  if (opts.ignoreMissingStateOverride) {
    return {
      holdQuoting: false,
      reason: `state was lost (${status.reason}) but --ignore-missing-state was passed — proceeding; latent matchable exposure may be under-counted until any prior soft-cancelled quotes expire`,
    };
  }
  return {
    holdQuoting: true,
    reason: `state was lost (${status.reason}) — must not resume quoting on a blank slate (a prior soft-cancelled quote may still be matchable on chain); reconstruct the soft-cancelled set from telemetry, or wait one expiry window, or pass --ignore-missing-state`,
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

function describe(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return typeof v;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
