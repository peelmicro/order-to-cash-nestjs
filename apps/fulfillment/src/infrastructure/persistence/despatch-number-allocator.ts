// The Drizzle adapter for `DespatchNumberAllocator` — mirrors
// `apps/orders/.../order-number-allocator.ts` exactly (same mechanism: a
// single-row counter table incremented under `SELECT ... FOR UPDATE` +
// `UPDATE`, self-initialising from `MAX(despatches.despatch_reference) + 1`
// so it needs no hardcoded starting value and continues correctly past the
// seed's `DES-000001..005` on first live allocation).
import { eq, sql } from 'drizzle-orm';
import { DespatchReference } from '@otc/shared-kernel';
import type { DespatchNumberAllocator } from '../../application/ports/despatch-number-allocator.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import { asDrizzleTx } from './drizzle-unit-of-work';
import { DESPATCH_NUMBER_SEQUENCE_ROW_ID, despatchNumberSequences, despatches } from './schema';

const DESPATCH_REFERENCE_PREFIX = 'DES-';

export class DrizzleDespatchNumberAllocator implements DespatchNumberAllocator {
  async next(tx: TransactionContext): Promise<DespatchReference> {
    const db = asDrizzleTx(tx);

    // Numeric MAX over the suffix, not a string MAX — see
    // `order-number-allocator.ts`'s identical header comment (D6) for why a
    // plain string MAX would go backwards once the sequence crosses a digit
    // width.
    const [{ maxSequence }] = await db
      .select({
        maxSequence: sql<
          number | null
        >`max(cast(substring(${despatches.despatchReference}, ${DESPATCH_REFERENCE_PREFIX.length + 1}) as unsigned))`,
      })
      .from(despatches);
    const startAt = maxSequence ? maxSequence + 1 : 1;

    // Idempotent, safe to run on every call — only the FIRST ever call
    // actually inserts a row; every later call's `ON DUPLICATE KEY UPDATE`
    // leaves the existing value untouched.
    await db
      .insert(despatchNumberSequences)
      .values({ id: DESPATCH_NUMBER_SEQUENCE_ROW_ID, nextValue: startAt })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${despatchNumberSequences.nextValue}` } });

    const [row] = await db
      .select({ nextValue: despatchNumberSequences.nextValue })
      .from(despatchNumberSequences)
      .where(eq(despatchNumberSequences.id, DESPATCH_NUMBER_SEQUENCE_ROW_ID))
      .for('update');
    if (!row) {
      // Unreachable given the insert above, guarded only so a future
      // refactor that drops it fails loudly instead of allocating `undefined`.
      throw new Error('DrizzleDespatchNumberAllocator: sequence row missing after ensure-insert');
    }

    await db
      .update(despatchNumberSequences)
      .set({ nextValue: row.nextValue + 1 })
      .where(eq(despatchNumberSequences.id, DESPATCH_NUMBER_SEQUENCE_ROW_ID));

    return DespatchReference.fromSequence(row.nextValue);
  }
}
