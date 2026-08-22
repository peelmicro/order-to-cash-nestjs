// COPY OF — apps/orders/src/infrastructure/outbox/kafka.config.ts
// Configuration for the relay's kafkajs producer (design.md §5.3, §8, §12),
// read from the process environment (see .env.example § Outbox relay).
// `ORDERS_FACTS_TOPIC` -> `FULFILLMENT_FACTS_TOPIC`, `KAFKA_CLIENT_ID` ->
// `FULFILLMENT_KAFKA_CLIENT_ID` (default `otc-fulfillment`) — the two edits
// against the Orders original (design.md §8.1).
//
// `FULFILLMENT_FACTS_TOPIC` is a constant, never derived at runtime from
// `specs/shared/asyncapi.yaml` (that would need a YAML parser dependency
// this service does not otherwise need) — instead it is guarded by
// `kafka.config.spec.ts`, which reads the spec as text and asserts this
// constant equals the `fulfillmentFacts` channel's `bindings.kafka.topic`.
export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
}

export const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';
// design.md §9.2 (billing_credit) — the service-neutral alias the canonical
// kafka-fact-publisher.ts imports instead of `FULFILLMENT_FACTS_TOPIC` directly.
export const FACTS_TOPIC = FULFILLMENT_FACTS_TOPIC;

export function loadKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    brokers,
    clientId: env.FULFILLMENT_KAFKA_CLIENT_ID ?? 'otc-fulfillment',
  };
}
