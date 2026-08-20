// Writes the Fulfillment DB (`otc_fulfillment`): initial stock plus, per
// seeded saga, the `reservations` (status `consumed` for completed orders,
// `released` for the cancelled one), the `despatches`/`despatch_items` for
// completed orders, and the already-published `outbox` rows. Reuses the
// real `@otc/fulfillment` Drizzle client/schema/migrator.
import { sql } from 'drizzle-orm';
import type mysql from 'mysql2/promise';
import {
  createFulfillmentDb,
  createFulfillmentPool,
  type FulfillmentDb,
} from '../../../fulfillment/src/infrastructure/persistence/client';
import {
  loadFulfillmentDbConfig,
  type FulfillmentDbConfig,
} from '../../../fulfillment/src/infrastructure/persistence/db-config';
import { runFulfillmentMigrations } from '../../../fulfillment/src/infrastructure/persistence/migrator';
import * as schema from '../../../fulfillment/src/infrastructure/persistence/schema';
import type { ReservationStatusRow } from '../../../fulfillment/src/infrastructure/persistence/schema';
import { STOCK } from '../data/stock.data';
import { SAGAS, stockRowId, type OrderSagaFixture } from '../data/sagas.data';
import { MASTER_DATA_TIMESTAMP } from '../data/constants';
import { deterministicId } from '../deterministic';

export interface FulfillmentDbHandle {
  pool: mysql.Pool;
  db: FulfillmentDb;
}

export async function openFulfillmentDb(
  config: FulfillmentDbConfig = loadFulfillmentDbConfig(),
): Promise<FulfillmentDbHandle> {
  const pool = createFulfillmentPool(config);
  return { pool, db: createFulfillmentDb(pool) };
}

export async function migrateFulfillment(
  config: FulfillmentDbConfig = loadFulfillmentDbConfig(),
): Promise<void> {
  await runFulfillmentMigrations(config);
}

export async function seedFulfillmentStock(db: FulfillmentDb): Promise<void> {
  const ts = MASTER_DATA_TIMESTAMP;
  await db
    .insert(schema.stock)
    .values(
      STOCK.map((item) => ({
        id: item.id,
        companyCode: item.companyCode,
        productCode: item.productCode,
        units: item.units,
        reservedUnits: item.reservedUnits,
        lowStockThreshold: item.lowStockThreshold,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.stock.updatedAt})` } });
}

export async function seedFulfillmentSagas(
  db: FulfillmentDb,
  sagas: readonly OrderSagaFixture[] = SAGAS,
): Promise<void> {
  for (const saga of sagas) {
    await db
      .insert(schema.reservations)
      .values(
        saga.reservations.map((reservation) => ({
          id: reservation.id,
          stockId: stockRowId(reservation.companyCode, reservation.productCode),
          companyCode: reservation.companyCode,
          retailerCode: reservation.retailerCode,
          productCode: reservation.productCode,
          orderReference: saga.orderReference,
          units: reservation.units,
          status: reservation.status as ReservationStatusRow,
          createdAt: reservation.createdAt,
          updatedAt: reservation.updatedAt,
        })),
      )
      .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.reservations.updatedAt})` } });

    if (saga.despatch) {
      const despatch = saga.despatch;
      await db
        .insert(schema.despatches)
        .values({
          id: despatch.id,
          despatchReference: despatch.despatchReference,
          despatchDate: despatch.despatchDate,
          companyCode: despatch.companyCode,
          retailerCode: despatch.retailerCode,
          orderReference: saga.orderReference,
          createdAt: despatch.despatchDate,
          updatedAt: despatch.despatchDate,
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.despatches.updatedAt})` } });

      await db
        .insert(schema.despatchItems)
        .values(
          despatch.items.map((item) => ({
            id: deterministicId(`order:${saga.sequence}:despatch-item:${item.productCode}`),
            despatchId: despatch.id,
            productCode: item.productCode,
            units: item.units,
            createdAt: despatch.despatchDate,
            updatedAt: despatch.despatchDate,
          })),
        )
        .onDuplicateKeyUpdate({
          set: { updatedAt: sql`VALUES(${schema.despatchItems.updatedAt})` },
        });
    }

    if (saga.fulfillmentOutbox.length > 0) {
      await db
        .insert(schema.outbox)
        .values(
          saga.fulfillmentOutbox.map((row) => ({
            id: row.id,
            eventId: row.eventId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            correlationId: row.correlationId,
            causationId: row.causationId,
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

export async function countFulfillmentRows(db: FulfillmentDb): Promise<{
  stock: number;
  reservations: number;
  despatches: number;
  despatchItems: number;
  outbox: number;
}> {
  const [stock, reservations, despatches, despatchItems, outbox] = await Promise.all([
    db.select().from(schema.stock),
    db.select().from(schema.reservations),
    db.select().from(schema.despatches),
    db.select().from(schema.despatchItems),
    db.select().from(schema.outbox),
  ]);
  return {
    stock: stock.length,
    reservations: reservations.length,
    despatches: despatches.length,
    despatchItems: despatchItems.length,
    outbox: outbox.length,
  };
}
