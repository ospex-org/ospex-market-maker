/**
 * Telemetry — the append-only NDJSON event log (DESIGN §11) and the
 * `ospex-mm summary` aggregator (dry-run metrics + live-mode fill rate / gas /
 * fees / settlement outcomes / realized P&L — see {@link LiveMetrics}; only
 * unrealized P&L over still-active positions remains as a follow-up).
 *
 * Every line of the event log is `{ ts, runId, [maker,] kind, ...payload }` — the
 * `maker` field (the instance's lowercased wallet address) is present on a live run
 * and absent in dry-run, so a shared `telemetry.logDir` is attributable per instance
 * and the state-loss fail-safe can scope its "prior run" check to THIS maker (see
 * `eventLogsExist`). **This NDJSON shape is a stable contract** — a future external
 * scorecard consumes it unchanged (DESIGN §11, §16), so this module is treated as a
 * wire boundary and fails closed: `kind` must be a known kind; the `runId` must be
 * filename-safe (it names the file); the payload must be a plain object with none of
 * the reserved keys (`ts` / `runId` / `kind` / `maker`); and every payload value
 * must be JSON-safe and deterministic —
 * `bigint`s, non-finite / unsafe-integer numbers, `undefined`, functions, symbols,
 * and non-plain objects (`Map`, `Date`, class instances, …) all throw rather than
 * being silently dropped or mangled by `JSON.stringify`. Anything that can exceed
 * `Number.MAX_SAFE_INTEGER` (risk in wei6, block numbers, …) is a decimal string —
 * the AGENT_CONTRACT numeric rule.
 *
 * **Signing material is also rejected / redacted** (own-state SSE plan §M6/B).
 * The MM persists the SDK's canonical `SignedCommitmentPayload` (M6/A) so
 * cancel paths can authoritatively cancel hidden rows without round-tripping
 * the public API. That bundle — the EIP-712 `signature`, the wrapper
 * `signedPayload`, the inner `commitment` struct, and the `nonce` — is the
 * same material `MatchingModule` needs to fill a commitment. Two defences:
 *
 * 1. **Denied object keys → throw.** Any payload key matching the denylist at
 *    any depth fails closed (a structural misuse: caller should be using an
 *    allow-list projection like `commitmentEventPayload`).
 * 2. **Sensitive string substrings → redact.** A 65-byte ECDSA signature
 *    pattern (`0x` + 130 hex), a JSON-shaped `signature` key with any hex
 *    value (catches truncated leaks too), and a JSON-shaped `signedPayload`
 *    key are replaced with `[REDACTED]` markers in every string value,
 *    recursively.
 *    Error messages, RPC errors, and any string carrying a serialized state
 *    fragment can incidentally contain a signature; redaction (rather than
 *    throw) keeps the telemetry writer running so the operator still sees
 *    the surrounding diagnostic context (Hermes PR #64 round 1).
 *
 * No SDK, no chain. Phase 2's runner is the first real consumer; this slice ships
 * the writer + the `kind` vocabulary so that vocabulary is locked early.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MarketType } from '../state/index.js';

/**
 * The `kind` vocabulary for event-log lines (DESIGN §11). Adding a kind is an
 * additive change; removing or renaming one is a breaking change to the scorecard
 * contract — don't.
 */
export const TELEMETRY_KINDS = [
  'tick-start',
  'candidate', //                  a contest considered; carries `skipReason` (a CandidateSkipReason) if skipped, and `market` ('spread' | 'total') on a per-market event — a reconcileMarket gate, a discovery confirm-loop refusal, or the tracked candidate (absent = moneyline, the default)
  'fair-value',
  'risk-verdict', //               { allowed, sizeUSDC } | { allowed: false, reason }
  'quote-intent',
  'quote-competitiveness',
  'competitiveness-unavailable',
  'submit',
  'would-submit', //               dry-run counterpart of `submit`
  'soft-cancel',
  'would-soft-cancel',
  'replace',
  'would-replace',
  'onchain-cancel',
  'cancel-blocked-missing-payload', // an on-chain cancel sweep encountered a pre-M6/A record (`signedPayloadStatus: 'missing-legacy'`) that's also book-hidden (`lifecycle: 'softCancelled'`) — the public commitments API redacts the signed payload (M2) so `cancelOnchain` has no recovery path. Emitted once per stuck record per run; carries `commitmentHash` / `speculationId` / `contestId` / `makerSide` / `lifecycle` / `reason` / `detail` / `phase` (`shutdown-kill` / `cli-cancel-stale` / unset for the routine recovered-soft-cancel sweep). Operator action required: recover the payload via owner-auth own-state (Phase 2) or wait for expiry. Own-state SSE plan §M6.
  'nonce-floor-raise',
  'expire', //                     a tracked commitment hit expiry — headroom released
  'approval', //                   { purpose, spender, currentAllowance, requiredAggregateAllowance, amountSetTo }
  'funding-hold', //               funding guard (C1a) tripped/cleared — { state: 'entered'|'cleared', reason, fundingWei6, requiredWei6, walletUsdcWei6, positionModuleAllowanceWei6 }
  'fill',
  'position-transition', //         a tracked position's status moved forward (active → pendingSettle → claimable; claimed is set by the auto-claim path, not by the poll)
  'settle',
  'claim',
  'degraded', //                   a market's odds channel errored
  'stream-health-degraded', //     an own-state composite-health DEGRADE cause, reason-discriminated, emitted ONCE on the degrade edge: `{reason: 'queue-overflow', shadowReady, queueCapacity}` (SSE queue overflowed, Phase 2 PR3) | `{reason: 'indexer-lag', indexerLagSeconds, indexerLagMaxSeconds, lagSource}` (indexer behind, Phase 3 PR2c-i) | `{reason: 'poll-failed'}` (own-state health poll threw — fail-closed, PR2c-i). In live + `subscribe:true` these degrade composite own-state health and HALT new posting (§5.1 gate, since PR2a); in dry-run / poll-only they are observability only. indexer-lag/poll-failed clear silently (recovery shows via `stream-health-hold {cleared}` when live).
  'stream-would-hold', //          Phase 2 documentation event — "what Phase 3 cutover would do at this point". Carries `{reason: 'queue-overflow', exposureWei6}`. Emitted iff open exposure > 0 alongside `stream-health-degraded`. Phase 2 does NOT actually set `fundingHold`.
  'stream-cold-restart', //        own-state SSE stream was cold-restarted (close + reopen cursor-less). Carries `{reason}` — the only emitted reason is `'mapping-degraded'` (F1 self-heal): a canonical own-state mapper failed on a live delta or a fresh-snapshot row missing required identity (e.g. a transient enrichment gap → empty team), so the stream re-grounds via a cursor-less re-snapshot that clears the §5.1 hold on a clean baseline. A PERSISTENT gap re-trips this on each fresh baseline — rate-limited to one per `ownState.debounceMs` by the wake loop — surfacing as repeated `stream-cold-restart` + a held gate rather than silence (see `owner-mapping-failed`).
  'stream-health-hold', //         §5.1 own-state-health posting gate tripped/cleared (own-state SSE plan, Phase 3 PR2). Carries `{state: 'entered'|'cleared', severity?: 'high'|'low', exposureWei6?}` (severity/exposure on 'entered' only; 'high' iff open exposure > 0). Live + `subscribe:true` only — inert in dry-run / poll-only. Emitted once per enter/clear transition; while held, `reconcileMarkets` refuses NEW posting. DISTINCT from the Phase-2 `stream-would-hold` doc event (which never actually held).

  'divergence', //                 PR5 shadow-vs-canonical comparator (own-state-sse-plan §2.5.4 / §6.3). Per-tick aggregated event when the audit (poll) source disagrees with the canonical (SSE-derived, post PR3b) state PAST the tolerance window. Carries `{count, byField, examples, streamObservedAt, pollObservedAt, sinceMs}`. PR2c-ii: an emit-worthy (persistent) divergence ALSO sets §5 latch 5 (auditDivergenceUnresolved) → in live + subscribe:true it HALTS new posting via `stream-health-hold` until a clean comparison or a rebaseline clears it.
  'unknown-own-fill', //           own-state SSE plan §7.2 (Phase 3 PR3b). An SSE `fill` event arrived for a `commitmentHash` not in canonical `MakerState` — the orphan fill is NOT applied (a fill carries no contest identity); instead this fires, the audit-divergence posting hold latches, and a cursor-less cold restart is requested so a fresh baseline reconciles. Carries `{commitmentHash, speculationId, txHash, logIndex}`. subscribe:true only.
  'owner-mapping-failed', //       own-state SSE plan §6 (Phase 3 PR3b). A canonical own-state mapper (`mapOwner*ToMaker`) threw `OwnerMappingError` on an SSE payload missing metadata a `Maker*Record` requires non-null — the row is SKIPPED (fail-closed, never a partial record) and cursor promotion freezes past it. Carries `{class:'OwnerMappingError', field, commitmentHash?, speculationId?, detail, phase:'own-state-stream'}`. subscribe:true only.
  'foreign-maker-commitments', //  live boot diagnostic (MM#6): open commitments exist on this maker wallet that THIS instance did not post (not in local state) — a likely sign a second MM is running on the same wallet (one wallet per instance — DESIGN §12). WARN-only. Carries { count, commitmentHashes }.
  'error', //                      { class, detail }
  'kill',
] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

/** Skip reasons carried on a `candidate` event when the MM declined to quote a market (DESIGN §11). */
export const CANDIDATE_SKIP_REASONS = [
  'no-reference-odds',
  'no-open-speculation',
  'would-create-lazy-speculation', //  the per-market reconcile recognized a SEED market (`marketSelection.seedSpeculations` on — one discovery tracks at the oracle-primary line where NO on-chain speculation exists yet, carrying a placeholder `speculationId`) and refused to post it (posting there would lazily create the speculation). Emitted ONLY for a seed: a non-seed market whose speculation has vanished surfaces instead as `transient-failure` (the per-speculation read throws) or `no-open-speculation` (a closed spec) — never this. In the current build it is a hard refusal (the MM never posts where no speculation exists); the seeding path that actually posts + lazily creates the speculation (paying the protocol creation fee) ships in a later slice. Carries `contestId` + the `market` tag (spread/total; omitted for moneyline).
  'reference-line-mismatch', //        spread/total only: the tracked speculation's on-chain line (away-perspective lineTicks) diverged from the line the reference odds are priced for, so quoting it would post the reference price at a different line (a mispriced commitment). The visible quotes are pulled and the market refuses until the lines agree. Moneyline has no line and never hits this. The discovery refresh FOLLOWS the oracle line (re-binds to the open spec at the new line, debounced by orders.replaceOnLineMoveTicks), so a divergence reaching here is a residual one: a sub-threshold move being debounced, or no open spec at the oracle line yet.
  'stale-reference',
  'start-too-soon',
  'untracked', //                      the contest left the discovery listing and is being DRAINED — its visible quotes are pulled (never re-quoted) each tick until the pull succeeds, after which the next discovery cycle untracks it. Emitted while a `departing` market is retried after an untrack-time pull failed transiently.
  'cap-hit',
  'refused-pricing',
  'tracking-cap-reached',
  'gas-budget-blocks-reapproval',
  'gas-budget-blocks-settlement', // on-chain settleSpeculation / claimPosition denied by canSpendGas (mayUseReserve = settlement.continueOnGasBudgetExhausted); `purpose` distinguishes `settleSpeculation` vs `claimPosition`
  'gas-budget-blocks-onchain-cancel', // on-chain cancelCommitment denied by canSpendGas. Two emit shapes: the automatic, reserve-preserving cancels (mayUseReserve: false, carry `contestId` — all via `onchainCancelCommitment`: the routine `cancelMode: onchain` partial-remainder / recovered-soft-cancel, the funding-guard `underfundedCancelMode: onchain` sweep, and the §5.1 own-state-health active cancel-sweep) vs the operator-explicit shutdown kill / cancel-stale --authoritative paths (mayUseReserve: true, no `contestId`); the candidate's `commitmentHash` identifies the record that couldn't be cancelled
  'partial-remainder-retained', //     a `partiallyFilled` remainder left in place (never off-chain-cancelled, never reposted over): it occupies its maker side until expiry / authoritative on-chain cancel. Carries `commitmentHash` / `contestId` / `speculationId` / `makerSide` / `takerSide` and a `reason` (`side-not-quoted` / `stale` / `mispriced` / `duplicate` / `shutdown`)
  'already-settled', //                ensureSpeculationSettled found the speculation already settled (pre-flight) or recovered from a concurrent settle — a boring skip, not an error. Emitted by the auto-settle path with `purpose: 'settleSpeculation'`; `outcome` distinguishes `alreadySettled` vs `recovered`. A `recovered` race that broadcast a settle which reverted on inclusion DID spend gas: `revertedTxHash` + `gasPolWei` are present and that gas IS billed (state daily counter + the run summary under `settle`); if the reverted receipt couldn't be fetched, `gasAccountingGap: true` flags the gap. `alreadySettled` / pre-send recovery send no tx → no gas, no faked txHash.
  'already-claimed', //                ensurePositionClaimed found the position already claimed (pre-flight) or recovered from a benign already-claimed race — a boring skip, not an error, and NOT a `claim` event (no event-sourced payout; the contract zeroes economic fields post-claim, so we never fake/derive one). Emitted by the auto-claim path with `purpose: 'claimPosition'`; `outcome` distinguishes `alreadyClaimed` vs `recovered`. Gas accounting mirrors `already-settled`: a `recovered` race that broadcast a claim which reverted on inclusion DID spend gas — `revertedTxHash` + `gasPolWei` are present and that gas IS billed (state daily counter + the run summary under `claim`); `gasAccountingGap: true` flags a reverted receipt that couldn't be fetched. `alreadyClaimed` / pre-send recovery send no tx → no gas. The run summary classifies these positions `alreadyClaimed` (NOT `wonUnclaimed`) and folds no payout into realized P&L.
] as const;
export type CandidateSkipReason = (typeof CANDIDATE_SKIP_REASONS)[number];

/**
 * The telemetry `market` tag (DESIGN §11). Present (`'spread'` | `'total'`) on a
 * non-moneyline event; **OMITTED for moneyline** (the unmarked default) so a
 * moneyline-only run's NDJSON stays byte-identical to before markets existed.
 *
 * Used on the per-market `candidate` event AND on the live commitment / position
 * events that feed the run-summary metrics — `submit` / `would-submit` /
 * `replace` / `would-replace` / `soft-cancel` / `would-soft-cancel` / `fill` /
 * `settle` / `claim` — so `summarize` can bucket fills + realized P&L by market.
 * Consumers read it as `market ?? 'moneyline'`.
 */
export function marketTag(market: MarketType): { market?: 'spread' | 'total' } {
  return market === 'moneyline' ? {} : { market };
}

/** Free-form payload for an event-log line — merged into `{ ts, runId, kind }`. See the bigint / reserved-key rules. */
export type TelemetryPayload = Record<string, unknown>;

const RESERVED_KEYS = ['ts', 'runId', 'kind', 'maker'] as const;
const KNOWN_KINDS: ReadonlySet<string> = new Set(TELEMETRY_KINDS);

/**
 * Field names that may carry EIP-712 signing material from a persisted
 * {@link MakerSignedPayload} / SDK `SignedCommitmentPayload` — rejected at any
 * depth by {@link assertNoSigningMaterial} (own-state SSE plan §M6/B):
 *
 * - `signature` — the ECDSA signature itself; the single field most useful to
 *   an adversary (combined with the `commitment` struct, it's the entire fill
 *   input for `MatchingModule.matchCommitment`).
 * - `signedPayload` — the on-disk wrapper holding `{ commitmentHash, commitment,
 *   signature }`; rejecting the wrapper catches a careless `...record` spread
 *   that drags the payload into telemetry.
 * - `commitment` — the inner EIP-712 typed-data struct (9 fields: `maker` /
 *   `contestId` / `scorer` / `lineTicks` / `positionType` / `oddsTick` /
 *   `riskAmount` / `nonce` / `expiry`). Names like `commitmentHash` /
 *   `commitmentLifecycle` are NOT denied (they don't carry signing material) —
 *   only the bare `commitment` key.
 * - `nonce` — the EIP-712 nonce; not sufficient alone to spoof a fill, but
 *   listed in the spec (§M6) and unused outside the signed struct, so denying
 *   it everywhere is defense in depth without breaking any caller.
 *
 * Per-emit-site allow-list projection (e.g. `commitmentEventPayload`) is the
 * primary defence — these helpers explicitly omit signing fields. This set is
 * the boundary backstop: if a future caller bypasses the projector and
 * `...record`s a `MakerCommitmentRecord` straight into an emit, the writer
 * throws rather than logging the signed bundle.
 */
const DENIED_SIGNING_KEYS: ReadonlySet<string> = new Set([
  'signature',
  'signedPayload',
  'commitment',
  'nonce',
]);

// Sensitive-substring redaction patterns (own-state SSE plan §M6/B; Hermes
// PR #64 round 1). Built from a `HEX_CLASS` template so the literal regex
// shape never appears as a contiguous run in this file's source — keeps the
// secret-scan check below from self-matching on these definitions.
const HEX_CLASS = '[0-9a-fA-F]';
// A bare 65-byte ECDSA signature anywhere in a string value — the actual
// bearer credential. Matches any run of 130+ hex chars (NOT only an
// `0x`-prefixed exactly-130), so a signature embedded mid-hex-blob — e.g. bytes
// 65-130 of a longer ABI/calldata hex run, where no `0x` immediately precedes
// it — is caught too. A belt-and-braces backstop behind the structural
// `DENIED_SIGNING_KEYS` throw + per-emit allow-list; over-redacting a long
// non-secret hex run in a log value is acceptable.
const ECDSA_SIG_PATTERN = new RegExp(`${HEX_CLASS}{130,}`, 'g');
// JSON-shaped `signature` key/value with any 0x-prefixed hex value (catches
// truncated leaks too — partial hex isn't replayable on its own, but its
// presence is a contamination signal). Captures the key + colon + opening
// quote run as $1 so the replacement preserves the prefix (and the
// replacement string itself doesn't contain a literal quoted-signature-key
// run that would self-trigger the secret-scan).
const SIGNATURE_JSON_VALUE_PATTERN = new RegExp(`("signature"\\s*:\\s*)"0x${HEX_CLASS}*"`, 'g');
// JSON-shaped `signedPayload` key marker. The dangerous bytes inside the
// value are already caught by the patterns above; this tags the
// structural-leak site for the operator. $1 captures so the replacement
// doesn't itself carry a literal quoted-signedPayload-key run.
const SIGNED_PAYLOAD_JSON_KEY_PATTERN = new RegExp(`("signedPayload"\\s*:)`, 'g');

/**
 * Redact sensitive signing-material substrings in a single string value.
 * Order matters: the bare-signature pattern runs first so it catches the
 * actual 130-hex regardless of surrounding context; the JSON-shape patterns
 * then catch truncated leaks and structural-leak markers. Backreferences
 * (`$1`) preserve captured key prefixes so the replacement strings don't
 * themselves carry the quoted JSON-key literals that the
 * {@link ../../scripts/secret-scan.mjs} also flags.
 */
function redactSensitiveStrings(s: string): string {
  return s
    .replace(ECDSA_SIG_PATTERN, '[REDACTED:ecdsa-signature]')
    .replace(SIGNATURE_JSON_VALUE_PATTERN, '$1"[REDACTED]"')
    .replace(SIGNED_PAYLOAD_JSON_KEY_PATTERN, '$1/* REDACTED-FIELD */');
}

/**
 * Walk `value` recursively and return a copy with every string substring run
 * through {@link redactSensitiveStrings}. Pure (does not mutate `value`); the
 * caller stringifies the returned structure. Bigints / functions / undefined /
 * non-plain objects are already rejected by `assertWireSafe` upstream, so this
 * walker only sees strings, finite numbers, booleans, nulls, arrays, and plain
 * objects.
 */
function sanitizePayloadValues(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveStrings(value);
  if (Array.isArray(value)) return value.map(sanitizePayloadValues);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizePayloadValues(v);
    return out;
  }
  return value;
}

/**
 * A run identifier — filename-safe and roughly time-sortable. Two runs started in
 * the same millisecond still differ (the random suffix), so two MMs sharing a log
 * directory won't clobber each other's file (though they must NOT share a state
 * directory — DESIGN §12).
 */
export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // 2026-05-11T14-30-00-123Z
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/**
 * Append-only NDJSON event log — one file per run, `<logDir>/run-<runId>.ndjson`.
 * Synchronous appends (`appendFileSync` per line): the event volume is a handful
 * of lines per ~30 s tick, so a write stream would be premature; this also keeps
 * every line durably on disk the moment it's emitted (no buffered flush to lose on
 * a crash). Single-writer per file.
 */
export class EventLog {
  readonly runId: string;
  readonly path: string;
  /** The instance's lowercased maker wallet, or `null` (dry-run). Stamped on every emitted line so a shared log dir is attributable per instance. */
  readonly maker: string | null;

  private constructor(runId: string, path: string, maker: string | null) {
    this.runId = runId;
    this.path = path;
    this.maker = maker;
  }

  /**
   * Open (creating `logDir` if needed) the event-log file for `runId`. The file
   * itself is created on the first `emit`. `runId` must be filename-safe — only
   * letters, digits, `_` and `-` (no path separators, no `..`) — since it becomes
   * part of the file name; use `newRunId()` for a safe one.
   *
   * `maker` (optional — the live wallet address) is stamped on every line so a
   * shared `telemetry.logDir` is attributable per instance and `eventLogsExist`
   * can scope the state-loss "prior run" check to THIS maker. It is a public
   * on-chain address (not signing material). Omit it for dry-run.
   */
  static open(logDir: string, runId: string, maker?: string): EventLog {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error(`telemetry: runId "${runId}" is not filename-safe — use only letters, digits, "_" and "-" (it becomes part of the log file name); call newRunId() for a safe one`);
    }
    let normalizedMaker: string | null = null;
    if (maker !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(maker)) {
        throw new Error(`telemetry: maker "${maker}" is not a 0x-prefixed 40-hex address`);
      }
      normalizedMaker = maker.toLowerCase();
    }
    mkdirSync(logDir, { recursive: true });
    return new EventLog(runId, join(logDir, `run-${runId}.ndjson`), normalizedMaker);
  }

  /**
   * Append one event line. Fails closed — throws if `kind` isn't a known kind, if
   * `payload` isn't a plain object, if `payload` shadows a reserved key (`ts` /
   * `runId` / `kind`), if any (nested) payload value isn't JSON-safe-and-
   * deterministic (a `bigint`, a non-finite or unsafe-integer number, `undefined`,
   * a function, a symbol, or a non-plain object like a `Map` / `Date` / class
   * instance), or if any (nested) payload key is signing material per
   * {@link DENIED_SIGNING_KEYS} (own-state SSE plan §M6/B). Stringify wei6 /
   * block numbers; flatten objects (incl. `Error`s); allow-list-project commitment
   * records via `commitmentEventPayload` / `softCancelEventPayload` rather than
   * `...record`-spreading them.
   *
   * **String values are redacted** for sensitive signing patterns
   * ({@link redactSensitiveStrings}) BEFORE stringification, so an error message
   * or RPC error that incidentally contains a 130-hex signature lands in the
   * NDJSON with the signature replaced by a `[REDACTED]` marker. Redaction is
   * non-throwing because string-value contamination is incidental (the runner
   * doesn't control SDK / RPC error wording), whereas a denied-KEY structural
   * misuse is the caller's bug to fix.
   */
  emit(kind: TelemetryKind, payload: TelemetryPayload = {}): void {
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(`telemetry: unknown event kind "${String(kind)}" — must be one of ${TELEMETRY_KINDS.join(', ')}`);
    }
    if (!isPlainObject(payload)) {
      throw new Error(`telemetry: payload must be a plain object, got ${describeValue(payload)}`);
    }
    for (const k of RESERVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        throw new Error(`telemetry: payload must not set the reserved key "${k}" (the writer owns ts / runId / kind / maker)`);
      }
    }
    for (const [key, value] of Object.entries(payload)) {
      // Boundary backstop for the signed-bundle leak (own-state SSE plan §M6/B):
      // run the denied-key check FIRST so a careless `...record` spread that
      // drags in `signedPayload` is reported as a sensitive-field violation
      // (the real bug), not as a wire-safety violation about the nested string
      // values. Walk the top-level keys with `assertNoSigningMaterial`, then
      // recurse the value with `assertWireSafe` (which preserves the existing
      // bigint / undefined / non-plain-object diagnostics).
      assertNoSigningMaterial(key, value, `payload.${key}`);
      assertWireSafe(value, `payload.${key}`);
    }
    // String values are redacted AFTER the structural checks pass and BEFORE
    // serialization (Hermes PR #64 round 1). The walker returns a fresh
    // sanitized structure so the caller's `payload` object is not mutated.
    const sanitizedPayload = sanitizePayloadValues(payload) as Record<string, unknown>;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      runId: this.runId,
      ...(this.maker !== null ? { maker: this.maker } : {}),
      kind,
      ...sanitizedPayload,
    });
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }
}

/**
 * Is there evidence of a prior run under `logDir`? The boot path feeds this to
 * `assessStateLoss`'s `hasPriorTelemetry`: a missing state file plus prior
 * telemetry = state loss, not a first run (DESIGN §12). A missing `logDir` means
 * no prior run (`false`); an unreadable one is treated conservatively as a prior
 * run (`true`).
 *
 * When `maker` is given (a live boot), the check is **scoped to THIS instance**:
 * only a prior run-log whose lines carry the same `maker` counts. This is the fix
 * for the shared-`telemetry.logDir` false-trip — a sibling instance's logs (a
 * different maker) no longer force this fresh-state instance into the state-loss
 * hold (which would otherwise train operators to reach for `--ignore-missing-state`,
 * defeating the real fail-safe). A maker-less line (a dry-run sibling, or a log
 * written before this field existed) is NOT attributable to this instance and is
 * skipped — so a pre-upgrade run's own legacy logs won't trip the hold; rely on
 * the `state.dir` lock / `--ignore-missing-state` across that one-time boundary.
 * A file that can't be read/parsed is counted conservatively (errs toward holding).
 *
 * Without `maker` (dry-run, no signer) the check is the original dir-wide
 * "any `run-*.ndjson`" — dry-run carries no on-chain exposure, so an over-broad
 * hold there is harmless.
 */
export function eventLogsExist(logDir: string, maker?: string): boolean {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false;
    return true; // unreadable dir — conservative
  }
  const runLogs = names.filter((name) => /^run-.+\.ndjson$/.test(name));
  if (maker === undefined) return runLogs.length > 0;

  const wanted = maker.toLowerCase();
  for (const name of runLogs) {
    let firstLine: string;
    try {
      const text = readFileSync(join(logDir, name), 'utf8');
      firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    } catch {
      return true; // can't read a run log — conservative (a prior run we can't rule out)
    }
    if (firstLine.trim() === '') continue;
    try {
      const parsed = JSON.parse(firstLine) as { maker?: unknown };
      if (typeof parsed.maker === 'string' && parsed.maker.toLowerCase() === wanted) return true;
    } catch {
      return true; // unparseable run log — conservative
    }
    // parsed but maker absent / different → not this instance's prior run; keep scanning.
  }
  return false;
}

/**
 * Recursively reject any property name that could carry EIP-712 signing
 * material — the persisted {@link MakerSignedPayload} keys (own-state SSE plan
 * §M6/B). Called for `(key, value)` pairs starting at the payload root, then
 * recursively for every nested object / array. A hit at any depth throws
 * before the line is written, so a misshapen call site is caught in dev /
 * CI / Hermes review rather than landing as a leaked signature in the
 * scorecard NDJSON. Array elements are walked but their numeric index is
 * never a denied key (only string keys can be).
 *
 * The walker visits primitives too (it's a no-op there), so the top-level
 * caller can pass primitive values without a type-narrowing wrapper.
 */
function assertNoSigningMaterial(key: string, value: unknown, path: string): void {
  if (DENIED_SIGNING_KEYS.has(key)) {
    throw new Error(
      `telemetry: ${path} is a signing-material field — never include "${key}" in a telemetry payload (own-state SSE plan §M6/B); use an allow-list projection like commitmentEventPayload(record) instead of spreading the record`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      // Array indices are numeric; they can never match a denied key, so we
      // just recurse into objects nested inside the array.
      if (v !== null && typeof v === 'object') {
        for (const [k, nested] of Object.entries(v)) assertNoSigningMaterial(k, nested, `${path}[${i}].${k}`);
      }
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, nested] of Object.entries(value)) assertNoSigningMaterial(k, nested, `${path}.${k}`);
  }
}

/** Recursively reject anything `JSON.stringify` would drop / mangle / can't represent precisely — the event log is a stable wire contract, so fail closed (DESIGN §11, AGENT_CONTRACT). */
function assertWireSafe(value: unknown, path: string): void {
  if (typeof value === 'bigint') {
    throw new Error(`telemetry: ${path} is a bigint (${value}n) — stringify it (the AGENT_CONTRACT numeric rule: wei6 / block numbers are decimal strings)`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    const what = value === undefined ? 'undefined' : `a ${typeof value}`;
    throw new Error(`telemetry: ${path} is ${what} — not JSON-representable; emit a string, number, boolean, null, plain object, or array`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`telemetry: ${path} is ${value} — NaN / Infinity serialize to null; emit a finite number or a string`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`telemetry: ${path} is ${value}, an integer beyond Number.MAX_SAFE_INTEGER — emit it as a decimal string (AGENT_CONTRACT numeric rule)`);
    }
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertWireSafe(v, `${path}[${i}]`));
    return;
  }
  // a non-null, non-array object
  if (!isPlainObject(value)) {
    throw new Error(`telemetry: ${path} is ${describeValue(value)} — JSON.stringify would lose or mangle it; flatten it to a plain object first`);
  }
  for (const [k, v] of Object.entries(value)) assertWireSafe(v, `${path}.${k}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name ? `a ${name}` : 'an unusual object';
}

// ── run summary (the `ospex-mm summary` aggregator — DESIGN §11, §2.3) ────────

/**
 * List the event-log files under `logDir` (`run-*.ndjson`), sorted. A missing
 * `logDir` yields `[]` (no logs yet — a fresh setup); an unreadable one (anything
 * other than ENOENT) throws — `summarize([])` is "no events", which would be
 * misleading if the logs are actually there but unreadable. `ospex-mm summary`
 * feeds the result to {@link summarize}.
 */
export function listRunLogs(logDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => /^run-.+\.ndjson$/.test(name))
    .sort()
    .map((name) => join(logDir, name));
}

/**
 * The `ospex-mm summary` report (DESIGN §11) — the §2.3 run metrics aggregated
 * from one or more NDJSON event logs. The **dry-run** metrics (would-be-stale rate,
 * quote competitiveness, quote-age distribution, latent-exposure peak, the
 * candidate-skip and error histograms) are fully computed; the **live-mode**
 * ones (fill rate, gas, fees, settlement outcomes, realized P&L — DESIGN §2.3)
 * are also computed by the live-event walk (`submit` / `replace` / `fill` /
 * `settle` / `claim` / `approval` / `onchain-cancel`) and exposed on
 * {@link RunSummary.liveMetrics}; only unrealized P&L over still-active
 * positions remains as a Phase-3 follow-up.
 *
 * This is the MM's *own* report; the cross-agent platform-viability scorecard
 * (DESIGN §16) consumes the raw NDJSON, not this.
 */
export interface RunSummary {
  schemaVersion: 1;
  /** ISO-8601 — when this summary was generated. */
  generatedAt: string;
  /** The event-log file paths aggregated, in the order given. */
  sources: string[];
  /** Structurally-valid event lines aggregated (after any `--since` filter). */
  lines: number;
  /** Lines that weren't a JSON object with string `ts` / `runId` / `kind` and a parseable `ts` — skipped. */
  malformedLines: number;
  /** Distinct `runId`s across the aggregated lines, sorted. */
  runIds: string[];
  /** Earliest / latest `ts` across the aggregated lines; `null` if there were none. */
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** Count of `tick-start` events (= ticks the loop ran). */
  ticks: number;
  /** Per-`kind` event count — zero-filled for every {@link TELEMETRY_KINDS}, plus any other `kind` strings seen (forward-compat). */
  eventCounts: Record<string, number>;
  /** `candidate` events: `tracked` = those with no `skipReason` (a contest taken on); `skipReasons` = a histogram of the `skipReason` strings on the rest. */
  candidates: { total: number; tracked: number; skipReasons: Record<string, number> };
  /** `quote-intent` events: how many priced a quote (`canQuote: true`) vs refused. */
  quoteIntents: { total: number; canQuote: number; refused: number };
  /** Dry-run "would-be" activity. */
  wouldSubmit: number;
  wouldReplace: { total: number; byReason: Record<string, number> };
  wouldSoftCancel: { total: number; byReason: Record<string, number> };
  /** `expire` events — tracked commitments that hit expiry (headroom released). */
  expired: number;
  /** Quote competitiveness (dry-run — DESIGN §2.3 / §8). The rate / tick-delta stats are `null` when there were no samples. */
  quoteCompetitiveness: {
    samples: number;
    atOrInsideBookCount: number;
    atOrInsideBookRate: number | null;
    vsReferenceTicks: { min: number; p50: number; mean: number; max: number } | null;
    unavailable: number;
  };
  /** How long would-be quotes stayed up before being soft-cancelled / replaced / expired, in seconds — over *completed* quotes (still-open ones at end of log are excluded). `null` if there were none. */
  quoteAgeSeconds: { samples: number; p50: number; p90: number; max: number } | null;
  /** The largest `visibleOpen + softCancelled-not-yet-expired` aggregate risk reached (USDC wei6, decimal string), reconstructed from the `would-submit` / `would-replace` / `expire` stream. `"0"` if nothing was posted. */
  latentExposurePeakWei6: string;
  /** Stale-quote incidents: `candidate[skipReason='stale-reference']` + `would-replace[reason='stale']` + `would-soft-cancel[reason='stale']`. */
  staleQuoteIncidents: number;
  /** `degraded` events by `reason` (`'channel-error'` / `'subscribe-failed'` / `'channel-cap'`). */
  degradedByReason: Record<string, number>;
  /** `error` events: total + a histogram by `phase` (`'(none)'` for errors without one). */
  errors: { total: number; byPhase: Record<string, number> };
  /** The `kill` event ending the run, if the log has one (graceful shutdown); `null` otherwise (still running, or crashed). */
  kill: { reason: string; ticks: number } | null;
  /**
   * Live-mode metrics — fill rate / gas / fees / settlement outcomes /
   * realized P&L (DESIGN §2.3, §11). Always populated, but zero-valued under
   * a pure dry-run log (the live events — `submit` / `replace` / `fill` /
   * `settle` / `claim` / `approval` / `onchain-cancel` — only get emitted
   * in live mode). Unrealized P&L over still-active positions lands in a
   * later Phase-3 slice (requires `summarize` to accept an `OspexAdapter`).
   */
  liveMetrics: LiveMetrics;
}

/**
 * Per-on-chain-op gas attribution — POL wei18 decimal strings, summed across
 * every event of each kind that carried `gasPolWei`.
 */
export interface LiveGasByKind {
  /** Boot-time `PositionModule` USDC allowance bumps — `approval` events. */
  approval: string;
  /** `cancelCommitmentOnchain` — `onchain-cancel` events (the routine `cancelMode: onchain` partial-remainder cancel, the funding-guard `underfundedCancelMode: onchain` sweep, the §5.1 own-state-health active cancel-sweep, the shutdown kill, or `cancel-stale --authoritative`). */
  onchainCancel: string;
  /** Auto-settle's `settleSpeculation` calls — `settle` events. */
  settle: string;
  /** Auto-claim's `claimPosition` calls — `claim` events. */
  claim: string;
}

/**
 * Realized P&L over closed positions (DESIGN §11). Computed by cross-event
 * correlation: `fill.newFillWei6` accumulates per-(speculationId, makerSide)
 * cumulative own stake; `settle.winSide` identifies the per-speculation
 * outcome; `claim.payoutWei6` is the maker's swept payout on a winning
 * position. For each position with at least one fill:
 *
 *   - **won** — a `claim` event exists for that `(speculationId, makerSide)`;
 *     profit = `payoutWei6 - cumulativeStake`, contributes to `netUsdcWei6`.
 *   - **lost** — settle exists with `winSide !== makerSide` AND `winSide !==
 *     'push' / 'void'`, and no claim; -stake contributes to `netUsdcWei6`.
 *   - **push** — settle's `winSide` is `'push'` or `'void'`; P&L = 0,
 *     contributes nothing.
 *   - **wonUnclaimed** — settle's `winSide === makerSide` BUT no claim has
 *     fired in this log window (auto-claim disabled, hasn't ticked yet, or
 *     threw). Counted but does NOT contribute to `netUsdcWei6` — the payout
 *     isn't known yet. Operators should consult `ospex-mm status` for live
 *     `getPositionStatus` payout totals.
 *   - **alreadyClaimed** — the auto-claim path found the position already
 *     claimed (a `candidate skipReason:'already-claimed'`, NOT a `claim`
 *     event): claimed out-of-window / by a prior run / a concurrent caller.
 *     The position IS claimed, but with no event-sourced payout here, so like
 *     `wonUnclaimed` it contributes nothing to `netUsdcWei6` (the SDK never
 *     derives a post-claim payout). Kept distinct from `wonUnclaimed` so the
 *     latter stays "genuinely unswept."
 *   - **unsettled** — position has fills but no settle event in the window.
 *     Held over for the (g-iii) unrealized-P&L slice.
 *
 * Unrealized P&L (active positions marked to current fair) is the remaining
 * Phase-3 follow-up and requires `summarize` to accept an `OspexAdapter`.
 */
/**
 * The realized-P&L economic fields. The run-wide totals AND each per-market
 * bucket ({@link RealizedPnl.byMarket}) share this exact shape, so the run-wide
 * figure equals the sum across the per-market buckets.
 */
export interface RealizedPnlAmounts {
  /** Net realized P&L in USDC wei6 (SIGNED decimal string — leading `-` for losses; `"0"` for zero). Sum of `won` profits minus `lost` stakes; `push`, `wonUnclaimed`, and `alreadyClaimed` contribute nothing. */
  netUsdcWei6: string;
  /** Sum of `payoutWei6 - cumulativeStake` across `won` positions (always non-negative — a claim only fires on winning positions). */
  claimedProfitUsdcWei6: string;
  /** Sum of stakes lost across `lost` positions (non-negative; subtracted from `claimedProfitUsdcWei6` to get net). */
  realizedLossUsdcWei6: string;
  /** Positions closed in the maker's favor with a `claim` event in this window. */
  wonCount: number;
  /** Positions whose `settle.winSide` ≠ `makerSide` (and ≠ push/void). */
  lostCount: number;
  /** Positions whose `settle.winSide ∈ {'push', 'void'}` — stake refunded, P&L = 0. */
  pushCount: number;
  /** Positions whose `settle.winSide === makerSide` but no `claim` event AND no `already-claimed` skip fired in this window — paper profit, not yet swept. Use `ospex-mm status` for the live payout figure. */
  wonUnclaimedCount: number;
  /** Positions the auto-claim path found ALREADY claimed (a `candidate skipReason:'already-claimed'`, no `claim` event) — claimed out-of-window / by a prior run / a concurrent caller. Distinct from `wonUnclaimed` (which is genuinely unswept): these ARE claimed, just with no event-sourced payout in this window, so they contribute nothing to `netUsdcWei6` (never a derived payout). Use `ospex-mm status` for the live payout figure. */
  alreadyClaimedCount: number;
  /** Positions with fills whose speculation has not settled in this window — held over for the (g-iii) unrealized-P&L slice. */
  unsettledCount: number;
}

export interface RealizedPnl extends RealizedPnlAmounts {
  /**
   * Per-market breakdown of the same realized-P&L amounts (`moneyline` /
   * `spread` / `total`) — zero-filled for all three. The market of each position
   * is resolved from the `market` tag on its `fill` / `settle` / `claim` events
   * (absent ⇒ `moneyline`), so an older moneyline-only log buckets entirely under
   * `moneyline` and the per-market figures reconcile with the run-wide totals.
   */
  byMarket: Record<MarketType, RealizedPnlAmounts>;
}

/**
 * Live-mode run metrics (DESIGN §2.3 / §11). The fill / settlement / gas /
 * fees / realized-P&L aggregators populated by the `submit` / `replace` /
 * `fill` / `settle` / `claim` / `approval` / `onchain-cancel` walk. Wei
 * amounts are decimal strings — the AGENT_CONTRACT numeric rule.
 */
export interface LiveMetrics {
  /**
   * Fill rate (DESIGN §2.3). `quotedUsdcWei6` sums `riskAmountWei6` across
   * every `submit` and `replace` event (USDC the maker actually committed
   * onto the book); `filledUsdcWei6` sums `newFillWei6` across every `fill`
   * event (USDC of that committed risk that takers matched). `fillRate` is
   * `filledUsdc / quotedUsdc` as a number in [0, 1+]; `null` when nothing
   * was quoted (division-by-zero). `byMarket` carries the same three fields
   * per market (`moneyline` / `spread` / `total`), zero-filled — quoted/filled
   * attributed by the `market` tag on each `submit` / `replace` / `fill` event
   * (absent ⇒ `moneyline`); the run-wide quoted/filled equal the sum across
   * markets. Future per-sport / per-time-to-tip bucketing is a follow-up.
   */
  fills: {
    quotedUsdcWei6: string;
    filledUsdcWei6: string;
    fillRate: number | null;
    byMarket: Record<MarketType, { quotedUsdcWei6: string; filledUsdcWei6: string; fillRate: number | null }>;
  };
  /**
   * Gas spent on chain. `totalPolWei` is the sum across every on-chain op
   * that carried a `gasPolWei` field; `byKind` attributes it per event
   * kind. `totalUsdcEquivWei6` is the optional `POL → USDC` conversion
   * (only present when the caller of {@link summarize} supplied a
   * `polToUsdcRate`; the CLI feeds it `config.gas.nativeTokenUSDCPrice`
   * iff `config.gas.reportInUSDC: true`).
   */
  gas: {
    totalPolWei: string;
    byKind: LiveGasByKind;
    totalUsdcEquivWei6: string | null;
  };
  /**
   * Settlement outcomes. `settleCount` is the number of `settle` events
   * (`speculationSettle` calls); `claimCount` is the number of `claim`
   * events; `totalClaimedPayoutWei6` is the sum of `payoutWei6` across
   * those claims — USDC the maker actually swept back. The maker's net
   * settled P&L (claimed payouts − staked risk on the claimed positions)
   * is on {@link realizedPnl} below.
   */
  settlements: {
    settleCount: number;
    claimCount: number;
    totalClaimedPayoutWei6: string;
  };
  /**
   * Realized P&L over closed positions (see {@link RealizedPnl} for the
   * cross-event correlation rules and bucket definitions). Net P&L is
   * `claimedProfit − realizedLoss`. Unrealized P&L over still-active
   * positions is the remaining Phase-3 follow-up (needs adapter).
   */
  realizedPnl: RealizedPnl;
  /**
   * Total protocol fees paid by the maker (USDC wei6 decimal string).
   * Genuinely `"0"` in v0 — v0 refuses lazy-creation commitments so there's
   * no `TreasuryModule` creation fee. Kept here for forward-compat: a future
   * event may emit a `feeUsdcWei6` field that gets summed here.
   */
  totalFeeUsdcWei6: string;
}

interface ParsedLine {
  ts: string;
  tsMs: number;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** A tracked would-be quote, for the latent-exposure / quote-age walk: its risk, when it was posted, whether its visible-life age has been recorded, whether it's still in the latent bucket. */
interface WalkedQuote {
  riskWei6: bigint;
  submitTsSec: number;
  ageRecorded: boolean;
  alive: boolean;
}

/** A non-negative-integer wei amount as a decimal string — `"0"`, `"250000"`. (Local copy; `src/state/`'s `isDecimalString` isn't exported.) */
function isWei6String(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
}

function parseSinceOrThrow(sinceIso: string): number {
  const ms = Date.parse(sinceIso);
  if (!Number.isFinite(ms)) {
    throw new Error(`telemetry.summarize: --since must be an ISO-8601 timestamp (e.g. 2026-05-12T14:00:00Z), got ${JSON.stringify(sinceIso)}`);
  }
  return ms;
}

function readAndParse(logPaths: readonly string[], sinceMs: number | null): { kept: ParsedLine[]; lines: number; malformed: number } {
  const kept: ParsedLine[] = [];
  let lines = 0;
  let malformed = 0;
  for (const path of logPaths) {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformed += 1;
        continue;
      }
      if (!isPlainObject(parsed)) {
        malformed += 1;
        continue;
      }
      const { ts, runId, kind } = parsed;
      if (typeof ts !== 'string' || typeof runId !== 'string' || typeof kind !== 'string') {
        malformed += 1;
        continue;
      }
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs)) {
        malformed += 1;
        continue;
      }
      if (sinceMs !== null && tsMs < sinceMs) continue; // before `--since` — filtered out, not counted as malformed or aggregated
      lines += 1;
      kept.push({ ts, tsMs, runId, kind, payload: parsed });
    }
  }
  kept.sort((a, b) => a.tsMs - b.tsMs); // stable sort → same-`ts` lines keep file (= emission) order, so the walk sees events causally
  return { kept, lines, malformed };
}

function quartiles(values: readonly number[]): { min: number; p50: number; p90: number; max: number; mean: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return { min: s[0] as number, p50: at(0.5), p90: at(0.9), max: s[s.length - 1] as number, mean: sum / values.length };
}

/** Record a would-be quote's visible-life age (seconds it was on the visible book) on its *first* terminal event (soft-cancel / replace-of / expire). No-op if the hash wasn't seen as a `would-submit`/`would-replace`-new (e.g. it predates the log window), or if its age is already recorded, or if the computed age is negative (clock skew). */
function recordAgeIfFirst(quotes: Map<string, WalkedQuote>, hash: string, terminalTsSec: number, completedAges: number[]): void {
  const q = quotes.get(hash);
  if (q === undefined || q.ageRecorded) return;
  q.ageRecorded = true;
  const age = terminalTsSec - q.submitTsSec;
  if (age >= 0) completedAges.push(age);
}

/**
 * Aggregate one or more NDJSON event logs into a {@link RunSummary} (DESIGN §11,
 * §2.3). `logPaths` are read in order; their lines are merged, parsed (a line that
 * isn't a JSON object with string `ts`/`runId`/`kind` and a parseable `ts` is
 * counted in `malformedLines` and skipped), optionally filtered to events at/after
 * `opts.sinceIso`, then walked in `ts` order to reconstruct the latent-exposure
 * peak and the per-quote visible-life ages, and counted into the §2.3 metrics. Pure
 * apart from `readFileSync` on each path (a missing/unreadable path throws — the CLI
 * resolves paths via {@link listRunLogs}, which returns only existing files).
 *
 * Dry-run metrics + the live-mode metrics (fill rate / gas / fees /
 * settlement outcomes / realized P&L — see {@link LiveMetrics}) are fully
 * computed; only unrealized P&L over still-active positions remains as a
 * Phase-3 follow-up (it requires `summarize` to accept an `OspexAdapter`).
 *
 * If `opts.polToUsdcRate` is supplied, `liveMetrics.gas.totalUsdcEquivWei6`
 * is populated by converting `totalPolWei` through that rate. The CLI feeds
 * `config.gas.nativeTokenUSDCPrice` iff `config.gas.reportInUSDC: true`;
 * otherwise the field stays `null`.
 */
export function summarize(logPaths: readonly string[], opts: { sinceIso?: string; polToUsdcRate?: number } = {}): RunSummary {
  const sinceMs = opts.sinceIso !== undefined ? parseSinceOrThrow(opts.sinceIso) : null;
  const { kept, lines, malformed } = readAndParse(logPaths, sinceMs);

  const eventCounts: Record<string, number> = {};
  for (const k of TELEMETRY_KINDS) eventCounts[k] = 0;
  const runIdSet = new Set<string>();
  let ticks = 0;
  let candTotal = 0;
  let candTracked = 0;
  const candSkipReasons: Record<string, number> = {};
  let qiTotal = 0;
  let qiCanQuote = 0;
  let qiRefused = 0;
  let wouldSubmit = 0;
  let wouldReplaceTotal = 0;
  const wouldReplaceByReason: Record<string, number> = {};
  let wouldSoftCancelTotal = 0;
  const wouldSoftCancelByReason: Record<string, number> = {};
  let expired = 0;
  let compSamples = 0;
  let compAtOrInside = 0;
  const compVsRef: number[] = [];
  let compUnavailable = 0;
  let staleQuoteIncidents = 0;
  const degradedByReason: Record<string, number> = {};
  let errTotal = 0;
  const errByPhase: Record<string, number> = {};
  let kill: { reason: string; ticks: number } | null = null;

  // Live-mode metric accumulators (DESIGN §2.3 / §11). `submit` + `replace`
  // contribute to `quotedUsdcWei6` (USDC the maker committed); `fill` events
  // contribute to `filledUsdcWei6`. The on-chain ops (`approval` /
  // `onchain-cancel` / `settle` / `claim`) sum `gasPolWei` into the per-kind
  // gas attribution. `settle` / `claim` contribute to the settlement counts;
  // `claim.payoutWei6` sums into `totalClaimedPayoutWei6`. All zero under a
  // pure dry-run log (those events don't get emitted).
  let quotedWei6 = 0n;
  let filledWei6 = 0n;
  let settleCount = 0;
  let claimCount = 0;
  let totalClaimedPayoutWei6 = 0n;
  // `totalFeeUsdcWei6` is genuinely zero in v0 (no maker-side USDC fees — no
  // lazy-creation path) but the aggregator is kept so a future fee-bearing
  // event can sum into it without a walker change. `const` because no `let`
  // path mutates it yet.
  const totalFeeUsdcWei6 = 0n;
  const gasByKind: LiveGasByKind = { approval: '0', onchainCancel: '0', settle: '0', claim: '0' };
  const addGas = (kind: keyof LiveGasByKind, gasPolWei: bigint): void => {
    gasByKind[kind] = (BigInt(gasByKind[kind]) + gasPolWei).toString();
  };
  /** Helper: read a `gasPolWei` decimal-string field from a payload, returning 0n when missing/malformed. */
  const readGas = (v: unknown): bigint => (isWei6String(v) ? BigInt(v) : 0n);

  // Realized-P&L cross-event correlation tables. For each unique
  // `(speculationId, makerSide)` position seen in this log: track cumulative
  // own stake from `fill` events. Track per-speculation `winSide` from
  // `settle` events (a contest-level outcome — same value on both sides). Track
  // per-position `{payout, result?}` from `claim` events — `result` (added in
  // PR (g-iii-a)) is the definitive `'won' | 'push' | 'void'` outcome from the
  // SDK's `ClaimablePositionView.result`, captured by the runner during the
  // position poll and propagated through the claim payload. The post-walk
  // pass combines these into win / loss / push / wonUnclaimed / unsettled
  // buckets — `claim.result` takes precedence over `settle.winSide` for the
  // bucket verdict (a `--since` window can clip the settle event but the
  // claim event carries the outcome directly).
  const stakesByPosition = new Map<string, bigint>(); // key = `${speculationId}:${makerSide}`
  const outcomeBySpeculation = new Map<string, string>(); // speculationId → winSide ('away' | 'home' | 'push' | 'void' | …)
  const claimByPosition = new Map<string, { payout: bigint; result?: 'won' | 'push' | 'void' }>();
  // `(speculationId:makerSide)` keys found already-claimed by the auto-claim path
  // (a `candidate skipReason:'already-claimed'`, no `claim` event). The position
  // IS claimed (a winner — claimPosition reverts on losers), just not via a
  // fresh tx in this window, so it must be classified `alreadyClaimed` rather
  // than `wonUnclaimed` / `unsettled` — and contributes no payout to realized P&L.
  const alreadyClaimedPositions = new Set<string>();
  const isMakerSide = (v: unknown): v is 'away' | 'home' => v === 'away' || v === 'home';
  const isClaimResult = (v: unknown): v is 'won' | 'push' | 'void' => v === 'won' || v === 'push' || v === 'void';

  // Per-market breakdown accumulators (DESIGN §2.3 — fill rate / P&L "bucketed
  // by market"). The `market` tag is OMITTED for moneyline (the unmarked
  // default), so an absent tag ⇒ 'moneyline'; an older moneyline-only log
  // buckets entirely under 'moneyline' and the per-market figures reconcile
  // with the run-wide totals. `quoted`/`filled` come from each event's own tag;
  // realized P&L resolves a position's market from `marketBySpeculation` (a
  // speculationId is 1:1 with a market on chain), populated from the same
  // fill/settle/claim events so a `--since` window that clips one kind still
  // resolves the bucket.
  const zeroMarkets = (): Record<MarketType, bigint> => ({ moneyline: 0n, spread: 0n, total: 0n });
  const quotedByMarket = zeroMarkets();
  const filledByMarket = zeroMarkets();
  const marketBySpeculation = new Map<string, MarketType>();
  const marketOf = (p: Record<string, unknown>): MarketType => {
    const m = p.market;
    return m === 'spread' || m === 'total' ? m : 'moneyline';
  };

  // The `ts`-ordered walk: track each posted would-be quote by its synthetic hash to
  // reconstruct the running `visibleOpen + softCancelled-not-yet-expired` risk (peak)
  // and the per-quote visible-life ages. A `would-soft-cancel` / `would-replace`-of /
  // `expire` records the quote's visible age; only `expire` removes it from the latent
  // bucket (an off-chain cancel leaves the signed payload matchable until expiry).
  const quotes = new Map<string, WalkedQuote>();
  let runningLatentWei6 = 0n;
  let peakLatentWei6 = 0n;
  const completedAges: number[] = [];
  const bump = (m: Record<string, number>, k: string): void => void (m[k] = (m[k] ?? 0) + 1);

  for (const ln of kept) {
    runIdSet.add(ln.runId);
    eventCounts[ln.kind] = (eventCounts[ln.kind] ?? 0) + 1;
    const p = ln.payload;
    const tsSec = Math.floor(ln.tsMs / 1000);
    switch (ln.kind) {
      case 'tick-start':
        ticks += 1;
        break;
      case 'candidate': {
        candTotal += 1;
        if (typeof p.skipReason === 'string') {
          bump(candSkipReasons, p.skipReason);
          if (p.skipReason === 'stale-reference') staleQuoteIncidents += 1;
          // A recovered inclusion-time settle race (`already-settled` +
          // `purpose: 'settleSpeculation'`) reverted a settle tx of ours, so
          // gas WAS spent: the runner debited the state daily counter and put
          // `gasPolWei` on this event. Fold that into the gas totals (under
          // `settle`) so the summary matches the daily counter — otherwise the
          // scorecard underreports the gas this exact path spent. NOT a
          // successful settle, so `settleCount` is intentionally left alone.
          // (When only `revertedTxHash` is present and gas couldn't be fetched,
          // there's no `gasPolWei` → `readGas` yields 0n; the event's
          // `gasAccountingGap: true` flag is the honest "not exact" signal.)
          if (p.skipReason === 'already-settled' && p.purpose === 'settleSpeculation') {
            addGas('settle', readGas(p.gasPolWei));
          }
          // Parallel to `already-settled`: a recovered inclusion-time CLAIM race
          // (`already-claimed` + `purpose: 'claimPosition'`) reverted a claim tx
          // of ours, so gas WAS spent and the runner put `gasPolWei` here — fold
          // it into the gas totals (under `claim`) so the summary matches the
          // daily counter. NOT a successful claim, so `claimCount` is left alone.
          // Also remember the position so the P&L pass classifies it
          // `alreadyClaimed` (not `wonUnclaimed` / `unsettled`).
          if (p.skipReason === 'already-claimed' && p.purpose === 'claimPosition') {
            addGas('claim', readGas(p.gasPolWei));
            if (typeof p.speculationId === 'string' && isMakerSide(p.makerSide)) {
              alreadyClaimedPositions.add(`${p.speculationId}:${p.makerSide}`);
            }
          }
        } else {
          candTracked += 1;
        }
        break;
      }
      case 'quote-intent':
        qiTotal += 1;
        if (p.canQuote === true) qiCanQuote += 1;
        else qiRefused += 1;
        break;
      case 'quote-competitiveness':
        compSamples += 1;
        if (p.atOrInsideBook === true) compAtOrInside += 1;
        if (typeof p.vsReferenceTicks === 'number' && Number.isFinite(p.vsReferenceTicks)) compVsRef.push(p.vsReferenceTicks);
        break;
      case 'competitiveness-unavailable':
        compUnavailable += 1;
        break;
      case 'would-submit': {
        wouldSubmit += 1;
        if (typeof p.commitmentHash === 'string' && isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotes.set(p.commitmentHash, { riskWei6: risk, submitTsSec: tsSec, ageRecorded: false, alive: true });
          runningLatentWei6 += risk;
          if (runningLatentWei6 > peakLatentWei6) peakLatentWei6 = runningLatentWei6;
        }
        break;
      }
      case 'would-replace': {
        wouldReplaceTotal += 1;
        if (typeof p.reason === 'string') {
          bump(wouldReplaceByReason, p.reason);
          if (p.reason === 'stale') staleQuoteIncidents += 1;
        }
        if (typeof p.replacedCommitmentHash === 'string') recordAgeIfFirst(quotes, p.replacedCommitmentHash, tsSec, completedAges);
        if (typeof p.newCommitmentHash === 'string' && isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotes.set(p.newCommitmentHash, { riskWei6: risk, submitTsSec: tsSec, ageRecorded: false, alive: true });
          runningLatentWei6 += risk;
          if (runningLatentWei6 > peakLatentWei6) peakLatentWei6 = runningLatentWei6;
        }
        break;
      }
      case 'would-soft-cancel': {
        wouldSoftCancelTotal += 1;
        if (typeof p.reason === 'string') {
          bump(wouldSoftCancelByReason, p.reason);
          if (p.reason === 'stale') staleQuoteIncidents += 1;
        }
        if (typeof p.commitmentHash === 'string') recordAgeIfFirst(quotes, p.commitmentHash, tsSec, completedAges);
        break;
      }
      case 'expire': {
        expired += 1;
        if (typeof p.commitmentHash === 'string') {
          recordAgeIfFirst(quotes, p.commitmentHash, tsSec, completedAges); // if it expired while still visibleOpen, this is its first terminal event
          const q = quotes.get(p.commitmentHash);
          if (q !== undefined && q.alive) {
            q.alive = false;
            runningLatentWei6 -= q.riskWei6;
            if (runningLatentWei6 < 0n) runningLatentWei6 = 0n;
          }
        }
        break;
      }
      case 'degraded':
        if (typeof p.reason === 'string') bump(degradedByReason, p.reason);
        break;
      case 'error': {
        errTotal += 1;
        bump(errByPhase, typeof p.phase === 'string' ? p.phase : '(none)');
        break;
      }
      case 'kill': {
        const reason = typeof p.reason === 'string' ? p.reason : 'unknown';
        const t = typeof p.ticks === 'number' && Number.isFinite(p.ticks) ? p.ticks : 0;
        kill = { reason, ticks: t };
        break;
      }
      // ── live-mode (Phase 3 g-i) — fill rate / gas / settlements / fees ──
      case 'submit': {
        if (isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotedWei6 += risk;
          quotedByMarket[marketOf(p)] += risk;
        }
        break;
      }
      case 'replace': {
        if (isWei6String(p.riskAmountWei6)) {
          const risk = BigInt(p.riskAmountWei6);
          quotedWei6 += risk;
          quotedByMarket[marketOf(p)] += risk;
        }
        break;
      }
      case 'fill': {
        if (isWei6String(p.newFillWei6)) {
          const delta = BigInt(p.newFillWei6);
          if (delta === 0n) break; // a zero-delta fill is a no-op for the metrics (mirrors poll.ts's >0n guards) — never creates a phantom 0-stake position, keeps fills.byMarket / realizedPnl.byMarket symmetric
          filledWei6 += delta;
          filledByMarket[marketOf(p)] += delta;
          // Realized-P&L: accumulate per-position own stake. Both commitment-diff
          // and position-poll `fill` sources carry `speculationId` + `makerSide`.
          if (typeof p.speculationId === 'string' && isMakerSide(p.makerSide)) {
            const key = `${p.speculationId}:${p.makerSide}`;
            stakesByPosition.set(key, (stakesByPosition.get(key) ?? 0n) + delta);
          }
          if (typeof p.speculationId === 'string') marketBySpeculation.set(p.speculationId, marketOf(p));
        }
        break;
      }
      case 'approval': {
        addGas('approval', readGas(p.gasPolWei));
        break;
      }
      case 'onchain-cancel': {
        addGas('onchainCancel', readGas(p.gasPolWei));
        break;
      }
      case 'settle': {
        settleCount += 1;
        addGas('settle', readGas(p.gasPolWei));
        // Realized-P&L: capture the contest-level outcome. Last-write-wins on a
        // duplicate (a maker quoting both sides emits two `settle` events for
        // the same speculation, but they both carry the same `winSide` — the
        // contest's outcome is contest-level, not per-position).
        if (typeof p.speculationId === 'string' && typeof p.winSide === 'string') {
          outcomeBySpeculation.set(p.speculationId, p.winSide);
        }
        if (typeof p.speculationId === 'string') marketBySpeculation.set(p.speculationId, marketOf(p));
        break;
      }
      case 'claim': {
        claimCount += 1;
        addGas('claim', readGas(p.gasPolWei));
        if (typeof p.speculationId === 'string') marketBySpeculation.set(p.speculationId, marketOf(p));
        if (isWei6String(p.payoutWei6)) {
          const payout = BigInt(p.payoutWei6);
          totalClaimedPayoutWei6 += payout;
          // Realized-P&L: per-position payout + result. Idempotent on a
          // duplicate (the claim event only fires once per position on chain;
          // this is just defense against an over-eager log replay). `result`
          // is the runner-emitted outcome from `ClaimablePositionView.result`
          // (added in PR (g-iii-a)); absent on logs from before that PR
          // and on `--since` windows that clip the position-poll observation
          // — in either case the classifier falls back to settle.winSide.
          if (typeof p.speculationId === 'string' && isMakerSide(p.makerSide)) {
            const entry: { payout: bigint; result?: 'won' | 'push' | 'void' } = { payout };
            if (isClaimResult(p.result)) entry.result = p.result;
            claimByPosition.set(`${p.speculationId}:${p.makerSide}`, entry);
          }
        }
        break;
      }
      default:
        break; // `fair-value` / `risk-verdict` / `soft-cancel` / `nonce-floor-raise` / `position-transition` — counted in `eventCounts` only (no derived metric here in g-i)
    }
  }

  const vsRefStats = quartiles(compVsRef);
  const ageStats = quartiles(completedAges);

  // Compose the live metrics. `fillRate` is null when nothing was quoted
  // (division-by-zero on the empty dry-run case). `totalUsdcEquivWei6` is
  // null unless the caller supplied a POL→USDC rate (the CLI passes
  // `config.gas.nativeTokenUSDCPrice` iff `config.gas.reportInUSDC: true`).
  // Convert POL wei18 × rate to USDC wei6: usdcWei6 = round(polWei18 × rate × 10^-12).
  const totalPolWei = BigInt(gasByKind.approval) + BigInt(gasByKind.onchainCancel) + BigInt(gasByKind.settle) + BigInt(gasByKind.claim);
  let totalUsdcEquivWei6: string | null = null;
  if (opts.polToUsdcRate !== undefined && Number.isFinite(opts.polToUsdcRate) && opts.polToUsdcRate >= 0) {
    // wei18 (POL) × USDC-per-POL → USDC wei6 = wei18 × rate / 10^12. Do the
    // float multiply on (wei18 / 1e18) × rate × 1e6 so the rate's significant
    // figures survive without bigint↔float gymnastics; a daily-budget POL
    // figure fits well within Number range.
    const polFloat = Number(totalPolWei) / 1e18;
    const usdcWei6 = BigInt(Math.round(polFloat * opts.polToUsdcRate * 1e6));
    totalUsdcEquivWei6 = usdcWei6.toString();
  }
  // ── realized-P&L post-walk ──────────────────────────────────────────────
  // For each position with at least one fill, classify by what we know.
  // **The runner-emitted `claim.result` (PR (g-iii-a)) is the authoritative
  // outcome when present** — it comes from the SDK's
  // `ClaimablePositionView.result` (`'won' | 'push' | 'void'`) captured during
  // the position-status poll, so it doesn't depend on a `settle` event being
  // in the same `--since` window. When it's absent (older logs, or a
  // window-clipped position-poll observation), the classifier falls back to
  // `settle.winSide`-derivation — which itself orders push/void before "claim
  // = won" so the runner's auto-claim on a refund doesn't miscount (Hermes
  // review-PR33 blocker, preserved).
  //
  // Final order:
  //   1. claim.result ∈ {'push', 'void'} → push (whatever payout came with it
  //      was a refund, ignored).
  //   2. settle.winSide ∈ {'push', 'void'} → push (no claim.result; falls back
  //      to the contest-level verdict; same posture as above).
  //   3. claim.result === 'won' → won (use payout).
  //   4. claim present without `result` AND (settle missing OR settle agrees) →
  //      won. Outcome-unknown is the externally-settled / window-clipped case;
  //      outcome-matches is the normal winning path.
  //   5. no settle and no claim → unsettled.
  //   6. settle.winSide ≠ makerSide (and not push/void) → lost. A stray
  //      claim in this case is anomalous; the outcome verdict wins.
  //   7. settle.winSide === makerSide and no claim → wonUnclaimed.
  // A per-bucket accumulator (run-wide AND each per-market bucket share this).
  interface PnlAcc { net: bigint; profit: bigint; loss: bigint; won: number; lost: number; push: number; wonUnclaimed: number; alreadyClaimed: number; unsettled: number }
  const newPnlAcc = (): PnlAcc => ({ net: 0n, profit: 0n, loss: 0n, won: 0, lost: 0, push: 0, wonUnclaimed: 0, alreadyClaimed: 0, unsettled: 0 });
  // Classify a position into exactly one bucket (+ its P&L delta), implementing
  // the precedence documented above. Pure — applied to BOTH the run-wide and the
  // per-market accumulator so the two can never diverge.
  type PnlVerdict =
    | { bucket: 'push' | 'wonUnclaimed' | 'alreadyClaimed' | 'unsettled' }
    | { bucket: 'won'; profit: bigint }
    | { bucket: 'lost'; stake: bigint };
  const classifyPosition = (
    stake: bigint,
    makerSide: string,
    outcome: string | undefined,
    claim: { payout: bigint; result?: 'won' | 'push' | 'void' } | undefined,
    alreadyClaimed: boolean,
  ): PnlVerdict => {
    if (claim?.result === 'push' || claim?.result === 'void') return { bucket: 'push' }; // (1)
    if (outcome === 'push' || outcome === 'void') return { bucket: 'push' }; //              (2)
    if (claim?.result === 'won') return { bucket: 'won', profit: claim.payout - stake }; //  (3)
    if (claim !== undefined && (outcome === undefined || outcome === makerSide)) return { bucket: 'won', profit: claim.payout - stake }; // (4)
    if (alreadyClaimed && (outcome === undefined || outcome === makerSide)) return { bucket: 'alreadyClaimed' }; //                        (4.5)
    if (outcome === undefined) return { bucket: 'unsettled' }; //                            (5)
    if (outcome !== makerSide) return { bucket: 'lost', stake }; //                          (6)
    return { bucket: 'wonUnclaimed' }; //                                                    (7)
  };
  const foldPnl = (acc: PnlAcc, v: PnlVerdict): void => {
    switch (v.bucket) {
      case 'push': acc.push += 1; break;
      case 'won': acc.net += v.profit; acc.profit += v.profit; acc.won += 1; break;
      case 'lost': acc.net -= v.stake; acc.loss += v.stake; acc.lost += 1; break;
      case 'alreadyClaimed': acc.alreadyClaimed += 1; break;
      case 'unsettled': acc.unsettled += 1; break;
      case 'wonUnclaimed': acc.wonUnclaimed += 1; break;
    }
  };
  const finalizePnl = (acc: PnlAcc): RealizedPnlAmounts => ({
    netUsdcWei6: acc.net.toString(),
    claimedProfitUsdcWei6: acc.profit.toString(),
    realizedLossUsdcWei6: acc.loss.toString(),
    wonCount: acc.won,
    lostCount: acc.lost,
    pushCount: acc.push,
    wonUnclaimedCount: acc.wonUnclaimed,
    alreadyClaimedCount: acc.alreadyClaimed,
    unsettledCount: acc.unsettled,
  });
  const pnlAggregate = newPnlAcc();
  const pnlByMarket: Record<MarketType, PnlAcc> = { moneyline: newPnlAcc(), spread: newPnlAcc(), total: newPnlAcc() };
  for (const [key, stake] of stakesByPosition) {
    const idx = key.indexOf(':');
    const speculationId = key.slice(0, idx);
    const makerSide = key.slice(idx + 1); // 'away' | 'home'
    const verdict = classifyPosition(stake, makerSide, outcomeBySpeculation.get(speculationId), claimByPosition.get(key), alreadyClaimedPositions.has(key));
    foldPnl(pnlAggregate, verdict);
    foldPnl(pnlByMarket[marketBySpeculation.get(speculationId) ?? 'moneyline'], verdict);
  }

  const fillsBucket = (m: MarketType): { quotedUsdcWei6: string; filledUsdcWei6: string; fillRate: number | null } => ({
    quotedUsdcWei6: quotedByMarket[m].toString(),
    filledUsdcWei6: filledByMarket[m].toString(),
    fillRate: quotedByMarket[m] === 0n ? null : Number(filledByMarket[m]) / Number(quotedByMarket[m]),
  });
  const liveMetrics: LiveMetrics = {
    fills: {
      quotedUsdcWei6: quotedWei6.toString(),
      filledUsdcWei6: filledWei6.toString(),
      fillRate: quotedWei6 === 0n ? null : Number(filledWei6) / Number(quotedWei6),
      byMarket: { moneyline: fillsBucket('moneyline'), spread: fillsBucket('spread'), total: fillsBucket('total') },
    },
    gas: {
      totalPolWei: totalPolWei.toString(),
      byKind: gasByKind,
      totalUsdcEquivWei6,
    },
    settlements: {
      settleCount,
      claimCount,
      totalClaimedPayoutWei6: totalClaimedPayoutWei6.toString(),
    },
    realizedPnl: {
      ...finalizePnl(pnlAggregate),
      byMarket: { moneyline: finalizePnl(pnlByMarket.moneyline), spread: finalizePnl(pnlByMarket.spread), total: finalizePnl(pnlByMarket.total) },
    },
    totalFeeUsdcWei6: totalFeeUsdcWei6.toString(),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [...logPaths],
    lines,
    malformedLines: malformed,
    runIds: [...runIdSet].sort(),
    firstEventAt: kept[0]?.ts ?? null,
    lastEventAt: kept[kept.length - 1]?.ts ?? null,
    ticks,
    eventCounts,
    candidates: { total: candTotal, tracked: candTracked, skipReasons: candSkipReasons },
    quoteIntents: { total: qiTotal, canQuote: qiCanQuote, refused: qiRefused },
    wouldSubmit,
    wouldReplace: { total: wouldReplaceTotal, byReason: wouldReplaceByReason },
    wouldSoftCancel: { total: wouldSoftCancelTotal, byReason: wouldSoftCancelByReason },
    expired,
    quoteCompetitiveness: {
      samples: compSamples,
      atOrInsideBookCount: compAtOrInside,
      atOrInsideBookRate: compSamples > 0 ? compAtOrInside / compSamples : null,
      vsReferenceTicks: vsRefStats === null ? null : { min: vsRefStats.min, p50: vsRefStats.p50, mean: vsRefStats.mean, max: vsRefStats.max },
      unavailable: compUnavailable,
    },
    quoteAgeSeconds: ageStats === null ? null : { samples: completedAges.length, p50: ageStats.p50, p90: ageStats.p90, max: ageStats.max },
    latentExposurePeakWei6: peakLatentWei6.toString(),
    staleQuoteIncidents,
    degradedByReason,
    errors: { total: errTotal, byPhase: errByPhase },
    kill,
    liveMetrics,
  };
}
