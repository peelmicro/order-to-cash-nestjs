// Pure shaping of the projector's `order_timeline` MongoDB document
// (apps/projector/src/infrastructure/persistence/order-timeline.document.ts
// — this file defines its OWN structural mirror rather than importing that
// service's file, since "the only shared runtime code is
// packages/shared-kernel and packages/contracts" CLAUDE.md non-negotiable)
// into the two openapi.yaml wire shapes `OrderSummary` and `OrderDetail`.
// Pure — no NestJS, no `mongodb` — so the ESLint domain-purity guard leaves
// it alone and this file is fully unit-testable without a database.
//
// `import type` from `@otc/contracts` inside `domain/` is an established
// pattern in this repo (e.g. apps/orders/src/domain/order.ts's
// `CompensationStep`, apps/projector/src/domain/fact-projection.ts) — it is
// erased at compile time and `packages/contracts` itself has zero runtime
// dependencies, so the ESLint domain-purity rule (which targets `@nestjs/*`,
// `drizzle-orm`, `kafkajs`, `nats`, `mongodb`) does not apply to it.
import type { CancellationReason, OrderStatus } from '@otc/contracts';

// R54 — this is the ONLY place `GET /orders`/`GET /orders/{id}` field
// shapes are decided; the two internal-only fields the projector also
// stores on the document (`statusRank`, `processedEventKeys`) are simply
// absent from this interface, so they can never leak onto the wire no
// matter what the Mongo projection query does or does not exclude.
export interface OrderTimelineDocumentLike {
  readonly _id: string;
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly orderDate: string | null;
  readonly retailer: { readonly code: string | null; readonly name: string | null; readonly gln: string | null };
  readonly company: { readonly code: string | null; readonly name: string | null; readonly gln: string | null };
  readonly status: OrderStatus;
  readonly cancellationReason: CancellationReason | null;
  readonly currency: string | null;
  readonly totals: { readonly initialAmount: number | null; readonly initialDiscount: number | null; readonly totalAmount: number | null };
  readonly items: readonly {
    readonly productCode: string;
    readonly name?: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly lineDiscount: number;
  }[];
  readonly references: {
    readonly despatchReference: string | null;
    readonly invoiceReference: string | null;
    readonly paymentReference: string | null;
  };
  readonly events: readonly {
    readonly eventId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly summary: string;
    readonly detail?: Record<string, unknown>;
  }[];
  readonly headerComplete: boolean;
  readonly updatedAt: string;
}

export interface OrderSummaryLike {
  readonly orderId: string;
  readonly orderReference: string;
  readonly orderDate: string;
  readonly retailer: { readonly code: string; readonly name?: string; readonly gln: string };
  readonly company: { readonly code: string; readonly name?: string; readonly gln: string };
  readonly status: OrderStatus;
  readonly cancellationReason: CancellationReason | null;
  readonly currency: string;
  readonly totals: { readonly initialAmount: number; readonly initialDiscount: number; readonly totalAmount: number };
  readonly updatedAt: string;
}

export interface OrderDetailLike {
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly orderDate: string | null;
  readonly retailer: { readonly code: string; readonly name?: string; readonly gln: string } | null;
  readonly company: { readonly code: string; readonly name?: string; readonly gln: string } | null;
  readonly status: OrderStatus;
  readonly cancellationReason: CancellationReason | null;
  readonly currency: string | null;
  readonly totals: { readonly initialAmount: number; readonly initialDiscount: number; readonly totalAmount: number } | null;
  readonly items: readonly {
    readonly productCode: string;
    readonly name?: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly lineDiscount: number;
  }[];
  readonly references: {
    readonly despatchReference: string | null;
    readonly invoiceReference: string | null;
    readonly paymentReference: string | null;
  };
  readonly events: readonly {
    readonly eventId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly summary: string;
    readonly detail?: Record<string, unknown>;
  }[];
  readonly headerComplete: boolean;
  readonly updatedAt: string;
}

function partyRef(party: { code: string | null; name: string | null; gln: string | null }): { code: string; name?: string; gln: string } | null {
  if (!party.code || !party.gln) {
    return null;
  }
  return { code: party.code, ...(party.name ? { name: party.name } : {}), gln: party.gln };
}

/**
 * `GET /orders` row shape. Excludes documents whose header is still a
 * placeholder (R53) rather than emitting a row with a null `orderReference`
 * — the list endpoint's schema requires `orderReference` (openapi.yaml
 * `OrderSummary`), so a placeholder simply is not list-ready yet; its full
 * timeline is still reachable individually via `GET /orders/{id}`, which
 * DOES surface `headerComplete: false` explicitly.
 */
export function toOrderSummary(doc: OrderTimelineDocumentLike): OrderSummaryLike | null {
  const retailer = partyRef(doc.retailer);
  const company = partyRef(doc.company);
  if (!doc.orderReference || !doc.orderDate || !doc.currency || !retailer || !company || doc.totals.totalAmount === null) {
    return null;
  }
  return {
    orderId: doc.orderId,
    orderReference: doc.orderReference,
    orderDate: doc.orderDate,
    retailer,
    company,
    status: doc.status,
    cancellationReason: doc.cancellationReason,
    currency: doc.currency,
    totals: {
      initialAmount: doc.totals.initialAmount ?? 0,
      initialDiscount: doc.totals.initialDiscount ?? 0,
      totalAmount: doc.totals.totalAmount,
    },
    updatedAt: doc.updatedAt,
  };
}

/** `GET /orders/{id}` shape — always returned once a document exists at all, placeholder or not (`headerComplete` tells the caller which). */
export function toOrderDetail(doc: OrderTimelineDocumentLike): OrderDetailLike {
  return {
    orderId: doc.orderId,
    orderReference: doc.orderReference,
    orderDate: doc.orderDate,
    retailer: partyRef(doc.retailer),
    company: partyRef(doc.company),
    status: doc.status,
    cancellationReason: doc.cancellationReason,
    currency: doc.currency,
    totals:
      doc.totals.totalAmount === null
        ? null
        : { initialAmount: doc.totals.initialAmount ?? 0, initialDiscount: doc.totals.initialDiscount ?? 0, totalAmount: doc.totals.totalAmount },
    items: doc.items,
    references: doc.references,
    events: doc.events,
    headerComplete: doc.headerComplete,
    updatedAt: doc.updatedAt,
  };
}
