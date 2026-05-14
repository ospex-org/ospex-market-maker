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
| `run --dry-run [--address <0x…>] [--keystore <p>] [--ignore-missing-state]` | config, state, contests, odds | state, telemetry log | (no `--json`) | graceful shutdown (KILL file / SIGTERM/SIGINT) | startup refusal (config invalid, state-loss without override, …) |
| `run --live [--keystore <p>] [--ignore-missing-state] [--yes]` | same + signed adapter | state, telemetry log, **on chain** | (no `--json`) | graceful shutdown | refusal (`mode.dryRun:true` + `--live` mismatch, no keystore, prompt rejected, `--yes`-requiring config without it, ...) |
| `cancel-stale [--authoritative] [--keystore <p>] [--ignore-missing-state] [--json]` | config, state | state (lifecycle stamps), telemetry log, **off-chain DELETE; on-chain cancelCommitment if `--authoritative`** | `{schemaVersion:1, cancelStale: CancelStaleReport}` | clean cleanup | any `errored > 0` or `gasDenied > 0` (incomplete sweep); refusal (`mode.dryRun:true`, no keystore, state-loss without override, dry: synthetic hash in state, ...) |
| `status [--address <0x…>] [--json]` | config, state, (optional) live `positions.status` | — (read-only) | `{schemaVersion:1, status: StatusReport}` | always 0 (informational; operational throws map to 1 via the CLI wrapper) | only on operational throw |
| `summary [--since <ts>] [--json]` | NDJSON event logs under `telemetry.logDir` | — (read-only) | `{schemaVersion:1, summary: RunSummary}` | always 0 (informational; operational throws map to 1) | only on operational throw or malformed `--since` |

Authoritative source for argument parsing: [`src/cli/index.ts`](./src/cli/index.ts). Each command delegates to a `runX(opts, deps): Report` in its sibling module (`doctor.ts`, `quote.ts`, `run.ts`, `cancel-stale.ts`, `status.ts`, `summary.ts`).

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
  offchainSkippedAlready: number; // records already in `softCancelled`; off-chain DELETE skipped
  onchainCancelled: number;       // 0 unless --authoritative was passed
  gasDenied: number;              // records the gas-budget verdict refused (on-chain leg)
  errored: number;                // per-record adapter throws
  gasPolWei: string;              // total POL gas spent on the on-chain leg (wei18 decimal)
  runId: string;                  // filename suffix of this command's event log
}
```

Stale-set rule: `lifecycle ∈ {visibleOpen, softCancelled, partiallyFilled}` AND `postedAtUnixSec + orders.staleAfterSeconds ≤ now`. Terminal lifecycles (`filled` / `expired` / `authoritativelyInvalidated`) are never in the set.

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
| `error` | any phase that catches a throw | `{ class: string, detail: string, phase?: string, contestId?, commitmentHash?, speculationId? }`. Known `phase` values at this writing: `'tick'`, `'discovery'`, `'odds-seed'`, `'odds-poll'`, `'odds-unsubscribe'`, `'reconcile'`, `'submit'`, `'cancel'`, `'onchain-cancel'`, `'fill-detection'`, `'fill-detection-lookup'`, `'position-poll'`, `'approve'`, `'settle'`, `'claim'`. `summary` aggregates by phase with `'(none)'` for absent. **Treat the list as authoritative-but-additive** — new runtime paths may add phases without bumping `schemaVersion`; consumers should handle unknown phases gracefully (bucket them as `'other'` rather than rejecting). Source of truth: `grep "phase: '" src/runners/index.ts`. |

### 3.2 Per-market reconcile (in tick order)

| `kind` | Payload |
|---|---|
| `candidate` | `{ contestId?: string, skipReason?: CandidateSkipReason, takerSide?: 'away' \| 'home', ...skip-specific }`. **No `skipReason`** = the contest was *tracked* (and `contestId` is present). Skip-specific fields: `cap-hit` → `contestId`, `takerSide`; `tracking-cap-reached` / `no-reference-odds` / `no-open-speculation` / `would-create-lazy-speculation` / `stale-reference` / `start-too-soon` / `refused-pricing` → `contestId` plus skip-reason-specific context; `gas-budget-blocks-settlement` → `purpose: 'settleSpeculation' \| 'claimPosition'`, `speculationId`, `contestId`, `makerSide`, `mayUseReserve: boolean`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail`; `gas-budget-blocks-onchain-cancel` → `commitmentHash`, `speculationId`, `makerSide`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail` (no `contestId` — keyed on the commitment hash, not the contest); `gas-budget-blocks-reapproval` → `purpose: 'positionModule-approve'`, `todayGasSpentPolWei`, `maxDailyGasPolWei`, `emergencyReservePolWei`, `detail` (no `contestId` — the boot-time auto-approve isn't per-market). |
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
| `onchain-cancel` | `{ commitmentHash, speculationId, contestId, makerSide, txHash, gasPolWei: string }` — `MatchingModule.cancelCommitment` landed (shutdown kill or `cancel-stale --authoritative`). Record → `authoritativelyInvalidated`. |
| `approval` | `{ purpose: 'positionModule', spender, currentAllowance, requiredAggregateAllowance, amountSetTo, walletBalanceWei6?, txHash, gasPolWei }` — `walletBalanceWei6` present in `mode:'exact'`, absent in `mode:'unlimited'` |

### 3.4 Fills + positions

| `kind` | Payload |
|---|---|
| `fill` (source `'commitment-diff'`) | `{ source: 'commitment-diff', commitmentHash, speculationId, contestId, sport, awayTeam, homeTeam, takerSide, makerSide, positionType, makerOddsTick, newFillWei6, filledRiskWei6, partial: boolean }` |
| `fill` (source `'position-poll'`) | `{ source: 'position-poll', positionId, speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, newFillWei6, cumulativeRiskWei6 }` — backfill from `getPositionStatus`; no `makerOddsTick` (the API surfaces aggregate own/counterparty stake, not per-fill ticks) |
| `position-transition` | `{ positionId, speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, fromStatus, toStatus, result?: 'won' \| 'push' \| 'void', predictedWinSide?: 'away' \| 'home' \| 'over' \| 'under' \| 'push' }`. `fromStatus`/`toStatus` ∈ `'active' \| 'pendingSettle' \| 'claimable'`. `result` carried on `pendingSettle` and `claimable`; `predictedWinSide` on `pendingSettle` only. |
| `settle` | `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, winSide: 'away' \| 'home' \| 'push' \| 'over' \| 'under', txHash, gasPolWei }` — `SPECULATION_SETTLED` landed |
| `claim` | `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, payoutWei6, txHash, gasPolWei, result?: 'won' \| 'push' \| 'void' }` — `POSITION_CLAIMED` landed; `result` (when present) is authoritative for `summary`'s realized-P&L classification (origin: `ClaimablePositionView.result`); local `MakerPositionStatus` stamped `'claimed'` |

### 3.5 Environment

| `kind` | Payload |
|---|---|
| `degraded` | `{ contestId, referenceGameId, reason: 'channel-error' \| 'subscribe-failed' \| 'channel-cap', detail?: string }` — odds channel issue; the market is treated as stale-reference |

### 3.6 Reserved (not yet emitted)

| `kind` | Notes |
|---|---|
| `fair-value` | Reserved in `TELEMETRY_KINDS`. Pricing computes fair internally; not surfaced as an event yet. |
| `nonce-floor-raise` | Reserved. `raiseMinNonce` bulk-invalidate is documented as a future optimization (currently per-commitment for both the shutdown kill path and `cancel-stale --authoritative`). |

### 3.7 Skip-reason vocabulary (`CANDIDATE_SKIP_REASONS`)

```
'no-reference-odds' | 'no-open-speculation' | 'would-create-lazy-speculation'
'stale-reference' | 'start-too-soon' | 'cap-hit' | 'refused-pricing'
'tracking-cap-reached' | 'gas-budget-blocks-reapproval'
'gas-budget-blocks-settlement' | 'gas-budget-blocks-onchain-cancel'
```

`refused-pricing` / `cap-hit` arrive during the per-market reconcile. The three `gas-budget-blocks-*` arrive from the on-chain write paths (boot approve, auto-settle/claim, shutdown kill / cancel-stale). The others are pre-engine market-discovery gates.

### 3.8 Soft-cancel + replace reasons

```
SoftCancelReason: 'side-not-quoted' | 'duplicate' | 'shutdown'
                | 'stale' | 'mispriced'        // = ReplaceReason
ReplaceReason:   'stale' | 'mispriced'
```

`'stale'` and `'mispriced'` appear on `would-replace` / `replace` (replacement actions) AND on `would-soft-cancel` / `soft-cancel` (when the replacement was deferred for cap budget). `'side-not-quoted'` only on soft-cancels. `'duplicate'` on book-hygiene pulls. `'shutdown'` only on the kill-switch's unconditional off-chain sweep.

---

## 4. State file

Path: `<state.dir>/maker-state.json`. Atomic write (temp + rename). Single-writer; not multi-process safe. Loaded at boot via `StateStore.load()` which returns `{state, status: {kind: 'loaded' | 'fresh' | 'lost', reason?}}` — `lost` means the file exists but failed validation.

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
```

**Lifecycle invariants**:
- `visibleOpen`, `softCancelled`, `partiallyFilled` — **non-terminal**; still matchable on chain until expiry (or `authoritativelyInvalidated` via on-chain cancel / nonce raise).
- `softCancelled` records are pulled from the API book but **still matchable on chain** until expiry. The risk engine still counts their exposure.
- `filled`, `expired`, `authoritativelyInvalidated` — **terminal**; headroom released. Pruned from state after `max(3600, 10 × orders.expirySeconds)` seconds.

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
  wonUnclaimedCount: number;            // settle.winSide === makerSide AND no claim in window (paper profit; no net contribution)
  unsettledCount: number;               // fills exist but no settle in window (held over to unrealized — future slice)
}
```

Unrealized P&L over `unsettledCount` positions is a future slice (requires `summarize` to accept an `OspexAdapter` for current fair-value reads).

---

## 6. Vocabulary cross-reference

| Term | Where it lives |
|---|---|
| `CommitmentLifecycle` (6 values) | [`src/state/index.ts`](./src/state/index.ts) — `COMMITMENT_LIFECYCLE_STATES` |
| `MakerPositionStatus` (4 values) | [`src/state/index.ts`](./src/state/index.ts) — `MAKER_POSITION_STATUSES` |
| `TelemetryKind` (24 values) | [`src/telemetry/index.ts`](./src/telemetry/index.ts) — `TELEMETRY_KINDS` |
| `CandidateSkipReason` (11 values) | [`src/telemetry/index.ts`](./src/telemetry/index.ts) — `CANDIDATE_SKIP_REASONS` |
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
