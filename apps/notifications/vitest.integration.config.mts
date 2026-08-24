import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real Kafka (apache/kafka:4.3.1)
// AND real MySQL (mysql:8.4.11, notifications_service re-review N1/N2/N7),
// the SAME pinned tags docker-compose.infra.yml uses, never mocked. Run via
// `pnpm --filter @otc/notifications test:integration` (root alias: `pnpm
// test:integration`). Deliberately a separate config/gate from
// vitest.config.mts so `pnpm test`/`pnpm quality` stay fast and do not
// require a Docker daemon — same convention as apps/orders/apps/fulfillment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Starting a Kafka container AND a MySQL container (plus migrating the
    // latter from empty) and waiting for a consumer group to reach Stable
    // comfortably exceeds vitest's default 5s test / 10s hook timeouts on a
    // cold image pull — adopted verbatim from apps/fulfillment/apps/orders'
    // own integration configs (same class of Testcontainers pair).
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // The cross-restart spec (N7) starts TWO Kafka microservice apps in one
    // test — several single-node KRaft brokers/consumer groups joining
    // concurrently across files has been observed elsewhere in this repo
    // (apps/orders, apps/fulfillment) to race on post-startup
    // metadata/coordinator propagation. Integration tests are already
    // outside `pnpm quality`'s fast gate, so serialising files here trades
    // wall-clock time for determinism.
    fileParallelism: false,
  },
});
