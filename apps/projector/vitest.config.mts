import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Testcontainers integration specs run under
    // vitest.integration.config.mts only (`pnpm test:integration`) — they
    // need Docker and take real seconds, so `pnpm test`/`pnpm quality` (this
    // config) must stay fast and Docker-independent. Same convention as
    // apps/notifications/apps/orders.
    exclude: ['**/node_modules/**', 'src/**/*.integration.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Two-tier gate (phase 21, sonarqube_quality_gates — CLAUDE.md
      // "coverage gates enforced in `pnpm quality` independently of
      // SonarQube"): the domain layer is held to a higher bar than the rest
      // of the service, per-glob, so a well-covered infrastructure/
      // presentation layer can never mask a thin domain/. `pnpm quality`
      // now runs `test:coverage` (root package.json), so this is the live
      // gate, not a dormant number.
      thresholds: {
        'src/domain/**': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
