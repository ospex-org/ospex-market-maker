/**
 * Telemetry: the append-only NDJSON event-log writer + the `ospex-mm summary`
 * aggregator. Every line is `{ ts, runId, kind, ...payload }`; values that can
 * exceed Number.MAX_SAFE_INTEGER are strings. The NDJSON shape is the stable
 * contract a future external scorecard reads. See docs/DESIGN.md §11.
 */
export {};
