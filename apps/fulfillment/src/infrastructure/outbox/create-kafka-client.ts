// COPY OF — apps/orders/src/infrastructure/outbox/create-kafka-client.ts
// Wraps the real kafkajs `Kafka` client as the narrow `KafkaClientLike`
// surface `KafkaFactPublisher` depends on. The only file in this service
// that imports `kafkajs` for its VALUE (not just its types) outside a test.
import { Kafka } from 'kafkajs';
import type { KafkaClientLike } from './kafka-fact-publisher';
import type { KafkaConfig } from './kafka.config';

export function createKafkaClient(config: KafkaConfig): KafkaClientLike {
  return new Kafka({ clientId: config.clientId, brokers: [...config.brokers] });
}
