# Security

This is **experimental software** with **financial risk**. Read [`docs/OPERATOR_SAFETY.md`](docs/OPERATOR_SAFETY.md) before running it against real funds.

## Reporting a vulnerability

- **`ospex-market-maker` or `@ospex/sdk` issues** — please report privately rather than opening a public issue: open a [GitHub security advisory](https://github.com/ospex-org/ospex-market-maker/security/advisories/new) on this repo (or contact the maintainers directly). Include a description, affected versions/commits, and a minimal reproduction if you have one.
- **Ospex smart-contract issues** — these go through the Ospex contracts repository's process, not here.

## Scope notes

- The market maker never asks for or persists a raw private key in its public interface — it delegates signing to a Foundry keystore via `@ospex/sdk`, prompting for the passphrase when a signature is needed. A report that the MM logs or leaks key material is in scope and high-priority.
- Post-M6/A, the MM persists the SDK's canonical signed EIP-712 commitment bundle (`signedPayload`) in `state.dir/maker-state.json` — the same input `MatchingModule.matchCommitment` needs to fill the commitment. This is a bearer credential. The state file is written at POSIX mode `0o600` from birth; the telemetry NDJSON writer fails closed on the matching object keys and redacts 65-byte ECDSA signature substrings in string values; CI runs `yarn secret-scan` to block accidentally-committed signing material. **A path that leaks `signedPayload` / `signature` / inner-`commitment` material from any artifact channel (telemetry, scorecard, logs, debug dumps, packed CLI envelopes) is in scope and high-priority.** Operator pasting of `state.dir` contents into shared channels is an operator-discipline problem covered in `docs/OPERATOR_SAFETY.md`, not a vulnerability.
- Approvals: the MM approves USDC only to `PositionModule`, only when `approvals.autoApprove` is set, and only a finite computed amount unless `approvals.mode: unlimited` + `--yes`. A path that approves more than configured, or approves silently, is in scope.
- Off-chain cancel is *visibility-only* — it does not invalidate a signed commitment. That's documented behaviour, not a vulnerability; the mitigation is short quote expiries (see `docs/OPERATOR_SAFETY.md`).
