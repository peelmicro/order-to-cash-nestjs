// The write-model port for `invoice.issue` AND `billing.payment.register`
// (design.md §5.2, §7; feature 22 extends this SAME file — "the same
// aggregate, the same repository file" per billing_invoicing design.md §14)
// — the fast-path/locking-read split and the drain-on-save discipline
// `apps/billing/.../buyer-credit-repository.port.ts` established.
import type { InvoiceReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { PaymentSource } from '@otc/contracts';
import type { Invoice } from '../../domain/invoice.js';
import type { InvoiceSnapshot } from '../../domain/invoice-snapshot.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const INVOICE_REPOSITORY = Symbol('InvoiceRepository');

/**
 * The `payments` table's row shape, read back — NOT a domain aggregate
 * (`billing_invoicing` design.md §14: "`markPaid` takes the payment's
 * fields as arguments" — there is no `Payment` entity in this model). Used
 * only to build a `duplicate` reply and to compare a locked invoice's
 * recorded remittance against a repeat's `paymentReference` (R48/R49).
 */
export interface PaymentRecordSnapshot {
  readonly id: UniqueId;
  readonly paymentReference: string;
  readonly invoiceId: UniqueId;
  readonly amount: Money;
  readonly valueDate: Date;
  readonly source: PaymentSource;
  readonly createdAt: Date;
}

export interface PaymentRecordInput {
  readonly id: UniqueId;
  readonly paymentReference: string;
  readonly amount: Money;
  readonly valueDate: Date;
  readonly source: PaymentSource;
  readonly createdAt: Date;
}

export interface InvoiceRepository {
  /**
   * The B7 fast path: a non-transactional read by `orderReference`, no
   * lock, before any transaction is opened (the `DespatchRepository.findByOrderReference`
   * precedent). The common redelivery case therefore opens no transaction
   * and takes no lock at all — which matters, because the sweeper retries
   * and `saga.md` §6 layer 3 makes repeats routine rather than exceptional.
   */
  findByOrderReference(orderReference: OrderNumber): Promise<InvoiceSnapshot | null>;

  /**
   * The B7 authority: the same read `FOR UPDATE`, INSIDE `tx` and AFTER the
   * `credits` row lock (§5.4 step 2). A locking read is a CURRENT read, so
   * it removes the REPEATABLE-READ snapshot reasoning entirely, and its gap
   * lock on `uq_invoices_order_reference` blocks a concurrent insert for
   * the same order.
   */
  lockByOrderReference(tx: TransactionContext, orderReference: OrderNumber): Promise<InvoiceSnapshot | null>;

  /**
   * INSERTs the invoice row and its line rows, then drains
   * `invoice.pullDomainEvents()` into the outbox, all inside `tx` (R13).
   * Never UPDATEs on the issue path. `tx` required — never opens its own.
   */
  save(invoice: Invoice, tx: TransactionContext): Promise<void>;

  /**
   * `billing.payment.register`'s identity resolution, non-transactional,
   * no lock — mirrors `findByOrderReference`'s fast-path shape. Used to
   * learn the target invoice's `retailerCode`/`companyCode`/`orderReference`
   * BEFORE opening a transaction, because `credits.lockForOrder` needs them
   * and BI8's lock order (credits ALWAYS first) must be fixed before either
   * lock is taken.
   */
  findById(id: UniqueId): Promise<InvoiceSnapshot | null>;

  /** The `invoiceReference` twin of `findById`, for a request that names the invoice by its business reference instead of its id. */
  findByInvoiceReference(invoiceReference: InvoiceReference): Promise<InvoiceSnapshot | null>;

  /**
   * The payment-register authority read: the invoice row `FOR UPDATE` by
   * `id`, INSIDE `tx` and AFTER the `credits` row lock — the SECOND lock
   * this call takes, exactly where `lockByOrderReference` sits in
   * `invoice.issue` (BI8's fixed order, extended to this subject). Fully
   * serialises every concurrent `payment.register` call naming this SAME
   * invoice, whatever `paymentReference` each one carries.
   */
  lockById(tx: TransactionContext, id: UniqueId): Promise<InvoiceSnapshot | null>;

  /**
   * The R48 fast path: a non-transactional, non-locking read of `payments`
   * by `paymentReference` — the idempotency key. A hit lets the common
   * redelivery case answer `duplicate` without ever opening a transaction,
   * the same reasoning `findByOrderReference` documents for `invoice.issue`.
   */
  findPaymentByReference(paymentReference: string): Promise<PaymentRecordSnapshot | null>;

  /**
   * The R48 authority re-read: a plain (non-locking) read of `payments` by
   * `invoiceId`, called ONLY after `lockById` has taken the invoice's own
   * row lock — that lock alone serialises every writer of a `payments` row
   * for this SAME invoice, so no separate lock is needed here. Closes the
   * race the step-0 fast path leaves open between its own read and this
   * transaction's commit.
   */
  findPaymentByInvoiceId(tx: TransactionContext, invoiceId: UniqueId): Promise<PaymentRecordSnapshot | null>;

  /**
   * `issued -> paid`'s persistence: `UPDATE invoices` (status, paidAt),
   * `INSERT payments` (the belt: `payments.payment_reference` carries a
   * UNIQUE constraint — R48's braces to this method's read-then-write
   * belt, exactly B7's `uq_invoices_order_reference` precedent), then
   * drains `invoice.pullDomainEvents()` (`payment.received.v1`) into the
   * outbox. `tx` required — never opens its own. Called BEFORE
   * `BuyerCreditRepository.save` in the handler so `payment.received.v1`'s
   * outbox row is written, and gets its `seq`, strictly before
   * `credit.released.v1`'s (R47's ordering).
   */
  markPaid(invoice: Invoice, payment: PaymentRecordInput, tx: TransactionContext): Promise<void>;
}
