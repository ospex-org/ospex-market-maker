/**
 * Order lifecycle: build desired quotes, check the SDK submit preview (refuse on
 * a lazy-creation path), reconcile against actual open commitments, submit /
 * soft-cancel-and-repost / book-hygiene reconcile, plus the authoritative
 * (on-chain) cancel + nonce-floor paths used by the kill switch and
 * `cancel-stale --authoritative`. Phase 2+ — there are no live write paths in
 * Phase 1. See docs/DESIGN.md §9.
 */
export {};
