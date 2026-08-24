// The `billing.payment.register` transactional unit as a PLAIN CLASS (no
// decorator) — mirrors `invoice-issue.handler.ts`'s split exactly, so a
// unit test can `new` it with fakes. This is feature 21's `Invoice.markPaid`
// seam's live caller (R47-R49), and `BuyerCredit.releaseHold`'s live
// caller too — both aggregate methods were delivered, unit-tested and
// uncalled by `billing_invoicing`; nothing about their own behaviour
// changes here.
import { InvoiceReference, Money, UniqueId } from '@otc/shared-kernel';
import type { PaymentRegisterReplyPayload } from '@otc/contracts';
import type { RegisterPaymentCommand } from './commands/payment.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { InvoiceRepository, PaymentRecordSnapshot } from './ports/invoice-repository.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { CreditLineNotFoundError } from './credit-application-errors.js';
import { InvoiceNotFoundError, PaymentReferenceConflictError } from './invoice-application-errors.js';
import { Invoice, type InvoiceContext } from '../domain/invoice.js';
import type { InvoiceSnapshot } from '../domain/invoice-snapshot.js';

function identityOf(request: { readonly invoiceId?: string; readonly invoiceReference?: string }): string {
  return request.invoiceId ?? request.invoiceReference ?? '(no invoice identity given)';
}

/**
 * N11 (review_billing_remittance_intake.md) — the fast path's missing
 * check. A `paymentReference` already recorded is not, by itself, proof
 * of a genuine redelivery: the caller may have reused the SAME reference
 * against a DIFFERENT invoice. Compares whichever identifier(s) the
 * request actually supplied against the invoice `findPaymentByReference`
 * resolved; an omitted identifier is not a mismatch (the DTO's
 * `AtLeastOneInvoiceIdentifier` guarantees at least one is present).
 */
function identityMatchesInvoice(request: { readonly invoiceId?: string; readonly invoiceReference?: string }, invoice: InvoiceSnapshot): boolean {
  if (request.invoiceId !== undefined && request.invoiceId !== invoice.id.value) {
    return false;
  }
  if (request.invoiceReference !== undefined && request.invoiceReference !== invoice.invoiceReference.value) {
    return false;
  }
  return true;
}

function replyFromDuplicate(invoice: InvoiceSnapshot, payment: PaymentRecordSnapshot): PaymentRegisterReplyPayload {
  return {
    outcome: 'duplicate',
    paymentReference: payment.paymentReference,
    invoiceReference: invoice.invoiceReference.value,
    orderReference: invoice.orderReference.value,
    invoiceStatus: invoice.status,
    ...(invoice.paidAt ? { paidAt: invoice.paidAt.toISOString() } : {}),
  };
}

function replyFromInvoice(invoice: Invoice, paymentReference: string): PaymentRegisterReplyPayload {
  return {
    outcome: 'accepted',
    paymentReference,
    invoiceReference: invoice.invoiceReference.value,
    orderReference: invoice.orderReference.value,
    invoiceStatus: invoice.status,
    ...(invoice.paidAt ? { paidAt: invoice.paidAt.toISOString() } : {}),
  };
}

export class PaymentRegisterHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly credits: BuyerCreditRepository,
    private readonly invoices: InvoiceRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * §—: the R48 fast path, outside any transaction (the `invoice.issue`
   * `findByOrderReference` precedent, keyed on `paymentReference` instead
   * of `orderReference`) → identity resolution (also non-transactional) so
   * `credits.lockForOrder` — ALWAYS the FIRST lock this service takes
   * (BI8, extended to this subject) — has what it needs before any
   * transaction opens → inside one `unitOfWork.execute`: credit lock,
   * then the invoice's own row lock (SECOND), the R48 authority re-read
   * under it, then `Invoice.markPaid` (R49's three refusals, all raised
   * by the aggregate itself), then `BuyerCredit.releaseHold`, then
   * persist `invoices` BEFORE `credits` so `payment.received.v1` gets a
   * lower outbox `seq` than `credit.released.v1` (R47's ordering). The
   * reply is built from the domain outcome BEFORE commit but returned
   * only AFTER `execute` resolves, so a rollback can never produce a
   * success reply — feature 19's rule, unchanged.
   */
  async register(cmd: RegisterPaymentCommand): Promise<PaymentRegisterReplyPayload> {
    const request = cmd.request;

    // Step 0 — the R48 fast path, outside any transaction. The common
    // redelivery case (a retrying robot, a re-dispatched sweeper attempt)
    // therefore opens no transaction and takes no lock at all.
    const existingPayment = await this.invoices.findPaymentByReference(request.paymentReference);
    if (existingPayment) {
      const paidInvoice = await this.invoices.findById(existingPayment.invoiceId);
      if (!paidInvoice) {
        throw new InvoiceNotFoundError(existingPayment.invoiceId.value);
      }
      if (!identityMatchesInvoice(request, paidInvoice)) {
        // N11 — the SAME condition the concurrent path's UNIQUE-constraint
        // backstop catches (two DIFFERENT invoices, one paymentReference).
        // One condition, one answer, whichever path reaches it first: no
        // transaction opened, no lock taken, exactly as the genuine-
        // redelivery case above it.
        throw new PaymentReferenceConflictError(request.paymentReference);
      }
      return replyFromDuplicate(paidInvoice, existingPayment);
    }

    // Identity resolution — non-transactional, no lock. Needed BEFORE any
    // transaction opens because `credits.lockForOrder` needs the target
    // invoice's `retailerCode`/`companyCode`/`orderReference`, and BI8's
    // lock order (credits ALWAYS first) is fixed before either lock is
    // taken.
    const invoiceSnapshot = await this.resolveInvoice(request);
    if (!invoiceSnapshot) {
      throw new InvoiceNotFoundError(identityOf(request));
    }

    return this.unitOfWork.execute(async (tx) => {
      // 1. claim the credit line — ALWAYS the first lock this service
      // takes (BI8, extended to `billing.payment.register`).
      const credit = await this.credits.lockForOrder(
        tx,
        invoiceSnapshot.retailerCode,
        invoiceSnapshot.companyCode,
        invoiceSnapshot.orderReference,
      );
      if (!credit) {
        // Unreachable in this model — an issued invoice implies its
        // credit line already existed at issue time and nothing deletes
        // one — kept for the same reason `invoice-issue.handler.ts`
        // keeps its own `CreditLineNotFoundError` branch: a defensive
        // refusal that changes nothing and emits nothing rather than a
        // silent `undefined` dereference.
        throw new CreditLineNotFoundError(invoiceSnapshot.retailerCode, invoiceSnapshot.companyCode);
      }

      // 2. the payment-register authority read: the invoice's OWN row
      // lock — the SECOND lock, AFTER credits (BI8). Fully serialises
      // every concurrent `payment.register` call naming this SAME
      // invoice, whatever `paymentReference` each one carries.
      const lockedSnapshot = await this.invoices.lockById(tx, invoiceSnapshot.id);
      if (!lockedSnapshot) {
        throw new InvoiceNotFoundError(invoiceSnapshot.id.value);
      }

      const invoice = Invoice.reconstitute(lockedSnapshot);

      // 3. the R48 authority re-read, now that the invoice lock
      // serialises every competitor — closes the race the step-0 fast
      // path leaves open between its own read and this transaction's
      // commit.
      if (invoice.status === 'paid') {
        const paidBy = await this.invoices.findPaymentByInvoiceId(tx, invoice.id);
        if (paidBy && paidBy.paymentReference === request.paymentReference) {
          // Nothing new written — this transaction commits empty.
          return replyFromDuplicate(lockedSnapshot, paidBy);
        }
        // Falls through: `markPaid` below raises `InvoiceAlreadyPaidError`
        // itself (B8) — a DIFFERENT paymentReference against an
        // already-paid invoice, R49's third case.
      }

      const ctx: InvoiceContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };
      const amount = Money.of(request.amount.amount, request.amount.currency);

      // 4. domain — R49's three refusals (currency mismatch, amount
      // mismatch, already paid) are ALL raised here, by the aggregate
      // itself (B8, B10); nothing written, no fact, on every one of them.
      invoice.markPaid(
        {
          paymentReference: request.paymentReference,
          amount,
          valueDate: new Date(request.valueDate),
          source: request.source,
          correlationId: cmd.correlationId,
        },
        ctx,
      );

      // 5. the release counterpart (feature 22's own addition): the
      // ledger identity `exposure(order) = Σhold − Σrelease` (`consume`
      // is numerically neutral, `credit-exposure.ts`) means `outstanding`
      // here is exactly the order's original hold amount — this returns
      // `availableCredit` to precisely where it started.
      credit.releaseHold(
        { orderReference: invoiceSnapshot.orderReference, reason: 'invoice_paid', correlationId: cmd.correlationId },
        ctx,
        () => UniqueId.generate(),
      );

      // 6. persist BOTH aggregates in this one transaction — `invoices`
      // FIRST, so `payment.received.v1`'s outbox row commits (and is
      // assigned its `seq`) strictly before `credit.released.v1`'s
      // (R47's ordering, made structural by call order — see the unit
      // test that arms this).
      await this.invoices.markPaid(
        invoice,
        { id: UniqueId.generate(), paymentReference: request.paymentReference, amount, valueDate: new Date(request.valueDate), source: request.source, createdAt: ctx.occurredAt },
        tx,
      );
      await this.credits.save(credit, tx);

      return replyFromInvoice(invoice, request.paymentReference);
    });
  }

  private async resolveInvoice(request: { readonly invoiceId?: string; readonly invoiceReference?: string }): Promise<InvoiceSnapshot | null> {
    if (request.invoiceId) {
      return this.invoices.findById(UniqueId.from(request.invoiceId));
    }
    if (request.invoiceReference) {
      return this.invoices.findByInvoiceReference(InvoiceReference.of(request.invoiceReference));
    }
    // The DTO's `AtLeastOneInvoiceIdentifier` constraint already refuses
    // this before the controller ever dispatches `RegisterPaymentCommand`
    // — kept as a defensive fallback rather than a non-null assertion.
    return null;
  }
}
