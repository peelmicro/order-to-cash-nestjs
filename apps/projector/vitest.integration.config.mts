import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real Kafka (apache/kafka:4.3.1)
// AND real MongoDB (mongo:8.3.8) AND real NATS (nats:2.14.5-alpine), the
// SAME pinned tags docker-compose.infra.yml uses, never mocked. Run via
// `pnpm --filter @otc/projector test:integration` (root alias: `pnpm
// test:integration`). Deliberately a separate config/gate from
// vitest.config.mts so `pnpm test`/`pnpm quality` stay fast and do not
// require a Docker daemon — same convention as apps/notifications/apps/orders.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Starting a Kafka container, a MongoDB container and (for a subset of
    // specs) a NATS container, and waiting for a consumer group to reach
    // Stable, comfortably exceeds vitest's default 5s test / 10s hook
    // timeouts on a cold image pull — adopted verbatim from
    // apps/notifications/apps/orders' own integration configs.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Several single-node KRaft brokers/consumer groups joining
    // concurrently across files has been observed elsewhere in this repo
    // (apps/orders, apps/fulfillment, apps/notifications) to race on
    // post-startup metadata/coordinator propagation. Integration tests are
    // already outside `pnpm quality`'s fast gate, so serialising files here
    // trades wall-clock time for determinism.
    fileParallelism: false,
  },
});
