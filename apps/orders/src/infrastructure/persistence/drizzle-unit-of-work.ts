// The infrastructure side of the `UnitOfWork` port (design.md §4.1) — the
// only place a `TransactionContext` is unwrapped back into a real Drizzle
// transaction. Everything else in the codebase treats `TransactionContext`
// as opaque.
import type { MySql2Transaction } from 'drizzle-orm/mysql2';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { OrdersDb } from './client';
import type * as schema from './schema';

/** The real shape hiding behind an Orders `TransactionContext` — Drizzle's own transaction handle. */
export type OrdersTx = MySql2Transaction<typeof schema, Record<string, never>>;

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: OrdersDb) {}

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
export function asDrizzleTx(tx: TransactionContext): OrdersTx {
  return tx as unknown as OrdersTx;
}
