# Quickstart

> **v0 scaffold.** Most of the commands below aren't implemented yet — see the README's *[Current scaffold status](../README.md#current-scaffold-status)*. This is the intended flow plus pointers; it fills in as the implementation lands (Phase 1 → 4 — see [`DESIGN.md`](DESIGN.md) §14).

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

## 4. Check readiness — `yarn mm doctor` *(Phase 1 target)*

```bash
yarn mm doctor
```

Will report your wallet's USDC and POL balances, the `PositionModule` USDC allowance, and network status — a "ready to" view. *(Not implemented yet — currently exits `not yet implemented`.)*

## 5. Dry-run first *(Phase 1 / 2 target)*

```bash
yarn mm quote --dry-run <contestId>   # one-shot: reference odds → a two-sided quote with the full breakdown
yarn mm run --dry-run                 # the full loop, posts nothing — let it run for a while
```

Read the dry-run output before going live: the would-be-stale rate, the quote-competitiveness numbers, the latent-exposure peak, and the skip reasons. If the prices or the skip pattern look wrong, fix the config — don't go live.

## 6. Going live (the two-key model) *(Phase 3 target)*

Live requires **both**: `mode.dryRun: false` in your config **and** the `--live` flag on the command. Either one alone runs dry. `--dry-run` always forces dry-run.

```bash
# after setting mode.dryRun: false in ospex-mm.yaml:
yarn mm run --live
```

Start with tiny caps. Watch `yarn mm status` and the telemetry log. Keep gas (POL) and USDC topped up. To stop: drop a `KILL` file (path = `killSwitchFile` in your config) or send SIGTERM/SIGINT — note that with `killCancelOnChain: false` this is a *soft* stop (pulled quotes stay matchable until they expire, ≈2 min by default; set `killCancelOnChain: true` for a hard, gas-spending stop).

**Read [`OPERATOR_SAFETY.md`](OPERATOR_SAFETY.md) before you go live.**
