// Writes the MongoDB `order_timeline` collection — one document per seeded
// order, shaped EXACTLY as specs/shared/openapi.yaml's `OrderDetail` schema
// (the projector's read model, domain-model.md §1 "Projector: sole writer
// of the read model"). `_id` is the order id, so re-running the seed is a
// plain idempotent `replaceOne(..., { upsert: true })` per document — no
// growth, no duplication.
import { MongoClient, type Collection, type Db } from 'mongodb';
import { loadMongoConfig, mongoConnectionUri, type MongoConfig } from '../mongo-config';
import { SAGAS, type OrderSagaFixture } from '../data/sagas.data';
import { retailerByCode } from '../data/retailers.data';
import { companyByCode } from '../data/companies.data';
import { productByCode } from '../data/products.data';

export const ORDER_TIMELINE_COLLECTION = 'order_timeline';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

export async function openMongo(config: MongoConfig = loadMongoConfig()): Promise<MongoHandle> {
  const client = new MongoClient(mongoConnectionUri(config));
  await client.connect();
  return { client, db: client.db(config.database) };
}

/** The read-model document shape — a structural mirror of OpenAPI `OrderDetail`. */
export interface OrderTimelineDocument {
  _id: string;
  orderId: string;
  orderReference: string;
  orderDate: string;
  retailer: { code: string; name: string; gln: string };
  company: { code: string; name: string; gln: string };
  status: string;
  cancellationReason: string | null;
  currency: string;
  totals: { initialAmount: number; initialDiscount: number; totalAmount: number };
  items: {
    productCode: string;
    name: string;
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
}

export function toTimelineDocument(saga: OrderSagaFixture): OrderTimelineDocument {
  const retailer = retailerByCode(saga.retailerCode);
  const company = companyByCode(saga.companyCode);

  return {
    _id: saga.orderId,
    orderId: saga.orderId,
    orderReference: saga.orderReference,
    orderDate: saga.orderDate.toISOString(),
    retailer: { code: retailer.code, name: retailer.name, gln: retailer.gln },
    company: { code: company.code, name: company.name, gln: company.gln },
    status: saga.status,
    cancellationReason: saga.cancellationReason,
    currency: saga.currency,
    totals: {
      initialAmount: saga.initialAmount,
      initialDiscount: saga.initialDiscount,
      totalAmount: saga.totalAmount,
    },
    items: saga.lines.map((line) => ({
      productCode: line.productCode,
      name: productByCode(line.productCode).name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineDiscount: line.lineDiscount,
    })),
    references: {
      despatchReference: saga.despatch?.despatchReference ?? null,
      invoiceReference: saga.invoice?.invoiceReference ?? null,
      paymentReference: saga.invoice?.payment.paymentReference ?? null,
    },
    // Ordered by occurredAt (R50) — the sagas.data.ts builders already
    // construct `timeline` in causal/occurredAt order; sorted again here
    // defensively so the read model never trusts construction order alone.
    events: [...saga.timeline]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((entry) => ({
        eventId: entry.eventId,
        eventType: entry.eventType,
        occurredAt: entry.occurredAt.toISOString(),
        summary: entry.summary,
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
    headerComplete: true,
    updatedAt: saga.updatedAt.toISOString(),
  };
}

export function orderTimelineCollection(db: Db): Collection<OrderTimelineDocument> {
  return db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);
}

export async function seedMongoTimelines(
  db: Db,
  sagas: readonly OrderSagaFixture[] = SAGAS,
): Promise<void> {
  const collection = orderTimelineCollection(db);
  await collection.createIndex({ orderReference: 1 }, { unique: true, name: 'uq_order_reference' });
  for (const saga of sagas) {
    const document = toTimelineDocument(saga);
    await collection.replaceOne({ _id: document._id }, document, { upsert: true });
  }
}

export async function countMongoTimelines(db: Db): Promise<number> {
  return orderTimelineCollection(db).countDocuments();
}
