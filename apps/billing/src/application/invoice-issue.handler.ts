// The issue transactional unit as a PLAIN CLASS (no decorator) — design.md
// §5.4. The `@CommandHandler` wrapper in
// `commands/invoice.command-handlers.ts` delegates to this, the same split
// `CreditHoldHandler` uses so a unit test can `new` it with fakes.
import { Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { InvoiceIssueReplyPayload } from '@otc/contracts';
import type { IssueInvoiceCommand } from './commands/invoice.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { InvoiceRepository } from './ports/invoice-repository.port.js';
import type { InvoiceNumberAllocator } from './ports/invoice-number-allocator.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { CreditLineNotFoundError } from './credit-application-errors.js';
import { InvoiceCurrencyMismatchError, NoActiveCreditHoldError } from './invoice-application-errors.js';
import { Invoice, type InvoiceContext } from '../domain/invoice.js';
import type { InvoiceSnapshot } from '../domain/invoice-snapshot.js';

function replyFromSnapshot(snapshot: InvoiceSnapshot, created: boolean): InvoiceIssueReplyPayload {
  return {
    orderReference: snapshot.orderReference.value,
    invoiceId: snapshot.id.value,
    invoiceReference: snapshot.invoiceReference.value,
    invoiceDate: snapshot.invoiceDate.toISOString(),
    currency: snapshot.currency,
    totalAmount: snapshot.totalAmount.amount,
    status: snapshot.status,
    created,
  };
}

function replyFromInvoice(invoice: Invoice, created: boolean): InvoiceIssueReplyPayload {
  return {
    orderReference: invoice.orderReference.value,
    invoiceId: invoice.id.value,
    invoiceReference: invoice.invoiceReference.value,
    invoiceDate: invoice.invoiceDate.toISOString(),
    currency: invoice.currency,
    totalAmount: invoice.totalAmount.amount,
    status: invoice.status,
    created,
  };
}

export class InvoiceIssueHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly credits: BuyerCreditRepository,
    private readonly invoices: InvoiceRepository,
    private readonly invoiceNumbers: InvoiceNumberAllocator,
    private readonly clock: Clock,
  ) {}

  /**
   * §5.4: fast path outside any transaction; then, inside one
   * `unitOfWork.execute`: `credits.lockForOrder` (ALWAYS the first lock,
   * `BI8`) → `null` ⇒ `CreditLineNotFoundError`; `invoices.lockByOrderReference`
   * (the B7 authority) → hit ⇒ `created: false`; currency check
   * (`BI4`); `activeHold === 0` ⇒ `NoActiveCreditHoldError` (`BI5`);
   * `invoiceNumbers.next(tx)` (ALWAYS the last lock, `BI8`); `Invoice.issue`;
   * `credit.consumeHold` (R40, no fact); `invoices.save` + `credits.save`.
   * `clock.now()` is read ONCE and shared by the invoice date, the fact
   * and the ledger entry (`BI13`). The reply is built from the domain
   * outcome BEFORE commit but returned only AFTER `execute` resolves, so a
   * rollback can never produce a success reply — feature 19's rule,
   * unchanged.
   */
  async issue(cmd: IssueInvoiceCommand): Promise<InvoiceIssueReplyPayload> {
    const request = cmd.request;
    const orderReference = OrderNumber.of(request.orderReference);

    // Step 0 — the B7 fast path, outside any transaction (the
    // `DespatchCreationHandler` precedent). The common redelivery case
    // therefore opens no transaction and takes no lock at all.
    const existing = await this.invoices.findByOrderReference(orderReference);
    if (existing) {
      return replyFromSnapshot(existing, false);
    }

    return this.unitOfWork.execute(async (tx) => {
      // 1. claim the credit line — ALWAYS the first lock this service
      // takes (BI8).
      const credit = await this.credits.lockForOrder(tx, request.retailerCode, request.companyCode, orderReference);
      if (!credit) {
        // BI3 — a contract violation: nothing was written (the
        // transaction rolls back), no fact is emitted.
        throw new CreditLineNotFoundError(request.retailerCode, request.companyCode);
      }

      // 2. the B7 authority, now that the credit lock serialises every
      // competitor.
      const existingLocked = await this.invoices.lockByOrderReference(tx, orderReference);
      if (existingLocked) {
        // BI9 — nothing was written (the transaction commits with no
        // writes), no second fact.
        return replyFromSnapshot(existingLocked, false);
      }

      // 3. currency check against the credit line (BI4).
      if (request.currency !== credit.currency) {
        throw new InvoiceCurrencyMismatchError(credit.currency, request.currency);
      }

      // 4. activeHold(order) from the loaded ledger; 0 ⇒
      // NoActiveCreditHoldError (BI5). Nothing written, no fact.
      const activeHold = credit.summary.byOrder.find((order) => order.orderReference === orderReference.value)?.activeHold ?? 0;
      if (activeHold <= 0) {
        throw new NoActiveCreditHoldError(request.orderReference);
      }

      // 5. allocate the reference — the LAST lock taken (BI8).
      const invoiceReference = await this.invoiceNumbers.next(tx);

      const ctx: InvoiceContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };

      // 6. domain.
      const invoice = Invoice.issue(
        {
          id: UniqueId.generate(),
          invoiceReference,
          invoiceDate: ctx.occurredAt,
          orderReference,
          retailerCode: request.retailerCode,
          companyCode: request.companyCode,
          currency: request.currency,
          lines: request.lines.map((line) => ({
            productCode: line.productCode,
            units: Quantity.of(line.units),
            unitPrice: Money.of(line.unitPrice, request.currency),
          })),
          discount: Money.of(request.discount ?? 0, request.currency),
          correlationId: cmd.correlationId,
        },
        ctx,
      );
      credit.consumeHold({ orderReference }, ctx, () => UniqueId.generate());

      // 7. persist both aggregates in this one transaction (BI7, §5.6).
      await this.invoices.save(invoice, tx);
      await this.credits.save(credit, tx);

      return replyFromInvoice(invoice, true);
    });
  }
}
