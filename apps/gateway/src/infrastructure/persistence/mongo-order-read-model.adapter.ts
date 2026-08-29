// `OrderReadModel` (application/ports/order-read-model.port.ts) over a
// DIRECT, READ-ONLY MongoDB query against the projector's OWN
// `order_timeline` collection (R54) — no RPC hop: the projector answers no
// query subject, by design (design.md §2 of `projector_read_model`), and
// the contract itself says list/detail are served "from the read model
// only". `{ projection: { statusRank: 0, processedEventKeys: 0 } }` is the
// exact exclusion `read-model-indexes.ts`'s own comment anticipates this
// feature performing — those two document-level fields are
// projector-internal and must never reach the wire.
//
// Amendment A1 (PR33, gate ruling: public) — the entry-level exclusion
// this file used to carry (`'events.statusRank': 0`, the R28 fix) is
// REMOVED, not merely renamed: `events[].statusRank` no longer exists on
// any entry the projector writes (PR30 retires it in favour of
// `causationId`), and `causationId` is deliberately NOT excluded here —
// it is a first-class envelope field (R11), not a projector-derived
// artefact, and reaches the wire unmapped exactly as `eventId` does
// (`order-read-model-mapper.ts`'s `events: doc.events` passthrough).
import type { Collection } from 'mongodb';
import type { OrderListFilter, OrderListResult, OrderReadModel } from '../../application/ports/order-read-model.port';
import type { OrderTimelineDocumentLike } from '../../domain/projection/order-read-model-mapper';

const EXCLUDE_INTERNAL_FIELDS = { statusRank: 0, processedEventKeys: 0 } as const;

export class MongoOrderReadModelAdapter implements OrderReadModel {
  constructor(private readonly collection: Collection<OrderTimelineDocumentLike>) {}

  async findById(orderId: string): Promise<OrderTimelineDocumentLike | null> {
    return this.collection.findOne({ _id: orderId } as never, { projection: EXCLUDE_INTERNAL_FIELDS });
  }

  async findByOrderReference(orderReference: string): Promise<OrderTimelineDocumentLike | null> {
    return this.collection.findOne({ orderReference } as never, { projection: EXCLUDE_INTERNAL_FIELDS });
  }

  async list(filter: OrderListFilter): Promise<OrderListResult> {
    const query: Record<string, unknown> = {};
    if (filter.status && filter.status.length > 0) {
      query.status = { $in: filter.status };
    }
    if (filter.retailerCode) {
      query['retailer.code'] = filter.retailerCode;
    }
    if (filter.companyCode) {
      query['company.code'] = filter.companyCode;
    }
    if (filter.orderReference) {
      query.orderReference = filter.orderReference;
    }

    const skip = (filter.page - 1) * filter.pageSize;
    const [items, total] = await Promise.all([
      this.collection
        .find(query as never, { projection: EXCLUDE_INTERNAL_FIELDS })
        // openapi.yaml `listOrders`: "Ordering is by orderDate descending."
        .sort({ orderDate: -1 })
        .skip(skip)
        .limit(filter.pageSize)
        .toArray(),
      this.collection.countDocuments(query as never),
    ]);

    return { items, total };
  }
}
