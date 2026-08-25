// The read-model document shape (design.md §3) — a structural mirror of
// `apps/seed/src/writers/mongo.writer.ts`'s `OrderTimelineDocument`
// (adopted, not competed with: apps/seed's shape already satisfies
// `specs/shared/openapi.yaml` `OrderDetail`) plus TWO projector-owned
// fields, `statusRank` and `processedEventKeys`. The client-visible half of
// this document is `openapi.yaml` `OrderDetail`; `statusRank` and
// `processedEventKeys` are projected out by feature 25's Mongo read
// (`{ projection: { statusRank: 0, processedEventKeys: 0 } }`) and are
// otherwise invisible on the wire.
//
// This file, `mongo-client.ts` and `mongo-read-model-writer.ts` are the
// ONLY files in this service that import `mongodb` for its VALUE — this one
// only for its TYPES (`Collection<T>`), which the ESLint domain-purity rule
// does not restrict outside `domain/` anyway; recorded here because
// design.md §2 names exactly these three files as the value-importers.
export interface OrderTimelineDocument {
  _id: string;
  orderId: string;
  orderReference: string | null;
  orderDate: string | null;
  retailer: { code: string | null; name: string | null; gln: string | null };
  company: { code: string | null; name: string | null; gln: string | null };
  status: string;
  cancellationReason: string | null;
  currency: string | null;
  totals: { initialAmount: number | null; initialDiscount: number | null; totalAmount: number | null };
  items: {
    productCode: string;
    name?: string;
    quantity: number;
    unitPrice: number;
    lineDiscount: number;
  }[];
  references: {
    despatchReference: string | null;
    invoiceReference: string | null;
    paymentReference: string | null;
  };
  events: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    summary: string;
    detail?: Record<string, unknown>;
  }[];
  headerComplete: boolean;
  updatedAt: string;
  statusRank: number;
  processedEventKeys: string[];
}
