// The closed set of the projector's idempotent-consumer dedup identities
// (specs/shared/saga.md §6, layer 1: "the projector, the orchestrator and
// notifications must each process the same fact exactly once,
// independently"). Same shape as apps/notifications' own
// application/ports/consumer-name.ts: one undifferentiated inbound stream
// (all thirteen facts share the same dedup identity), one member.
export const CONSUMER_NAMES = ['projector'] as const;

export type ConsumerName = (typeof CONSUMER_NAMES)[number];

export function isConsumerName(value: unknown): value is ConsumerName {
  return typeof value === 'string' && (CONSUMER_NAMES as readonly string[]).includes(value);
}
