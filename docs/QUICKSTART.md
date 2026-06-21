# Quickstart

> **Alpha.** The full command surface is wired: `doctor`, `quote --dry-run`, `candidates` (the read-only quote/setup-target preflight — see §5), `run --dry-run` (the shadow loop — posts nothing), `run --live` (executes submits + off-chain cancels via the SDK, stream-driven own-state tracking — fills + position status arrive in real time over the owner-authenticated own-state SSE stream — boot-time auto-approve with a wallet-bounded target, the daily POL gas-budget verdict, auto-settle + auto-claim of the maker's own positions, and the on-chain kill path on shutdown when `killCancelOnChain: true`), `cancel-stale [--authoritative]` (the one-shot operator cleanup — off-chain by default, on-chain per record with the flag), `status` (read-only state snapshot + optional live `positions.status(maker)` totals), and `summary` (including live-mode metrics and realized P&L). Unrealized P&L and the `raiseMinNonce` bulk-invalidate optimization are still ahead — see the README's *[Current status](../README.md#current-status)*. The live path has been exercised end-to-end on Polygon mainnet in small, controlled runs; treat it as alpha — dry-run first, tiny caps.

## 1. Prerequisites

- Node 20+, [Yarn](https://classic.yarnpkg.com/) 1.x.
- An RPC URL for Polygon (Alchemy / Infura / QuickNode). No public-RPC default — the public Polygon endpoints are rate-limited and unreliable.
- **For live mode only** — everything below `run --live` is read-only / signs nothing, so you can skip these for a dry-run:
  - A [Foundry](https://book.getfoundry.sh/) keystore for the wallet the maker will use:

    ```bash
    mkdir -p ~/.foundry/keystores
    cast wallet new ~/.foundry/keystores ospex-mm     # generates a fresh key; prints only the address
    # — or: cast wallet import ospex-mm                # import an existing private key
    ```

  - USDC (for stakes) and POL/MATIC (for gas — approvals, on-chain cancels, settle, claim) in that wallet. The MM does **not** need LINK.

## 2. Install & build

```bash
yarn install
yarn build
```

`yarn install` pulls `@ospex/sdk` from its pinned GitHub Release tarball — `package.json` / `yarn.lock` are the source of truth for the pinned version (v0.6.2 at the time of writing); there is nothing SDK-related to install separately.

Then run the CLI as `yarn mm <command>` (which is `node dist/cli/index.js`), or `yarn dev <command>` to run it via `tsx` without a build. To put the `ospex-mm` binary on your PATH instead: `yarn link` (or `npm link`) after `yarn build`, then `ospex-mm <command>`.

## 3. Configure

```bash
cp ospex-mm.example.yaml ospex-mm.yaml
```

Edit `ospex-mm.yaml` — at minimum `rpcUrl` and `pricing.economics` (your capital and target monthly return; the math derives the quoting spread and refuses to start if your targets don't add up). Review the `risk` caps — they're conservative by default; lower them further if you want. The annotated config explains every field; the rationale is in [`DESIGN.md`](DESIGN.md) §7.

`wallet.keystorePath` can stay blank (the example's default) for everything in §4–§7 — `doctor --address <0x…>`, `quote --dry-run`, and `run --dry-run` sign nothing. When you go live (§8), set it to the **absolute** path of your keystore file — the path is used verbatim, so `~` is **not** expanded (`/home/you/.foundry/keystores/ospex-mm`, not `~/.foundry/keystores/ospex-mm`). A blank path is an advisory `WARN` in `doctor`; a path that is set but points at a missing file is a `FAIL`.

## 4. Check readiness — `yarn mm doctor`

```bash
yarn mm doctor --address <0x…>   # fully read-only — no keystore, no passphrase prompt; --json for a machine-readable envelope
```

Reports that wallet's USDC and POL balances, the `PositionModule` USDC allowance, API + RPC reachability, and the persisted-state integrity check — plus a "Ready to" matrix: *dry-run shadow* (boots whenever nothing's broken — the shadow loop posts nothing, so it needs no keystore) and *post commitments* (the live prereqs — a usable keystore, a resolved address, `mode.dryRun: false`, a funded/approved wallet). Exits `0` unless something is broken; a `WARN` (no keystore yet, low POL, allowance below the cap ceiling, …) is advisory. Note the keystore semantics: a blank `wallet.keystorePath` is a `WARN` (fine for dry-run), but a path that points at a missing file is a `FAIL` — don't set it until the keystore exists, and use an absolute path (no `~` expansion). Without `--address` (and with no keystore configured) the chain-side checks are `SKIP`ped and doctor still verifies config, API, and state. If you do pass `--address`, use the wallet you actually intend to fund — doctor treats a wallet with zero POL as a `FAIL` (it can't send any transaction), which also flips the "Ready to" matrix to NO.

## 5. Preview a quote — `yarn mm quote --dry-run`

```bash
yarn mm quote --dry-run <contestId>   # one-shot: reference odds → fair value → spread → a two-sided priced quote, with the full breakdown
```

Computes what the MM would quote for that contest (or refuses with a clear message if the contest is closed, has no open moneyline speculation, or has no reference odds). It never posts. Use it to sanity-check your pricing config before running the loop.

### Find a quote target

`quote --dry-run` refuses a contest that is already **scored or voided**, has **no open moneyline speculation**, or has **no reference odds**. Use the `candidates` preflight to see — in one read-only, signer-free listing — what is quotable right now *and* what could be turned into a quotable contest:

```bash
yarn mm candidates                  # human table; --sport <sport> / --hours <n> to set the window (1-720h;
                                    #   the contests leg caps at the contests API's 168h max)
yarn mm candidates --json           # { schemaVersion: 2, candidates: … } envelope for scripts/agents
```

It's **market-aware**: a verified contest is classified per configured market (`marketSelection.markets`, default `moneyline`) — one item per `(contest, market)`. Each gets one classification: `quote_ready` (verified contest + open speculation for that market + reference odds — pass its `contestId` straight to `quote --dry-run`), `needs_speculation` (verified, but nobody has seeded that market's speculation), `needs_verification` (contest created, oracle verification pending), `setup` (an upcoming game with reference odds and no contest yet — someone must create and verify a contest on chain before anyone can quote it), or `skipped` (with a reason — started/postponed, no odds, deny-listed, …). The command never writes and needs no keystore; an empty listing exits 0 — that's a valid board state, not a setup problem. When `marketSelection.contestAllowList` is non-empty, contest-backed items carry `inContestAllowList` so you can see what a live run would actually quote — discovery annotates, it never hides.

If you prefer to query the public API directly, this is the contest query the runner's discovery (and `candidates`'s contest leg) starts from — upcoming verified contests:

```bash
# upcoming verified contests starting within the next 24 hours (window: 1–168, default 72):
curl -s 'https://api.ospex.org/v1/contests?status=verified&window=24&limit=200'
```

Pick a contest whose `speculations[]` contains an entry with `"type": "moneyline"` and `"speculationStatus": 0` (0 = open, still taking commitments) and pass its `contestId` to `quote`. With [`jq`](https://jqlang.org/):

```bash
curl -s 'https://api.ospex.org/v1/contests?status=verified&window=24&limit=200' \
  | jq '[.contests[]
         | select(any(.speculations[]?; .type == "moneyline" and .speculationStatus == 0))
         | {contestId, awayTeam, homeTeam, matchTime}]'
```

The endpoint lists **upcoming** contests only (start time between now and now + `window` hours). An empty list means there is genuinely nothing to quote right now — contests exist only after someone creates and verifies them on chain, and outside your configured sports' game hours (or in the off-season) the board can be empty (`candidates` shows whether games are at least *creatable* in that window). Likewise, `quote` against a contest that has since been scored refuses with a clear message — both are expected states, not setup problems. `run --dry-run` (§6) discovers its own targets with a stricter version of this query — verified contests further filtered to your configured `marketSelection.sports`, the `maxStartsWithinHours` start window, and the tracking cap — and just sits idle until a quotable market appears.

## 6. Run the shadow loop — `yarn mm run --dry-run`

```bash
yarn mm run --dry-run    # the full loop, posting nothing — Ctrl-C (or a KILL file) to stop
```

Runs the real event loop — discovery → reference-odds tracking (a core-api SSE odds stream per market by default; bounded snapshot polling if you set `odds.subscribe: false`) → the per-market reconcile (price → plan → log → assess competitiveness) → age-out → terminal-record prune → state flush, every `ownState.auditPollIntervalMs` (default 60 s) — but instead of submitting it logs `quote-intent` / `quote-competitiveness` / `would-submit` / `would-replace` / `would-soft-cancel` / `candidate` / `expire` / `degraded` events to the NDJSON file under `telemetry.logDir`, and tracks a *hypothetical* inventory (so cap enforcement, including the latent-exposure bucket, is exercised for real). It boots through the state-loss fail-safe first (a missing/corrupt state file plus prior telemetry holds quoting — pass `--ignore-missing-state` only after confirming no prior commitment is still matchable). To stop: drop a `KILL` file (path = `killSwitchFile` in your config) or send SIGTERM/SIGINT. Let it run for a meaningful window, then read the aggregated metrics with `yarn mm summary` (§7) before going live. `--address` / `--keystore <path>` are accepted but not required in dry-run.

> `run --live` is implemented for the reconcile's write path (submits + off-chain cancels), stream-driven own-state tracking (the owner-authenticated own-state SSE stream — always on in live mode — is the canonical writer of commitments, fills, and positions, emitting `fill` / `position-transition` events in real time; the per-tick poll of the maker's own commitments/positions survives only as an audit cross-check that never gates the tick), boot-time auto-approve (`approvals.autoApprove: true` raises the `PositionModule` USDC allowance to `min(risk-cap ceiling, wallet USDC balance)` in `mode: exact` once before the first tick — deferred while the state-loss hold is active; `approvals.mode: unlimited` skips the wallet bound and requires `--yes`), and a **daily POL gas-budget verdict** (`canSpendGas` checks `state.dailyCounters[YYYY-MM-DD].gasPolWei + gas.emergencyReservePOL` against `gas.maxDailyGasPOL` before every on-chain write — denied approves emit `candidate` `gas-budget-blocks-reapproval`). **Auto-settle + auto-claim** (`settlement.autoSettleOwn` / `autoClaimOwn`): each tick after the audit probes, the runner calls idempotent `ensureSpeculationSettled` for `pendingSettle` records (our own settle tx emits `settle`; an already-settled or concurrent-race recovery emits a `candidate` `already-settled` skip instead — never an `error` — billing any reverted-race gas) and idempotent `ensurePositionClaimed` for `claimable` records (our own claim tx emits `claim` with the event-sourced payout; an already-claimed or concurrent-race recovery emits a `candidate` `already-claimed` skip instead — no `claim` event, no payout, billing any reverted-race gas — never an `error`; only a genuine `NotSettled` / `NoPayout` / RPC failure stays `error` `phase: 'claim'`; every success outcome stamps the local `claimed` status so the per-tick loop stops retrying); gas-gated with `mayUseReserve = settlement.continueOnGasBudgetExhausted` so finalize-positions ops can dip into the emergency reserve when set, otherwise share the normal gate (denials emit `candidate` `gas-budget-blocks-settlement`). The **kill switch**: on shutdown — KILL file or SIGTERM/SIGINT — the runner first sweeps every `visibleOpen` quote off chain via gasless `cancelCommitmentOffchain` (emits `soft-cancel` `reason: 'shutdown'`, records → `softCancelled`) — a `partiallyFilled` remainder is retained (the API rejects its off-chain cancel once matched) and left for the on-chain kill or natural expiry; then, only if `killCancelOnChain: true`, also calls `cancelCommitmentOnchain` for every non-terminal commitment (including partials) to authoritatively kill the matchable window (gas-gated with `mayUseReserve: true` — "burn the reserve to kill latent exposure"; records → `authoritativelyInvalidated`). Use `ospex-mm cancel-stale` to pull every stale `visibleOpen` commitment off the book — a `partiallyFilled` remainder is skipped off-chain (the API rejects its DELETE once matched) and `softCancelled` records stay matchable on chain, so for either only `--authoritative` invalidates the still-matchable signed payload. Off-chain by default; `--authoritative` also calls `cancelCommitmentOnchain` per record — costs POL, drawn from the emergency reserve via `mayUseReserve: true`. **Stop a running `run --live` first** since the JSON state file isn't multi-process safe. Mirrors the runner's state-loss fail-safe (refuses on missing-state + prior-telemetry unless `--ignore-missing-state`). Keep an eye on the telemetry log and start tiny.

## 7. Read the run metrics — `yarn mm summary`

```bash
yarn mm summary                              # aggregate every run-*.ndjson under telemetry.logDir
yarn mm summary --since 2026-05-12T14:00:00Z # window it to events at/after a timestamp
yarn mm summary --json                       # a { schemaVersion: 1, summary: … } envelope
```

Aggregates the NDJSON event logs into the §2.3 run metrics: ticks, the candidate-skip and event-kind histograms, quote-intent counts, the would-be submit / replace / soft-cancel / expire tallies, the **quote-competitiveness** rate (how often a would-be quote sat at/inside the visible book on its side, plus the vs-reference tick spread), the **quote-age** distribution (p50 / p90 / max seconds a quote stayed up), the **latent-exposure peak**, stale-quote incidents, and the error counts — plus the run window, the run-ids, and the shutdown reason if the log has a `kill` event. Read this after a dry-run window to gauge whether your pricing config is competitive and your caps are sensible *before* you flip to live. **Live-mode metrics** (`summary.liveMetrics`) are populated when the log carries live events: **fill rate** (filled USDC ÷ quoted USDC across `submit` / `replace` / `fill`), **gas** (POL wei18 total + per-kind attribution across `approval` / `onchain-cancel` / `settle` / `claim`; optional USDC equivalent when `gas.reportInUSDC: true`), **settlements** (counts + total claimed payout), **realized P&L** (signed net + claimed-profit / realized-loss + per-outcome counts: won / lost / push / won-unclaimed / already-claimed / unsettled — `already-claimed` is a position the auto-claim found already claimed out-of-window, distinct from `won-unclaimed`; it contributes no derived payout), and **fees** (USDC wei6 — genuinely `"0"` in v0). Unrealized P&L (active positions marked to current fair) is the remaining live-metrics slice.

## 8. Going live (the two-key model)

Live requires **both**: `mode.dryRun: false` in your config **and** the `--live` flag on the command. `--live` without the config flag is refused; `--dry-run` always forces dry-run. If you ran dry-run with a blank `wallet.keystorePath`, set it now — the **absolute** path to your keystore file (no `~` expansion), or the `OSPEX_KEYSTORE_PATH` env var. The keystore passphrase comes from `OSPEX_KEYSTORE_PASSPHRASE` (preferred for non-interactive runs), else a no-echo TTY prompt; `--address` with `--live` is refused (the signer determines the maker wallet). Use a *fresh* `state.dir` for live — a directory polluted with prior dry-run synthetic commitments is refused at boot. **Point `state.dir` at an absolute path *outside* this repo working tree** (e.g. `/var/lib/ospex-mm/state` — an absolute path outside the clone). `maker-state.json` holds signed EIP-712 commitment payloads — bearer credentials a taker can use to fill your still-matchable quotes — so it must never be committed. Only the literal `./state/` (plus `./telemetry/`, `./KILL`) are git-ignored; a `state.dir` under any *other* in-repo name (`./live-state/`, `./canary-state/`, …) is **not** ignored and would make those credentials git-visible. See [`OPERATOR_SAFETY.md`](OPERATOR_SAFETY.md#sensitive-local-state).

```bash
# after setting mode.dryRun: false in ospex-mm.yaml, with a fresh state.dir
# (absolute path OUTSIDE this repo — see the note above; an in-repo dir not named "state" is git-visible):
OSPEX_KEYSTORE_PASSPHRASE='…' yarn mm run --live
# or, on a TTY, omit the env var and you'll be prompted (no-echo)
```

Start with tiny caps. Watch `yarn mm summary` (NDJSON-log aggregation — competitiveness, candidate / event histograms, latent-exposure peak), `yarn mm status` (a read-only snapshot of the persisted state — commitments by lifecycle, positions by status with USDC sums, today + lifetime gas / fees, plus the SDK's `positions.status(maker)` totals from the API when a maker address resolves), and the telemetry log. Keep gas (POL) and USDC topped up. To stop: drop a `KILL` file (path = `killSwitchFile` in your config) or send SIGTERM/SIGINT — note that with `killCancelOnChain: false` this is a *soft* stop (pulled quotes stay matchable until they expire, ≈2 min by default; set `killCancelOnChain: true` for a hard, gas-spending stop).

**Read [`OPERATOR_SAFETY.md`](OPERATOR_SAFETY.md) before you go live.**
