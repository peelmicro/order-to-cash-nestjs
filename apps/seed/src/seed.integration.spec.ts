// Testcontainers integration test — a full disposable stack: ONE MySQL
// container hosting the three logical databases (otc_orders,
// otc_fulfillment, otc_billing — task prompt: "three databases on one
// container is fine — create them") plus ONE disposable MongoDB container,
// both the SAME pinned images docker-compose.infra.yml uses. Runs the
// COMPLETE seed (migrations + master data + sample sagas + Mongo) TWICE and
// asserts idempotency by diffing row counts and a checksum of a
// representative table, never mocked (CLAUDE.md § Testing conventions).
import { randomUUID } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient, type Db as MongoDb } from 'mongodb';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createOrdersDb,
  createOrdersPool,
  type OrdersDb,
} from '../../orders/src/infrastructure/persistence/client';
import type { OrdersDbConfig } from '../../orders/src/infrastructure/persistence/db-config';
import { runOrdersMigrations } from '../../orders/src/infrastructure/persistence/migrator';

import {
  createFulfillmentDb,
  createFulfillmentPool,
  type FulfillmentDb,
} from '../../fulfillment/src/infrastructure/persistence/client';
import type { FulfillmentDbConfig } from '../../fulfillment/src/infrastructure/persistence/db-config';
import { runFulfillmentMigrations } from '../../fulfillment/src/infrastructure/persistence/migrator';

import {
  createBillingDb,
  createBillingPool,
  type BillingDb,
} from '../../billing/src/infrastructure/persistence/client';
import type { BillingDbConfig } from '../../billing/src/infrastructure/persistence/db-config';
import { runBillingMigrations } from '../../billing/src/infrastructure/persistence/migrator';

import { seedOrdersMasterData, seedOrdersSagas } from './writers/orders-db.writer';
import { seedFulfillmentSagas, seedFulfillmentStock } from './writers/fulfillment-db.writer';
import { seedBillingCredits, seedBillingSagas } from './writers/billing-db.writer';
import { seedMongoTimelines, orderTimelineCollection } from './writers/mongo.writer';
import { verifySeed, type VerificationSummary } from './verify';
import { OutboxRelay, type OutboxRelayResult } from '../../orders/src/infrastructure/outbox/outbox-relay';
import type { FactPublisher, PublishableFact } from '../../orders/src/application/ports/fact-publisher.port';

const MYSQL_IMAGE = 'mysql:8.4.11';
const MONGO_IMAGE = 'mongo:8.3.8';
const APP_USER = 'otc_app';
const APP_PASSWORD = 'otc_app_test_password';
const ROOT_PASSWORD = 'otc_root_test_password';

describe('apps/seed — full seed against disposable MySQL + MongoDB (Testcontainers)', () => {
  let mysqlContainer: StartedMySqlContainer;
  let mongoContainer: StartedMongoDBContainer;
  let mongoClient: MongoClient;
  let mongoDb: MongoDb;

  let ordersDb: OrdersDb;
  let fulfillmentDb: FulfillmentDb;
  let billingDb: BillingDb;
  let ordersPool: ReturnType<typeof createOrdersPool>;
  let fulfillmentPool: ReturnType<typeof createFulfillmentPool>;
  let billingPool: ReturnType<typeof createBillingPool>;

  beforeAll(async () => {
    mysqlContainer = await new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('otc_orders')
      .withUsername(APP_USER)
      .withUserPassword(APP_PASSWORD)
      .withRootPassword(ROOT_PASSWORD)
      .start();

    // Database-per-service, three logical databases on the ONE container —
    // task prompt explicitly allows this for the disposable test stack.
    await mysqlContainer.executeQuery('CREATE DATABASE IF NOT EXISTS otc_fulfillment;', [], true);
    await mysqlContainer.executeQuery('CREATE DATABASE IF NOT EXISTS otc_billing;', [], true);
    await mysqlContainer.executeQuery(
      `GRANT ALL PRIVILEGES ON otc_fulfillment.* TO '${APP_USER}'@'%';`,
      [],
      true,
    );
    await mysqlContainer.executeQuery(
      `GRANT ALL PRIVILEGES ON otc_billing.* TO '${APP_USER}'@'%';`,
      [],
      true,
    );
    await mysqlContainer.executeQuery('FLUSH PRIVILEGES;', [], true);

    const baseConfig = {
      host: mysqlContainer.getHost(),
      port: mysqlContainer.getPort(),
      user: APP_USER,
      password: APP_PASSWORD,
    };
    const ordersConfig: OrdersDbConfig = { ...baseConfig, database: 'otc_orders' };
    const fulfillmentConfig: FulfillmentDbConfig = { ...baseConfig, database: 'otc_fulfillment' };
    const billingConfig: BillingDbConfig = { ...baseConfig, database: 'otc_billing' };

    await runOrdersMigrations(ordersConfig);
    await runFulfillmentMigrations(fulfillmentConfig);
    await runBillingMigrations(billingConfig);

    ordersPool = createOrdersPool(ordersConfig);
    ordersDb = createOrdersDb(ordersPool);
    fulfillmentPool = createFulfillmentPool(fulfillmentConfig);
    fulfillmentDb = createFulfillmentDb(fulfillmentPool);
    billingPool = createBillingPool(billingConfig);
    billingDb = createBillingDb(billingPool);

    mongoContainer = await new MongoDBContainer(MONGO_IMAGE).start();
    mongoClient = new MongoClient(mongoContainer.getConnectionString(), { directConnection: true });
    await mongoClient.connect();
    mongoDb = mongoClient.db(`otc_read_model_test_${randomUUID().slice(0, 8)}`);
  }, 300_000);

  afterAll(async () => {
    await ordersPool?.end();
    await fulfillmentPool?.end();
    await billingPool?.end();
    await mongoClient?.close();
    await mysqlContainer?.stop();
    await mongoContainer?.stop();
  });

  async function runFullSeed(): Promise<void> {
    await seedOrdersMasterData(ordersDb);
    await seedFulfillmentStock(fulfillmentDb);
    await seedBillingCredits(billingDb);
    await seedOrdersSagas(ordersDb);
    await seedFulfillmentSagas(fulfillmentDb);
    await seedBillingSagas(billingDb);
    await seedMongoTimelines(mongoDb);
  }

  async function ordersChecksum(): Promise<string> {
    const connection = await mysql.createConnection({
      host: mysqlContainer.getHost(),
      port: mysqlContainer.getPort(),
      user: APP_USER,
      password: APP_PASSWORD,
      database: 'otc_orders',
    });
    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT MD5(GROUP_CONCAT(id ORDER BY id)) AS checksum FROM orders`,
      );
      return String(rows[0]?.checksum);
    } finally {
      await connection.end();
    }
  }

  it('runs migrations from empty and seeds the full fixture set, passing self-verification', async () => {
    await runFullSeed();
    const summary = await verifySeed({ ordersDb, fulfillmentDb, billingDb, mongoDb });

    expect(summary.orders.orders).toBe(6);
    expect(summary.fulfillment.despatches).toBe(5);
    expect(summary.billing.invoices).toBe(5);
    expect(summary.mongoOrderTimelines).toBe(6);
  }, 300_000);

  it('is idempotent: running the full seed again changes no row counts and no representative-table checksum', async () => {
    const before: VerificationSummary = await verifySeed({
      ordersDb,
      fulfillmentDb,
      billingDb,
      mongoDb,
    });
    const checksumBefore = await ordersChecksum();

    await runFullSeed();

    const after: VerificationSummary = await verifySeed({
      ordersDb,
      fulfillmentDb,
      billingDb,
      mongoDb,
    });
    const checksumAfter = await ordersChecksum();

    expect(after).toEqual(before);
    expect(checksumAfter).toBe(checksumBefore);
  }, 300_000);

  it('the cancelled order timeline shows the compensation sequence (release, then cancel)', async () => {
    const cancelledDoc = await orderTimelineCollection(mongoDb).findOne({
      orderReference: 'ORD-000006',
    });

    expect(cancelledDoc?.status).toBe('cancelled');
    expect(cancelledDoc?.cancellationReason).toBe('credit_rejected');
    expect(cancelledDoc?.events.map((e) => e.eventType)).toEqual([
      'order.placed.v1',
      'stock.reserved.v1',
      'credit.rejected.v1',
      'stock.released.v1',
      'order.cancelled.v1',
    ]);
  }, 300_000);

  it('every outbox row across the three databases is already published', async () => {
    const [ordersUnpublished] = await ordersPool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL',
    );
    const [fulfillmentUnpublished] = await fulfillmentPool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL',
    );
    const [billingUnpublished] = await billingPool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL',
    );

    expect(Number(ordersUnpublished[0]?.n)).toBe(0);
    expect(Number(fulfillmentUnpublished[0]?.n)).toBe(0);
    expect(Number(billingUnpublished[0]?.n)).toBe(0);
  }, 300_000);

  it('the relay finds no unpublished record in any of the three seeded databases', async () => {
    // A fake publisher that must never be invoked — the seed pre-publishes
    // every row on purpose (design.md §2, "the seeded databases have
    // nothing to publish"), so a real broker is neither needed nor wanted
    // here.
    class NeverCalledFactPublisher implements FactPublisher {
      calls = 0;
      async publish(_facts: readonly PublishableFact[]): Promise<void> {
        this.calls++;
      }
    }

    const relayConfig = { enabled: true, pollIntervalMs: 0, batchSize: 100, publishTimeoutMs: 5_000 };
    const clock = { now: () => new Date() };

    // `OutboxRelay` is typed against apps/orders' own `OrdersDb`. The
    // fulfillment/billing handles below are cast to it deliberately: the
    // three `outbox` schemas are proven byte-identical by
    // `outbox-parity.spec.ts` (OI11), so the SQL `OutboxRelay` generates
    // from the Orders-defined `outbox` table object is valid against any
    // of the three databases — this cast is the mechanism, the parity test
    // is the guarantee that makes it safe.
    const handles: [name: string, db: unknown][] = [
      ['orders', ordersDb],
      ['fulfillment', fulfillmentDb],
      ['billing', billingDb],
    ];

    for (const [name, db] of handles) {
      const publisher = new NeverCalledFactPublisher();
      const relay = new OutboxRelay({
        db: db as ConstructorParameters<typeof OutboxRelay>[0]['db'],
        publisher,
        clock,
        config: relayConfig,
      });

      const result: OutboxRelayResult = await relay.runOnce();

      expect(result, `${name}: the relay claimed an unpublished record`).toEqual({ claimed: 0, published: 0 });
      expect(publisher.calls, `${name}: the fake publisher was called`).toBe(0);
    }
  }, 300_000);

  it('every seeded outbox row carries a causationId', async () => {
    const [[ordersMissing], [fulfillmentMissing], [billingMissing]] = await Promise.all([
      ordersPool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM outbox WHERE causation_id IS NULL OR causation_id = ''`,
      ),
      fulfillmentPool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM outbox WHERE causation_id IS NULL OR causation_id = ''`,
      ),
      billingPool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM outbox WHERE causation_id IS NULL OR causation_id = ''`,
      ),
    ]);

    expect(Number(ordersMissing[0]?.n)).toBe(0);
    expect(Number(fulfillmentMissing[0]?.n)).toBe(0);
    expect(Number(billingMissing[0]?.n)).toBe(0);
  }, 300_000);
});
