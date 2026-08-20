// Testcontainers integration test — the acceptance criterion for
// db_billing (feature_list.json #11): "migrations run from empty" and
// "round-trip integration test per table". Runs against a disposable
// mysql:8.4.11 container, the SAME pinned image docker-compose.infra.yml
// uses (see progress/impl_infra_compose.md), never a mocked store. Same
// shape as apps/orders' and apps/fulfillment's migrations.integration.spec.ts
// (db_orders / db_fulfillment) — see progress/impl_db_fulfillment.md for the
// pattern this feature follows.
//
// Kept out of `pnpm test` / `pnpm quality` (vitest.config.mts excludes
// *.integration.spec.ts) — run explicitly via `pnpm test:integration`.
import { randomUUID } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillingMigrations } from './migrator';
import * as schema from './schema';

const MYSQL_IMAGE = 'mysql:8.4.11';

describe('otc_billing — migrations + round-trip (Testcontainers, mysql:8.4.11)', () => {
  let container: StartedMySqlContainer;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;

  beforeAll(async () => {
    container = await new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('otc_billing')
      .withUsername('otc_app')
      .withUserPassword('otc_app_test_password')
      .withRootPassword('otc_root_test_password')
      .start();

    // "migrations run from empty" — applied to a container that has never
    // seen a single CREATE TABLE.
    await runBillingMigrations({
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
        'credit_items',
        'credits',
        'invoice_items',
        'invoices',
        'outbox',
        'payments',
        'processed_events',
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

  it('asserts the (credit_id, order_reference) index exists on credit_items — the ledger derivation lookups must be index scans', async () => {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT seq_in_index, column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'credit_items' AND index_name = 'idx_credit_items_credit_order'
       ORDER BY seq_in_index`,
      [container.getDatabase()],
    );

    expect(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME))).toEqual([
      'credit_id',
      'order_reference',
    ]);
  });

  it('round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling', async () => {
    // MySQL DATETIME has second precision — strip milliseconds so the
    // round-trip comparison below isn't flaky on truncation.
    const nowUtc = new Date(Math.floor(Date.now() / 1000) * 1000);

    const creditId = randomUUID();
    await db.insert(schema.credits).values({
      id: creditId,
      code: 'CR-000001',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      creditLimit: 1_000_000,
      currencyCode: 'EUR',
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [creditRow] = await db.select().from(schema.credits).where(eq(schema.credits.id, creditId));
    expect(creditRow).toMatchObject({
      id: creditId,
      code: 'CR-000001',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      creditLimit: 1_000_000,
      currencyCode: 'EUR',
    });
    expect(creditRow?.createdAt.getTime()).toBe(nowUtc.getTime());
    expect(creditRow?.updatedAt.getTime()).toBe(nowUtc.getTime());

    const creditItemId = randomUUID();
    await db.insert(schema.creditItems).values({
      id: creditItemId,
      creditId,
      orderReference: 'ORD-000001',
      amount: 50_000,
      type: 'hold',
      creditDate: nowUtc,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [creditItem] = await db
      .select()
      .from(schema.creditItems)
      .where(eq(schema.creditItems.id, creditItemId));
    expect(creditItem).toMatchObject({
      id: creditItemId,
      creditId,
      orderReference: 'ORD-000001',
      amount: 50_000,
      type: 'hold',
    });
    expect(creditItem?.creditDate.getTime()).toBe(nowUtc.getTime());

    const invoiceId = randomUUID();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      invoiceReference: 'INV-000001',
      invoiceDate: nowUtc,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000001',
      amount: 50_000,
      discount: 0,
      totalAmount: 50_000,
      currencyCode: 'EUR',
      status: 'issued',
      paidAt: null,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice).toMatchObject({
      id: invoiceId,
      invoiceReference: 'INV-000001',
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000001',
      amount: 50_000,
      discount: 0,
      totalAmount: 50_000,
      currencyCode: 'EUR',
      status: 'issued',
      paidAt: null,
    });
    expect(invoice?.invoiceDate.getTime()).toBe(nowUtc.getTime());

    const invoiceItemId = randomUUID();
    await db.insert(schema.invoiceItems).values({
      id: invoiceItemId,
      invoiceId,
      productCode: 'PROD-0001',
      units: 10,
      price: 5_000,
      createdAt: nowUtc,
      updatedAt: nowUtc,
    });
    const [invoiceItem] = await db
      .select()
      .from(schema.invoiceItems)
      .where(eq(schema.invoiceItems.id, invoiceItemId));
    expect(invoiceItem).toMatchObject({
      id: invoiceItemId,
      invoiceId,
      productCode: 'PROD-0001',
      units: 10,
      price: 5_000,
    });

    const paymentId = randomUUID();
    await db.insert(schema.payments).values({
      id: paymentId,
      paymentReference: 'PAY-000001',
      invoiceId,
      amount: 50_000,
      currencyCode: 'EUR',
      valueDate: nowUtc,
      source: 'robot',
      createdAt: nowUtc,
    });
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    expect(payment).toMatchObject({
      id: paymentId,
      paymentReference: 'PAY-000001',
      invoiceId,
      amount: 50_000,
      currencyCode: 'EUR',
      source: 'robot',
    });
    expect(payment?.valueDate.getTime()).toBe(nowUtc.getTime());
    expect(payment?.createdAt.getTime()).toBe(nowUtc.getTime());

    const eventId = randomUUID();
    const causationId = randomUUID();
    const payload = {
      invoiceReference: 'INV-000001',
      orderReference: 'ORD-000001',
      totalAmount: 50_000,
      lines: [{ productCode: 'PROD-0001', units: 10, price: 5_000 }],
    };
    // outbox.occurred_at is datetime(3) (design.md §3.2) — round-trip the
    // millisecond component too.
    const occurredAtWithMs = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId,
      eventType: 'invoice.issued.v1',
      aggregateId: invoiceId,
      correlationId: creditId,
      causationId,
      payload,
      occurredAt: occurredAtWithMs,
      publishedAt: null,
      createdAt: nowUtc,
    });
    const [outboxRow] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventId, eventId));
    expect(outboxRow).toMatchObject({
      eventId,
      eventType: 'invoice.issued.v1',
      aggregateId: invoiceId,
      correlationId: creditId,
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
  });

  it('rejects a duplicate (retailer_code, company_code) pair in credits — one BuyerCredit line per retailer/supplier pair', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    await db.insert(schema.credits).values({
      id: randomUUID(),
      code: 'CR-000002',
      retailerCode: 'RET-0002',
      companyCode: 'COM-0002',
      creditLimit: 100_000,
      currencyCode: 'EUR',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.credits).values({
        id: randomUUID(),
        code: 'CR-000003', // different code — the pair is still a duplicate
        retailerCode: 'RET-0002',
        companyCode: 'COM-0002',
        creditLimit: 200_000,
        currencyCode: 'EUR',
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });

    // Sanity: same retailerCode for a DIFFERENT company is a distinct pair
    // and must be accepted — proves the constraint is the composite pair,
    // not retailerCode alone.
    await expect(
      db.insert(schema.credits).values({
        id: randomUUID(),
        code: 'CR-000004',
        retailerCode: 'RET-0002',
        companyCode: 'COM-0003',
        creditLimit: 100_000,
        currencyCode: 'EUR',
        createdAt: now,
        updatedAt: now,
      }),
    ).resolves.not.toThrow();
  });

  it('rejects a duplicate invoice_reference in invoices — one INV-###### reference must be unique', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    await db.insert(schema.invoices).values({
      id: randomUUID(),
      invoiceReference: 'INV-000099',
      invoiceDate: now,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000099',
      amount: 1_000,
      discount: 0,
      totalAmount: 1_000,
      currencyCode: 'EUR',
      status: 'issued',
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.invoices).values({
        id: randomUUID(),
        invoiceReference: 'INV-000099', // duplicate reference
        invoiceDate: now,
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        orderReference: 'ORD-000098',
        amount: 2_000,
        discount: 0,
        totalAmount: 2_000,
        currencyCode: 'EUR',
        status: 'issued',
        paidAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
  });

  it('rejects a duplicate payment_reference in payments — the remittance intake idempotency key', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    const invoiceId = randomUUID();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      invoiceReference: 'INV-000098',
      invoiceDate: now,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000097',
      amount: 1_000,
      discount: 0,
      totalAmount: 1_000,
      currencyCode: 'EUR',
      status: 'issued',
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.payments).values({
      id: randomUUID(),
      paymentReference: 'PAY-000099',
      invoiceId,
      amount: 1_000,
      currencyCode: 'EUR',
      valueDate: now,
      source: 'operator',
      createdAt: now,
    });

    await expect(
      db.insert(schema.payments).values({
        id: randomUUID(),
        paymentReference: 'PAY-000099', // duplicate — the idempotency key
        invoiceId,
        amount: 1_000,
        currencyCode: 'EUR',
        valueDate: now,
        source: 'operator',
        createdAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
  });

  it('rejects a duplicate event_id in outbox — dual-write of the same fact must fail loudly, not silently duplicate', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const invoiceId = randomUUID();
    const sharedEventId = randomUUID();

    await db.insert(schema.outbox).values({
      id: randomUUID(),
      eventId: sharedEventId,
      eventType: 'payment.received.v1',
      aggregateId: invoiceId,
      correlationId: invoiceId,
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
        eventType: 'payment.received.v1',
        aggregateId: invoiceId,
        correlationId: invoiceId,
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

  it('cascade-deletes invoice_items when the parent invoice is deleted', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const invoiceId = randomUUID();
    const invoiceItemId = randomUUID();

    await db.insert(schema.invoices).values({
      id: invoiceId,
      invoiceReference: 'INV-000097',
      invoiceDate: now,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      orderReference: 'ORD-000096',
      amount: 1_000,
      discount: 0,
      totalAmount: 1_000,
      currencyCode: 'EUR',
      status: 'issued',
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.invoiceItems).values({
      id: invoiceItemId,
      invoiceId,
      productCode: 'PROD-0099',
      units: 1,
      price: 1_000,
      createdAt: now,
      updatedAt: now,
    });

    await db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId));

    const remaining = await db
      .select()
      .from(schema.invoiceItems)
      .where(eq(schema.invoiceItems.id, invoiceItemId));
    expect(remaining).toHaveLength(0);
  });
});
