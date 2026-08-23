// The two fact builders `Invoice` uses — design.md §3.4. Mirrors
// `credit-events.ts`/`stock-events.ts` exactly: `createDomainEvent` from
// `@otc/shared-kernel`, payload types from `@otc/contracts` (`import type`
// only), the same `Indexed<TPayload>` intersection trick, `aggregateId` =
// the invoice's own id (domain-model.md §7.2 names `Invoice` as the
// producing aggregate of facts 10 and 11), `correlationId` = the order id,
// `causationId`/`occurredAt` from `InvoiceContext`.
//
// **`invoice.issued.v1` has exactly ONE builder and exactly ONE call
// site** — `Invoice.issue`. **`payment.received.v1` has exactly ONE
// builder and exactly ONE call site** — `Invoice.markPaid`. Neither is
// reachable from the application layer, the repository or a controller, so
// "the fact accompanies the state change" is structural (O8's analogue for
// this aggregate, design.md §3.4).
import { createDomainEvent, type DomainEventEnvelope, type UniqueId } from '@otc/shared-kernel';
import type { InvoiceIssuedPayload, InvoiceLine as InvoiceLinePayload, PaymentReceivedPayload } from '@otc/contracts';
import type { Invoice, InvoiceContext } from './invoice.js';

/**
 * `createDomainEvent`'s generic parameter is constrained to
 * `Record<string, unknown>`; a generated `@otc/contracts` payload interface
 * has no index signature, so intersecting with `Record<string, unknown>`
 * gives the type an index signature without changing its real shape — the
 * same precedent `apps/orders/src/domain/order-events.ts` and
 * `credit-events.ts` document.
 */
type Indexed<TPayload> = TPayload & Record<string, unknown>;

export function invoiceIssuedEvent(
  carrier: Invoice,
  input: {
    readonly orderReference: string;
    readonly retailerCode: string;
    readonly companyCode: string;
    readonly currency: string;
    readonly lines: readonly InvoiceLinePayload[];
    readonly amount: number;
    readonly discount: number;
    readonly totalAmount: number;
  },
  correlationId: UniqueId,
  ctx: InvoiceContext,
): DomainEventEnvelope<Indexed<InvoiceIssuedPayload>> {
  const nonEmptyLines = input.lines as [InvoiceLinePayload, ...InvoiceLinePayload[]];
  const payload: InvoiceIssuedPayload = {
    orderReference: input.orderReference,
    invoiceReference: carrier.invoiceReference.value,
    invoiceDate: carrier.invoiceDate.toISOString(),
    retailerCode: input.retailerCode,
    companyCode: input.companyCode,
    currency: input.currency,
    lines: nonEmptyLines,
    amount: input.amount,
    discount: input.discount,
    totalAmount: input.totalAmount,
  };
  return createDomainEvent<Indexed<InvoiceIssuedPayload>>({
    eventType: 'invoice.issued.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<InvoiceIssuedPayload>,
  });
}

export function paymentReceivedEvent(
  carrier: Invoice,
  input: {
    readonly orderReference: string;
    readonly paymentReference: string;
    readonly currency: string;
    readonly amount: number;
    readonly valueDate: Date;
    readonly source: PaymentReceivedPayload['source'];
  },
  correlationId: UniqueId,
  ctx: InvoiceContext,
): DomainEventEnvelope<Indexed<PaymentReceivedPayload>> {
  const payload: PaymentReceivedPayload = {
    orderReference: input.orderReference,
    invoiceReference: carrier.invoiceReference.value,
    paymentReference: input.paymentReference,
    currency: input.currency,
    amount: input.amount,
    valueDate: input.valueDate.toISOString(),
    source: input.source,
  };
  return createDomainEvent<Indexed<PaymentReceivedPayload>>({
    eventType: 'payment.received.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<PaymentReceivedPayload>,
  });
}
