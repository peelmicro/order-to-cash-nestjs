// The closed `CancellationReason` set — domain-model.md §3.1. Owned by the
// domain for the same reason `order-status.ts` owns `ORDER_STATUSES`
// (design.md §3): `@otc/contracts` re-generates the same value set from
// `asyncapi.yaml`, and parity is asserted, never assumed, by
// `order-status.spec.ts`.
export const CANCELLATION_REASONS = ['stock_rejected', 'credit_rejected', 'operator_cancelled'] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Runtime guard — the one place a `string` from persistence is narrowed to `CancellationReason`. */
export function isCancellationReason(value: unknown): value is CancellationReason {
  return typeof value === 'string' && (CANCELLATION_REASONS as readonly string[]).includes(value);
}
