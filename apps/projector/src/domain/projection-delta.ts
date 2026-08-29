// The store-agnostic value `fact-projection.ts` builds — the projector's
// entire "domain" (design.md §4): it owns no aggregate and enforces no
// invariant, so its domain is the pure, total function from an envelope to
// a description of the change. ZERO framework/driver imports (PR28) —
// infrastructure alone (delta-to-pipeline.ts) translates this into
// MongoDB aggregation-pipeline stages.
//
// Deliberately self-contained: this file does NOT import
// `OrderTimelineDocument` from infrastructure/persistence — the domain
// layer must never reach outward into infrastructure/ (ESLint
// `no-restricted-imports`, CLAUDE.md § Non-negotiables) — so every shape
// below is declared fresh, even where it structurally mirrors the
// document's own fields.
import type { OrderStatus } from './order-status-rank';

export interface TimelineEntryDelta {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string; // ISO-8601, straight from the envelope (PR14)
  readonly summary: string;
  // Amendment A1 (PR30) — the triggering envelope's OWN causationId,
  // stored verbatim. This REPLACES the rejected first attempt's
  // `statusRank` entry field (progress/spec_projector_timeline_ordering.md
  // §6.2: a status ranking is not a causal ordering, and diverges from one
  // the moment a status-bearing fact causes a status-less one — the exact
  // shape of the R24 completion triple). `causationId` is the recorded
  // causal edge `delta-to-pipeline.ts`'s pipeline uses to compute each tie
  // group's depth; PR10 forbids inferring an edge from `eventType`, from
  // an implied status, or from any other derived property.
  readonly causationId: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Written only while the corresponding field is `null` (PR11). */
export interface OrderReferencesDelta {
  readonly despatchReference?: string;
  readonly invoiceReference?: string;
  readonly paymentReference?: string;
}

export interface OrderHeaderItemDelta {
  readonly productCode: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineDiscount: number;
}

/** Present ONLY for `order.placed.v1` (PR9). Written unconditionally — the dedup filter is what stops a second write (design.md §5.3). */
export interface OrderHeaderDelta {
  readonly orderReference: string;
  readonly orderDate: string;
  readonly retailer: { readonly code: string; readonly gln: string };
  readonly company: { readonly code: string; readonly gln: string };
  readonly currency: string;
  readonly totals: { readonly initialAmount: number; readonly initialDiscount: number; readonly totalAmount: number };
  readonly items: readonly OrderHeaderItemDelta[];
}

export interface ProjectionDelta {
  readonly orderId: string; // = correlationId (PR15 — no identifier generated here)
  readonly entry: TimelineEntryDelta;
  readonly impliedStatus: OrderStatus | null;
  readonly statusRank: number; // 0 when impliedStatus is null
  readonly fillIfAbsent: {
    readonly cancellationReason?: string;
    readonly references?: OrderReferencesDelta;
  };
  readonly header?: OrderHeaderDelta;
}
