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

## One wallet per instance

**Run at most one MM instance per wallet.** The `state.dir` lock stops two instances from sharing a *state directory*, but it does **not** stop two instances from sharing a *wallet* (different `state.dir`s, same keystore). Don't do it: both instances quote the same markets on the same maker address, so each sees the other's fills as commitments it never posted — which triggers repeated cursor-freeze + cold-restart churn — and they cancel and replace each other's quotes in a tight loop. There is no on-chain harm (your own commitments can't fill each other), but the MMs spend gas and make no orderly market.

- This is **not enforced** (cross-process mutual exclusion on a wallet would need shared coordination the MM deliberately doesn't have). Instead, a **live boot warns**: it reads the wallet's open commitments and, if any weren't posted by this instance, logs `WARNING: … another MM may be running on the same wallet` and emits a `foreign-maker-commitments` telemetry event.
- The warning is **advisory** — open commitments on your wallet that this instance didn't post can also be harmless **prior-run residue** (a previous run on this wallet whose quotes haven't expired) or a **hand-posted quote**. If you know that's the case, it's safe to ignore; the residue expires on its own. If you did *not* expect them, stop the other instance.
- Running several MMs on one host? Give each **its own wallet** (and its own `state.dir` / `telemetry.logDir` / `killSwitchFile`).

## Funding

- The MM needs **USDC** (for stakes) and **POL/MATIC** (for gas: approvals, on-chain cancels, settle, claim). It does **not** need LINK.
- Keep both topped up. `ospex-mm doctor` flags low wallet balances; `ospex-mm status` reports today's accumulated POL gas spend + the live `positions.status` totals (claimable payout sums) so you can see at a glance whether you have unclaimed winnings sitting on chain. If you run out of POL while you have winning positions, you won't be able to claim them until you refuel — your funds aren't lost, but they're stuck.
- The MM approves USDC only to `PositionModule`. It will **not** approve on its own unless you set `approvals.autoApprove: true`. Even then, `mode: exact` (the default) raises the allowance only to `min(risk-cap ceiling, current wallet USDC balance)` — a finite, wallet-bounded amount — and is **raise-only** (an existing higher allowance is left alone). The auto-approve is **deferred while the boot-time state-loss hold is active** (a missing/corrupt state file with prior telemetry): raising the allowance during that window could re-activate latent soft-cancelled signed commitments, so the MM waits for the hold to lift before approving. An unlimited approval (`MaxUint256`) only happens if you explicitly set `approvals.mode: unlimited` *and* confirm with `--yes` on the CLI. Audit your approvals with `ospex approvals show`; revoke ones you don't need.

## Funding guard — auto-halt when underfunded

A commitment's stake is pulled from your wallet **when it's matched**, not when it's posted. If your wallet's USDC (or its `PositionModule` allowance) drops below what your open commitments could draw — you moved funds, lowered the allowance, or got filled faster than expected — those commitments become *unbacked*: a taker who tries to fill one just wastes gas. The funding guard protects against quoting liquidity you can't honour.

- Each tick (live only), before posting, the MM checks `min(wallet USDC, PositionModule allowance)` against the **gross** remaining risk of your still-matchable commitments. If it falls short, it **stops posting new quotes** until you top up — and a `funding-hold` telemetry event records it (with the shortfall amounts).
- What happens to the quotes already on the book is set by `fundingGuard.underfundedCancelMode`: **`offchain`** (default) pulls them off the relay so no *new* fills come in (gasless — but the signed payloads stay matchable on chain until they expire, so the hold persists until then); **`onchain`** also authoritatively cancels them on chain (costs gas, but actually clears the exposure so the hold lifts sooner); **`none`** just halts posting and lets them ride to expiry.
- It **fails closed**: if the balance/allowance read itself fails, the MM enters the hold rather than risk posting commitments it can't back (`failClosedOnReadError: true`, the default).
- This is an *advisory, time-sensitive* guard, not an escrow — funding can still move between the check and a fill. The real protection against unbacked exposure is keeping your wallet funded and using short expiries (see below).

## Own-state-health guard — auto-cancel on a degraded stream

In live mode the MM **always** opens its owner-authenticated own-state SSE stream — it is the canonical source of truth for the MM's commitments, fills, and positions. The stream needs your keystore (the SDK mints a bearer token signed by the maker's key), so a live boot refuses without one; this guard is therefore always armed when you run live. In dry-run there is no signer, no subscription is opened, and the guard is inert.

If the stream degrades — it goes silent, overflows, lags the indexer, fails to authenticate, or diverges from the per-tick audit cross-check — the MM can no longer trust its own book, so it **stops posting new quotes** (a `stream-health-hold` telemetry event records it). If there is open exposure when that happens (a `high`-severity hold), the MM also **actively cancels its existing quotes** so no new fills land against a book it can't see:

- It pulls every still-matchable `visibleOpen` quote off the relay (gasless — but, like the funding guard, the signed payloads stay matchable on chain until expiry, so the exposure persists until then).
- Under **`orders.cancelMode: onchain`** it *also* authoritatively cancels them on chain — this **spends POL gas** (gas-gated, and it will **not** touch your emergency reserve), and is the only mode that actually clears the exposure.
- There is **no `none` opt-out** (unlike the funding guard): a degraded own-state view is treated as a safety event, and pulling your relay quotes is the minimum response. To avoid the on-chain gas spend, leave `orders.cancelMode` at its default `offchain`.

So before you go live with `orders.cancelMode: onchain`, know that a flaky stream can trigger automatic, gas-spending on-chain cancels. Keep POL funded, and watch for `stream-health-hold` / `onchain-cancel` telemetry.

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

## Markets — spread / total (opt-in)

`marketSelection.markets` defaults to `["moneyline"]`. Spread and total are **opt-in** — add them to the list to quote them. Before you do:

- **Order is priority.** When the tracking cap (`maxTrackedMarkets`) is tight, earlier-listed markets win slots — a market listed later can be starved of tracking on a busy slate. List the markets you care about most first.
- **Each market is its own odds stream.** `maxTrackedMarkets` caps `(contest, market, line)` entries, and each opens its own reference-odds SSE connection. Enabling three markets can roughly **triple** your stream count for the same number of contests — size `maxTrackedMarkets` and `odds.maxRealtimeChannels` (and your core-api per-IP cap) accordingly.
- **Caps are per market + line.** Worst-case exposure is summed independently across a contest's moneyline / spread / total speculations (they can all lose at once), so a multi-market contest draws more of your per-contest / bankroll caps than moneyline alone. Size your caps for the markets you enable.
- **Line-sanity rail.** Every spread / total commitment carries an on-chain line; the MM refuses to sign a line outside a conservative magnitude band (`MM_MAX_SANE_LINE_TICKS`, ±500.0 points) — a hard safety rail against a pathological line, not a tuning knob. Moneyline (no line) is unaffected.
- **The MM follows the oracle line.** For spread / total it tracks the open speculation at the reference (oracle) line and re-binds as that line moves (debounced by `orders.replaceOnLineMoveTicks`); if the tracked line and the reference line diverge, it pulls its quotes and refuses rather than post at a mispriced line.

## Seeding — posting where no speculation exists yet (opt-in)

By default the MM only quotes markets that **already have an open speculation** on chain. **Seeding** lets it post at a market's oracle line where no speculation exists yet — the protocol then *lazily creates* the speculation when the seed first matches, and you (the maker) pay your share of the protocol **creation fee** at that match. This is off by default and is a **double opt-in** — both are required, or seeds are never posted:

1. `marketSelection.seedSpeculations: true`, **and**
2. `risk.maxDailyFeeUSDC` set **> 0** — the per-day budget for creation fees.

With `seedSpeculations: true` but `maxDailyFeeUSDC: "0"` (the default), the MM still *tracks* seed markets but refuses every one at the post gate (`fee-budget-exhausted`) — it logs a clear WARNING at boot so you aren't left wondering why seeds never post. Set the fee budget only when you intend to spend real USDC seeding.

- **Seeding spends USDC.** Each seed speculation costs the maker a one-time creation-fee share when its commitment lazily *creates* the speculation (its first match, if no one else created it first). `maxDailyFeeUSDC` caps that spend per UTC day; once the budget is exhausted, further seeds refuse (`fee-budget-exhausted`) until the next day. The cap is **conservative** — it counts the fee of seeds you've already posted but that haven't matched yet (each will owe its fee at match), so several seeds posted at once can't collectively blow past the budget. Budget it deliberately.
- **The reported seed-fee figure is an estimate, not exact realized spend.** The MM can't observe from the data it has whether a given match actually triggered the on-chain creation (and so paid the fee). It assumes its seed's first match created the speculation — exact when you're the only one seeding that line, but in the rare case another maker created the same speculation first, your seed matches into the existing one and pays *no* fee, while the MM still records the estimate. So `status`/`summary` seed-fee figures can over-state by at most one fee per such speculation. They are reported separately and are never folded into realized P&L.
- **A `TreasuryModule` allowance is approved at boot.** With seeding live and `autoApprove` on, the MM raises a `TreasuryModule` USDC allowance (the creation fee is pulled from it at match) — **raise-only, bounded by your wallet balance**, so the allowance is never the binding constraint (the per-day `maxDailyFeeUSDC` budget is). It is gas-gated like the `PositionModule` approve and emits an `approval` event (`purpose: 'treasuryModule'`). If `autoApprove` is off, approve the `TreasuryModule` allowance yourself before enabling seeding, or every seed match reverts.
- **A fee-short wallet is money-safe (not stranding).** The creation fee is charged *inside* the match transaction with no fallback, so if your wallet can't cover it the whole match **reverts atomically** — you lose nothing, but the seed never matches (and the taker wastes gas). The per-side `canSpendFee` pre-flight is the budget gate; there is intentionally no separate funding-guard reservation for the seed fee.
- **A seed is byte-identical to a normal quote once its speculation exists.** When a real speculation appears at a seed's line (yours via a match, or anyone's), discovery re-binds the tracked market to it and quotes it normally — no more fee, no placeholder.

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

- The MM keeps its inventory in JSON files under `state.dir`, including the set of quotes it has soft-cancelled-but-not-yet-expired. That soft-cancelled set is the one thing it can't rebuild from chain/API. **One MM per `state.dir` — now enforced.** Both `run` and `cancel-stale` take a single-process lock (`state.dir/maker.lock`) at boot, so a second instance against the same directory is **refused** (the refusal names the live holder — pid, host, maker wallet, run id) rather than silently corrupting `maker-state.json`. This is the mechanism behind the cancel-stale "STOP `run --live` FIRST" rule: cancel-stale shares the same lock, so it refuses while a `run` loop is live. Read-only commands (`status`, `doctor`) take no lock and can inspect a running MM freely.
  - **Stale lock after a crash.** If a run is killed hard (SIGKILL, power loss) it can leave the lock file behind. The next `run` / `cancel-stale` reclaims it automatically **only** when the recorded process is verifiably dead on the same host. If the lock was created on a *different* host (a shared `state.dir` across machines — unsupported) or is unparseable, the command fails closed; once you've confirmed no MM is running against that directory, remove `state.dir/maker.lock` by hand and retry. The lock file is not sensitive (it carries no signing material — only a wallet address, hostname, and config path).
  - If the state file is lost or corrupted between runs, the MM will not resume quoting on a blank slate (it would under-count latent exposure) — it reconstructs from telemetry, or waits one `expirySeconds` window, or you pass an explicit override.

## Running more than one MM (on one host)

If you run more than one MM instance on the same machine, **give each instance its own `state.dir`, its own `telemetry.logDir`, and its own `killSwitchFile`** — plus its own wallet (see "One wallet per instance" if present, or simply: never point two instances at the same keystore). The `state.dir` lock enforces the first of these; the others are operator discipline.

- **`state.dir`** — lock-enforced (a second instance on the same `state.dir` is refused). Already covered above.
- **`telemetry.logDir`** — give each instance its own. Both `run --live` and `cancel-stale` now stamp the **maker wallet on every telemetry line**, so even a shared log dir is attributable per instance, and each command's boot-time state-loss fail-safe scopes its "a prior run happened" check to *this* instance's maker — a sibling's logs in a shared dir no longer false-trip the hold (which used to push operators toward `--ignore-missing-state`, the exact override that defeats the real fail-safe). Separate dirs are still cleaner for reading/scorecards. (Note: a live run upgraded from a pre-this-release version whose old logs carry no maker field won't have those legacy logs counted — rely on the `state.dir` lock / state file across that one-time boundary.)
- **`killSwitchFile`** — this is the subtle one at N>1:
  - A **shared** kill file (the default `./KILL`, when every instance is launched from the same working directory) is a **fleet kill**: dropping `./KILL` stops *every* instance polling that path. There is no separate per-instance switch in that layout.
  - A **per-instance** kill file (a distinct `killSwitchFile` per instance) is a **per-instance switch** — and then there is **no single fleet-wide file** to stop them all at once (you drop each instance's file, or signal each process).
  - **Latency:** the kill file is polled once per tick, so a dropped file takes effect within up to one `ownState.auditPollIntervalMs` (default ~60 s). For an immediate stop, send **SIGINT/SIGTERM** — always per-process and acted on at the next safe point (it triggers the same graceful cancel-sweep).
- **SSE connection budget** — the core-api per-IP stream cap is per **host**, shared across all co-located instances. Size it for the fleet: `MAX_STREAM_CONNECTIONS_PER_IP ≥ N·(odds.maxRealtimeChannels + 1)`. See DESIGN §3 "SSE connection budget".

## Sensitive local state

The state file under `state.dir/maker-state.json` is **sensitive operator state**. Each commitment record persists the SDK's signed EIP-712 payload — the same input a taker uses to fill that commitment on chain. Anyone with read access to this file can fill your still-matchable commitments until they expire / fill / are cancelled. Treat `state.dir` like a wallet directory, not a log directory.

- **Keep `state.dir` outside the repo working tree.** Point it at an absolute path outside this clone (e.g. `/var/lib/ospex-mm/state`), not a directory under the repo. The committed `.gitignore` ignores only the literal `./state/`, `./telemetry/`, and `./KILL` (root-anchored so they don't also ignore `src/state/` etc.); a `state.dir` under any *other* in-repo name (`./live-state/`, `./canary-state/`, …) is **not** ignored and would commit `maker-state.json` — and its signed payloads — into git history.
- **Never paste `maker-state.json` (or any subset of it) into issues, PRs, chat, screenshots, or shared logs.** The signed payload is a bearer credential. Redact `signedPayload` / `signature` / the inner `commitment` struct before sharing anything from this file.
- **Linux / macOS production.** The MM creates the state file at mode `0600` (owner read/write only) automatically — and **the flush fails closed if it can't.** The temp file is created via `open(O_CREAT|O_EXCL, mode=0o600)` so the mode applies at the kernel-level syscall (no permissive-mode window). On a filesystem that silently drops mode bits (FAT, certain network mounts), the flush throws rather than publishing weak-mode state. Verify with `ls -l state.dir/`. Run under a dedicated unprivileged user; restrict the parent directory.
- **Windows production.** The MM cannot set POSIX mode bits — you must restrict the parent directory ACL yourself (e.g. via `icacls`). At minimum: deny `Everyone`, allow only the operator account.
- **Backups.** If you back up `state.dir`, the backup destination must be encrypted at rest and at least as locked down as the live directory. A copy on an unencrypted cloud drive is a leak.
- **Disposal.** When retiring a state directory (decommissioning an MM, rotating keys), shred the file — a simple `rm` may leave recoverable signed payloads. Use `shred` (Linux) or `cipher /w` (Windows).
- **Telemetry / scorecard outputs** under `telemetry.logDir` are projected through allow-list helpers, and `EventLog.emit` enforces two boundary defences: denied keys (`signature` / `signedPayload` / `commitment` / `nonce`) throw, and sensitive string substrings (a 65-byte ECDSA signature pattern, JSON-shape signature/signedPayload markers) are redacted to `[REDACTED]` tags before serialization. So even an RPC error message that happens to quote signed bytes will land in the NDJSON with the signature redacted. Telemetry outputs are safe to share for debugging. If a third-party tool ever dumps a `MakerCommitmentRecord` to a log of its own, treat that log the same as `state.dir`.

## Migration from a pre-0.5.1 MM (state file with no `signedPayload`)

If you're upgrading from an older release, your existing `maker-state.json` was written before the MM persisted signed payloads. The new MM loads it cleanly — each commitment record gets `signedPayloadStatus: 'missing-legacy'` on first read — but the cancel paths behave differently per commitment lifecycle:

- **`visibleOpen` / `partiallyFilled` (still visible on the API).** Cancel paths fall back to `cancelOnchain({ hash })`: the SDK fetches the row from the public commitments API and reconstructs the signed bundle there. No operator action needed.
- **`softCancelled` (book-hidden — pulled from the API but still matchable on chain until expiry).** This is the hazardous case. The public commitments API redacts the signed payload for hidden rows, so `cancelOnchain({ hash })` has no recovery path. The MM emits a `cancel-blocked-missing-payload` telemetry event for each such record and waits for operator action.

**What to do for each blocked record:**

1. Check the telemetry: `grep cancel-blocked-missing-payload telemetry.logDir/run-*.ndjson | jq .` — the events carry `commitmentHash` / `speculationId` / `contestId` / `makerSide` / `lifecycle` / `phase` (`shutdown-kill` / `cli-cancel-stale` / unset for the routine recovered-soft-cancel sweep).
2. Verify the record's expiry: `ospex-mm status` shows the commitment's `expiryUnixSec`. If it's in the past or near-past, the commitment is no longer matchable on chain — no action needed; let the next tick reconcile.
3. If the expiry is far enough out to matter, your options are:
   - **Wait it out.** With the recommended `expiryMode: fixed-seconds` + `expirySeconds: 120`, every legacy hidden record is dead within ~2 minutes of the prior MM's last soft-cancel. Confirm by re-running `cancel-stale` after the window passes — the blocked events should stop.
   - **Raise the nonce floor.** `MatchingModule.raiseMinNonce(newFloor)` invalidates every commitment with nonce < `newFloor` for your address; you can use a block explorer / `cast send` to call it manually. Confirm the floor is above the affected records' nonces (you can get those from the on-chain `Commitment` event log for your address).
   - **Recover the signed payload via owner-auth own-state.** The SDK's `client.ownState.getCommitment({ address, hash })` returns the full `OwnerCommitment` — including `signedPayload` — for the maker's own hidden rows (the public API redacts them; the owner-auth surface does not). You can pass that payload to `client.commitments.cancelOnchainSigned(...)` programmatically to authoritatively cancel the record. The MM does not yet wire this recovery into its cancel paths automatically, so it is a manual/scripted step; the wait-or-raise-nonce-floor options above remain the no-code path.

Once a hidden record is no longer matchable (expired, nonce-invalidated, or filled), it's safe to ignore: the next reconcile transitions it out of `softCancelled` and removes it from the blocked set.

## If something goes wrong

1. Kill switch (drop the `KILL` file).
2. `ospex-mm status` and the telemetry log under `telemetry.logDir` — what's open, what's filled, what errored.
3. `ospex-mm cancel-stale` (off-chain) — or `ospex-mm cancel-stale --authoritative` (on-chain, costs gas) if you need quotes invalidated *now*. **Stop `run --live` first** — the JSON state file isn't multi-process safe, so a concurrent runner would race on the flush. The off-chain leg pulls every stale `visibleOpen` commitment from the API book (gasless). A `partiallyFilled` remainder is **skipped** off-chain — the API rejects a DELETE once a commitment has matched (`409 COMMITMENT_MATCHED`) — so a matched commitment's remaining capacity is invalidated **only** by `--authoritative` (or natural expiry); `softCancelled` records are likewise a no-op for the API but stay matchable on chain until expiry. `--authoritative` additionally calls `cancelCommitmentOnchain` per non-terminal record — including `partiallyFilled` — (gas-gated with `mayUseReserve: true`, drawn from the emergency reserve — operator-explicit). The command mirrors the runner's state-loss fail-safe: refuses if `maker-state.json` is missing while prior telemetry exists, unless you pass `--ignore-missing-state` (attesting no prior soft-cancelled commitment is still matchable).
4. If you're locked out of settle/claim because you're out of POL — top up the wallet, then `ospex-mm status` / claim again.

## Reporting issues

SDK / CLI / market-maker bugs → this repo's issues (security issues: see [`../SECURITY.md`](../SECURITY.md)). Smart-contract security issues → the Ospex contracts repository.
