// Shared Testcontainers harness for the `billing_credit` integration specs
// (design.md §13): real MySQL (mysql:8.4.11), real NATS (nats:2.14.5-alpine)
// and real Kafka (apache/kafka:4.3.1, 6-partition topic). Boots the REAL
// `AppModule` provider graph — literally `Test.createTestingModule({
// imports: [AppModule] })`, exactly per design.md §13 — by pointing the
// process environment at the started containers before compiling, so every
// `useFactory` in `app.module.ts` builds the SAME way it would in
// production, no provider is swapped by hand, and the exact DI/decorator/
// serializer wiring `main.ts` boots is what this harness exercises (the
// class of bug feature 16's live-stack finding was invisible to a
// hand-wired `TestingModule`).
//
// NOT itself a `*.spec.ts` file — neither vitest config picks it up.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { JSONCodec, headers as natsHeaders, type NatsConnection } from 'nats';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import type { RpcError } from '@otc/contracts';
import { AppModule, NATS_CONNECTION } from '../app.module';
import type { BillingDb } from '../infrastructure/persistence/client';
import { runBillingMigrations } from '../infrastructure/persistence/migrator';
import * as schema from '../infrastructure/persistence/schema';
import { BareJsonNatsDeserializer } from '../infrastructure/messaging/bare-json-nats.deserializer';
import { BareJsonNatsSerializer } from '../infrastructure/messaging/bare-json-nats.serializer';
import { BILLING_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from '../infrastructure/outbox/test-support/kafka-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from '../infrastructure/messaging/test-support/nats-test-fixture';
import { assertNotCentsRuleAmount, CENTS_RULE_OPT_IN } from './cents-rule-fixture-guard';
import type { CreditHoldRequestPayload, InvoiceIssueRequestPayload, InvoiceLine, PaymentRegisterRequestPayload, PaymentSource } from '@otc/contracts';

export const MYSQL_IMAGE = 'mysql:8.4.11';

export interface SeedCreditRow {
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditLimit: number;
  readonly currencyCode: string;
  readonly code?: string;
}

export interface SeedCreditItemRow {
  readonly creditId: string;
  readonly orderReference: string;
  readonly amount: number;
  readonly type: 'hold' | 'consume' | 'release';
}

export interface SeedInvoiceRow {
  readonly orderReference: string;
  readonly invoiceReference: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currencyCode: string;
  readonly amount: number;
  readonly discount: number;
  readonly totalAmount: number;
  readonly status: 'issued' | 'paid';
  readonly paidAt?: Date | null;
  readonly invoiceDate?: Date;
}

export interface HoldRequestOverrides {
  readonly orderReference: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly amount: number;
  readonly centsRuleOptIn?: typeof CENTS_RULE_OPT_IN;
}

export interface IssueRequestOverrides {
  readonly orderReference: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLine[];
  readonly discount?: number;
  readonly centsRuleOptIn?: typeof CENTS_RULE_OPT_IN;
}

export interface PaymentRequestOverrides {
  readonly invoiceId?: string;
  readonly invoiceReference?: string;
  readonly paymentReference: string;
  readonly amount: number;
  readonly currency: string;
  readonly valueDate?: string;
  readonly source?: PaymentSource;
  readonly centsRuleOptIn?: typeof CENTS_RULE_OPT_IN;
}

export interface BillingIntegrationHarness {
  readonly app: INestApplication;
  readonly db: BillingDb;
  readonly testNatsConnection: NatsConnection;
  /** A raw `nats` request — the production caller's shape (Orders' `nats-saga-commands.adapter.ts`), never `ClientProxy`. Bare JSON in, bare JSON (or RpcError) out. */
  requestBare<TReply>(subject: string, payload: unknown, headers?: Record<string, string>, timeoutMs?: number): Promise<TReply | RpcError>;
  seedCreditLine(row: SeedCreditRow): Promise<string>;
  seedCreditItem(row: SeedCreditItemRow): Promise<string>;
  /** Inserts an `invoices` row directly — used by fixtures that need an already-issued (or already-paid) invoice without driving `billing.invoice.issue` (e.g. `BI9`'s paid variant — feature 22 has no responder yet). */
  seedInvoice(row: SeedInvoiceRow): Promise<string>;
  outboxRowsFor(correlationId: string): Promise<(typeof schema.outbox.$inferSelect)[]>;
  ledgerOf(orderReference: string): Promise<(typeof schema.creditItems.$inferSelect)[]>;
  creditRowOf(retailerCode: string, companyCode: string): Promise<typeof schema.credits.$inferSelect | undefined>;
  committedExposureOf(creditId: string): Promise<number>;
  invoicesOf(orderReference: string): Promise<(typeof schema.invoices.$inferSelect)[]>;
  invoiceItemsOf(invoiceId: string): Promise<(typeof schema.invoiceItems.$inferSelect)[]>;
  /** feature 22 — the `payments` rows for one invoice, for direct row-count assertions (R48). */
  paymentsOf(invoiceId: string): Promise<(typeof schema.payments.$inferSelect)[]>;
  /** Builds a `billing.credit.hold` request payload, guarding the amount with `assertNotCentsRuleAmount` (N2, `billing_invoicing` design.md §11.2). */
  holdRequest(overrides: HoldRequestOverrides): CreditHoldRequestPayload;
  /** Builds a `billing.invoice.issue` request payload, guarding the COMPUTED total (Σ unitPrice × units − discount) with `assertNotCentsRuleAmount` — the load-bearing half for invoicing fixtures (N2). */
  issueRequest(overrides: IssueRequestOverrides): InvoiceIssueRequestPayload;
  /** feature 22 — builds a `billing.payment.register` request payload, guarding the amount with `assertNotCentsRuleAmount` (N2, extended to this subject). */
  paymentRequest(overrides: PaymentRequestOverrides): PaymentRegisterRequestPayload;
  teardown(): Promise<void>;
}

function natsHeadersOf(record?: Record<string, string>) {
  if (!record) {
    return undefined;
  }
  const h = natsHeaders();
  for (const [key, value] of Object.entries(record)) {
    h.set(key, value);
  }
  return h;
}

export async function startBillingIntegrationHarness(): Promise<BillingIntegrationHarness> {
  const [mysqlContainer, kafkaFixture, natsFixture]: [StartedMySqlContainer, KafkaTestFixture, NatsTestFixture] = await Promise.all([
    new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('otc_billing')
      .withUsername('otc_app')
      .withUserPassword('otc_app_test_password')
      .withRootPassword('otc_root_test_password')
      .start(),
    startKafkaTestFixture(),
    startNatsTestFixture(),
  ]);

  const dbConnectionDetails = {
    host: mysqlContainer.getHost(),
    port: mysqlContainer.getPort(),
    user: mysqlContainer.getUsername(),
    password: mysqlContainer.getUserPassword(),
    database: mysqlContainer.getDatabase(),
  };
  await runBillingMigrations(dbConnectionDetails);
  await createTopic(kafkaFixture.brokers, BILLING_FACTS_TOPIC);

  // A probe connection this harness's OWN test helpers read/write through —
  // independent of whatever pool `app.module.ts`'s useFactory opens from
  // the env vars below.
  const probePool: Pool = mysql.createPool({ ...dbConnectionDetails, timezone: 'Z' });
  const db = drizzle(probePool, { schema, mode: 'default' });

  const natsConnectionOptions = natsFixture.container.getConnectionOptions();
  const natsServers = typeof natsConnectionOptions.servers === 'string' ? natsConnectionOptions.servers : natsConnectionOptions.servers![0]!;

  // Point the process environment at the started containers BEFORE
  // compiling `AppModule` — every `useFactory` in it reads these via
  // `loadBillingDbConfig()`/`loadKafkaConfig()` (design.md §13).
  process.env.BILLING_DB_HOST = dbConnectionDetails.host;
  process.env.MYSQL_HOST_PORT = String(dbConnectionDetails.port);
  process.env.MYSQL_USER = dbConnectionDetails.user;
  process.env.MYSQL_PASSWORD = dbConnectionDetails.password;
  process.env.MYSQL_DB_BILLING = dbConnectionDetails.database;
  process.env.KAFKA_BROKERS = kafkaFixture.brokers.join(',');
  process.env.BILLING_KAFKA_CLIENT_ID = `otc-billing-test-${randomUUID().slice(0, 8)}`;
  process.env.OUTBOX_RELAY_ENABLED = 'true';
  process.env.OUTBOX_POLL_INTERVAL_MS = '50';
  process.env.OUTBOX_BATCH_SIZE = '100';
  process.env.OUTBOX_PUBLISH_TIMEOUT_MS = '5000';

  // A8 (R60/OR6) — `app.module.ts` now ALSO opens its own outbound
  // `NATS_CONNECTION`, SOLELY for `NatsHealthCheck`'s readiness probe (this
  // service issues no other outbound RPC call). Left to `loadNatsConfig()`'s
  // env-var path, that provider would connect to whatever `NATS_URL`
  // defaults to (`nats://localhost:4222`, no credentials), NOT this
  // hermetic fixture (which requires `--user test --pass test`) — same
  // finding recorded in `apps/fulfillment/src/test-support/stock-integration-harness.ts`'s
  // own comment. Overridden here with a real, correctly-authenticated
  // connection to the SAME fixture instead.
  const testNatsConnection = await natsFixture.connect();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NATS_CONNECTION)
    .useValue(testNatsConnection)
    .compile();
  const app = moduleRef.createNestApplication();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.NATS,
    options: {
      servers: [natsServers],
      user: natsConnectionOptions.user,
      pass: natsConnectionOptions.pass,
      deserializer: new BareJsonNatsDeserializer(),
      serializer: new BareJsonNatsSerializer(),
    },
  });
  await app.startAllMicroservices();
  await app.init();

  async function requestBare<TReply>(
    subject: string,
    payload: unknown,
    headerRecord?: Record<string, string>,
    timeoutMs = 5000,
  ): Promise<TReply | RpcError> {
    const requestCodec = JSONCodec<unknown>();
    const replyCodec = JSONCodec<TReply | RpcError>();
    const reply = await testNatsConnection.request(subject, requestCodec.encode(payload), {
      timeout: timeoutMs,
      headers: natsHeadersOf(headerRecord),
    });
    return replyCodec.decode(reply.data);
  }

  async function seedCreditLine(row: SeedCreditRow): Promise<string> {
    const id = randomUUID();
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db.insert(schema.credits).values({
      id,
      code: row.code ?? `CR-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
      retailerCode: row.retailerCode,
      companyCode: row.companyCode,
      creditLimit: row.creditLimit,
      currencyCode: row.currencyCode,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function seedCreditItem(row: SeedCreditItemRow): Promise<string> {
    assertNotCentsRuleAmount(row.amount, `seedCreditItem(${row.type}, ${row.orderReference})`);
    const id = randomUUID();
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db.insert(schema.creditItems).values({
      id,
      creditId: row.creditId,
      orderReference: row.orderReference,
      amount: row.amount,
      type: row.type,
      creditDate: now,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function seedInvoice(row: SeedInvoiceRow): Promise<string> {
    const id = randomUUID();
    const now = row.invoiceDate ?? new Date(Math.floor(Date.now() / 1000) * 1000);
    await db.insert(schema.invoices).values({
      id,
      invoiceReference: row.invoiceReference,
      invoiceDate: now,
      companyCode: row.companyCode,
      retailerCode: row.retailerCode,
      orderReference: row.orderReference,
      amount: row.amount,
      discount: row.discount,
      totalAmount: row.totalAmount,
      currencyCode: row.currencyCode,
      status: row.status,
      paidAt: row.paidAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function outboxRowsFor(correlationId: string) {
    return db.select().from(schema.outbox).where(eq(schema.outbox.correlationId, correlationId));
  }

  async function ledgerOf(orderReference: string) {
    return db.select().from(schema.creditItems).where(eq(schema.creditItems.orderReference, orderReference));
  }

  async function creditRowOf(retailerCode: string, companyCode: string) {
    const rows = await db.select().from(schema.credits).where(eq(schema.credits.retailerCode, retailerCode));
    return rows.find((row) => row.companyCode === companyCode);
  }

  async function committedExposureOf(creditId: string): Promise<number> {
    const rows = await db.select().from(schema.creditItems).where(eq(schema.creditItems.creditId, creditId));
    return rows.reduce((sum, row) => sum + (row.type === 'hold' ? row.amount : row.type === 'release' ? -row.amount : 0), 0);
  }

  async function invoicesOf(orderReference: string) {
    return db.select().from(schema.invoices).where(eq(schema.invoices.orderReference, orderReference));
  }

  async function invoiceItemsOf(invoiceId: string) {
    return db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId));
  }

  async function paymentsOf(invoiceId: string) {
    return db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
  }

  function holdRequest(overrides: HoldRequestOverrides): CreditHoldRequestPayload {
    assertNotCentsRuleAmount(overrides.amount, `holdRequest(${overrides.orderReference})`, overrides.centsRuleOptIn);
    return {
      orderReference: overrides.orderReference,
      retailerCode: overrides.retailerCode,
      companyCode: overrides.companyCode,
      amount: { amount: overrides.amount, currency: overrides.currency },
    };
  }

  function issueRequest(overrides: IssueRequestOverrides): InvoiceIssueRequestPayload {
    const discount = overrides.discount ?? 0;
    const gross = overrides.lines.reduce((sum, line) => sum + line.unitPrice * line.units, 0);
    // The COMPUTED total — the load-bearing half of N2's guard (design.md
    // §11.2): an invoicing fixture's credit-relevant amount is usually
    // computed from several lines, not written as one literal.
    assertNotCentsRuleAmount(gross - discount, `issueRequest(${overrides.orderReference})`, overrides.centsRuleOptIn);
    return {
      orderReference: overrides.orderReference,
      retailerCode: overrides.retailerCode,
      companyCode: overrides.companyCode,
      currency: overrides.currency,
      lines: overrides.lines as [InvoiceLine, ...InvoiceLine[]],
      discount: overrides.discount,
    };
  }

  function paymentRequest(overrides: PaymentRequestOverrides): PaymentRegisterRequestPayload {
    assertNotCentsRuleAmount(overrides.amount, `paymentRequest(${overrides.paymentReference})`, overrides.centsRuleOptIn);
    return {
      ...(overrides.invoiceId ? { invoiceId: overrides.invoiceId } : {}),
      ...(overrides.invoiceReference ? { invoiceReference: overrides.invoiceReference } : {}),
      paymentReference: overrides.paymentReference,
      amount: { amount: overrides.amount, currency: overrides.currency },
      valueDate: overrides.valueDate ?? new Date().toISOString(),
      source: overrides.source ?? 'test',
    };
  }

  return {
    app,
    db,
    testNatsConnection,
    requestBare,
    seedCreditLine,
    seedCreditItem,
    seedInvoice,
    outboxRowsFor,
    ledgerOf,
    creditRowOf,
    committedExposureOf,
    invoicesOf,
    invoiceItemsOf,
    paymentsOf,
    holdRequest,
    issueRequest,
    paymentRequest,
    async teardown(): Promise<void> {
      // `testNatsConnection` IS `app.module.ts`'s own `NATS_CONNECTION`
      // now (overridden above, A8) — `app.close()` already closes it via
      // `NatsConnectionCloser`'s shutdown hook, so no separate close call
      // is needed here.
      await app.close();
      await probePool.end();
      await mysqlContainer.stop();
      await kafkaFixture.teardown();
      await natsFixture.teardown();
    },
  };
}
