# The house taker

`ospex-taker` consumes outside quotes at a bounded distance from the raw posted reference, under a cumulative-stakes cap. It is shadow by default; live use requires explicit configuration and the separate `--live` flag.

## Program boundary

`ospex-taker` is a second program in this repository, not a maker mode. It has its own configuration, dedicated wallet, state directory, exclusive process lock, and SIGINT/SIGTERM control. It never starts/stops the maker, imports its runner, cancels its quotes, settles/claims positions, tops up a wallet, changes allowances, or launches a service. SDK calls are isolated in `src/ospex/taker.ts`; the existing maker adapter only supplies the existing keystore-unlock helper. The policy and journal have no chain or wallet dependency.

`makers` is an explicit, nonempty list of outside makers; `houseWallets` is an explicit, nonempty list of all known house-controlled makers. Each has a label and controller. Self, house, unknown, duplicate and overlapping entries fail closed. A maker cannot be classified as independent merely because its address differs: The operator must verify controller ownership and keep the exclusion list complete. Every decision records the configured label/controller. The taker is always **house flow**, never independent demand; its records must remain separate from maker/model scorecards. No credential or wallet is inferred from the maker configuration or process environment.

## Price and size

Reference means the **raw market as posted**, on the exact contest, market, line and bettor side. It is not no-vig/fair probability. For a maker odds tick `t`, the opposite bettor side has decimal price `t / (t - 100)` and implied probability `(t - 100) / t`. For raw American reference odds `a`, implied probability is `100 / (a + 100)` for positive odds and `-a / (-a + 100)` for negative odds.

Take only when:

```
bettor implied probability - raw reference implied probability <= distancePp / 100
```

Equality passes; a better price always passes. This is a signed difference, not absolute distance. The posted reference must include a valid number for the exact bettor side; the other side is never complemented or substituted. Moneyline requires lineTicks zero; spread uses the **away** line multiplied by ten and requires complementary home/away lines; totals use their single line multiplied by ten. Side 0/1 flips for the taker (away/home or over/under). All reference timestamps must be parseable; no timestamp-age cutoff exists. An unchanged eight-hour-old reference is valid.

A cheap listed-quote price check rejects ineligible quotes before SDK preparation. This observation never authorizes signing. The live path gets a fresh deciding reference snapshot inside the signer guard, after SDK preflight/gas/nonce work and the final chain-capacity/allowance reads, immediately before durable decision/reservation and signing. It never rechecks the price after signing. The quote's ISO expiry must still be at least `minSecondsLeft` away at this decision (equality passes). Chain remaining maker capacity replaces stale indexer remaining capacity; the SDK preview must show the complete remaining lot. No desired partial amount is supplied. Price is checked before budget. If an otherwise price-eligible full quote exceeds remaining budget, record its excess and keep looking for another full-size quote—never clip it.

## Cap, allowance and uncertainty

`capUSDC` is required, positive, quoted, and has at most six decimal places. It is **cumulative successful taker stakes for this one dedicated taker**, not daily P&L, balance or net losses. Winnings, deposits, restarts and an allowance increase do not replenish it. Never share the wallet with another writer or run the same wallet under multiple state directories; the lock protects one canonical directory, not arbitrary copies. There is no per-game, per-maker, daily or sport cap.

Before initial live signing, PositionModule allowance must equal the configured cap exactly. Thereafter it must be finite, no greater than the cap, and sufficient for the full stake. TreasuryModule allowance must also be finite and no greater than the cap. The SDK separately enforces any lazy-creation fee approval. The taker has **no approval write path**. Fees/gas are not betting stakes and are not counted as stakes; wallet funding and any finite creation-fee allowance require a separate manual decision. Excess/unlimited approval is rejected rather than reduced by the taker.

The append-only private journal uses fsync, sequence numbers and a hash chain. A take reserves its full stake **before signing**. The signed transaction's deterministic hash and nonce are fsynced before signed bytes can return to the SDK broadcaster. Signed bytes and maker signatures never enter the journal or output. A broadcast timeout, RPC error, absent/ambiguous receipt or crash never releases a reservation or triggers a resend. Missing/corrupt journals and stale locks do not auto-reset. A decision that survived a crash without a hash stays held until explicit reconciliation: the durable-before-handoff invariant proves its signed bytes never reached the broadcaster.

Only an exact receipt for the journaled hash, sender and MatchingModule target can complete a take. Successful receipts must carry the exact commitment/maker/taker/contest/scorer/line/side/odds event and a stake within the reservation. Reverted receipts charge zero stake. The receipt block must be at/below the RPC's `finalized` block and its hash must still be canonical. Unsupported finality, unproven replacements, orphaned blocks and unknown outcomes remain held. This deliberately sacrifices throughput rather than guessing a financial outcome.

At the cap, the process holds taking and states the cap, spent, reserved, remaining, the smallest price-eligible quote requirement (or explicitly says no next quote was evaluated), and that **only the taker holds; the maker and everything else keep running**. If no quote fits remaining headroom it reports that, not a false claim that all headroom was spent. To increase budget, stop only the taker, edit the cap and set finite allowance manually under a separate authorization, preserve the same journal, and restart. Reconcile pending outcomes first. There is no cap reset command. Explicit signer-free reconciliation can release an unsigned reservation, or a signed reservation with finalized proof of a different same-chain, same-wallet, same-nonce zero-value self-transfer. The replacement must have empty calldata, no authorization list and no receipt logs; replacements that could themselves spend funds stay held. Its receipt and inclusion block must agree, include the exact replacement hash, and be below a rechecked finalized anchor. A merely advanced nonce, missing hash, timeout or pending replacement is not proof.

## Commands and evidence

After build, `node dist/taker/cli.js --help` and `yarn taker --help` describe the separate CLI. The package also exports `ospex-taker`.

- `init --config <file>` creates a **new shadow** journal, exclusively. It must never be used to bypass missing history.
- `status --config <file>` reads local counters and pending decision IDs; it does not open a wallet or make network calls. It currently requires the exclusive lock, so stop the runner first.
- `reconcile --config <file> --id <decision-id>` explicitly releases an unsigned reservation. For a signed attempt, add `--replacement-hash <hash>` for the narrowly accepted finalized self-transfer proof, unless its original final receipt is available. It never unlocks a wallet, signs, broadcasts, approves, or changes historical spend without a proven original receipt. Select the live journal with both live keys. Preserve backups; do not hand-edit history.
- `run --config <file> --once` performs one shadow scan. Without `--once`, it polls.
- Live selection requires **both** `mode.dryRun: false` and `--live`, including selection of the live journal for `init`/`status`. Either key alone remains shadow. `init`/`status` never unlock/sign even when selecting that journal.
- Live `run` additionally needs the dedicated keystore and `OSPEX_TAKER_PASSPHRASE` privately in that process's environment. Never pass a secret on the command line. The environment entry is deleted after unlock. No key or passphrase is supplied by the example.
- SIGINT/SIGTERM stops only this process. A transaction already handed off is not cancelled. A stop arriving after signing preserves the hash and blocks further SDK handoff when still possible; otherwise the pending record remains for next-start reconciliation.

The example deliberately uses invalid endpoint domains and synthetic addresses; it cannot run on a network without an operator replacing them. Start distance is zero for a first real run; the example's one-pp value is explicitly test-only. Relative state/keystore paths resolve against the config file, not the working directory.

Journal rows are linked by decision ID:

- `decision`: observation time; exact quote identity/odds/expiry; raw reference and its timestamps; bettor-side decimal price (its reciprocal is implied probability); configured `distanceLimitPp` and actual signed `decision.distancePp`; complete stake; cap; maker label/controller; dry-run flag; take or plain-language pass reason. Its transaction fields are null because no signed transaction exists at the decision boundary.
- `signed`: same ID, hash, nonce, signing-record time, and `submissionAt` (SDK handoff time, **not proof of RPC acceptance**).
- `outcome`: same ID/hash, success/revert, actual charged stake, receipt acquisition time, inclusion time, block number/hash. Unresolved outcomes remain visibly pending rather than becoming fabricated failures.
- `released`: same decision ID and the unsigned or finalized replacement proof. Removes only that reservation, never historical spend.

Unchanged pass/shadow observations are suppressed per currently listed quote; quote/reference/decision changes are recorded. Poll capture time and the expiry countdown alone do not append rows. The cache is pruned when quotes leave the book and never authorizes signing. Replay streams bounded chunks and rows (at most 1 MiB per row), retaining counters, open attempts, the chain tip and successful quote hashes, not completed decision payloads. Historical v1 rows remain readable without a reset or migration.

The example polls every 30 seconds. A failed book read produces a retry notice and waits for the configured interval without taking or exiting. Approximate API cost per poll is one list request per maker/page plus one reference read per cheaply rejected quote; eligible quotes still require SDK preparation and a fresh deciding reference. This is not a global rate limiter: other clients on the same egress IP share its read budget, and large maker/quote lists need a longer interval.

Passes carry no transaction hash. Shadow takes are hypothetical decisions, with no reservation, signing, approval or live spend. The raw reference is retained even for passes where no comparison could be made; missing data stays null. Local failures report safe `TAKER_CONFIG`, `TAKER_LOCK`, `TAKER_STATE`, `TAKER_JOURNAL`, `TAKER_RECONCILE` or `TAKER_KEYSTORE` classifications and recovery text. Unknown errors report `TAKER_RUNTIME`; raw SDK/keystore causes are never printed because they can contain signed bytes or RPC credentials.

Keep journal/state private. Back up the canonical journal; do not copy it into a second writer or publish it wholesale. Hash chaining detects corruption/order changes, not an administrator deliberately restoring a valid stale backup. Recovery and stale-lock removal are manual, after proving the old process is dead and reconciling chain outcomes; ambiguous evidence remains held rather than being automatically repaired.

## Verification boundary

Tests use synthetic quotes, mocked transports and deliberately invalid signing stubs—no wallet, credentials or live transaction. Adapter economics tests call the actual pinned SDK's `buildMatchPreview` producer and compare full-size taker economics. Other tests cover price semantics, exact lines/sides, expiry, old reference timestamps, caps, crash/restart holds, finality and receipt identity, signer handoff ordering, true process lock contention, maker-state isolation and shadow behavior. CI builds/types/lints/tests/scans the repository and smoke-tests both CLIs. None of that is mainnet or deployment evidence.
