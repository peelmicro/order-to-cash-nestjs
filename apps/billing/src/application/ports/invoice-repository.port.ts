// The write-model port for `invoice.issue` (design.md §5.2, §7) — the
// fast-path/locking-read split and the drain-on-save discipline
// `apps/billing/.../buyer-credit-repository.port.ts` established.
import type { OrderNumber } from '@otc/shared-kernel';
import type { Invoice } from '../../domain/invoice.js';
import type { InvoiceSnapshot } from '../../domain/invoice-snapshot.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const INVOICE_REPOSITORY = Symbol('InvoiceRepository');

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
}
