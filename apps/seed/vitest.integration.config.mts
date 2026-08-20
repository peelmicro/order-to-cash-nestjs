import { defineConfig } from 'vitest/config';

// Testcontainers integration test — a real disposable MySQL (three logical
// databases on the one pinned mysql:8.4.11 container, same pattern as
// apps/orders/apps/fulfillment/apps/billing) plus a real disposable MongoDB
// (mongo:8.3.8, same pinned image as docker-compose.infra.yml). Runs the
// FULL seed twice to assert idempotency. Never mocked — CLAUDE.md § Testing
// conventions.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Two full seed runs (each: three sets of migrations + all writers +
    // Mongo) against cold containers comfortably exceeds vitest's defaults.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
