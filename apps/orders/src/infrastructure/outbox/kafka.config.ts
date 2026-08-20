// Configuration for the relay's kafkajs producer (design.md §5.3, §8), read
// from the process environment (see .env.example § Outbox relay). Plain
// parts, explicit defaults, the same shape `db-config.ts` already
// established.
//
// `ORDERS_FACTS_TOPIC` is a constant, never derived at runtime from
// `specs/shared/asyncapi.yaml` (that would need a YAML parser dependency
// this service does not otherwise need) — instead it is guarded by
// `kafka.config.spec.ts`, which reads the spec as text and asserts this
// constant equals the `ordersFacts` channel's `bindings.kafka.topic`.
export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
}

export const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';

export function loadKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    brokers,
    clientId: env.KAFKA_CLIENT_ID ?? 'otc-orders',
  };
}
