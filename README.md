# ospex-market-maker

A **reference market maker** for [Ospex](https://ospex.org) — a zero-vig peer-to-peer sports prediction protocol on Polygon. Clone it, point it at your wallet, bankroll, RPC URL, and return target, and it quotes two-sided liquidity on upcoming contests, manages its exposure, reacts to fills, settles and claims, and writes an auditable record of everything it did.

It is built on **[`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk)** — every chain and API interaction goes through the SDK; this repo never calls the Ospex contracts directly.

---

> ## ⚠️ Status — v0 scaffold
>
> This repo is in active development. The full design is in **[`docs/DESIGN.md`](docs/DESIGN.md)** — the command surface, config schema, pricing model, risk model, and lifecycle are specified there; the implementation is landing incrementally (Phase 1 = read-only core; Phase 2 = dry-run/shadow loop; Phase 3 = live micro-maker; Phase 4 = public polish). **Do not run this against real funds yet.**
>
> ## ⚠️ A note on the `@ospex/sdk` dependency
>
> This builds on `@ospex/sdk`, which is being prepared for public release. Until it's published, `yarn install` from a fresh clone won't resolve `@ospex/sdk` on branches that depend on it; the genesis scaffold on `main` builds without it. See **[`CONTRIBUTING.md`](CONTRIBUTING.md)** for the interim dev setup.

---

## Current scaffold status

What works in this commit:

- `yarn install && yarn build && yarn typecheck && yarn lint && yarn test` — clean (no tests yet; `vitest` runs with `--passWithNoTests`, which goes away once Phase 1 lands tests).
- `yarn mm --help` — prints the command list. (`yarn dev --help` does the same via `tsx` without a build; `yarn build && yarn link`, then `ospex-mm --help`, puts the binary on your PATH.)
- The design (`docs/DESIGN.md`), the annotated config (`ospex-mm.example.yaml`), and the safety checklist (`docs/OPERATOR_SAFETY.md`).

What's **not** implemented yet (Phase 1+ — see `docs/DESIGN.md §14`):

- `doctor`, `quote`, `run`, `cancel-stale`, `status`, `summary` — these currently exit with `not yet implemented`.
- the config loader, the pricing model, the risk engine, the `@ospex/sdk` adapter, the state store, telemetry, the event loop.

So: don't run this against real funds, and read the "intended flow" below as the target shape, not as something that works today.

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

yarn mm doctor                       # readiness: balances (USDC + POL), PositionModule allowance, network
yarn mm quote --dry-run <contestId>  # one-shot: fetch reference odds, compute a two-sided quote, print the breakdown
yarn mm run --dry-run                # shadow mode: the full loop, posts nothing — read the output before going live
# then, deliberately: set mode.dryRun: false in the config AND pass --live (the two-key model)
yarn mm run --live
```

`yarn mm <cmd>` runs the built CLI (`node dist/cli/index.js`). `yarn dev <cmd>` runs it via `tsx` without a build, for iteration. To get the `ospex-mm` binary on your PATH: `yarn build && yarn link` (or `npm link`), then `ospex-mm <cmd>`. (Today every command except `--help` exits `not yet implemented` — see *Current scaffold status* above.)

See **[`docs/QUICKSTART.md`](docs/QUICKSTART.md)** for the walkthrough and **[`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md)** for the safe-operation checklist before you go live.

## Configuration

The annotated reference config is **[`ospex-mm.example.yaml`](ospex-mm.example.yaml)** — copy it, fill in wallet / rpc / pricing / risk, run. A novice typically touches only `wallet`, `rpcUrl`, `pricing.economics`, and maybe `risk`. The full schema and the rationale for every field are in `docs/DESIGN.md §7`. Defaults are conservative and `dryRun: true`.

## Architecture (brief — full design in `docs/DESIGN.md`)

A single long-running **worker** process. No HTTP surface. Runs locally (`ospex-mm run`) or as a worker dyno. Layers under `src/`: `config/` (load + validate), `ospex/` (the only module that imports `@ospex/sdk`), `pricing/` (vig strip → fair value → spread → quote prices), `risk/` (worst-case-loss-by-outcome accounting + cap enforcement + the allowance target), `orders/` (the order lifecycle), `state/` (persistent inventory, JSON, single-process), `telemetry/` (NDJSON event log + the `summary` aggregator), `runners/` (the event loop), `cli/` (`doctor | quote | run | cancel-stale | status | summary`).

## Safety — read this

This is **experimental software**, provided **without warranty**. Wagering and on-chain transactions carry **financial risk**, and there is **no profit guarantee** — odds accuracy, liquidity, settlement timing, RPC availability, and indexer latency are all best-effort. Nothing here is financial, legal, or tax advice; **you are responsible for compliance with the laws of your jurisdiction** and any tax/regulatory treatment — this software enforces no geofencing or KYC. **Dry-run first; start with tiny caps.** The MM never logs your private key, but when live it *will* submit transactions and move funds; approvals can be abused by buggy software — approve only what you'll risk, and audit with `ospex doctor` / `ospex approvals show`. An off-chain cancel pulls a quote from the order book but does **not** invalidate the signed payload — a taker holding it can still match it until it expires (≈2 minutes by default); for a hard stop use the on-chain kill (`killCancelOnChain: true`, costs gas). The full checklist is in **[`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md)**.

## Development

```bash
yarn install        # devDeps only on `main`; @ospex/sdk is added on feature branches (see CONTRIBUTING.md)
yarn build          # tsc -> dist/
yarn typecheck      # tsc --noEmit
yarn test           # vitest
yarn lint           # eslint src
```

Branches and PRs only — never commit to `main`. See **[`CONTRIBUTING.md`](CONTRIBUTING.md)**.

## License

[MIT](LICENSE). (The Ospex smart contracts are BUSL-1.1 in their own repository; `@ospex/sdk` and this repo are MIT.)

Security issues: see **[`SECURITY.md`](SECURITY.md)**.
