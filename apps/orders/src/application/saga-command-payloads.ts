// Builds the full typed RPC request payload for a saga command "owed" by a
// step-table row, from the LOADED aggregate at enqueue time (design.md
// §6.3: "lines are immutable from confirmed, totals are aggregate-consistent,
// so snapshotting is safe and the sweeper never needs to re-derive it").
// Pure — no I/O, no port. `SagaFactHandler` calls this right before handing
// the result to `SagaCommandStore.enqueue` (design.md §5.1 step 3).
import type {
  CreditHoldRequestPayload,
  CreditReleasedPayload,
  CreditReleaseRequestPayload,
  DespatchCreateRequestPayload,
  Envelope,
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
  | InvoiceIssueRequestPayload
  | CreditReleaseRequestPayload;

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
 * `stock.release` is now owed by TWO different step-table rows (design.md
 * §4.3 Path B, and feature 41's follow-up pass): `credit.rejected.v1`
 * (reason always `credit_rejected`) and `credit.released.v1`'s
 * `credit_approved`/`confirmed` variant (reason always `order_cancelled` —
 * asserted here, not assumed: see `saga-steps.ts`'s `credit.released.v1`
 * module comment for why no other reason can reach that variant). Any
 * OTHER triggering fact type would be a step-table/payload-builder mismatch
 * — a programming error, not a runtime condition to swallow.
 */
function stockReleaseReasonFor(fact: Envelope): StockReleaseRequestPayload['reason'] {
  switch (fact.eventType) {
    case 'credit.rejected.v1':
      return 'credit_rejected';
    case 'credit.released.v1': {
      const reason = (fact.payload as CreditReleasedPayload).reason;
      if (reason !== 'order_cancelled') {
        throw new Error(
          `saga-command-payloads: stock.release owed by credit.released.v1 with unexpected reason "${reason}" — expected order_cancelled (the paid variant owes no commandAfter and should never reach here)`,
        );
      }
      return 'order_cancelled';
    }
    default:
      throw new Error(`saga-command-payloads: stock.release owed by unexpected fact type "${fact.eventType}"`);
  }
}

/**
 * `kind` must be the `commandAfter` the step table just enqueued for
 * `order` — the switch is total over `SagaCommandKind`, so a new kind added
 * to the closed set without a case here fails to compile (`never` below).
 * `fact` — the triggering envelope `SagaFactHandler` already holds — is
 * required for `stock.release` (its `reason` depends on which fact owed
 * it) and unused by every other kind; kept optional on the signature so
 * every existing single-argument test call site for `credit.hold`/
 * `invoice.issue`/etc. stays unchanged.
 */
export function buildSagaCommandPayload(kind: SagaCommandKind, order: Order, fact?: Envelope): SagaCommandPayload {
  switch (kind) {
    case 'stock.reserve':
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
        lines: nonEmptyReserveLines(order),
      } satisfies StockReserveRequestPayload;
    case 'stock.release': {
      if (!fact) {
        throw new Error('saga-command-payloads: stock.release requires the triggering fact envelope to determine its reason');
      }
      return {
        orderReference: order.orderReference.value,
        reason: stockReleaseReasonFor(fact),
      } satisfies StockReleaseRequestPayload;
    }
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
      // BI21 (billing_invoicing design.md §12, open-point row 5 — approved
      // at the gate): the credit hold above is on `order.totalAmount` (the
      // NET total, `initialAmount - initialDiscount`), so `invoice.issue`
      // must carry the same discount or Billing derives `totalAmount` from
      // the GROSS `amount` alone and the invoice total silently diverges
      // from the order total and the consumed hold. `apps/seed`'s own
      // seeded invoices already write `discount: initialDiscount` — this
      // restores that shape on the live path.
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
        currency: order.currency,
        lines: nonEmptyInvoiceLines(order),
        discount: order.initialDiscount.amount,
      } satisfies InvoiceIssueRequestPayload;
    case 'credit.release':
      // No step-table row ever names `credit.release` as its
      // `commandAfter` — `CancelOrderHandler` enqueues it directly (same
      // "outside the fact-driven table" shape `stock.release`'s
      // operator-cancel variant uses in `beginStockReleaseCompensation`),
      // so this case is never reached via `SagaFactHandler`'s call site
      // today. Implemented anyway for the switch's own exhaustiveness
      // (`never` below) and so any FUTURE fact-driven caller gets the
      // correct shape for free, matching `credit.hold`'s own two fields.
      return {
        orderReference: order.orderReference.value,
        retailerCode: order.retailerCode,
        companyCode: order.companyCode,
      } satisfies CreditReleaseRequestPayload;
    default: {
      const exhaustive: never = kind;
      throw new Error(`saga-command-payloads: unmapped saga command kind "${String(exhaustive)}"`);
    }
  }
}
