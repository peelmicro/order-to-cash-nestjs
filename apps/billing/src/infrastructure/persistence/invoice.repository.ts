// The Drizzle adapter for `InvoiceRepository` (design.md §5.2, §7.1).
// `findByOrderReference` is the B7 fast path — no lock, no transaction, a
// plain read against the shared `BillingDb` handle. `lockByOrderReference`
// is the B7 authority — the same two reads inside `tx`, `FOR UPDATE`, and
// it is this feature's SECOND lock (`BI8`) — never `SKIP LOCKED` here: a
// contender must WAIT, not skip.
import { eq } from 'drizzle-orm';
import type { InvoiceReference, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { InvoiceRepository, PaymentRecordInput, PaymentRecordSnapshot } from '../../application/ports/invoice-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { Invoice } from '../../domain/invoice';
import type { InvoiceSnapshot } from '../../domain/invoice-snapshot';
import { PaymentReferenceConflictError } from '../../application/invoice-application-errors';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx } from './drizzle-unit-of-work';
import type { BillingDb } from './client';
import { toInvoiceItemTableRows, toInvoiceSnapshot, toInvoiceTableRow, toPaymentRecordSnapshot, toPaymentTableRow } from './invoice.mapper';
import { invoiceItems, invoices, payments } from './schema';

const MYSQL_DUPLICATE_ENTRY_CODE = 'ER_DUP_ENTRY';

/** COPY OF the idiom `infrastructure/messaging/processed-events.repository.ts` established — surfaces a MySQL duplicate-key violation as a typed outcome rather than letting the raw driver error escape. */
function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return false;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return false;
  }
  return (cause as { code?: unknown }).code === MYSQL_DUPLICATE_ENTRY_CODE;
}

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

  /** Payment-register identity resolution (feature 22), non-transactional, no lock — the `findByOrderReference` fast-path shape, keyed on `id`. */
  async findById(id: UniqueId): Promise<InvoiceSnapshot | null> {
    const [invoiceRow] = await this.db.select().from(invoices).where(eq(invoices.id, id.value));
    if (!invoiceRow) {
      return null;
    }
    const itemRows = await this.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRow.id));
    return toInvoiceSnapshot(invoiceRow, itemRows);
  }

  /** The `invoiceReference` twin of `findById` — same shape, keyed on the business reference. */
  async findByInvoiceReference(invoiceReference: InvoiceReference): Promise<InvoiceSnapshot | null> {
    const [invoiceRow] = await this.db.select().from(invoices).where(eq(invoices.invoiceReference, invoiceReference.value));
    if (!invoiceRow) {
      return null;
    }
    const itemRows = await this.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRow.id));
    return toInvoiceSnapshot(invoiceRow, itemRows);
  }

  /** The payment-register authority read: `invoices` row `FOR UPDATE` by `id` — the SECOND lock this feature takes, AFTER the `credits` row (BI8, extended). */
  async lockById(tx: TransactionContext, id: UniqueId): Promise<InvoiceSnapshot | null> {
    const db = asDrizzleTx(tx);

    const [invoiceRow] = await db.select().from(invoices).where(eq(invoices.id, id.value)).for('update');
    if (!invoiceRow) {
      return null;
    }
    const itemRows = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRow.id));
    return toInvoiceSnapshot(invoiceRow, itemRows);
  }

  /** The R48 fast path: `payments` by `payment_reference`, no lock, no transaction. */
  async findPaymentByReference(paymentReference: string): Promise<PaymentRecordSnapshot | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.paymentReference, paymentReference));
    return row ? toPaymentRecordSnapshot(row) : null;
  }

  /** The R48 authority re-read: `payments` by `invoice_id`, inside `tx`, called only after `lockById` has already taken that invoice's own row lock (no separate lock needed here — see the port doc). */
  async findPaymentByInvoiceId(tx: TransactionContext, invoiceId: UniqueId): Promise<PaymentRecordSnapshot | null> {
    const db = asDrizzleTx(tx);
    const [row] = await db.select().from(payments).where(eq(payments.invoiceId, invoiceId.value));
    return row ? toPaymentRecordSnapshot(row) : null;
  }

  /**
   * `issued -> paid` (feature 22): `UPDATE invoices` (status, paid_at),
   * `INSERT payments` (guarded by `payments.payment_reference`'s UNIQUE
   * constraint — the belt to `findPaymentByInvoiceId`'s read-then-write
   * brace, surfaced as `PaymentReferenceConflictError` rather than a raw
   * driver error), then drains `invoice.pullDomainEvents()`
   * (`payment.received.v1`) into the outbox. Called BEFORE
   * `BuyerCreditRepository.save` by the handler, so this INSERT — and
   * `payment.received.v1`'s outbox row — commits, and is assigned its
   * `seq`, strictly before `credit.released.v1`'s (R47's ordering, made
   * structural by call order).
   */
  async markPaid(invoice: Invoice, payment: PaymentRecordInput, tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();

    await db
      .update(invoices)
      .set({ status: invoice.status, paidAt: invoice.paidAt, updatedAt: now })
      .where(eq(invoices.id, invoice.id.value));

    try {
      await db.insert(payments).values(toPaymentTableRow(invoice.id.value, payment));
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        throw new PaymentReferenceConflictError(payment.paymentReference);
      }
      throw error;
    }

    const events = invoice.pullDomainEvents();
    await this.outboxRecorder.record(tx, events);
  }
}
