# AGENTS.md

Machine-oriented reference for agents (LLMs, scripts, observability tools) interacting with `ospex-market-maker`. Companion to:

- [`README.md`](./README.md) — human onboarding (install, configure, conceptual framing, safety prose).
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design intent, rationale, trade-offs.
- [`docs/OPERATOR_SAFETY.md`](./docs/OPERATOR_SAFETY.md) — operator checklist before going live.
- [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) — guided run-through.

This file is the **machine surface**: command JSON envelopes, telemetry NDJSON vocabulary, state-file schema, and a cookbook of question→command recipes. If you only want to query, parse, or reason about the MM's output, start here.

---

## 1. The MM in one paragraph

`ospex-market-maker` is a long-running TypeScript worker that quotes both sides of a sports speculation on the Ospex protocol (Polygon mainnet, R4 contracts). It posts EIP-712 commitments off-chain via `@ospex/sdk` → `ospex-core-api`, watches takers match them, and auto-settles + auto-claims winning positions on chain. There is **no HTTP surface**. Everything an external observer consumes is one of three artifacts:

1. **Per-CLI-command stdout** — `--json` envelopes shaped `{ schemaVersion: 1, <command>: <Report> }`. Stable contract.
2. **NDJSON event log** — one file per run under `telemetry.logDir/run-<runId>.ndjson`. Stable contract; the source the `summary` aggregator and any future external scorecard read.
3. **JSON state file** — `state.dir/maker-state.json`, atomic-write. Versioned (`version: 1`, matching `MAKER_STATE_VERSION` in `src/state/index.ts` — note this is *not* `schemaVersion`; only the CLI `--json` envelopes use that field name). Operator-inspectable; not a wire contract for other systems (the MM owns it), but documented here so agents can parse it for diagnostics.

Everything else (Heroku logs, internal monitoring) is out of scope for this doc.

---

## 2. CLI surface

Every command supports `--json` (except `run` — it's a loop, not a query; its structured output is the NDJSON log). All `--json` envelopes share the shape `{ schemaVersion: 1, <name>: <Report> }`.

Numeric values that can exceed `Number.MAX_SAFE_INTEGER` (USDC wei6, POL wei18, block numbers) are emitted as **decimal strings**. Booleans, finite numbers, and nested plain objects are emitted as normal JSON.

### 2.1 Command table

| Command | Reads | Writes | JSON envelope | Exit 0 when | Exit 1 when |
|---|---|---|---|---|---|
| `doctor [--address <0x…>] [--json]` | config, keystore, API/RPC reachability, wallet balances + allowance, state file | — (read-only) | `{schemaVersion:1, doctor: DoctorReport}` | no FAIL checks | any FAIL (config invalid, API/RPC unreachable, keystore set but missing, …); a WARN does NOT fail |
| `quote --dry-run <contestId> [--json]` | config, contest + reference odds | — (read-only) | `{schemaVersion:1, quote: QuoteReport}` | `pipeline:'computed' && canQuote:true` | refused (closed, no open speculation, no reference odds, etc.) |
| `candidates [--sport <sport>] [--hours <n>] [--json]` | config, games schedule, contests, per-candidate odds snapshots | — (read-only, signer-free) | `{schemaVersion:1, candidates: CandidatesReport}` | listing succeeded — an **empty result is a valid answer** (exit 0) | operational throw only (config invalid, API unreachable, bad flag) |
| `run --dry-run [--address <0x…>] [--keystore <p>] [--ignore-missing-state]` | config, state, contests, odds | state, telemetry log | (no `--json`) | graceful shutdown (KILL file / SIGTERM/SIGINT) | startup refusal (config invalid, state-loss without override, …) |
| `run --live [--keystore <p>] [--ignore-missing-state] [--yes]` | same + signed adapter | state, telemetry log, **on chain** | (no `--json`) | graceful shutdown | refusal (`mode.dryRun:true` + `--live` mismatch, no keystore, prompt rejected, `--yes`-requiring config without it, ...) |
| `cancel-stale [--authoritative] [--keystore <p>] [--ignore-missing-state] [--json]` | config, state | state (lifecycle stamps), telemetry log, **off-chain DELETE; on-chain cancelCommitment if `--authoritative`** | `{schemaVersion:1, cancelStale: CancelStaleReport}` | clean cleanup | any `errored > 0`, `gasDenied > 0`, or `blockedMissingPayload > 0` (incomplete sweep); refusal (`mode.dryRun:true`, no keystore, state-loss without override, dry: synthetic hash in state, ...) |
| `status [--address <0x…>] [--json]` | config, state, (optional) live `positions.status` | — (read-only) | `{schemaVersion:1, status: StatusReport}` | always 0 (informational; operational throws map to 1 via the CLI wrapper) | only on operational throw |
| `summary [--since <ts>] [--json]` | NDJSON event logs under `telemetry.logDir` | — (read-only) | `{schemaVersion:1, summary: RunSummary}` | always 0 (informational; operational throws map to 1) | only on operational throw or malformed `--since` |

Authoritative source for argument parsing: [`src/cli/index.ts`](./src/cli/index.ts). Each command delegates to a `runX(opts, deps): Report` in its sibling module (`doctor.ts`, `quote.ts`, `candidates.ts`, `run.ts`, `cancel-stale.ts`, `status.ts`, `summary.ts`).

### 2.2 DoctorReport (envelope: `{schemaVersion:1, doctor: …}`)

```typescript
interface DoctorReport {
  schemaVersion: 1;
  configPath: string;
  chainId: 137 | 80002;
  apiUrl: string;
  walletAddress: `0x${string}` | null;
  walletAddressSource: 'flag' | 'keystore' | 'unknown';
  configDryRun: boolean;
  checks: Array<{
    name: 'config' | 'keystore' | 'wallet' | 'api' | 'rpc'
        | 'pol-balance' | 'usdc-balance' | 'allowance' | 'state';
    status: 'ok' | 'warn' | 'fail' | 'skipped';
    detail: string;     // one-line human description
  }>;
  ready: {
    dryRunShadow:    { ok: boolean; reason: string };  // gates the exit code
    postCommitments: { ok: boolean; reason: string };  // informational, never gates
  };
}
```

### 2.3 QuoteReport (envelope: `{schemaVersion:1, quote: …}`)

```typescript
type QuoteReport =
  | { pipeline: 'refused';
      contestId: string;
      reason: string;
      context: QuoteContext;  // contestId, teams, sport, matchTime, status, referenceGameId
    }
  | { pipeline: 'computed';
      contestId: string;
      context: QuoteContext;
      referenceOdds: ReferenceOddsBreakdown;
      spreadMode: 'economics' | 'direct';
      result: QuoteResult;    // canQuote + per-side QuoteSide | null + notes
      inventoryNote: string;
    };
```

Exits 0 only for `pipeline:'computed' && result.canQuote:true`. See [`src/orders/index.ts`](./src/orders/index.ts) for `QuoteResult` / `QuoteSide`.

### 2.4 CancelStaleReport (envelope: `{schemaVersion:1, cancelStale: …}`)

```typescript
interface CancelStaleReport {
  inspected: number;              // total stale records matched
  offchainCancelled: number;
  offchainSkippedAlready: number; // records already in `softCancelled` (incl. recovered soft-cancels — matched on chain after the pull, filledRiskWei6 > 0); off-chain DELETE skipped — --authoritative kills the latent remainder
  offchainSkippedPartial: number; // `partiallyFilled` records; off-chain DELETE skipped (API 409 once matched) — only --authoritative can cancel them
  onchainCancelled: number;       // 0 unless --authoritative was passed
  gasDenied: number;              // records the gas-budget verdict refused (on-chain leg)
  blockedMissingPayload: number;  // 0 unless --authoritative; records whose on-chain cancel was BLOCKED — pre-M6/A (`signedPayloadStatus: 'missing-legacy'`) AND book-hidden (`softCancelled`), so the API redacts the signed payload and `cancelOnchain` has no recovery path. Counts toward exit 1 (incomplete sweep); recover via owner-auth own-state or wait for expiry
  errored: number;                // per-record adapter throws
  gasPolWei: string;              // total POL gas spent on the on-chain leg (wei18 decimal)
  runId: string;                  // filename suffix of this command's event log
}
```

Stale-set rule: `lifecycle ∈ {visibleOpen, softCancelled, partiallyFilled}` AND `postedAtUnixSec + orders.staleAfterSeconds ≤ now` AND not already past `expiry + orders.expiryReleaseGraceSeconds` (a record dead on chain has nothing matchable to invalidate, so it's left for the runner's `ageOut` to reclassify `expired` rather than wastefully off-chain-DELETEd / on-chain-cancelled — same shared `isExpiredForRelease` predicate as every other sweep). Terminal lifecycles (`filled` / `expired` / `authoritativelyInvalidated`) are never in the set. The **off-chain leg skips `partiallyFilled`** records (the API rejects a DELETE once a commitment has matched — `409 COMMITMENT_MATCHED`), counting them in `offchainSkippedPartial`; only `--authoritative` (the on-chain leg) can cancel a matched commitment's remaining capacity.

### 2.5 StatusReport (envelope: `{schemaVersion:1, status: …}`)

```typescript
interface StatusReport {
  schemaVersion: 1;
  configPath: string;
  statePath: string;
  stateIntegrity: 'loaded' | 'fresh' | 'lost';
  stateLossAssessment: {
    holdQuoting: boolean;            // true for `lost` AND for `fresh + prior telemetry`
    reason: string;
    suggestedWaitSeconds?: number;
  };
  lastFlushedAt: string | null;      // ISO-8601 or null (never flushed)
  lastRunId: string | null;
  commitments: {
    total: number;
    byLifecycle: Record<CommitmentLifecycle, number>;
    distinctContestsNonTerminal: number;  // contests with `visibleOpen` / `softCancelled` / `partiallyFilled` records
  };
  positions: {
    total: number;
    byStatus: Record<MakerPositionStatus, { count: number; ownRiskWei6: string }>;
  };
  dailyCounters: {
    today: string;                    // YYYY-MM-DD UTC
    todayGasPolWei: string;
    todayFeeUsdcWei6: string;
    lifetimeGasPolWei: string;
    lifetimeFeeUsdcWei6: string;
  };
  pnl: { realizedUsdcWei6: string; unrealizedUsdcWei6: string; asOfUnixSec: number };
  makerAddress: `0x${string}` | null;
  makerAddressSource: 'flag' | 'keystore' | 'unknown';
  livePositionTotals: {               // SDK's positions.status(maker).totals
    activeCount: number;
    pendingSettleCount: number;
    claimableCount: number;
    claimablePayoutWei6: string;
    pendingSettlePayoutWei6: string;
  } | null;
  livePositionsSkipReason: string | null;
}
```

`status` always exits 0 — it reports state-loss situations instead of refusing. Use `stateLossAssessment.holdQuoting` as the diagnostic signal.

### 2.6 RunSummary (envelope: `{schemaVersion:1, summary: …}`)

```typescript
interface RunSummary {
  schemaVersion: 1;
  generatedAt: string;
  sources: string[];               // event-log file paths aggregated
  lines: number;                   // structurally-valid lines after --since filter
  malformedLines: number;
  runIds: string[];                // sorted
  firstEventAt: string | null;
  lastEventAt: string | null;
  ticks: number;
  eventCounts: Record<string, number>;       // zero-filled for every TelemetryKind
  candidates: { total: number; tracked: number; skipReasons: Record<string, number> };
  quoteIntents: { total: number; canQuote: number; refused: number };
  wouldSubmit: number;
  wouldReplace: { total: number; byReason: Record<string, number> };
  wouldSoftCancel: { total: number; byReason: Record<string, number> };
  expired: number;
  quoteCompetitiveness: {
    samples: number;
    atOrInsideBookCount: number;
    atOrInsideBookRate: number | null;
    vsReferenceTicks: { min: number; p50: number; mean: number; max: number } | null;
    unavailable: number;
  };
  quoteAgeSeconds: { samples: number; p50: number; p90: number; max: number } | null;
  latentExposurePeakWei6: string;
  staleQuoteIncidents: number;
  degradedByReason: Record<string, number>;
  errors: { total: number; byPhase: Record<string, number> };
  kill: { reason: string; ticks: number } | null;
  liveMetrics: LiveMetrics;        // see §5
}
```

The `summary` command threads `config.gas.nativeTokenUSDCPrice` into `summarize` when `config.gas.reportInUSDC: true`, populating `liveMetrics.gas.totalUsdcEquivWei6`.

### 2.7 CandidatesReport (envelope: `{schemaVersion:1, candidates: …}`)

The quote-target / setup-target preflight. Read-only and signer-free (no keystore, no writes). Each in-window game/contest gets exactly one `kind`; the allow-list **annotates** (`inContestAllowList`) but never hides; the deny-list skips (`skipReason: 'deny-list'`).

```typescript
interface CandidatesReport {
  generatedAt: string;                   // ISO-8601 UTC
  config: { sports: string[];
            hours: number;              // the games leg's window (1-720)
            contestsHours: number;      // the contests leg's effective window: min(hours, 168) — the contests
                                        //   API caps at 168h while the games API allows 720h. Beyond 168h only
                                        //   game rows are visible, so a created game out there classifies
                                        //   needs_verification with contestStatus: null
            maxTrackedContests: number;
            requireReferenceOdds: boolean; contestAllowListSize: number };
  summary: {
    gamesAvailableToCreate: number;      // == count of kind 'setup'
    quoteReady: number;
    needsContest: number;                // planning-doc parity alias — always == gamesAvailableToCreate
    needsMoneylineSpeculation: number;
    needsVerification: number;
    skipped: Record<string, number>;     // by skipReason; only nonzero reasons present
  };
  truncated: boolean;                    // a pagination bound was hit — the listing may be incomplete
  items: CandidateItem[];                // sorted: kind priority (quote_ready, needs_moneyline_speculation,
                                         //   needs_verification, setup, skipped), then matchTime ascending
}

interface CandidateItem {
  kind: 'quote_ready' | 'needs_moneyline_speculation' | 'needs_verification' | 'setup' | 'skipped';
  gameId: string | null;                 // stable schedule id — key on this, never slug; null when no game row joined
  slug: string | null;                   // display-only; mutable (doubleheader renames)
  sport: string;
  awayTeam: string;                      // full team names, always
  homeTeam: string;
  matchTime: string;                     // ISO-8601 UTC
  status: string | null;                 // game status ('upcoming' | 'live' | 'final' | 'postponed' | 'cancelled'); null when no game row
  hasOdds: boolean | null;
  canCreateContest: boolean | null;
  contestCreated: boolean;
  contestId: string | null;
  moneylineSpeculationId: string | null; // the open moneyline speculation, when one exists
  recommendedAction: 'quote' | 'seed_moneyline_speculation' | 'wait_for_verification'
                   | 'create_contest_then_seed_moneyline' | null;   // null on 'skipped'
  contestStatus?: string | null;         // ALWAYS present on quote_ready / needs_moneyline_speculation / needs_verification
                                         //   ('verified' / 'unverified' / …; null = contest row not visible yet);
                                         //   on 'skipped' only when the skip is contest-backed; never on 'setup'
  referenceOdds?: { awayAmerican: number | null; homeAmerican: number | null } | null;  // 'quote_ready' only
  inContestAllowList?: boolean;          // contest-backed items; present iff marketSelection.contestAllowList is non-empty
  skipReason?: 'started-or-live' | 'no-odds' | 'no-reference-odds' | 'cannot-create-contest'
             | 'deny-list' | 'not-quotable-status' | 'game-status-postponed-or-cancelled';  // 'skipped' only
}
```

Classification table (one `kind` per item):

| kind | condition | recommendedAction |
|---|---|---|
| `quote_ready` | contest `verified` + open `moneyline` speculation + (odds present, when `requireReferenceOdds`) | `quote` |
| `needs_moneyline_speculation` | contest `verified`, no open moneyline speculation | `seed_moneyline_speculation` |
| `needs_verification` | game created but contest not yet `verified` (or contest row not visible yet) | `wait_for_verification` |
| `setup` | game upcoming, `contestCreated=false`, `canCreateContest=true`, `hasOdds=true` | `create_contest_then_seed_moneyline` |
| `skipped` | anything else in the window — see `skipReason` | `null` |

---

## 3. Telemetry NDJSON contract

Every line of `<telemetry.logDir>/run-<runId>.ndjson` is:

```json
{ "ts": "<ISO-8601>", "runId": "<runId>", "kind": "<TelemetryKind>", ...payload }
```

The line shape itself is unversioned — consumers branch on `kind`. Lines are append-only, written synchronously with `appendFileSync`, sorted by `ts` when aggregated across files. Stable contract: the per-`kind` payload schemas below are the agreement.

Canonical vocabulary (`TELEMETRY_KINDS` in [`src/telemetry/index.ts`](./src/telemetry/index.ts)):

### 3.1 Lifecycle

| `kind` | Emitted by | Payload |
|---|---|---|
| `tick-start` | runner, every tick | `{ tick: number }` |
| `kill` | runner, on graceful shutdown (KILL file / SIGTERM / SIGINT) | `{ reason: string, ticks: number }` |
| `error` | any phase that catches a throw | `{ class: string, detail: string, phase?: string, contestId?, commitmentHash?, speculationId? }`. Known `phase` values at this writing: `'tick'`, `'discovery'`, `'odds-seed'`, `'odds-poll'`, `'odds-unsubscribe'`, `'reconcile'`, `'submit'`, `'cancel'`, `'onchain-cancel'`, `'fill-detection'`, `'fill-detection-lookup'`, `'position-poll'`, `'softcancel-recovery'`, `'approve'`, `'settle'`, `'claim'`, `'own-state-stream'` (Phase 2 PR4a — non-fatal transport error from the SDK's own-state SSE subscription), `'own-state-unsubscribe'` (Phase 2 PR4a — throw from `await subscription.unsubscribe()` on shutdown), `'own-state-health-poll'` (Phase 3 PR2c-i — throw from the indexer-lag `client.ownState.health()` poll; fail-closed degrades the §5 latch 6 posting gate). Since the own-state polling retirement, `'fill-detection'` / `'fill-detection-lookup'` / `'position-poll'` / `'softcancel-recovery'` errors arise from the per-tick AUDIT probes — the poll survives only as a cross-check of the canonical SSE-derived state; a probe error marks the audit cycle failed (the divergence comparator skips it, latches preserved) and never gates the tick. `summary` aggregates by phase with `'(none)'` for absent. **Treat the list as authoritative-but-additive** — new runtime paths may add phases without bumping `schemaVersion`; consumers should handle unknown phases gracefully (bucket them as `'other'` rather than rejecting). Source of truth: `grep "phase: '" src/runners/index.ts`. |

### 3.2 Per-market reconcile (in tick order)

| `kind` | Payload |
|---|---|
| `candidate` | `{ contestId?: string, skipReason?: CandidateSkipReason, takerSide?: 'away' \| 'home', ...skip-specific }`. **No `skipReason`** = the contest was *tracked* (and `contestId` is present). Skip-specific fields: `cap-hit` → `contestId`, `takerSide`; `tracking-cap-reached` / `no-reference-odds` / `no-open-speculation` / `would-create-lazy-speculation` / `stale-reference` / `start-too-soon` / `refused-pricing` → `contestId` plus skip-reason-specific context; `gas-budget-blocks-settlement` → `purpose: 'settleSpeculation' \| 'claimPosition'`, `speculationId`, `contestId`, `makerSide`, `mayUseReserve: boolean`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail`; `gas-budget-blocks-onchain-cancel` → `commitmentHash`, `speculationId`, `makerSide`, `contestId?`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail`. **Producers — two emit shapes:** (1) **automatic & reserve-preserving** — `canSpendGas(mayUseReserve: false)`, **includes `contestId`** (all route through the shared `onchainCancelCommitment`): the routine `orders.cancelMode: onchain` cancels (a retained `partiallyFilled` remainder OR a recovered soft-cancel), the funding guard's `underfundedCancelMode: onchain` sweep, and the §5.1 own-state-health active cancel-sweep (PR3b-ii) — an automatic guard must not burn the emergency reserve, so each leaves the record matchable and retries (on the normal cadence, or the next held tick after a gas-denied break). (2) **operator-explicit & reserve-eligible** — `mayUseReserve: true`, **omit `contestId`**: the shutdown kill / `cancel-stale --authoritative` paths, which break the cancel loop on the first denial since today's spend only grows; `gas-budget-blocks-reapproval` → `purpose: 'positionModule-approve'`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail` (no `contestId` — the boot-time auto-approve isn't per-market); `already-settled` → `purpose: 'settleSpeculation'`, `speculationId`, `contestId`, `makerSide`, `outcome: 'alreadySettled' \| 'recovered'`, `winSide`, `revertedTxHash?`, `gasPolWei?`, `gasAccountingGap?`; `already-claimed` → `purpose: 'claimPosition'`, `speculationId`, `contestId`, `makerSide`, `outcome: 'alreadyClaimed' \| 'recovered'`, `revertedTxHash?`, `gasPolWei?`, `gasAccountingGap?` — the two idempotent-skip reasons emit **no** `settle`/`claim` event and (for `already-claimed`) **no** payout; a reverted inclusion-race tx of ours debits `gasPolWei` (summed under `settle`/`claim` respectively), else `gasAccountingGap: true`. |
| `quote-intent` | `{ contestId, speculationId, sport, awayTeam, homeTeam, canQuote: boolean, away: QuoteSideSummary \| null, home: QuoteSideSummary \| null, notes: string[] }`. `QuoteSideSummary` = `{ takerOddsTick, takerImpliedProb, makerSide, makerOddsTick, positionType, sizeUSDC, sizeWei6 }`. |
| `risk-verdict` | `{ contestId, speculationId, sport, awayTeam, homeTeam, allowed: boolean, awayOffer: { allowed: boolean, sizeUSDC: number, headroomUSDC: number }, homeOffer: {…}, notes: string[] }`. Emitted **after** pre-engine gates pass (not for `no-reference-odds` / `start-too-soon` / `stale-reference` / `no-open-speculation` skips). |
| `quote-competitiveness` | `{ contestId, speculationId, side: 'away' \| 'home', quoteTick, quoteProb, makerSide, makerOddsTick, positionType, referenceTick, referenceProb, vsReferenceTicks, bookDepthOnSide, bestBookTick, atOrInsideBook }` |
| `competitiveness-unavailable` | `{ contestId, speculationId, reason: string }` (orderbook not populated) |

### 3.3 Order lifecycle (`would-*` in dry-run, plain in live)

| `kind` | Payload |
|---|---|
| `submit` / `would-submit` | `{ commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, riskAmountWei6, expiryUnixSec, takerOddsTick, takerImpliedProb }`. Live submit signs + POSTs the EIP-712 commitment via `commitments.submitRaw` (the API relay path); gasless — no `gasPolWei`. |
| `replace` / `would-replace` | `{ replacedCommitmentHash, newCommitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, reason: 'stale' \| 'mispriced', fromMakerOddsTick, toMakerOddsTick, fromTakerOddsTick, toTakerOddsTick, riskAmountWei6, expiryUnixSec }` |
| `soft-cancel` / `would-soft-cancel` | `{ commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, reason: SoftCancelReason }` |
| `expire` | `{ commitmentHash, speculationId, contestId, makerSide, oddsTick }` — clock-only terminalization; headroom released |
| `onchain-cancel` | `{ commitmentHash, speculationId, contestId, makerSide, txHash, gasPolWei: string }` — `MatchingModule.cancelCommitment` landed (the routine `cancelMode: onchain` cancel of a matched remainder — a visible `partiallyFilled` retained partial OR a recovered soft-cancel, i.e. soft-cancelled then matched on chain — the funding guard's `underfundedCancelMode: onchain` sweep, the §5.1 own-state-health active cancel-sweep (PR3b-ii), or the operator-explicit shutdown kill / `cancel-stale --authoritative`). Record → `authoritativelyInvalidated`. |
| `cancel-blocked-missing-payload` | `{ commitmentHash, speculationId, contestId, makerSide, lifecycle, reason: 'missing-legacy-signed-payload-and-hidden', detail: string, phase?: 'shutdown-kill' \| 'cli-cancel-stale' }` — an on-chain cancel sweep hit a pre-M6/A record (`signedPayloadStatus: 'missing-legacy'`) that is also book-hidden (`lifecycle: 'softCancelled'`): the public commitments API redacts the signed payload (M2) so `cancelOnchain` has no recovery path. The record is SKIPPED (no cancel attempted, no gas spent) and its latent exposure rides to expiry. Emitted once per stuck record per sweep — the routine `cancelMode: onchain` recovered-soft-cancel pre-pass (no `phase`), the shutdown kill (`phase: 'shutdown-kill'`), or `cancel-stale --authoritative` (`phase: 'cli-cancel-stale'`). **Operator action required**: recover the payload via owner-auth own-state or wait for expiry (own-state SSE plan §M6). |
| `approval` | `{ purpose: 'positionModule', spender, currentAllowance, requiredAggregateAllowance, amountSetTo, walletBalanceWei6?, txHash, gasPolWei }` — `walletBalanceWei6` present in `mode:'exact'`, absent in `mode:'unlimited'` |

### 3.4 Fills + positions

| `kind` | Payload |
|---|---|
| `fill` (source `'own-state-stream'`) | `{ source: 'own-state-stream', commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, newFillWei6, cumulativeRiskWei6 }` — the **only live fill source** since the own-state polling retirement: an owner `fill` delivered over the own-state SSE stream (the canonical state writer in live mode), deduped on `(txHash, logIndex)`. Creates/extends the maker-side position record; `cumulativeRiskWei6` is the position's post-fill own risk. The commitment's `filledRiskWei6` bump arrives separately via the stream's `commitment` event. |
| `fill` (source `'commitment-diff'`) | **RESERVED — not emitted since the own-state polling retirement** (historical logs may contain it; the audit probes suppress their fill descriptors). `{ source: 'commitment-diff', commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, newFillWei6, filledRiskWei6, partial: boolean }` |
| `fill` (source `'position-poll'`) | **RESERVED — not emitted since the own-state polling retirement** (historical logs may contain it). `{ source: 'position-poll', positionId, speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, newFillWei6, cumulativeRiskWei6 }` — was the backfill from `getPositionStatus`; no `makerOddsTick` (the API surfaces aggregate own/counterparty stake, not per-fill ticks) |
| `fill` (source `'softcancel-recovery'`) | **RESERVED — not emitted since the own-state polling retirement** (historical logs may contain it). `{ source: 'softcancel-recovery', commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, newFillWei6, filledRiskWei6, partial: boolean }` — was `reconcileSoftCancelledFills` converging a `softCancelled` commitment's `filledRiskWei6` up to the authoritative cumulative `getCommitment` reports (a soft-cancelled signed payload that matched on chain — invisible to `commitment-diff`, which can't see soft-cancelled rows). **Commitment-only — did NOT mutate the position.** Same payload shape as `'commitment-diff'`. |
| `position-transition` | `{ positionId, speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, fromStatus, toStatus, result?: 'won' \| 'push' \| 'void', predictedWinSide?: 'away' \| 'home' \| 'over' \| 'under' \| 'push' }`. `fromStatus`/`toStatus` ∈ `'active' \| 'pendingSettle' \| 'claimable'`. `result` carried on `pendingSettle` and `claimable`; `predictedWinSide` on `pendingSettle` only. |
| `settle` | `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, winSide: 'away' \| 'home' \| 'push' \| 'over' \| 'under', txHash, gasPolWei }` — `SPECULATION_SETTLED` landed |
| `claim` | `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, payoutWei6, txHash, gasPolWei, result?: 'won' \| 'push' \| 'void' }` — `POSITION_CLAIMED` landed; `result` (when present) is authoritative for `summary`'s realized-P&L classification (origin: `ClaimablePositionView.result`); local `MakerPositionStatus` stamped `'claimed'` |

### 3.5 Environment

| `kind` | Payload |
|---|---|
| `degraded` | `{ contestId, referenceGameId, reason: 'channel-error' \| 'subscribe-failed' \| 'channel-cap', detail?: string }` — odds channel issue; the market is treated as stale-reference |
| `stream-health-degraded` | Reason-discriminated own-state-health degrade signal, emitted ONCE on the degrade edge (not every check). **`reason: 'queue-overflow'`** → `{ shadowReady: boolean, queueCapacity: number }` — own-state SSE queue overflowed (dropped owner events); latched at enqueue time, cleared by a `resync` rebaseline. **`reason: 'indexer-lag'`** → `{ indexerLagSeconds: number, indexerLagMaxSeconds: number, lagSource: string }` (Phase 3 PR2c-i) — the `client.ownState.health()` poll (every `ownState.auditPollIntervalMs`) reported the indexer's lag at/above `ownState.indexerLagMaxSeconds`. **`reason: 'poll-failed'`** → `{}` (PR2c-i) — that health poll threw; fail-closed (degraded). The `indexer-lag` / `poll-failed` clears are SILENT (the latch flips back on a successful in-bounds poll; recovery shows via `stream-health-hold {state:'cleared'}` when live). In **dry-run** all of these are observability only (no subscription is opened; no trading change). In **live mode** — the own-state stream is always on — they degrade composite own-state health, so the §5.1 posting gate halts NEW posting — see `stream-health-hold`. None ever sets `fundingHold` or runs `fundingCancelSweep` (those are the separate funding guard). |
| `stream-would-hold` | `{ reason: 'queue-overflow', exposureWei6: string }` — accompanies `stream-health-degraded` IFF open exposure > 0. Informational marker that an overflow occurred with exposure at risk. In live mode the §5.1 gate acts on the degradation (`stream-health-hold`); in dry-run it stays informational. |
| `stream-health-hold` | `{ state: 'entered', severity: 'high' \| 'low', exposureWei6: string }` on enter / `{ state: 'cleared' }` on clear — the §5.1 own-state-health posting gate (Phase 3 PR2a) tripped or cleared. While **entered**, `reconcileMarkets` refuses NEW posting (the maker's own-state view is degraded, so adding/compounding exposure is unsafe). `severity: 'high'` iff there is open exposure to protect (`computeOpenExposureWei6 > 0`), else `'low'`. Emitted ONCE per enter/clear transition. The composite own-state health degrades on ANY §5 latch — currently: a queue overflow, a STALE transport (no SSE frame, heartbeats included, within `ownState.staleMaxMs`, PR2b), a token-refresh auth failure (PR2b), an indexer lagging at/above `ownState.indexerLagMaxSeconds` or a failed health poll (PR2c-i), a persistent audit-vs-canonical divergence (PR2c-ii — see `divergence`), a position-truncated baseline, a canonical own-state mapping failure (PR3b — see `owner-mapping-failed`, an incomplete-book signal), or a fatal stream error — and (for the transport-mirror inputs) must then stay continuously healthy for `ownState.recoveryHoldMs` before the gate clears. The posting-only latches (indexer-lag, audit-divergence) gate posting WITHOUT resetting that recovery hold — they clear the gate the instant the underlying check passes again. **Live only** — the own-state stream (and with it this gate + sweep) is always on in live mode since the own-state polling retirement; inert in dry-run (no subscription is opened). Distinct from `stream-would-hold` (the Phase-2 informational marker, which never actually held). **While a `high`-severity hold is active (PR3b-ii), the runner ALSO actively sweeps the at-risk exposure**: it pulls every still-matchable `visibleOpen` quote off the relay (`soft-cancel` reason `'stream-health'`) and, under `orders.cancelMode: onchain`, authoritatively cancels every still-matchable non-terminal record on chain (`onchain-cancel` → `authoritativelyInvalidated`) — the two-leg `streamHealthCancelSweep`, modeled on the funding guard's `fundingCancelSweep` but keyed off `orders.cancelMode`. A `low`-severity hold (no open exposure) performs no sweep. |
| `divergence` | `{ count: number, byField: Record<DivergenceField, number>, examples: DivergenceExample[], streamObservedAt: number, pollObservedAt: number, sinceMs: number }` — Phase 3 PR3b **audit-vs-canonical** comparator (inverted from the Phase-2 shadow comparator at the source flip). Aggregated per-tick when the AUDIT (poll-derived) source disagrees with CANONICAL (SSE-derived) own-state past the tolerance window (`ownState.divergenceToleranceMs`, default 5000ms). `DivergenceField` ∈ `'commitment-lifecycle' \| 'commitment-filled' \| 'position-status' \| 'position-risk' \| 'missing-in-audit' \| 'missing-in-canonical'`, where **`missing-in-audit`** = canonical (SSE) has the row but the audit (poll) lacks it, and **`missing-in-canonical`** = the audit (poll) has it but canonical (SSE) lacks it. Each `DivergenceExample` is `{ field, key, canonical: string|number|null, audit: string|number|null }` (the Phase-2 `shadow` value field is renamed `audit`). `streamObservedAt` = last canonical-side (SSE) event ms; `pollObservedAt` = last audit-side (poll) observation ms. Examples are capped at 5. Persistent mismatch (`sinceMs >= toleranceMs`) is emitted regardless of source-side freshness. Comparator is read-only on canonical state. **Live only**: an emit-worthy divergence ALSO sets §5 latch 5 (`auditDivergenceUnresolved`), a posting-only gate input — so a persistent divergence halts NEW posting (via `stream-health-hold`) until a later cycle (one that actually observed the API) reads clean or a rebaseline (`resync` / cold-restart) clears it; the comparator gates on the transport-only `instantOwnStateHealthy` (NOT this latch), so it always keeps re-evaluating (no self-deadlock). It does NOT run in dry-run, and a failed audit cycle is skipped (so a failed poll can't clear a real divergence). |
| `unknown-own-fill` | `{ commitmentHash: string, speculationId: string, txHash: string, logIndex: number }` — Phase 3 PR3b §7.2. **Live only** (dry-run never subscribes). An SSE `fill` event arrived for a `commitmentHash` not present in canonical `MakerState` — the orphan fill is NOT applied (a `Fill` carries no contest identity to materialize a position), cursor promotion freezes past it, §5 latch 5 (`auditDivergenceUnresolved`) holds posting, and a cursor-less cold restart is requested so a fresh baseline reconciles (or the orphan never lands — the correct terminal state for that inconsistency). |
| `owner-mapping-failed` | `{ class: 'OwnerMappingError', field: string, commitmentHash?: string, speculationId?: string, detail: string, phase: 'own-state-stream' }` — Phase 3 PR3b §6. **Live only** (dry-run never subscribes). A canonical own-state mapper (`mapOwner*ToMaker`) threw on an SSE payload missing metadata a `Maker*Record` requires non-null — the offending row is SKIPPED (fail-closed; never a partial record). Because the SSE is the canonical writer, a skipped row means `MakerState` is incomplete, so own-state latches unhealthy (a mapping-degraded composite-health input) and the §5.1 posting gate HOLDS. The latch SELF-HEALS (F1): both the live-delta drain and the `onReady` incomplete-baseline check request a cursor-less cold restart (`stream-cold-restart {reason: 'mapping-degraded'}`) whose fresh re-snapshot re-grounds the book and clears the latch on a clean baseline — recovery no longer requires an external server resync. A PERSISTENT gap (the fresh snapshot still carries the malformed row) re-trips on each baseline, rate-limited to one restart per `ownState.debounceMs` by the wake loop, so it surfaces as repeated `stream-cold-restart` + a held gate rather than a silent permanent outage. Exactly one of `commitmentHash` / `speculationId` is populated. |
| `funding-hold` | `{ state: 'entered' \| 'cleared', reason: 'funding-shortfall' \| 'read-failed', fundingWei6?, requiredWei6?, walletUsdcWei6?, positionModuleAllowanceWei6? }` — the funding guard (DESIGN §6) tripped or cleared. Emitted ONCE per enter/clear transition (a sustained hold doesn't spam the log). `reason: 'funding-shortfall'` = the wallet can no longer back its matchable-commitment exposure; `'read-failed'` = the balance/allowance read itself threw (fail-closed). While held, the funding sweep pulls every `visibleOpen` quote off the relay (`soft-cancel` reason `'funding'`) and, under `underfundedCancelMode: onchain`, on-chain-cancels matchable partials; no NEW posting until cleared. The wei6 numeric context is attached when known. |
| `stream-cold-restart` | `{ reason: 'mapping-degraded' }` — the own-state SSE stream was cold-restarted (close + reopen, cursor-less). `'mapping-degraded'` (F1 self-heal) is the only emitted reason: a canonical own-state mapper failed on a live delta or an incomplete fresh baseline, so the stream re-grounds via a cursor-less re-snapshot that clears the §5.1 hold on a clean baseline (see `owner-mapping-failed`). A PERSISTENT gap re-trips this on each fresh baseline, rate-limited to one restart per `ownState.debounceMs` by the wake loop, surfacing as repeated `stream-cold-restart` + a held gate rather than silence. **Live only** (dry-run never subscribes). |

### 3.6 Reserved (not yet emitted)

| `kind` | Notes |
|---|---|
| `fair-value` | Reserved in `TELEMETRY_KINDS`. Pricing computes fair internally; not surfaced as an event yet. |
| `nonce-floor-raise` | Reserved. `raiseMinNonce` bulk-invalidate is documented as a future optimization (the on-chain cancels are currently per-commitment across the shutdown kill path, `cancel-stale --authoritative`, the routine `cancelMode: onchain` partial-remainder cancel, the funding guard's `underfundedCancelMode: onchain` sweep, and the §5.1 own-state-health active cancel-sweep). |

### 3.7 Skip-reason vocabulary (`CANDIDATE_SKIP_REASONS`)

```
'no-reference-odds' | 'no-open-speculation' | 'would-create-lazy-speculation'
'stale-reference' | 'start-too-soon' | 'cap-hit' | 'refused-pricing'
'tracking-cap-reached' | 'gas-budget-blocks-reapproval'
'gas-budget-blocks-settlement' | 'gas-budget-blocks-onchain-cancel'
'partial-remainder-retained' | 'already-settled' | 'already-claimed'
```

`refused-pricing` / `cap-hit` arrive during the per-market reconcile. The three `gas-budget-blocks-*` arrive from the on-chain write paths (boot approve, auto-settle/claim, shutdown kill / cancel-stale, the routine `cancelMode: onchain` partial-remainder cancel, the funding guard's `underfundedCancelMode: onchain` sweep, and the §5.1 own-state-health active cancel-sweep). `partial-remainder-retained` marks a `partiallyFilled` remainder the runner left in place — never off-chain-cancelled (the API rejects a DELETE once matched), never reposted over (would double side exposure); its payload is `{ commitmentHash, contestId, speculationId, makerSide, takerSide, reason }`, where `reason ∈ {side-not-quoted, stale, mispriced, duplicate, shutdown}` is why it would have been actioned were it a `visibleOpen`. `already-settled` is the auto-settle idempotent skip — emitted when `ensureSpeculationSettled` finds the speculation already settled (pre-flight) or recovers from a concurrent settle, so a lost race is a boring skip rather than an `error`. Payload `{ purpose: 'settleSpeculation', speculationId, contestId, makerSide, outcome: 'alreadySettled' | 'recovered', winSide, revertedTxHash?, gasPolWei?, gasAccountingGap? }` — `gasPolWei` is present (and debited to the daily counter) when our settle reverted on inclusion (POL was spent on the lost race); `gasAccountingGap: true` flags that such a reverted tx's gas couldn't be fetched, so budget state isn't exact. `already-claimed` is the auto-claim idempotent skip — emitted when `ensurePositionClaimed` finds the position already claimed (pre-flight) or recovers from a benign already-claimed race (a prior run / concurrent caller / `claimable`-projection lag), so it's a boring skip rather than an `error`, and it is **NOT** a `claim` event (no event-sourced payout — the contract zeroes economic fields post-claim, so none is derived). Payload `{ purpose: 'claimPosition', speculationId, contestId, makerSide, outcome: 'alreadyClaimed' | 'recovered', revertedTxHash?, gasPolWei?, gasAccountingGap? }` — same gas semantics as `already-settled` (a reverted inclusion-race claim of ours debits `gasPolWei`, summed under `claim`; `gasAccountingGap: true` flags an unfetchable reverted receipt). The run summary classifies these positions `alreadyClaimed` (not `wonUnclaimed`) and folds no payout into realized P&L. The others are pre-engine market-discovery gates.

### 3.8 Soft-cancel + replace reasons

```
SoftCancelReason: 'side-not-quoted' | 'duplicate' | 'shutdown' | 'funding' | 'stream-health'
                | 'stale' | 'mispriced'        // = ReplaceReason
ReplaceReason:   'stale' | 'mispriced'
```

`'stale'` and `'mispriced'` appear on `would-replace` / `replace` (replacement actions) AND on `would-soft-cancel` / `soft-cancel` (when the replacement was deferred for cap budget). `'side-not-quoted'` only on soft-cancels. `'duplicate'` on book-hygiene pulls. `'shutdown'` only on the kill-switch's unconditional off-chain sweep. `'funding'` only on the funding guard's underfunded sweep (DESIGN §6) — when the wallet can no longer back its matchable-commitment exposure, every `visibleOpen` quote is pulled off the relay (`underfundedCancelMode: offchain | onchain`). `'stream-health'` only on the §5.1 own-state-health active cancel-sweep (PR3b-ii) — when the own-state SSE view is degraded WITH open exposure (the `high`-severity `stream-health-hold`), every `visibleOpen` quote is pulled off the relay (`orders.cancelMode: offchain | onchain`), so no NEW fills land against a book the MM can't observe. **All soft-cancels target `visibleOpen` records only** — a `partiallyFilled` remainder is never off-chain-cancelled (the API rejects a DELETE once matched); it surfaces as a `partial-remainder-retained` candidate (§3.7) carrying the same reason vocabulary, **except `'funding'` and `'stream-health'`**: those two sweeps emit no `partial-remainder-retained` — an underfunded / stream-health partial is authoritatively on-chain-cancelled under `onchain` mode (`underfundedCancelMode` / `orders.cancelMode` respectively), else left to ride to expiry.

---

## 4. State file

Path: `<state.dir>/maker-state.json`. Atomic write (temp + rename). Single-writer; not multi-process safe. Loaded at boot via `StateStore.load()` which returns `{state, status: {kind: 'loaded' | 'fresh' | 'lost', reason?}}` — `lost` means the file exists but failed validation.

> ⚠️ **Sensitive bearer-credential state (own-state SSE plan §M6).** Post-M6/A, each commitment record persists the SDK's canonical signed bundle (`signedPayload` — EIP-712 signature + the inner typed-data struct). That bundle is exactly what `MatchingModule.matchCommitment` needs to fill the commitment, so anyone with read access to this file can fill the maker's still-matchable commitments until they expire / fill / are cancelled. Agents and scripts parsing this file:
>
> - **Must NEVER paste the file (or any record's `signedPayload` / `signature` / `commitment` subtree) into issues, PRs, chat, logs, or any artifact channel.** It's a bearer credential.
> - The file is created at POSIX mode `0o600` from birth (`StateStore.flush` uses `O_WRONLY|O_CREAT|O_EXCL` + post-create POSIX sanity check) and the operator restricts the `state.dir` parent ACL on Windows. The full operator playbook is in [`docs/OPERATOR_SAFETY.md`](./docs/OPERATOR_SAFETY.md#sensitive-local-state).
> - The MM's `EventLog.emit` (the NDJSON writer that feeds the scorecard) throws on denied keys (`signature` / `signedPayload` / `commitment` / `nonce`) and redacts 65-byte ECDSA signature substrings and JSON-shape signing-key markers in every string value, so telemetry output stays safe to share even if an upstream error message incidentally quotes a signature. The state file does NOT have this protection — it's the raw bundle.

### 4.1 Schema

```typescript
const MAKER_STATE_VERSION = 1;

interface MakerState {
  version: 1;                       // monotonic; older versions are rejected as `lost`
  lastRunId: string | null;
  commitments: Record<string, MakerCommitmentRecord>;  // keyed by EIP-712 hash
  positions: Record<string, MakerPositionRecord>;      // keyed by `${speculationId}:${makerSide}`
  pnl: { realizedUsdcWei6: string; unrealizedUsdcWei6: string; asOfUnixSec: number };
  dailyCounters: Record<string, { gasPolWei: string; feeUsdcWei6: string }>;  // keyed by YYYY-MM-DD UTC
  lastFlushedAt: string | null;     // ISO-8601
}

interface MakerCommitmentRecord {
  hash: string;                     // EIP-712 hash, or `dry:<runId>:<n>` in dry-run (rejected at live boot)
  speculationId: string;
  contestId: string;
  sport: string;                    // denormalized
  awayTeam: string;                 // denormalized
  homeTeam: string;                 // denormalized
  scorer: string;
  makerSide: 'away' | 'home';
  oddsTick: number;                 // uint16 ticks at 100× scale (1.91 = 191)
  riskAmountWei6: string;
  filledRiskWei6: string;           // '0' unless partially filled
  lifecycle: CommitmentLifecycle;
  expiryUnixSec: number;
  postedAtUnixSec: number;
  updatedAtUnixSec: number;
  // M6/A — own-state SSE plan §M6. Bearer-credential material; see §4 warning.
  signedPayload?: MakerSignedPayload;   // present iff signedPayloadStatus === 'present'
  signedPayloadStatus: SignedPayloadStatus; // REQUIRED — authoritative discriminant for the cancel path
  // Phase 2 PR1 — own-state SSE plan §2.5.3. Observed on-chain fills for this
  // commitment, append-only, in arrival order. Pre-Phase-2-PR1 state files
  // load with `fills: []` via validator migration. Populated by the SSE `fill`
  // reducer; the audit probes NEVER append (no txHash/logIndex available).
  fills: MakerCommitmentFill[];
}

// One observed on-chain Match log event for the maker — an append-only audit /
// history record. The (txHash, logIndex) pair is the canonical dedup key (see
// `fillDedupKey`), used at RUNTIME by the SSE fill reducer to drop overlap
// re-deliveries; it is NOT reconstructed from `fills[]` at cold start. Restart
// dedup is the snapshot-subsumes path — the fresh snapshot's position risk
// already reflects prior fills and the server flows only post-snapshot fills live
// (own-state-sse-plan §2.5.3's proposed cold-start reconstruction was removed as
// dead-in-practice).
interface MakerCommitmentFill {
  txHash: string;                   // 0x-prefixed; the matching tx hash
  logIndex: number;                 // non-negative integer; log index within the tx
  amountWei6: string;               // delta of this fill (USDC wei6 decimal string); NOT the post-fill cumulative
  ts: number;                       // unix seconds when the MM observed and applied this fill
}

// The SDK's canonical SignedCommitmentPayload, persisted with the four bigint
// fields encoded as decimal strings (JSON.stringify rejects native bigints).
// Stored verbatim so cancel paths can call cancelCommitmentOnchain({signedCommitment})
// without round-tripping the public commitments API (which redacts hidden rows
// post v0.5.0/M2). The validator cross-checks signedPayload.commitmentHash ===
// record.hash on load; a drift fails the file as `lost`.
interface MakerSignedPayload {
  commitmentHash: string;           // 0x-prefixed; equals the parent record's hash
  commitment: {
    maker: string;                  // 0x-prefixed address
    contestId: string;              // uint256 as decimal string
    scorer: string;                 // 0x-prefixed address
    lineTicks: number;              // signed int
    positionType: 0 | 1;            // 0=away, 1=home (per Ospex protocol)
    oddsTick: number;               // uint16 in [101, 10100]
    riskAmount: string;             // uint256 wei6 as decimal string
    nonce: string;                  // uint256 as decimal string
    expiry: string;                 // uint256 (unix seconds) as decimal string
  };
  signature: string;                // 0x-prefixed 65-byte ECDSA signature (132 chars total)
}

interface MakerPositionRecord {
  speculationId: string;
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  side: 'away' | 'home';
  riskAmountWei6: string;           // own staked risk
  counterpartyRiskWei6: string;     // counterparty's stake (the payout-above-stake delta on a win)
  status: MakerPositionStatus;
  result?: 'won' | 'push' | 'void'; // captured at pendingSettle/claimable from ClaimablePositionView.result
  updatedAtUnixSec: number;
}
```

### 4.2 Enums

```
CommitmentLifecycle: 'visibleOpen' | 'softCancelled' | 'partiallyFilled'
                   | 'filled' | 'expired' | 'authoritativelyInvalidated'

MakerPositionStatus: 'active' | 'pendingSettle' | 'claimable' | 'claimed'
                   | 'settledLost' | 'void'   // settledLost/void are terminal zero-payout, produced by the canonical own-state SSE mapper (PR3b); the poll/audit path never produces them (the API has no settledLost/void bucket). All three of claimed/settledLost/void are immutable terminals.

SignedPayloadStatus: 'present' | 'missing-legacy'
```

**Lifecycle invariants**:
- `visibleOpen`, `softCancelled`, `partiallyFilled` — **non-terminal**; still matchable on chain until expiry (or `authoritativelyInvalidated` via on-chain cancel / nonce raise).
- `softCancelled` records are pulled from the API book but **still matchable on chain** until expiry. The risk engine counts their exposure at the *remaining* (`risk − filled`): a soft-cancelled commitment can itself match on chain via its stale signed payload, so `filledRiskWei6` converges from the authoritative cumulative (canonically via the own-state stream's `commitment` events; the `reconcileSoftCancelledFills` audit probe applies the same rule to the per-tick audit clone) — the record **stays `softCancelled`** (a partial fill does **not** promote it to `partiallyFilled`; promoting a book-hidden row into the visible-commitment set would let the open-commitments diff's disappeared-hash classification read its effective `cancelled` and wrongly release the remainder). Only a full fill terminalizes it (`filled`).
- `partiallyFilled` is **never off-chain-cancelled by the MM** — once a commitment has matched, the API rejects the DELETE (`409 COMMITMENT_MATCHED`), so the MM never *pulls* a matched commitment into `softCancelled`. It moves only to `filled` (fully matched), `expired`, or `authoritativelyInvalidated` (on-chain cancel / nonce raise). Off-chain soft-cancel applies to `visibleOpen` only. (Distinct path: when a tracked `visibleOpen`/`partiallyFilled` row turns up *already* book-hidden — effective `cancelled`, but `storedStatus` open/`partially_filled` and not nonce-invalidated, e.g. an out-of-band off-chain DELETE — the classification **adopts** the row as `softCancelled` rather than releasing it, since the signed payload stays matchable on chain.)
- `filled`, `expired`, `authoritativelyInvalidated` — **terminal**; headroom released. Pruned from state after `max(3600, 10 × orders.expirySeconds)` seconds.

**`signedPayloadStatus` invariants** (own-state SSE plan §M6/A):
- `'present'` — the SDK's canonical signed bundle is captured locally on submit. Cancel paths use `cancelCommitmentOnchain({signedCommitment: ...})` directly; no public-API round-trip needed. Set on every live submit at and after MM v0.5.1+ pin. Cross-check enforced at state load: `signedPayload.commitmentHash === record.hash` (drift fails the file as `lost`).
- `'missing-legacy'` — the record predates M6/A (loaded from an older state file) OR is a dry-run synthetic (no signing happened). `signedPayload` is absent. Cancel dispatch (`dispatchCancel(record)` in `src/state/index.ts`) routes by lifecycle: `visibleOpen` / `partiallyFilled` fall back to `cancelCommitmentOnchain({hash})` (the SDK fetches + reconstructs from the public commitments API); `softCancelled` is BLOCKED (the public API redacts hidden rows post v0.5.0/M2) — a `cancel-blocked-missing-payload` telemetry event fires for operator action. Operators upgrading from a pre-0.5.1 MM should consult [`docs/OPERATOR_SAFETY.md`](./docs/OPERATOR_SAFETY.md#migration-from-a-pre-051-mm-state-file-with-no-signedpayload).

### 4.3 State-loss model

`StateLoadStatus.kind`:
- `'loaded'` — file present + validated. Safe to resume.
- `'fresh'` — no file. Safe if no prior telemetry. Unsafe if prior telemetry exists (a prior run's `softCancelled` set is gone).
- `'lost'` — file present but malformed / wrong version / failed validation. Always unsafe.

`assessStateLoss(status, opts) → { holdQuoting, reason, suggestedWaitSeconds? }` is the canonical verdict. `status` surfaces it via `stateLossAssessment`; `run --live` and `cancel-stale` both fail-closed on `holdQuoting: true` (unless `--ignore-missing-state` was passed).

---

## 5. Live-mode metrics (`RunSummary.liveMetrics`)

Computed by the event walk in `summarize()`. Zero-valued when the log is pure dry-run.

```typescript
interface LiveMetrics {
  fills: {
    quotedUsdcWei6: string;         // Σ riskAmountWei6 across submit + replace
    filledUsdcWei6: string;         // Σ newFillWei6 across fill events
    fillRate: number | null;        // filledUsdcWei6 / quotedUsdcWei6; null on div-by-zero
  };
  gas: {
    totalPolWei: string;
    byKind: { approval: string; onchainCancel: string; settle: string; claim: string };  // POL wei18 per on-chain op
    totalUsdcEquivWei6: string | null;  // populated only when caller supplied polToUsdcRate
  };
  settlements: {
    settleCount: number;
    claimCount: number;
    totalClaimedPayoutWei6: string;     // Σ payoutWei6 across claim events
  };
  realizedPnl: RealizedPnl;
  totalFeeUsdcWei6: string;             // '0' in v0 (no maker-side USDC fees)
}

interface RealizedPnl {
  netUsdcWei6: string;                  // SIGNED — '-X' for losses
  claimedProfitUsdcWei6: string;        // Σ (payout - cumulativeStake) across won positions; ≥ 0
  realizedLossUsdcWei6: string;         // Σ stake across lost positions; ≥ 0
  wonCount: number;                     // claim event with result='won' OR (claim w/o result + outcome agrees / unknown)
  lostCount: number;                    // settle.winSide ≠ makerSide AND not push/void AND no claim
  pushCount: number;                    // settle.winSide ∈ {push, void} OR claim.result ∈ {push, void}
  wonUnclaimedCount: number;            // settle.winSide === makerSide AND no claim event AND no already-claimed skip in window (paper profit; no net contribution)
  alreadyClaimedCount: number;          // auto-claim found it already claimed (candidate already-claimed, no claim event) — claimed out-of-window / prior run / concurrent caller; distinct from wonUnclaimed; no derived payout, no net contribution
  unsettledCount: number;               // fills exist but no settle in window (held over to unrealized — future slice)
}
```

Unrealized P&L over `unsettledCount` positions is a future slice (requires `summarize` to accept an `OspexAdapter` for current fair-value reads).

---

## 6. Vocabulary cross-reference

| Term | Where it lives |
|---|---|
| `CommitmentLifecycle` (6 values) | [`src/state/index.ts`](./src/state/index.ts) — `COMMITMENT_LIFECYCLE_STATES` |
| `MakerPositionStatus` (6 values) | [`src/state/index.ts`](./src/state/index.ts) — `MAKER_POSITION_STATUSES` |
| `TelemetryKind` (see `TELEMETRY_KINDS`) | [`src/telemetry/index.ts`](./src/telemetry/index.ts) — `TELEMETRY_KINDS` |
| `CandidateSkipReason` (14 values) | [`src/telemetry/index.ts`](./src/telemetry/index.ts) — `CANDIDATE_SKIP_REASONS` |
| `CandidatesSkipReason` (7 values — the `candidates` CLI discovery vocabulary, distinct from the runner's) | [`src/cli/candidates.ts`](./src/cli/candidates.ts) — `CANDIDATES_SKIP_REASONS` |
| `SoftCancelReason` / `ReplaceReason` | [`src/orders/index.ts`](./src/orders/index.ts) |
| Risk caps / `headroomForSide` / `canSpendGas` | [`src/risk/index.ts`](./src/risk/index.ts) |

These are the source of truth. AGENTS.md mirrors them; if there's drift, the source wins and this doc needs a PR.

---

## 7. Cookbook

Question → command. Pipes use `jq` notation for clarity.

**"Can the MM boot live right now?"**
```
ospex-mm doctor --address 0x… --json | jq '.doctor.ready.postCommitments'
# { "ok": true|false, "reason": "…" }
```

**"What could the MM quote right now? What needs setting up first?"**
```
ospex-mm candidates --json | jq '.candidates.summary'
# quote-ready contest ids, ready to feed to `quote --dry-run`:
ospex-mm candidates --json | jq '.candidates.items[] | select(.kind == "quote_ready")
                                 | {contestId, awayTeam, homeTeam, matchTime, referenceOdds}'
# upcoming games someone could turn into contests:
ospex-mm candidates --json | jq '.candidates.items[] | select(.kind == "setup")
                                 | {gameId, awayTeam, homeTeam, matchTime}'
```
Read-only + signer-free; an empty `items` is a valid board state (exit 0). Check `.candidates.truncated` before treating the listing as complete.

**"What would the MM quote on contest C if I asked right now?"**
```
ospex-mm quote --dry-run <contestId> --json | jq '.quote'
```

**"How is my state file right now? Anything dangerous?"**
```
ospex-mm status --json | jq '.status.stateLossAssessment'
# { "holdQuoting": false|true, "reason": "…", "suggestedWaitSeconds"?: 120 }
```

**"How much capital do I have exposed (latent + filled) right now?"**
```
ospex-mm status --json | jq '.status.commitments.distinctContestsNonTerminal,
                              .status.positions.byStatus'
```

**"How much have I claimed today? Lifetime?"**
```
ospex-mm summary --json | jq '.summary.liveMetrics.settlements.totalClaimedPayoutWei6'
ospex-mm status  --json | jq '.status.dailyCounters'
```

**"Am I in the green or red so far this run?"**
```
ospex-mm summary --json | jq '.summary.liveMetrics.realizedPnl'
# { "netUsdcWei6": "…", "wonCount": …, "lostCount": …, "claimedProfitUsdcWei6": "…", … }
```

**"What's the gas burn rate?"**
```
ospex-mm summary --json | jq '.summary.liveMetrics.gas'
# Per-op breakdown + total POL + optional USDC equivalent.
```

**"Why didn't the MM post on contest C?"**
1. Walk the NDJSON log for `risk-verdict` events with `contestId: C` → see `allowed` + per-side `headroomUSDC` + `notes`.
2. Or: walk for `candidate` events with `contestId: C` and `skipReason` set — that's the pre-engine gate.
3. Cross-reference with `degraded` events for the same `contestId` (channel issue).

```bash
jq -c 'select(.kind == "risk-verdict" and .contestId == "C")' run-*.ndjson
jq -c 'select(.kind == "candidate"    and .contestId == "C")' run-*.ndjson
```

**"What's the fill rate so far?"**
```
ospex-mm summary --json | jq '.summary.liveMetrics.fills'
# { "quotedUsdcWei6": "…", "filledUsdcWei6": "…", "fillRate": 0.0–1.0+ | null }
```

**"Is the MM holding quoting right now (state-loss hold)?"**
```
ospex-mm status --json | jq '.status.stateLossAssessment.holdQuoting'
```

**"Are any claims pending (won-unclaimed)?"**
```
ospex-mm summary --json | jq '.summary.liveMetrics.realizedPnl.wonUnclaimedCount'
ospex-mm status  --json | jq '.status.livePositionTotals'
```

**"How many positions were already claimed out-of-window (a prior run / another caller)?"** — distinct from `wonUnclaimedCount`; these are NOT pending, just claimed without a `claim` event in this window (no derived payout).
```
ospex-mm summary --json | jq '.summary.liveMetrics.realizedPnl.alreadyClaimedCount'
```

**"How do I sweep stale quotes? On-chain?"**
- Off-chain only (gasless, signed DELETE): `ospex-mm cancel-stale`. Records → `softCancelled`. Still matchable on chain until expiry.
- On-chain authoritative (costs POL gas, mayUseReserve): `ospex-mm cancel-stale --authoritative`. Records → `authoritativelyInvalidated`. `MatchingModule.cancelCommitment` flips `s_cancelledCommitments[hash]`.
- **Stop `run --live` first** — the JSON state file is not multi-process safe.

**"What lifecycle is commitment H in?"**
```bash
# State file gives the local view:
jq --arg h "0x…" '.commitments[$h].lifecycle' state.dir/maker-state.json

# Event log gives the history:
jq -c --arg h "0x…" 'select((.commitmentHash // "") == $h)' run-*.ndjson
```

**"What does the API think about my positions right now?"**
```
ospex-mm status --address 0x… --json | jq '.status.livePositionTotals'
# Cheap signer-free read of `positions.status(maker).totals`.
```

---

## 8. Conventions

- **All wei amounts are decimal strings.** USDC: 6-decimal wei6. POL: 18-decimal wei18. Always strings in JSON envelopes + NDJSON payloads — they can exceed `Number.MAX_SAFE_INTEGER`.
- **Timestamps**: ISO-8601 strings on emit (`ts`), Unix seconds (numbers) in state-file `*UnixSec` fields.
- **Hex addresses + tx hashes**: `0x`-prefixed, lowercased. Type alias `Hex = \`0x${string}\``.
- **`away` / `home`** in event payloads is the *taker offer* side (the side a taker would back). The *maker* commitment is on the opposite side. `toProtocolQuote()` does the conversion. `quote-intent` / `risk-verdict` events carry the per-taker-offer breakdown; `submit` / `replace` / `soft-cancel` carry both `takerSide` and `makerSide` so consumers don't have to infer.
- **`positionType`** is `0` for away (maker on away), `1` for home (maker on home).
- **`oddsTick`** is uint16 × 100 (1.91 decimal odds → 191 ticks). Range `[101, 10100]`.
- **`schemaVersion: 1`** on JSON envelopes is the wire-contract version. Additive shape changes don't bump it; breaking changes would (none planned).

---

## 9. Where the human prose lives

- **[`README.md`](./README.md)** — install, configure, conceptual framing, current scaffold status, safety prose.
- **[`docs/DESIGN.md`](./docs/DESIGN.md)** — design intent + rationale (§2 metrics; §6 risk/gas; §7 config; §8 two-key + competitiveness; §9 order lifecycle; §10 ingestion; §11 telemetry; §12 state persistence; §13 kill switch; §14 phase DoD; §16 firewall).
- **[`docs/OPERATOR_SAFETY.md`](./docs/OPERATOR_SAFETY.md)** — pre-live checklist; kill switch model; state model.
- **[`docs/QUICKSTART.md`](./docs/QUICKSTART.md)** — step-by-step run-through.

When this doc and the source disagree, the source wins — file a doc-fix PR.
