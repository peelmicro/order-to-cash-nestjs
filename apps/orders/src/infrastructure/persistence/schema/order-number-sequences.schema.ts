// The `OrderNumber` allocation counter (`orders_acceptance` feature) — a
// single-row table used as the concurrency-safe sequence generator for
// `ORD-######` business references (domain-model.md §2.3). Not a business
// entity: no `created_at`/`updated_at`, the same way `outbox.seq` carries no
// audit columns either — it is a technical allocation primitive, not
// something referenced by a fact or read by a consumer.
//
// One row only (`id = 1`), incremented under a row-level lock by
// `DrizzleOrderNumberAllocator` (design: `order-number-allocator.ts`) — the
// standard MySQL InnoDB "counter table" sequence-generation pattern
// (https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html),
// chosen over locking a range of the (much larger, ever-growing) `orders`
// table itself.
import { int, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';

export const ORDER_NUMBER_SEQUENCE_ROW_ID = 1;

export const orderNumberSequences = mysqlTable('order_number_sequences', {
  id: tinyint('id').primaryKey(),
  nextValue: int('next_value').notNull(),
});
