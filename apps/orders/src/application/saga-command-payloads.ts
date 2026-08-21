// Builds the full typed RPC request payload for a saga command "owed" by a
// step-table row, from the LOADED aggregate at enqueue time (design.md
// §6.3: "lines are immutable from confirmed, totals are aggregate-consistent,
// so snapshotting is safe and the sweeper never needs to re-derive it").
// Pure — no I/O, no port. `SagaFactHandler` calls this right before handing
// the result to `SagaCommandStore.enqueue` (design.md §5.1 step 3).
import type {
  CreditHoldRequestPayload,
  DespatchCreateRequestPayload,
  InvoiceIssueRequestPayload,
  InvoiceLine,
  StockReleaseRequestPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';
import type { Order } from '../domain/order.js';
import type { SagaCommandKind } from './saga-steps.js';

export type SagaCommandPayload =
  | StockReserveRequestPayload
  | StockReleaseRequestPayload
  | DespatchCreateRequestPayload
  | CreditHoldRequestPayload
  | InvoiceIssueRequestPayload;

function nonEmptyReserveLines(order: Order): StockReserveRequestPayload['lines'] {
  const lines = order.lines.map((line) => ({ productCode: line.productCode, units: line.quantity.value }));
  if (lines.length === 0) {
    // O1/R5 already guarantee this never happens — narrowing assertion only, same style as order-events.ts's toNonEmptyLinesPayload.
    throw new Error('saga-command-payloads: order has no lines — cannot build a stock.reserve request');
  }
  return lines as StockReserveRequestPayload['lines'];
}

function nonEmptyInvoiceLines(order: Order): [InvoiceLine, ...InvoiceLine[]] {
  const lines: InvoiceLine[] = order.lines.map((line) => ({
    productCode: line.productCode,
    units: line.quantity.value,
    unitPrice: line.unitPrice.amount,
  }));
  if (lines.length === 0) {
    throw new Error('saga-command-payloads: order has no lines — cannot build an invoice.issue request');
  }
  return lines as [InvoiceLine, ...InvoiceLine[]];
}

/**
 * `kind` must be the `commandAfter` the step table just enqueued for
 * `order` — the switch is total over `SagaCommandKind`, so a new kind added
 * to the closed set without a case here fails to compile (`never` below).
 */
export function buildSagaCommandPayload(kind: SagaCommandKind, order: Order): SagaCommandPayload {
  switch (kind) {
    case 'stock.reserve':
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
        lines: nonEmptyReserveLines(order),
      } satisfies StockReserveRequestPayload;
    case 'stock.release':
      // The only step-table row that owes `stock.release` is
      // `credit.rejected.v1` (design.md §4.3 Path B) — the operator-initiated
      // release (`order_cancelled`) is feature 25's, not built here.
      return {
        orderReference: order.orderReference.value,
        reason: 'credit_rejected',
      } satisfies StockReleaseRequestPayload;
    case 'despatch.create':
      return { orderReference: order.orderReference.value } satisfies DespatchCreateRequestPayload;
    case 'credit.hold':
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
        amount: { amount: order.totalAmount.amount, currency: order.totalAmount.currency },
      } satisfies CreditHoldRequestPayload;
    case 'invoice.issue':
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
        currency: order.currency,
        lines: nonEmptyInvoiceLines(order),
      } satisfies InvoiceIssueRequestPayload;
    default: {
      const exhaustive: never = kind;
      throw new Error(`saga-command-payloads: unmapped saga command kind "${String(exhaustive)}"`);
    }
  }
}
