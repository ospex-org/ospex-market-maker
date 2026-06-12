# Changelog

All notable changes to `ospex-market-maker` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semver](https://semver.org/) — pre-1.0, a minor bump may change the CLI or config surface.

## [Unreleased]

### Added

- `ospex-mm candidates [--sport <sport>] [--hours <n>] [--json]` — a **read-only, signer-free** operator preflight (no keystore, no passphrase prompt, no writes) that lists **both quote candidates and setup candidates** in one pass. Each in-window game/contest gets exactly one classification: `quote_ready` (contest `verified` + open `moneyline` speculation + reference odds present when `requireReferenceOdds`), `needs_moneyline_speculation` (verified, no open moneyline speculation), `needs_verification` (contest created but not yet verified), `setup` (game upcoming with `contestCreated=false`, `canCreateContest=true`, `hasOdds=true`), or `skipped` with a reason (`started-or-live` / `no-odds` / `no-reference-odds` / `cannot-create-contest` / `deny-list` / `not-quotable-status` / `game-status-postponed-or-cancelled`). `--json` emits a `{ schemaVersion: 1, candidates: … }` envelope (items sorted by kind priority then matchTime; `truncated: true` when a pagination bound was hit). `--hours` accepts 1–720 (the games API max); the contests leg is capped at the contests API max of 168h — `config.contestsHours` in the envelope carries the effective value — so a long window still returns the full games/setup side instead of failing on the narrower contests endpoint. The allow-list annotates contest-backed items with `inContestAllowList` but never hides them; the deny-list skips. An empty listing is a valid answer and exits 0. See `AGENTS.md` §2.7 for the envelope schema.
- `OspexAdapter.listGames` over the SDK's `client.games.list` (`@ospex/sdk` ≥ 0.6.x games surface) — full-schedule reads pass `availableOnly: false` explicitly; the games rows' provider-named `externalIds` are dropped at the adapter boundary (`GameView`) and never surfaced in CLI output.

## [0.1.0-alpha.1] — 2026-06-12

First tagged release. The full v0 command surface is implemented (793 unit tests) and the live path has been exercised end-to-end on Polygon mainnet in small, controlled runs — posting, partial fills, soft and on-chain cancels, expiry, stream reconnects, process restarts, and the score → settle → claim lifecycle. Distribution is clone-and-run at this tag; nothing is published to npm.

### Added

- The complete CLI surface: `doctor`, `quote --dry-run`, `run --dry-run`, `run --live`, `cancel-stale [--authoritative]`, `status`, and `summary` — each with a `--json` envelope where applicable; see the README "Current status" section and `AGENTS.md` for the report schemas.
- Pricing (vig strip → fair value → spread → two-sided quote), a worst-case-loss-by-outcome risk engine with per-commitment / contest / team / sport / bankroll caps, the order reconcile, persistent single-process JSON state, and NDJSON telemetry with `summary` aggregation including realized P&L.
- Live mode is own-state-stream-driven: the owner-authenticated SSE stream is the canonical writer of the maker's commitments, fills, and positions; per-tick polls survive only as an audit cross-check.
- Operator safety rails: two-key live gating (`mode.dryRun: false` AND `--live`), the boot-time state-loss fail-safe, wallet-bounded boot auto-approve (`exact` mode default), a daily POL gas budget with an emergency reserve, the funding guard, auto-settle / auto-claim, and an off-chain (plus optional on-chain) cancel sweep on shutdown.

### Alpha safety envelope

- **Moneyline only**, and only on speculations that already exist — the MM is not a speculation seeder.
- **Dry-run first.** `mode.dryRun: true` is the default; go live deliberately with tiny caps.
- **Single-process local state** — one MM process per state dir / maker wallet; the JSON state file is not multi-process safe.
- **An off-chain cancel removes a quote from the public book but does NOT invalidate the signed payload** — a taker already holding it can still match it until expiry (default ≈ 2 minutes). Remainder safety after a partial fill therefore relies on short expiries or the on-chain paths (`killCancelOnChain: true`, `cancel-stale --authoritative`).
- **No unrealized P&L yet** (realized P&L is wired); no `raiseMinNonce` bulk invalidation — on-chain cancels are per-commitment.
- **Bring your own RPC URL and Foundry keystore** — there are no defaults, and raw private keys are never accepted. `wallet.keystorePath` is used verbatim (`~` is not expanded; use an absolute path) and can stay blank until you go live.

### Pinned

- `@ospex/sdk` v0.6.2, resolved from its GitHub Release tarball (`package.json` / `yarn.lock` are the source of truth). Node ≥ 20.
