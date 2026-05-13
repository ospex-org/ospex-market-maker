# ospex-market-maker

A **reference market maker** for [Ospex](https://ospex.org) — a zero-vig peer-to-peer sports prediction protocol on Polygon. Clone it, point it at your wallet, bankroll, RPC URL, and return target, and it quotes two-sided liquidity on upcoming contests, manages its exposure, reacts to fills, settles and claims, and writes an auditable record of everything it did.

It is built on **[`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk)** — every chain and API interaction goes through the SDK; this repo never calls the Ospex contracts directly.

---

> ## ⚠️ Status — v0 scaffold
>
> This repo is in active development. The full design is in **[`docs/DESIGN.md`](docs/DESIGN.md)** — the command surface, config schema, pricing model, risk model, and lifecycle are specified there; the implementation is landing incrementally (Phase 1 = read-only core; Phase 2 = dry-run/shadow loop; Phase 3 = live micro-maker; Phase 4 = public polish). **Do not run this against real funds yet.**

---

## Current scaffold status

What works (Phase 1 read-only core + the Phase-2 dry-run shadow loop + the first slices of Phase-3 live execution — see *What's not implemented yet* for the live-mode gaps):

- `yarn install && yarn build && yarn typecheck && yarn lint && yarn test` — clean (309 unit tests across the pricing, config, risk, orders, state, telemetry, ospex-adapter, runner, and CLI-command modules).
- **`ospex-mm doctor`** — readiness probe: config, keystore, API, RPC, POL/USDC balances, `PositionModule` allowance, and the persisted-state integrity check, plus a "Ready to" matrix (dry-run shadow — needs no keystore, since the shadow loop posts nothing / post commitments — the live prereqs). `--address <0x…>` keeps it fully read-only (no passphrase prompt); `--json` emits a `{ schemaVersion: 1, doctor: … }` envelope.
- **`ospex-mm quote --dry-run <contestId>`** — computes a two-sided moneyline quote breakdown (reference odds → fair value → spread → priced quote with size), or refuses with a clear message (contest closed, no open moneyline speculation, no reference odds). Never posts; `--json` emits a `{ schemaVersion: 1, quote: … }` envelope.
- **`ospex-mm run --dry-run`** — the shadow loop: boots through the state-loss fail-safe, then runs the tick loop — discovery → reference-odds tracking → the per-market reconcile → age-out → state flush — until a kill-switch file appears or a SIGTERM / SIGINT arrives; logs `quote-intent` / `quote-competitiveness` / `would-submit` / `would-replace` / `would-soft-cancel` / `candidate` / `expire` / `degraded` / `error` / `kill` events to the NDJSON log under `telemetry.logDir`, and mutates a *hypothetical* inventory — but **posts nothing on chain**. `--address` / `--keystore` (overrides the configured path) / `--ignore-missing-state` (attests no prior run left a still-matchable commitment — lifts the boot-time hold).
- **`ospex-mm run --live`** — the same loop, with the reconcile's submits going through `commitments.submitRaw` and the off-chain cancels through `commitments.cancel` (the protocol tuple comes from `toProtocolQuote`; nonce auto-picked; the short fixed-seconds / match-time `expiry` is passed explicitly). Gated by the two-key model (DESIGN §8): requires *both* `mode.dryRun: false` in the config *and* the `--live` flag; otherwise refused with a clear message. Reads the keystore passphrase from `OSPEX_KEYSTORE_PASSPHRASE` (preferred for non-interactive runs), else prompts no-echo on a TTY. The signer's address determines the maker wallet — `--address` with `--live` is refused. The Runner ctor also refuses to boot live on a state directory containing dry-run synthetic commitments (use a fresh `state.dir` for live). Events log as `submit` / `replace` / `soft-cancel` (instead of the `would-*` counterparts), carrying the real commitment hashes. **Fill detection** (DESIGN §10) runs each tick before the reconcile: `listOpenCommitments(maker)` is diffed against the local visibleOpen / partiallyFilled set (including past-local-expiry records, so a fill landing right before expiry isn't missed by `ageOut`'s clock-only terminalization), disappeared hashes are classified via `getCommitment(hash)` with any unobserved fill delta applied *first* (a commitment can have partially filled and then expired / been cancelled between polls), and partial-fill bumps are detected on still-listed commitments; the affected market is dirtied so the same tick re-prices the imbalance. **Fails closed**: if `listOpenCommitments` throws, the tick skips reconcile, the position poll, AND `ageOut` — the runner doesn't write or terminalize on unverified fill state, and the markets stay dirty for next-tick retry. A separate **position-status poll** (one `getPositionStatus(maker)` per tick, after fill detection) backfills `MakerPositionRecord`s the commitment-list diff can't see — a taker matching a soft-cancelled commitment via a stale signed payload before expiry shows up on the position side and gets recorded then — AND mirrors each polled position's API bucket (`active` / `pendingSettle` / `claimable`) into the local `MakerPositionStatus`, emitting a `position-transition` event on each forward step (`claimed` is stamped later by the auto-claim path). **Boot-time auto-approve** (`approvals.autoApprove: true`) reads the maker's `PositionModule` USDC allowance once before the first tick and brings it up to the aggregate cap ceiling if short (`mode: exact` — the safer default); `mode: unlimited` (`MaxUint256`) is gated by `--yes` on the CLI to keep it from being accidentally set. Emits `approval` `{purpose, spender, currentAllowance, requiredAggregateAllowance, amountSetTo, txHash, gasPolWei}`. Gas budgeting in POL, auto-settle / auto-claim, the on-chain kill path, P&L, and `cancel-stale` / `status` are still landing in later Phase-3 slices — start tiny, on testnet only, until those land.
- **`ospex-mm summary [--since <ts>] [--json]`** — aggregates the NDJSON event logs under `telemetry.logDir` into the §2.3 run metrics: ticks, the candidate / event-kind histograms, quote-intent counts, the would-be-submit / replace / soft-cancel / expire tallies, the quote-competitiveness rate (and the vs-reference tick spread), the quote-age distribution (p50 / p90 / max), the latent-exposure peak, stale-quote incidents, and the error counts — plus the run window, run-ids, and (a `kill` event if any) shutdown reason. `--since` windows it; `--json` emits a `{ schemaVersion: 1, summary: … }` envelope. (Live events — `submit` / `replace` / `soft-cancel` / `fill` / `position-transition` — show up in `eventCounts`; the derived live-mode metrics — fill rate, P&L, gas, fees, settlements — are intentionally absent: `summary.liveMetrics` is `null` until the dedicated live-mode aggregator lands later in Phase 3.)
- `yarn mm --help` — the command list. (`yarn dev --help` does the same via `tsx`; `yarn build && yarn link`, then `ospex-mm --help`, puts the binary on your PATH.)
- The **pricing module** (`src/pricing/` — vig stripping, the economics/direct spread modes with their refusal paths, odds-tick conversion + bounds, sizing). Pure functions, unit-tested. Used by `quote`.
- The **config loader** (`src/config/` — `loadConfig` / `parseConfig`: parse the YAML, validate with strict unknown-key rejection, apply the `OSPEX_*` env overrides, default almost everything to `ospex-mm.example.yaml`'s values).
- The **risk engine** (`src/risk/` — worst-case-loss-by-outcome exposure accounting over positions + visible + latent commitments; the per-commitment / contest / team / sport / bankroll caps; the headroom and verdict functions; the `PositionModule` aggregate-allowance target). Pure functions, unit-tested. Used by `quote` and `doctor`.
- The **order-planning layer** (`src/orders/` — `buildDesiredQuote` turns config + reference odds + exposure headroom into a two-sided quote, which is what `quote --dry-run` runs; `inventoryFromState` translates the persisted state into the risk engine's `Inventory`; `reconcileBook` decides what to submit / replace / soft-cancel against the maker's current book on a speculation, per DESIGN §9). Pure functions, unit-tested. The runner wires these into the loop; the same path executes the writes in live mode (`run --live`) and simulates them in dry-run.
- The **runner** (`src/runners/` — the `Runner` class: the tick loop, the boot-time state-loss fail-safe (DESIGN §12), the kill-switch (a `KILL` file or a SIGTERM / SIGINT → a graceful shutdown that emits `kill` and flushes), **discovery** (every `discovery.everyNTicks` ticks — jittered — find the verified contests with an open moneyline speculation + a reference-game id starting within `marketSelection.maxStartsWithinHours`, honour the allow/deny lists, track up to `marketSelection.maxTrackedContests` of them, untrack the departed; `candidate` telemetry for the skipped/tracked), **reference-odds tracking** (DESIGN §10's Realtime guardrails — by default a Supabase Realtime channel per tracked market: snapshot-first seed, then `onChange` keeps the market's odds + freshness + a `dirty` flag current, `onRefresh` keeps freshness current, `onError` degrades the market; capped at `odds.maxRealtimeChannels` with the rest left degraded and retried when a slot frees; `odds.subscribe: false` falls back to a bounded per-tick snapshot poll; a degraded market is re-subscribed on the next discovery cycle; `degraded` telemetry), the **per-market reconcile** (DESIGN §3/§8/§9 — for each market that needs it [its reference odds moved, or it lacks a fresh two-sided standing quote of ours, throttled to roughly one re-quote per `orders.staleAfterSeconds`], and *not* while the boot-time state-loss hold is active: the unquoteable-market gates [`start-too-soon` / `stale-reference` (incl. a degraded odds channel) / `no-reference-odds`, plus `no-open-speculation` after a `getSpeculation` re-check] — each *pulls* (soft-cancels) any visible quote of ours on that speculation, since the visible book must never carry a quote the MM is no longer pricing (DESIGN §2.2 / §3), and logs the skip — otherwise `buildDesiredQuote` over the hypothetical inventory `inventoryFromState` derives from the persisted state, `reconcileBook` against the maker's book on that speculation, and — in dry-run, the only mode in Phase 2 — log it [`quote-intent` + `would-submit` / `would-replace` / `would-soft-cancel` + a `cap-hit` candidate per deferred side] and mutate the hypothetical inventory [synthetic `visibleOpen` records for would-be submits / replacements, pulled / replaced ones reclassified `softCancelled` — still counted against caps until expiry], then assess quote competitiveness [DESIGN §8 — for each would-be quote: where its tick would sit vs the visible orderbook on its side (the `getSpeculation` already fetched that book — no extra read) and vs the reference odds; a `quote-competitiveness` event per side, or one `competitiveness-unavailable` if that orderbook somehow isn't populated]; a `dirty` market is reconciled even when its quotes are fresh, and an unquoteable market with quotes still up is reconciled to pull them; a transient `getSpeculation` failure leaves the market to retry promptly next tick rather than wait out the stale-after throttle), age-out of expired tracked commitments → `expired` + an `expire` event, a prune of old terminal (`expired` / `filled` / `authoritativelyInvalidated`) commitment records past `max(3600, 10×orders.expirySeconds)` so a long shadow run's state file stays bounded, the per-tick state flush, and an interruptible sleep clamped to the `pollIntervalMs` floor; the clock / sleep / kill-probe / signal / randomness seams — and the `OspexAdapter` itself (so `listContests` / `getContest` / `getOddsSnapshot` / `subscribeOdds` / `getSpeculation` can be faked) — are injectable, so it's unit-tested with bounded tick runs). The reconcile is **mode-aware**: under `--dry-run` it logs `would-*` events + mutates a hypothetical inventory; under `--live` (with the two-key match) it goes through `commitments.submitRaw` / `commitments.cancel` and records real commitment hashes. A failed live write logs `error` `phase:'submit'`/`'cancel'`, marks the market for prompt retry next tick, and never crashes the loop. **Fill detection** is wired in live mode (each tick before the reconcile — diffs `listOpenCommitments(maker)` against the local set, classifies disappeared hashes via `getCommitment`, detects partial bumps; **fails closed** — if `listOpenCommitments` throws, the tick skips the reconcile, position poll, AND `ageOut`, so the runner never writes or terminalizes on unverified fill state; markets stay dirty for next-tick retry). A **position-status poll** runs alongside (one aggregate `getPositionStatus(maker)` per tick), backfilling `MakerPositionRecord`s for fills the commitment-list diff can't see — a taker matching a soft-cancelled commitment via a stale signed payload before expiry — AND mirroring each polled position's API bucket (`active` / `pendingSettle` / `claimable`) into the local `MakerPositionStatus`, emitting `position-transition` events on each forward step. The on-chain authoritative cancel / `raiseMinNonce` paths, gas budgeting, settlement / claim, and P&L are Phase-3 work still ahead.
- The **`@ospex/sdk` adapter** (`src/ospex/` — the only module that imports `@ospex/sdk`; read-only wrappers over contests / speculations / commitments / positions / odds / balances / approvals / health; maps the SDK's provider-specific reference-game field to the neutral `referenceGameId` at this boundary). Used by `doctor` and `quote`.
- The **state store** (`src/state/` — persisted-inventory shape, atomic JSON writes, the boot-time state-loss fail-safe; `doctor` reads it for the integrity check) and the **telemetry layer** (`src/telemetry/` — the NDJSON event-log writer + the `kind` vocabulary, wired into `run`; plus `summarize` / `listRunLogs`, behind `ospex-mm summary`).
- The design (`docs/DESIGN.md`), the annotated config (`ospex-mm.example.yaml`), and the safety checklist (`docs/OPERATOR_SAFETY.md`).

What's **not** implemented yet (see `docs/DESIGN.md §14`):

- the on-chain authoritative-cancel and `raiseMinNonce` paths (for `cancel-stale --authoritative` and the kill switch's `killCancelOnChain: true`), gas budgeting in POL (daily POL counter + verdict gate — `approvals.autoApprove` is wired, but its `gasPolWei` doesn't yet feed a budget gate), auto-`settleSpeculation` / `claimPosition` / `claimAll` (the `claimed` terminal of `MakerPositionStatus` is stamped here, not by the poll), and P&L computation — the remaining Phase-3 slices.
- `cancel-stale` and `status` — still exit `not yet implemented` (Phase 3). (`summary`'s live-mode metrics — fill rate, P&L, gas, fees, settlements — also land in Phase 3, once those events exist.)

So: `doctor`, `quote --dry-run`, `run --dry-run` (the shadow loop), and `summary` are full-featured. `run --live` *executes* (submits + off-chain cancels + fill detection) — but with gas budgeting / settlement / on-chain kill still ahead, treat it as alpha. Don't run anything against real funds yet — testnet only.

---

## What this is

- A clone-configure-run **market maker template** for Ospex. The minimum that lets an agent safely **quote, update, cancel, get filled, settle, claim, and produce metrics** — with strict bankroll controls and a clear safety model.
- Built **on `@ospex/sdk`** — the SDK provides the contract/API plumbing (EIP-712 signing, reads, submit/match/cancel, positions, the odds Realtime subscription, typed errors, a nonce counter); this repo owns the *decisions* (which markets to quote, at what price and size, when to cancel/replace, when to stop) plus the config, risk engine, event loop, persistent state, and telemetry.
- **Subscription-first** for reference odds (it streams price changes rather than polling per contest) so it doesn't hammer the public API. Fill detection is bounded polling of the maker's *own* commitments/positions for now; a Realtime fills channel is a planned follow-up.

## What this is *not*

- Not a sophisticated quant system — it does not try to beat sportsbooks. The pricing is a first-order model with honestly-flagged assumptions (see `docs/DESIGN.md §5`).
- Not a speculation seeder — v0 quotes only speculations that already exist; it does not create new ones.
- Not the home for flow / taker agents, observer agents, or cross-agent scorecards — those exist to *exercise* a market maker and *prove the platform*; they live in a separate test harness, not here.

## Wallet model

Ospex never asks for your private key. Use a [Foundry](https://book.getfoundry.sh/) keystore:

```bash
mkdir -p ~/.foundry/keystores
cast wallet new ~/.foundry/keystores ospex-mm    # Foundry generates the key, prints only the address
                                                  # — or `cast wallet import ospex-mm` for an existing key
```

Point the config at that path (`wallet.keystorePath`, or the `OSPEX_KEYSTORE_PATH` env var). You also bring your own RPC URL — Alchemy, Infura, or QuickNode (the public Polygon RPCs are rate-limited and unreliable; there is no default). The MM prompts for the keystore passphrase only when it needs to sign.

## Quick start (intended flow — fills in as the implementation lands)

```bash
yarn install
yarn build

cp ospex-mm.example.yaml ospex-mm.yaml
# edit ospex-mm.yaml — wallet.keystorePath, rpcUrl, pricing.economics (capital + target return), risk caps

yarn mm doctor                       # readiness: balances (USDC + POL), PositionModule allowance, API/RPC, state
yarn mm quote --dry-run <contestId>  # one-shot: fetch reference odds, compute a two-sided quote, print the breakdown
yarn mm run --dry-run                # shadow mode: the full loop, posts nothing — let it run a while
yarn mm summary                      # aggregate the NDJSON event logs into the run metrics — read this before going live
# then, deliberately: set mode.dryRun: false in the config AND pass --live (the two-key model);
# OSPEX_KEYSTORE_PASSPHRASE=… in the env, else a no-echo TTY prompt
OSPEX_KEYSTORE_PASSPHRASE=… yarn mm run --live
```

`yarn mm <cmd>` runs the built CLI (`node dist/cli/index.js`). `yarn dev <cmd>` runs it via `tsx` without a build, for iteration. To get the `ospex-mm` binary on your PATH: `yarn build && yarn link` (or `npm link`), then `ospex-mm <cmd>`. Today `doctor`, `quote --dry-run`, `run --dry-run`, `run --live` (submits + off-chain cancels — alpha; see *Current scaffold status*), and `summary` work; `cancel-stale` / `status` exit `not yet implemented`.

See **[`docs/QUICKSTART.md`](docs/QUICKSTART.md)** for the walkthrough and **[`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md)** for the safe-operation checklist before you go live.

## Configuration

The annotated reference config is **[`ospex-mm.example.yaml`](ospex-mm.example.yaml)** — copy it, fill in wallet / rpc / pricing / risk, run. A novice typically touches only `wallet`, `rpcUrl`, `pricing.economics`, and maybe `risk`. The full schema and the rationale for every field are in `docs/DESIGN.md §7`. Defaults are conservative and `dryRun: true`.

## Architecture (brief — full design in `docs/DESIGN.md`)

A single long-running **worker** process. No HTTP surface. Runs locally (`ospex-mm run`) or as a worker dyno. Layers under `src/`: `config/` (load + validate), `ospex/` (the only module that imports `@ospex/sdk`), `pricing/` (vig strip → fair value → spread → quote prices), `risk/` (worst-case-loss-by-outcome accounting + cap enforcement + the allowance target), `orders/` (the order lifecycle), `state/` (persistent inventory, JSON, single-process), `telemetry/` (NDJSON event log + the `summary` aggregator), `runners/` (the event loop), `cli/` (`doctor | quote | run | cancel-stale | status | summary`).

## Safety — read this

This is **experimental software**, provided **without warranty**. Wagering and on-chain transactions carry **financial risk**, and there is **no profit guarantee** — odds accuracy, liquidity, settlement timing, RPC availability, and indexer latency are all best-effort. Nothing here is financial, legal, or tax advice; **you are responsible for compliance with the laws of your jurisdiction** and any tax/regulatory treatment — this software enforces no geofencing or KYC. **Dry-run first; start with tiny caps.** The MM never logs your private key, but when live it *will* submit transactions and move funds; approvals can be abused by buggy software — approve only what you'll risk, and audit with `ospex doctor` / `ospex approvals show`. An off-chain cancel pulls a quote from the order book but does **not** invalidate the signed payload — a taker holding it can still match it until it expires (≈2 minutes by default); for a hard stop use the on-chain kill (`killCancelOnChain: true`, costs gas). The full checklist is in **[`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md)**.

## Development

```bash
yarn install        # pulls @ospex/sdk from its v0.1.0 GitHub Release tarball + transitive deps
yarn build          # tsc -> dist/
yarn typecheck      # tsc --noEmit
yarn test           # vitest
yarn lint           # eslint src
```

Branches and PRs only — never commit to `main`. See **[`CONTRIBUTING.md`](CONTRIBUTING.md)**.

## License

[MIT](LICENSE). (The Ospex smart contracts are BUSL-1.1 in their own repository; `@ospex/sdk` and this repo are MIT.)

Security issues: see **[`SECURITY.md`](SECURITY.md)**.
