// The closed set of Notifications consumer names the idempotent-consumer
// pattern dedups by (specs/shared/saga.md §6, layer 1: "the projector, the
// orchestrator and notifications must each process the same fact exactly
// once, independently"). Same shape as
// apps/fulfillment/src/application/ports/consumer-name.ts /
// apps/orders/src/application/ports/consumer-name.ts, but with exactly ONE
// member: this service has a single undifferentiated inbound stream (all
// seven notified facts share the same dedup identity), unlike Orders'
// `orders.saga`, which is also its Kafka consumer group id.
export const CONSUMER_NAMES = ['notifications'] as const;

export type ConsumerName = (typeof CONSUMER_NAMES)[number];

export function isConsumerName(value: unknown): value is ConsumerName {
  return typeof value === 'string' && (CONSUMER_NAMES as readonly string[]).includes(value);
}
