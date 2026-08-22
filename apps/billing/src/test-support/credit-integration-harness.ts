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
import { AppModule } from '../app.module';
import type { BillingDb } from '../infrastructure/persistence/client';
import { runBillingMigrations } from '../infrastructure/persistence/migrator';
import * as schema from '../infrastructure/persistence/schema';
import { BareJsonNatsDeserializer } from '../infrastructure/messaging/bare-json-nats.deserializer';
import { BareJsonNatsSerializer } from '../infrastructure/messaging/bare-json-nats.serializer';
import { BILLING_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from '../infrastructure/outbox/test-support/kafka-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from '../infrastructure/messaging/test-support/nats-test-fixture';

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

export interface CreditIntegrationHarness {
  readonly app: INestApplication;
  readonly db: BillingDb;
  readonly testNatsConnection: NatsConnection;
  /** A raw `nats` request — the production caller's shape (Orders' `nats-saga-commands.adapter.ts`), never `ClientProxy`. Bare JSON in, bare JSON (or RpcError) out. */
  requestBare<TReply>(subject: string, payload: unknown, headers?: Record<string, string>, timeoutMs?: number): Promise<TReply | RpcError>;
  seedCreditLine(row: SeedCreditRow): Promise<string>;
  seedCreditItem(row: SeedCreditItemRow): Promise<string>;
  outboxRowsFor(correlationId: string): Promise<(typeof schema.outbox.$inferSelect)[]>;
  ledgerOf(orderReference: string): Promise<(typeof schema.creditItems.$inferSelect)[]>;
  creditRowOf(retailerCode: string, companyCode: string): Promise<typeof schema.credits.$inferSelect | undefined>;
  committedExposureOf(creditId: string): Promise<number>;
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

export async function startCreditIntegrationHarness(): Promise<CreditIntegrationHarness> {
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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  const testNatsConnection = await natsFixture.connect();

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

  return {
    app,
    db,
    testNatsConnection,
    requestBare,
    seedCreditLine,
    seedCreditItem,
    outboxRowsFor,
    ledgerOf,
    creditRowOf,
    committedExposureOf,
    async teardown(): Promise<void> {
      await testNatsConnection.close();
      await app.close();
      await probePool.end();
      await mysqlContainer.stop();
      await kafkaFixture.teardown();
      await natsFixture.teardown();
    },
  };
}
