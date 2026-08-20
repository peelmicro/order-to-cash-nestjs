import { defineConfig } from 'vitest/config';

// Same split as every other app: fast, Docker-independent unit tests here
// (pnpm test / pnpm quality); Testcontainers integration specs live under
// vitest.integration.config.mts (pnpm test:integration) — see
// apps/orders/vitest.config.mts for the precedent this file follows.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 60,
        statements: 60,
        branches: 60,
        functions: 60,
      },
    },
  },
});
