// The `DespatchReference` (`DES-######`) allocation counter
// (`fulfillment_despatch` feature) — mirrors `apps/orders/.../schema/order-number-sequences.schema.ts`
// exactly: a single-row table used as the concurrency-safe sequence
// generator (domain-model.md §2.3), incremented under `SELECT ... FOR
// UPDATE` + `UPDATE` by `DrizzleDespatchNumberAllocator`. Not a business
// entity: no `created_at`/`updated_at`, a technical allocation primitive.
import { int, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';

export const DESPATCH_NUMBER_SEQUENCE_ROW_ID = 1;

export const despatchNumberSequences = mysqlTable('despatch_number_sequences', {
  id: tinyint('id').primaryKey(),
  nextValue: int('next_value').notNull(),
});
