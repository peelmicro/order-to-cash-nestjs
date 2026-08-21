// The Drizzle adapter for `OrderNumberAllocator` (orders_acceptance feature,
// task "order-number allocation — concurrency-safe, continuing past the
// seed's existing references").
//
// Mechanism: a single-row counter table (`order_number_sequences`,
// `id = 1`), incremented under `SELECT ... FOR UPDATE` + `UPDATE` — the
// standard MySQL InnoDB "generate sequence numbers" recipe
// (https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html). Two
// callers racing `next(tx)` serialize on the exclusive row lock the `SELECT
// ... FOR UPDATE` takes on the counter row: the second caller blocks until
// the first commits (releasing the lock) or rolls back, so no two callers
// ever read the same `nextValue`.
//
// Rejected alternative: `SELECT MAX(order_reference) FROM orders FOR
// UPDATE` directly against `orders` (no extra table). It was rejected
// because correctness there depends on InnoDB's next-key (gap) locking
// behaviour over a large, ever-growing table under the default REPEATABLE
// READ isolation — correct in principle, but the row-level lock on a
// dedicated single-row counter is the textbook-safe form regardless of
// isolation level or how the `orders` table's index is shaped, and it is
// unaffected by `orders` growing.
//
// Continuing past the seed's ORD-000001..ORD-000006: the row is
// self-initialising. On every call this adapter first ensures the counter
// row exists via an idempotent `INSERT ... ON DUPLICATE KEY UPDATE
// next_value = next_value` (a genuine no-op once the row exists — the
// candidate value it would have inserted is discarded), seeded from
// `MAX(orders.order_reference) + 1` read at that moment. This means the
// allocator needs no hardcoded starting value and no change to
// `apps/seed`: whatever the database already contains — the seed's six
// orders, zero orders in a fresh Testcontainers fixture, or any other prior
// state — the very first live allocation continues from the correct point.
import { eq, sql } from 'drizzle-orm';
import { OrderNumber } from '@otc/shared-kernel';
import type { OrderNumberAllocator } from '../../application/ports/order-number-allocator.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import { asDrizzleTx } from './drizzle-unit-of-work';
import { ORDER_NUMBER_SEQUENCE_ROW_ID, orderNumberSequences, orders } from './schema';

const ORDER_NUMBER_PREFIX = 'ORD-';

/** Parses the numeric sequence out of an `ORD-######` reference — the inverse of `OrderNumber.fromSequence`. Infrastructure-local: the domain never needs this, it only ever receives a whole `OrderNumber`. */
export function parseOrderNumberSequence(reference: string): number {
  const digits = reference.slice(ORDER_NUMBER_PREFIX.length);
  const parsed = Number(digits);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`order-number-allocator: "${reference}" does not carry a valid sequence suffix`);
  }
  return parsed;
}

export class DrizzleOrderNumberAllocator implements OrderNumberAllocator {
  async next(tx: TransactionContext): Promise<OrderNumber> {
    const db = asDrizzleTx(tx);

    // D6 (review_orders_acceptance.md): `MAX(order_reference)` alone is a
    // STRING max — correct only while every reference has the same digit
    // width. `'ORD-1000000' < 'ORD-999999'` lexically, so once the
    // sequence crosses 999999 a virgin counter re-seeded from a plain
    // string MAX would go BACKWARDS and collide with existing references.
    // Casting the numeric suffix (everything after the fixed 4-character
    // `ORD-` prefix) to UNSIGNED before taking MAX() makes this a genuine
    // numeric max regardless of digit width, so the self-initialisation
    // stays correct across any digit-width crossing, not just today's.
    const [{ maxSequence }] = await db
      .select({
        maxSequence: sql<number | null>`max(cast(substring(${orders.orderReference}, ${ORDER_NUMBER_PREFIX.length + 1}) as unsigned))`,
      })
      .from(orders);
    const startAt = maxSequence ? maxSequence + 1 : 1;

    // Idempotent, safe to run on every call — see the header comment. Only
    // the FIRST ever call actually inserts a row; every later call's
    // `ON DUPLICATE KEY UPDATE` leaves the existing value untouched.
    await db
      .insert(orderNumberSequences)
      .values({ id: ORDER_NUMBER_SEQUENCE_ROW_ID, nextValue: startAt })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${orderNumberSequences.nextValue}` } });

    const [row] = await db
      .select({ nextValue: orderNumberSequences.nextValue })
      .from(orderNumberSequences)
      .where(eq(orderNumberSequences.id, ORDER_NUMBER_SEQUENCE_ROW_ID))
      .for('update');
    if (!row) {
      // Unreachable given the insert above, guarded only so a future
      // refactor that drops it fails loudly instead of allocating `undefined`.
      throw new Error('DrizzleOrderNumberAllocator: sequence row missing after ensure-insert');
    }

    await db
      .update(orderNumberSequences)
      .set({ nextValue: row.nextValue + 1 })
      .where(eq(orderNumberSequences.id, ORDER_NUMBER_SEQUENCE_ROW_ID));

    return OrderNumber.fromSequence(row.nextValue);
  }
}
