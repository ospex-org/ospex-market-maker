# ospex-market-maker — Design (v0)

**Status: approved for implementation (revision 5).** This defines what the v0 market maker *is allowed to do*, *forbidden from doing*, and *what metrics it must produce* — and the architecture, config, and lifecycle that follow. Four review rounds done; the design is stable. Revision 5 folds in the round-4 implementation guardrails (no design changes). The repo scaffold and Phase 1 build follow this doc. **This is the design and the v0 *target* — not a snapshot of current state. For what actually works in the repo today, see the README's *Current scaffold status* section** (statements here like "`moneyline.ts` is implemented" or "`doctor` reports balances" describe the v0 target; the implementation lands incrementally — §14).

**A note on SDK calls in this doc.** References like `client.commitments.submit(...)` name methods on [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk). `src/ospex/` wraps the SDK; wrapper method names may differ — the canonical names are the SDK's. SDK *wire-field* names — including the SDK's reference-game-id field (which currently embeds a provider name) — appear only inside that `src/ospex/` adapter; the rest of the MM, and every committed doc / config / CLI output / telemetry payload, uses neutral terms (`referenceGameId` / `upstreamGameId`). Where this doc names a *contract* method (e.g. `cancelCommitment`) it says so explicitly.

---

## 0. Revision history

### Revision 5 — implementation guardrails folded in (review round 4)

The review approved Rev 4 for execution; three items carried in as Phase-1 implementation guardrails (not design changes):

1. **Commitment polling passes explicit SDK options** — `status: ['open','partially_filled']` and `limit: maxOpenCommitments + small buffer` — plus by-hash lookups for the tracked commitments that disappeared since last tick. (§10, §14)
2. **Boot-time state-loss fail-safe** — if the persisted `softCancelled` set is missing or corrupt after a prior run, the MM does **not** resume quoting on a blank slate (which would under-count latent exposure); it reconstructs the set (replay recent telemetry) or waits one full `expirySeconds` window or requires an explicit operator override before posting. (§12, §14)
3. **Phase 1 is strictly read-only** — no `submit` / cancel / approve live paths exist at all, not even behind a flag; the SDK's write methods aren't wired in `src/ospex/` until Phase 2+. The risk engine's latent-exposure accounting and aggregate-allowance target are nonetheless implemented and unit-tested in Phase 1 (they gate Phase 3). (§14)

### Revision 4 — third review pass (protocol/SDK semantics)

1. **Latent matchable exposure is a first-class risk category.** An off-chain cancel pulls a quote from the API but does **not** invalidate the signed payload — a taker holding it can still match it on chain until expiry / on-chain cancel / nonce-floor raise. State now tracks commitments as `visibleOpen` → (`softCancelled` | `partiallyFilled`/`filled` | `expired` | `authoritativelyInvalidated`); risk caps bind `visibleOpen` + `softCancelled` remaining risk; **off-chain cancel does not free exposure headroom** — only expiry, on-chain `cancelCommitment`, or a nonce-floor raise does. `killCancelOnChain: false` pulls visible quotes only — not a hard risk stop. (§6, §9, §12)
2. **The v0 live default expiry is short `fixed-seconds` (~120 s), not `match-time`.** Because an off-chain cancel doesn't invalidate a signed quote, the *expiry* is what bounds the latent-exposure window. `match-time` (expiry = game start) is still available but documented as dangerous unless paired with on-chain cancels / periodic nonce-floor raises. (§6, §7, §9)
3. **v0 quotes only existing open speculations — no lazy creation.** The SDK's high-level submit can resolve a commitment to a *lazy-creation* path (the speculation auto-creates on first match, and the maker owes a share of the creation fee via `TreasuryModule`). v0 refuses such quotes (`skip-reason: would-create-lazy-speculation`), keeping the approval surface to `PositionModule` only and `maxDailyFeeUSDC` genuinely at zero. Supporting lazy creation (TreasuryModule approvals + fee budgeting + per-speculation-key fee tracking) is a documented post-v0 option. (§6, §9, §15)
4. **`approvals.mode: exact` raises the allowance to `min(risk-cap ceiling, current wallet USDC balance)`, not a per-quote shortfall.** `approve(x)` *sets* the ERC-20 allowance to `x`; it does not add. The MM raises `PositionModule`'s allowance to `min(maxOpenCommitments × maxRiskPerCommitmentUSDC, maxBankrollUtilizationPct × bankrollUSDC, walletUSDCBalance)` — a finite, computable number bounded by what the wallet currently holds — never `MaxUint256` unless `approvals.mode: unlimited` (config + `--yes`). Raise-only (an existing allowance that already meets the target is left alone) and **deferred while the boot-time state-loss hold is active** (raising during the hold could re-activate latent soft-cancelled signed commitments — DESIGN §12). `readBalances` failure fail-closes in exact mode. Approval telemetry carries `purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`, `walletBalanceWei6?` (present in exact, absent in unlimited), `txHash`, `gasPolWei`. (§6, §7, §11, §12)
5. **Gas wording corrected.** POL is spent **only** on `approve`, on-chain `cancelCommitment`, nonce-floor raises, `settleSpeculation`, `claimPosition`. Posting a commitment and routine off-chain cancels are EIP-712 signing + an API call — *no gas*. The "stop new quotes when the gas budget is hit" rule is reframed: posting stays allowed (it's gasless) unless it would force a re-`approve` we can't afford; off-chain cancels of stale/mispriced quotes always continue. (§6)
6. **Bounded own-state polling claim corrected to match the current SDK.** Fill detection = `client.commitments.list({ maker, status: open,partially_filled })` (bounded by `maxOpenCommitments`) + by-hash lookup of the few tracked commitments that disappeared since last tick + `client.positions.status(address)` periodically. `client.positions.byAddress` is not currently paginated/`since`-filtered, so the hot loop avoids it. (§10) *(Since superseded by the own-state polling retirement: the owner-authenticated own-state SSE stream is now the canonical fill/state source, and these bounded reads survive only as per-tick audit probes — see §10.)*
7. **Provider-name self-reference removed.** This doc no longer writes the SDK's provider-specific wire-field name in prose — the literal appears only in `src/ospex/` code. (whole doc, §16)

### Revision 3 — second review pass

Precise provider-name principle (SDK wire fields only inside `src/ospex/`) · off-chain cancels never gas-gated · gas budgeted in POL (`gas:` block) with optional USDC-equivalent reporting · SDK install = exact GitHub Release tarball (not npm, not a caret range) · stream lifecycle guardrails (channel caps, backoff+jitter, dirty-event coalescing, snapshot-first, degraded-on-error) · bounded competitiveness reads · explicit partial-fill accounting · settlement ≠ oracle/scoring clarification · open-question answers folded in.

### Revision 2 — first review pass

MIT confirmed · subscription-first ingestion (odds push now; maker's-own state bounded-polled; fills push as a cross-repo fast-follow) · no provider/sibling-repo names in public text · no internal-ops in public docs (`internal/` gitignored dir) · public `@ospex/sdk` link · SDK dependency reworked for clean fresh-clone install · dry-run reports *quote competitiveness*, not a fill rate (Ospex isn't a CLOB) · two-key live model · exposure = worst-case loss by outcome · book-hygiene invariant softened · SDK vs wrapper names aligned · auto-approval opt-in · v0 markets = moneyline only (config rejects spread/total) · README + `docs/OPERATOR_SAFETY.md` disclaimer requirements.

---

## 1. What this is

A **reference market maker** for [Ospex](https://ospex.org) — the zero-vig peer-to-peer sports prediction protocol on Polygon. Clone it, point it at your wallet / bankroll / RPC / return target, and it quotes two-sided liquidity on upcoming contests, manages its exposure (including the *latent* exposure of signed quotes it has pulled but can't unsign), reacts to fills, settles and claims, and writes an auditable record of everything it did.

It is built **on top of [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk)** — every chain and API interaction goes through the SDK. This repo never calls the Ospex contracts directly. The SDK already provides: contest / speculation / commitment / position / odds reads, signed-commitment submit / match / cancel / on-chain-cancel / nonce-floor-raise, position settle / claim / claim-all / status / claim-params, EIP-712 signing, the `KeystoreSigner`, typed errors, allowance pre-flight, the odds SSE subscription, and a per-instance nonce counter. So this repo owns only the *decisions*: which markets to quote, at what price, at what size, when to cancel / replace, when to stop — plus the config, the risk engine, the event loop, the persistent state, and the telemetry.

### What this is *not*

- Not a sophisticated quant system. It's the minimum that lets an agent safely **quote, update, cancel, get filled, settle, claim, and produce metrics**. It does not try to beat sportsbooks.
- Not the home for flow / taker agents, observer agents, or cross-agent scorecards. Those exist only to *exercise* a market maker and *prove the platform* — they live in a separate test harness outside this repository, never here. (See §16.)
- Not a speculation seeder: v0 quotes only speculations that already exist; it does not create new ones (the SDK's lazy-creation path, with its `TreasuryModule` fee, is out of scope — see §6).
- Not opinionated about your data: it reads upstream / reference odds via the SDK (the consensus market's prices — not Ospex liquidity). Plugging in your own reference source is a future extension point, not a v0 feature.

### Audience

Two readers. An **operator** — possibly not a quant — who wants to run a market maker on Ospex: §1, §7 (config), §8 (dry-run vs live), and §13 (the safety disclaimers) are written for you. A **developer / contributor** extending the repo: everything else.

---

## 2. The contract — allowed / forbidden / required metrics

This is the heart of v0. If a behaviour isn't on the "allowed" list and isn't trivially implied by it, it's out of scope. If it's on the "forbidden" list, it's a bug to ever do it.

### 2.1 Allowed — what v0 does

1. **Universe discovery.** List upcoming contests / games via the SDK; filter by configured sports, market types, and how soon the game starts; require that upstream reference odds exist *and* that an open speculation already exists for the market; pick which contests / markets to quote — bounded by `maxTrackedContests`.
2. **Reference pricing.** Subscribe to upstream reference odds for the games being tracked (`client.odds.subscribe({ contestId, market }, handlers)` — contest-id native; the server resolves the upstream game), seeded by a one-shot snapshot (`client.odds.snapshot(contestId)`); strip the consensus vig → fair probabilities; derive a quoting spread (see §5) from the operator's economics or a directly-configured spread.
3. **Order placement.** Post signed two-sided commitments (moneyline in v0 — see §5) on *existing open speculations* via `client.commitments.submit`, sized by per-quote cap and exposure headroom (including latent exposure — §6), with a short expiry (the recommended `fixed-seconds` mode — §7). Emit a preview before posting; refuse if no open speculation exists for the line (a post there would lazily create one); never post in dry-run.
4. **Order management.** List its own open commitments (`client.commitments.list({ maker })`); refresh / replace a quote when it ages or reference odds move past a threshold — by pulling it from the API (off-chain) and posting a fresh one; never *intentionally surface* duplicate or inconsistent orders (the book-hygiene invariant, §9). **Track that an off-chain cancel does not invalidate the signed payload — the pulled quote is "latent" and still counts against caps until it expires (or is invalidated on-chain).**
5. **Exposure management.** Track open liability — `visibleOpen` *and* `softCancelled`-but-not-yet-expired commitments — plus filled positions; cap **worst-case USDC loss by outcome** per commitment, per contest, per team, per sport, and as a fraction of total bankroll (§6); stop quoting a market / team / sport when its cap is reached; stop quoting entirely when the bankroll ceiling is reached.
6. **Fill monitoring.** Receive fills, commitment lifecycle, and position status in real time over the owner-authenticated own-state SSE stream — the canonical own-state source, always on in live mode (§10); a bounded per-tick poll (`commitments.list({ maker, status: open,partially_filled })` plus by-hash lookup of the tracked hashes that disappeared, plus `positions.status(address)`) survives only as an audit cross-check. Move filled risk from "open / latent quote" to "filled position" in the inventory; recompute P&L; immediately re-price (or pull) the opposite side of a market after a fill, because the fill changed the exposure.
7. **Settlement / claim path.** Detect scored / claimable speculations for the maker's *own* positions; optionally settle (permissionless) and claim automatically (config toggles), or leave it to the operator. **"Settle" here means finalising a speculation that is *already scored* and claiming the maker's own positions — the MM does not create contests, run oracle requests, submit scoring scripts, or require LINK.** It needs only USDC (stakes; approved to `PositionModule`) and gas (POL/MATIC; for the on-chain ops listed in §6).
8. **Safety.** Honor hard caps on USDC risk (including latent matchable exposure), daily gas budget (in POL), and daily fee budget; run in dry-run mode; expose a kill switch; auto-approval off by default and never silently unlimited; never loop on a reverting transaction or an SSE reconnect.
9. **Telemetry.** Log every decision, commitment, and transaction as structured events; produce a single-agent run summary (quote age, fill rate *(live)* / quote competitiveness *(dry-run)*, spread earned, P&L, gas (POL; optionally USDC-equivalent), fees, stale-quote incidents, latent-exposure peak, error counts, settlement outcomes).

### 2.2 Forbidden — what v0 must never do

- **Never call the Ospex contracts directly.** Everything via `@ospex/sdk`.
- **Never assume an off-chain cancel removed exposure.** Pulling a quote from the API does not invalidate the signed payload; only expiry, on-chain `cancelCommitment`, or a nonce-floor raise frees the headroom. The MM keeps quote expiries short so this window is small.
- **Never let aggregate matchable risk exceed the `PositionModule` allowance** (or the wallet's USDC balance, or the configured caps). In `mode: exact` the allowance is raised to `min(risk-cap ceiling, current wallet USDC balance)` (§6) — deferred while the boot-time state-loss hold is active (§12). Never `MaxUint256` unless explicitly configured + `--yes`-confirmed.
- **Never approve USDC on its own unless `approvals.autoApprove` is set.** Never approve in dry-run. Every approval is a telemetry event with the fields in §11.
- **Never quote a market whose speculation doesn't yet exist** (which would trigger lazy creation + a `TreasuryModule` fee). Refuse with `skip-reason: would-create-lazy-speculation`.
- **Never exceed any configured cap** — per-commitment, per-contest, per-team, per-sport, total-bankroll, max-open-commitments, daily-gas, daily-fee — computed as worst-case loss by outcome over visible + latent commitments and filled positions (§6). Enforced *every tick*, before any submit.
- **Never quote on missing / ambiguous / stale-beyond-threshold reference data.** Refuse the market with a logged reason; do not guess a price.
- **Never quote prices it can't justify.** If the operator's economics imply an unrealistic spread (or one tighter than the consensus market), refuse to start and name the input(s) to change. No nonsense quotes — better to do nothing.
- **Never leave a stale or mispriced quote *visible*.** Pulling it from the API is gasless and always allowed regardless of the gas budget — do it, then post a corrected one (or let the pulled one expire and post fresh).
- **Never retry a reverting transaction in a tight loop**, or an SSE reconnect in a tight loop. Bounded retries with backoff + jitter; after N failures on the same operation, stop it and log it.
- **Never persist or log a raw private key.** The MM only ever holds a `KeystoreSigner` from the SDK's `signers/keystore` subpath; signing prompts for the Foundry passphrase. (Inherited from the SDK's BYO posture.)
- **Never run without a configured RPC URL.** No public-RPC default. (Inherited from the SDK.)
- **Never silently widen its own risk over a run.** Caps at boot are the caps for the whole run; raising them is an explicit restart.
- **Never go live by accident.** Live requires *both* `mode.dryRun: false` in config *and* the `--live` flag (§8).
- **(Operational) Never run as a Heroku `web` dyno.** No HTTP listener; a web dyno gets SIGKILLed on the port-bind timeout. It is a `worker`.

### 2.3 Required metrics — what every run must produce

Emitted two ways: **(a)** an append-only NDJSON event log (one line per event — §11), and **(b)** an `ospex-mm summary` command that aggregates the log. The NDJSON shape is the stable contract a future external scorecard reads — the MM doesn't compute the cross-agent "is the platform viable" scorecard itself, but it produces the raw material for it.

Per run, the summary reports:

- Contests **considered / quoted / skipped** (skips broken out by reason: no-reference-odds, no-open-speculation, would-create-lazy-speculation, stale-reference, start-too-soon, cap-hit, refused-pricing, tracking-cap-reached, gas-budget-blocks-reapproval, ...).
- Commitments **submitted / soft-cancelled / authoritatively-cancelled / expired**; **fills** (count, USDC).
- **Live mode — fill rate:** filled USDC ÷ quoted USDC, overall and bucketed by sport / market / time-to-tip. **Dry-run mode — quote competitiveness:** how often the would-be quote sat at or inside the visible orderbook on its side, and how it compared to the reference odds. (Dry-run cannot report a fill rate — see §8.)
- **Quote age** distribution (p50 / p90 / max), **stale-quote incidents**, and **latent-exposure peak** (the largest aggregate `visibleOpen + softCancelled-not-yet-expired` risk reached).
- **Spread earned** — the first-order P&L proxy: Σ (embedded spread × filled-per-side). The output states this is an approximation (see §5, the zero-vig caveat).
- **P&L** — realized (settled positions) + unrealized (open positions marked to current fair value).
- **Gas spent** — in POL; optionally also USDC-equivalent via `gas.nativeTokenUSDCPrice` (best-effort, labelled). **Fees paid** (USDC; zero in v0). **Bankroll turnover.**
- **Errors** by class (allowance, chain / revert, API, config, signing, stream, ...).
- **Settlement / claim outcomes** for the maker's own positions.

---

## 3. Architecture

A single long-running worker process. No HTTP surface. Runs locally (`ospex-mm run`) or as a Heroku `worker` dyno. One process = one signing identity = one `OspexClient` instance (the SDK's nonce counter is per-instance — see the SDK's AGENT_CONTRACT §9).

### Layers (`src/`)

| Dir | Responsibility |
|---|---|
| `config/` | Load + validate the YAML config (and env overrides); the typed `Config`. Boot fails fast on invalid config. |
| `ospex/` | The **only** module that imports `@ospex/sdk`. Constructs the `OspexClient` and `KeystoreSigner`; exposes the narrow set of calls the MM needs — contest / speculation / commitment / position reads, the odds **subscription** + snapshot, commitment submit / off-chain cancel / on-chain cancel / nonce-floor raise, fill polling, settle / claim, allowance read + set. The SDK's provider-specific wire-field names (e.g. the reference-game-id field) are confined to this adapter; it maps them to the MM's neutral terms (`referenceGameId` / `upstreamGameId`). Wrapper method names may differ from the raw SDK names — the SDK's names are canonical. |
| `pricing/` | Pure functions: vig stripping → fair value; spread derivation (economics or direct mode); two-sided quote-price construction; odds-tick conversion + bounds checks. The shared two-way pricing core is `computeQuote`; non-moneyline markets reuse it through thin per-market adapters in `pricing/markets/` that feed their per-side juice through it and carry the line (`spread.ts` implemented; `total.ts` next; moneyline uses `computeQuote` directly). Heavily unit-tested. |
| `risk/` | Exposure tracking — worst-case loss by outcome over filled positions **and** `visibleOpen` **and** `softCancelled`-not-yet-expired commitments — plus cap enforcement and the `PositionModule` aggregate-allowance target. The **risk engine**: `(inventory, proposedQuote, config) → { allowed, sizeUSDC } | { refused, reason }`. The loop never submits without an `allowed` verdict. |
| `orders/` | The order lifecycle: build desired quotes, confirm the target speculation is still open (refuse on what would be a lazy creation — a direct `speculations.get` read, since the SDK's submit preview that reports the same `existing` / `lazy` discriminator needs an unlocked signer + RPC), reconcile against actual open commitments, submit / soft-cancel-and-repost / book-hygiene reconcile, and the authoritative (on-chain) cancel + nonce-floor paths used by the kill switch and `cancel-stale --authoritative`. Wraps the SDK's commitment calls (via `ospex/`). |
| `state/` | Persistent inventory: each posted commitment tracked **by hash** in a state — `visibleOpen` → (`softCancelled` \| `partiallyFilled`/`filled` \| `expired` \| `authoritativelyInvalidated`) — plus resulting positions, running P&L, daily POL-gas / fee counters. **The `softCancelled` set (with expiries) is the one piece of state not reconstructible from chain/API** — an off-chain DELETE removes a quote from the API but not from on-chain validity — so it is persisted locally; if the state file is lost, the MM under-counts latent exposure until those quotes expire (another reason to keep `expirySeconds` short). JSON file(s) under a configurable state dir, atomic writes (temp + rename). **Not multi-process safe — one MM per state dir.** |
| `telemetry/` | The NDJSON event-log writer + the summary aggregator. |
| `runners/` | The event loop (one runner, `dryRun` mode flag), the kill-switch check, graceful shutdown. |
| `cli/` | `ospex-mm doctor | quote | run | cancel-stale | status | summary`. CLI framework: match what the `ospex` CLI uses, for consistency. |

### The event loop

The MM is **event-driven for odds and for its own state** (subscription callbacks — a reference-odds SSE stream per tracked market, plus the owner-authenticated own-state SSE stream that canonically writes the maker's commitments / fills / positions in live mode) and **timer-driven for the rest** (a single tick paced at `ownState.auditPollIntervalMs`, default 60 s). An odds-change callback marks the affected market *dirty*; rapid moves coalesce — a market is reconciled at most once per tick. One tick:

1. **Kill-switch check.** If tripped → pull every visible quote off chain via per-record `cancelCommitmentOffchain` (gasless; `soft-cancel` `reason: 'shutdown'`); if `killCancelOnChain: true`, also authoritatively cancel every non-terminal commitment on chain via per-record `cancelCommitmentOnchain` (uses the gas reserve via `mayUseReserve: true`; `onchain-cancel` events; records → `authoritativelyInvalidated`); flush state + telemetry; exit `0`. (Note: with `killCancelOnChain: false` the soft-cancelled quotes stay matchable until they expire — see §6.)
2. **Discovery** (every `discovery.everyNTicks` ticks — default 10 ≈ 10 min at the default 60 s tick — with jitter): list upcoming contests per the config filters, up to `marketSelection.maxTrackedContests`; for each, confirm an *open speculation* exists for the market(s) being quoted (skip otherwise — `no-open-speculation`); open odds subscriptions for new ones (up to `odds.maxRealtimeChannels`), seeding each with a one-shot snapshot; drop subscriptions for contests that have started / left the window.
3. **Funding guard, then per-market reconcile.** First re-read wallet funding (throttled — §6); if `min(wallet USDC, PositionModule allowance)` can't cover the gross matchable-commitment risk, **halt posting this tick** and pull/cancel existing quotes per `fundingGuard.underfundedCancelMode`. Otherwise, **for each dirty or newly-tracked market** (and any whose standing two-sided quote has gone stale / expired): compute fair value → run the risk engine over the *aggregate* exposure (positions + visibleOpen + softCancelled-not-yet-expired + the proposed quote) → if `allowed`, build the desired quote → re-confirm the speculation is still open (refuse on what would be a lazy creation — a direct `speculations.get` read; see §9) → reconcile against the actual open commitments on that speculation: pull (soft-cancel) any visible quote that's stale/mispriced and post a fresh one; submit what's missing. Record a telemetry event per candidate, including skips with reasons.
4. **Audit probes (live)** — fills and lifecycle changes have already landed in real time over the own-state stream (which updates inventory + P&L and dirties the market so the reconcile re-prices or pulls the opposite side); this step only cross-checks. `client.commitments.list({ maker, status: open,partially_filled })` (bounded by `maxOpenCommitments`) is diffed, disappeared hashes are looked up per-hash, soft-cancelled records are probed via `getCommitment`, and `client.positions.status(address)` is read — all converging a per-tick audit clone for the audit-vs-canonical divergence comparator. A probe failure marks the audit cycle failed (the comparator skips it, latches are preserved) and never gates the tick.
5. **Age out** `softCancelled` (and unmatched `visibleOpen`) commitments that have passed their expiry → reclassify `expired`, release headroom.
6. **(If configured)** sweep claimable positions: settle (permissionless) where needed, then claim — subject to the gas reserve (§6).
7. **Flush** state + telemetry. Sleep `ownState.auditPollIntervalMs`. Repeat.

A channel error / unrecoverable disconnect on an odds subscription marks that market **degraded** → its visible quotes are pulled (off-chain) and its reference is treated as stale until the channel recovers (the latent exposure of those pulled quotes persists until they expire). The tick interval is `ownState.auditPollIntervalMs` (validated range 10–300 s, default 60 s — §7). Because odds *and* own-state arrive via subscription, nothing trading-critical waits on it — the tick paces the audit cross-check, the own-state health poll, discovery, and the reconcile / settle / funding / age-out sweep.

### SSE connection budget

The MM holds open SSE connections to `ospex-core-api`: **one reference-odds stream per tracked market** (capped at `odds.maxRealtimeChannels`, default 5) **plus exactly one composite owner-auth own-state stream** (commitments + fills + positions on a single connection). So a single live instance uses **`maxRealtimeChannels + 1`** connections — 6 at the defaults.

core-api bounds concurrent streams with a **per-IP cap** (`MAX_STREAM_CONNECTIONS_PER_IP`, default 16); a connection past the cap is refused with **HTTP 429**. Two subtleties matter:

1. **The cap is per egress IP / host, not per process** — every MM instance on the same host (and anything else streaming from that IP) shares one budget. The boot-time guardrail can only see *this* process, so it logs the per-instance count + the per-host math; it cannot detect siblings.
2. **The per-IP cap is split.** core-api reserves `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` (default 3) of it for the owner-auth own-state stream, so **anonymous** streams — the odds subscriptions — may use only `MAX_STREAM_CONNECTIONS_PER_IP − RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` (default `16 − 3 = 13`). The reserve keeps anonymous odds saturation from 429-ing a maker's safety-critical own-state reconnect. So the **binding** budget for odds channels is the *anonymous* one (13), **tighter** than the total cap (16): `maxRealtimeChannels = 14` fits the total (`14 + 1 = 15 ≤ 16`) but is refused on the 14th odds stream (`14 > 13`). The own-state stream itself always fits — it draws from the reserve.

**Running more than one instance on one host** — both constraints must hold for N co-located instances:
- **Odds (anonymous):** `N × maxRealtimeChannels ≤ MAX_STREAM_CONNECTIONS_PER_IP − RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` — usually the binding one.
- **Total:** `N × (maxRealtimeChannels + 1) ≤ MAX_STREAM_CONNECTIONS_PER_IP`.

To make room, raise `MAX_STREAM_CONNECTIONS_PER_IP` and/or lower `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` on your core-api, **or** give each instance its own egress IP.

**Lowering the per-instance footprint now (no protocol change):** reduce `odds.maxRealtimeChannels` and let the tail of tracked markets fall back to bounded polling — set `odds.subscribe: false` to poll *every* tracked market each tick (one `getOddsSnapshot` per market, no streams) when stream budget is the binding constraint. This trades freshness for connections.

**Future — odds-stream multiplexing (not yet built):** the per-market odds stream is the dominant consumer of the budget. A future core-api capability could let one connection subscribe to *many* contests (server-side fan-out keyed by a subscription set), collapsing the odds side to a single stream per instance (`1 + 1` total). That is a core-api protocol change **and** new `@ospex/sdk` support that the MM would consume after an SDK release — a deliberately deferred item, tracked for the MVE multi-maker ramp; the polling-fallback lever above is the interim answer.

---

## 4. Relationship to `@ospex/sdk`

The MM depends on `@ospex/sdk` and nothing else from the Ospex side. It does **not** depend on `@ospex/cli` — the CLI is a separate operator tool (useful, e.g., as a manual counterparty when testing a maker against itself or a friend). `KeystoreSigner` comes from the `@ospex/sdk/signers/keystore` subpath (which pulls `ethers` — acceptable; the MM must sign).

**Dependency installation.** The MM pins `@ospex/sdk` to an *exact* version (a money-moving bot must not float SDK behaviour):

- **Preferred (now):** the exact GitHub Release tarball URL — e.g. `"@ospex/sdk": "https://github.com/ospex-org/ospex-sdk/releases/download/vX.Y.Z/ospex-sdk-X.Y.Z.tgz"` (the live pin is in `package.json`). Matches the SDK's distribution direction (Releases first; npm maybe later).
- **Later / optional:** npm, *if* Ospex adds it as a secondary channel — still pinned to an exact version, never a caret range.
- **Fallback:** a `vendor/` directory plus a `scripts/fetch-sdk` step documented in the README — only if neither of the above is available.
- **Never:** commit the SDK tarball into this repo.

The MM inherits the SDK's contracts wholesale: typed errors with the documented retryability semantics; the `--json` / `schemaVersion` envelope discipline; the BYO wallet + RPC posture; the vocabulary (`Contest`, `Speculation`, `Position`, `Commitment`, `MarketType`; position types translated to the actual side — never expose "upper" / "lower"). To detect (and refuse) the lazy-creation path it reads the SDK's speculation detail directly (`speculations.get`) and checks the target speculation already exists + is open — the SDK's high-level submit preview reports the same `existing` / `lazy` discriminator, but it requires an unlocked signer + RPC (it builds a full submit), so the MM does the equivalent read on its own (§6).

---

## 5. Pricing model

Pipeline (`computeQuote` — the shared two-way pricing core, used by every market). Ported in spirit from a prior math sketch, rewritten in TypeScript. Spread / total are priced by thin per-market adapters under `pricing/markets/` that source their per-side juice + line and reuse `computeQuote` verbatim (`spread.ts` implemented; `total.ts` next); moneyline uses it directly.

**Step 1 — Strip the consensus vig.** Reference implied probabilities sum to slightly more than 1; the excess is the consensus overround. Normalize proportionally → fair probabilities. (Proportional normalization is the v0 method; Shin / power / log-odds corrections for favorite–longshot bias are a documented future option.)

**Step 2 — Derive the quoting spread.** Two modes; the config picks one.

- **`economics` mode — the approachable path.** The operator says: how much capital (`capitalUSDC`), what return they want (`targetMonthlyReturnPct`), over what horizon (`daysHorizon`), roughly how many games / day in their configured sports (`estGamesPerDay`). The math estimates expected monthly *filled* volume from the per-quote cap × games/day × an assumed fill rate × days, then solves for the spread that would hit the target return on a balanced book: `targetSpread = targetReturn / (expectedMonthlyFilledVolume / 2)`. **It refuses to start** if `targetSpread` exceeds `maxReasonableSpread` (config; ~5% is the realistic upper bound for a competitive market) *or* exceeds the consensus overround (you can't quote inside the market and still extract that margin) — naming exactly which input to change. This refusal is the central safety feature for non-quant operators.
- **`direct` mode — the "I know what I want" path.** The operator gives `spreadBps` directly; the math uses it as the embedded spread (still subject to the consensus-overround check).

**Step 3 — Build quote prices.** Split the spread across the two sides (symmetric in v0: `quoteProb = fairProb + spread/2` each — asymmetric / inventory-skew is future work). These `quoteProb` / `quoteTick` are **taker-facing** — the (inflated, worse-than-fair) probability / decimal-odds tick that a taker who matched the resulting commitment would face for backing that side. Refuse the market if a quote probability hits 1 (pathological — only on extremely lopsided lines).

**Step 4 — To ticks.** Convert quote probabilities → decimal odds → uint16 ticks, validating the tick bounds (`MIN_ODDS = 101` … `MAX_ODDS = 10100`) and that the risk amount is a multiple of `ODDS_SCALE = 100` (USDC 6-dp). Out-of-bounds → refuse the market. (Still taker-facing — `quoteTick` is the *taker's* tick. The protocol commitment's maker-side tick is `inverseOddsTick(quoteTick)`; see "Side conventions" below.)

**Step 5 — Size.** Each *offer* side = `min(perQuoteCap, exposureHeadroom_for_that_offer)` where the offer's headroom comes from the worst-case-by-outcome accounting in §6 (which already counts the maker's latent quotes). The away offer becomes a maker-on-*home* commitment, so it draws on the maker-on-home headroom — and vice versa. If one side is at its cap and the other isn't, optionally upsize the open side (bounded by its own headroom) to encourage rebalancing flow. If both are capped, don't quote.

### Side conventions — taker-facing pricing, protocol-maker on chain

The pricing and orders layers — and all user-facing surfaces (config, CLI output, telemetry, docs) — speak in **taker** terms: "what odds are we offering someone who wants to back the away team / home team / over / under?" That's the natural framing for an operator and for any future flow agent. The Ospex protocol, though, stores a commitment as the *maker's* side: `positionType` (`Upper`/`0` = away/over, `Lower`/`1` = home/under — `OspexTypes.sol`) is the side the maker wins on, `oddsTick` is the maker's decimal × 100, and a taker who matches gets the *opposite* side at `inverseOddsTick(oddsTick) = round(100·oddsTick / (oddsTick − 100))`. So offering a taker the away side means the maker takes the **home** side, at the inverse tick.

`toProtocolQuote({ takerSide, takerOddsTick })` → `{ makerSide: oppositeSide(takerSide), makerOddsTick: inverseOddsTick(takerOddsTick), positionType: positionTypeForSide(makerSide) }` is the **single conversion point** — invoked at the Ospex submission/orderbook boundary (the runner's commitment-minting step in dry-run; the execution layer in live). Nothing else does the maker/taker flip. Telemetry events carry **both** the taker-facing fields and the resulting protocol commitment params, so the NDJSON is self-describing. (This explicit boundary is deliberate: a contributor reaching for ordinary bookmaker/taker pricing language won't silently re-introduce a side/odds inversion.)

**Markets in v0.** Operator-facing config accepts `markets: ["moneyline"]` only. `spread` / `total` are *rejected by config validation* with a clear "not yet implemented in this version" message. The spread / total pricing adapters (`pricing/markets/`) are built incrementally ahead of that gate; wiring `"spread"` into the accepted set is the final step of shipping that market.

### Line-sanity rail — the MM never signs an absurd line

Every signable commitment carries a `lineTicks` (int32, 10×-scaled: a `-3.5` run line is `-35`, a `220.5` total is `2205`). Before the MM signs — or, in dry-run, "would-submit"s — it runs the line through a single conservative magnitude bound, `MM_MAX_SANE_LINE_TICKS = ±5_000` ticks (= `±500.0` line points; `pricing/line.ts` + `constants.ts`). A line outside the band is refused; moneyline (`lineTicks` always `0`) always passes, so v0 behavior is unchanged.

This is a hard safety rail, not a cosmetic check. The `SpreadScorerModule` computes `adjustedAway = scaledAway + lineTicks` in **checked `int32` arithmetic with no on-chain magnitude bound**, so a pathological spread line permanently reverts settlement and strands the escrow of every position on that speculation — and the protocol is zero-admin / non-upgradeable, so there is no on-chain remediation once a speculation is created. The rail is deliberately ~2× the most extreme real sports line (an NBA total ~`260.0` ⇒ `2_600`) and `200×` tighter than the SDK's catastrophic-overflow `MAX_LINE_TICKS` floor (`±1,000,000`). It is enforced at the **single commitment-sign chokepoint** (the runner's `submitQuote`, covering both fresh quotes and replacements); a refusal skips that side for the tick rather than crashing it. A candidate-stage refusal — so an out-of-band market is never even priced — lands alongside spread / total discovery.

### The zero-vig-at-settlement caveat — flagged loudly

Ospex matched-pairs has **no protocol-level vig**. At settlement, each side receives `1.0 + (counterparty stake ÷ own stake)` in decimal terms — the protocol takes no rake. The "spread" the maker embeds in a quote is the *price it offers to provide liquidity*, not a cut. The "balanced book ⇒ profit ≈ spread × per-side volume" model is a **first-order approximation**: reasonable when fills land roughly evenly on both sides, but imbalanced fills turn the maker into a directional bettor — a different risk profile (and, for some MMs, where most of the P&L comes from). v0 uses the approximation; the docs and the run summary state that it *is* one. A treatment that models matched-pair settlement directly is future work, not a v0 blocker.

### Flagged free parameters (each is invented; revisit with production data)

`fillRateAssumption` (~0.30 — **the first to replace** with measured data) · `capitalTurnoverPerDay` (~1.0) · `maxPerQuotePctOfCapital` (~5%) · `maxReasonableSpread` (~5%) · symmetric spread split · balanced-book P&L assumption.

---

## 6. Risk model

### Exposure is worst-case USDC loss by outcome — over filled positions, visible quotes, *and* latent quotes

An off-chain cancel pulls a quote from the API but does **not** invalidate the signed `OspexCommitment` — a taker who holds it can still match it on chain until the commitment **expires**, is **filled**, is **cancelled on-chain** (`cancelCommitment`), or is **invalidated by a nonce-floor raise** (`raiseMinNonce`). So a pulled quote is *latent* matchable exposure, not gone.

For moneyline, a *filled* position on side X loses the maker's stake (`riskAmount`) if X loses; an *open or latent* commitment on side X, if matched before the next tick, exposes the maker to that same `riskAmount` loss if X loses. ("Side X" here is the **protocol maker side** — `positionType`. A *taker offer* on the away side is served by a maker-on-*home* commitment, so it's a home-side item: it loses if away wins. `buildDesiredQuote` therefore sizes the away offer against the maker-on-home headroom — see §5's "Side conventions".) The risk engine computes, per contest, the worst-case loss in each outcome bucket:

- `lossIf(homeWins)` = Σ over the maker's **away-side** items (maker `positionType` = `Upper`/`0`) of the at-risk USDC for each (those lose when home wins): positions (their `riskAmount`), `visibleOpen` commitments (full `riskAmount`), `softCancelled`-but-not-yet-expired/invalidated commitments (full `riskAmount`).
- `lossIf(awayWins)` = the symmetric sum on the **home** side (maker `positionType` = `Lower`/`1`) — the side that *serves the away taker offer*.
- **Counting rule (no double-count).** Each *unit* of risk is counted exactly once, in whichever bucket it currently occupies: a fully-filled commitment is a *position*; a fully-open or soft-cancelled commitment counts its full `riskAmount`; a *partially-filled* commitment counts its filled portion as a position and only its `remaining_risk_amount` as the open contribution — never the original full amount *and* the resulting position. Open / latent / remaining risk is always counted as if matchable before the next tick (conservative). The maker can never lose more than its own stake on a single item.
- **Off-chain cancel does not free headroom.** A `softCancelled` commitment stays in these buckets until it `expires` or is `authoritativelyInvalidated` (on-chain cancel / nonce-floor raise). `killCancelOnChain: false` pulls visible quotes only and is **not** a hard risk stop — the latent exposure persists until those quotes expire (≤ `expirySeconds` with the recommended mode; until game start with `match-time`).

Caps then bind these outcome buckets:

| Cap | Bounds |
|---|---|
| `maxRiskPerCommitmentUSDC` | the biggest single commitment's `riskAmount` |
| `maxRiskPerContestUSDC` | `max(lossIf(homeWins), lossIf(awayWins))` for that contest |
| `maxRiskPerTeamUSDC` | Σ over contests of the worst-case loss in the bucket where *that team* loses |
| `maxRiskPerSportUSDC` | Σ over contests in that sport of `max(lossIf(homeWins), lossIf(awayWins))` |
| `bankrollUSDC` × `maxBankrollUtilizationPct` | Σ over all contests of `max(lossIf(homeWins), lossIf(awayWins))` — the absolute exposure ceiling; stop quoting entirely above it |
| `maxOpenCommitments` | count of `visibleOpen` + `softCancelled`-not-yet-expired commitments — don't pile up latent risk |
| `gas.maxDailyGasPOL` | daily gas budget, in POL — see below |
| `maxDailyFeeUSDC` (under `risk:`) | daily protocol-fee budget in USDC — genuinely zero in v0 (no lazy creation, see below), the knob exists for any future fee |

When spread / total pricing lands, each market defines its own outcome-bucket loss function (the *position* still has a fixed worst-case loss = the staked `riskAmount`, so the bucket accounting generalizes). The **risk engine** is a pure function returning `{ allowed: true, sizeUSDC }` (clamped to headroom) or `{ allowed: false, reason }`; every refusal is a telemetry event; the loop cannot submit without an `allowed` verdict.

### Expiry bounds the latent-exposure window

Because an off-chain cancel doesn't invalidate a signed quote, the **expiry** is what determines how long a pulled quote stays a risk. The v0 **recommended live default is `expiryMode: fixed-seconds` with a short `expirySeconds` (~120 s)** — a pulled quote stops being matchable within ~2 minutes, and the MM rolls fresh quotes forward (`staleAfterSeconds` < `expirySeconds`, so the MM pulls-and-reposts before the old one lapses; the old, soft-cancelled one then expires shortly after). Configure `staleAfterSeconds` / `expirySeconds` so the overlap (one soft-cancelled-not-yet-expired generation + one visible generation) stays within your per-side caps — or accept a brief gap between generations; the risk engine enforces the cap regardless. `expiryMode: match-time` (expiry = game start) is available but **dangerous with off-chain cancel** — a pulled quote stays matchable for hours; only use it if you replace via *on-chain* cancel or periodic nonce-floor raises (which cost gas), or you explicitly accept that latent exposure. The example config ships `fixed-seconds`.

**Expiry-release grace margin.** The contract keeps a commitment matchable until `block.timestamp >= expiry` (strict), but the MM compares against its own host clock — which, with the core-api's wall clock, can *lead* the Polygon block timestamp. So the MM holds accounting headroom for `orders.expiryReleaseGraceSeconds` (default 60 s) past a commitment's local expiry: it releases / terminalizes only once `now ≥ expiryUnixSec + grace`. This is applied uniformly at every local-clock release/terminalization path — `inventoryFromState` (exposure accounting), `ageOut`, and the `detectFills` disappeared-hash classifier (now an audit probe — it must classify the per-tick audit clone with the same grace, else the clone would terminalize *first* and feed the divergence comparator a false mismatch, since the core-api hides locally-expired rows from `listOpenCommitments`) — through the single `isExpiredForRelease` predicate so they cannot drift. Book hygiene still treats a quote as expired at the original expiry (the `reconcileBook` occupancy filter is unchanged); only *headroom release* waits for the grace, and any same-side repost during the window is sized against an inventory that still counts the old remaining risk, so `old_remaining + new ≤ cap`. Independently authoritative facts still release immediately even inside the window: a full cumulative fill → `filled`; an on-chain cancel / nonce-floor raise → `authoritativelyInvalidated`. Set the grace to `0` to restore release exactly at expiry.

### v0 quotes only existing open speculations — no lazy creation

The SDK's high-level submit can resolve a commitment to a *lazy-creation* path: if no open speculation exists for `(contestId, scorer, lineTicks)`, a posted commitment lazily creates the speculation when first matched — and the maker's share of the creation fee is due via a **`TreasuryModule`** allowance on that first match. v0 sidesteps this entirely: discovery only tracks markets that already have an open speculation, and before posting, the per-market reconcile re-confirms that speculation still exists + is open (a direct `speculations.get` read via the SDK) — if it's gone, a post there would lazily create one, so the MM refuses (`skip-reason: would-create-lazy-speculation`). (The SDK's high-level submit preview reports the same `existing` / `lazy` discriminator, but it builds a full submit and so needs an unlocked signer + RPC — the direct read is the dry-run-friendly equivalent.) Consequences: the only USDC approval the MM ever needs is to `PositionModule`; `maxDailyFeeUSDC: "0"` is genuinely accurate; there is no `TreasuryModule` allowance, no creation-fee budgeting, no per-speculation-key fee tracking. Supporting lazy creation (all of the above) is a documented post-v0 option — for now the MM provides liquidity *on* existing speculations rather than seeding new ones. (In the multi-agent fishbowl, something else seeds the first commitment on each speculation.)

### Approvals — an aggregate absolute allowance, not a per-quote shortfall

`approve(x)` *sets* the ERC-20 allowance to `x` — it does not add. So `approvals.mode: exact` does **not** mean "approve the next quote's shortfall"; it means **raise `PositionModule`'s allowance to** `min( maxOpenCommitments × maxRiskPerCommitmentUSDC, maxBankrollUtilizationPct × bankrollUSDC, wallet USDC balance )` — a finite, computable number, bounded by the current wallet balance so the allowance never overstates pullable risk. Set once at startup when `autoApprove: true` (and the boot-time state-loss hold has lifted — raising the allowance during the hold could re-activate latent soft-cancelled signed commitments and is deferred until the hold clears); re-set only if one of those bounds changes. The check is **raise-only**: if `currentAllowance` already meets the target, the call is a silent no-op (the operator's existing allowance is never downshifted). If `readBalances` fails in exact mode, the approve fails closed (the wallet bound is part of the safety contract) — log + skip + retry on the next boot. (Setting it to the *current* aggregate need and re-approving as it grows also works but burns gas on every quote — pre-approving the wallet-bounded target is cheaper and is the v0 behaviour.) `approvals.mode: unlimited` sets `MaxUint256` — requires the config setting *and* CLI confirmation (`--yes`); discouraged. Skips the wallet-balance read (the operator confirmed the unbounded path; bounding it would defeat the explicit opt-in) and is idempotent on `currentAllowance >= MaxUint256`. Never approves in dry-run. The `approval` telemetry event carries `purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`, `walletBalanceWei6?` (present in exact mode, absent in unlimited), `txHash`, `gasPolWei`. The MM needs `PositionModule` allowance only — no `TreasuryModule` (no lazy creation), no LINK (no oracle/contest creation).

### Gas — what actually spends POL, and the exhaustion policy

POL gas is spent **only** on: `approve` (ERC-20), on-chain `cancelCommitment`, nonce-floor raises (`raiseMinNonce`), `settleSpeculation`, `claimPosition`. **Posting a commitment (`commitments.submit`) and routine off-chain cancels are EIP-712 signing + an API call — no gas.** Budget: `gas.maxDailyGasPOL` (in POL — what's actually spent), `gas.emergencyReservePOL` held back. Optional USDC-equivalent reporting via an operator-supplied `gas.nativeTokenUSDCPrice` (best-effort; no on-chain POL/USD oracle in the SDK yet — a future enhancement could make this automatic). Polygon gas is tiny, so the example budget is small.

**Daily accounting.** The runner accumulates POL spent per UTC day in `state.dailyCounters[YYYY-MM-DD].gasPolWei` (wei18 decimal string). Every on-chain write — starting with the boot-time auto-approve — adds `gasUsed × effectiveGasPrice` from the receipt. The verdict gate `canSpendGas` (in `src/risk/`) reads this counter and refuses spend when `todayGasSpent + emergencyReserve ≥ maxDailyGas`, an operator misconfig (reserve ≥ cap) is detected, or the cap is non-positive.

**When the daily gas budget (`gas.maxDailyGasPOL`) is reached:**
- **Keep posting commitments** as long as no re-`approve` is needed (aggregate matchable risk stays within the current `PositionModule` allowance) — posting is gasless. If a new quote *would* require a re-approval and the budget (minus reserve) is exhausted, refuse it (`skip-reason: gas-budget-blocks-reapproval`). (Pre-approving the wallet-bounded exact target at startup means this rarely bites.)
- **Keep doing off-chain cancels** — pulling stale or mispriced quotes from the API is gasless and always allowed; pulled quotes then expire on their own (≤ `expirySeconds`).
- **On-chain `cancelCommitment` / nonce-floor raises / `settleSpeculation` / `claimPosition`** draw on `gas.emergencyReservePOL` (settle/claim only if `settlement.continueOnGasBudgetExhausted`). Settlement and claim need only gas (no LINK, no protocol fee), so the reserve covers them.
- The kill switch's off-chain part is never gas-gated; its on-chain part (if `killCancelOnChain`) uses the reserve.
- Keep enough POL in the wallet (budget + reserve) that the MM can always claim its winnings; `ospex-mm doctor` / `status` flag a low POL balance.

### Funding guard — halt (and optionally cancel) when the wallet can't back its matchable exposure

A signed commitment is only as good as the wallet behind it: `PositionModule.recordFill` pulls the maker's stake from the wallet *at match time*, not at submit. If the wallet's USDC is moved (or the `PositionModule` allowance is dropped) below what its open commitments could draw, those commitments are *unbacked* — a taker who fills one wastes gas on a transfer that reverts. The funding guard is the maker-side defence (the SDK/CLI taker-side preflight is the complement — `commitments fillability`).

Each live tick, before posting, the runner re-reads (throttled to `fundingGuard.checkIntervalMs`) `funding = min(wallet USDC, PositionModule allowance)` and compares it to `required` — the **gross** remaining maker risk (`riskAmount − filled`) over every still-matchable commitment (`visibleOpen` / `softCancelled` / `partiallyFilled`, not past `expiry + expiryReleaseGraceSeconds`). `required` is deliberately **gross, not outcome-netted, and excludes positions** (a filled position's USDC was already pulled): each open commitment can match independently, so if all fill the wallet pays the full sum — netting would *under*-state the cash the wallet must hold, the one error a solvency guard must never make. When `required` is `0` the reads are skipped (no exposure to back). A balance/allowance **read failure enters the hold** when `failClosedOnReadError` (default) — never post commitments we might not be able to back.

`funding < required` sets a **hold** that gates new posting (the reconcile early-returns, exactly like the boot-time state-loss hold). The hold clears on the first re-read where funding again covers `required`. **This is advisory + time-sensitive, not an escrow / hard-solvency system** — funding can still move between a check and a fill.

While held, `fundingGuard.underfundedCancelMode` governs the **active cancel response** to *existing* quotes:
- **`none`** — hold only; existing quotes ride to expiry. Posting stays halted until they age out (or funding is restored).
- **`offchain`** (default) — also pull every still-matchable `visibleOpen` quote off the relay (gasless `cancelCommitmentOffchain` → `softCancelled`, `soft-cancel` `reason: 'funding'`), so no *new* relay fills arrive. **This does not reduce `required`** — an off-chain pull is visibility-only; the signed payload stays matchable on chain until expiry, so it's still counted (§6 latent exposure). The hold therefore persists until those commitments expire.
- **`onchain`** — the off-chain pull above, then an authoritative `cancelCommitment` for every still-matchable non-terminal record (gas-gated via `canSpendGas` with `mayUseReserve: false` — an automatic guard must not burn the emergency reserve; a denial emits one `gas-budget-blocks-onchain-cancel` per hold episode and stops the sweep for the tick). Each landed cancel → `authoritativelyInvalidated`, which **does** drop it from `required` — so `onchain` is the only mode that actively shrinks the exposure and lets the hold clear before natural expiry.

The guard is live-only (dry-run never reads or holds) and emits `funding-hold` (`state: entered | cleared`, with the `funding` / `required` wei6 amounts) on each transition.

### Kill switch

Mechanism: the presence of a file at `killSwitchFile` (config; default `./KILL`), checked at the top of every tick. Tripped → pull every visible quote off chain via `cancelCommitmentOffchain` (gasless; emits `soft-cancel` `reason: 'shutdown'`, reclassifies to `softCancelled`); if `killCancelOnChain: true`, also authoritatively cancel every non-terminal commitment on chain via per-record `cancelCommitmentOnchain` (`MatchingModule.cancelCommitment`; gas drawn from the reserve via `canSpendGas` with `mayUseReserve: true`; emits `onchain-cancel`; reclassifies to `authoritativelyInvalidated`); flush state + telemetry; exit `0`. SIGTERM / SIGINT do the same (graceful). **`killCancelOnChain: false` (the default) is a *soft* stop** — pulled quotes leave the book but a taker holding the signed payload can still match them until they expire (≤ `expirySeconds` with the recommended mode; until game start with `match-time`); set it to `true` for a hard, gas-spending stop. (A future optimization may bulk-invalidate via `raiseMinNonce` per speculation when multiple commitments share one; the current path is per-commitment for safety + simplicity.) Documented in the README.

---

## 7. Config schema

A YAML file (`--config <path>`, default `./ospex-mm.yaml`), validated at boot — invalid or missing required values → exit `1` with a message naming the problem. Env vars override individual fields (`OSPEX_KEYSTORE_PATH`, `OSPEX_RPC_URL`, `OSPEX_API_URL`, `OSPEX_CHAIN_ID`). The repo ships `ospex-mm.example.yaml` — the MLB + moneyline starter config below, conservative caps, `dryRun: true`, short `fixed-seconds` expiry — which doubles as the onboarding doc. A novice typically touches only `rpcUrl`, `pricing.economics`, and maybe `risk` — plus `wallet` when going live.

```yaml
# ospex-mm.example.yaml — annotated reference config (v0)

wallet:
  keystorePath: ""   # Blank = no keystore (read-only / dry-run — doctor WARNs, nothing signs). For live
                     #   mode: the ABSOLUTE path to a Foundry v3 keystore (used verbatim — `~` is NOT
                     #   expanded; a set-but-missing path is a doctor FAIL), or OSPEX_KEYSTORE_PATH.
                     #   Prompts for the passphrase only when signing.

rpcUrl: ""            # REQUIRED. Alchemy / Infura / QuickNode URL for the chain. No public-RPC default.
apiUrl: ""            # Optional. Defaults to the production Ospex core API URL.
chainId: 137          # 137 = Polygon mainnet, 80002 = Amoy testnet.

marketSelection:
  sports: ["mlb"]                  # any of: mlb, nba, nhl, ncaab, ncaaf, nfl (config-driven; add more freely)
  markets: ["moneyline"]           # v0 supports only "moneyline"; "spread"/"total" are REJECTED by config validation.
  maxStartsWithinHours: 24         # only quote games starting within this window
  maxTrackedContests: 5            # hard cap on contests tracked at once (bounds odds subscriptions)
  requireReferenceOdds: true       # skip games with no upstream odds linkage
  requireOpenSpeculation: true     # v0: only quote markets whose speculation already exists (no lazy creation)
  contestAllowList: []             # optional: if non-empty, ONLY these contestIds
  contestDenyList: []              # optional: never these contestIds

discovery:
  everyNTicks: 10                  # run discovery every N ticks (10 × the 60s tick = ~10 min)
  jitterPct: 0.2                   # +/- jitter on the discovery interval

odds:
  subscribe: true                  # subscription-first: stream reference-odds changes. Strongly preferred.
                                   #   false = degraded fallback to bounded snapshot polling (restricted nets only).
  maxRealtimeChannels: 5           # hard cap on open SSE odds-stream connections (~ maxTrackedContests * markets). One instance uses this + 1 own-state stream; the core-api per-IP cap is per HOST — see §3 "SSE connection budget".

pricing:
  mode: economics                  # "economics" (derive spread from your return target) or "direct"
  economics:
    capitalUSDC: "50"
    targetMonthlyReturnPct: 0.005   # 0.5% / month on capital
    daysHorizon: 30
    estGamesPerDay: 8.0             # rough count across your configured sports
    fillRateAssumption: 0.30        # FLAGGED ASSUMPTION — replace with measured data later
    capitalTurnoverPerDay: 1.0      # FLAGGED ASSUMPTION
    maxReasonableSpread: 0.05       # refuse to start if the math wants a wider spread than this
  direct:
    spreadBps: 300                  # only used when mode: direct (3.00%)
  quoteBothSides: true
  minEdgeBps: 0                     # require at least this much edge vs fair to bother quoting
  maxPerQuotePctOfCapital: 0.05     # FLAGGED ASSUMPTION — per-quote concentration cap

risk:                               # caps bind WORST-CASE USDC LOSS BY OUTCOME over positions + visible + LATENT quotes
  bankrollUSDC: "50"
  maxBankrollUtilizationPct: 0.50
  maxRiskPerCommitmentUSDC: "0.25"
  maxRiskPerContestUSDC: "1"
  maxRiskPerTeamUSDC: "2"
  maxRiskPerSportUSDC: "5"
  maxOpenCommitments: 10            # counts visible + soft-cancelled-not-yet-expired commitments
  maxDailyFeeUSDC: "0"              # genuinely zero in v0 (no lazy speculation creation)

gas:
  maxDailyGasPOL: "1"               # daily gas budget, in POL (the native token — what's actually spent)
  emergencyReservePOL: "0.2"        # held back for on-chain risk-reduction / capital-recovery after the budget is hit
  reportInUSDC: true                # also report gas in USDC in the run summary (best-effort)
  nativeTokenUSDCPrice: "0.25"      # operator-provided POL->USDC for reporting (no on-chain oracle yet)

approvals:
  autoApprove: false                # the MM will NOT approve USDC on its own unless this is true
  mode: exact                       # "exact" = raise PositionModule allowance to min(risk-cap ceiling, current wallet USDC) — see DESIGN §6.
                                    #   Deferred while the boot-time state-loss hold is active (§12); raise-only.
                                    #   "unlimited" = MaxUint256 (requires --yes; skips the wallet bound). Discouraged.

orders:
  expiryMode: fixed-seconds         # RECOMMENDED. "fixed-seconds" = short expiry, MM rolls quotes forward.
                                    #   "match-time" (expire at game start) is available but DANGEROUS with off-chain
                                    #   cancel — a pulled quote stays matchable for hours. See DESIGN §6.
  expirySeconds: 120                # used when expiryMode: fixed-seconds. Short bounds latent exposure; tunable.
  staleAfterSeconds: 90             # pull-and-repost a quote this old (< expirySeconds, so it never just lapses)
  staleReferenceAfterSeconds: 300   # treat reference odds as stale (pull quotes, don't repost) if nothing heard this long
  replaceOnOddsMoveBps: 50          # pull-and-repost when fair value moves more than this since posting
  cancelMode: offchain              # freeing a matched-but-latent remainder: "offchain" (default) leaves it to ride to expiry
                                    #   (its off-chain cancel is rejected once matched); "onchain" authoritatively cancels it
                                    #   (POL gas, reserve-preserving) then re-quotes the freed side. Covers BOTH the visible
                                    #   partiallyFilled remainders and recovered soft-cancels (soft-cancelled then matched on
                                    #   chain). See §9. (visibleOpen quotes are always pulled gasless off-chain regardless.)

settlement:
  autoSettleOwn: true                       # settle the maker's own already-scored speculations (permissionless)
  autoClaimOwn: true                        # claim the maker's own winning positions
  continueOnGasBudgetExhausted: true        # allow settle/claim after the daily gas budget is hit (within the reserve)

telemetry:
  logDir: ./telemetry               # NDJSON event logs land here
  logLevel: info

state:
  dir: ./state                      # persistent inventory / soft-cancelled set / P&L / daily counters (JSON, atomic, single-process)

killSwitchFile: ./KILL
killCancelOnChain: false            # false = soft stop (pulled quotes expire on their own); true = hard stop (gas, uses reserve)

# (no top-level pollIntervalMs — the runner's single tick cadence is ownState.auditPollIntervalMs; see below)

mode:
  dryRun: true                      # MASTER SAFETY FLAG. true = compute everything, post nothing.
                                    #   Live requires dryRun: false AND the --live flag (see DESIGN §8).
```

The runner's single tick cadence is **`ownState.auditPollIntervalMs`** (default 60 000 ms, validated range 10 000–300 000 ms) — it paces the audit cross-check probes, the own-state health poll, and the reconcile / settle / funding / age-out sweep; fills arrive in real time over the own-state stream, so nothing trading-critical waits on it. The former top-level `pollIntervalMs` (and its 30 s floor) was removed with the own-state polling retirement. Note the block above is abridged (it predates the `ownState` / `fundingGuard` sections) — the annotated [`ospex-mm.example.yaml`](../ospex-mm.example.yaml) is the authoritative, complete config reference.

---

## 8. Dry-run vs live

**Dry-run** (`mode.dryRun: true`, the default) — the loop does **everything except** the writes (`commitments.submit` / off-chain cancel / on-chain cancel / nonce-floor raise / settle / claim / approve). Instead it logs `quote-intent` / `would-submit` / `would-soft-cancel` / `would-replace` events with the exact payloads and mutates a *hypothetical* inventory (synthetic `visibleOpen` records for the would-be submits, reclassified to `softCancelled` on a would-be cancel — the same lifecycle the risk engine reads in live mode). It still discovers, prices, re-confirms the speculation is still open (so a would-be-lazy-creation refusal surfaces in dry-run), **runs the risk engine** (cap violations surface, including against that hypothetical latent-exposure bucket), and measures **quote competitiveness** — for each would-be quote, whether it sits at or inside the visible orderbook on its side, and how it compares to the reference odds.

**Competitiveness reads are bounded** — only for markets the MM would actually quote (passed the risk engine), only when the market is dirty or newly tracked (not every tick, every contest), with a capped orderbook page size; on failure / rate-limit the MM logs `competitiveness-unavailable` and moves on — never a retry-loop; it can be sampled every N dirty-cycles if even that proves heavy.

It does **not** claim a fill rate. Ospex is not a central limit order book that auto-crosses two posted commitments — a taker must *intentionally* match a specific signed commitment — so "would this have filled?" is unanswerable without simulating taker behaviour, which is the job of the separate test harness (outside this repo) that consumes the NDJSON log. A real fill rate is a live-mode metric (or an external-harness metric derived from the log).

**Going live — the two-key model.** Live requires *both* `mode.dryRun: false` in the config *and* the `--live` flag. With only one, the MM runs dry and logs a clear message (`refusing to run live: config has dryRun=false but --live was not passed` / `refusing to run live: --live passed but config has dryRun=true`). `--dry-run` always forces dry-run regardless of config. Neither a stray config edit nor a stray flag can put real money on the table. Recommended flow: run dry-run for a meaningful window, read the would-be-stale rate, the competitiveness numbers, the latent-exposure peak, and the skip reasons — *then* set `mode.dryRun: false` and add `--live`.

---

## 9. Order lifecycle

Each posted commitment is tracked **by hash** in a state: `visibleOpen` (API-visible, matchable) → one of `softCancelled` (pulled from the API, *still matchable on chain* until expiry/on-chain-cancel/nonce-raise), `partiallyFilled`/`filled`, `expired`, or `authoritativelyInvalidated` (on-chain `cancelCommitment` or nonce-floor raise landed). Only the last three release exposure headroom; `softCancelled` does not (§6).

- **Lazy-speculation check.** Before posting, the MM verifies an open speculation exists for `(contestId, scorer, lineTicks)` — discovery pre-filters, and the per-market reconcile re-confirms it with a direct `speculations.get` read each time it would (re)quote. (The SDK's high-level submit preview reports the same `existing` / `lazy` discriminator, but it builds a full submit and so needs an unlocked signer + RPC — the direct read is the equivalent that works in dry-run.) If the speculation is gone, a posted commitment would lazily create one → refuse (`skip-reason: would-create-lazy-speculation`); if it's present but no longer open → skip (`no-open-speculation`). v0 never seeds speculations.
- **Stale / mispriced quotes.** A `visibleOpen` commitment older than `orders.staleAfterSeconds`, or whose fair value has moved more than `orders.replaceOnOddsMoveBps` since posting → the MM **pulls it off-chain** (→ `softCancelled`) and **posts a fresh quote** at the current price. The old (soft-cancelled) quote stays in the latent-exposure bucket until it `expires` (≤ `expirySeconds` with the recommended `fixed-seconds` mode). The MM does **not** routinely on-chain-cancel for staleness/replace (gas); it *does* for the kill switch (`killCancelOnChain`) and `cancel-stale --authoritative`.
- **Partially-filled remainders — the side is occupied.** Once a commitment has *any* match, its off-chain cancel is rejected by the relay (`409 COMMITMENT_MATCHED`). So a `partiallyFilled` remainder is **never** off-chain-cancelled and **never** reposted over — stacking a fresh same-side quote on a live remainder would double the side's matchable exposure. The reconciler treats a live partial remainder as **occupying its maker side**: it leaves the remainder in place (logging a `partial-remainder-retained` candidate with the reason it would otherwise have acted — `side-not-quoted` / `stale` / `mispriced` / `duplicate`), pulls only any redundant `visibleOpen` on that side, and re-opens the side for a fresh quote only once the remainder `expires` (≤ `expirySeconds` under `fixed-seconds`) or is authoritatively cancelled. Its remaining (unfilled) risk stays counted in the latent-exposure bucket throughout (§6). **Freeing a remainder *before* expiry is opt-in via `orders.cancelMode: onchain`**: the runner authoritatively `cancelCommitment`s each retained remainder on chain (gas-gated *without* the emergency reserve — a routine quote refresh must not burn it, unlike the shutdown kill / settlement paths; a denial logs `gas-budget-blocks-onchain-cancel` and the remainder stays retained, with no off-chain fallback and no repost over it), then re-quotes the freed side on a *subsequent* tick — never same-tick over the just-cancelled remainder, so the cancel→re-quote ordering footgun can't arise. Under the default `cancelMode: offchain` the remainder simply rides to expiry — fine under short `fixed-seconds` expiry; under `match-time` it occupies its side until game start, which is exactly when `cancelMode: onchain` earns its gas. The operator escape hatches `cancel-stale --authoritative` and the `killCancelOnChain` kill path also authoritatively cancel remainders.
- **Unquoteable markets.** When a tracked market becomes unquoteable for *any* reason — its game is imminent (starts within one `expirySeconds` window), its reference odds went missing or stale-beyond-`staleReferenceAfterSeconds`, its odds channel errored, or its speculation closed — the MM **pulls any `visibleOpen` quote of its own on that speculation** (→ `softCancelled`) before moving on, **retains any partial remainder** (it can't be off-chain-cancelled — see above), and stops quoting it (logging the skip reason). The visible book must never carry a quote the MM is no longer pricing (§2.2). The pulled / retained quotes remain latent — counted against caps until they expire. (The MM re-quotes the market on the next tick once it's quoteable again — fresh reference odds, a re-subscribed channel, etc.)
- **The book-hygiene invariant.** The MM never *intentionally surfaces* more than one active quote per `(speculation, side)` through the API / orderbook: before submitting, it reconciles its intended book against its actual open commitments (`client.commitments.list({ maker })`). It may, transiently, hold one `visibleOpen` plus one (or more) `softCancelled`-not-yet-expired generations per side — that's expected with rolling expiry, and all of them count in the latent-exposure bucket — but the *visible* surface has ≤ 1 per `(speculation, side)`.
- **Fills.** Canonically, fills and commitment lifecycle arrive in real time over the owner-authenticated own-state SSE stream (always on in live mode — §10): a stream `fill` event creates/extends the maker-side position, and a stream `commitment` event advances the record's lifecycle (→ `filled` / `expired`, or — for an effective `cancelled` — `authoritativelyInvalidated` **only** when `storedStatus='cancelled'` or `nonceInvalidated`, else `softCancelled` for a row that is merely book-hidden but still matchable on chain; the effective `cancelled` status alone is ambiguous post-book-visibility-split, so the canonical signals decide). On a fill: move the filled risk from open/latent to a filled position (per the §6 counting rule); recompute P&L (realized = settled positions, unrealized = open positions marked to current fair); **immediately re-price or pull the opposite side** of that market. Log a `fill` event. The reads the poll-canonical era used — the per-tick `client.commitments.list({ maker, status: open,partially_filled })` diff with by-hash lookups of disappeared rows (`detectFills`), the aggregate position-status poll (`pollPositionStatus`), and the per-record `getCommitment` probes of `softCancelled` rows (`reconcileSoftCancelledFills` — soft-cancelled commitments are API-hidden from the list, but the data-layer projects the real cumulative even for hidden rows) — survive **only as audit probes**: they apply the same classification rules to a per-tick audit clone for the audit-vs-canonical divergence comparator, never write canonical state, and a probe failure marks the audit cycle failed (the comparator skips it and preserves its latches) without gating the tick — protection against trading on stale state is the composite stream-health posting gate + cancel-sweep (§10), not a tick cascade. The soft-cancelled convergence rule is the same in either view: `filledRiskWei6` converges up to the *authoritative cumulative* (clamped to risk, never decreasing); the lifecycle **stays `softCancelled`** while any remainder is unfilled and only → `filled` once fully matched — **derived from the cumulative amount, not the API's effective status** (a hidden row still reports effective `cancelled`). A partial fill does **not** promote it to `partiallyFilled`: a book-hidden row must never enter the visible-commitment set (it would always "disappear" from the open-commitments diff, whose effective-`cancelled` read would wrongly release the latent remainder). The risk engine already counts a `softCancelled` record at its *remaining* (`risk − filled`), so the matched portion leaves latent exposure without a lifecycle promotion. Under `orders.cancelMode: onchain`, a recovered soft-cancel (now `softCancelled` with a matched remainder) is additionally routed — after `reconcileMarkets` — to an authoritative on-chain `cancelCommitment`, the soft-cancelled analogue of the retained-partial cancel: it stops further matching of the still-latent remainder instead of letting it ride to expiry (gas-gated, reserve-preserving; unmatched and past-expiry soft-cancels are skipped). Under the default `offchain` it rides to expiry.
- **Expiry.** `fixed-seconds` (recommended) → expiry = `now + expirySeconds`; the loop rolls quotes forward and ages out expired ones each tick. `match-time` → expiry = the contest's `matchTime` (never quote a game that's already started) — but then a soft-cancelled quote stays matchable for hours; bound it via on-chain cancels / nonce-floor raises (gas) or accept it. An expired commitment is dead on chain and releases its headroom; the loop reclassifies it `expired`.

---

## 10. Data ingestion — subscription-first

The MM is **subscription-first wherever the SDK supports it**, deliberately, to keep load off the public API:

- **Reference odds — push, now.** `client.odds.subscribe({ contestId, market }, handlers)` — contest-id native (the server resolves the upstream game) — opens a core-api SSE odds stream per tracked contest / market; `onChange` flags the market dirty for re-pricing, `onRefresh` updates the freshness timestamp, `onSnapshot` seeds the baseline, and `onStatus` reports the connection lifecycle. The initial value (and `ospex-mm quote --dry-run`) uses a one-shot `client.odds.snapshot(contestId)`. Games with no upstream linkage (snapshot all-null) are skipped (`no-reference-odds`). If `odds.subscribe: false` — a degraded mode for environments where SSE is blocked — the MM falls back to bounded snapshot polling on the tick cadence (`ownState.auditPollIntervalMs`); subscription is the default and is strongly preferred.

  **Stream lifecycle guardrails (required):**
  - **Startup snapshot first, then subscribe** — never act on a subscription before seeding a known-good snapshot.
  - **Caps:** at most `marketSelection.maxTrackedContests` contests and `odds.maxRealtimeChannels` channels. Discovery refuses to track more — logs `tracking-cap-reached` and moves on.
  - **Unsubscribe** when a contest leaves the start window or its game starts — channels don't leak.
  - **Reconnect:** exponential backoff with jitter; never a tight reconnect loop. The SDK's SSE transport manages reconnect (full-jitter backoff) and re-snapshots on recovery; the MM watches for it not recovering within a backoff window.
  - **Fatal stream error / unrecoverable disconnect** → mark that market **degraded**: pull its visible quotes (off-chain), treat its reference as stale, keep retrying with backoff. (The pulled quotes are now latent — they expire on their own.)
  - **Dirty-event coalescing** — a burst of `onChange`s on one market → *one* reconcile on the next tick, not a write per event.

- **Fills / positions — push, now (the own-state stream); the bounded poll demoted to an audit cross-check.** In live mode the MM opens the SDK's owner-authenticated own-state SSE stream at boot — the bearer-token mint signs with the maker's key, so live boot refuses without a maker address — and that stream is the **canonical writer** of the maker's commitments, fills, and positions: snapshot-first baseline, then real-time deltas. Dry-run has no signer and never subscribes; its own-state surface is inert. The former bounded poll — `client.commitments.list({ maker, status: ['open','partially_filled'], limit: maxOpenCommitments + buffer })` with by-hash lookups of disappeared tracked rows, per-record `getCommitment` probes of soft-cancelled rows, and `client.positions.status(address)` — survives once per tick as the **audit probe set**: it converges a per-tick audit clone for the audit-vs-canonical divergence comparator and never drives state. A composite stream-health predicate (transport freshness, auth, queue overflow, indexer lag via the `client.ownState.health()` poll, audit divergence) gates posting while degraded and, with open exposure, actively cancels the maker's quotes. On process restart the MM performs a cold restart of the stream (a fresh snapshot rebuild); it does not resume from a persisted cursor across process restarts. **Note:** `client.positions.byAddress(address)` is not currently paginated / `since`-filtered in the SDK, so the hot loop avoids it (it's used on boot to reconcile state).

- **Contest discovery — slow bounded poll, now; push, later.** `client.contests.list` (then `client.speculations.list` to confirm an open speculation exists) every `discovery.everyNTicks` ticks (~5 min) with jitter — new contests appear a few times a day. Could become push via the `contests` / `speculations` SSE streams (added in SDK 0.3.0), a lower-priority follow-up.

---

## 11. Telemetry & the run summary

**Event log.** NDJSON, one file per run (or rotated daily) under `telemetry.logDir`. Every line: `{ ts, runId, kind, ...payload }`. `kind` ∈ `tick-start`, `candidate` (a contest considered; carries `skipReason` if skipped — values include `no-reference-odds`, `no-open-speculation`, `would-create-lazy-speculation`, `stale-reference`, `start-too-soon`, `cap-hit`, `refused-pricing`, `tracking-cap-reached`, `gas-budget-blocks-reapproval`, `gas-budget-blocks-settlement` (on-chain `settleSpeculation` / `claimPosition` denied by the gas verdict; the candidate event's `purpose` field is `'settleSpeculation'` or `'claimPosition'` and `mayUseReserve` reflects `settlement.continueOnGasBudgetExhausted`), `gas-budget-blocks-onchain-cancel` (a `cancelCommitmentOnchain` denied by the gas verdict; carries `commitmentHash` / `speculationId` / `makerSide` + the gas counters. **Producers — two emit shapes:** (1) automatic & reserve-preserving — `mayUseReserve: false`, additionally carries `contestId` (all via the shared `onchainCancelCommitment`): the routine `orders.cancelMode: onchain` cancels (a retained `partiallyFilled` remainder or a recovered soft-cancel, §9), the funding guard's `underfundedCancelMode: onchain` sweep (§6), and the §5.1 own-state-health active cancel-sweep — each leaves the record matchable and retries (on the normal cadence, or the next held tick after a gas-denied break) rather than burning the reserve; (2) operator-explicit & reserve-eligible — `mayUseReserve: true`, no `contestId`: the shutdown kill / `cancel-stale --authoritative` paths, breaking the cancel loop on the first denial since today's spend only grows), `already-settled` (auto-settle idempotent skip — `ensureSpeculationSettled` found the speculation already settled or recovered from a concurrent settle; carries `purpose: 'settleSpeculation'`, `outcome` (`'alreadySettled' | 'recovered'`), `winSide`. Gas appears **only** when a `recovered` race had our own settle revert on inclusion: then `revertedTxHash` + `gasPolWei` are present and that gas is debited (and summed under `settle`), OR — if that reverted receipt couldn't be fetched — `revertedTxHash` + `gasAccountingGap: true` with no `gasPolWei` (no faked gas). The no-tx cases — pre-flight `alreadySettled` and pre-send `recovered` — carry neither `gasPolWei` nor `gasAccountingGap`), `already-claimed` (auto-claim idempotent skip — `ensurePositionClaimed` found the position already claimed or recovered from a benign already-claimed race; carries `purpose: 'claimPosition'`, `outcome` (`'alreadyClaimed' | 'recovered'`). **NOT a `claim` event and no payout** — the contract zeroes economic fields once claimed, so none is derived. Gas mirrors `already-settled`: only a `recovered` race that reverted our own claim on inclusion carries `revertedTxHash` + `gasPolWei` (debited, summed under `claim`), or `revertedTxHash` + `gasAccountingGap: true` if that reverted receipt couldn't be fetched; the no-tx cases (`alreadyClaimed`, pre-send `recovered`) carry neither. The run summary classifies these positions `alreadyClaimed`, **not** `wonUnclaimed`); `cap-hit` also carries `takerSide` — which taker offer was deferred), `fair-value`, `risk-verdict` (the engine's per-market decision — payload `{ contestId, speculationId, sport, awayTeam, homeTeam, allowed, awayOffer: { allowed, sizeUSDC, headroomUSDC }, homeOffer: { allowed, sizeUSDC, headroomUSDC }, notes }`; `allowed` mirrors `desired.canQuote`; per-side `headroomUSDC` is the max additional risk the per-cap math allowed on that side; `sizeUSDC` is the engine-bound size when allowed (0 when refused); `notes` carries the refusal reasons. Emitted only when the engine actually runs — i.e. after the pre-engine gates (`no-reference-odds` / `start-too-soon` / `stale-reference` / `no-open-speculation`) have passed; pre-engine skips surface as `candidate` `skipReason` instead), `quote-intent`, `quote-competitiveness` (per would-be offer: `takerSide`, `takerOddsTick`, `takerImpliedProb`, the protocol commitment params `makerSide` / `makerOddsTick` / `positionType` (`toProtocolQuote` of the offer — §5), `referenceTakerTick`, `referenceImpliedProb`, `vsReferenceTicks`, `bookDepthOnSide`, `bestBookTakerTick` (the *highest* taker-perspective tick — `inverseOddsTick(c.oddsTick)` — among the orderbook commitments serving that same taker side, i.e. at the same `positionType` as the MM's would-be commitment; a higher taker tick is a longer payout, so this is the offer takers reach for first), `atOrInsideBook` (= `takerOddsTick ≥ bestBookTakerTick`, or no one else is offering that side) — where the would-be offer sits vs the visible orderbook on its side and vs the reference odds), `competitiveness-unavailable` (the speculation's orderbook wasn't available for the read — degraded), `submit` / `would-submit`, `soft-cancel` / `would-soft-cancel`, `replace` / `would-replace` (each carries both the taker-facing offer fields — `takerSide`, `takerOddsTick`, `takerImpliedProb` — and the protocol commitment params `makerSide` / `makerOddsTick` / `positionType`), `onchain-cancel` (an on-chain `cancelCommitment` landed — payload `{ commitmentHash, speculationId, contestId, makerSide, txHash, gasPolWei }`; the local record is stamped `authoritativelyInvalidated`; emitted by the routine `orders.cancelMode: onchain` partial-remainder cancel, the funding guard's `underfundedCancelMode: onchain` sweep, the §5.1 own-state-health active cancel-sweep, the shutdown-time on-chain kill path, and `cancel-stale --authoritative`), `nonce-floor-raise`, `expire` (a tracked commitment hit expiry → headroom released), `approval` (`purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`, `walletBalanceWei6?`, `txHash`, `gasPolWei`; `walletBalanceWei6` is present in `mode: 'exact'` (the bound applied to `amountSetTo`) and absent in `mode: 'unlimited'` (operator-confirmed via `--yes`, no wallet bound)), `fill`, `position-transition` (a tracked position's status advanced forward — payload `{ positionId, speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, fromStatus, toStatus, result?, predictedWinSide? }`; `fromStatus` / `toStatus` ∈ `active | pendingSettle | claimable`; `claimed` is set by the auto-claim path, not by the poll. `pendingSettle` and `claimable` API views carry `result: 'won' | 'push' | 'void'`; `pendingSettle` additionally carries `predictedWinSide`), `settle` (auto-settle fired — payload `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, winSide, txHash, gasPolWei }`; `winSide` from the on-chain `SPECULATION_SETTLED` event), `claim` (auto-claim fired — payload `{ speculationId, contestId, sport, awayTeam, homeTeam, makerSide, positionType, payoutWei6, txHash, gasPolWei, result? }`; `payoutWei6` from the on-chain `POSITION_CLAIMED` event; `result` (optional) is the settled outcome `'won' | 'push' | 'void'` copied from the position-status API's `ClaimablePositionView.result` — present when the position-poll observed it before claim; the summary walker treats it as authoritative for outcome classification, so a `--since` window that clips the `settle` event still classifies push/void refunds correctly; the local `MakerPositionStatus` is stamped `claimed`. **Emitted only on a FRESH claim** (`ensurePositionClaimed` → `outcome: 'claimed'`); a position found already claimed emits the `already-claimed` candidate above instead — no `claim` event, no payout), `degraded` (a market's odds channel errored), `error` (class + detail), `kill`. Values that can exceed `Number.MAX_SAFE_INTEGER` (risk in wei6, block numbers) are strings — same convention as the SDK's AGENT_CONTRACT. **This NDJSON shape is the stable contract** the future external scorecard reads; the MM does not change it lightly.

**Run summary.** `ospex-mm summary [--since <ts>] [--json]` reads the log(s) and emits the metrics in §2.3 (including the latent-exposure peak). `--json` → a single `schemaVersion`-stamped envelope (SDK-style). This is the MM's *own* report; the cross-agent platform-viability scorecard is the harness's job and consumes the same NDJSON.

---

## 12. State persistence

A small set of JSON files under `state.dir`: each posted commitment by hash with its current state (`visibleOpen` / `softCancelled` / `partiallyFilled` / `filled` / `expired` / `authoritativelyInvalidated`) and expiry; the resulting positions; running P&L; daily POL-gas and fee counters (keyed by date). Atomic writes (temp + rename). **The `softCancelled` set is the one piece of state not reconstructible from chain/API** — a DELETE removes a quote from the API but not from on-chain validity — so it's persisted and reloaded; if the state file is lost, the MM under-counts latent exposure until those quotes expire (keep `expirySeconds` short). **JSON state is not multi-process safe — one MM per state directory, now enforced by a single-process lock.** Both state-writing commands (`run` and `cancel-stale`) acquire an `O_EXCL` lock file (`state.dir/maker.lock`) at boot, recording the holder's pid / hostname / maker wallet / config path / run id. A second instance against the same `state.dir` **fails closed** with a clear refusal (it names the live holder); a stale lock left by a crashed run is reclaimed only when the recorded pid is verifiably dead on the same host (a cross-host or unparseable lock fails closed — the operator removes it by hand once they've confirmed no MM is running). Without this, two instances silently last-writer-wins-corrupt `maker-state.json`, and because the corrupted blob still passes the shallow load validation the state-loss fail-safe never fires. Read-only commands (`status`, `doctor`) take no lock. See `src/state/lock.ts`. On boot, the loop loads state and reconciles the rest against on-chain / API reality (`client.commitments.list({ maker })`, `client.positions.byAddress`) — chain is truth; the local state is a (mostly) rebuildable cache, plus the soft-cancelled set. **Boot-time state-loss fail-safe:** if the persisted `softCancelled` set is missing or corrupt after a prior run, the MM does **not** resume quoting on a blank slate — that would under-count latent matchable exposure (a prior soft-cancelled quote could still be matchable on chain). It first tries to reconstruct the set by replaying recent telemetry; failing that, it waits one full `expirySeconds` window (long enough for any prior soft-cancelled quote to have expired) before posting; or the operator passes an explicit override (e.g. `--ignore-missing-state`, used only when you know no prior run left open commitments). SQLite is overkill for v0's data volume; JSON also keeps the state human-inspectable. Revisit if it grows.

**One wallet per instance.** The `state.dir` lock enforces one *process* per state directory; it does **not** enforce one *wallet* across directories. Two instances pointed at different `state.dir`s but the **same keystore** each acquire their own lock and run — both quoting the same markets on the same maker address. That is a genuine misconfiguration: each instance sees the other's fills as orphans it never posted (`unknown-own-fill` → cursor freeze + cold restart), and they cancel/replace each other's quotes — a mutual-churn loop. Hard cross-instance mutual exclusion on a wallet would need a shared coordination point, which is the explicitly out-of-scope "multi-host nonce coordination" non-goal (§16); instead a live boot runs a cheap, best-effort **detection**: it reads the wallet's currently-open commitments and, if any were not posted by this instance (absent from local state), emits a `foreign-maker-commitments` telemetry event and a loud WARN (it never refuses — a foreign open commitment can also be benign prior-run residue or a hand-posted quote). Run one MM per wallet; see `OPERATOR_SAFETY.md`.

**Sensitive local state (own-state SSE plan §M6).** Post-M6/A, each commitment record persists the SDK's canonical signed bundle — the EIP-712 `signature` and the inner typed-data struct — under `MakerCommitmentRecord.signedPayload`. This is the same input `MatchingModule.matchCommitment` needs to fill the commitment, so an attacker with the maker's state file can match the maker's still-matchable commitments until they expire / are filled / are cancelled. Operators MUST treat `state.dir` like a wallet directory, not a log directory. Three defences live in this repo:

- **File mode `0o600` on POSIX, from birth.** `StateStore.flush` creates the temp file via `O_WRONLY|O_CREAT|O_EXCL` (`flag: 'wx'`) with `mode: 0o600` so the file lands at owner-only at the kernel-level `open` syscall — no window between "file exists" and "file is locked down" for a concurrent reader to observe. A stale temp from a prior crash is `unlinkSync`'d first so the next create doesn't inherit the old (possibly permissive) mode. POSIX-only `statSync` sanity check after creation throws if the mode didn't take (a filesystem that silently drops mode bits — FAT, certain network mounts — fails the flush rather than publishing weak-mode state). On Windows mode bits don't map to ACLs; the sanity check is skipped and the operator restricts the parent-directory ACL themselves (`OPERATOR_SAFETY.md`).
- **Telemetry / artifact redaction at the wire boundary.** Two defences inside `EventLog.emit`. (1) **Denied keys throw.** Any payload key matching `signature` / `signedPayload` / `commitment` / `nonce` at any depth fails closed — that's the structural-misuse path (caller should be allow-list-projecting via `commitmentEventPayload` / `softCancelEventPayload`). (2) **Sensitive string substrings are redacted inline.** Every string value, recursively, has the 65-byte ECDSA signature pattern (`0x` + 130 hex) and the JSON-shape signature/signedPayload markers replaced with `[REDACTED]` tags before serialization. The redaction (rather than throw) is for incidental contamination — an RPC error message, a `errMessage(err)` call that happens to quote signed bytes — so the telemetry writer keeps running and the operator still sees the surrounding diagnostic context.
- **Secret scanner in CI.** `yarn secret-scan` (also a CI step) scans tracked + untracked-non-gitignored text files for a 65-byte ECDSA signature pattern, a quoted `signedPayload` JSON key, or a quoted `signature` JSON key whose value begins with `0x`. Fails the PR on any hit so an accidentally-pasted state snippet doesn't reach the public tree.

**Migration (pre-M6/A → M6/A state files).** A state file written by a pre-M6/A run loads cleanly: every commitment record gets `signedPayloadStatus: 'missing-legacy'` and an absent `signedPayload`. Cancel paths fall back to the SDK's `cancelOnchain({ hash })` for visible rows (the SDK fetches + reconstructs the bundle from the public commitments API); for hidden rows (`softCancelled`), the public API redacts the bundle (M2) so the cancel is BLOCKED, fires a `cancel-blocked-missing-payload` telemetry event, and waits for operator action. Operators inspecting prior-run state files for hidden + still-matchable commitments should consult `OPERATOR_SAFETY.md` for the recovery playbook.

---

## 13. Distribution, deployment, license, disclaimers

- **Stack.** Node 20+, TypeScript strict (`exactOptionalPropertyTypes`), yarn, `vitest`. Deps minimal: `@ospex/sdk` (exact GitHub Release tarball — §4; never a committed tarball), a YAML parser, `pino`, a CLI lib (match the `ospex` CLI's), and whatever `@ospex/sdk` pulls transitively (`viem`; `ethers` only via the keystore subpath).
- **Deployment.** A worker process. Local: `ospex-mm run` (or `yarn mm run` from a clone). Heroku: a `worker` dyno (`Procfile: worker: node dist/cli/index.js run ...`) — **never `web`**. An `app.json` with the worker formation and the `Procfile` ship alongside `ospex-mm run` in Phase 3 (not in the genesis scaffold).
- **License — MIT.** Matches `@ospex/sdk`. Only the smart contracts stay BUSL.
- **Public README + `docs/OPERATOR_SAFETY.md` must carry, prominently:**
  - Experimental software; **no warranty**.
  - Wagering / on-chain transactions carry **financial risk**; **no profit guarantee** — odds accuracy, liquidity, settlement timing, RPC availability, and indexer latency are all best-effort.
  - Nothing here is financial, legal, or tax advice.
  - **You are responsible for compliance with the laws of your jurisdiction** and for any tax / regulatory treatment; this software enforces no geofencing or KYC.
  - **Dry-run first**; start with **tiny caps**; understand the two-key live model and the kill switch before going live.
  - The MM never logs your private key, but **when live it will submit transactions and move funds**. Approvals can be abused by buggy software; approve only what you'll risk; audit with `ospex doctor` / `ospex approvals show`.
  - **An off-chain cancel pulls a quote from the order book but does not invalidate the signed payload** — a taker holding it can still match it until it expires (≈2 min by default). For a hard stop, use the on-chain kill (`killCancelOnChain: true`, costs gas).
  - The MM needs **POL/MATIC for gas** (approvals, on-chain cancels, settle, claim) and **USDC for stakes** — keep both topped up; `ospex-mm doctor` flags low balances.

  `docs/OPERATOR_SAFETY.md` expands the safe-operation checklist: keystore setup, the two-key live model, the soft-vs-hard kill, the latent-exposure window, what to read in the dry-run output before going live, watching your caps, keeping gas funded, revoking approvals.

---

## 14. Success criteria, by phase

- **Phase 0 (this doc).** Signed off (after the third review pass + the maintainer's final pass).
- **Phase 1 — scaffold + read-only core.** `ospex-mm doctor` reports readiness (wallet, USDC + POL balances, `PositionModule` allowance, network — mirrors `ospex doctor`). `ospex-mm quote --dry-run <contestId>` produces a sane two-sided moneyline quote with a full breakdown (and refuses with a clear message if no open speculation exists / a lazy-creation path is detected). Pricing module unit-tested (vig strip, both spread modes, every refusal path, tick-bound checks). Risk engine implemented and unit-tested including latent-exposure accounting and the aggregate-allowance target (these gate Phase 3 even though no Phase-1 path uses them yet). Commitment polling uses explicit SDK options (`status`, `limit`) from day one; the boot-time state-loss fail-safe (§12) is in place. **Phase 1 is strictly read-only — no `submit` / cancel / approve live paths exist at all, not even behind a flag; the SDK's write methods aren't wired in `src/ospex/` until Phase 2+.**
- **Phase 2 — shadow mode.** `ospex-mm run --dry-run` runs for hours without crashing; produces quote decisions; rejects bad / ambiguous / stale data and lazy-creation paths with logged reasons; obeys every cap including latent exposure (verified with deliberately tight caps); explains each quote and each skip; tracks would-be-stale rate, quote competitiveness, and latent-exposure peak; honours the stream guardrails (subscription caps, backoff, coalescing, degraded-on-error).
- **Phase 3 — live micro-maker.** `ospex-mm run --live` (config `mode.dryRun: false` AND the `--live` flag) with tiny budgets posts commitments on existing open speculations only; rolls short-expiry quotes forward; pulls + reposts on staleness / odds move; off-chain cancels keep working when the gas budget is hit; tracks latent exposure and never exceeds caps; raises the `PositionModule` allowance to `min(risk-cap ceiling, current wallet USDC)` in `mode: exact` (deferred while the state-loss hold is active — §12), never `MaxUint256` unless explicitly configured + `--yes`-confirmed; refuses lazy-creation commitments; gets matched by a manual CLI taker (a second Foundry keystore + the `ospex` CLI); auto-settles / claims its own positions if configured; produces a clean run log and a coherent `summary`.
- **Phase 4 — public-ready.** A fresh clone + `ospex-mm.example.yaml` + a funded Foundry keystore + an RPC URL → a working dry-run in under ten minutes following only the README / QUICKSTART. CI green (install / build / typecheck / test). MIT license + the README / `OPERATOR_SAFETY.md` disclaimers in place. The "what a real MM would do differently" notes ported into `docs/`.

After Phase 3, before the multi-agent fishbowl: the SSE fills/positions runner wiring (§10) — **since shipped** as the own-state polling retirement: the owner-authenticated own-state stream is the canonical state driver in live mode, and the bounded poll survives only as a per-tick audit cross-check. The spread / total strategies and lazy-speculation support are post-v0 work, tracked separately.

---

## 15. Out of scope for v0 — the "what a real MM does differently" list (plus v0 deliberate limits)

Asymmetric spread split / inventory-aware price skew (Avellaneda–Stoikov-style) · measured fill-rate model (per sport / time-to-tip / price-competitiveness) · probabilistic fair value · cross-venue hedging · latency-aware quoting beyond the odds subscription · alternative vig-stripping methods (Shin / power / log-odds) · multi-host nonce coordination (v0 is single-process) · **spread & total strategies *validated*** (the architecture slots them; moneyline ships first) · **lazy speculation creation** — auto-seeding new speculations + `TreasuryModule` creation-fee approvals/budgeting; v0 only quotes existing open speculations. The SSE fills / positions runner wiring is *not* in this list — it has shipped (§10): the own-state stream is the canonical state driver, with the bounded poll retained as a per-tick audit cross-check.

---

## 16. The firewall — what does NOT live in this repo

Flow / taker agents, observer / settlement agents, and cross-agent scorecards are **not** part of this repo, ever. They exist only to *exercise* a market maker and *prove the Ospex platform* (a lone maker with no takers proves nothing) — evidence-gathering apparatus, not the product. The test harness, when it's built, is a **separate repository** (location TBD; built once the MM is far enough along to be worth exercising). Through the live-micro-maker phase, the `ospex` CLI from a second wallet covers manual taker / observer testing — no harness needed yet.

**Provider-name hygiene.** No specific upstream odds-provider names appear in any user-facing surface — committed docs (including this one), README, code comments, CLI output, JSON telemetry payloads, configs, examples. The SDK's provider-specific *wire-field* names appear *only* inside the `src/ospex/` adapter, which maps them to the MM's neutral terms (`referenceGameId` / `upstreamGameId`); everything outside that adapter uses the neutral terms. Public-facing language is "upstream / reference odds surfaced by the Ospex SDK".

**Local-only operational notes** (deployment specifics, monitoring wiring, scratch configs) belong in a **gitignored `internal/` directory** — never in this tree or any committed file.

What *is* in this repo: the MM's own single-agent run summary (its P&L, fill rate, gas, stale-quote incidents, latent-exposure peak — operators running solo want it). The link to the harness: the NDJSON event log (§11) is shaped so the external scorecard can consume it with no changes to the MM.

---

## 17. Open questions

**Resolved across the review rounds:** license (MIT) · subscription-first ingestion (odds push + lifecycle guardrails; own-state push — now the canonical state source, with the bounded poll demoted to a per-tick audit cross-check) · gas (POL-denominated; spent only on approve / on-chain-cancel / nonce-raise / settle / claim; budget exhaustion blocks re-approvals + authoritative invalidation, not gasless posting/off-chain-cancel) · latent matchable exposure (a tracked category; caps bind it; off-chain cancel doesn't free headroom; the soft-cancelled set is persisted) · default expiry (`fixed-seconds` ~120 s; `match-time` available with a warning) · lazy-speculation policy (v0 refuses lazy-creation commitments; quotes only existing open speculations) · approvals (`exact` = raise to `min(risk-cap ceiling, current wallet USDC)`, deferred while the state-loss hold is active, raise-only; `unlimited` only on opt-in + `--yes`) · bounded fill detection (hash-tracking + `positions.status`; avoid unbounded `byAddress` in the hot loop) · dry-run reports quote competitiveness, not a fill rate · competitiveness-read bounds · partial-fill accounting (no double-count) · settlement ≠ oracle/scoring · state store (JSON, single-process) · tick cadence (`ownState.auditPollIntervalMs`, default 60 s — the former top-level `pollIntervalMs` and its 30 s floor were retired with the own-state polling retirement) · discovery cadence (~10 ticks, jittered, subscriptions capped) · default caps (the conservative starter profile in §7) · SDK install (exact GitHub Release tarball) · provider-name self-reference removed from this doc · v0 markets = moneyline only.

**Still open (maintainer calls, not design questions):**

1. **Confirm the short-`fixed-seconds` expiry default** (vs `match-time`) — recommended for the latent-exposure reason; flag if you'd rather default the other way.
2. **Sequencing the SSE fills/positions runner wiring** — resolved: the owner-authenticated own-state stream is wired as the canonical state driver (always on in live mode), and the poll was retired to a per-tick audit cross-check (§10).
3. **Proceed to scaffold now, or one more confirming review of this revision?** The review's stated path was "patch the doc for the listed items, then proceed to scaffold" — so this revision should be clear to go to Phase 1.
