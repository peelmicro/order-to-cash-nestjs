// COPY OF — apps/orders/src/infrastructure/persistence/drizzle-unit-of-work.ts
// The infrastructure side of the `UnitOfWork` port (design.md §4.1, §7,
// §5.2) — the only place a `TransactionContext` is unwrapped back into a
// real Drizzle transaction. Everything else in the codebase treats
// `TransactionContext` as opaque. `OrdersDb`/`OrdersTx` -> `FulfillmentDb`/
// `FulfillmentTx`, the ONE edit against the Orders original.
import type { MySql2Transaction } from 'drizzle-orm/mysql2';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { FulfillmentDb } from './client';
import type * as schema from './schema';

/** The real shape hiding behind a Fulfillment `TransactionContext` — Drizzle's own transaction handle. */
export type FulfillmentTx = MySql2Transaction<typeof schema, Record<string, never>>;

/**
 * The MySQL driver error codes InnoDB raises for TRANSIENT lock contention
 * — never a data conflict. `ER_LOCK_DEADLOCK`: InnoDB detected a lock
 * cycle and killed this transaction so the other side could proceed; MySQL's
 * own documentation says to be prepared to re-issue it. `ER_LOCK_WAIT_TIMEOUT`:
 * this session waited `innodb_lock_wait_timeout` for a lock another
 * transaction held; same class (contention, not conflict) — included
 * deliberately, not left out, because a genuine deadlock cycle is not the
 * only way concurrent writers queue behind each other on this codebase's
 * short, single-row inserts. `ER_DUP_ENTRY` (a real, permanent conflict —
 * `invoice.repository.ts`'s `isDuplicateEntryError`) is NEVER in this set:
 * retrying a duplicate key forever would turn a correct `CONFLICT` into a
 * hang.
 */
const RETRYABLE_LOCK_ERROR_CODES: ReadonlySet<string> = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** At most this many attempts total (the first try plus retries) before the last error is rethrown unchanged. */
const MAX_ATTEMPTS = 3;

/** A short, fixed backoff before each retry — index 0 before attempt 2, index 1 before attempt 3. Small deliberately: this is a hot-spot mitigation, not a queueing mechanism. */
const RETRY_BACKOFF_MS: readonly number[] = [10, 25];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The driver error `code` on `error.cause.code` if it is one of `RETRYABLE_LOCK_ERROR_CODES`, else `undefined`. Mirrors `invoice.repository.ts`'s `isDuplicateEntryError` shape, generalised to a set. */
function retryableLockErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_LOCK_ERROR_CODES.has(code) ? code : undefined;
}

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: FulfillmentDb) {}

  /**
   * Runs `work` inside one write-model transaction, retrying the WHOLE
   * unit of work — never a single statement — on `ER_LOCK_DEADLOCK` /
   * `ER_LOCK_WAIT_TIMEOUT`. Safe by construction only because every caller
   * in this codebase re-derives everything it needs (fresh reads, freshly
   * constructed aggregates) from inside the callback rather than mutating
   * state captured from a previous failed attempt — verified caller by
   * caller, not assumed (`progress/impl_deadlock_retry.md`). `db.transaction`
   * itself rolls back and releases the connection on any thrown error, so a
   * retry always starts a genuinely fresh transaction. On exhaustion, the
   * LAST error is rethrown unchanged — never swallowed into something
   * vaguer.
   */
  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction((tx) => work(tx as unknown as TransactionContext));
      } catch (error) {
        const code = retryableLockErrorCode(error);
        if (!code || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        await delay(RETRY_BACKOFF_MS[attempt - 1]!);
      }
    }
  }
}

/**
 * The single unavoidable cast (design.md §4.1) — unwraps the opaque
 * `TransactionContext` handed to infrastructure back into the real Drizzle
 * transaction it always was. Called only by adapters that were themselves
 * handed a `tx` obtained (directly or indirectly) from
 * `DrizzleUnitOfWork.execute`.
 */
export function asDrizzleTx(tx: TransactionContext): FulfillmentTx {
  return tx as unknown as FulfillmentTx;
}
