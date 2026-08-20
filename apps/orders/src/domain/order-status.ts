// The `Order` state machine's closed status set — domain-model.md §3.3
// Table T-1. The domain owns this union (design.md §3): neither
// `@otc/contracts` (generated) nor `infrastructure/persistence/schema/orders.schema.ts`
// (a projection) is the source of truth. Both are held to parity with this
// file by a dedicated test — `order-status.spec.ts` (domain ↔ contracts) and
// `orders.schema.spec.ts` (domain ↔ Drizzle, living in infrastructure/
// because a domain test may not import infrastructure/).
export const ORDER_STATUSES = [
  'placed',
  'stock_reserved',
  'credit_approved',
  'confirmed',
  'despatched',
  'invoiced',
  'paid',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Runtime guard — the one place a `string` from persistence is narrowed to `OrderStatus`. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}
