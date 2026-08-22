// COPY OF — apps/orders/src/infrastructure/outbox/test-support/kafka-test-fixture.ts
// Shared Testcontainers fixture for the relay's real-Kafka integration
// specs (E7-E11) — the first real Kafka in this repository's tests
// (design.md §9). `apache/kafka:4.3.1`, the SAME pinned tag
// `docker-compose.infra.yml` uses.
//
// `@testcontainers/kafka`'s `KafkaContainer` targets the Confluent
// (`cp-kafka`) image family — its startup script shells out to
// `/etc/confluent/docker/run`, which the official `apache/kafka` image does
// not ship. Per design.md §9's explicit fallback instruction, this fixture
// therefore drives the SAME `apache/kafka:4.3.1` tag through a plain
// `GenericContainer`, with the explicit single-node KRaft environment
// `docker-compose.infra.yml`'s own `kafka` service already establishes —
// never a different image, never `latest`.
//
// The host port is reserved BEFORE the container starts (via
// `testcontainers`'s own `RandomPortGenerator`) so `KAFKA_ADVERTISED_LISTENERS`
// can name it directly, rather than the run-time host-port-discovery script
// `@testcontainers/kafka` needs for the Confluent image.
import { Kafka, type Admin } from 'kafkajs';
import { GenericContainer, RandomPortGenerator, Wait, type StartedTestContainer } from 'testcontainers';

export const KAFKA_IMAGE = 'apache/kafka:4.3.1';
export const KAFKA_TOPIC_PARTITIONS = 6;
export const KAFKA_TOPIC_REPLICATION_FACTOR = 1;

const KAFKA_CONTAINER_PORT = 9092;
const KAFKA_CONTROLLER_PORT = 9093;

export interface KafkaTestFixture {
  readonly container: StartedTestContainer;
  readonly brokers: readonly string[];
  teardown(): Promise<void>;
}

export async function startKafkaTestFixture(): Promise<KafkaTestFixture> {
  const hostPort = await new RandomPortGenerator().generatePort();
  const advertised = `localhost:${hostPort}`;

  const container = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: KAFKA_CONTAINER_PORT, host: hostPort })
    .withEnvironment({
      CLUSTER_ID: 'b3JkZXItdG8tY2FzaC10',
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: `PLAINTEXT://:${KAFKA_CONTAINER_PORT},CONTROLLER://:${KAFKA_CONTROLLER_PORT}`,
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${advertised}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: `1@localhost:${KAFKA_CONTROLLER_PORT}`,
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: '1',
      // Explicit topic creation only (design.md §9) — broker auto-creation
      // would yield a one-partition topic and make the R15 partitioning
      // test vacuous.
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_LOG_DIRS: '/var/lib/kafka/data',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000)
    .start();

  return {
    container,
    brokers: [advertised],
    async teardown(): Promise<void> {
      await container.stop();
    },
  };
}

// Post-approval hardening (2026-08-21, follow-up to order_saga_orchestrator):
// vitest sets `NODE_ENV=test`, and kafkajs itself branches on that
// (`kafkajs/src/retry/index.js`: `isTestMode = process.env.NODE_ENV ===
// 'test'`) to swap its retry defaults for a set tuned for kafkajs's OWN
// mocked unit tests — `initialRetryTime: 50ms, maxRetryTime: 1000ms,
// retries: 15` (kafkajs/src/retry/defaults.test.js), a ~9.5s cumulative
// budget, capped at 1s per attempt. Verified directly: a probe spec run
// under this repo's `test:integration` config printed `NODE_ENV=test`.
// That budget is too short and too coarse for a REAL, freshly-started
// single-node KRaft broker (this fixture): `Wait.forLogMessage(/Kafka
// Server started/)` fires before the group-coordinator subsystem is
// necessarily ready, so the very first `consumer.connect()`/`run()` can
// hit `KafkaJSNumberOfRetriesExceeded: This is not the correct
// coordinator for this group` — and under concurrent load (several of
// this fixture's single-node brokers alive near-simultaneously across a
// full suite run) that "still loading" window can exceed 9.5s. Kafkajs's
// own NON-test defaults (`retries: 5, initialRetryTime: 300ms,
// maxRetryTime: 30_000ms`) are not much better in total (~9.3s) because
// only 5 attempts are allowed before the exponential backoff ever grows
// large. This override is explicit and TEST-ONLY: `main.ts` never runs
// with `NODE_ENV=test`, so production already gets kafkajs's sane
// production defaults and does not need it.
export const KAFKA_TEST_CLIENT_RETRY = {
  initialRetryTime: 300,
  maxRetryTime: 10_000,
  retries: 10,
  factor: 0.2,
  multiplier: 2,
} as const;

/**
 * Polls the broker (via a disposable admin client with retries disabled —
 * this function owns its own retry cadence via `intervalMs`, deliberately
 * NOT kafkajs's internal backoff) until consumer group `groupId` is
 * `Stable` with at least one joined member, i.e. the group has actually
 * finished forming and is ready to receive published facts — never a
 * fixed `sleep`. Used by `saga-integration-harness.ts` so every saga spec
 * pays the post-container-start "coordinator loading" cost inside
 * `beforeAll`'s generous hook budget, instead of inside a test's own
 * `waitFor` window.
 */
export async function waitForConsumerGroupReady(
  brokers: readonly string[],
  groupId: string,
  timeoutMs = 60_000,
  intervalMs = 300,
): Promise<void> {
  const kafka = new Kafka({
    clientId: 'otc-orders-test-group-readiness',
    brokers: [...brokers],
    retry: { retries: 0 },
  });
  const admin: Admin = kafka.admin();
  await admin.connect();
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const { groups } = await admin.describeGroups([groupId]);
        const group = groups[0];
        if (group && group.state === 'Stable' && group.members.length > 0) {
          return;
        }
      } catch {
        // The coordinator may still be loading, or the group may not
        // exist yet (first-ever subscription) — both are "not ready",
        // not a hard failure; keep polling until `timeoutMs`.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`waitForConsumerGroupReady: group "${groupId}" did not reach Stable (with members) within ${timeoutMs}ms`);
  } finally {
    await admin.disconnect();
  }
}

// Post-approval hardening (2026-08-21): reproduced directly (this spec
// failing in true isolation, no other containers competing) — on a
// single-node KRaft broker, `admin.createTopics({ waitForLeaders: true })`
// can throw `KafkaJSProtocolError: This server does not host this
// topic-partition` (kafkajs's `metadata()` call, right after the topic was
// just created, before partition-leader metadata has propagated). This is
// NOT the `LEADER_NOT_AVAILABLE` type kafkajs's own internal
// `retryOnLeaderNotAvailable` poll watches for, so kafkajs's admin code
// (`admin/index.js`) takes its OTHER branch — `bail(e)` — which aborts the
// whole outer retrier immediately, on the very FIRST attempt, regardless
// of any `retry` (retries/initialRetryTime/maxRetryTime) configured on the
// client. No client-level retry tuning can fix this; only an outer retry
// of the entire `createTopics` call can, which is what `createTopicWithRetry`
// below does — safe to repeat because a topic that already exists is
// swallowed by kafkajs itself (`TOPIC_ALREADY_EXISTS` -> `return false`,
// not an error).
async function createTopicWithRetry(admin: Admin, topic: string, attempts = 10, delayMs = 500): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await admin.createTopics({
        topics: [
          {
            topic,
            numPartitions: KAFKA_TOPIC_PARTITIONS,
            replicationFactor: KAFKA_TOPIC_REPLICATION_FACTOR,
          },
        ],
        waitForLeaders: true,
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Creates one Kafka topic with the same shape `infra/kafka/create-topics.sh` uses — explicit, never relying on broker auto-creation. */
export async function createTopic(brokers: readonly string[], topic: string): Promise<void> {
  // `retry: { retries: 0 }` — deliberately: kafkajs's own generic retry
  // does not apply to the failure mode above anyway (see
  // `createTopicWithRetry`'s comment), so leaving it at a non-zero value
  // would only stack an irrelevant delay in front of every OTHER
  // (genuinely retriable, e.g. `NOT_CONTROLLER`) admin error. All backoff
  // for this client is owned by `createTopicWithRetry`'s explicit loop.
  const kafka = new Kafka({ clientId: 'otc-orders-test', brokers: [...brokers], retry: { retries: 0 } });
  const admin: Admin = kafka.admin();
  await admin.connect();
  try {
    await createTopicWithRetry(admin, topic);
  } finally {
    await admin.disconnect();
  }
}
