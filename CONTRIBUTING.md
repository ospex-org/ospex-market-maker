# Contributing

PRs and issue reports welcome. This is a v0 scaffold under active development against [`docs/DESIGN.md`](docs/DESIGN.md) — that doc is the spec; align with it.

## Dev workflow

```bash
yarn install
yarn build          # tsc -> dist/
yarn typecheck      # tsc --noEmit
yarn test           # vitest
yarn lint           # eslint src
```

- **Branches and PRs only — never commit to `main`.** Create the branch before writing code.
- TypeScript is strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, no unused locals/params). New optional config fields need `| undefined` in their type. Avoid `any` — use `unknown`, specific interfaces, or generics.
- `yarn typecheck` must pass before you push.

## The `@ospex/sdk` dependency (interim)

The market maker is built on [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk), which is being prepared for public release. The genesis scaffold on `main` has **no** `@ospex/sdk` dependency, so `main` installs cleanly. Feature branches that implement the SDK-backed surface (`src/ospex/`, the `doctor` / `quote` / `run` commands) pin `@ospex/sdk` to an exact GitHub Release tarball URL — which only resolves once the SDK repo is public. Until then, to work on those branches you need the SDK available locally: build/pack it from a clone of `ospex-org/ospex-sdk` and `yarn add ./ospex-sdk-<ver>.tgz`, or use a workspace link. A `scripts/fetch-sdk` helper will be added alongside the dependency. CI on those branches will be red at the install step until the SDK is public — that's expected.

## Hard rules (from `docs/DESIGN.md`)

- **The MM never calls the Ospex contracts directly.** Everything goes through `@ospex/sdk`, and only `src/ospex/` imports it.
- **No upstream odds-provider names in committed files** — docs, README, code comments, CLI output, telemetry payloads, configs, examples. The SDK's provider-specific wire-field names are confined to `src/ospex/` and mapped to neutral terms (`referenceGameId` / `upstreamGameId`) everywhere else. See `docs/DESIGN.md §16`.
- **No flow / taker / observer / scorecard code here.** Those exist to exercise a market maker and prove the platform — they belong in a separate test harness, not in this repo. See `docs/DESIGN.md §16`.
- **No live write paths in Phase 1.** `submit` / cancel / approve are not implemented (not even behind a flag) until Phase 2+; the risk engine's latent-exposure and aggregate-allowance logic is implemented and unit-tested in Phase 1 anyway. See `docs/DESIGN.md §14`.
- **Safety defaults stay safe.** Don't loosen `mode.dryRun: true`, the two-key live model, the conservative caps, or the short-expiry default in the example config without a very good reason.

## Tests

New behaviour gets tests (`vitest`, under `tests/` or co-located `*.test.ts`). The pricing math, the risk engine's latent-exposure accounting, the aggregate-allowance target, and config-schema validation are the load-bearing units — keep their coverage tight. (`yarn test` runs `vitest run` — no `--passWithNoTests`; the suite must not be able to silently regress to zero tests.)
