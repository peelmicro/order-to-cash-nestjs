// The transaction boundary — design.md §4.1. Expressed as a port in the
// application layer, opened by infrastructure. A command handler reads:
//
//   await this.unitOfWork.execute(async (tx) => {
//     const order = Order.place(input, { occurredAt: this.clock.now(), causationId: commandId });
//     await this.orders.save(order, tx);   // aggregate row + order_items + outbox rows, all inside tx
//     return order.id;
//   });
//
// Rejected alternatives, and why: `@Transactional()`-style AOP or an
// ambient async-local transaction hide the transaction boundary — the most
// important line in R13 becomes invisible at the call site, and a reviewer
// cannot see from a handler whether two writes share a transaction. Putting
// the boundary inside the repository (`save` opens its own transaction)
// makes R17 unsatisfiable: a consumer must write its dedup record, its
// aggregate change and its outbox records in ONE transaction spanning two
// collaborators, so the boundary has to sit above the repository.
export const UNIT_OF_WORK = Symbol('UnitOfWork');

declare const transactionBrand: unique symbol;

/**
 * An opaque handle to an open write-model transaction. The application
 * layer passes it; only infrastructure looks inside. The port must not
 * name Drizzle — the application layer would then depend on the adapter it
 * is meant to abstract. The brand makes `TransactionContext` unforgeable in
 * application code while carrying the real transaction at runtime; the
 * single unavoidable cast lives in one function,
 * `drizzle-unit-of-work.ts`'s `asDrizzleTx(tx)`, commented, and is the only
 * place in the codebase where a `TransactionContext` is unwrapped.
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
