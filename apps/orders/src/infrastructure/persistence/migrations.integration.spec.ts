// Testcontainers integration test — the acceptance criterion for db_orders
// (feature_list.json #9): "migrations run from empty" and "round-trip
// integration test per table via Testcontainers". Runs against a disposable
// mysql:8.4.11 container, the SAME pinned image docker-compose.infra.yml
// uses (see progress/impl_infra_compose.md), never a mocked store.
//
// Kept out of `pnpm test` / `pnpm quality` (vitest.config.mts excludes
// *.integration.spec.ts) — run explicitly via `pnpm test:integration`. See
// vitest.integration.config.mts for the rationale.
import { randomUUID } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOrdersMigrations } from './migrator';
import * as schema from './schema';

const MYSQL_IMAGE = 'mysql:8.4.11';

describe('otc_orders — migrations + round-trip (Testcontainers, mysql:8.4.11)', () => {
  let container: StartedMySqlContainer;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;

  beforeAll(async () => {
    container = await new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('otc_orders')
      .withUsername('otc_app')
      .withUserPassword('otc_app_test_password')
      .withRootPassword('otc_root_test_password')
      .start();

    // "migrations run from empty" — applied to a container that has never
    // seen a single CREATE TABLE.
    await runOrdersMigrations({
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

  it('applies the committed migrations from empty and creates all 8 tables plus drizzle’s own migrations table', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [container.getDatabase()],
    );
    const tableNames = rows.map((row) => String(row.table_name ?? row.TABLE_NAME));

    expect(tableNames).toEqual(
      [
        '__drizzle_migrations',
        'companies',
        'currencies',
        'order_items',
        'orders',
        'outbox',
        'processed_events',
        'products',
        'retailers',
      ].sort(),
    );
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

  it('round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling', async () => {
    // MySQL DATETIME has second precision — strip milliseconds so the
    // round-trip comparison below isn't flaky on truncation. `outbox.occurred_at`
    // is the one exception: it is datetime(3) (design.md §3.2), so its own
    // round-trip below uses a separate, millisecond-bearing timestamp.
    const nowUtc = new Date(Math.floor(Date.now() / 1000) * 1000);

    const currencyId = randomUUID();
    await db.insert(schema.currencies).values({
      id: currencyId,
      code: 'EUR',
      isoNumber: '978',
      symbol: '€',
      decimalPoints: 2,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [currency] = await db.select().from(schema.currencies).where(eq(schema.currencies.id, currencyId));
    expect(currency).toMatchObject({
      id: currencyId,
      code: 'EUR',
      isoNumber: '978',
      symbol: '€',
      decimalPoints: 2,
    });
    expect(currency?.createdAt.getTime()).toBe(nowUtc.getTime());
    expect(currency?.updatedAt.getTime()).toBe(nowUtc.getTime());

    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      code: 'PROD-0001',
      ean: '5901234123457',
      name: 'Widget',
      description: 'A widget for round-trip testing',
      price: 12_345,
      currencyId,
      disabledAt: null,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product).toMatchObject({
      id: productId,
      code: 'PROD-0001',
      ean: '5901234123457',
      name: 'Widget',
      description: 'A widget for round-trip testing',
      price: 12_345,
      currencyId,
      disabledAt: null,
    });

    const retailerId = randomUUID();
    await db.insert(schema.retailers).values({
      id: retailerId,
      code: 'RET-0001',
      name: 'Acme Retail',
      country: 'ES',
      vat: 'ESB12345678',
      gln: '5412345000013',
      currencyId,
      disabledAt: null,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [retailer] = await db.select().from(schema.retailers).where(eq(schema.retailers.id, retailerId));
    expect(retailer).toMatchObject({
      id: retailerId,
      code: 'RET-0001',
      name: 'Acme Retail',
      country: 'ES',
      vat: 'ESB12345678',
      gln: '5412345000013',
      currencyId,
    });

    const companyId = randomUUID();
    await db.insert(schema.companies).values({
      id: companyId,
      code: 'COM-0001',
      name: 'Acme Supply Co',
      country: 'ES',
      vat: 'ESA87654321',
      gln: '5412345000037',
      currencyId,
      disabledAt: null,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(company).toMatchObject({
      id: companyId,
      code: 'COM-0001',
      name: 'Acme Supply Co',
      country: 'ES',
      vat: 'ESA87654321',
      gln: '5412345000037',
      currencyId,
    });

    const orderId = randomUUID();
    await db.insert(schema.orders).values({
      id: orderId,
      orderReference: 'ORD-000001',
      orderDate: nowUtc,
      companyId,
      retailerId,
      currencyId,
      initialAmount: 12_345,
      initialDiscount: 345,
      totalAmount: 12_000,
      status: 'placed',
      cancellationReason: null,
      notes: 'round-trip fixture',
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order).toMatchObject({
      id: orderId,
      orderReference: 'ORD-000001',
      companyId,
      retailerId,
      currencyId,
      initialAmount: 12_345,
      initialDiscount: 345,
      totalAmount: 12_000,
      status: 'placed',
      cancellationReason: null,
      notes: 'round-trip fixture',
    });
    expect(order?.orderDate.getTime()).toBe(nowUtc.getTime());

    const orderItemId = randomUUID();
    await db.insert(schema.orderItems).values({
      id: orderItemId,
      orderId,
      productId,
      description: 'A widget for round-trip testing',
      price: 12_345,
      quantity: 1,
      discount: 345,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [orderItem] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.id, orderItemId));
    expect(orderItem).toMatchObject({
      id: orderItemId,
      orderId,
      productId,
      description: 'A widget for round-trip testing',
      price: 12_345,
      quantity: 1,
      discount: 345,
    });

    const eventId = randomUUID();
    const causationId = randomUUID();
    const payload = {
      orderReference: 'ORD-000001',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: 'EUR',
      totalAmount: 12_000,
      lines: [{ productCode: 'PROD-0001', quantity: 1, unitPrice: 12_345 }],
    };
    // outbox.occurred_at is datetime(3) (design.md §3.2) — round-trip the
    // millisecond component too, rather than the second-truncated nowUtc
    // every other table's datetime(0) columns use above.
    const occurredAtWithMs = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId,
      eventType: 'order.placed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId,
      payload,
      occurredAt: occurredAtWithMs,
      publishedAt: null,
      createdAt: nowUtc,
    });
    const [outboxRow] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventId, eventId));
    expect(outboxRow).toMatchObject({
      eventId,
      eventType: 'order.placed.v1',
      aggregateId: orderId,
      correlationId: orderId,
      causationId,
      publishedAt: null,
      traceParent: null,
    });
    expect(outboxRow?.payload).toEqual(payload);
    expect(outboxRow?.occurredAt.getTime()).toBe(occurredAtWithMs.getTime());
    // `seq` is store-assigned (design.md §3.2) — the test did not supply
    // it, so its mere presence as a positive number is what proves the
    // AUTO_INCREMENT column exists and works.
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
  });

  it('rejects a duplicate event_id in outbox — dual-write of the same fact must fail loudly, not silently duplicate', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const orderId = randomUUID();
    const sharedEventId = randomUUID();

    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId: sharedEventId,
      eventType: 'order.confirmed.v1',
      aggregateId: orderId,
      correlationId: orderId,
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
        eventType: 'order.confirmed.v1',
        aggregateId: orderId,
        correlationId: orderId,
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
});
