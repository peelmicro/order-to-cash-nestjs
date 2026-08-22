// The closed set of Billing consumer names the idempotent-consumer pattern
// dedups by (outbox_and_idempotency design.md §6.1, `specs/shared/requirements.md`
// § Vocabulary) — copied verbatim in SHAPE from
// `apps/orders/src/application/ports/consumer-name.ts`, but EMPTY: per
// saga.md §5, Billing consumes NO fact in this feature (`credit.hold`/
// `credit.list` are command-driven, and Billing's own facts are produced,
// never consumed, by it). `ConsumerName` is therefore `never` and
// `IdempotentConsumer.runOnce` is UNCALLABLE from this service until the
// shared § Vocabulary grows — the honest type: the pattern is present (and
// arms OI12's case 1, design.md §8), but cannot be used by accident.
export const CONSUMER_NAMES = [] as const;

export type ConsumerName = (typeof CONSUMER_NAMES)[number];

export function isConsumerName(value: unknown): value is ConsumerName {
  return typeof value === 'string' && (CONSUMER_NAMES as readonly string[]).includes(value);
}
