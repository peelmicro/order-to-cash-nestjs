// Configuration for the Kafka CONSUMER transport main.ts connects
// (notification-facts.controller.ts) — same shape
// apps/orders/src/infrastructure/outbox/kafka.config.ts establishes for its
// producer/consumer pair, but this service is consumer-only: no
// `FACTS_TOPIC`/producer alias, because Notifications emits no fact and has
// no outbox (feature 23's scope — see progress/impl_notifications_service.md).
//
// The three topic constants are never derived at runtime from
// specs/shared/asyncapi.yaml (that would need a YAML parser this service
// does not otherwise need) — guarded instead by kafka.config.spec.ts, which
// reads the spec as text, same discipline as the orders/fulfillment
// originals.
export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly groupId: string;
}

export const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
export const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';
export const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';

export function loadKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    brokers,
    clientId: env.NOTIFICATIONS_KAFKA_CLIENT_ID ?? 'otc-notifications',
    groupId: env.NOTIFICATIONS_CONSUMER_GROUP ?? 'notifications',
  };
}
