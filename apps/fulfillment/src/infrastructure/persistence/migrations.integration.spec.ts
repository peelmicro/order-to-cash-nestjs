// Testcontainers integration test — the acceptance criterion for
// db_fulfillment (feature_list.json #10): "migrations run from empty" and
// "round-trip integration test per table". Runs against a disposable
// mysql:8.4.11 container, the SAME pinned image docker-compose.infra.yml
// uses (see progress/impl_infra_compose.md), never a mocked store. Same
// shape as apps/orders' migrations.integration.spec.ts (db_orders) — see
// progress/impl_db_orders.md for the decision this feature follows.
//
// Kept out of `pnpm test` / `pnpm quality` (vitest.config.mts excludes
// *.integration.spec.ts) — run explicitly via `pnpm test:integration`.
import { randomUUID } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFulfillmentMigrations } from './migrator';
import * as schema from './schema';

const MYSQL_IMAGE = 'mysql:8.4.11';

describe('otc_fulfillment — migrations + round-trip (Testcontainers, mysql:8.4.11)', () => {
  let container: StartedMySqlContainer;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;

  beforeAll(async () => {
    container = await new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('otc_fulfillment')
      .withUsername('otc_app')
      .withUserPassword('otc_app_test_password')
      .withRootPassword('otc_root_test_password')
      .start();

    // "migrations run from empty" — applied to a container that has never
    // seen a single CREATE TABLE.
    await runFulfillmentMigrations({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
    });

    // `timezone: 'Z'` — CLAUDE.md "Dates: UTC everywhere". Without it
    // mysql2 converts DATETIME using the Node process's local timezone,
    // which would make the round-trip assertions below flaky depending on
    // where the test runs.
    connection = await mysql.createConnection({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
      timezone: 'Z',
    });
    db = drizzle(connection, { schema, mode: 'default' });
  }, 120_000);

  afterAll(async () => {
    await connection?.end();
    await container?.stop();
  });

  it('applies the committed migrations from empty and creates all 7 tables plus drizzle’s own migrations table', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [container.getDatabase()],
    );
    const tableNames = rows.map((row) => String(row.table_name ?? row.TABLE_NAME));

    expect(tableNames).toEqual(
      [
        '__drizzle_migrations',
        'despatch_items',
        'despatch_number_sequences',
        'despatches',
        'outbox',
        'processed_events',
        'reservations',
        'stock',
      ].sort(),
    );
  });

  it('asserts the uq_despatches_order_reference unique constraint exists — F8, at most one DespatchAdvice per order (fulfillment_despatch)', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'despatches' AND index_name = 'uq_despatches_order_reference'
       ORDER BY seq_in_index`,
      [container.getDatabase()],
    );

    expect(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME))).toEqual([
      'order_reference',
    ]);
  });

  it('asserts the (published_at, occurred_at) index exists on outbox — the relay poll must be an index scan', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT seq_in_index, column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'outbox' AND index_name = 'idx_outbox_published_occurred'
       ORDER BY seq_in_index`,
      [container.getDatabase()],
    );

    expect(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME))).toEqual([
      'published_at',
      'occurred_at',
    ]);
  });

  it('asserts the (published_at, seq) index exists on outbox — the relay poll (design.md §5.2) must be an index scan', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT seq_in_index, column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'outbox' AND index_name = 'idx_outbox_unpublished_seq'
       ORDER BY seq_in_index`,
      [container.getDatabase()],
    );

    expect(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME))).toEqual([
      'published_at',
      'seq',
    ]);
  });

  it('asserts the (order_reference, status) index exists on reservations — compensation and idempotent-despatch lookups must be index scans', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT seq_in_index, column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'reservations' AND index_name = 'idx_reservations_order_status'
       ORDER BY seq_in_index`,
      [container.getDatabase()],
    );

    expect(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME))).toEqual([
      'order_reference',
      'status',
    ]);
  });

  it('round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling', async () => {
    // MySQL DATETIME has second precision — strip milliseconds so the
    // round-trip comparison below isn't flaky on truncation.
    const nowUtc = new Date(Math.floor(Date.now() / 1000) * 1000);

    const stockId = randomUUID();
    await db.insert(schema.stock).values({
      id: stockId,
      companyCode: 'COM-0001',
      productCode: 'PROD-0001',
      units: 100,
      reservedUnits: 10,
      lowStockThreshold: 5,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [stockRow] = await db.select().from(schema.stock).where(eq(schema.stock.id, stockId));
    expect(stockRow).toMatchObject({
      id: stockId,
      companyCode: 'COM-0001',
      productCode: 'PROD-0001',
      units: 100,
      reservedUnits: 10,
      lowStockThreshold: 5,
    });
    expect(stockRow?.createdAt.getTime()).toBe(nowUtc.getTime());
    expect(stockRow?.updatedAt.getTime()).toBe(nowUtc.getTime());

    const reservationId = randomUUID();
    await db.insert(schema.reservations).values({
      id: reservationId,
      stockId,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PROD-0001',
      orderReference: 'ORD-000001',
      units: 10,
      status: 'reserved',
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [reservation] = await db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.id, reservationId));
    expect(reservation).toMatchObject({
      id: reservationId,
      stockId,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PROD-0001',
      orderReference: 'ORD-000001',
      units: 10,
      status: 'reserved',
    });

    const despatchId = randomUUID();
    await db.insert(schema.despatches).values({
      id: despatchId,
      despatchReference: 'DES-000001',
      despatchDate: nowUtc,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000001',
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [despatch] = await db
      .select()
      .from(schema.despatches)
      .where(eq(schema.despatches.id, despatchId));
    expect(despatch).toMatchObject({
      id: despatchId,
      despatchReference: 'DES-000001',
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000001',
    });
    expect(despatch?.despatchDate.getTime()).toBe(nowUtc.getTime());

    const despatchItemId = randomUUID();
    await db.insert(schema.despatchItems).values({
      id: despatchItemId,
      despatchId,
      productCode: 'PROD-0001',
      units: 10,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [despatchItem] = await db
      .select()
      .from(schema.despatchItems)
      .where(eq(schema.despatchItems.id, despatchItemId));
    expect(despatchItem).toMatchObject({
      id: despatchItemId,
      despatchId,
      productCode: 'PROD-0001',
      units: 10,
    });

    const eventId = randomUUID();
    const causationId = randomUUID();
    const payload = {
      orderReference: 'ORD-000001',
      companyCode: 'COM-0001',
      reservations: [{ productCode: 'PROD-0001', units: 10, reservationId }],
    };
    // outbox.occurred_at is datetime(3) (design.md §3.2) — round-trip the
    // millisecond component too.
    const occurredAtWithMs = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId,
      eventType: 'stock.reserved.v1',
      aggregateId: stockId,
      correlationId: despatchId,
      causationId,
      payload,
      occurredAt: occurredAtWithMs,
      publishedAt: null,
      createdAt: nowUtc,
    });
    const [outboxRow] = await db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.eventId, eventId));
    expect(outboxRow).toMatchObject({
      eventId,
      eventType: 'stock.reserved.v1',
      aggregateId: stockId,
      correlationId: despatchId,
      causationId,
      publishedAt: null,
      traceParent: null,
    });
    expect(outboxRow?.payload).toEqual(payload);
    expect(outboxRow?.occurredAt.getTime()).toBe(occurredAtWithMs.getTime());
    expect(outboxRow?.seq).toEqual(expect.any(Number));
    expect(outboxRow?.seq).toBeGreaterThan(0);

    await db.insert(schema.processedEvents).values({
      id: randomUUID(),
      eventId,
      consumer: 'saga-orchestrator',
      processedAt: nowUtc,
      createdAt: nowUtc,
    });
    const [processedEvent] = await db
      .select()
      .from(schema.processedEvents)
      .where(eq(schema.processedEvents.eventId, eventId));
    expect(processedEvent).toMatchObject({
      eventId,
      consumer: 'saga-orchestrator',
    });
    expect(processedEvent?.processedAt.getTime()).toBe(nowUtc.getTime());

    // despatch_number_sequences — the DES-###### counter row (fulfillment_despatch).
    await db.insert(schema.despatchNumberSequences).values({ id: 1, nextValue: 1 });
    const [sequenceRow] = await db
      .select()
      .from(schema.despatchNumberSequences)
      .where(eq(schema.despatchNumberSequences.id, 1));
    expect(sequenceRow).toMatchObject({ id: 1, nextValue: 1 });
  });

  it('rejects a duplicate order_reference in despatches — F8, at most one DespatchAdvice per order', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    await db.insert(schema.despatches).values({
      id: randomUUID(),
      despatchReference: 'DES-000200',
      despatchDate: now,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000200',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.despatches).values({
        id: randomUUID(),
        despatchReference: 'DES-000201', // different despatch reference — SAME order reference
        despatchDate: now,
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        orderReference: 'ORD-000200',
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
  });

  it('rejects a duplicate (company_code, product_code) pair in stock — one StockItem per product per supplier', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    await db.insert(schema.stock).values({
      id: randomUUID(),
      companyCode: 'COM-0002',
      productCode: 'PROD-0002',
      units: 50,
      reservedUnits: 0,
      lowStockThreshold: 5,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.stock).values({
        id: randomUUID(),
        companyCode: 'COM-0002', // duplicate pair — same company, same product
        productCode: 'PROD-0002',
        units: 999,
        reservedUnits: 0,
        lowStockThreshold: 5,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });

    // Sanity: same productCode for a DIFFERENT company is a distinct pair
    // and must be accepted — proves the constraint is the composite pair,
    // not productCode alone.
    await expect(
      db.insert(schema.stock).values({
        id: randomUUID(),
        companyCode: 'COM-0003',
        productCode: 'PROD-0002',
        units: 50,
        reservedUnits: 0,
        lowStockThreshold: 5,
        createdAt: now,
        updatedAt: now,
      }),
    ).resolves.not.toThrow();
  });

  it('rejects a duplicate event_id in outbox — dual-write of the same fact must fail loudly, not silently duplicate', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const stockId = randomUUID();
    const sharedEventId = randomUUID();

    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId: sharedEventId,
      eventType: 'stock.released.v1',
      aggregateId: stockId,
      correlationId: stockId,
      causationId: randomUUID(),
      payload: { orderReference: 'ORD-000002' },
      occurredAt: now,
      publishedAt: null,
      createdAt: now,
    });

    await expect(
      db.insert(schema.outbox).values({
        id: randomUUID(),
        eventId: sharedEventId, // duplicate — different row, same eventId
        eventType: 'stock.released.v1',
        aggregateId: stockId,
        correlationId: stockId,
        causationId: randomUUID(),
        payload: { orderReference: 'ORD-000002' },
        occurredAt: now,
        publishedAt: null,
        createdAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
  });

  it('rejects a duplicate (event_id, consumer) pair in processed_events — redelivery must be blocked by the unique constraint, not by application logic alone', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const eventId = randomUUID();

    await db.insert(schema.processedEvents).values({
      id: randomUUID(),
      eventId,
      consumer: 'projector',
      processedAt: now,
      createdAt: now,
    });

    await expect(
      db.insert(schema.processedEvents).values({
        id: randomUUID(),
        eventId, // duplicate pair — same eventId, same consumer
        consumer: 'projector',
        processedAt: now,
        createdAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });

    // Sanity: the SAME eventId with a DIFFERENT consumer is a distinct pair
    // and must be accepted — proves the constraint is the composite pair,
    // not eventId alone.
    await expect(
      db.insert(schema.processedEvents).values({
        id: randomUUID(),
        eventId,
        consumer: 'saga-orchestrator',
        processedAt: now,
        createdAt: now,
      }),
    ).resolves.not.toThrow();
  });

  it('cascade-deletes despatch_items when the parent despatch is deleted', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const despatchId = randomUUID();
    const despatchItemId = randomUUID();

    await db.insert(schema.despatches).values({
      id: despatchId,
      despatchReference: 'DES-000099',
      despatchDate: now,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000099',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.despatchItems).values({
      id: despatchItemId,
      despatchId,
      productCode: 'PROD-0099',
      units: 1,
      createdAt: now,
      updatedAt: now,
    });

    await db.delete(schema.despatches).where(eq(schema.despatches.id, despatchId));

    const remaining = await db
      .select()
      .from(schema.despatchItems)
      .where(eq(schema.despatchItems.id, despatchItemId));
    expect(remaining).toHaveLength(0);
  });
});
