# Operator safety

Read this before running the market maker against real funds. It is the safe-operation checklist; the design rationale behind each point is in [`DESIGN.md`](DESIGN.md).

## Before you start

- **Experimental software, no warranty.** This is a reference implementation under active development. It may have bugs. Bugs in this software, or in `@ospex/sdk`, or in the Ospex contracts, could cause loss of funds.
- **Financial risk; no profit guarantee.** Wagering and on-chain transactions carry financial risk. There is no guarantee of liquidity, fills, profit, settlement timing, odds accuracy, RPC availability, or indexer latency — all of it is best-effort.
- **Not advice; your responsibility.** Nothing here is financial, legal, or tax advice. You are responsible for complying with the laws of your jurisdiction and for any tax/regulatory treatment of your activity. This software enforces no geofencing, KYC, or any other regulatory check. Don't use it where you shouldn't.

## Your wallet

- Use a Foundry keystore (`cast wallet new ~/.foundry/keystores ospex-mm`, or `cast wallet import`). The MM never sees or persists your private key — it reads the v3 keystore and prompts for the passphrase only when it needs to sign.
- Use a wallet that holds only what you're willing to put at risk. Don't point this at your main wallet.
- Keep the keystore file and its passphrase secure. Anyone with both can sign as you.

## Funding

- The MM needs **USDC** (for stakes) and **POL/MATIC** (for gas: approvals, on-chain cancels, settle, claim). It does **not** need LINK.
- Keep both topped up. `ospex-mm doctor` and `ospex-mm status` flag low balances. If you run out of POL while you have winning positions, you won't be able to claim them until you refuel — your funds aren't lost, but they're stuck.
- The MM approves USDC only to `PositionModule`. It will **not** approve on its own unless you set `approvals.autoApprove: true`. Even then, `mode: exact` (the default) raises the allowance only to `min(risk-cap ceiling, current wallet USDC balance)` — a finite, wallet-bounded amount — and is **raise-only** (an existing higher allowance is left alone). The auto-approve is **deferred while the boot-time state-loss hold is active** (a missing/corrupt state file with prior telemetry): raising the allowance during that window could re-activate latent soft-cancelled signed commitments, so the MM waits for the hold to lift before approving. An unlimited approval (`MaxUint256`) only happens if you explicitly set `approvals.mode: unlimited` *and* confirm with `--yes` on the CLI. Audit your approvals with `ospex approvals show`; revoke ones you don't need.

## Dry-run first

`mode.dryRun: true` is the default. Run `ospex-mm run --dry-run` for a meaningful window before going live. The MM does everything except post — it logs what it *would* submit/cancel/replace, runs the risk engine, and measures quote competitiveness against the visible order book. Read the output:

- the **would-be-stale rate** — how often a quote would have aged out before being matched;
- the **quote-competitiveness** numbers — whether your quotes sit at or inside the visible book;
- the **latent-exposure peak** — the largest aggregate risk reached (including quotes that would have been pulled but not yet expired);
- the **skip reasons** — why contests/markets were passed over.

If the prices look wrong, or the skip pattern is surprising, or the economics-mode math refuses to start — fix the config. Don't go live to "see what happens."

## Going live — the two-key model

Live requires **both**:

1. `mode.dryRun: false` in your config file, **and**
2. the `--live` flag on the command.

With only one of the two, the MM runs dry and tells you why. The `--dry-run` flag always forces dry-run regardless of config. This is deliberate: it takes two intentional acts to put real money on the table; neither a stray config edit nor a stray flag can do it alone.

## Caps

- The example config is conservative. Start there or tighter. Caps bind **worst-case USDC loss by outcome** — they account for filled positions, your visible quotes, *and* latent quotes (see below).
- The caps at boot are the caps for the whole run. The MM never widens its own risk during a run. To change a cap, stop and restart.

## Latent matchable exposure — important

When the MM "cancels" a quote, by default it does so **off-chain**: it tells the API to stop surfacing that quote. But the quote is a *signed* `OspexCommitment` — pulling it from the order book does **not** invalidate the signature. A taker who already has the signed payload can still match it on chain until it:

- **expires**,
- gets **filled**, or
- is **cancelled on chain** (`cancelCommitment`) or **invalidated by a nonce-floor raise** — both of which cost gas.

So a pulled quote is *latent* exposure, not gone. The MM tracks this and counts it against your caps. The defence is **short expiries**: the recommended `expiryMode: fixed-seconds` with `expirySeconds: 120` means a pulled quote stops being matchable within ~2 minutes. **Do not set `expiryMode: match-time`** (expiry = the game's start time) unless you understand that a pulled quote then stays matchable for *hours* — only acceptable if you replace via on-chain cancels (gas) or accept the exposure.

## The kill switch

- Drop a file at `killSwitchFile` (default `./KILL`), or send SIGTERM/SIGINT. The MM pulls every visible quote off chain (gasless `cancelCommitmentOffchain` — emits `soft-cancel` `reason: 'shutdown'`, reclassifies the records to `softCancelled`), flushes state and telemetry, and exits cleanly.
- **With `killCancelOnChain: false` (the default) this is a *soft* stop** — pulled quotes leave the book immediately, but a taker holding the signed payload can still match them on chain until they expire (~2 min with the recommended config). For a *hard* stop (also authoritatively cancels every non-terminal commitment on chain via `cancelCommitmentOnchain` per record — `MatchingModule.cancelCommitment` flips `s_cancelledCommitments[hash]` so subsequent `matchCommitment` calls revert), set `killCancelOnChain: true`. This costs gas — drawn from the emergency reserve via `canSpendGas` with `mayUseReserve: true`. (A future optimization may bulk-invalidate via `raiseMinNonce` per speculation; the current path is per-commitment for safety + simplicity.)

## State

- The MM keeps its inventory in JSON files under `state.dir`, including the set of quotes it has soft-cancelled-but-not-yet-expired. That soft-cancelled set is the one thing it can't rebuild from chain/API. **Don't run two MMs against the same state directory.** If the state file is lost or corrupted between runs, the MM will not resume quoting on a blank slate (it would under-count latent exposure) — it reconstructs from telemetry, or waits one `expirySeconds` window, or you pass an explicit override.

## If something goes wrong

1. Kill switch (drop the `KILL` file).
2. `ospex-mm status` and the telemetry log under `telemetry.logDir` — what's open, what's filled, what errored.
3. `ospex-mm cancel-stale` (off-chain) — or `ospex-mm cancel-stale --authoritative` (on-chain, costs gas) if you need quotes invalidated *now*. **Stop `run --live` first** — the JSON state file isn't multi-process safe, so a concurrent runner would race on the flush. The off-chain leg pulls every tracked commitment older than `orders.staleAfterSeconds` from the API book (gasless) — `visibleOpen`, `partiallyFilled` (the unfilled remainder is still matchable), and `softCancelled` (no-op for the API but on chain remains matchable until expiry). `--authoritative` additionally calls `cancelCommitmentOnchain` per record (gas-gated with `mayUseReserve: true`, drawn from the emergency reserve — operator-explicit). The command mirrors the runner's state-loss fail-safe: refuses if `maker-state.json` is missing while prior telemetry exists, unless you pass `--ignore-missing-state` (attesting no prior soft-cancelled commitment is still matchable).
4. If you're locked out of settle/claim because you're out of POL — top up the wallet, then `ospex-mm status` / claim again.

## Reporting issues

SDK / CLI / market-maker bugs → this repo's issues (security issues: see [`../SECURITY.md`](../SECURITY.md)). Smart-contract security issues → the Ospex contracts repository.
