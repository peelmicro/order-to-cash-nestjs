// The thirteen human-readable summary/detail builders (PR16, design.md §4).
// Each is a pure function of one fact's payload alone — no read-model
// access, no write-model access, no clock — voice-matched to
// `apps/seed/src/data/sagas.data.ts`'s existing prose so a seeded and a
// projected document read alike. ZERO framework/driver imports (PR28).
import type {
  CreditApprovedPayload,
  CreditRejectedPayload,
  CreditReleasedPayload,
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
import { formatMinorUnits } from './money-format';

export interface SummaryResult {
  readonly summary: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function orderPlacedSummary(payload: OrderPlacedPayload): SummaryResult {
  return { summary: `Order ${payload.orderReference} placed for ${payload.retailerCode}` };
}

export function stockReservedSummary(payload: StockReservedPayload): SummaryResult {
  return { summary: `Stock reserved for ${payload.reservations.length} line(s)` };
}

export function stockRejectedSummary(payload: StockRejectedPayload): SummaryResult {
  const totalShort = payload.shortages.reduce((sum, s) => sum + (s.requested - s.available), 0);
  const firstProduct = payload.shortages[0]!.productCode;
  return {
    summary: `Stock rejected: ${totalShort} unit(s) short on ${firstProduct}`,
    detail: { shortages: payload.shortages, reason: payload.reason },
  };
}

export function stockReleasedSummary(payload: StockReleasedPayload): SummaryResult {
  const units = payload.released.reduce((sum, r) => sum + r.units, 0);
  const compensationSuffix = payload.reason === 'credit_rejected' ? ' (compensation)' : '';
  return {
    summary: `${units} unit(s) released back to stock${compensationSuffix}`,
    detail: { released: payload.released, reason: payload.reason },
  };
}

export function creditApprovedSummary(payload: CreditApprovedPayload): SummaryResult {
  return { summary: `Credit hold of ${formatMinorUnits(payload.heldAmount, payload.currency)} approved` };
}

export function creditRejectedSummary(payload: CreditRejectedPayload): SummaryResult {
  return {
    summary: `Credit hold of ${formatMinorUnits(payload.requestedAmount, payload.currency)} rejected (${payload.reason})`,
    detail: { reason: payload.reason, requestedAmount: payload.requestedAmount },
  };
}

export function creditReleasedSummary(payload: CreditReleasedPayload): SummaryResult {
  const suffix = payload.reason === 'invoice_paid' ? 'invoice paid' : 'order cancelled';
  return { summary: `Credit exposure released — ${suffix}` };
}

export function orderConfirmedSummary(_payload: OrderConfirmedPayload): SummaryResult {
  return { summary: 'Order confirmed (ORDRSP)' };
}

export function orderDespatchedSummary(payload: OrderDespatchedPayload): SummaryResult {
  return { summary: `Despatch ${payload.despatchReference} created` };
}

export function invoiceIssuedSummary(payload: InvoiceIssuedPayload): SummaryResult {
  return { summary: `Invoice ${payload.invoiceReference} issued` };
}

export function paymentReceivedSummary(payload: PaymentReceivedPayload): SummaryResult {
  return { summary: `Payment ${payload.paymentReference} received` };
}

export function orderCompletedSummary(payload: OrderCompletedPayload): SummaryResult {
  return { summary: `Order ${payload.orderReference} completed` };
}

export function orderCancelledSummary(payload: OrderCancelledPayload): SummaryResult {
  return {
    summary: `Order ${payload.orderReference} cancelled (${payload.cancellationReason})`,
    detail: { cancellationReason: payload.cancellationReason, compensationSteps: payload.compensationSteps },
  };
}

// The 14th fact — R29's dead-letter clause / OR3 (feature 27). Purely
// diagnostic (order-status-rank.ts's own entry: status null, rank 0).
export function orderSagaFailedSummary(payload: OrderSagaFailedPayload): SummaryResult {
  return {
    summary: `Saga command "${payload.command}" dead-lettered after ${payload.attempts} attempt(s)`,
    detail: { command: payload.command, attempts: payload.attempts, lastError: payload.lastError },
  };
}
