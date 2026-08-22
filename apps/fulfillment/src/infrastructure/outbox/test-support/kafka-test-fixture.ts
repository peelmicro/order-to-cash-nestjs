// COPY OF — apps/orders/src/infrastructure/outbox/test-support/kafka-test-fixture.ts
// Shared Testcontainers fixture for the relay's real-Kafka integration
// specs (design.md §9, §13). `apache/kafka:4.3.1`, the SAME pinned tag
// `docker-compose.infra.yml` uses.
//
// `@testcontainers/kafka`'s `KafkaContainer` targets the Confluent
// (`cp-kafka`) image family — its startup script shells out to
// `/etc/confluent/docker/run`, which the official `apache/kafka` image does
// not ship. This fixture therefore drives the SAME `apache/kafka:4.3.1` tag
// through a plain `GenericContainer`, with the explicit single-node KRaft
// environment `docker-compose.infra.yml`'s own `kafka` service already
// establishes — never a different image, never `latest`.
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
      // Explicit topic creation only — broker auto-creation would yield a
      // one-partition topic and make the R15 partitioning test vacuous.
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

// Kafkajs's `NODE_ENV=test` retry defaults are too short/coarse for a REAL,
// freshly-started single-node KRaft broker — see the Orders original's
// comment for the full reproduction. This override is explicit and
// TEST-ONLY: `main.ts` never runs with `NODE_ENV=test`.
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
 * `Stable` with at least one joined member — never a fixed `sleep`.
 */
export async function waitForConsumerGroupReady(
  brokers: readonly string[],
  groupId: string,
  timeoutMs = 60_000,
  intervalMs = 300,
): Promise<void> {
  const kafka = new Kafka({
    clientId: 'otc-fulfillment-test-group-readiness',
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
  const kafka = new Kafka({ clientId: 'otc-fulfillment-test', brokers: [...brokers], retry: { retries: 0 } });
  const admin: Admin = kafka.admin();
  await admin.connect();
  try {
    await createTopicWithRetry(admin, topic);
  } finally {
    await admin.disconnect();
  }
}
