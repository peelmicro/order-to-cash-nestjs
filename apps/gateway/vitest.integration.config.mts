import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real NATS (nats:2.14.5-alpine)
// AND real MongoDB (mongo:8.3.8), the SAME pinned tags docker-compose.infra.yml
// uses, never mocked. Run via `pnpm --filter @otc/gateway test:integration`.
// Deliberately a separate config/gate from vitest.config.mts so `pnpm
// test`/`pnpm quality` stay fast and do not require a Docker daemon —
// same convention as apps/notifications/apps/orders/apps/projector.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
