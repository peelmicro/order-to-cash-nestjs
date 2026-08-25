// Configuration for the Kafka CONSUMER transport main.ts connects
// (presentation/projector-facts.controller.ts) — same shape
// apps/notifications/src/infrastructure/messaging/kafka.config.ts
// establishes. Consumer-only: no `FACTS_TOPIC`/producer alias, because the
// projector emits no fact and has no outbox (design.md §1: "It answers
// nothing").
//
// The three topic constants are never derived at runtime from
// specs/shared/asyncapi.yaml (that would need a YAML parser this service
// does not otherwise need) — guarded instead by kafka.config.spec.ts, which
// reads the spec as text, same discipline as every other service's
// kafka.config.spec.ts.
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
    clientId: env.PROJECTOR_KAFKA_CLIENT_ID ?? 'otc-projector',
    groupId: env.PROJECTOR_CONSUMER_GROUP ?? 'projector',
  };
}
