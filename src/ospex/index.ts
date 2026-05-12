/**
 * The Ospex SDK adapter — the ONLY module that imports `@ospex/sdk`.
 *
 * Wraps the read surface the MM needs (contests / speculations / commitments /
 * positions / odds / balances / approvals / health) and maps the SDK's
 * provider-specific wire-field names to neutral MM terms at this boundary
 * (`jsonoddsId` → `referenceGameId`) — DESIGN §16 forbids provider names anywhere
 * else. SDK types that have no provider-name leak (`Commitment`, `PositionStatus`,
 * `BalancesSnapshot`, `MoneylineOdds`, the typed `Ospex*Error` classes, …) are
 * re-exported as-is so downstream callers don't have to reach past this adapter
 * to type a variable or `instanceof`-check an error.
 *
 * Phase 1 is **strictly read-only** — `createOspexAdapter` constructs the
 * `OspexClient` *without* a signer, so any SDK write would throw on call; the
 * adapter also exposes no write wrappers. Phase 2+ adds the keystore-derived
 * signer + writes (`submit` / `cancel` / `approve` / `settle` / `claim`) here.
 *
 * The adapter takes a structurally-typed `OspexClientLike` so tests can pass a
 * minimal fake; `createOspexAdapter(config)` is the production factory that builds
 * the real `OspexClient`.
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
  type Speculation,
  type SpeculationsListOptions,
  type SpreadOdds,
  type Subscription,
  type TotalOdds,
} from '@ospex/sdk';

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

export type OspexClientLike = {
  contests: Pick<OspexClient['contests'], 'get' | 'list'>;
  speculations: Pick<OspexClient['speculations'], 'list' | 'get'>;
  commitments: Pick<OspexClient['commitments'], 'list' | 'get'>;
  positions: Pick<OspexClient['positions'], 'status' | 'byAddress'>;
  balances: Pick<OspexClient['balances'], 'read'>;
  approvals: Pick<OspexClient['approvals'], 'read'>;
  health: Pick<OspexClient['health'], 'check'>;
  odds: OspexClient['odds'];
};

// ── the adapter ──────────────────────────────────────────────────────────────

export interface OspexAdapterContext {
  chainId: ChainId;
  /** Resolved API URL (caller's `config.apiUrl` if set, else `DEFAULT_API_URL`). */
  apiUrl: string;
}

/**
 * Read-only wrapper over `@ospex/sdk`. Construct via `createOspexAdapter(config)`
 * for production use; tests pass an `OspexClientLike` fake to the constructor
 * directly.
 */
export class OspexAdapter {
  readonly chainId: ChainId;
  readonly apiUrl: string;

  constructor(private readonly client: OspexClientLike, ctx: OspexAdapterContext) {
    this.chainId = ctx.chainId;
    this.apiUrl = ctx.apiUrl;
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
}

/**
 * Build a read-only `OspexClient` from `config` and wrap it in an `OspexAdapter`.
 * Phase 1 — no `signer`, no `KeystoreSigner` construction (any SDK write call
 * would throw `OspexConfigError`). Phase 2+ adds the keystore-derived signer here.
 */
export function createOspexAdapter(config: Config): OspexAdapter {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const clientOptions: OspexClientOptions = {
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
  };
  if (config.apiUrl !== undefined) clientOptions.apiUrl = config.apiUrl;
  return new OspexAdapter(new OspexClient(clientOptions), { chainId: config.chainId, apiUrl });
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
