import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Testcontainers integration specs run under
    // vitest.integration.config.mts only (`pnpm test:integration`) — they
    // need Docker and take real seconds, so `pnpm test`/`pnpm quality` (this
    // config) must stay fast and Docker-independent. Same decision as
    // apps/orders — see progress/impl_db_orders.md.
    exclude: ['**/node_modules/**', 'src/**/*.integration.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Numbers wired now per CLAUDE.md; not enforced-failing until phase 21
      // (sonarqube_quality_gates) — `vitest run` (the default `test` script)
      // does not compute coverage at all, only `test:coverage` does, and
      // thresholds only fail *that* invocation.
      thresholds: {
        lines: 60,
        statements: 60,
        branches: 60,
        functions: 60,
      },
    },
  },
});
