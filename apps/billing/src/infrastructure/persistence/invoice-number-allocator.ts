// COPY OF — apps/fulfillment/src/infrastructure/persistence/despatch-number-allocator.ts
// `DES-`→`INV-`, `despatches`→`invoices`, `despatchReference`→`invoiceReference`
// — the ONE edit against the Fulfillment original (design.md §7.3). Same
// mechanism, same reason for the mechanism: a numeric
// `MAX(CAST(SUBSTRING(...)))` self-initialisation so the first live
// allocation continues past the seed's `INV-00000n` instead of colliding
// with it, an idempotent `ON DUPLICATE KEY UPDATE` ensure-insert, then
// `SELECT ... FOR UPDATE` + `UPDATE`.
import { eq, sql } from 'drizzle-orm';
import { InvoiceReference } from '@otc/shared-kernel';
import type { InvoiceNumberAllocator } from '../../application/ports/invoice-number-allocator.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import { asDrizzleTx } from './drizzle-unit-of-work';
import { INVOICE_NUMBER_SEQUENCE_ROW_ID, invoiceNumberSequences, invoices } from './schema';

const INVOICE_REFERENCE_PREFIX = 'INV-';

export class DrizzleInvoiceNumberAllocator implements InvoiceNumberAllocator {
  async next(tx: TransactionContext): Promise<InvoiceReference> {
    const db = asDrizzleTx(tx);

    // Numeric MAX over the suffix, not a string MAX — see
    // `order-number-allocator.ts`'s identical header comment (D6) for why a
    // plain string MAX would go backwards once the sequence crosses a digit
    // width.
    const [{ maxSequence }] = await db
      .select({
        maxSequence: sql<
          number | null
        >`max(cast(substring(${invoices.invoiceReference}, ${INVOICE_REFERENCE_PREFIX.length + 1}) as unsigned))`,
      })
      .from(invoices);
    const startAt = maxSequence ? maxSequence + 1 : 1;

    // Idempotent, safe to run on every call — only the FIRST ever call
    // actually inserts a row; every later call's `ON DUPLICATE KEY UPDATE`
    // leaves the existing value untouched.
    await db
      .insert(invoiceNumberSequences)
      .values({ id: INVOICE_NUMBER_SEQUENCE_ROW_ID, nextValue: startAt })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${invoiceNumberSequences.nextValue}` } });

    const [row] = await db
      .select({ nextValue: invoiceNumberSequences.nextValue })
      .from(invoiceNumberSequences)
      .where(eq(invoiceNumberSequences.id, INVOICE_NUMBER_SEQUENCE_ROW_ID))
      .for('update');
    if (!row) {
      // Unreachable given the insert above, guarded only so a future
      // refactor that drops it fails loudly instead of allocating `undefined`.
      throw new Error('DrizzleInvoiceNumberAllocator: sequence row missing after ensure-insert');
    }

    await db
      .update(invoiceNumberSequences)
      .set({ nextValue: row.nextValue + 1 })
      .where(eq(invoiceNumberSequences.id, INVOICE_NUMBER_SEQUENCE_ROW_ID));

    return InvoiceReference.fromSequence(row.nextValue);
  }
}
