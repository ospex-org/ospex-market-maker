/**
 * Configuration loading + validation.
 *
 * The full config schema is in docs/DESIGN.md §7 (and the annotated
 * `ospex-mm.example.yaml` at the repo root). Phase 1 implements `loadConfig`:
 * parse YAML, apply env overrides, validate, and fail fast with a clear
 * message on invalid / missing required values.
 */

export interface Config {
  // Filled in during Phase 1 — see docs/DESIGN.md §7 for the full shape.
  readonly _scaffold?: never;
}

export function loadConfig(_path: string): Config {
  throw new Error('loadConfig: not yet implemented (v0 scaffold) — see docs/DESIGN.md §7');
}
