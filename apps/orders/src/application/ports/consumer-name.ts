// The closed set of consumer names the idempotent-consumer pattern dedups
// by (design.md §6.1, `specs/shared/requirements.md` § Vocabulary). A typo
// cannot create a second, silently-empty dedup namespace. Mirrors the
// `ORDER_STATUSES` convention of feature 13
// (`apps/orders/src/domain/order-status.ts`).
export const CONSUMER_NAMES = ['orders.saga', 'projector', 'notifications'] as const;

export type ConsumerName = (typeof CONSUMER_NAMES)[number];

export function isConsumerName(value: unknown): value is ConsumerName {
  return typeof value === 'string' && (CONSUMER_NAMES as readonly string[]).includes(value);
}
