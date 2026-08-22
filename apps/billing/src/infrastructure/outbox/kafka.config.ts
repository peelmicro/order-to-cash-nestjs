// COPY OF — apps/orders/src/infrastructure/outbox/kafka.config.ts
// Configuration for the relay's kafkajs producer (design.md §9.3), read
// from the process environment (see .env.example § Outbox relay).
// `ORDERS_FACTS_TOPIC` -> `BILLING_FACTS_TOPIC`, `KAFKA_CLIENT_ID` ->
// `BILLING_KAFKA_CLIENT_ID` (default `otc-billing`) — the two edits against
// the Orders original, deliberately NOT parity-guarded (design.md §9.3): it
// IS the per-service difference.
//
// `BILLING_FACTS_TOPIC` is a constant, never derived at runtime from
// `specs/shared/asyncapi.yaml` (that would need a YAML parser dependency
// this service does not otherwise need) — instead it is guarded by
// `kafka.config.spec.ts`, which reads the spec as text and asserts this
// constant equals the `billingFacts` channel's `bindings.kafka.topic`.
export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
}

export const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';
// design.md §9.2 (billing_credit) — the service-neutral alias the canonical
// kafka-fact-publisher.ts imports instead of `BILLING_FACTS_TOPIC` directly.
export const FACTS_TOPIC = BILLING_FACTS_TOPIC;

export function loadKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    brokers,
    clientId: env.BILLING_KAFKA_CLIENT_ID ?? 'otc-billing',
  };
}
