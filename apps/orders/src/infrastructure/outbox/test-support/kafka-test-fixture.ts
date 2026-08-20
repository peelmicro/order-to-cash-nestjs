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

/** Creates one Kafka topic with the same shape `infra/kafka/create-topics.sh` uses — explicit, never relying on broker auto-creation. */
export async function createTopic(brokers: readonly string[], topic: string): Promise<void> {
  const kafka = new Kafka({ clientId: 'otc-orders-test', brokers: [...brokers] });
  const admin: Admin = kafka.admin();
  await admin.connect();
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
  } finally {
    await admin.disconnect();
  }
}
