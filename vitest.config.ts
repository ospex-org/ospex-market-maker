import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // genesis-scaffold only — once Phase 1 lands pricing/risk/config tests,
    // remove this (or add a CI guard) so the suite can't silently go to zero tests.
    passWithNoTests: true,
  },
});
