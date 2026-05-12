# Quickstart

> **v0 scaffold.** Working today: `doctor`, `quote --dry-run`, and `run --dry-run` (the shadow loop — posts nothing). Still landing: `run --live`, `cancel-stale`, `status`, `summary` — see the README's *[Current scaffold status](../README.md#current-scaffold-status)*. This is the intended flow plus pointers; it fills in as the implementation lands (Phase 1 → 4 — see [`DESIGN.md`](DESIGN.md) §14).

## 1. Prerequisites

- Node 20+, [Yarn](https://classic.yarnpkg.com/) 1.x.
- A [Foundry](https://book.getfoundry.sh/) keystore for the wallet the maker will use:

  ```bash
  mkdir -p ~/.foundry/keystores
  cast wallet new ~/.foundry/keystores ospex-mm     # generates a fresh key; prints only the address
  # — or: cast wallet import ospex-mm                # import an existing private key
  ```

- An RPC URL for Polygon (Alchemy / Infura / QuickNode). No public-RPC default — the public Polygon endpoints are rate-limited and unreliable.
- USDC (for stakes) and POL/MATIC (for gas — approvals, on-chain cancels, settle, claim) in that wallet. The MM does **not** need LINK.

## 2. Install & build

```bash
yarn install
yarn build
```

Then run the CLI as `yarn mm <command>` (which is `node dist/cli/index.js`), or `yarn dev <command>` to run it via `tsx` without a build. To put the `ospex-mm` binary on your PATH instead: `yarn link` (or `npm link`) after `yarn build`, then `ospex-mm <command>`.

## 3. Configure

```bash
cp ospex-mm.example.yaml ospex-mm.yaml
```

Edit `ospex-mm.yaml` — at minimum `wallet.keystorePath`, `rpcUrl`, and `pricing.economics` (your capital and target monthly return; the math derives the quoting spread and refuses to start if your targets don't add up). Review the `risk` caps — they're conservative by default; lower them further if you want. The annotated config explains every field; the rationale is in [`DESIGN.md`](DESIGN.md) §7.

## 4. Check readiness — `yarn mm doctor`

```bash
yarn mm doctor                # add --address <0x…> to skip the keystore passphrase prompt; --json for a machine-readable envelope
```

Reports your wallet's USDC and POL balances, the `PositionModule` USDC allowance, API + RPC reachability, and the persisted-state integrity check — plus a "Ready to" matrix: *dry-run shadow* (boots whenever nothing's broken — the shadow loop posts nothing, so it needs no keystore) and *post commitments* (the live prereqs — a usable keystore, a resolved address, `mode.dryRun: false`, a funded/approved wallet). Exits `0` unless something is broken; a `WARN` (no keystore yet, low POL, allowance below the cap ceiling, …) is advisory.

## 5. Preview a quote — `yarn mm quote --dry-run`

```bash
yarn mm quote --dry-run <contestId>   # one-shot: reference odds → fair value → spread → a two-sided priced quote, with the full breakdown
```

Computes what the MM would quote for that contest (or refuses with a clear message if the contest is closed, has no open moneyline speculation, or has no reference odds). It never posts. Use it to sanity-check your pricing config before running the loop.

## 6. Run the shadow loop — `yarn mm run --dry-run`

```bash
yarn mm run --dry-run    # the full loop, posting nothing — Ctrl-C (or a KILL file) to stop
```

Runs the real event loop — discovery → reference-odds tracking (a Supabase Realtime channel per market by default; bounded snapshot polling if you set `odds.subscribe: false`) → the per-market reconcile (price → plan → log) → age-out → state flush, every `pollIntervalMs` (≥ 30 s) — but instead of submitting it logs `quote-intent` / `would-submit` / `would-replace` / `would-soft-cancel` / `candidate` / `expire` / `degraded` events to the NDJSON file under `telemetry.logDir`, and tracks a *hypothetical* inventory (so cap enforcement, including the latent-exposure bucket, is exercised for real). It boots through the state-loss fail-safe first (a missing/corrupt state file plus prior telemetry holds quoting — pass `--ignore-missing-state` only after confirming no prior commitment is still matchable). To stop: drop a `KILL` file (path = `killSwitchFile` in your config) or send SIGTERM/SIGINT. Let it run for a meaningful window, then read the log (a `summary` aggregator is coming) before going live. `--address` / `--keystore <path>` are accepted but not required in dry-run.

> `run --live` isn't implemented yet — it exits `not yet implemented`. The two-key model below is the Phase-3 design.

## 7. Going live (the two-key model) *(Phase 3 target)*

Live requires **both**: `mode.dryRun: false` in your config **and** the `--live` flag on the command. Either one alone runs dry (in v0, `--live` simply isn't implemented yet — it exits `not yet implemented`). `--dry-run` always forces dry-run.

```bash
# after setting mode.dryRun: false in ospex-mm.yaml:
yarn mm run --live
```

Start with tiny caps. Watch `yarn mm status` and the telemetry log. Keep gas (POL) and USDC topped up. To stop: drop a `KILL` file (path = `killSwitchFile` in your config) or send SIGTERM/SIGINT — note that with `killCancelOnChain: false` this is a *soft* stop (pulled quotes stay matchable until they expire, ≈2 min by default; set `killCancelOnChain: true` for a hard, gas-spending stop).

**Read [`OPERATOR_SAFETY.md`](OPERATOR_SAFETY.md) before you go live.**
