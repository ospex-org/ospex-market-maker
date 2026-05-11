/**
 * The event loop: event-driven for odds (subscription callbacks mark markets
 * dirty), timer-driven for everything else (a `pollIntervalMs` tick). One runner
 * with a `dryRun` mode flag; the kill-switch check; graceful shutdown. See
 * docs/DESIGN.md §3 ("The event loop").
 */
export {};
