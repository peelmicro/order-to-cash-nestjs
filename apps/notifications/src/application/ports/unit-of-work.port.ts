// The transaction boundary the canonical idempotent-consumer pattern
// requires (infrastructure/messaging/idempotent-consumer.ts). Expressed as
// a port in the application layer, opened by infrastructure — same shape
// apps/fulfillment/src/application/ports/unit-of-work.port.ts and
// apps/orders' own establish, so the canonical pair's PORTABLE_IMPORT_WHITELIST
// import specifiers ('../../application/ports/unit-of-work.port') resolve
// to a compatible interface here too.
//
// Notifications has exactly ONE table (`processed_events`) and no
// aggregate — this port exists solely so the canonical dedup pattern can be
// reused UNMODIFIED (notifications_service re-review, N1/N2), not because
// this service has multi-row transactional invariants of its own.
export const UNIT_OF_WORK = Symbol('UnitOfWork');

declare const transactionBrand: unique symbol;

/**
 * An opaque handle to an open write-model transaction. The application
 * layer passes it; only infrastructure looks inside. The single unavoidable
 * cast lives in `infrastructure/persistence/drizzle-unit-of-work.ts`'s
 * `asDrizzleTx(tx)`, commented, and is the only place in this service where
 * a `TransactionContext` is unwrapped.
 */
export interface TransactionContext {
  readonly [transactionBrand]: 'TransactionContext';
}

export interface UnitOfWork {
  /**
   * Runs `work` inside one write-model transaction. Commits if it
   * resolves, rolls back if it rejects, and never swallows the rejection.
   */
  execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
