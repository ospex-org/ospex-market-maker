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
4. **`approvals.mode: exact` means an *aggregate absolute* allowance, not a per-quote shortfall.** `approve(x)` *sets* the ERC-20 allowance to `x`; it does not add. The MM sets `PositionModule`'s allowance to the maximum aggregate matchable risk its configured caps could ever require — a finite, computable number — never `MaxUint256` unless `approvals.mode: unlimited` (config + `--yes`). Approval telemetry carries `purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`. (§6, §7, §11)
5. **Gas wording corrected.** POL is spent **only** on `approve`, on-chain `cancelCommitment`, nonce-floor raises, `settleSpeculation`, `claimPosition`. Posting a commitment and routine off-chain cancels are EIP-712 signing + an API call — *no gas*. The "stop new quotes when the gas budget is hit" rule is reframed: posting stays allowed (it's gasless) unless it would force a re-`approve` we can't afford; off-chain cancels of stale/mispriced quotes always continue. (§6)
6. **Bounded own-state polling claim corrected to match the current SDK.** Fill detection = `client.commitments.list({ maker, status: open,partially_filled })` (bounded by `maxOpenCommitments`) + by-hash lookup of the few tracked commitments that disappeared since last tick + `client.positions.status(address)` periodically. `client.positions.byAddress` is not currently paginated/`since`-filtered, so the hot loop avoids it. (§10)
7. **Provider-name self-reference removed.** This doc no longer writes the SDK's provider-specific wire-field name in prose — the literal appears only in `src/ospex/` code. (whole doc, §16)

### Revision 3 — second review pass

Precise provider-name principle (SDK wire fields only inside `src/ospex/`) · off-chain cancels never gas-gated · gas budgeted in POL (`gas:` block) with optional USDC-equivalent reporting · SDK install = exact GitHub Release tarball (not npm, not a caret range) · Realtime lifecycle guardrails (channel caps, backoff+jitter, dirty-event coalescing, snapshot-first, degraded-on-error) · bounded competitiveness reads · explicit partial-fill accounting · settlement ≠ oracle/scoring clarification · open-question answers folded in.

### Revision 2 — first review pass

MIT confirmed · subscription-first ingestion (odds push now; maker's-own state bounded-polled; fills push as a cross-repo fast-follow) · no provider/sibling-repo names in public text · no internal-ops in public docs (`internal/` gitignored dir) · public `@ospex/sdk` link · SDK dependency reworked for clean fresh-clone install · dry-run reports *quote competitiveness*, not a fill rate (Ospex isn't a CLOB) · two-key live model · exposure = worst-case loss by outcome · book-hygiene invariant softened · SDK vs wrapper names aligned · auto-approval opt-in · v0 markets = moneyline only (config rejects spread/total) · README + `docs/OPERATOR_SAFETY.md` disclaimer requirements.

---

## 1. What this is

A **reference market maker** for [Ospex](https://ospex.org) — the zero-vig peer-to-peer sports prediction protocol on Polygon. Clone it, point it at your wallet / bankroll / RPC / return target, and it quotes two-sided liquidity on upcoming contests, manages its exposure (including the *latent* exposure of signed quotes it has pulled but can't unsign), reacts to fills, settles and claims, and writes an auditable record of everything it did.

It is built **on top of [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk)** — every chain and API interaction goes through the SDK. This repo never calls the Ospex contracts directly. The SDK already provides: contest / speculation / commitment / position / odds reads, signed-commitment submit / match / cancel / on-chain-cancel / nonce-floor-raise, position settle / claim / claim-all / status / claim-params, EIP-712 signing, the `KeystoreSigner`, typed errors, allowance pre-flight, the odds Realtime subscription, and a per-instance nonce counter. So this repo owns only the *decisions*: which markets to quote, at what price, at what size, when to cancel / replace, when to stop — plus the config, the risk engine, the event loop, the persistent state, and the telemetry.

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
2. **Reference pricing.** Subscribe to upstream reference odds for the games being tracked (`client.odds.subscribe(...)`, keyed by reference game id + market — the `src/ospex/` adapter maps the neutral id to the SDK's wire field), seeded by a one-shot snapshot (`client.odds.snapshot(contestId)`); strip the consensus vig → fair probabilities; derive a quoting spread (see §5) from the operator's economics or a directly-configured spread.
3. **Order placement.** Post signed two-sided commitments (moneyline in v0 — see §5) on *existing open speculations* via `client.commitments.submit`, sized by per-quote cap and exposure headroom (including latent exposure — §6), with a short expiry (the recommended `fixed-seconds` mode — §7). Emit a preview before posting; refuse if the SDK preview reports a lazy-creation path; never post in dry-run.
4. **Order management.** List its own open commitments (`client.commitments.list({ maker })`); refresh / replace a quote when it ages or reference odds move past a threshold — by pulling it from the API (off-chain) and posting a fresh one; never *intentionally surface* duplicate or inconsistent orders (the book-hygiene invariant, §9). **Track that an off-chain cancel does not invalidate the signed payload — the pulled quote is "latent" and still counts against caps until it expires (or is invalidated on-chain).**
5. **Exposure management.** Track open liability — `visibleOpen` *and* `softCancelled`-but-not-yet-expired commitments — plus filled positions; cap **worst-case USDC loss by outcome** per commitment, per contest, per team, per sport, and as a fraction of total bankroll (§6); stop quoting a market / team / sport when its cap is reached; stop quoting entirely when the bankroll ceiling is reached.
6. **Fill monitoring.** Detect matched commitments / new positions (bounded — `commitments.list({ maker, status: open,partially_filled })` plus by-hash lookup of the tracked hashes that disappeared, plus `positions.status(address)` periodically; a Realtime channel is a cross-repo fast-follow — §10); move filled risk from "open / latent quote" to "filled position" in the inventory; recompute P&L; immediately re-price (or pull) the opposite side of a market after a fill, because the fill changed the exposure.
7. **Settlement / claim path.** Detect scored / claimable speculations for the maker's *own* positions; optionally settle (permissionless) and claim automatically (config toggles), or leave it to the operator. **"Settle" here means finalising a speculation that is *already scored* and claiming the maker's own positions — the MM does not create contests, run oracle requests, submit scoring scripts, or require LINK.** It needs only USDC (stakes; approved to `PositionModule`) and gas (POL/MATIC; for the on-chain ops listed in §6).
8. **Safety.** Honor hard caps on USDC risk (including latent matchable exposure), daily gas budget (in POL), and daily fee budget; run in dry-run mode; expose a kill switch; auto-approval off by default and never silently unlimited; never loop on a reverting transaction or a Realtime reconnect.
9. **Telemetry.** Log every decision, commitment, and transaction as structured events; produce a single-agent run summary (quote age, fill rate *(live)* / quote competitiveness *(dry-run)*, spread earned, P&L, gas (POL; optionally USDC-equivalent), fees, stale-quote incidents, latent-exposure peak, error counts, settlement outcomes).

### 2.2 Forbidden — what v0 must never do

- **Never call the Ospex contracts directly.** Everything via `@ospex/sdk`.
- **Never assume an off-chain cancel removed exposure.** Pulling a quote from the API does not invalidate the signed payload; only expiry, on-chain `cancelCommitment`, or a nonce-floor raise frees the headroom. The MM keeps quote expiries short so this window is small.
- **Never let aggregate matchable risk exceed the `PositionModule` allowance** (or the wallet's USDC balance, or the configured caps). The allowance is set to the aggregate cap ceiling (§6) — never `MaxUint256` unless explicitly configured + confirmed.
- **Never approve USDC on its own unless `approvals.autoApprove` is set.** Never approve in dry-run. Every approval is a telemetry event with the fields in §11.
- **Never quote a market whose speculation doesn't yet exist** (which would trigger lazy creation + a `TreasuryModule` fee). Refuse with `skip-reason: would-create-lazy-speculation`.
- **Never exceed any configured cap** — per-commitment, per-contest, per-team, per-sport, total-bankroll, max-open-commitments, daily-gas, daily-fee — computed as worst-case loss by outcome over visible + latent commitments and filled positions (§6). Enforced *every tick*, before any submit.
- **Never quote on missing / ambiguous / stale-beyond-threshold reference data.** Refuse the market with a logged reason; do not guess a price.
- **Never quote prices it can't justify.** If the operator's economics imply an unrealistic spread (or one tighter than the consensus market), refuse to start and name the input(s) to change. No nonsense quotes — better to do nothing.
- **Never leave a stale or mispriced quote *visible*.** Pulling it from the API is gasless and always allowed regardless of the gas budget — do it, then post a corrected one (or let the pulled one expire and post fresh).
- **Never retry a reverting transaction in a tight loop**, or a Realtime reconnect in a tight loop. Bounded retries with backoff + jitter; after N failures on the same operation, stop it and log it.
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
- **Errors** by class (allowance, chain / revert, API, config, signing, realtime, ...).
- **Settlement / claim outcomes** for the maker's own positions.

---

## 3. Architecture

A single long-running worker process. No HTTP surface. Runs locally (`ospex-mm run`) or as a Heroku `worker` dyno. One process = one signing identity = one `OspexClient` instance (the SDK's nonce counter is per-instance — see the SDK's AGENT_CONTRACT §9).

### Layers (`src/`)

| Dir | Responsibility |
|---|---|
| `config/` | Load + validate the YAML config (and env overrides); the typed `Config`. Boot fails fast on invalid config. |
| `ospex/` | The **only** module that imports `@ospex/sdk`. Constructs the `OspexClient` and `KeystoreSigner`; exposes the narrow set of calls the MM needs — contest / speculation / commitment / position reads, the odds **subscription** + snapshot, commitment submit / off-chain cancel / on-chain cancel / nonce-floor raise, fill polling, settle / claim, allowance read + set. The SDK's provider-specific wire-field names (e.g. the reference-game-id field) are confined to this adapter; it maps them to the MM's neutral terms (`referenceGameId` / `upstreamGameId`). Wrapper method names may differ from the raw SDK names — the SDK's names are canonical. |
| `pricing/` | Pure functions: vig stripping → fair value; spread derivation (economics or direct mode); two-sided quote-price construction; odds-tick conversion + bounds checks. Per-market-type strategies under `pricing/strategies/` (`moneyline.ts` implemented; `spread.ts` / `total.ts` are stubs that throw "not yet implemented" — present for contributors, not wired into v0 config validation). Heavily unit-tested. |
| `risk/` | Exposure tracking — worst-case loss by outcome over filled positions **and** `visibleOpen` **and** `softCancelled`-not-yet-expired commitments — plus cap enforcement and the `PositionModule` aggregate-allowance target. The **risk engine**: `(inventory, proposedQuote, config) → { allowed, sizeUSDC } | { refused, reason }`. The loop never submits without an `allowed` verdict. |
| `orders/` | The order lifecycle: build desired quotes, check the SDK submit preview (refuse on lazy creation), reconcile against actual open commitments, submit / soft-cancel-and-repost / book-hygiene reconcile, and the authoritative (on-chain) cancel + nonce-floor paths used by the kill switch and `cancel-stale --authoritative`. Wraps the SDK's commitment calls (via `ospex/`). |
| `state/` | Persistent inventory: each posted commitment tracked **by hash** in a state — `visibleOpen` → (`softCancelled` \| `partiallyFilled`/`filled` \| `expired` \| `authoritativelyInvalidated`) — plus resulting positions, running P&L, daily POL-gas / fee counters. **The `softCancelled` set (with expiries) is the one piece of state not reconstructible from chain/API** — an off-chain DELETE removes a quote from the API but not from on-chain validity — so it is persisted locally; if the state file is lost, the MM under-counts latent exposure until those quotes expire (another reason to keep `expirySeconds` short). JSON file(s) under a configurable state dir, atomic writes (temp + rename). **Not multi-process safe — one MM per state dir.** |
| `telemetry/` | The NDJSON event-log writer + the summary aggregator. |
| `runners/` | The event loop (one runner, `dryRun` mode flag), the kill-switch check, graceful shutdown. |
| `cli/` | `ospex-mm doctor | quote | run | cancel-stale | status | summary`. CLI framework: match what the `ospex` CLI uses, for consistency. |

### The event loop

The MM is **event-driven for odds** (subscription callbacks) and **timer-driven for everything else** (a `pollIntervalMs` tick). An odds-change callback marks the affected market *dirty*; rapid moves coalesce — a market is reconciled at most once per tick. One tick:

1. **Kill-switch check.** If tripped → pull all visible quotes off-chain; if `killCancelOnChain`, also raise on-chain nonce floors per speculation (uses the gas reserve); flush state + telemetry; exit `0`. (Note: with `killCancelOnChain: false` the soft-cancelled quotes stay matchable until they expire — see §6.)
2. **Discovery** (every `discovery.everyNTicks` ticks — default 10 ≈ 5 min at a 30 s tick — with jitter): list upcoming contests per the config filters, up to `marketSelection.maxTrackedContests`; for each, confirm an *open speculation* exists for the market(s) being quoted (skip otherwise — `no-open-speculation`); open odds subscriptions for new ones (up to `odds.maxRealtimeChannels`), seeding each with a one-shot snapshot; drop subscriptions for contests that have started / left the window.
3. **For each dirty or newly-tracked market:** compute fair value → run the risk engine over the *aggregate* exposure (positions + visibleOpen + softCancelled-not-yet-expired + the proposed quote) → if `allowed`, build the desired quote → check the SDK submit preview (refuse on lazy creation) → reconcile against the actual open commitments on that speculation: pull (soft-cancel) any visible quote that's stale/mispriced and post a fresh one; submit what's missing. Record a telemetry event per candidate, including skips with reasons.
4. **Detect fills** — `client.commitments.list({ maker, status: open,partially_filled })` (bounded by `maxOpenCommitments`); diff against the set of hashes that were `visibleOpen` last tick; look up by hash the few that disappeared (→ `filled` / `cancelled` / `expired`); reclassify; on a fill, update inventory + P&L → re-price or pull the opposite side of that market. Periodically also read `client.positions.status(address)` for the settlement view.
5. **Age out** `softCancelled` (and unmatched `visibleOpen`) commitments that have passed their expiry → reclassify `expired`, release headroom.
6. **(If configured)** sweep claimable positions: settle (permissionless) where needed, then claim — subject to the gas reserve (§6).
7. **Flush** state + telemetry. Sleep `pollIntervalMs`. Repeat.

A channel error / unrecoverable disconnect on an odds subscription marks that market **degraded** → its visible quotes are pulled (off-chain) and its reference is treated as stale until the channel recovers (the latent exposure of those pulled quotes persists until they expire). `pollIntervalMs` has an enforced floor (§7); the loop logs and clamps if config goes below it. Because odds arrive via subscription, this interval paces discovery + fill detection, not odds reads.

---

## 4. Relationship to `@ospex/sdk`

The MM depends on `@ospex/sdk` and nothing else from the Ospex side. It does **not** depend on `@ospex/cli` — the CLI is a separate operator tool (useful, e.g., as a manual counterparty when testing a maker against itself or a friend). `KeystoreSigner` comes from the `@ospex/sdk/signers/keystore` subpath (which pulls `ethers` — acceptable; the MM must sign).

**Dependency installation.** The MM pins `@ospex/sdk` to an *exact* version (a money-moving bot must not float SDK behaviour):

- **Preferred (now):** the exact GitHub Release tarball URL — e.g. `"@ospex/sdk": "https://github.com/ospex-org/ospex-sdk/releases/download/v0.1.0/ospex-sdk-0.1.0.tgz"`. Matches the SDK's distribution direction (Releases first; npm maybe later).
- **Later / optional:** npm, *if* Ospex adds it as a secondary channel — still pinned to an exact version, never a caret range.
- **Fallback:** a `vendor/` directory plus a `scripts/fetch-sdk` step documented in the README — only if neither of the above is available.
- **Never:** commit the SDK tarball into this repo.

The MM inherits the SDK's contracts wholesale: typed errors with the documented retryability semantics; the `--json` / `schemaVersion` envelope discipline; the BYO wallet + RPC posture; the vocabulary (`Contest`, `Speculation`, `Position`, `Commitment`, `MarketType`; position types translated to the actual side — never expose "upper" / "lower"). It also uses the SDK's submit preview (`speculation` mode) to detect lazy-creation paths and refuse them (§6).

---

## 5. Pricing model

Pipeline (per market type; the moneyline strategy implements it for v0). Ported in spirit from a prior math sketch, rewritten in TypeScript, pluggable per market under `pricing/strategies/`.

**Step 1 — Strip the consensus vig.** Reference implied probabilities sum to slightly more than 1; the excess is the consensus overround. Normalize proportionally → fair probabilities. (Proportional normalization is the v0 method; Shin / power / log-odds corrections for favorite–longshot bias are a documented future option.)

**Step 2 — Derive the quoting spread.** Two modes; the config picks one.

- **`economics` mode — the approachable path.** The operator says: how much capital (`capitalUSDC`), what return they want (`targetMonthlyReturnPct`), over what horizon (`daysHorizon`), roughly how many games / day in their configured sports (`estGamesPerDay`). The math estimates expected monthly *filled* volume from the per-quote cap × games/day × an assumed fill rate × days, then solves for the spread that would hit the target return on a balanced book: `targetSpread = targetReturn / (expectedMonthlyFilledVolume / 2)`. **It refuses to start** if `targetSpread` exceeds `maxReasonableSpread` (config; ~5% is the realistic upper bound for a competitive market) *or* exceeds the consensus overround (you can't quote inside the market and still extract that margin) — naming exactly which input to change. This refusal is the central safety feature for non-quant operators.
- **`direct` mode — the "I know what I want" path.** The operator gives `spreadBps` directly; the math uses it as the embedded spread (still subject to the consensus-overround check).

**Step 3 — Build quote prices.** Split the spread across the two sides (symmetric in v0: `quoteProb = fairProb + spread/2` each — asymmetric / inventory-skew is future work). Refuse the market if a quote probability hits 1 (pathological — only on extremely lopsided lines).

**Step 4 — To ticks.** Convert quote probabilities → decimal odds → uint16 ticks via the SDK's tick helpers, validating the tick bounds (`MIN_ODDS = 101` … `MAX_ODDS = 10100`) and that the risk amount is a multiple of `ODDS_SCALE = 100` (USDC 6-dp). Out-of-bounds → refuse the market.

**Step 5 — Size.** Each side = `min(perQuoteCap, exposureHeadroom_on_that_side)` where headroom comes from the worst-case-by-outcome accounting in §6 (which already counts the maker's latent quotes). If one side is at its cap and the other isn't, optionally upsize the open side (bounded by its own headroom) to encourage rebalancing flow. If both are capped, don't quote.

**Markets in v0.** Operator-facing config accepts `markets: ["moneyline"]` only. `spread` / `total` are *rejected by config validation* with a clear "not yet implemented in this version" message. The strategy stubs exist so contributors can build them; wiring `"spread"` into the accepted set is part of shipping that strategy.

### The zero-vig-at-settlement caveat — flagged loudly

Ospex matched-pairs has **no protocol-level vig**. At settlement, each side receives `1.0 + (counterparty stake ÷ own stake)` in decimal terms — the protocol takes no rake. The "spread" the maker embeds in a quote is the *price it offers to provide liquidity*, not a cut. The "balanced book ⇒ profit ≈ spread × per-side volume" model is a **first-order approximation**: reasonable when fills land roughly evenly on both sides, but imbalanced fills turn the maker into a directional bettor — a different risk profile (and, for some MMs, where most of the P&L comes from). v0 uses the approximation; the docs and the run summary state that it *is* one. A treatment that models matched-pair settlement directly is future work, not a v0 blocker.

### Flagged free parameters (each is invented; revisit with production data)

`fillRateAssumption` (~0.30 — **the first to replace** with measured data) · `capitalTurnoverPerDay` (~1.0) · `maxPerQuotePctOfCapital` (~5%) · `maxReasonableSpread` (~5%) · symmetric spread split · balanced-book P&L assumption.

---

## 6. Risk model

### Exposure is worst-case USDC loss by outcome — over filled positions, visible quotes, *and* latent quotes

An off-chain cancel pulls a quote from the API but does **not** invalidate the signed `OspexCommitment` — a taker who holds it can still match it on chain until the commitment **expires**, is **filled**, is **cancelled on-chain** (`cancelCommitment`), or is **invalidated by a nonce-floor raise** (`raiseMinNonce`). So a pulled quote is *latent* matchable exposure, not gone.

For moneyline, a *filled* position on side X loses the maker's stake (`riskAmount`) if X loses; an *open or latent* commitment on side X, if matched before the next tick, exposes the maker to that same `riskAmount` loss if X loses. The risk engine computes, per contest, the worst-case loss in each outcome bucket:

- `lossIf(homeWins)` = Σ over the maker's **away-side** items of the at-risk USDC for each (those lose when home wins): positions (their `riskAmount`), `visibleOpen` commitments (full `riskAmount`), `softCancelled`-but-not-yet-expired/invalidated commitments (full `riskAmount`).
- `lossIf(awayWins)` = the symmetric sum on the **home** side.
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

When spread / total strategies land, each defines its own outcome-bucket loss function (the *position* still has a fixed worst-case loss = the staked `riskAmount`, so the bucket accounting generalizes). The **risk engine** is a pure function returning `{ allowed: true, sizeUSDC }` (clamped to headroom) or `{ allowed: false, reason }`; every refusal is a telemetry event; the loop cannot submit without an `allowed` verdict.

### Expiry bounds the latent-exposure window

Because an off-chain cancel doesn't invalidate a signed quote, the **expiry** is what determines how long a pulled quote stays a risk. The v0 **recommended live default is `expiryMode: fixed-seconds` with a short `expirySeconds` (~120 s)** — a pulled quote stops being matchable within ~2 minutes, and the MM rolls fresh quotes forward (`staleAfterSeconds` < `expirySeconds`, so the MM pulls-and-reposts before the old one lapses; the old, soft-cancelled one then expires shortly after). Configure `staleAfterSeconds` / `expirySeconds` so the overlap (one soft-cancelled-not-yet-expired generation + one visible generation) stays within your per-side caps — or accept a brief gap between generations; the risk engine enforces the cap regardless. `expiryMode: match-time` (expiry = game start) is available but **dangerous with off-chain cancel** — a pulled quote stays matchable for hours; only use it if you replace via *on-chain* cancel or periodic nonce-floor raises (which cost gas), or you explicitly accept that latent exposure. The example config ships `fixed-seconds`.

### v0 quotes only existing open speculations — no lazy creation

The SDK's high-level submit can resolve a commitment to a *lazy-creation* path: if no open speculation exists for `(contestId, scorer, lineTicks)`, a posted commitment lazily creates the speculation when first matched — and the maker's share of the creation fee is due via a **`TreasuryModule`** allowance on that first match. v0 sidesteps this entirely: discovery only tracks markets that already have an open speculation, and before posting, the MM checks the SDK submit preview — if it reports a lazy-creation path, the MM refuses (`skip-reason: would-create-lazy-speculation`). Consequences: the only USDC approval the MM ever needs is to `PositionModule`; `maxDailyFeeUSDC: "0"` is genuinely accurate; there is no `TreasuryModule` allowance, no creation-fee budgeting, no per-speculation-key fee tracking. Supporting lazy creation (all of the above) is a documented post-v0 option — for now the MM provides liquidity *on* existing speculations rather than seeding new ones. (In the multi-agent fishbowl, something else seeds the first commitment on each speculation.)

### Approvals — an aggregate absolute allowance, not a per-quote shortfall

`approve(x)` *sets* the ERC-20 allowance to `x` — it does not add. So `approvals.mode: exact` does **not** mean "approve the next quote's shortfall"; it means **set `PositionModule`'s allowance to the maximum aggregate matchable risk the configured caps could ever require** — a finite, computable number: `min( maxOpenCommitments × maxRiskPerCommitmentUSDC, maxBankrollUtilizationPct × bankrollUSDC, wallet USDC balance )` — set once (at startup if `autoApprove`), re-set only if one of those bounds changes. (Setting it to the *current* aggregate need and re-approving as it grows also works but burns gas on every quote — pre-approving the cap ceiling is cheaper and is the v0 behaviour.) Either way the allowance is a finite number, never `MaxUint256`. `approvals.mode: unlimited` sets `MaxUint256` — requires the config setting *and* CLI confirmation (`--yes`); discouraged. Never approves in dry-run. The `approval` telemetry event carries `purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`. The MM needs `PositionModule` allowance only — no `TreasuryModule` (no lazy creation), no LINK (no oracle/contest creation).

### Gas — what actually spends POL, and the exhaustion policy

POL gas is spent **only** on: `approve` (ERC-20), on-chain `cancelCommitment`, nonce-floor raises (`raiseMinNonce`), `settleSpeculation`, `claimPosition`. **Posting a commitment (`commitments.submit`) and routine off-chain cancels are EIP-712 signing + an API call — no gas.** Budget: `gas.maxDailyGasPOL` (in POL — what's actually spent), `gas.emergencyReservePOL` held back. Optional USDC-equivalent reporting via an operator-supplied `gas.nativeTokenUSDCPrice` (best-effort; no on-chain POL/USD oracle in the SDK yet — a future enhancement could make this automatic). Polygon gas is tiny, so the example budget is small.

**When the daily gas budget (`gas.maxDailyGasPOL`) is reached:**
- **Keep posting commitments** as long as no re-`approve` is needed (aggregate matchable risk stays within the current `PositionModule` allowance) — posting is gasless. If a new quote *would* require a re-approval and the budget (minus reserve) is exhausted, refuse it (`skip-reason: gas-budget-blocks-reapproval`). (Pre-approving the cap ceiling at startup means this rarely bites.)
- **Keep doing off-chain cancels** — pulling stale or mispriced quotes from the API is gasless and always allowed; pulled quotes then expire on their own (≤ `expirySeconds`).
- **On-chain `cancelCommitment` / nonce-floor raises / `settleSpeculation` / `claimPosition`** draw on `gas.emergencyReservePOL` (settle/claim only if `settlement.continueOnGasBudgetExhausted`). Settlement and claim need only gas (no LINK, no protocol fee), so the reserve covers them.
- The kill switch's off-chain part is never gas-gated; its on-chain part (if `killCancelOnChain`) uses the reserve.
- Keep enough POL in the wallet (budget + reserve) that the MM can always claim its winnings; `ospex-mm doctor` / `status` flag a low POL balance.

### Kill switch

Mechanism: the presence of a file at `killSwitchFile` (config; default `./KILL`), checked at the top of every tick. Tripped → pull all visible quotes off-chain; if `killCancelOnChain`, also raise the on-chain nonce floor per speculation (uses the reserve); flush state + telemetry; exit `0`. SIGTERM / SIGINT do the same (graceful). **`killCancelOnChain: false` (the default) is a *soft* stop** — pulled quotes stay matchable until they expire (≤ `expirySeconds` with the recommended mode; until game start with `match-time`); set it to `true` for a hard, gas-spending stop. Documented in the README.

---

## 7. Config schema

A YAML file (`--config <path>`, default `./ospex-mm.yaml`), validated at boot — invalid or missing required values → exit `1` with a message naming the problem. Env vars override individual fields (`OSPEX_KEYSTORE_PATH`, `OSPEX_RPC_URL`, `OSPEX_API_URL`, `OSPEX_CHAIN_ID`, plus `OSPEX_MM_*`). The repo ships `ospex-mm.example.yaml` — the MLB + moneyline starter config below, conservative caps, `dryRun: true`, short `fixed-seconds` expiry — which doubles as the onboarding doc. A novice typically touches only `wallet`, `rpcUrl`, `pricing.economics`, and maybe `risk`.

```yaml
# ospex-mm.example.yaml — annotated reference config (v0)

wallet:
  keystorePath: ~/.foundry/keystores/ospex-mm   # Foundry v3 keystore; prompts for passphrase on sign.
                                                 # (Or set OSPEX_KEYSTORE_PATH instead.)

rpcUrl: ""            # REQUIRED. Alchemy / Infura / QuickNode URL for the chain. No public-RPC default.
apiUrl: ""            # Optional. Defaults to the production Ospex core API URL.
chainId: 137          # 137 = Polygon mainnet, 80002 = Amoy testnet.

marketSelection:
  sports: ["mlb"]                  # any of: mlb, nba, nhl, ncaab, ncaaf, nfl (config-driven; add more freely)
  markets: ["moneyline"]           # v0 supports only "moneyline"; "spread"/"total" are REJECTED by config validation.
  maxStartsWithinHours: 24         # only quote games starting within this window
  maxTrackedContests: 30           # hard cap on contests tracked at once (bounds odds subscriptions)
  requireReferenceOdds: true       # skip games with no upstream odds linkage
  requireOpenSpeculation: true     # v0: only quote markets whose speculation already exists (no lazy creation)
  contestAllowList: []             # optional: if non-empty, ONLY these contestIds
  contestDenyList: []              # optional: never these contestIds

discovery:
  everyNTicks: 10                  # run discovery every N ticks (10 * 30s = ~5 min)
  jitterPct: 0.2                   # +/- jitter on the discovery interval

odds:
  subscribe: true                  # subscription-first: stream reference-odds changes. Strongly preferred.
                                   #   false = degraded fallback to bounded snapshot polling (restricted nets only).
  maxRealtimeChannels: 60          # hard cap on open Realtime channels (~ maxTrackedContests * markets)

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
  mode: exact                       # "exact" = set PositionModule allowance to the aggregate cap ceiling (see DESIGN §6).
                                    #   "unlimited" = MaxUint256 (requires --yes). Discouraged.

orders:
  expiryMode: fixed-seconds         # RECOMMENDED. "fixed-seconds" = short expiry, MM rolls quotes forward.
                                    #   "match-time" (expire at game start) is available but DANGEROUS with off-chain
                                    #   cancel — a pulled quote stays matchable for hours. See DESIGN §6.
  expirySeconds: 120                # used when expiryMode: fixed-seconds. Short bounds latent exposure; tunable.
  staleAfterSeconds: 90             # pull-and-repost a quote this old (< expirySeconds, so it never just lapses)
  staleReferenceAfterSeconds: 300   # treat reference odds as stale (pull quotes, don't repost) if nothing heard this long
  replaceOnOddsMoveBps: 50          # pull-and-repost when fair value moves more than this since posting
  cancelMode: offchain              # routine cancels: "offchain" (gasless, soft — see DESIGN §6) or "onchain" (authoritative, gas)

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

pollIntervalMs: 30000               # enforced floor 30000 (see DESIGN §7); paces discovery + fill detection, not odds

mode:
  dryRun: true                      # MASTER SAFETY FLAG. true = compute everything, post nothing.
                                    #   Live requires dryRun: false AND the --live flag (see DESIGN §8).
```

`pollIntervalMs` floor: **30 000 ms minimum** (default 30 000). The loop logs and clamps if config goes lower. Tunable upward freely.

---

## 8. Dry-run vs live

**Dry-run** (`mode.dryRun: true`, the default) — the loop does **everything except** the writes (`commitments.submit` / off-chain cancel / on-chain cancel / nonce-floor raise / settle / claim / approve). Instead it logs `would-submit` / `would-soft-cancel` / `would-replace` events with the exact payloads. It still discovers, prices, checks the SDK submit preview (so a lazy-creation refusal surfaces in dry-run), **runs the risk engine** (cap violations surface, including against a *hypothetical* latent-exposure bucket), tracks a hypothetical inventory, and measures **quote competitiveness** — for each would-be quote, whether it sits at or inside the visible orderbook on its side, and how it compares to the reference odds.

**Competitiveness reads are bounded** — only for markets the MM would actually quote (passed the risk engine), only when the market is dirty or newly tracked (not every tick, every contest), with a capped orderbook page size; on failure / rate-limit the MM logs `competitiveness-unavailable` and moves on — never a retry-loop; it can be sampled every N dirty-cycles if even that proves heavy.

It does **not** claim a fill rate. Ospex is not a central limit order book that auto-crosses two posted commitments — a taker must *intentionally* match a specific signed commitment — so "would this have filled?" is unanswerable without simulating taker behaviour, which is the job of the separate test harness (outside this repo) that consumes the NDJSON log. A real fill rate is a live-mode metric (or an external-harness metric derived from the log).

**Going live — the two-key model.** Live requires *both* `mode.dryRun: false` in the config *and* the `--live` flag. With only one, the MM runs dry and logs a clear message (`refusing to run live: config has dryRun=false but --live was not passed` / `refusing to run live: --live passed but config has dryRun=true`). `--dry-run` always forces dry-run regardless of config. Neither a stray config edit nor a stray flag can put real money on the table. Recommended flow: run dry-run for a meaningful window, read the would-be-stale rate, the competitiveness numbers, the latent-exposure peak, and the skip reasons — *then* set `mode.dryRun: false` and add `--live`.

---

## 9. Order lifecycle

Each posted commitment is tracked **by hash** in a state: `visibleOpen` (API-visible, matchable) → one of `softCancelled` (pulled from the API, *still matchable on chain* until expiry/on-chain-cancel/nonce-raise), `partiallyFilled`/`filled`, `expired`, or `authoritativelyInvalidated` (on-chain `cancelCommitment` or nonce-floor raise landed). Only the last three release exposure headroom; `softCancelled` does not (§6).

- **Lazy-speculation check.** Before posting, the MM verifies an open speculation exists for `(contestId, scorer, lineTicks)` (discovery already pre-filters; the SDK submit preview's `speculation` mode is the authoritative signal). If the commitment would lazily create a speculation → refuse (`skip-reason: would-create-lazy-speculation`). v0 never seeds speculations.
- **Stale / mispriced quotes.** A `visibleOpen` commitment older than `orders.staleAfterSeconds`, or whose fair value has moved more than `orders.replaceOnOddsMoveBps` since posting → the MM **pulls it off-chain** (→ `softCancelled`) and **posts a fresh quote** at the current price. The old (soft-cancelled) quote stays in the latent-exposure bucket until it `expires` (≤ `expirySeconds` with the recommended `fixed-seconds` mode). The MM does **not** routinely on-chain-cancel for staleness/replace (gas); it *does* for the kill switch (`killCancelOnChain`) and `cancel-stale --authoritative`.
- **The book-hygiene invariant.** The MM never *intentionally surfaces* more than one active quote per `(speculation, side)` through the API / orderbook: before submitting, it reconciles its intended book against its actual open commitments (`client.commitments.list({ maker })`). It may, transiently, hold one `visibleOpen` plus one (or more) `softCancelled`-not-yet-expired generations per side — that's expected with rolling expiry, and all of them count in the latent-exposure bucket — but the *visible* surface has ≤ 1 per `(speculation, side)`.
- **Fills.** Every tick: `client.commitments.list({ maker, status: open,partially_filled })` (≤ `maxOpenCommitments` rows); diff against last tick's `visibleOpen` hash set; look up by hash the few that disappeared (→ `filled` / `cancelled` / `expired`) and reclassify. On a fill: move the filled risk from open/latent to a filled position (per the §6 counting rule); recompute P&L (realized = settled positions, unrealized = open positions marked to current fair); **immediately re-price or pull the opposite side** of that market. Log a `fill` event. Fill-detection latency is bounded by `pollIntervalMs` until the Realtime fills channel lands (§10).
- **Expiry.** `fixed-seconds` (recommended) → expiry = `now + expirySeconds`; the loop rolls quotes forward and ages out expired ones each tick. `match-time` → expiry = the contest's `matchTime` (never quote a game that's already started) — but then a soft-cancelled quote stays matchable for hours; bound it via on-chain cancels / nonce-floor raises (gas) or accept it. An expired commitment is dead on chain and releases its headroom; the loop reclassifies it `expired`.

---

## 10. Data ingestion — subscription-first

The MM is **subscription-first wherever the SDK supports it**, deliberately, to keep load off the public API and Supabase:

- **Reference odds — push, now.** `client.odds.subscribe({ <the SDK's reference-game-id field>, market }, handlers)` — the `src/ospex/` adapter maps the MM's neutral `referenceGameId` to that field — opens a Supabase Realtime channel per tracked game / market; `onChange` flags the market dirty for re-pricing, `onRefresh` updates the freshness timestamp. The initial value (and `ospex-mm quote --dry-run`) uses a one-shot `client.odds.snapshot(contestId)`. Games with no upstream linkage (snapshot all-null) are skipped (`no-reference-odds`). If `odds.subscribe: false` — a degraded mode for environments where Realtime is blocked — the MM falls back to bounded snapshot polling at `pollIntervalMs`; subscription is the default and is strongly preferred.

  **Realtime lifecycle guardrails (required):**
  - **Startup snapshot first, then subscribe** — never act on a subscription before seeding a known-good snapshot.
  - **Caps:** at most `marketSelection.maxTrackedContests` contests and `odds.maxRealtimeChannels` channels. Discovery refuses to track more — logs `tracking-cap-reached` and moves on.
  - **Unsubscribe** when a contest leaves the start window or its game starts — channels don't leak.
  - **Reconnect:** exponential backoff with jitter; never a tight reconnect loop. The SDK/Supabase client manages reconnect; the MM watches for it not recovering within a backoff window.
  - **Channel error / unrecoverable disconnect** → mark that market **degraded**: pull its visible quotes (off-chain), treat its reference as stale, keep retrying with backoff. (The pulled quotes are now latent — they expire on their own.)
  - **Dirty-event coalescing** — a burst of `onChange`s on one market → *one* reconcile on the next tick, not a write per event.
  - **Bootstrap retry** — the SDK fetches `/v1/config/public` lazily on the first subscribe; if it fails, retry with backoff (the SDK resets its promise so the next call retries) — never tight-loop.

- **Fills / positions — bounded, now; push, fast-follow.** Today: `client.commitments.list({ maker, status: ['open','partially_filled'], limit: maxOpenCommitments + buffer })` — explicit statuses and limit, bounded by `maxOpenCommitments` — plus a by-hash lookup of the few *tracked* commitments that disappeared from that list since last tick (→ `filled` / `cancelled` / `expired`), plus `client.positions.status(address)` periodically for the settlement view. **Note:** `client.positions.byAddress(address)` is not currently paginated / `since`-filtered in the SDK, so the hot loop avoids it (it's used on boot to reconcile state). A push path — a filtered Realtime channel on the `commitments` (+ `positions`) tables in the indexer's database, plus `client.commitments.subscribe` / `client.positions.subscribe` on the SDK — is a **committed cross-repo fast-follow** (indexer migration + SDK methods + MM wiring), sequenced **after** the Phase 3 live micro-maker and **before** scaling to the multi-agent fishbowl.

- **Contest discovery — slow bounded poll, now; push, later.** `client.contests.list` (then `client.speculations.list` to confirm an open speculation exists) every `discovery.everyNTicks` ticks (~5 min) with jitter — new contests appear a few times a day. Could become push when `contests` / `speculations` gain Realtime publications (a planned indexer + SDK item, lower priority).

---

## 11. Telemetry & the run summary

**Event log.** NDJSON, one file per run (or rotated daily) under `telemetry.logDir`. Every line: `{ ts, runId, kind, ...payload }`. `kind` ∈ `tick-start`, `candidate` (a contest considered; carries `skipReason` if skipped — values include `no-reference-odds`, `no-open-speculation`, `would-create-lazy-speculation`, `stale-reference`, `start-too-soon`, `cap-hit`, `refused-pricing`, `tracking-cap-reached`, `gas-budget-blocks-reapproval`), `fair-value`, `risk-verdict` (allowed + size or refused + reason), `quote-intent`, `quote-competitiveness`, `competitiveness-unavailable`, `submit` / `would-submit`, `soft-cancel` / `would-soft-cancel`, `replace` / `would-replace`, `onchain-cancel`, `nonce-floor-raise`, `expire` (a tracked commitment hit expiry → headroom released), `approval` (`purpose`, `spender`, `currentAllowance`, `requiredAggregateAllowance`, `amountSetTo`), `fill`, `settle`, `claim`, `degraded` (a market's odds channel errored), `error` (class + detail), `kill`. Values that can exceed `Number.MAX_SAFE_INTEGER` (risk in wei6, block numbers) are strings — same convention as the SDK's AGENT_CONTRACT. **This NDJSON shape is the stable contract** the future external scorecard reads; the MM does not change it lightly.

**Run summary.** `ospex-mm summary [--since <ts>] [--json]` reads the log(s) and emits the metrics in §2.3 (including the latent-exposure peak). `--json` → a single `schemaVersion`-stamped envelope (SDK-style). This is the MM's *own* report; the cross-agent platform-viability scorecard is the harness's job and consumes the same NDJSON.

---

## 12. State persistence

A small set of JSON files under `state.dir`: each posted commitment by hash with its current state (`visibleOpen` / `softCancelled` / `partiallyFilled` / `filled` / `expired` / `authoritativelyInvalidated`) and expiry; the resulting positions; running P&L; daily POL-gas and fee counters (keyed by date). Atomic writes (temp + rename). **The `softCancelled` set is the one piece of state not reconstructible from chain/API** — a DELETE removes a quote from the API but not from on-chain validity — so it's persisted and reloaded; if the state file is lost, the MM under-counts latent exposure until those quotes expire (keep `expirySeconds` short). **JSON state is not multi-process safe — one MM per state directory.** On boot, the loop loads state and reconciles the rest against on-chain / API reality (`client.commitments.list({ maker })`, `client.positions.byAddress`) — chain is truth; the local state is a (mostly) rebuildable cache, plus the soft-cancelled set. **Boot-time state-loss fail-safe:** if the persisted `softCancelled` set is missing or corrupt after a prior run, the MM does **not** resume quoting on a blank slate — that would under-count latent matchable exposure (a prior soft-cancelled quote could still be matchable on chain). It first tries to reconstruct the set by replaying recent telemetry; failing that, it waits one full `expirySeconds` window (long enough for any prior soft-cancelled quote to have expired) before posting; or the operator passes an explicit override (e.g. `--ignore-missing-state`, used only when you know no prior run left open commitments). SQLite is overkill for v0's data volume; JSON also keeps the state human-inspectable. Revisit if it grows.

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
- **Phase 2 — shadow mode.** `ospex-mm run --dry-run` runs for hours without crashing; produces quote decisions; rejects bad / ambiguous / stale data and lazy-creation paths with logged reasons; obeys every cap including latent exposure (verified with deliberately tight caps); explains each quote and each skip; tracks would-be-stale rate, quote competitiveness, and latent-exposure peak; honours the Realtime guardrails (subscription caps, backoff, coalescing, degraded-on-error).
- **Phase 3 — live micro-maker.** `ospex-mm run --live` (config `mode.dryRun: false` AND the `--live` flag) with tiny budgets posts commitments on existing open speculations only; rolls short-expiry quotes forward; pulls + reposts on staleness / odds move; off-chain cancels keep working when the gas budget is hit; tracks latent exposure and never exceeds caps; sets the `PositionModule` allowance to the aggregate cap ceiling (never unlimited); refuses lazy-creation commitments; gets matched by a manual CLI taker (a second Foundry keystore + the `ospex` CLI); auto-settles / claims its own positions if configured; produces a clean run log and a coherent `summary`.
- **Phase 4 — public-ready.** A fresh clone + `ospex-mm.example.yaml` + a funded Foundry keystore + an RPC URL → a working dry-run in under ten minutes following only the README / QUICKSTART. CI green (install / build / typecheck / test). MIT license + the README / `OPERATOR_SAFETY.md` disclaimers in place. The "what a real MM would do differently" notes ported into `docs/`.

After Phase 3, before the multi-agent fishbowl: the Realtime-fills cross-repo fast-follow (§10). The spread / total strategies and lazy-speculation support are post-v0 work, tracked separately.

---

## 15. Out of scope for v0 — the "what a real MM does differently" list (plus v0 deliberate limits)

Asymmetric spread split / inventory-aware price skew (Avellaneda–Stoikov-style) · measured fill-rate model (per sport / time-to-tip / price-competitiveness) · probabilistic fair value · cross-venue hedging · latency-aware quoting beyond the odds subscription · alternative vig-stripping methods (Shin / power / log-odds) · multi-host nonce coordination (v0 is single-process) · **spread & total strategies *validated*** (the architecture slots them; moneyline ships first) · **lazy speculation creation** — auto-seeding new speculations + `TreasuryModule` creation-fee approvals/budgeting; v0 only quotes existing open speculations. The Realtime fills / positions channel is *not* in this list — it's a committed cross-repo fast-follow (§10), sequenced after Phase 3.

---

## 16. The firewall — what does NOT live in this repo

Flow / taker agents, observer / settlement agents, and cross-agent scorecards are **not** part of this repo, ever. They exist only to *exercise* a market maker and *prove the Ospex platform* (a lone maker with no takers proves nothing) — evidence-gathering apparatus, not the product. The test harness, when it's built, is a **separate repository** (location TBD; built once the MM is far enough along to be worth exercising). Through the live-micro-maker phase, the `ospex` CLI from a second wallet covers manual taker / observer testing — no harness needed yet.

**Provider-name hygiene.** No specific upstream odds-provider names appear in any user-facing surface — committed docs (including this one), README, code comments, CLI output, JSON telemetry payloads, configs, examples. The SDK's provider-specific *wire-field* names appear *only* inside the `src/ospex/` adapter, which maps them to the MM's neutral terms (`referenceGameId` / `upstreamGameId`); everything outside that adapter uses the neutral terms. Public-facing language is "upstream / reference odds surfaced by the Ospex SDK".

**Local-only operational notes** (deployment specifics, monitoring wiring, scratch configs) belong in a **gitignored `internal/` directory** — never in this tree or any committed file.

What *is* in this repo: the MM's own single-agent run summary (its P&L, fill rate, gas, stale-quote incidents, latent-exposure peak — operators running solo want it). The link to the harness: the NDJSON event log (§11) is shaped so the external scorecard can consume it with no changes to the MM.

---

## 17. Open questions

**Resolved across the review rounds:** license (MIT) · subscription-first ingestion (odds push + lifecycle guardrails; bounded own-state fill detection; cross-repo Realtime fills fast-follow after Phase 3) · gas (POL-denominated; spent only on approve / on-chain-cancel / nonce-raise / settle / claim; budget exhaustion blocks re-approvals + authoritative invalidation, not gasless posting/off-chain-cancel) · latent matchable exposure (a tracked category; caps bind it; off-chain cancel doesn't free headroom; the soft-cancelled set is persisted) · default expiry (`fixed-seconds` ~120 s; `match-time` available with a warning) · lazy-speculation policy (v0 refuses lazy-creation commitments; quotes only existing open speculations) · approvals (`exact` = aggregate cap-ceiling absolute allowance; `unlimited` only on opt-in + `--yes`) · bounded fill detection (hash-tracking + `positions.status`; avoid unbounded `byAddress` in the hot loop) · dry-run reports quote competitiveness, not a fill rate · competitiveness-read bounds · partial-fill accounting (no double-count) · settlement ≠ oracle/scoring · state store (JSON, single-process) · `pollIntervalMs` floor (30 s) · discovery cadence (~10 ticks, jittered, subscriptions capped) · default caps (the conservative starter profile in §7) · SDK install (exact GitHub Release tarball) · provider-name self-reference removed from this doc · v0 markets = moneyline only.

**Still open (maintainer calls, not design questions):**

1. **Confirm the short-`fixed-seconds` expiry default** (vs `match-time`) — recommended for the latent-exposure reason; flag if you'd rather default the other way.
2. **Sequencing the Realtime-fills cross-repo work** — design places it after Phase 3 / before the fishbowl; lead order indexer migration → SDK `subscribe` methods → MM wiring. Confirm against the broader roadmap.
3. **Proceed to scaffold now, or one more confirming review of this revision?** The review's stated path was "patch the doc for the listed items, then proceed to scaffold" — so this revision should be clear to go to Phase 1.
