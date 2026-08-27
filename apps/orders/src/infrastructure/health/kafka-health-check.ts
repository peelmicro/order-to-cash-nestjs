// R60/OR6 — a genuine fact-stream reachability probe: `admin.connect()` +
// `admin.describeCluster()` against a DEDICATED, short-timeout, no-retry
// Kafka client — deliberately NOT the long-lived outbox/DLQ producer this
// service already owns (`kafka-fact-publisher.ts`/`kafka-dlq-publisher.ts`),
// whose kafkajs default retry/backoff (5 attempts, exponential, ~9s
// cumulative) would make a single "down" observation take many seconds.
// `retries: 0` + a 2s connection/request timeout bound every check to a
// couple of seconds regardless of broker state. A fresh `Admin` per check,
// connected and disconnected each time: never cached, never optimistic.
import { Kafka, type KafkaConfig as KafkaJsConfig } from 'kafkajs';
import type { HealthCheck, HealthCheckResult } from '../../application/ports/health-check.port';
import type { KafkaConfig } from '../outbox/kafka.config';

export const KAFKA_PROBE_TIMEOUT_MS = 2000;

export function createKafkaHealthClient(config: KafkaConfig): Kafka {
  const options: KafkaJsConfig = {
    clientId: `${config.clientId}-health`,
    brokers: [...config.brokers],
    connectionTimeout: KAFKA_PROBE_TIMEOUT_MS,
    requestTimeout: KAFKA_PROBE_TIMEOUT_MS,
    retry: { retries: 0 },
  };
  return new Kafka(options);
}

export class KafkaHealthCheck implements HealthCheck {
  readonly name = 'factStream';

  constructor(private readonly client: Kafka) {}

  async check(): Promise<HealthCheckResult> {
    const admin = this.client.admin();
    try {
      await admin.connect();
      await admin.describeCluster();
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }
}
