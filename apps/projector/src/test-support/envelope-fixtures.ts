// Envelope builders for all THIRTEEN facts (design.md §10, task G1) — used
// by domain unit specs (no container) and by every integration spec in
// this service. Same `makeEnvelope` shape as
// apps/notifications/src/test-support/envelope-fixtures.ts, extended to the
// full catalogue this service must handle (domain-model.md §7.2).
import type {
  CreditApprovedPayload,
  CreditRejectedPayload,
  CreditReleasedPayload,
  Envelope,
  InvoiceIssuedPayload,
  OrderCancelledPayload,
  OrderCompletedPayload,
  OrderConfirmedPayload,
  OrderDespatchedPayload,
  OrderPlacedPayload,
  OrderSagaFailedPayload,
  PaymentReceivedPayload,
  StockRejectedPayload,
  StockReleasedPayload,
  StockReservedPayload,
} from '@otc/contracts';

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function makeEnvelope<TPayload>(
  eventType: string,
  payload: TPayload,
  overrides: Partial<Envelope> = {},
): Envelope {
  return {
    eventId: nextId('event'),
    eventType,
    aggregateId: overrides.aggregateId ?? 'aggregate-1',
    correlationId: overrides.correlationId ?? 'order-1',
    causationId: overrides.causationId ?? 'cause-1',
    occurredAt: overrides.occurredAt ?? '2026-08-24T10:00:00.000Z',
    payload: payload as Record<string, never>,
    ...overrides,
  };
}

export function orderPlacedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderPlacedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    buyerGln: '1234567890128',
    supplierGln: '1234567890128',
    currency: 'USD',
    orderDate: '2026-08-24T09:00:00.000Z',
    lines: [{ productCode: 'P1', quantity: 2, unitPrice: 1000, lineDiscount: 0 }],
    initialAmount: 2000,
    initialDiscount: 0,
    totalAmount: 2000,
  };
  return makeEnvelope('order.placed.v1', payload, overrides);
}

export function stockReservedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: StockReservedPayload = {
    orderReference: 'ORD-000001',
    companyCode: 'COMPANY01',
    reservations: [{ reservationId: 'res-1', productCode: 'P1', units: 2 }],
  };
  return makeEnvelope('stock.reserved.v1', payload, overrides);
}

export function stockRejectedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: StockRejectedPayload = {
    orderReference: 'ORD-000001',
    companyCode: 'COMPANY01',
    shortages: [{ productCode: 'P1', requested: 5, available: 2 }],
    reason: 'insufficient_stock',
  };
  return makeEnvelope('stock.rejected.v1', payload, overrides);
}

export function stockReleasedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: StockReleasedPayload = {
    orderReference: 'ORD-000001',
    companyCode: 'COMPANY01',
    released: [{ reservationId: 'res-1', productCode: 'P1', units: 2 }],
    reason: 'credit_rejected',
  };
  return makeEnvelope('stock.released.v1', payload, overrides);
}

export function creditApprovedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: CreditApprovedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    creditCode: 'CR-000001',
    currency: 'USD',
    heldAmount: 2000,
    availableCreditAfter: 98000,
  };
  return makeEnvelope('credit.approved.v1', payload, overrides);
}

export function creditRejectedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: CreditRejectedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    currency: 'USD',
    requestedAmount: 2000,
    availableCredit: 500,
    reason: 'over_limit',
  };
  return makeEnvelope('credit.rejected.v1', payload, overrides);
}

export function creditReleasedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: CreditReleasedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    currency: 'USD',
    releasedAmount: 2000,
    availableCreditAfter: 100000,
    reason: 'invoice_paid',
  };
  return makeEnvelope('credit.released.v1', payload, overrides);
}

export function orderConfirmedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderConfirmedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    currency: 'USD',
    totalAmount: 2000,
    confirmedAt: '2026-08-24T11:00:00.000Z',
  };
  return makeEnvelope('order.confirmed.v1', payload, overrides);
}

export function orderDespatchedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderDespatchedPayload = {
    orderReference: 'ORD-000001',
    despatchReference: 'DES-000001',
    despatchDate: '2026-08-24T12:00:00.000Z',
    companyCode: 'COMPANY01',
    retailerCode: 'RETAILER01',
    lines: [{ productCode: 'P1', units: 2 }],
  };
  return makeEnvelope('order.despatched.v1', payload, overrides);
}

export function invoiceIssuedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: InvoiceIssuedPayload = {
    orderReference: 'ORD-000001',
    invoiceReference: 'INV-000001',
    invoiceDate: '2026-08-24T13:00:00.000Z',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    currency: 'USD',
    lines: [{ productCode: 'P1', units: 2, unitPrice: 1000 }],
    amount: 2000,
    discount: 0,
    totalAmount: 2000,
  };
  return makeEnvelope('invoice.issued.v1', payload, overrides);
}

export function paymentReceivedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: PaymentReceivedPayload = {
    orderReference: 'ORD-000001',
    invoiceReference: 'INV-000001',
    paymentReference: 'PAY-000001',
    currency: 'USD',
    amount: 2000,
    valueDate: '2026-08-24T14:00:00.000Z',
    source: 'robot',
  };
  return makeEnvelope('payment.received.v1', payload, overrides);
}

export function orderCompletedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderCompletedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    currency: 'USD',
    totalAmount: 2000,
    completedAt: '2026-08-24T15:00:00.000Z',
  };
  return makeEnvelope('order.completed.v1', payload, overrides);
}

export function orderCancelledEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderCancelledPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    cancellationReason: 'credit_rejected',
    cancelledAt: '2026-08-24T15:30:00.000Z',
    compensationSteps: [],
  };
  return makeEnvelope('order.cancelled.v1', payload, overrides);
}

export function orderSagaFailedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  const payload: OrderSagaFailedPayload = {
    orderReference: 'ORD-000001',
    command: 'stock.reserve',
    attempts: 3,
    lastError: 'SagaCommandTransportError: no responders',
    failedAt: '2026-08-24T16:00:00.000Z',
  };
  return makeEnvelope('order.saga_failed.v1', payload, overrides);
}

/** All fourteen builders, keyed by `eventType` — the closed set PR2's structural spec cross-checks against `domain-model.md` §7.2. */
export const ALL_FACT_ENVELOPE_BUILDERS: Readonly<Record<string, (overrides?: Partial<Envelope>) => Envelope>> = {
  'order.placed.v1': orderPlacedEnvelope,
  'stock.reserved.v1': stockReservedEnvelope,
  'stock.rejected.v1': stockRejectedEnvelope,
  'stock.released.v1': stockReleasedEnvelope,
  'credit.approved.v1': creditApprovedEnvelope,
  'credit.rejected.v1': creditRejectedEnvelope,
  'credit.released.v1': creditReleasedEnvelope,
  'order.confirmed.v1': orderConfirmedEnvelope,
  'order.despatched.v1': orderDespatchedEnvelope,
  'invoice.issued.v1': invoiceIssuedEnvelope,
  'payment.received.v1': paymentReceivedEnvelope,
  'order.completed.v1': orderCompletedEnvelope,
  'order.cancelled.v1': orderCancelledEnvelope,
  'order.saga_failed.v1': orderSagaFailedEnvelope,
};
