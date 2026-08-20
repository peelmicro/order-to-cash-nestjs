// Writes the Orders DB (`otc_orders`): the reference catalogue (currencies,
// products, retailers, companies) plus, per seeded saga, the `orders` row,
// its `order_items` and its already-published `outbox` rows. Reuses the
// real `@otc/orders` Drizzle client/schema/migrator — never a second,
// hand-rolled connection shape (task prompt: "reuse each app's migrator —
// import it, don't shell out").
import { sql } from 'drizzle-orm';
import type mysql from 'mysql2/promise';
import {
  createOrdersDb,
  createOrdersPool,
  type OrdersDb,
} from '../../../orders/src/infrastructure/persistence/client';
import {
  loadOrdersDbConfig,
  type OrdersDbConfig,
} from '../../../orders/src/infrastructure/persistence/db-config';
import { runOrdersMigrations } from '../../../orders/src/infrastructure/persistence/migrator';
import * as schema from '../../../orders/src/infrastructure/persistence/schema';
import type { OrderStatusRow } from '../../../orders/src/infrastructure/persistence/schema';
import { CURRENCIES, currencyIdByCode } from '../data/currencies.data';
import { PRODUCTS, productByCode } from '../data/products.data';
import { RETAILERS, retailerByCode } from '../data/retailers.data';
import { COMPANIES, companyByCode } from '../data/companies.data';
import { MASTER_DATA_TIMESTAMP } from '../data/constants';
import { SAGAS, type OrderSagaFixture } from '../data/sagas.data';
import { deterministicId } from '../deterministic';

export interface OrdersDbHandle {
  pool: mysql.Pool;
  db: OrdersDb;
}

export async function openOrdersDb(
  config: OrdersDbConfig = loadOrdersDbConfig(),
): Promise<OrdersDbHandle> {
  const pool = createOrdersPool(config);
  return { pool, db: createOrdersDb(pool) };
}

export async function migrateOrders(config: OrdersDbConfig = loadOrdersDbConfig()): Promise<void> {
  await runOrdersMigrations(config);
}

export async function seedOrdersMasterData(db: OrdersDb): Promise<void> {
  const ts = MASTER_DATA_TIMESTAMP;

  await db
    .insert(schema.currencies)
    .values(
      CURRENCIES.map((currency) => ({
        id: currency.id,
        code: currency.code,
        isoNumber: currency.isoNumber,
        symbol: currency.symbol,
        decimalPoints: currency.decimalPoints,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.currencies.updatedAt})` } });

  await db
    .insert(schema.products)
    .values(
      PRODUCTS.map((product) => ({
        id: product.id,
        code: product.code,
        ean: product.ean,
        name: product.name,
        description: product.description,
        price: product.price,
        currencyId: currencyIdByCode(product.currencyCode),
        disabledAt: null,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.products.updatedAt})` } });

  await db
    .insert(schema.retailers)
    .values(
      RETAILERS.map((retailer) => ({
        id: retailer.id,
        code: retailer.code,
        name: retailer.name,
        country: retailer.country,
        vat: retailer.vat,
        gln: retailer.gln,
        currencyId: currencyIdByCode(retailer.currencyCode),
        disabledAt: null,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.retailers.updatedAt})` } });

  await db
    .insert(schema.companies)
    .values(
      COMPANIES.map((company) => ({
        id: company.id,
        code: company.code,
        name: company.name,
        country: company.country,
        vat: company.vat,
        gln: company.gln,
        currencyId: currencyIdByCode(company.currencyCode),
        disabledAt: null,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.companies.updatedAt})` } });
}

export async function seedOrdersSagas(
  db: OrdersDb,
  sagas: readonly OrderSagaFixture[] = SAGAS,
): Promise<void> {
  for (const saga of sagas) {
    await db
      .insert(schema.orders)
      .values({
        id: saga.orderId,
        orderReference: saga.orderReference,
        orderDate: saga.orderDate,
        companyId: companyByCode(saga.companyCode).id,
        retailerId: retailerByCode(saga.retailerCode).id,
        currencyId: currencyIdByCode(saga.currency),
        initialAmount: saga.initialAmount,
        initialDiscount: saga.initialDiscount,
        totalAmount: saga.totalAmount,
        status: saga.status as OrderStatusRow,
        cancellationReason: saga.cancellationReason,
        notes:
          saga.status === 'cancelled'
            ? 'demo — compensation path (credit_rejected, .99 rule)'
            : null,
        createdAt: saga.orderDate,
        updatedAt: saga.updatedAt,
      })
      .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.orders.updatedAt})` } });

    await db
      .insert(schema.orderItems)
      .values(
        saga.lines.map((line) => ({
          id: deterministicId(`order:${saga.sequence}:item:${line.productCode}`),
          orderId: saga.orderId,
          productId: productByCode(line.productCode).id,
          description: line.description,
          price: line.unitPrice,
          quantity: line.quantity,
          discount: line.lineDiscount,
          createdAt: saga.orderDate,
          updatedAt: saga.orderDate,
        })),
      )
      .onDuplicateKeyUpdate({
        // `description` is included so a warm database (from before the
        // `order_items.description` migration, design.md §9.1) backfills on
        // the next seed run rather than staying stuck on whatever a
        // `NOT NULL` column with no default coerced it to.
        set: {
          description: sql`VALUES(${schema.orderItems.description})`,
          updatedAt: sql`VALUES(${schema.orderItems.updatedAt})`,
        },
      });

    if (saga.ordersOutbox.length > 0) {
      await db
        .insert(schema.outbox)
        .values(
          saga.ordersOutbox.map((row) => ({
            id: row.id,
            eventId: row.eventId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            correlationId: row.correlationId,
            payload: row.payload,
            occurredAt: row.occurredAt,
            publishedAt: row.publishedAt,
            createdAt: row.occurredAt,
          })),
        )
        .onDuplicateKeyUpdate({ set: { publishedAt: sql`VALUES(${schema.outbox.publishedAt})` } });
    }
  }
}

export async function countOrdersRows(db: OrdersDb): Promise<{
  currencies: number;
  products: number;
  retailers: number;
  companies: number;
  orders: number;
  orderItems: number;
  outbox: number;
}> {
  const [currencies, products, retailers, companies, orders, orderItems, outbox] =
    await Promise.all([
      db.select().from(schema.currencies),
      db.select().from(schema.products),
      db.select().from(schema.retailers),
      db.select().from(schema.companies),
      db.select().from(schema.orders),
      db.select().from(schema.orderItems),
      db.select().from(schema.outbox),
    ]);
  return {
    currencies: currencies.length,
    products: products.length,
    retailers: retailers.length,
    companies: companies.length,
    orders: orders.length,
    orderItems: orderItems.length,
    outbox: outbox.length,
  };
}
