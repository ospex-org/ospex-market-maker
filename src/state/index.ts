/**
 * Persistent inventory.
 *
 * Each posted commitment tracked by hash through `visibleOpen` → (`softCancelled`
 * | `partiallyFilled` / `filled` | `expired` | `authoritativelyInvalidated`);
 * resulting positions; running P&L; daily POL-gas / fee counters. JSON files,
 * atomic writes (temp + rename), single-process. The `softCancelled` set is the
 * one piece of state not reconstructible from chain / API — the boot-time
 * fail-safe applies if it's missing or corrupt. See docs/DESIGN.md §12.
 */
export {};
