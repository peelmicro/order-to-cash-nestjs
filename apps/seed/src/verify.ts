// Self-verification (task prompt: "the seed ... verifies itself: assert
// expected row counts per table and per collection, assert one completed
// order's cross-store consistency, exit non-zero on any mismatch"). Every
// expected count is DERIVED from the fixture data modules themselves —
// never hand-counted and re-typed here — so this file can never drift from
// sagas.data.ts/stock.data.ts/credits.data.ts the way a hardcoded number
// could.
import { eq, isNull } from 'drizzle-orm';
import * as ordersSchema from '../../orders/src/infrastructure/persistence/schema';
import * as fulfillmentSchema from '../../fulfillment/src/infrastructure/persistence/schema';
import * as billingSchema from '../../billing/src/infrastructure/persistence/schema';
import type { OrdersDb } from '../../orders/src/infrastructure/persistence/client';
import type { FulfillmentDb } from '../../fulfillment/src/infrastructure/persistence/client';
import type { BillingDb } from '../../billing/src/infrastructure/persistence/client';
import type { Db } from 'mongodb';
import { CURRENCIES } from './data/currencies.data';
import { PRODUCTS } from './data/products.data';
import { RETAILERS } from './data/retailers.data';
import { COMPANIES } from './data/companies.data';
import { CREDITS } from './data/credits.data';
import { STOCK } from './data/stock.data';
import { SAGAS, COMPLETED_SAGAS, CANCELLED_SAGAS } from './data/sagas.data';
import { countOrdersRows } from './writers/orders-db.writer';
import { countFulfillmentRows } from './writers/fulfillment-db.writer';
import { countBillingRows } from './writers/billing-db.writer';
import {
  countMongoTimelines,
  orderTimelineCollection,
  type OrderTimelineDocument,
} from './writers/mongo.writer';

export class SeedVerificationError extends Error {}

function assertEqual(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new SeedVerificationError(`${label}: expected ${expected}, got ${actual}`);
  }
}

export interface VerificationSummary {
  orders: Awaited<ReturnType<typeof countOrdersRows>>;
  fulfillment: Awaited<ReturnType<typeof countFulfillmentRows>>;
  billing: Awaited<ReturnType<typeof countBillingRows>>;
  mongoOrderTimelines: number;
}

export async function verifySeed(handles: {
  ordersDb: OrdersDb;
  fulfillmentDb: FulfillmentDb;
  billingDb: BillingDb;
  mongoDb: Db;
}): Promise<VerificationSummary> {
  const { ordersDb, fulfillmentDb, billingDb, mongoDb } = handles;

  // ── 1. row counts, per table and per collection ──────────────────────────
  const orderItemsExpected = SAGAS.reduce((sum, saga) => sum + saga.lines.length, 0);
  const ordersOutboxExpected = SAGAS.reduce((sum, saga) => sum + saga.ordersOutbox.length, 0);
  const reservationsExpected = SAGAS.reduce((sum, saga) => sum + saga.reservations.length, 0);
  const despatchItemsExpected = COMPLETED_SAGAS.reduce(
    (sum, saga) => sum + (saga.despatch?.items.length ?? 0),
    0,
  );
  const fulfillmentOutboxExpected = SAGAS.reduce(
    (sum, saga) => sum + saga.fulfillmentOutbox.length,
    0,
  );
  const creditItemsExpected = SAGAS.reduce((sum, saga) => sum + saga.creditLedgerEntries.length, 0);
  const invoiceItemsExpected = COMPLETED_SAGAS.reduce(
    (sum, saga) => sum + (saga.invoice?.items.length ?? 0),
    0,
  );
  const billingOutboxExpected = SAGAS.reduce((sum, saga) => sum + saga.billingOutbox.length, 0);

  const orders = await countOrdersRows(ordersDb);
  assertEqual('orders.currencies', orders.currencies, CURRENCIES.length);
  assertEqual('orders.products', orders.products, PRODUCTS.length);
  assertEqual('orders.retailers', orders.retailers, RETAILERS.length);
  assertEqual('orders.companies', orders.companies, COMPANIES.length);
  assertEqual('orders.orders', orders.orders, SAGAS.length);
  assertEqual('orders.orderItems', orders.orderItems, orderItemsExpected);
  assertEqual('orders.outbox', orders.outbox, ordersOutboxExpected);

  const fulfillment = await countFulfillmentRows(fulfillmentDb);
  assertEqual('fulfillment.stock', fulfillment.stock, STOCK.length);
  assertEqual('fulfillment.reservations', fulfillment.reservations, reservationsExpected);
  assertEqual('fulfillment.despatches', fulfillment.despatches, COMPLETED_SAGAS.length);
  assertEqual('fulfillment.despatchItems', fulfillment.despatchItems, despatchItemsExpected);
  assertEqual('fulfillment.outbox', fulfillment.outbox, fulfillmentOutboxExpected);

  const billing = await countBillingRows(billingDb);
  assertEqual('billing.credits', billing.credits, CREDITS.length);
  assertEqual('billing.creditItems', billing.creditItems, creditItemsExpected);
  assertEqual('billing.invoices', billing.invoices, COMPLETED_SAGAS.length);
  assertEqual('billing.invoiceItems', billing.invoiceItems, invoiceItemsExpected);
  assertEqual('billing.payments', billing.payments, COMPLETED_SAGAS.length);
  assertEqual('billing.outbox', billing.outbox, billingOutboxExpected);

  const mongoOrderTimelines = await countMongoTimelines(mongoDb);
  assertEqual('mongo.order_timeline', mongoOrderTimelines, SAGAS.length);

  // ── 2. every seeded outbox row is already published ──────────────────────
  const unpublishedOrders = await ordersDb
    .select()
    .from(ordersSchema.outbox)
    .where(isNull(ordersSchema.outbox.publishedAt));
  assertEqual('orders.outbox unpublished rows', unpublishedOrders.length, 0);

  const unpublishedFulfillment = await fulfillmentDb
    .select()
    .from(fulfillmentSchema.outbox)
    .where(isNull(fulfillmentSchema.outbox.publishedAt));
  assertEqual('fulfillment.outbox unpublished rows', unpublishedFulfillment.length, 0);

  const unpublishedBilling = await billingDb
    .select()
    .from(billingSchema.outbox)
    .where(isNull(billingSchema.outbox.publishedAt));
  assertEqual('billing.outbox unpublished rows', unpublishedBilling.length, 0);

  // ── 3. one completed order's cross-store consistency ─────────────────────
  const [sample] = COMPLETED_SAGAS;
  if (!sample) {
    throw new SeedVerificationError('no completed saga to sample for cross-store verification');
  }

  const [orderRow] = await ordersDb
    .select()
    .from(ordersSchema.orders)
    .where(eq(ordersSchema.orders.id, sample.orderId));
  if (!orderRow) {
    throw new SeedVerificationError(`orders.orders: row for ${sample.orderReference} not found`);
  }
  assertEqual(
    `${sample.orderReference}: orders.totalAmount`,
    orderRow.totalAmount,
    sample.totalAmount,
  );

  const orderItemRows = await ordersDb
    .select()
    .from(ordersSchema.orderItems)
    .where(eq(ordersSchema.orderItems.orderId, sample.orderId));
  const orderItemsSum = orderItemRows.reduce(
    (sum, row) => sum + row.price * row.quantity - row.discount,
    0,
  );
  assertEqual(
    `${sample.orderReference}: order_items sum vs order total`,
    orderItemsSum,
    sample.totalAmount,
  );

  const [despatchRow] = await fulfillmentDb
    .select()
    .from(fulfillmentSchema.despatches)
    .where(eq(fulfillmentSchema.despatches.orderReference, sample.orderReference));
  if (!despatchRow || despatchRow.despatchReference !== sample.despatch?.despatchReference) {
    throw new SeedVerificationError(
      `${sample.orderReference}: despatch reference mismatch (fulfillment DB vs fixture)`,
    );
  }

  const [invoiceRow] = await billingDb
    .select()
    .from(billingSchema.invoices)
    .where(eq(billingSchema.invoices.orderReference, sample.orderReference));
  if (!invoiceRow || invoiceRow.invoiceReference !== sample.invoice?.invoiceReference) {
    throw new SeedVerificationError(
      `${sample.orderReference}: invoice reference mismatch (billing DB vs fixture)`,
    );
  }
  assertEqual(
    `${sample.orderReference}: invoice.totalAmount`,
    invoiceRow.totalAmount,
    sample.totalAmount,
  );

  const [paymentRow] = await billingDb
    .select()
    .from(billingSchema.payments)
    .where(eq(billingSchema.payments.invoiceId, invoiceRow.id));
  if (!paymentRow || paymentRow.paymentReference !== sample.invoice?.payment.paymentReference) {
    throw new SeedVerificationError(
      `${sample.orderReference}: payment reference mismatch (billing DB vs fixture)`,
    );
  }
  assertEqual(`${sample.orderReference}: payment.amount`, paymentRow.amount, sample.totalAmount);

  const mongoDoc = await orderTimelineCollection(mongoDb).findOne({ _id: sample.orderId });
  if (!mongoDoc) {
    throw new SeedVerificationError(
      `mongo.order_timeline: no document for ${sample.orderReference}`,
    );
  }
  assertEqual(
    `${sample.orderReference}: mongo totals.totalAmount`,
    mongoDoc.totals.totalAmount,
    sample.totalAmount,
  );
  if (mongoDoc.references.despatchReference !== sample.despatch?.despatchReference) {
    throw new SeedVerificationError(`${sample.orderReference}: mongo despatchReference mismatch`);
  }
  if (mongoDoc.references.invoiceReference !== sample.invoice?.invoiceReference) {
    throw new SeedVerificationError(`${sample.orderReference}: mongo invoiceReference mismatch`);
  }
  if (mongoDoc.status !== 'completed') {
    throw new SeedVerificationError(
      `${sample.orderReference}: mongo status expected "completed", got "${mongoDoc.status}"`,
    );
  }

  // ── 4. the cancelled order's timeline shows the compensation sequence ────
  const [cancelled] = CANCELLED_SAGAS;
  if (!cancelled) {
    throw new SeedVerificationError('no cancelled saga seeded');
  }
  const cancelledDoc = await orderTimelineCollection(mongoDb).findOne({ _id: cancelled.orderId });
  if (!cancelledDoc) {
    throw new SeedVerificationError(
      `mongo.order_timeline: no document for ${cancelled.orderReference}`,
    );
  }
  assertCompensationSequence(cancelledDoc);

  return { orders, fulfillment, billing, mongoOrderTimelines };
}

function assertCompensationSequence(doc: OrderTimelineDocument): void {
  const eventTypes = doc.events.map((event) => event.eventType);
  const expected = [
    'order.placed.v1',
    'stock.reserved.v1',
    'credit.rejected.v1',
    'stock.released.v1',
    'order.cancelled.v1',
  ];
  if (JSON.stringify(eventTypes) !== JSON.stringify(expected)) {
    throw new SeedVerificationError(
      `${doc.orderReference}: compensation sequence mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(eventTypes)}`,
    );
  }
  if (doc.status !== 'cancelled' || doc.cancellationReason !== 'credit_rejected') {
    throw new SeedVerificationError(
      `${doc.orderReference}: expected status "cancelled" / cancellationReason "credit_rejected", got "${doc.status}" / "${doc.cancellationReason}"`,
    );
  }
}
