// The fabricated saga history — the hard part (task prompt). 5 `completed`
// orders and exactly 1 `cancelled` order (reason `credit_rejected`, its
// total ending `.99` — the credit simulator's `simulated_cents_rule`
// affordance, domain-model.md §7.2 fact 6 / specs/shared/asyncapi.yaml's own
// `credit.rejected.v1` example). Every fact of every saga is built here
// ONCE and then fanned out by the writers into the three MySQL databases
// (as already-published outbox rows) and the MongoDB `order_timeline`
// document — so the four stores can never disagree about what happened.
//
// **References.** `ORD-000001..006`, `DES-000001..005`, `INV-000001..005`
// are consumed by this seed. Live traffic continues each sequence from
// `MAX(existing sequence) + 1` — e.g. `OrderNumber.fromSequence(maxSeq + 1)`
// — read from the respective business-reference column at insert time; the
// seed itself never needs that lookup because it owns sequences 1..6 (or
// 1..5) outright on an empty database, which is also why it must run before
// any live order is ever placed (documented in progress/impl_seed_job.md).
//
// **Fact ordering (occurredAt).** Every completed saga follows the happy
// path step table of specs/shared/saga.md §3.1 exactly, one instant apart;
// the cancelled saga follows §4.2 (Path B — release, *then* cancel).
// **aggregateId** is the id of the aggregate that actually produced the
// fact (order id / stock item id / credit line id / despatch id / invoice
// id), matching the convention specs/shared/asyncapi.yaml's own examples
// use — never the order id for facts Orders did not produce itself.
// **causationId** IS written here (feature 14, `outbox_and_idempotency`
// — the `causation_id` column now exists in all three committed schemas).
// The seed has no commands, so it follows the written rule of
// specs/outbox_and_idempotency/design.md §3.5: the two root facts
// (`order.placed.v1`, `payment.received.v1`) cite a synthetic deterministic
// command id (`deterministicId('order:<seq>:command:orders.create')` /
// `...:command:payment.register')`); every other fact cites the **eventId
// of the fact that triggered it** rather than a fabricated command id —
// one link shorter than a live saga's causal chain (where a responder's
// fact would cite the triggering command's `x-request-id`), but complete
// and reconstructible.
import { DespatchReference, InvoiceReference, OrderNumber } from '@otc/shared-kernel';
import type {
  CreditApprovedPayload,
  CreditRejectedPayload,
  CreditReleasedPayload,
  DespatchLine,
  InvoiceIssuedPayload,
  InvoiceLine,
  OrderCancelledPayload,
  OrderCompletedPayload,
  OrderConfirmedPayload,
  OrderDespatchedPayload,
  OrderLine,
  OrderPlacedPayload,
  PaymentReceivedPayload,
  ReservationRef,
  StockReleasedPayload,
  StockReservedPayload,
} from '@otc/contracts';
import { deterministicId } from '../deterministic';
import { addDays, addMinutes, addSeconds } from '../clock';
import { CURRENCIES } from './currencies.data';
import { productByCode } from './products.data';
import { companyByCode } from './companies.data';
import { retailerByCode } from './retailers.data';
import { creditByRetailerAndCompany } from './credits.data';

// ── Shared shapes every writer + Mongo consumes ────────────────────────────

export interface OrderLineFixture {
  productCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
}

export interface OutboxFixture {
  id: string;
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  // The eventId of the causing fact, or the id of the causing command
  // (R12) — see the causal-chain table of design.md §3.5, fabricated per
  // this file's header comment.
  causationId: string;
  // `object`, not `Record<string, unknown>` — the imported @otc/contracts
  // payload interfaces (OrderPlacedPayload, StockReservedPayload, ...) have
  // no index signature, and TS refuses to assign a closed interface to a
  // mapped-type target even though it is structurally compatible; `object`
  // has no such restriction while still ruling out primitives.
  payload: object;
  occurredAt: Date;
  publishedAt: Date;
}

export interface TimelineEntryFixture {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface ReservationFixture {
  id: string;
  companyCode: string;
  retailerCode: string;
  productCode: string;
  units: number;
  status: 'consumed' | 'released';
  createdAt: Date;
  updatedAt: Date;
}

export interface DespatchFixture {
  id: string;
  despatchReference: string;
  despatchDate: Date;
  companyCode: string;
  retailerCode: string;
  items: { productCode: string; units: number }[];
}

export interface CreditLedgerEntryFixture {
  id: string;
  creditId: string;
  orderReference: string;
  amount: number;
  type: 'hold' | 'consume' | 'release';
  creditDate: Date;
}

export interface InvoiceFixture {
  id: string;
  invoiceReference: string;
  invoiceDate: Date;
  amount: number;
  discount: number;
  totalAmount: number;
  status: 'paid';
  paidAt: Date;
  items: { productCode: string; units: number; price: number }[];
  payment: {
    id: string;
    paymentReference: string;
    amount: number;
    valueDate: Date;
    source: 'test';
  };
}

export interface OrderSagaFixture {
  sequence: number;
  orderId: string;
  orderReference: string;
  orderDate: Date;
  retailerCode: string;
  companyCode: string;
  currency: string;
  status: 'completed' | 'cancelled';
  cancellationReason: 'credit_rejected' | null;
  lines: OrderLineFixture[];
  initialAmount: number;
  initialDiscount: number;
  totalAmount: number;
  updatedAt: Date;
  ordersOutbox: OutboxFixture[];
  reservations: ReservationFixture[];
  despatch: DespatchFixture | null;
  fulfillmentOutbox: OutboxFixture[];
  creditLedgerEntries: CreditLedgerEntryFixture[];
  invoice: InvoiceFixture | null;
  billingOutbox: OutboxFixture[];
  timeline: TimelineEntryFixture[];
}

/** Deterministic id of the Fulfillment `StockItem` row for one (company, product) pair — shared with stock.data.ts so both agree on the same id. */
export function stockRowId(companyCode: string, productCode: string): string {
  return deterministicId(`stock:${companyCode}:${productCode}`);
}

function currencyOf(code: string): { code: string; decimalPoints: number } {
  const currency = CURRENCIES.find((c) => c.code === code);
  if (!currency) {
    throw new Error(`sagas.data: unknown currency "${code}"`);
  }
  return currency;
}

function sumLines(lines: OrderLineFixture[]): { initialAmount: number; initialDiscount: number; totalAmount: number } {
  const initialAmount = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const initialDiscount = lines.reduce((sum, line) => sum + line.lineDiscount, 0);
  return { initialAmount, initialDiscount, totalAmount: initialAmount - initialDiscount };
}

interface BuildInput {
  sequence: number;
  retailerCode: string;
  companyCode: string;
  lines: { productCode: string; quantity: number; unitPrice?: number; lineDiscount?: number }[];
  orderDate: Date;
}

function resolveLines(input: BuildInput['lines']): OrderLineFixture[] {
  return input.map((line) => ({
    productCode: line.productCode,
    // The `order_items.description` snapshot (design.md §9.1) — resolved
    // once here from the catalogue so `orderPlacedLines(...)` below can
    // simply read it back: the persisted row and the published
    // `order.placed.v1` fact carry the same text by construction, not by
    // coincidence.
    description: productByCode(line.productCode).name,
    quantity: line.quantity,
    unitPrice: line.unitPrice ?? productByCode(line.productCode).price,
    lineDiscount: line.lineDiscount ?? 0,
  }));
}

function orderPlacedLines(lines: OrderLineFixture[]): [OrderLine, ...OrderLine[]] {
  const mapped = lines.map<OrderLine>((line) => ({
    productCode: line.productCode,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineDiscount: line.lineDiscount,
  }));
  return mapped as [OrderLine, ...OrderLine[]];
}

/** Builds one completed saga — the full happy path of specs/shared/saga.md §3.1. */
function buildCompletedSaga(input: BuildInput): OrderSagaFixture {
  const { sequence, retailerCode, companyCode, orderDate: t0 } = input;
  const retailer = retailerByCode(retailerCode);
  const company = companyByCode(companyCode);
  const currency = currencyOf(retailer.currencyCode);
  const lines = resolveLines(input.lines);
  const { initialAmount, initialDiscount, totalAmount } = sumLines(lines);

  const orderId = deterministicId(`order:${sequence}`);
  const orderReference = OrderNumber.fromSequence(sequence).toString();
  const credit = creditByRetailerAndCompany(retailerCode, companyCode);
  const despatchId = deterministicId(`order:${sequence}:despatch`);
  const despatchReference = DespatchReference.fromSequence(sequence).toString();
  const invoiceId = deterministicId(`order:${sequence}:invoice`);
  const invoiceReference = InvoiceReference.fromSequence(sequence).toString();
  const paymentId = deterministicId(`order:${sequence}:payment`);
  const paymentReference = `PAY-SEED-${String(sequence).padStart(6, '0')}`;
  const firstStockItemId = stockRowId(companyCode, lines[0].productCode);

  const tStockReserved = addMinutes(t0, 1);
  const tCreditApproved = addMinutes(t0, 2);
  const tOrderConfirmed = addSeconds(tCreditApproved, 30);
  const tDespatched = addMinutes(t0, 3);
  const tInvoiceIssued = addMinutes(t0, 4);
  const tPaymentReceived = addDays(t0, 1);
  const tCreditReleased = addSeconds(tPaymentReceived, 5);
  const tCompleted = addSeconds(tPaymentReceived, 10);

  const eventId = (eventType: string): string => deterministicId(`order:${sequence}:event:${eventType}`);
  const outboxId = (eventType: string): string => deterministicId(`order:${sequence}:outbox:${eventType}`);

  const reservations: ReservationFixture[] = lines.map((line) => ({
    id: deterministicId(`order:${sequence}:reservation:${line.productCode}`),
    companyCode,
    retailerCode,
    productCode: line.productCode,
    units: line.quantity,
    status: 'consumed',
    createdAt: tStockReserved,
    updatedAt: tDespatched,
  }));

  const reservationRefs: [ReservationRef, ...ReservationRef[]] = reservations.map((reservation) => ({
    reservationId: reservation.id,
    productCode: reservation.productCode,
    units: reservation.units,
  })) as [ReservationRef, ...ReservationRef[]];

  const despatchLines: [DespatchLine, ...DespatchLine[]] = lines.map((line) => ({
    productCode: line.productCode,
    units: line.quantity,
  })) as [DespatchLine, ...DespatchLine[]];

  const invoiceLines: [InvoiceLine, ...InvoiceLine[]] = lines.map((line) => ({
    productCode: line.productCode,
    units: line.quantity,
    unitPrice: line.unitPrice,
  })) as [InvoiceLine, ...InvoiceLine[]];

  // ── payloads, typed against @otc/contracts so a shape mismatch is a
  //    compile error (task prompt: "every seeded event envelope validates
  //    structurally against the contracts types") ──────────────────────────
  const orderPlacedPayload: OrderPlacedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    buyerGln: retailer.gln,
    supplierGln: company.gln,
    currency: currency.code,
    orderDate: t0.toISOString(),
    lines: orderPlacedLines(lines),
    initialAmount,
    initialDiscount,
    totalAmount,
  };

  const stockReservedPayload: StockReservedPayload = {
    orderReference,
    companyCode,
    retailerCode,
    reservations: reservationRefs,
  };

  const creditApprovedPayload: CreditApprovedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    creditCode: credit.code,
    currency: currency.code,
    heldAmount: totalAmount,
    availableCreditAfter: credit.creditLimit - totalAmount,
  };

  const orderConfirmedPayload: OrderConfirmedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    currency: currency.code,
    totalAmount,
    confirmedAt: tOrderConfirmed.toISOString(),
  };

  const orderDespatchedPayload: OrderDespatchedPayload = {
    orderReference,
    despatchReference,
    despatchDate: tDespatched.toISOString(),
    companyCode,
    retailerCode,
    lines: despatchLines,
  };

  const invoiceIssuedPayload: InvoiceIssuedPayload = {
    orderReference,
    invoiceReference,
    invoiceDate: tInvoiceIssued.toISOString(),
    retailerCode,
    companyCode,
    currency: currency.code,
    lines: invoiceLines,
    amount: initialAmount,
    discount: initialDiscount,
    totalAmount,
  };

  const paymentReceivedPayload: PaymentReceivedPayload = {
    orderReference,
    invoiceReference,
    paymentReference,
    currency: currency.code,
    amount: totalAmount,
    valueDate: tPaymentReceived.toISOString(),
    source: 'test',
  };

  const creditReleasedPayload: CreditReleasedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    creditCode: credit.code,
    currency: currency.code,
    releasedAmount: totalAmount,
    availableCreditAfter: credit.creditLimit,
    reason: 'invoice_paid',
  };

  const orderCompletedPayload: OrderCompletedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    currency: currency.code,
    totalAmount,
    completedAt: tCompleted.toISOString(),
  };

  const orderPlacedEventId = eventId('order.placed.v1');
  const stockReservedEventId = eventId('stock.reserved.v1');
  const creditApprovedEventId = eventId('credit.approved.v1');
  const orderConfirmedEventId = eventId('order.confirmed.v1');
  const orderDespatchedEventId = eventId('order.despatched.v1');
  const invoiceIssuedEventId = eventId('invoice.issued.v1');
  const paymentReceivedEventId = eventId('payment.received.v1');
  const creditReleasedEventId = eventId('credit.released.v1');
  const orderCompletedEventId = eventId('order.completed.v1');

  // The causal chain the seed must fabricate (design.md §3.5): the two
  // roots cite a synthetic command id, every other fact cites the eventId
  // of the fact that triggered it.
  const orderPlacedCausationId = deterministicId(`order:${sequence}:command:orders.create`);
  const stockReservedCausationId = orderPlacedEventId;
  const creditApprovedCausationId = stockReservedEventId;
  const orderConfirmedCausationId = creditApprovedEventId;
  const orderDespatchedCausationId = creditApprovedEventId;
  const invoiceIssuedCausationId = orderDespatchedEventId;
  const paymentReceivedCausationId = deterministicId(`order:${sequence}:command:payment.register`);
  const creditReleasedCausationId = paymentReceivedEventId;
  const orderCompletedCausationId = creditReleasedEventId;

  const ordersOutbox: OutboxFixture[] = [
    {
      id: outboxId('order.placed.v1'),
      eventId: orderPlacedEventId,
      eventType: 'order.placed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId: orderPlacedCausationId,
      payload: orderPlacedPayload,
      occurredAt: t0,
      publishedAt: t0,
    },
    {
      id: outboxId('order.confirmed.v1'),
      eventId: orderConfirmedEventId,
      eventType: 'order.confirmed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId: orderConfirmedCausationId,
      payload: orderConfirmedPayload,
      occurredAt: tOrderConfirmed,
      publishedAt: tOrderConfirmed,
    },
    {
      id: outboxId('order.completed.v1'),
      eventId: orderCompletedEventId,
      eventType: 'order.completed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId: orderCompletedCausationId,
      payload: orderCompletedPayload,
      occurredAt: tCompleted,
      publishedAt: tCompleted,
    },
  ];

  const fulfillmentOutbox: OutboxFixture[] = [
    {
      id: outboxId('stock.reserved.v1'),
      eventId: stockReservedEventId,
      eventType: 'stock.reserved.v1',
      aggregateId: firstStockItemId,
      correlationId: orderId,
      causationId: stockReservedCausationId,
      payload: stockReservedPayload,
      occurredAt: tStockReserved,
      publishedAt: tStockReserved,
    },
    {
      id: outboxId('order.despatched.v1'),
      eventId: orderDespatchedEventId,
      eventType: 'order.despatched.v1',
      aggregateId: despatchId,
      correlationId: orderId,
      causationId: orderDespatchedCausationId,
      payload: orderDespatchedPayload,
      occurredAt: tDespatched,
      publishedAt: tDespatched,
    },
  ];

  const billingOutbox: OutboxFixture[] = [
    {
      id: outboxId('credit.approved.v1'),
      eventId: creditApprovedEventId,
      eventType: 'credit.approved.v1',
      aggregateId: credit.id,
      correlationId: orderId,
      causationId: creditApprovedCausationId,
      payload: creditApprovedPayload,
      occurredAt: tCreditApproved,
      publishedAt: tCreditApproved,
    },
    {
      id: outboxId('invoice.issued.v1'),
      eventId: invoiceIssuedEventId,
      eventType: 'invoice.issued.v1',
      aggregateId: invoiceId,
      correlationId: orderId,
      causationId: invoiceIssuedCausationId,
      payload: invoiceIssuedPayload,
      occurredAt: tInvoiceIssued,
      publishedAt: tInvoiceIssued,
    },
    {
      id: outboxId('payment.received.v1'),
      eventId: paymentReceivedEventId,
      eventType: 'payment.received.v1',
      aggregateId: invoiceId,
      correlationId: orderId,
      causationId: paymentReceivedCausationId,
      payload: paymentReceivedPayload,
      occurredAt: tPaymentReceived,
      publishedAt: tPaymentReceived,
    },
    {
      id: outboxId('credit.released.v1'),
      eventId: creditReleasedEventId,
      eventType: 'credit.released.v1',
      aggregateId: credit.id,
      correlationId: orderId,
      causationId: creditReleasedCausationId,
      payload: creditReleasedPayload,
      occurredAt: tCreditReleased,
      publishedAt: tCreditReleased,
    },
  ];

  const timeline: TimelineEntryFixture[] = [
    { eventId: orderPlacedEventId, eventType: 'order.placed.v1', occurredAt: t0, summary: `Order ${orderReference} placed for ${retailerCode}` },
    { eventId: stockReservedEventId, eventType: 'stock.reserved.v1', occurredAt: tStockReserved, summary: `Stock reserved for ${reservations.length} line(s)` },
    { eventId: creditApprovedEventId, eventType: 'credit.approved.v1', occurredAt: tCreditApproved, summary: `Credit hold of ${totalAmount} ${currency.code} approved` },
    { eventId: orderConfirmedEventId, eventType: 'order.confirmed.v1', occurredAt: tOrderConfirmed, summary: 'Order confirmed (ORDRSP)' },
    { eventId: orderDespatchedEventId, eventType: 'order.despatched.v1', occurredAt: tDespatched, summary: `Despatch ${despatchReference} created` },
    { eventId: invoiceIssuedEventId, eventType: 'invoice.issued.v1', occurredAt: tInvoiceIssued, summary: `Invoice ${invoiceReference} issued` },
    { eventId: paymentReceivedEventId, eventType: 'payment.received.v1', occurredAt: tPaymentReceived, summary: `Payment ${paymentReference} received` },
    { eventId: creditReleasedEventId, eventType: 'credit.released.v1', occurredAt: tCreditReleased, summary: 'Credit exposure released — invoice paid' },
    { eventId: orderCompletedEventId, eventType: 'order.completed.v1', occurredAt: tCompleted, summary: `Order ${orderReference} completed` },
  ];

  return {
    sequence,
    orderId,
    orderReference,
    orderDate: t0,
    retailerCode,
    companyCode,
    currency: currency.code,
    status: 'completed',
    cancellationReason: null,
    lines,
    initialAmount,
    initialDiscount,
    totalAmount,
    updatedAt: tCompleted,
    ordersOutbox,
    reservations,
    despatch: {
      id: despatchId,
      despatchReference,
      despatchDate: tDespatched,
      companyCode,
      retailerCode,
      items: lines.map((line) => ({ productCode: line.productCode, units: line.quantity })),
    },
    fulfillmentOutbox,
    creditLedgerEntries: [
      { id: deterministicId(`order:${sequence}:credit-item:hold`), creditId: credit.id, orderReference, amount: totalAmount, type: 'hold', creditDate: tCreditApproved },
      { id: deterministicId(`order:${sequence}:credit-item:consume`), creditId: credit.id, orderReference, amount: totalAmount, type: 'consume', creditDate: tInvoiceIssued },
      { id: deterministicId(`order:${sequence}:credit-item:release`), creditId: credit.id, orderReference, amount: totalAmount, type: 'release', creditDate: tCreditReleased },
    ],
    invoice: {
      id: invoiceId,
      invoiceReference,
      invoiceDate: tInvoiceIssued,
      amount: initialAmount,
      discount: initialDiscount,
      totalAmount,
      status: 'paid',
      paidAt: tPaymentReceived,
      items: lines.map((line) => ({ productCode: line.productCode, units: line.quantity, price: line.unitPrice })),
      payment: {
        id: paymentId,
        paymentReference,
        amount: totalAmount,
        valueDate: tPaymentReceived,
        source: 'test',
      },
    },
    billingOutbox,
    timeline,
  };
}

/** Builds the one cancelled saga — the compensation path of specs/shared/saga.md §4.2 (release, then cancel). */
function buildCancelledSaga(input: BuildInput): OrderSagaFixture {
  const { sequence, retailerCode, companyCode, orderDate: t0 } = input;
  const retailer = retailerByCode(retailerCode);
  const company = companyByCode(companyCode);
  const currency = currencyOf(retailer.currencyCode);
  const lines = resolveLines(input.lines);
  const { initialAmount, initialDiscount, totalAmount } = sumLines(lines);
  if (totalAmount % 100 !== 99) {
    throw new Error(
      `buildCancelledSaga: order ${sequence} total ${totalAmount} does not end in .99 — the simulated_cents_rule demo requires it`,
    );
  }

  const orderId = deterministicId(`order:${sequence}`);
  const orderReference = OrderNumber.fromSequence(sequence).toString();
  const credit = creditByRetailerAndCompany(retailerCode, companyCode);
  const firstStockItemId = stockRowId(companyCode, lines[0].productCode);

  const tStockReserved = addMinutes(t0, 1);
  const tCreditRejected = addMinutes(t0, 2);
  const tStockReleased = addMinutes(t0, 3);
  const tCancelled = addSeconds(tStockReleased, 30);

  const eventId = (eventType: string): string => deterministicId(`order:${sequence}:event:${eventType}`);
  const outboxId = (eventType: string): string => deterministicId(`order:${sequence}:outbox:${eventType}`);

  const reservations: ReservationFixture[] = lines.map((line) => ({
    id: deterministicId(`order:${sequence}:reservation:${line.productCode}`),
    companyCode,
    retailerCode,
    productCode: line.productCode,
    units: line.quantity,
    status: 'released',
    createdAt: tStockReserved,
    updatedAt: tStockReleased,
  }));

  const reservationRefs: [ReservationRef, ...ReservationRef[]] = reservations.map((reservation) => ({
    reservationId: reservation.id,
    productCode: reservation.productCode,
    units: reservation.units,
  })) as [ReservationRef, ...ReservationRef[]];

  const orderPlacedPayload: OrderPlacedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    buyerGln: retailer.gln,
    supplierGln: company.gln,
    currency: currency.code,
    orderDate: t0.toISOString(),
    lines: orderPlacedLines(lines),
    initialAmount,
    initialDiscount,
    totalAmount,
    notes: 'demo — compensation path (credit_rejected, .99 rule)',
  };

  const stockReservedPayload: StockReservedPayload = {
    orderReference,
    companyCode,
    retailerCode,
    reservations: reservationRefs,
  };

  const creditRejectedPayload: CreditRejectedPayload = {
    orderReference,
    retailerCode,
    companyCode,
    creditCode: credit.code,
    currency: currency.code,
    requestedAmount: totalAmount,
    availableCredit: credit.creditLimit,
    reason: 'simulated_cents_rule',
  };

  const stockReleasedPayload: StockReleasedPayload = {
    orderReference,
    companyCode,
    retailerCode,
    released: reservationRefs,
    reason: 'credit_rejected',
  };

  const orderPlacedEventId = eventId('order.placed.v1');
  const stockReservedEventId = eventId('stock.reserved.v1');
  const creditRejectedEventId = eventId('credit.rejected.v1');
  const stockReleasedEventId = eventId('stock.released.v1');
  const orderCancelledEventId = eventId('order.cancelled.v1');

  // The causal chain the seed must fabricate (design.md §3.5) — Path B
  // (release, then cancel).
  const orderPlacedCausationId = deterministicId(`order:${sequence}:command:orders.create`);
  const stockReservedCausationId = orderPlacedEventId;
  const creditRejectedCausationId = stockReservedEventId;
  const stockReleasedCausationId = creditRejectedEventId;
  const orderCancelledCausationId = stockReleasedEventId;

  const orderCancelledPayload: OrderCancelledPayload = {
    orderReference,
    retailerCode,
    companyCode,
    cancellationReason: 'credit_rejected',
    cancelledAt: tCancelled.toISOString(),
    compensationSteps: [
      {
        step: 'stock_released',
        eventId: stockReleasedEventId,
        eventType: 'stock.released.v1',
        occurredAt: tStockReleased.toISOString(),
        summary: `${reservations.reduce((sum, r) => sum + r.units, 0)} unit(s) released back to stock`,
      },
    ],
  };

  const ordersOutbox: OutboxFixture[] = [
    {
      id: outboxId('order.placed.v1'),
      eventId: orderPlacedEventId,
      eventType: 'order.placed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId: orderPlacedCausationId,
      payload: orderPlacedPayload,
      occurredAt: t0,
      publishedAt: t0,
    },
    {
      id: outboxId('order.cancelled.v1'),
      eventId: orderCancelledEventId,
      eventType: 'order.cancelled.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId: orderCancelledCausationId,
      payload: orderCancelledPayload,
      occurredAt: tCancelled,
      publishedAt: tCancelled,
    },
  ];

  const fulfillmentOutbox: OutboxFixture[] = [
    {
      id: outboxId('stock.reserved.v1'),
      eventId: stockReservedEventId,
      eventType: 'stock.reserved.v1',
      aggregateId: firstStockItemId,
      correlationId: orderId,
      causationId: stockReservedCausationId,
      payload: stockReservedPayload,
      occurredAt: tStockReserved,
      publishedAt: tStockReserved,
    },
    {
      id: outboxId('stock.released.v1'),
      eventId: stockReleasedEventId,
      eventType: 'stock.released.v1',
      aggregateId: firstStockItemId,
      correlationId: orderId,
      causationId: stockReleasedCausationId,
      payload: stockReleasedPayload,
      occurredAt: tStockReleased,
      publishedAt: tStockReleased,
    },
  ];

  const billingOutbox: OutboxFixture[] = [
    {
      id: outboxId('credit.rejected.v1'),
      eventId: creditRejectedEventId,
      eventType: 'credit.rejected.v1',
      aggregateId: credit.id,
      correlationId: orderId,
      causationId: creditRejectedCausationId,
      payload: creditRejectedPayload,
      occurredAt: tCreditRejected,
      publishedAt: tCreditRejected,
    },
  ];

  const timeline: TimelineEntryFixture[] = [
    { eventId: orderPlacedEventId, eventType: 'order.placed.v1', occurredAt: t0, summary: `Order ${orderReference} placed for ${retailerCode}` },
    { eventId: stockReservedEventId, eventType: 'stock.reserved.v1', occurredAt: tStockReserved, summary: `Stock reserved for ${reservations.length} line(s)` },
    {
      eventId: creditRejectedEventId,
      eventType: 'credit.rejected.v1',
      occurredAt: tCreditRejected,
      summary: `Credit hold of ${totalAmount} ${currency.code} rejected (simulated_cents_rule)`,
      detail: { reason: creditRejectedPayload.reason, requestedAmount: totalAmount },
    },
    {
      eventId: stockReleasedEventId,
      eventType: 'stock.released.v1',
      occurredAt: tStockReleased,
      summary: `${reservations.reduce((sum, r) => sum + r.units, 0)} unit(s) released back to stock (compensation)`,
    },
    {
      eventId: orderCancelledEventId,
      eventType: 'order.cancelled.v1',
      occurredAt: tCancelled,
      summary: `Order ${orderReference} cancelled (credit_rejected)`,
      detail: { cancellationReason: 'credit_rejected' },
    },
  ];

  return {
    sequence,
    orderId,
    orderReference,
    orderDate: t0,
    retailerCode,
    companyCode,
    currency: currency.code,
    status: 'cancelled',
    cancellationReason: 'credit_rejected',
    lines,
    initialAmount,
    initialDiscount,
    totalAmount,
    updatedAt: tCancelled,
    ordersOutbox,
    reservations,
    despatch: null,
    fulfillmentOutbox,
    creditLedgerEntries: [],
    invoice: null,
    billingOutbox,
    timeline,
  };
}

const BASE_DATE = new Date('2026-06-01T09:00:00.000Z');

export const SAGAS: readonly OrderSagaFixture[] = [
  buildCompletedSaga({
    sequence: 1,
    retailerCode: 'CarrefourEs',
    companyCode: 'IBERFOODS',
    orderDate: BASE_DATE,
    lines: [
      { productCode: 'PRD-0002', quantity: 5 },
      { productCode: 'PRD-0003', quantity: 3 },
    ],
  }),
  buildCompletedSaga({
    sequence: 2,
    retailerCode: 'CarrefourFr',
    companyCode: 'FRESHFR',
    orderDate: addDays(BASE_DATE, 1),
    lines: [
      { productCode: 'PRD-0002', quantity: 4 },
      { productCode: 'PRD-0008', quantity: 2 },
    ],
  }),
  buildCompletedSaga({
    sequence: 3,
    retailerCode: 'LeroyMerlinEs',
    companyCode: 'TOOLIBERIA',
    orderDate: addDays(BASE_DATE, 2),
    lines: [
      { productCode: 'PRD-0004', quantity: 10 },
      { productCode: 'PRD-0005', quantity: 6 },
    ],
  }),
  buildCompletedSaga({
    sequence: 4,
    retailerCode: 'AldiDe',
    companyCode: 'GERMANFOODS',
    orderDate: addDays(BASE_DATE, 3),
    lines: [
      { productCode: 'PRD-0002', quantity: 8 },
      { productCode: 'PRD-0003', quantity: 4 },
    ],
  }),
  buildCompletedSaga({
    sequence: 5,
    retailerCode: 'AldiGb',
    companyCode: 'UKDISTRIB',
    orderDate: addDays(BASE_DATE, 4),
    lines: [
      { productCode: 'PRD-0009', quantity: 20 },
      { productCode: 'PRD-0010', quantity: 15 },
    ],
  }),
  buildCancelledSaga({
    sequence: 6,
    retailerCode: 'CarrefourEs',
    companyCode: 'IBERFOODS',
    orderDate: addDays(BASE_DATE, 5),
    lines: [{ productCode: 'PRD-0001', quantity: 1 }],
  }),
];

export const COMPLETED_SAGAS = SAGAS.filter((saga) => saga.status === 'completed');
export const CANCELLED_SAGAS = SAGAS.filter((saga) => saga.status === 'cancelled');
