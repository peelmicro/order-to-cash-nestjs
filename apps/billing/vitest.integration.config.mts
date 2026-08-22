import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real MySQL (mysql:8.4.11, the
// SAME pinned image docker-compose.infra.yml uses), never mocked. Run via
// `pnpm --filter @otc/billing test:integration` (root alias: `pnpm
// test:integration`). Deliberately a separate config/gate from
// vitest.config.mts so `pnpm test`/`pnpm quality` stay fast and do not
// require a Docker daemon — same convention as apps/orders / apps/fulfillment,
// see progress/impl_db_orders.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Starting a MySQL/NATS/Kafka container, running migrations and
    // round-tripping every table comfortably exceeds vitest's default 5s
    // test / 10s hook timeouts on a cold Docker image pull. 180_000/120_000
    // adopted verbatim from apps/orders'/apps/fulfillment's
    // vitest.integration.config.mts (design.md §13, task H7) — same class
    // of Testcontainers trio, same headroom needed.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Several spec files here each start their OWN MySQL + Kafka + NATS
    // Testcontainers trio. Left at vitest's default file-level parallelism,
    // several single-node KRaft Kafka brokers starting concurrently have
    // been observed (apps/orders, apps/fulfillment) to race against each
    // other's post-startup metadata/coordinator propagation — a
    // resource-contention flake, not a functional bug. Integration tests
    // are already outside `pnpm quality`'s fast gate, so serialising files
    // here trades wall-clock time for determinism.
    fileParallelism: false,
  },
});
