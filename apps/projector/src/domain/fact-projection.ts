// `projectFact(envelope): ProjectionDelta` (design.md §4) — a thirteen-arm
// switch with NO default arm that silently returns: an unknown type throws
// `UnknownFactTypeError`, which `presentation/projector-facts.controller.ts`
// turns into PR4's log-and-acknowledge. ZERO framework/driver imports
// (PR28) and no clock read anywhere (PR14) — every timestamp on the
// returned delta comes from the envelope's own `occurredAt`.
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
import { impliedStatusOf, rankOf } from './order-status-rank';
import type { ProjectionDelta } from './projection-delta';
import {
  creditApprovedSummary,
  creditRejectedSummary,
  creditReleasedSummary,
  invoiceIssuedSummary,
  orderCancelledSummary,
  orderCompletedSummary,
  orderConfirmedSummary,
  orderDespatchedSummary,
  orderPlacedSummary,
  orderSagaFailedSummary,
  paymentReceivedSummary,
  stockRejectedSummary,
  stockReleasedSummary,
  stockReservedSummary,
} from './summaries';

export class UnknownFactTypeError extends Error {
  constructor(eventType: string) {
    super(`fact-projection: unknown eventType "${eventType}" — not one of the fourteen facts`);
    this.name = new.target.name;
  }
}

/** The fourteen `eventType` keys this switch covers — the other half of PR2's structural cross-check (fact-projection.spec.ts). */
export const HANDLED_EVENT_TYPES = [
  'order.placed.v1',
  'stock.reserved.v1',
  'stock.rejected.v1',
  'stock.released.v1',
  'credit.approved.v1',
  'credit.rejected.v1',
  'credit.released.v1',
  'order.confirmed.v1',
  'order.despatched.v1',
  'invoice.issued.v1',
  'payment.received.v1',
  'order.completed.v1',
  'order.cancelled.v1',
  'order.saga_failed.v1',
] as const;

export function projectFact(envelope: Envelope): ProjectionDelta {
  // Membership is checked BEFORE any PR12 lookup, so an eventType outside
  // the thirteen throws UnknownFactTypeError here — never
  // order-status-rank.ts's own UnknownEventTypeForRankError, which exists
  // to guard a programmer error inside this file, not a malformed/unknown
  // wire message (PR4's concern).
  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(envelope.eventType)) {
    throw new UnknownFactTypeError(envelope.eventType);
  }

  const base = {
    orderId: envelope.correlationId,
    impliedStatus: impliedStatusOf(envelope.eventType),
    statusRank: rankOf(envelope.eventType),
  };

  switch (envelope.eventType) {
    case 'order.placed.v1': {
      const payload = envelope.payload as OrderPlacedPayload;
      const { summary } = orderPlacedSummary(payload);
      return {
        ...base,
        entry: entryOf(envelope, summary),
        fillIfAbsent: {},
        header: {
          orderReference: payload.orderReference,
          orderDate: payload.orderDate,
          retailer: { code: payload.retailerCode, gln: payload.buyerGln },
          company: { code: payload.companyCode, gln: payload.supplierGln },
          currency: payload.currency,
          totals: {
            initialAmount: payload.initialAmount,
            initialDiscount: payload.initialDiscount,
            totalAmount: payload.totalAmount,
          },
          items: payload.lines.map((line) => ({
            productCode: line.productCode,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineDiscount: line.lineDiscount,
          })),
        },
      };
    }
    case 'stock.reserved.v1': {
      const payload = envelope.payload as StockReservedPayload;
      const { summary } = stockReservedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary), fillIfAbsent: {} };
    }
    case 'stock.rejected.v1': {
      const payload = envelope.payload as StockRejectedPayload;
      const { summary, detail } = stockRejectedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary, detail), fillIfAbsent: {} };
    }
    case 'stock.released.v1': {
      const payload = envelope.payload as StockReleasedPayload;
      const { summary, detail } = stockReleasedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary, detail), fillIfAbsent: {} };
    }
    case 'credit.approved.v1': {
      const payload = envelope.payload as CreditApprovedPayload;
      const { summary } = creditApprovedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary), fillIfAbsent: {} };
    }
    case 'credit.rejected.v1': {
      const payload = envelope.payload as CreditRejectedPayload;
      const { summary, detail } = creditRejectedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary, detail), fillIfAbsent: {} };
    }
    case 'credit.released.v1': {
      const payload = envelope.payload as CreditReleasedPayload;
      const { summary } = creditReleasedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary), fillIfAbsent: {} };
    }
    case 'order.confirmed.v1': {
      const payload = envelope.payload as OrderConfirmedPayload;
      const { summary } = orderConfirmedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary), fillIfAbsent: {} };
    }
    case 'order.despatched.v1': {
      const payload = envelope.payload as OrderDespatchedPayload;
      const { summary } = orderDespatchedSummary(payload);
      return {
        ...base,
        entry: entryOf(envelope, summary),
        fillIfAbsent: { references: { despatchReference: payload.despatchReference } },
      };
    }
    case 'invoice.issued.v1': {
      const payload = envelope.payload as InvoiceIssuedPayload;
      const { summary } = invoiceIssuedSummary(payload);
      return {
        ...base,
        entry: entryOf(envelope, summary),
        fillIfAbsent: { references: { invoiceReference: payload.invoiceReference } },
      };
    }
    case 'payment.received.v1': {
      const payload = envelope.payload as PaymentReceivedPayload;
      const { summary } = paymentReceivedSummary(payload);
      return {
        ...base,
        entry: entryOf(envelope, summary),
        fillIfAbsent: { references: { paymentReference: payload.paymentReference } },
      };
    }
    case 'order.completed.v1': {
      const payload = envelope.payload as OrderCompletedPayload;
      const { summary } = orderCompletedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary), fillIfAbsent: {} };
    }
    case 'order.cancelled.v1': {
      const payload = envelope.payload as OrderCancelledPayload;
      const { summary, detail } = orderCancelledSummary(payload);
      return {
        ...base,
        entry: entryOf(envelope, summary, detail),
        fillIfAbsent: { cancellationReason: payload.cancellationReason },
      };
    }
    case 'order.saga_failed.v1': {
      // R29's dead-letter clause / OR3 (feature 27) — the 14th fact,
      // purely diagnostic (order-status-rank.ts: status null, rank 0),
      // same "status-less" shape as stock.rejected.v1/credit.rejected.v1
      // above: a timeline entry, `fillIfAbsent: {}`, no header/status
      // change.
      const payload = envelope.payload as OrderSagaFailedPayload;
      const { summary, detail } = orderSagaFailedSummary(payload);
      return { ...base, entry: entryOf(envelope, summary, detail), fillIfAbsent: {} };
    }
    default:
      throw new UnknownFactTypeError(envelope.eventType);
  }
}

function entryOf(envelope: Envelope, summary: string, detail?: Readonly<Record<string, unknown>>) {
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    occurredAt: envelope.occurredAt,
    summary,
    ...(detail ? { detail } : {}),
  };
}
