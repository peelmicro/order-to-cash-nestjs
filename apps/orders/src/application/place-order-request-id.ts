// RI3's collision detector (`observability_reliability` design.md §3.2,
// §3.3) — narrows a MySQL/`mysql2` duplicate-key error to the
// `uq_orders_request_id` constraint SPECIFICALLY, never the pre-existing
// `orders.order_reference` unique constraint, which must still propagate
// as a genuine (if practically unreachable) error. Mirrors the shape
// `apps/billing/src/infrastructure/persistence/invoice.repository.ts`'s
// own `isDuplicateEntryError` already established for
// `payments.payment_reference` (`error.cause.code === 'ER_DUP_ENTRY'`,
// via `drizzle-orm`'s `mysql2` driver wrapping), widened here to also
// check WHICH unique key the driver named — Billing's case never needed
// that distinction because `invoices`/`payments` carry only one unique
// key each worth catching.
const MYSQL_DUPLICATE_ENTRY_CODE = 'ER_DUP_ENTRY';
const REQUEST_ID_CONSTRAINT_NAME = 'uq_orders_request_id';

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `true` only for a duplicate-key error whose MySQL error message names
 * `uq_orders_request_id` — the RI3 race (two concurrent first-time
 * `orders.create` requests sharing the same, not-yet-committed
 * `requestId`). A duplicate-key error on any other constraint (the
 * primary key, `order_reference`) returns `false` and must be rethrown by
 * the caller unchanged.
 */
export function isDuplicateRequestIdError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const err = error as { message?: unknown; cause?: unknown };
  const cause =
    typeof err.cause === 'object' && err.cause !== null ? (err.cause as Record<string, unknown>) : undefined;
  if (cause?.code !== MYSQL_DUPLICATE_ENTRY_CODE) {
    return false;
  }
  const text = `${readString(err.message)} ${readString(cause.sqlMessage)} ${readString(cause.message)}`;
  return text.includes(REQUEST_ID_CONSTRAINT_NAME);
}
