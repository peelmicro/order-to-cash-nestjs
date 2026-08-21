import { defineConfig } from 'vitest/config';

// Testcontainers integration tests only — real MySQL (mysql:8.4.11, the
// SAME pinned image docker-compose.infra.yml uses), never mocked. Run via
// `pnpm --filter @otc/orders test:integration` (root alias: `pnpm
// test:integration`). Deliberately a separate config/gate from
// vitest.config.mts so `pnpm test`/`pnpm quality` stay fast and do not
// require a Docker daemon — see progress/impl_db_orders.md for the decision
// record this repo's later db_* features (fulfillment, billing) should
// follow the same way.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Starting a MySQL container, running migrations and round-tripping
    // every table comfortably exceeds vitest's default 5s test / 10s hook
    // timeouts on a cold Docker image pull.
    //
    // 180_000 (post-approval hardening, 2026-08-21, saga_order_orchestrator
    // follow-up): raised from 120_000 so this file-level DEFAULT genuinely
    // exceeds the largest explicit per-test override in this app's saga
    // specs (150_000ms, saga-happy-path.integration.spec.ts and
    // saga-consumption.integration.spec.ts's SO1 case) — every `it()` in
    // the saga suites already sets its own explicit timeout that wins over
    // this value regardless, but a bare `it()` added later without one
    // should not silently fall back to a smaller ceiling than the suites it
    // sits next to.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // order_saga_orchestrator (feature 16) added several spec files that
    // each start their OWN MySQL + Kafka + NATS Testcontainers trio. Left
    // at vitest's default file-level parallelism, several of those trios
    // start their single-node KRaft Kafka brokers concurrently, and the
    // admin client's `createTopics`/`joinGroup` calls have been observed
    // to race against the broker's own post-startup metadata/coordinator
    // propagation under that concurrent load (`KafkaJSProtocolError: This
    // server does not host this topic-partition` / "coordinator not
    // available") — a resource-contention flake, not a functional bug
    // (every file passes reliably in isolation). Integration tests are
    // already outside `pnpm quality`'s fast gate, so serialising files
    // here trades wall-clock time for determinism.
    fileParallelism: false,
  },
});
