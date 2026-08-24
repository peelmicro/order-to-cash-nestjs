// The infrastructure side of the `UnitOfWork` port — the only place a
// `TransactionContext` is unwrapped back into a real Drizzle transaction.
// Everything else in this service treats `TransactionContext` as opaque.
// Same shape apps/fulfillment's own drizzle-unit-of-work.ts establishes,
// `FulfillmentDb`/`FulfillmentTx` -> `NotificationsDb`/`NotificationsTx`.
import type { MySql2Transaction } from 'drizzle-orm/mysql2';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { NotificationsDb } from './client';
import type * as schema from './schema';

/** The real shape hiding behind a Notifications `TransactionContext` — Drizzle's own transaction handle. */
export type NotificationsTx = MySql2Transaction<typeof schema, Record<string, never>>;

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: NotificationsDb) {}

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx as unknown as TransactionContext));
  }
}

/**
 * The single unavoidable cast — unwraps the opaque `TransactionContext`
 * handed to infrastructure back into the real Drizzle transaction it always
 * was. Called only by adapters that were themselves handed a `tx` obtained
 * (directly or indirectly) from `DrizzleUnitOfWork.execute`.
 */
export function asDrizzleTx(tx: TransactionContext): NotificationsTx {
  return tx as unknown as NotificationsTx;
}
