/**
 * The Ospex SDK adapter — the ONLY module that imports `@ospex/sdk`.
 *
 * Wraps the surface the MM needs (contests / speculations / commitments /
 * positions / odds / balances / approvals / health on the read side; submit /
 * cancel / approve / settle / claim on the write side) and maps the SDK's
 * provider-specific wire-field names to neutral MM terms at this boundary
 * (`jsonoddsId` → `referenceGameId`) — DESIGN §16 forbids provider names anywhere
 * else. SDK types that have no provider-name leak (`Commitment`, `PositionStatus`,
 * `BalancesSnapshot`, `MoneylineOdds`, the typed `Ospex*Error` classes, …) are
 * re-exported as-is so downstream callers don't have to reach past this adapter
 * to type a variable or `instanceof`-check an error.
 *
 * Two flavours:
 *   - `createOspexAdapter(config)` — **read-only**: builds the `OspexClient`
 *     *without* a signer. The write wrappers exist but throw `OspexConfigError`
 *     from the SDK on call (no signer / no chain). `doctor`, `quote`, and
 *     `run --dry-run` use this.
 *   - `createLiveOspexAdapter(config, signer)` — **signed**: attaches a
 *     keystore-unlocked signer ({@link unlockKeystoreSigner}), so the write
 *     wrappers work and `makerAddress()` resolves to the signer's address.
 *     `run --live` uses this. (The runner doesn't consume it yet — that wiring
 *     lands in the next Phase-3 slice.)
 *
 * The adapter takes a structurally-typed `OspexClientLike` so tests can pass a
 * minimal fake; the two `create*OspexAdapter` factories are the production path.
 */

import { readFileSync } from 'node:fs';

import {
  DEFAULT_API_URL,
  OspexAllowanceError,
  OspexAPIError,
  OspexChainError,
  OspexClient,
  OspexConfigError,
  OspexError,
  OspexScriptApprovalError,
  OspexSigningError,
  OspexSubscriptionError,
  OspexValidationError,
  getAddresses,
  type ApprovalsSnapshot,
  type BalancesSnapshot,
  type ChainId,
  type Commitment,
  type CommitmentsListOptions,
  type CommitmentStatus,
  type Contest,
  type ContestOddsSnapshot,
  type ContestsListOptions,
  type Hex,
  type MarketType,
  type MoneylineOdds,
  type OddsSnapshot,
  type OddsSubscribeArgs,
  type OddsSubscribeHandlers,
  type OspexClientOptions,
  type OspexAddresses,
  type PositionStatus,
  type Signer,
  type Speculation,
  type SpeculationsListOptions,
  type SpreadOdds,
  type Subscription,
  type TotalOdds,
} from '@ospex/sdk';
// Imported from a subpath, not the package root: the SDK deliberately keeps
// KeystoreSigner (and its ethers + scrypt dependency) off the main entry point.
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';

import type { Config } from '../config/index.js';

// ── SDK passthroughs (no provider-name leak — safe to re-expose as-is) ───────

export type {
  ApprovalsSnapshot,
  BalancesSnapshot,
  ChainId,
  Commitment,
  CommitmentsListOptions,
  CommitmentStatus,
  ContestsListOptions,
  Hex,
  MarketType,
  MoneylineOdds,
  OspexAddresses,
  OspexClientOptions,
  PositionStatus,
  Signer,
  SpeculationsListOptions,
  SpreadOdds,
  Subscription,
  TotalOdds,
};

export {
  OspexAllowanceError,
  OspexAPIError,
  OspexChainError,
  OspexConfigError,
  OspexError,
  OspexScriptApprovalError,
  OspexSigningError,
  OspexSubscriptionError,
  OspexValidationError,
};

// ── neutral views over the SDK shapes that DO leak provider field names ──────

/** A contest, with the SDK's `jsonoddsId` renamed to the neutral `referenceGameId` (DESIGN §16). */
export interface ContestView {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  /** ISO-8601 string. */
  matchTime: string;
  /** `'unverified' | 'verified' | 'scored' | 'voided'` — the SDK widens to `string`; treat anything past `'verified'` as not-quotable. */
  status: string;
  /** The upstream reference game id — `null` when the contest has no upstream linkage (no reference odds reachable). */
  referenceGameId: string | null;
  speculations: SpeculationView[];
}

/** A speculation on a contest. The SDK's `speculationStatus: 0 | 1` is rephrased as `open: boolean` (the magic numbers are opaque); other fields pass through. */
export interface SpeculationView {
  speculationId: string;
  contestId: string;
  marketType: MarketType;
  lineTicks: number | null;
  line: number | null;
  /** True iff the speculation is still taking commitments (SDK `speculationStatus === 0`). */
  open: boolean;
  /**
   * The open/partial commitments on this speculation (the "orderbook" — every
   * maker's, not just ours). Populated by `getContest` (the contest-detail
   * endpoint embeds it) and `getSpeculation` (always present there); absent on
   * `listSpeculations`'s lean rows. The runner reads it for its bounded
   * quote-competitiveness checks (DESIGN §8).
   */
  orderbook?: Commitment[];
}

/** One-shot reference odds for a contest, with the SDK's `jsonoddsId` renamed (DESIGN §16). The inner per-market shapes are pure SDK types (no provider names). */
export interface OddsSnapshotView {
  contestId: string;
  referenceGameId: string | null;
  odds: {
    moneyline: MoneylineOdds | null;
    spread: SpreadOdds | null;
    total: TotalOdds | null;
  };
}

/** Args for `subscribeOdds` — neutral `referenceGameId` (the adapter maps it to the SDK's `jsonoddsId`). */
export interface SubscribeOddsArgs {
  referenceGameId: string;
  market: MarketType;
}

/** A single `onChange` / `onRefresh` payload, with `jsonoddsId` renamed (DESIGN §16). */
export interface OddsUpdateView {
  referenceGameId: string;
  market: MarketType;
  network: string;
  line: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

export interface OddsSubscribeHandlersView {
  onChange: (update: OddsUpdateView) => void;
  onRefresh?: (update: OddsUpdateView) => void;
  onError?: (err: Error) => void;
}

// ── the structural subset of `OspexClient` the adapter uses ──────────────────
//
// Picking from `OspexClient`'s actual types keeps the test fake honest — any
// SDK signature change shows up here as a compile error rather than at runtime.
// The write methods (`submitRaw` / `cancel` / `cancelOnchain` / `raiseMinNonce`
// / `approve` / `getNonceFloor` on commitments; `settleSpeculation` / `claim` /
// `claimAll` on positions) are part of the real client too — they just throw
// `OspexConfigError` when invoked without a signer / `rpcUrl` (i.e. on a
// read-only adapter), which is exactly the SDK's own behaviour.

export type OspexClientLike = {
  contests: Pick<OspexClient['contests'], 'get' | 'list'>;
  speculations: Pick<OspexClient['speculations'], 'list' | 'get'>;
  commitments: Pick<
    OspexClient['commitments'],
    'list' | 'get' | 'submitRaw' | 'cancel' | 'cancelOnchain' | 'raiseMinNonce' | 'approve' | 'getNonceFloor'
  >;
  positions: Pick<OspexClient['positions'], 'status' | 'byAddress' | 'settleSpeculation' | 'claim' | 'claimAll'>;
  balances: Pick<OspexClient['balances'], 'read'>;
  approvals: Pick<OspexClient['approvals'], 'read'>;
  health: Pick<OspexClient['health'], 'check'>;
  odds: OspexClient['odds'];
};

// ── write-method arg/result shapes (derived from the SDK — no deep imports) ───
//
// The SDK doesn't re-export these from its package root and has no `./commitments`
// / `./positions` subpath export, so we derive the shapes from the picked client
// methods. Same honesty guarantee as `OspexClientLike`: an SDK signature change
// breaks compilation here. Callers (the runner, the CLI commands) use these names
// rather than reaching into `@ospex/sdk` themselves.

/** Canonical protocol-tuple submit args. The SDK signs the 9-field EIP-712 commitment, picks the nonce per its in-process strategy unless `nonce` is supplied, and POSTs to `ospex-core-api`. Build for the *protocol maker side* (convert taker-facing quotes via `toProtocolQuote` first — DESIGN §5). */
export type SubmitCommitmentArgs = Parameters<OspexClientLike['commitments']['submitRaw']>[0];
/** `submitCommitment` result — the real commitment hash + the persisted row. */
export type SubmitCommitmentResult = Awaited<ReturnType<OspexClientLike['commitments']['submitRaw']>>;
/** `cancelCommitmentOnchain` result — the tx hash + receipt + the cancelled commitment's hash. */
export type CancelOnchainResult = Awaited<ReturnType<OspexClientLike['commitments']['cancelOnchain']>>;
/** `raiseMinNonce` args — `{ contestId, scorer, lineTicks, newMinNonce }`. */
export type RaiseMinNonceArgs = Parameters<OspexClientLike['commitments']['raiseMinNonce']>[0];
/** `raiseMinNonce` result — the tx hash + receipt. */
export type RaiseMinNonceResult = Awaited<ReturnType<OspexClientLike['commitments']['raiseMinNonce']>>;
/** `readMinNonceFloor` args — `{ maker, contestId, scorer, lineTicks }` (the speculation key is derived from the latter three). */
export type NonceFloorArgs = Parameters<OspexClientLike['commitments']['getNonceFloor']>[0];
/** `approveUSDC` amount — an exact wei6 allowance ceiling, or the literal `'max'` (only with explicit operator opt-in). */
export type ApproveUSDCAmount = Parameters<OspexClientLike['commitments']['approve']>[0];
/** `approveUSDC` result — tx hash, receipt, spender, token, and the amount set. */
export type ApproveResult = Awaited<ReturnType<OspexClientLike['commitments']['approve']>>;
/** `settleSpeculation` args — `{ speculationId }`. */
export type SettleSpeculationArgs = Parameters<OspexClientLike['positions']['settleSpeculation']>[0];
/** `settleSpeculation` result — tx hash, block, receipt, and the decoded `winSide`. */
export type SettleSpeculationResult = Awaited<ReturnType<OspexClientLike['positions']['settleSpeculation']>>;
/** `claimPosition` args — `{ speculationId, positionType }`. */
export type ClaimPositionArgs = Parameters<OspexClientLike['positions']['claim']>[0];
/** `claimPosition` result — tx hash, block, receipt, and the on-chain payout. */
export type ClaimPositionResult = Awaited<ReturnType<OspexClientLike['positions']['claim']>>;
/** `claimAll` args (optional) — `{ address?, opts? }`; address defaults to the signer's. */
export type ClaimAllArgs = NonNullable<Parameters<OspexClientLike['positions']['claimAll']>[0]>;
/** `claimAll` result — per-entry settle+claim outcomes and the swept totals. */
export type ClaimAllResult = Awaited<ReturnType<OspexClientLike['positions']['claimAll']>>;

// ── the adapter ──────────────────────────────────────────────────────────────

export interface OspexAdapterContext {
  chainId: ChainId;
  /** Resolved API URL (caller's `config.apiUrl` if set, else `DEFAULT_API_URL`). */
  apiUrl: string;
  /**
   * The wallet attached when the adapter was built for live (signed) operation —
   * present iff `createLiveOspexAdapter` was used. Absent on a read-only adapter,
   * in which case the write wrappers throw (`OspexConfigError` from the SDK) and
   * `makerAddress()` throws. The underlying `OspexClient` is given the same signer.
   */
  signer?: Signer;
}

/**
 * Wrapper over `@ospex/sdk`. Construct via `createOspexAdapter(config)`
 * (read-only) or `createLiveOspexAdapter(config, signer)` (signed); tests pass an
 * `OspexClientLike` fake to the constructor directly (and a `signer` in the
 * context to exercise the write/live surface).
 */
export class OspexAdapter {
  readonly chainId: ChainId;
  readonly apiUrl: string;
  private readonly signer: Signer | undefined;

  constructor(private readonly client: OspexClientLike, ctx: OspexAdapterContext) {
    this.chainId = ctx.chainId;
    this.apiUrl = ctx.apiUrl;
    this.signer = ctx.signer;
  }

  // ── live-mode identity ────────────────────────────────────────────────

  /** True iff this adapter was built with a signer attached (i.e. via `createLiveOspexAdapter`) — the write wrappers and `makerAddress()` work. */
  isLive(): boolean {
    return this.signer !== undefined;
  }

  /**
   * The maker/operator address — derived from the attached signer. The live-mode
   * maker is *always* the signer's address (`--address` / `readKeystoreAddress`
   * are read-only conveniences for `doctor`, not an identity override). Throws
   * `OspexConfigError` on a read-only adapter (no signer).
   */
  async makerAddress(): Promise<Hex> {
    if (this.signer === undefined) {
      throw new OspexConfigError(
        'OspexAdapter.makerAddress: no signer attached — this is a read-only adapter; build it with createLiveOspexAdapter(config, signer)',
      );
    }
    return this.signer.getAddress();
  }

  // ── contests / speculations ───────────────────────────────────────────

  async getContest(contestId: string): Promise<ContestView> {
    return toContestView(await this.client.contests.get(contestId));
  }

  async listContests(options: ContestsListOptions = {}): Promise<ContestView[]> {
    const contests = await this.client.contests.list(options);
    return contests.map(toContestView);
  }

  async listSpeculations(options: SpeculationsListOptions = {}): Promise<SpeculationView[]> {
    const speculations = await this.client.speculations.list(options);
    return speculations.map(toSpeculationView);
  }

  /**
   * Fetch a single speculation by id, *with its orderbook* — the detail endpoint
   * guarantees `orderbook` is populated (unlike `listSpeculations`'s lean rows).
   * The runner uses this for its bounded quote-competitiveness reads (DESIGN §8):
   * fetch just the one speculation's book, on demand, rather than re-fetching the
   * whole contest each time a market goes dirty.
   */
  async getSpeculation(speculationId: string): Promise<SpeculationView> {
    return toSpeculationView(await this.client.speculations.get(speculationId));
  }

  // ── odds ──────────────────────────────────────────────────────────────

  async getOddsSnapshot(contestId: string): Promise<OddsSnapshotView> {
    return toOddsSnapshotView(await this.client.odds.snapshot(contestId));
  }

  subscribeOdds(args: SubscribeOddsArgs, handlers: OddsSubscribeHandlersView): Promise<Subscription> {
    const sdkArgs: OddsSubscribeArgs = { jsonoddsId: args.referenceGameId, market: args.market };
    // Capture the optional callbacks as locals so the `!== undefined` narrowings flow into the closures.
    const { onChange, onRefresh, onError } = handlers;
    const sdkHandlers: OddsSubscribeHandlers = {
      onChange: (o) => onChange(toOddsUpdateView(o)),
      ...(onRefresh !== undefined ? { onRefresh: (o: OddsSnapshot) => onRefresh(toOddsUpdateView(o)) } : {}),
      ...(onError !== undefined ? { onError } : {}),
    };
    return this.client.odds.subscribe(sdkArgs, sdkHandlers);
  }

  // ── commitments ───────────────────────────────────────────────────────

  /**
   * The maker's currently-matchable commitments — explicit `status` + `limit` per
   * DESIGN §10 + §14 (the Phase-2 fill-detection loop uses this; pass
   * `caps.maxOpenCommitments + buffer` for `limit`).
   */
  async listOpenCommitments(maker: string, limit: number): Promise<Commitment[]> {
    return this.client.commitments.list({ maker, status: ['open', 'partially_filled'], limit });
  }

  async getCommitment(hash: Hex): Promise<Commitment> {
    return this.client.commitments.get(hash);
  }

  // ── positions ─────────────────────────────────────────────────────────

  async getPositionStatus(owner: string): Promise<PositionStatus> {
    return this.client.positions.status(owner);
  }

  // ── balances / approvals / health (signer-free via owner=…) ───────────

  async readBalances(owner: Hex): Promise<BalancesSnapshot> {
    return this.client.balances.read({ owner });
  }

  async readApprovals(owner: Hex): Promise<ApprovalsSnapshot> {
    return this.client.approvals.read({ owner });
  }

  /** Liveness probe. Resolves `true` if the API responds; `false` on any failure — never throws. */
  async checkApiHealth(): Promise<boolean> {
    return this.client.health.check().then(
      () => true,
      () => false,
    );
  }

  // ── address book ──────────────────────────────────────────────────────

  /** The deployed Ospex addresses for the configured chain (`PositionModule`, `MatchingModule`, scorers, …). */
  addresses(): OspexAddresses {
    return getAddresses(this.chainId);
  }

  // ── writes (live only) ────────────────────────────────────────────────
  //
  // Every method here calls an SDK write that needs a signer + `rpcUrl`. On a
  // read-only adapter the SDK throws `OspexConfigError` on the first call — these
  // wrappers don't pre-check (the SDK's error is precise and we'd just be
  // duplicating it). Gas cost annotations below are POL on Polygon.

  /**
   * Sign + POST a commitment — the gasless API-relay path. The SDK signs the
   * 9-field EIP-712 tuple, picks the nonce (`max(onchainFloor, lastInProcess+1,
   * unixSec)` — fine for a single long-running process — unless `args.nonce` is
   * supplied), POSTs to `ospex-core-api` with an idempotency key, retries once on
   * `NONCE_TOO_LOW`, and returns the real commitment hash + the persisted row.
   * `args` is the *protocol maker side* — convert taker-facing quote sides via
   * `toProtocolQuote` before calling (DESIGN §5).
   */
  async submitCommitment(args: SubmitCommitmentArgs): Promise<SubmitCommitmentResult> {
    return this.client.commitments.submitRaw(args);
  }

  /**
   * Off-chain cancel — a signed `CancelCommitment` action + `DELETE
   * /v1/commitments/:hash` (gasless). Visibility-only: removes the row from the
   * open book so takers stop seeing it, but does NOT prevent a taker who already
   * holds the signed payload from matching it on chain. Idempotent server-side.
   * For an authoritative cancel use {@link cancelCommitmentOnchain} /
   * {@link raiseMinNonce}.
   */
  async cancelCommitmentOffchain(hash: Hex): Promise<void> {
    await this.client.commitments.cancel(hash);
  }

  /**
   * On-chain cancel — `MatchingModule.cancelCommitment(struct)` (costs POL).
   * Authoritative: once set, `matchCommitment` reverts with
   * `MatchingModule__CommitmentCancelled`. No `AlreadyCancelled` revert path, so
   * re-cancelling a hash succeeds — don't infer "first cancel" from tx success.
   * Needs all 9 EIP-712 fields populated on the row (indexer-only rows with nulls
   * can't be reconstructed → the SDK throws).
   */
  async cancelCommitmentOnchain(hash: Hex): Promise<CancelOnchainResult> {
    return this.client.commitments.cancelOnchain(hash);
  }

  /**
   * Raise the maker's per-`(maker, speculationKey)` nonce floor on chain
   * (`MatchingModule.raiseMinNonce`, costs POL) — every commitment with `nonce <
   * newMinNonce` becomes unmatchable. Bulk authoritative invalidation for one
   * speculation. `newMinNonce` must strictly exceed the current floor (the SDK
   * maps `NonceMustIncrease` to a typed error).
   */
  async raiseMinNonce(args: RaiseMinNonceArgs): Promise<RaiseMinNonceResult> {
    return this.client.commitments.raiseMinNonce(args);
  }

  /**
   * Read the maker's current on-chain nonce floor for one speculation
   * (`MatchingModule.s_minNonces`) — `0n` when never raised. The chain is
   * canonical; the Supabase mirror (`maker_nonce_floors`) can lag 5–20 s. Used to
   * pick a `newMinNonce` for {@link raiseMinNonce} and for diagnostics. Read-only
   * but needs `rpcUrl` (no signer required).
   */
  async readMinNonceFloor(args: NonceFloorArgs): Promise<bigint> {
    return this.client.commitments.getNonceFloor(args);
  }

  /**
   * Set the maker's USDC allowance for `PositionModule` (costs POL) — the maker's
   * `riskAmount` is pulled from this at match time (`PositionModule.recordFill`).
   * `approve()` *sets* (not adds), so the caller passes the absolute target — in
   * `mode: exact` this is `min(risk-cap ceiling, current wallet USDC)` (DESIGN §6);
   * `'max'` only with explicit operator opt-in (DESIGN §6 — never unlimited by
   * default). The lazy-creation-fee allowance (`TreasuryModule`) is intentionally
   * not wrapped — v0 quotes only existing open speculations, so it's never pulled.
   */
  async approveUSDC(amount: ApproveUSDCAmount): Promise<ApproveResult> {
    return this.client.commitments.approve(amount);
  }

  /**
   * Settle a scored speculation on chain (`SpeculationModule.settleSpeculation`,
   * costs POL) — permissionless, no signing/allowance beyond the tx. Required
   * before any holder can claim. Returns the `winSide` decoded from the
   * `SPECULATION_SETTLED` event.
   */
  async settleSpeculation(args: SettleSpeculationArgs): Promise<SettleSpeculationResult> {
    return this.client.positions.settleSpeculation(args);
  }

  /**
   * Claim one settled position (`PositionModule.claimPosition`, costs POL) —
   * transfers the payout to the holder; never pulls USDC in, so no allowance.
   * Returns the on-chain payout (authoritative — ignore local estimates).
   */
  async claimPosition(args: ClaimPositionArgs): Promise<ClaimPositionResult> {
    return this.client.positions.claim(args);
  }

  /**
   * Sweep every settle+claim the wallet is owed (`claimAll`) — settle-then-claim
   * per entry, a revert on one entry doesn't block the rest. `address` defaults to
   * the signer's and, in live mode, MUST equal it (the SDK throws otherwise — a
   * mismatched plan would revert or, worse, sweep an unrelated position). Pass
   * `{ opts: { dryRun: true } }` to get the action plan without sending any tx.
   */
  async claimAll(args?: ClaimAllArgs): Promise<ClaimAllResult> {
    return this.client.positions.claimAll(args);
  }
}

/** Resolved API URL: the caller's `config.apiUrl` if set, else the SDK production default. */
function resolveApiUrl(config: Config): string {
  return config.apiUrl ?? DEFAULT_API_URL;
}

/** The `OspexClientOptions` common to both factories — chain id + RPC, plus `apiUrl` only when explicitly configured (omitted, not `undefined`, so it doesn't override the SDK default under `exactOptionalPropertyTypes`). */
function buildClientOptions(config: Config): OspexClientOptions {
  const options: OspexClientOptions = { chainId: config.chainId, rpcUrl: config.rpcUrl };
  if (config.apiUrl !== undefined) options.apiUrl = config.apiUrl;
  return options;
}

/**
 * Build a **read-only** `OspexClient` from `config` and wrap it in an
 * `OspexAdapter` — no signer. Reads work; the write wrappers throw
 * `OspexConfigError` from the SDK on call, and `makerAddress()` throws. Used by
 * `doctor`, `quote`, and `run --dry-run`. For the signed adapter (`run --live`)
 * use {@link createLiveOspexAdapter}.
 */
export function createOspexAdapter(config: Config): OspexAdapter {
  return new OspexAdapter(new OspexClient(buildClientOptions(config)), {
    chainId: config.chainId,
    apiUrl: resolveApiUrl(config),
  });
}

/**
 * Build a **signed** `OspexClient` from `config` + a `signer` and wrap it in an
 * `OspexAdapter` — the live counterpart of {@link createOspexAdapter}. The signer
 * is attached to both the client (so the write methods work) and the adapter
 * context (so `makerAddress()` resolves to the signer's address and `isLive()` is
 * true). `run --live` builds this with a keystore-unlocked signer
 * ({@link unlockKeystoreSigner}); the runner wiring lands in a later Phase-3 slice.
 */
export function createLiveOspexAdapter(config: Config, signer: Signer): OspexAdapter {
  return new OspexAdapter(new OspexClient({ ...buildClientOptions(config), signer }), {
    chainId: config.chainId,
    apiUrl: resolveApiUrl(config),
    signer,
  });
}

// ── keystore — cheap-path address read (no decrypt, no passphrase prompt) ────

/**
 * Read the wallet address from a v3 keystore JSON without decrypting it (no
 * passphrase prompt). Returns `null` for any of: missing file, unreadable file,
 * non-JSON content, JSON without an `address` field (Foundry-produced keystores
 * omit it for privacy), or an `address` that isn't a 40-hex string. The caller
 * (`ospex-mm doctor` in Phase 1b, the runner's boot path in Phase 2) falls back
 * to `--address` or a passphrase-driven unlock when this returns null.
 *
 * Mirrors `@ospex/cli`'s `getKeystoreAddressIfPresent`. We duplicate the helper
 * here because the MM depends on `@ospex/sdk` only — not `@ospex/cli` (DESIGN §4).
 */
export function readKeystoreAddress(keystorePath: string): Hex | null {
  let raw: string;
  try {
    raw = readFileSync(keystorePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const addr = (parsed as { address?: unknown }).address;
  if (typeof addr !== 'string' || addr.length === 0) return null;
  const hex = addr.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return `0x${hex}` as Hex;
}

// ── keystore — unlock the signer (decrypts; pays the scrypt KDF cost) ────────

/**
 * Decrypt the v3 keystore JSON at `keystorePath` with `passphrase` and return an
 * unlocked {@link Signer} (a `KeystoreSigner`). This is the real unlock — it pays
 * the scrypt cost (~hundreds of ms) — and the only way to obtain a write-capable
 * adapter ({@link createLiveOspexAdapter}). `run --live`'s boot path supplies the
 * passphrase from `OSPEX_KEYSTORE_PASSPHRASE` or an interactive prompt; the
 * prompting itself is out of scope here.
 *
 * Throws a clear `Error` (naming the path) when the file can't be read, and
 * propagates whatever the keystore decryptor throws on malformed JSON or a wrong
 * passphrase — both are operator input, surfaced verbatim by the boot path.
 * Contrast {@link readKeystoreAddress}, which never decrypts and only reads the
 * (optional) plaintext `address` field for `doctor`.
 */
export async function unlockKeystoreSigner(keystorePath: string, passphrase: string): Promise<Signer> {
  let keystoreJson: string;
  try {
    keystoreJson = readFileSync(keystorePath, 'utf8');
  } catch (err) {
    throw new Error(`unlockKeystoreSigner: cannot read keystore file at ${keystorePath}: ${(err as Error).message}`);
  }
  return KeystoreSigner.unlock(keystoreJson, passphrase);
}

// ── view-mappers ─────────────────────────────────────────────────────────────

function toContestView(c: Contest): ContestView {
  return {
    contestId: c.contestId,
    awayTeam: c.awayTeam,
    homeTeam: c.homeTeam,
    sport: c.sport,
    sportId: c.sportId,
    matchTime: c.matchTime,
    status: c.status,
    referenceGameId: c.jsonoddsId ?? null,
    speculations: c.speculations.map(toSpeculationView),
  };
}

function toSpeculationView(s: Speculation): SpeculationView {
  const view: SpeculationView = {
    speculationId: s.speculationId,
    contestId: s.contestId,
    marketType: s.type,
    lineTicks: s.lineTicks,
    line: s.line,
    open: s.speculationStatus === 0,
  };
  if (s.orderbook !== undefined) view.orderbook = s.orderbook; // present on contest-detail / speculation-detail responses; absent on the lean list endpoint
  return view;
}

function toOddsSnapshotView(snap: ContestOddsSnapshot): OddsSnapshotView {
  return {
    contestId: snap.contestId,
    referenceGameId: snap.jsonoddsId,
    odds: {
      moneyline: snap.odds.moneyline,
      spread: snap.odds.spread,
      total: snap.odds.total,
    },
  };
}

function toOddsUpdateView(o: OddsSnapshot): OddsUpdateView {
  return {
    referenceGameId: o.jsonoddsId,
    market: o.market,
    network: o.network,
    line: o.line,
    awayOddsAmerican: o.awayOddsAmerican,
    homeOddsAmerican: o.homeOddsAmerican,
    upstreamLastUpdated: o.upstreamLastUpdated,
    pollCapturedAt: o.pollCapturedAt,
    changedAt: o.changedAt,
  };
}
