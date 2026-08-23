// The Drizzle adapter for `InvoiceRepository` (design.md §5.2, §7.1).
// `findByOrderReference` is the B7 fast path — no lock, no transaction, a
// plain read against the shared `BillingDb` handle. `lockByOrderReference`
// is the B7 authority — the same two reads inside `tx`, `FOR UPDATE`, and
// it is this feature's SECOND lock (`BI8`) — never `SKIP LOCKED` here: a
// contender must WAIT, not skip.
import { eq } from 'drizzle-orm';
import type { OrderNumber } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { InvoiceRepository } from '../../application/ports/invoice-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { Invoice } from '../../domain/invoice';
import type { InvoiceSnapshot } from '../../domain/invoice-snapshot';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx } from './drizzle-unit-of-work';
import type { BillingDb } from './client';
import { toInvoiceItemTableRows, toInvoiceSnapshot, toInvoiceTableRow } from './invoice.mapper';
import { invoiceItems, invoices } from './schema';

export class DrizzleInvoiceRepository implements InvoiceRepository {
  constructor(
    private readonly db: BillingDb,
    private readonly clock: Clock,
    private readonly outboxRecorder: OutboxRecorder = new OutboxRecorder(clock),
  ) {}

  /** The B7 fast path: one `SELECT` on `invoices` by `order_reference` plus one on `invoice_items` by `invoice_id`, no lock, no transaction. Returns the snapshot, not the aggregate — the fast path only needs to build a reply. */
  async findByOrderReference(orderReference: OrderNumber): Promise<InvoiceSnapshot | null> {
    const [invoiceRow] = await this.db.select().from(invoices).where(eq(invoices.orderReference, orderReference.value));
    if (!invoiceRow) {
      return null;
    }
    const itemRows = await this.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRow.id));
    return toInvoiceSnapshot(invoiceRow, itemRows);
  }

  /** The B7 authority: the same two reads inside `tx`, `.for('update')` on the parent row — the second lock this service takes (`BI8`). */
  async lockByOrderReference(tx: TransactionContext, orderReference: OrderNumber): Promise<InvoiceSnapshot | null> {
    const db = asDrizzleTx(tx);

    const [invoiceRow] = await db.select().from(invoices).where(eq(invoices.orderReference, orderReference.value)).for('update');
    if (!invoiceRow) {
      return null;
    }
    const itemRows = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRow.id));
    return toInvoiceSnapshot(invoiceRow, itemRows);
  }

  /** `insert(invoices)` then `insert(invoiceItems)` — NEVER an `UPDATE` on this path (feature 22 adds `markPaid`'s `UPDATE` to this same file) — then drains the outbox. `tx` required — never opens its own. */
  async save(invoice: Invoice, tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();
    const timestamps = { createdAt: now, updatedAt: now };

    await db.insert(invoices).values(toInvoiceTableRow(invoice, timestamps));
    const lineRows = toInvoiceItemTableRows(invoice, timestamps);
    if (lineRows.length > 0) {
      await db.insert(invoiceItems).values(lineRows);
    }

    const events = invoice.pullDomainEvents();
    await this.outboxRecorder.record(tx, events);
  }
}
