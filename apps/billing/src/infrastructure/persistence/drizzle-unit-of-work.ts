// COPY OF — apps/orders/src/infrastructure/persistence/drizzle-unit-of-work.ts
// The infrastructure side of the `UnitOfWork` port (design.md §4.1, §7,
// §5.2) — the only place a `TransactionContext` is unwrapped back into a
// real Drizzle transaction. Everything else in the codebase treats
// `TransactionContext` as opaque. `OrdersDb`/`OrdersTx` -> `BillingDb`/
// `BillingTx`, the ONE edit against the Orders original.
import type { MySql2Transaction } from 'drizzle-orm/mysql2';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { BillingDb } from './client';
import type * as schema from './schema';

/** The real shape hiding behind a Billing `TransactionContext` — Drizzle's own transaction handle. */
export type BillingTx = MySql2Transaction<typeof schema, Record<string, never>>;

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: BillingDb) {}

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx as unknown as TransactionContext));
  }
}

/**
 * The single unavoidable cast (design.md §4.1) — unwraps the opaque
 * `TransactionContext` handed to infrastructure back into the real Drizzle
 * transaction it always was. Called only by adapters that were themselves
 * handed a `tx` obtained (directly or indirectly) from
 * `DrizzleUnitOfWork.execute`.
 */
export function asDrizzleTx(tx: TransactionContext): BillingTx {
  return tx as unknown as BillingTx;
}
