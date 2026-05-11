# Security

This is **experimental software** with **financial risk**. Read [`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md) before running it against real funds.

## Reporting a vulnerability

- **`ospex-market-maker` or `@ospex/sdk` issues** — please report privately rather than opening a public issue: open a [GitHub security advisory](https://github.com/ospex-org/ospex-market-maker/security/advisories/new) on this repo (or contact the maintainers directly). Include a description, affected versions/commits, and a minimal reproduction if you have one.
- **Ospex smart-contract issues** — these go through the Ospex contracts repository's process, not here.

## Scope notes

- The market maker never asks for or persists a raw private key in its public interface — it delegates signing to a Foundry keystore via `@ospex/sdk`, prompting for the passphrase when a signature is needed. A report that the MM logs or leaks key material is in scope and high-priority.
- Approvals: the MM approves USDC only to `PositionModule`, only when `approvals.autoApprove` is set, and only a finite computed amount unless `approvals.mode: unlimited` + `--yes`. A path that approves more than configured, or approves silently, is in scope.
- Off-chain cancel is *visibility-only* — it does not invalidate a signed commitment. That's documented behaviour, not a vulnerability; the mitigation is short quote expiries (see `docs/OPERATOR_SAFETY.md`).
