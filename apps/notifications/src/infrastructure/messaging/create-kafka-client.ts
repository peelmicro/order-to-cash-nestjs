// Wraps the real kafkajs `Kafka` client as the narrow `KafkaClientLike`
// surface `KafkaDlqPublisher` depends on — same shape
// apps/orders/src/infrastructure/outbox/create-kafka-client.ts establishes
// for its own outbox producer. The only file in this service that imports
// `kafkajs` for its VALUE (not just its types) outside a test: this
// service's inbound consumer transport is opened by `@nestjs/microservices`
// itself (main.ts), never through this helper.
import { Kafka } from 'kafkajs';
import type { KafkaClientLike } from './kafka-dlq-publisher';
import type { KafkaConfig } from './kafka.config';

export function createKafkaClient(config: KafkaConfig): KafkaClientLike {
  return new Kafka({ clientId: config.clientId, brokers: [...config.brokers] });
}
