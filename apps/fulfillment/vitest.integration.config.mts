import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real MySQL (mysql:8.4.11, the
// SAME pinned image docker-compose.infra.yml uses), never mocked. Run via
// `pnpm --filter @otc/fulfillment test:integration` (root alias: `pnpm
// test:integration`). Deliberately a separate config/gate from
// vitest.config.mts so `pnpm test`/`pnpm quality` stay fast and do not
// require a Docker daemon — same convention as apps/orders, see
// progress/impl_db_orders.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Starting a MySQL container, running migrations and round-tripping
    // every table comfortably exceeds vitest's default 5s test / 10s hook
    // timeouts on a cold Docker image pull.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
