// saga_e2e_verification — all five of the feature's acceptance criteria.
// Pass 2 built the first four (happy path, .99 compensation, redelivery,
// poison->DLQ) and their shared fleet; Pass 3 adds a fifth `it()` — R56's
// composed-stack trace observation — reusing that SAME fleet, per the
// leader's own instruction not to spin up a second one.
//
// Pass 3's own honest finding, load-bearing for criterion 5 below: the
// Pass-3 brief's premise ("feature 27 already proved every structured JSON
// log line across every service carries traceId, R58") turned out, on an
// exhaustive source-level audit of every `console.log`/`console.error`
// JSON-shaped call site in this monorepo, to be TRUE ONLY for
// `apps/orders` (and `apps/gateway`'s own `problem-json.filter.ts`, not
// reachable from this suite since Gateway is not part of this fleet — see
// below). `apps/fulfillment`, `apps/billing` and `apps/projector` carry
// ZERO info-level structured log lines anywhere in their production code —
// their only JSON-shaped logger in each case is an outbox-publish-failure
// (or, for the projector, a Kafka-consume-failure) ERROR path, never
// reached by a healthy order. `test-matrix.md`'s own R58 "DONE" row, read
// literally, never actually claims otherwise — every file it names is
// under `apps/orders`/`apps/gateway` — so this is not a regression, but it
// does mean criterion 5 cannot do what the brief's own prescribed
// technique describes ("parse every JSON log line... across every
// process") for three of the four spawned services. Criterion 5 below
// therefore composes the BEST REAL evidence that actually exists, from
// TWO different genuine channels never fabricated for this purpose: (a)
// Orders' own multiple `saga-command-dispatcher: command sent` log lines
// (R58, one per dispatched saga command, i.e. genuinely "every command"
// per R56's own wording) and (b) Fulfillment's and Billing's own DURABLY
// RECORDED `outbox.trace_parent` column (R57) — the same real value each
// service's own `OutboxRecorder.record()` captures, in that SAME real
// separate process, from the active OTel context at the moment of ITS OWN
// write-model transaction — read back over raw SQL exactly the way an
// operator would, never a log line but a genuinely independent per-process
// record of that process's own trace context for this one order. The
// Projector CANNOT be included: it owns no outbox (nothing durable to
// read) and logs nothing at all on a healthy consume (nothing to parse) —
// with no OTel collector stood up (out of this pass's explicit scope), its
// participation in this order's trace is genuinely unobservable from
// outside its own process today. The Gateway is also not part of this
// specific proof: this fleet, unchanged from Pass 2, never spawns a
// Gateway process at all (every order in this file is placed via a raw
// NATS call straight into `orders.create`, the same mechanism all four
// Pass 2 criteria already use) — so there is no Gateway log line to check
// one way or the other, and the trace's own genesis for this suite is
// necessarily the test's own unheadered NATS call (Orders' own
// `orders-create.controller.ts` starts a fresh root span there), not an
// inbound HTTP request. Both gaps (Projector, Gateway) are reported
// precisely in `progress/impl_saga_e2e_verification.md`'s Pass 3 section
// rather than routed around.
//
// Everything in this file drives the REAL, UNMODIFIED, SEPARATELY COMPILED
// `apps/orders`, `apps/fulfillment`, `apps/billing` and `apps/projector`
// services as genuine OS child processes (`spawnRealService`/
// `spawnRealProjector`, Pass 1's own Part 3), talking to each other over a
// real Kafka broker and a real NATS broker (Testcontainers), each backed by
// its OWN disposable MySQL database (Fulfillment/Billing) or the shared
// Orders database, plus a real MongoDB the Projector writes its read model
// into — the same six moving parts `docker-compose.infra.yml` +
// `docker-compose.apps.yml` stand up in dev, never an in-process
// `TestingModule` standing in for any of them. This is deliberately
// DIFFERENT from every other integration spec in this repo (per this
// feature's own brief): those prove one service's own AppModule graph
// against real infra; this proves the actually-running, multi-process
// SYSTEM.
//
// WHY THIS FILE LIVES HERE, NOT UNDER apps/orders: no single service is the
// "owner" of a whole-system proof, and `apps/gateway` is the one service in
// this repo with existing precedent for spawning ANOTHER service's real
// process (`spawn-real-projector.ts`, feature 26; `spawn-real-service.ts`
// + `spawn-real-service-smoke.integration.spec.ts`, this feature's own Pass
// 1) — see spawn-real-service.ts's own header for why that precedent
// exists (no service in this monorepo imports another service's `src/`).
// This file extends that same precedent to the full saga-relevant fleet,
// rather than inventing a new cross-app location nothing else needs.
// Nothing under `apps/orders`/`apps/fulfillment`/`apps/billing`/
// `apps/projector`/`apps/gateway`'s own production `src/` is imported here
// — every assertion is made the way an OPERATOR would: over the wire
// (NATS/Kafka) or against the database directly (raw SQL — this file's
// OWN `test-support/mysql-worker-client.ts` + `mysql-worker-script.cjs`,
// NEVER a service's own Drizzle schema module and NEVER `mysql2` declared
// as a dependency of `apps/gateway` itself — see those two files' own
// headers for why: `apps/gateway/src/no-write-database-client.spec.ts`
// (Group B's guard) makes it a hard architectural rule that Gateway can
// never resolve `mysql2`/`drizzle-orm` in any form, found live while
// building this suite when `pnpm quality` caught exactly that), because
// this is a black-box, system-level proof, not a unit of any one service.
//
// FLEET-REUSE DECISION (the brief asks this be stated explicitly): ONE
// shared fleet — 3 disposable MySQL databases (orders/fulfillment/billing),
// one Kafka broker, one auth-free NATS broker, one authenticated MongoDB —
// plus Fulfillment, Billing, Projector and (started last, once its
// responders are already up) Orders as four real spawned processes, is
// built ONCE in `beforeAll` and torn down ONCE in `afterAll`. All four
// criteria run against that same fleet, each placing its OWN order(s) (no
// test depends on state left behind by another) — reusing the fleet, never
// the data. Notifications is DELIBERATELY NOT spawned: none of the four
// criteria observes an email, and Notifications gates no order-status
// transition (`saga.md` §5: it consumes facts but emits none, owns no
// aggregate) — its absence cannot make any of these four criteria pass
// vacuously. Gateway's own HTTP surface is also not spawned; every RPC in
// this file is a raw `nats` request speaking the exact wire
// `scripts/place-order.mjs`/`scripts/pay-invoice.mjs` already prove works
// against the real bare-JSON (de)serializer pair every responder installs.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { Kafka, type Producer } from 'kafkajs';
import { connect, headers as natsHeaders, JSONCodec, type NatsConnection } from 'nats';
import type { Db } from 'mongodb';
import type { OrdersCreateReplyPayload, PaymentRegisterRequestPayload, RpcError } from '@otc/contracts';
import { getFreePort, spawnRealService, type RealServiceProcess } from './test-support/spawn-real-service';
import { spawnRealProjector, type RealProjectorProcess } from './test-support/spawn-real-projector';
import { startOpenNatsTestFixture, type OpenNatsTestFixture } from './test-support/open-nats-test-fixture';
import {
  createTopic,
  KAFKA_TEST_CLIENT_RETRY,
  startKafkaTestFixture,
  waitForConsumerGroupReady,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { MySqlWorkerClient } from './test-support/mysql-worker-client';

const MYSQL_IMAGE = 'mysql:8.4.11';

const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';
const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';
const ORDERS_FACTS_DLQ_TOPIC = `${ORDERS_FACTS_TOPIC}.dlq`;
const FULFILLMENT_FACTS_DLQ_TOPIC = `${FULFILLMENT_FACTS_TOPIC}.dlq`;
const BILLING_FACTS_DLQ_TOPIC = `${BILLING_FACTS_TOPIC}.dlq`;

// The same reference-catalogue codes/GLNs `orders-test-fixture.ts` seeds
// (proven-valid GLN check digits) — duplicated here rather than imported,
// per this file's own header ("nothing under any service's production
// src/ is imported here").
const CURRENCY = 'EUR';
const RETAILER_CODE = 'RET-0001';
const RETAILER_GLN = '5412345000013';
const COMPANY_CODE = 'COM-0001';
const COMPANY_GLN = '5412345000037';
const PRODUCT_CODE = 'PRD-0001';

const KAFKA_PRODUCER_CONFIG = { idempotent: true, maxInFlightRequests: 1 } as const;
const KAFKA_SEND_ACKS = -1;

// `order-status.ts`'s own `ORDER_STATUS_VALUES` ordering — duplicated here
// (this file's own header: nothing under any service's `src/` is
// imported). Used ONLY for the "has the saga reached AT LEAST this status
// yet" race-avoidance a real, live-speed saga needs: this suite's own run
// against the real fleet found a fresh order can advance from `placed` all
// the way to `invoiced` well inside one 300ms poll interval (the same "at
// least, not exactly" reasoning `saga-command-retry.integration.spec.ts`'s
// own `waitUntilAtLeast` comment documents) — polling for an EXACT
// intermediate status is a real, armed-and-observed flake in this fleet,
// not a hypothetical one.
const ORDER_STATUS_RANK = [
  'placed',
  'stock_reserved',
  'credit_approved',
  'confirmed',
  'despatched',
  'invoiced',
  'paid',
  'completed',
] as const;

function statusRank(status: string): number {
  if (status === 'cancelled') return -1; // never "at least" anything but itself
  const rank = (ORDER_STATUS_RANK as readonly string[]).indexOf(status);
  if (rank === -1) throw new Error(`saga-e2e-verification: unknown order status "${status}"`);
  return rank;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 300): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-e2e-verification: condition not met within ${timeoutMs}ms`);
}

/** Runs `apps/<serviceName>`'s own `db:migrate` CLI (`migrate-cli.ts`) as a real child process against `env` — the same script a developer runs by hand (`pnpm --filter @otc/<serviceName> db:migrate`), bypassing only the `dotenv -e ../../.env --` wrapper (this fixture supplies every value that CLI needs directly, never relying on the repo's own dev `.env`). Never imports the service's own migrator module — this file imports no service's `src/` (see header). */
function runMigrationsCli(serviceName: string, env: NodeJS.ProcessEnv): void {
  // This file lives directly in `apps/gateway/src/` (one level shallower
  // than `test-support/spawn-real-service.ts`'s own `appDir()`, which
  // needs THREE levels up from `src/test-support/`) — TWO levels up from
  // `src/` lands on `apps/`.
  const dir = path.resolve(__dirname, '../../', serviceName);
  const tsxBin = path.join(dir, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, ['src/infrastructure/persistence/migrate-cli.ts'], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `saga-e2e-verification: migrating apps/${serviceName} failed (exit ${result.status}, spawn error: ${String(result.error)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function natsRequestBare<T>(
  nc: NatsConnection,
  subject: string,
  payload: unknown,
  headerRecord?: Record<string, string>,
  timeoutMs = 20_000,
): Promise<T> {
  const codec = JSONCodec<T>();
  let h;
  if (headerRecord) {
    h = natsHeaders();
    for (const [key, value] of Object.entries(headerRecord)) h.set(key, value);
  }
  const reply = await nc.request(subject, JSONCodec().encode(payload), { timeout: timeoutMs, headers: h });
  return codec.decode(reply.data);
}

/** Publishes to a FIXED partition (kafkajs's per-message `partition` field), same technique `saga-dead-letter.integration.spec.ts` uses — so two messages published this way are guaranteed to share a partition and therefore Kafka's per-partition ordering. */
async function publishToFixedPartition(
  producer: Producer,
  topic: string,
  key: string,
  envelope: Record<string, unknown>,
  partition = 0,
): Promise<void> {
  await producer.send({ topic, acks: KAFKA_SEND_ACKS, messages: [{ key, value: JSON.stringify(envelope), partition }] });
}

/** `mysql-worker-client.ts`'s request/reply protocol is newline-delimited JSON — a `Date` PARAMETER crosses `JSON.stringify` on the way to the worker and arrives as an ISO-8601 STRING (`'...T...Z'`), which `mysql2` does NOT accept for a DATETIME column placeholder (only a `Date` instance or its OWN `'YYYY-MM-DD HH:MM:SS'` format) — this converts to that accepted string form explicitly, for every seed row's `created_at`/`updated_at` below. */
function mysqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function orderPlacedEnvelope(eventId: string, correlationId: string, aggregateId: string, orderReference: string) {
  return {
    eventId,
    eventType: 'order.placed.v1',
    aggregateId,
    correlationId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      orderReference,
      retailerCode: RETAILER_CODE,
      companyCode: COMPANY_CODE,
      buyerGln: RETAILER_GLN,
      supplierGln: COMPANY_GLN,
      currency: CURRENCY,
      orderDate: new Date().toISOString(),
      lines: [{ productCode: PRODUCT_CODE, description: 'Widget', quantity: 1, unitPrice: 1_000, lineDiscount: 0 }],
      initialAmount: 1_000,
      initialDiscount: 0,
      totalAmount: 1_000,
    },
  };
}

interface OrderRow {
  id: string;
  order_reference: string;
  status: string;
  cancellation_reason: string | null;
  total_amount: number;
}

interface InvoiceRow {
  id: string;
  invoice_reference: string;
  total_amount: number;
  currency_code: string;
  status: string;
}

/** The subset of `order_timeline`'s own shape this file reads (`order-timeline.document.ts`, not imported — see this file's own header) — `_id` is the order id, a plain string, never an `ObjectId`. */
interface TimelineDoc {
  _id: string;
  events?: { eventType?: string }[];
}

const ORDER_TIMELINE_COLLECTION = 'order_timeline';

/**
 * Criterion 5 (R56) — parses `saga-command-dispatcher: command sent` JSON
 * lines (the ONLY info-level, traceId-bearing structured log line this
 * repo's saga machinery emits on a successful order — see this file's own
 * header comment for the exhaustive audit backing that claim) out of
 * Orders' own captured stdout+stderr, filtered to ONE order's own
 * `correlationId`. Returns one entry per distinct command dispatch
 * observed, in logged order.
 */
function ordersCommandSentLogEntries(output: string, orderId: string): { command: string; traceId: string | undefined }[] {
  const entries: { command: string; traceId: string | undefined }[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.message === 'saga-command-dispatcher: command sent' && parsed.correlationId === orderId) {
      entries.push({
        command: String(parsed.command),
        traceId: typeof parsed.traceId === 'string' ? parsed.traceId : undefined,
      });
    }
  }
  return entries;
}

/**
 * Criterion 5 (R56) — extracts the 32-hex trace-id segment out of a W3C
 * `traceparent` string (`00-<trace-id>-<span-id>-<flags>`), the exact
 * format `activeTraceParent()` writes verbatim into `outbox.trace_parent`
 * in Fulfillment/Billing (`trace-context.ts` in each service, R57). `null`
 * in (never propagated, or the arming probe below), `null` out.
 */
function traceIdFromTraceParent(traceParent: string | null): string | null {
  if (!traceParent) return null;
  const parts = traceParent.split('-');
  return parts.length === 4 ? parts[1] : null;
}

interface OutboxRow {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id: string;
  // The worker script's reply crosses a `JSON.stringify`/`JSON.parse`
  // boundary (`mysql-worker-client.ts`) — `mysql2` itself returns a JS
  // `Date` for this DATETIME column, but `JSON.stringify` always renders a
  // `Date` via its own `toJSON()` (ISO-8601), so by the time it reaches
  // this file it is already a plain string, never a `Date` instance.
  occurred_at: string;
  payload: unknown;
}

describe('saga_e2e_verification — happy path, .99 compensation, redelivery, poison→DLQ, and R56 composed-stack trace (real spawned Orders/Fulfillment/Billing/Projector, Testcontainers infra)', () => {
  let ordersContainer: StartedMySqlContainer;
  let fulfillmentContainer: StartedMySqlContainer;
  let billingContainer: StartedMySqlContainer;
  let kafkaFixture: KafkaTestFixture;
  let natsFixture: OpenNatsTestFixture;
  let mongoFixture: StandaloneMongoTestFixture;

  let ordersDb: MySqlWorkerClient;
  let fulfillmentDb: MySqlWorkerClient;
  let billingDb: MySqlWorkerClient;
  let mongoDb: Db;

  let rpcNats: NatsConnection;
  let rawKafka: Kafka;
  let rawProducer: Producer;

  let fulfillmentProcess: RealServiceProcess;
  let billingProcess: RealServiceProcess;
  let projectorProcess: RealProjectorProcess;
  let ordersProcess: RealServiceProcess;

  const MONGO_DB_NAME = `otc_saga_e2e_readmodel_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // ── 1. Every disposable infra fixture, in parallel ──────────────────
    [ordersContainer, fulfillmentContainer, billingContainer, kafkaFixture, natsFixture, mongoFixture] =
      await Promise.all([
        new MySqlContainer(MYSQL_IMAGE)
          .withDatabase('otc_orders')
          .withUsername('otc_app')
          .withUserPassword('otc_app_test_password')
          .withRootPassword('otc_root_test_password')
          .start(),
        new MySqlContainer(MYSQL_IMAGE)
          .withDatabase('otc_fulfillment')
          .withUsername('otc_app')
          .withUserPassword('otc_app_test_password')
          .withRootPassword('otc_root_test_password')
          .start(),
        new MySqlContainer(MYSQL_IMAGE)
          .withDatabase('otc_billing')
          .withUsername('otc_app')
          .withUserPassword('otc_app_test_password')
          .withRootPassword('otc_root_test_password')
          .start(),
        startKafkaTestFixture(),
        startOpenNatsTestFixture(),
        startAuthenticatedMongoTestFixture(),
      ]);

    // ── 2. Migrations — the REAL `db:migrate` CLI, one child process per
    //    service (never a Drizzle import) ────────────────────────────────
    runMigrationsCli('orders', {
      ORDERS_DB_HOST: ordersContainer.getHost(),
      MYSQL_HOST_PORT: String(ordersContainer.getPort()),
      MYSQL_USER: ordersContainer.getUsername(),
      MYSQL_PASSWORD: ordersContainer.getUserPassword(),
      MYSQL_DB_ORDERS: ordersContainer.getDatabase(),
    });
    runMigrationsCli('fulfillment', {
      FULFILLMENT_DB_HOST: fulfillmentContainer.getHost(),
      MYSQL_HOST_PORT: String(fulfillmentContainer.getPort()),
      MYSQL_USER: fulfillmentContainer.getUsername(),
      MYSQL_PASSWORD: fulfillmentContainer.getUserPassword(),
      MYSQL_DB_FULFILLMENT: fulfillmentContainer.getDatabase(),
    });
    runMigrationsCli('billing', {
      BILLING_DB_HOST: billingContainer.getHost(),
      MYSQL_HOST_PORT: String(billingContainer.getPort()),
      MYSQL_USER: billingContainer.getUsername(),
      MYSQL_PASSWORD: billingContainer.getUserPassword(),
      MYSQL_DB_BILLING: billingContainer.getDatabase(),
    });

    // ── 3. Kafka topics — every fact topic + its `.dlq` companion, up
    //    front (auto-creation is disabled on this fixture); sequential —
    //    concurrent `admin.createTopics` against a single-node KRaft
    //    broker has been observed to race (kafka-test-fixture.ts's own
    //    sibling comment in every other harness in this repo) ───────────
    for (const topic of [
      ORDERS_FACTS_TOPIC,
      FULFILLMENT_FACTS_TOPIC,
      BILLING_FACTS_TOPIC,
      ORDERS_FACTS_DLQ_TOPIC,
      FULFILLMENT_FACTS_DLQ_TOPIC,
      BILLING_FACTS_DLQ_TOPIC,
    ]) {
      await createTopic(kafkaFixture.brokers, topic);
    }

    // ── 4. Probe DB clients (`MySqlWorkerClient` — see this file's own
    //    header for why never a bare `mysql2` import here) + reference-data
    //    seeding (raw SQL — no service's own schema module is imported) ──
    [ordersDb, fulfillmentDb, billingDb] = await Promise.all([
      MySqlWorkerClient.connect('orders', {
        host: ordersContainer.getHost(),
        port: ordersContainer.getPort(),
        user: ordersContainer.getUsername(),
        password: ordersContainer.getUserPassword(),
        database: ordersContainer.getDatabase(),
      }),
      MySqlWorkerClient.connect('fulfillment', {
        host: fulfillmentContainer.getHost(),
        port: fulfillmentContainer.getPort(),
        user: fulfillmentContainer.getUsername(),
        password: fulfillmentContainer.getUserPassword(),
        database: fulfillmentContainer.getDatabase(),
      }),
      MySqlWorkerClient.connect('billing', {
        host: billingContainer.getHost(),
        port: billingContainer.getPort(),
        user: billingContainer.getUsername(),
        password: billingContainer.getUserPassword(),
        database: billingContainer.getDatabase(),
      }),
    ]);

    const now = mysqlDateTime(new Date(Math.floor(Date.now() / 1000) * 1000));
    const currencyId = randomUUID();
    await ordersDb.execute(
      'INSERT INTO currencies (id, code, iso_number, symbol, decimal_points, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [currencyId, CURRENCY, '978', '€', 2, now, now],
    );
    await ordersDb.execute(
      'INSERT INTO retailers (id, code, name, country, vat, gln, currency_id, disabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      [randomUUID(), RETAILER_CODE, 'Acme Retail', 'ES', 'ESB12345678', RETAILER_GLN, currencyId, now, now],
    );
    await ordersDb.execute(
      'INSERT INTO companies (id, code, name, country, vat, gln, currency_id, disabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      [randomUUID(), COMPANY_CODE, 'Acme Supply Co', 'ES', 'ESA87654321', COMPANY_GLN, currencyId, now, now],
    );
    await ordersDb.execute(
      'INSERT INTO products (id, code, ean, name, description, price, currency_id, disabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      [randomUUID(), PRODUCT_CODE, '5901234123457', 'Widget', 'A widget for saga_e2e_verification', 1_000, currencyId, now, now],
    );

    await fulfillmentDb.execute(
      'INSERT INTO stock (id, company_code, product_code, units, reserved_units, low_stock_threshold, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 2, ?, ?)',
      [randomUUID(), COMPANY_CODE, PRODUCT_CODE, 1_000_000, now, now],
    );

    await billingDb.execute(
      'INSERT INTO credits (id, code, retailer_code, company_code, credit_limit, currency_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      // `CR-######` — exactly six digits (domain-model.md §2.3's business
      // reference pattern; `billing-integration-harness.ts`'s own
      // `seedCreditLine` default is the same shape). A non-conforming code
      // (this file's own first draft used `CR-E2E001`) is not silently
      // accepted — it is REJECTED at the credit-hold responder with
      // `DOMAIN_ERROR: "..." is not a valid CR-###### business reference`,
      // which the saga's dispatcher then retries to exhaustion and parks
      // (visible in `dumpOrderDiagnostics`'s own `last_error` — this is how
      // the bug was actually found and fixed while building this suite).
      [randomUUID(), 'CR-000001', RETAILER_CODE, COMPANY_CODE, 1_000_000_000, CURRENCY, now, now],
    );

    // ── 5. Spawn the real fleet — Fulfillment/Billing/Projector FIRST
    //    (concurrently), Orders LAST, so its saga's outbound RPC calls
    //    never race a responder that has not booted yet ─────────────────
    const [fulfillmentPort, billingPort, ordersPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);

    [fulfillmentProcess, billingProcess, projectorProcess] = await Promise.all([
      spawnRealService({
        serviceName: 'fulfillment',
        env: {
          FULFILLMENT_PORT: String(fulfillmentPort),
          FULFILLMENT_DB_HOST: fulfillmentContainer.getHost(),
          MYSQL_HOST_PORT: String(fulfillmentContainer.getPort()),
          MYSQL_USER: fulfillmentContainer.getUsername(),
          MYSQL_PASSWORD: fulfillmentContainer.getUserPassword(),
          MYSQL_DB_FULFILLMENT: fulfillmentContainer.getDatabase(),
          KAFKA_BROKERS: kafkaFixture.brokers.join(','),
          NATS_URL: natsFixture.url,
          OUTBOX_RELAY_ENABLED: 'true',
          OUTBOX_POLL_INTERVAL_MS: '100',
        },
        readiness: { type: 'log', pattern: /\[fulfillment\] listening on port/, timeoutMs: 90_000 },
      }),
      spawnRealService({
        serviceName: 'billing',
        env: {
          BILLING_PORT: String(billingPort),
          BILLING_DB_HOST: billingContainer.getHost(),
          MYSQL_HOST_PORT: String(billingContainer.getPort()),
          MYSQL_USER: billingContainer.getUsername(),
          MYSQL_PASSWORD: billingContainer.getUserPassword(),
          MYSQL_DB_BILLING: billingContainer.getDatabase(),
          KAFKA_BROKERS: kafkaFixture.brokers.join(','),
          NATS_URL: natsFixture.url,
          OUTBOX_RELAY_ENABLED: 'true',
          OUTBOX_POLL_INTERVAL_MS: '100',
        },
        readiness: { type: 'log', pattern: /\[billing\] listening on port/, timeoutMs: 90_000 },
      }),
      spawnRealProjector({
        mongoHost: mongoFixture.host,
        mongoPort: mongoFixture.port,
        mongoDatabase: MONGO_DB_NAME,
        kafkaBrokers: kafkaFixture.brokers,
        natsUrl: natsFixture.url,
      }),
    ]);

    ordersProcess = await spawnRealService({
      serviceName: 'orders',
      env: {
        ORDERS_PORT: String(ordersPort),
        ORDERS_DB_HOST: ordersContainer.getHost(),
        MYSQL_HOST_PORT: String(ordersContainer.getPort()),
        MYSQL_USER: ordersContainer.getUsername(),
        MYSQL_PASSWORD: ordersContainer.getUserPassword(),
        MYSQL_DB_ORDERS: ordersContainer.getDatabase(),
        KAFKA_BROKERS: kafkaFixture.brokers.join(','),
        NATS_URL: natsFixture.url,
        OUTBOX_RELAY_ENABLED: 'true',
        OUTBOX_POLL_INTERVAL_MS: '100',
        // Fast, deterministic retry-then-DLQ for criterion 4 — env-configurable
        // (`fact-retry-dispatcher.ts`'s `loadFactRetryPolicy`), same override
        // every per-service dead-letter integration spec in this repo uses.
        FACT_RETRY_MAX_ATTEMPTS: '3',
        FACT_RETRY_BACKOFF_MS: '50',
      },
      readiness: { type: 'log', pattern: /\[orders\] listening on port/, timeoutMs: 90_000 },
    });
    // Orders' saga Kafka consumer group joins ASYNCHRONOUSLY after the
    // "listening" log line (ServerKafka's `consumer.run()` is called, not
    // awaited to `Stable` — same finding `saga-integration-harness.ts`
    // documents). Block here, once, so every criterion below starts from a
    // ready consumer group rather than eating this cost inside its own
    // waitFor budget.
    await waitForConsumerGroupReady([...kafkaFixture.brokers], 'orders.saga-server', 90_000, 300);

    // ── 6. Shared test-owned clients — one NATS RPC connection, one raw
    //    Kafka client/producer, one Mongo `Db` handle ────────────────────
    rpcNats = await connect({ servers: [natsFixture.servers] });
    rawKafka = new Kafka({ clientId: 'otc-saga-e2e-test', brokers: [...kafkaFixture.brokers], retry: KAFKA_TEST_CLIENT_RETRY });
    rawProducer = rawKafka.producer(KAFKA_PRODUCER_CONFIG);
    await rawProducer.connect();
    mongoDb = mongoFixture.client.db(MONGO_DB_NAME);
  }, 600_000);

  afterAll(async () => {
    await rawProducer?.disconnect();
    await rpcNats?.close();
    await ordersProcess?.stop();
    await billingProcess?.stop();
    await fulfillmentProcess?.stop();
    await projectorProcess?.stop();
    await ordersDb?.close();
    await fulfillmentDb?.close();
    await billingDb?.close();
    await ordersContainer?.stop();
    await fulfillmentContainer?.stop();
    await billingContainer?.stop();
    await kafkaFixture?.teardown();
    await natsFixture?.teardown();
    await mongoFixture?.teardown();
  }, 180_000);

  async function placeOrder(unitPrice: number, quantity = 1): Promise<OrdersCreateReplyPayload> {
    const reply = await natsRequestBare<OrdersCreateReplyPayload | RpcError>(rpcNats, 'orders.create', {
      retailerCode: RETAILER_CODE,
      companyCode: COMPANY_CODE,
      currency: CURRENCY,
      lines: [{ productCode: PRODUCT_CODE, quantity, unitPrice }],
    });
    if (!('orderId' in reply)) {
      throw new Error(`saga-e2e-verification: orders.create was refused: ${JSON.stringify(reply)}`);
    }
    return reply;
  }

  async function orderRow(orderId: string): Promise<OrderRow | undefined> {
    const rows = await ordersDb.query<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
    return rows[0];
  }

  // TEMPORARY diagnostic (Pass 2, debugging criteria 1/2's initial timeout)
  // — dumps the saga's own durable state for one order on a waitFor
  // failure, so the failure message names WHERE the saga stalled instead
  // of only "did not reach status X in time".
  async function dumpOrderDiagnostics(orderId: string): Promise<string> {
    const row = await orderRow(orderId);
    const commands = await ordersDb.query('SELECT command, status, attempts, last_error FROM saga_commands WHERE order_id = ?', [orderId]);
    const ignored = await ordersDb.query(
      'SELECT event_type, marker, observed_status, expected_status FROM saga_ignored_facts WHERE correlation_id = ?',
      [orderId],
    );
    const outboxRows = await ordersDb.query('SELECT event_type, published_at FROM outbox WHERE aggregate_id = ?', [orderId]);
    return JSON.stringify({ row, commands, ignored, outboxRows }, null, 2);
  }

  it(
    'criterion 1 — happy path: a real order reaches status "completed"',
    async () => {
      const placed = await placeOrder(1_500, 2); // 3000 minor units — not a .99 total
      expect(placed.totalAmount).toBe(3_000);

      try {
        await waitFor(async () => (await orderRow(placed.orderId))?.status === 'invoiced', 60_000);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${await dumpOrderDiagnostics(placed.orderId)}`, { cause: error });
      }

      const invoices = await billingDb.query<InvoiceRow>(
        'SELECT * FROM invoices WHERE order_reference = ? AND status = ?',
        [placed.orderReference, 'issued'],
      );
      const invoice = invoices[0];
      expect(invoice).toBeDefined();
      expect(invoice.total_amount).toBe(3_000);

      const paymentPayload: PaymentRegisterRequestPayload = {
        invoiceReference: invoice.invoice_reference,
        paymentReference: `PAY-E2E-${randomUUID().slice(0, 8)}`,
        amount: { amount: invoice.total_amount, currency: invoice.currency_code },
        valueDate: new Date().toISOString(),
        source: 'test',
      };
      const paymentReply = await natsRequestBare(rpcNats, 'billing.payment.register', paymentPayload, {
        'x-correlation-id': placed.orderId,
        'x-request-id': randomUUID(),
      });
      expect((paymentReply as { outcome?: string }).outcome).toBe('accepted');

      await waitFor(async () => (await orderRow(placed.orderId))?.status === 'completed', 60_000);
    },
    120_000,
  );

  it(
    'criterion 2 — a .99 order compensates visibly: cancelled, credit_rejected (billing\'s own reason: simulated_cents_rule), and the real Fulfillment reservation genuinely released',
    async () => {
      // R42 (billing_credit): amountMinorUnits % 100 === 99 refuses
      // UNCONDITIONALLY. 1099 minor units, qty 1.
      const placed = await placeOrder(1_099, 1);
      expect(placed.totalAmount % 100).toBe(99);

      try {
        await waitFor(async () => {
          const row = await orderRow(placed.orderId);
          return row?.status === 'cancelled';
        }, 60_000);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${await dumpOrderDiagnostics(placed.orderId)}`, { cause: error });
      }

      const cancelled = await orderRow(placed.orderId);
      // The DOMAIN-LEVEL cancellation reason (order-cancellation-reason.ts's
      // closed set: 'stock_rejected' | 'credit_rejected' | 'operator_cancelled')
      // — NOT the string 'simulated_cents_rule', which is Billing's OWN,
      // more granular internal reason for REFUSING the credit hold
      // (simulator-credit-decision.ts) and never reaches Orders' own
      // `cancellationReason` column (mapReason in saga-steps.ts narrows
      // `stock.released.v1`'s payload.reason to exactly this 3-value set).
      // Both are asserted below: the domain-correct final state on Orders'
      // own row, AND — precisely, from Billing's own outbox, not inferred —
      // that the SPECIFIC trigger really was the .99 rule and not some
      // other refusal.
      expect(cancelled?.cancellation_reason).toBe('credit_rejected');

      const billingOutboxRows = await billingDb.query<OutboxRow>(
        'SELECT * FROM outbox WHERE correlation_id = ? AND event_type = ?',
        [placed.orderId, 'credit.rejected.v1'],
      );
      expect(billingOutboxRows).toHaveLength(1);
      const creditRejectedPayload = billingOutboxRows[0].payload as { reason?: string };
      expect(creditRejectedPayload.reason).toBe('simulated_cents_rule');

      // The stock genuinely released — not merely inferred from the
      // order's own status field (per the brief's own instruction) — the
      // real Fulfillment MySQL reservation for this order is 'released'.
      interface ReservationRow {
        status: string;
        units: number;
      }
      const reservationRows = await fulfillmentDb.query<ReservationRow>(
        'SELECT * FROM reservations WHERE order_reference = ?',
        [placed.orderReference],
      );
      expect(reservationRows).toHaveLength(1);
      expect(reservationRows[0].status).toBe('released');
    },
    120_000,
  );

  it(
    'criterion 3 — redelivering an already-processed fact causes no duplicate side effect anywhere in the system (Orders\' saga_commands, Fulfillment\'s reservations, the Mongo read model)',
    async () => {
      const placed = await placeOrder(1_500, 1); // 1500 — not a .99 total
      try {
        await waitFor(async () => {
          const row = await orderRow(placed.orderId);
          return row !== undefined && statusRank(row.status) >= statusRank('stock_reserved');
        }, 60_000);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${await dumpOrderDiagnostics(placed.orderId)}`, { cause: error });
      }

      // The REAL envelope Orders' own OutboxRelay already published — read
      // back, byte-for-byte, from Orders' own outbox row. Never fabricated:
      // this is what makes it "a real fact already produced by a real saga
      // run" per the brief's own instruction.
      const originalRows = await ordersDb.query<OutboxRow>(
        'SELECT * FROM outbox WHERE aggregate_id = ? AND event_type = ?',
        [placed.orderId, 'order.placed.v1'],
      );
      expect(originalRows).toHaveLength(1);
      const original = originalRows[0];
      const originalEnvelope = {
        eventId: original.event_id,
        eventType: original.event_type,
        aggregateId: original.aggregate_id,
        correlationId: original.correlation_id,
        causationId: original.causation_id,
        occurredAt: original.occurred_at,
        payload: original.payload,
      };

      // BEFORE counts — exact row counts, not merely "no error observed".
      interface CountRow {
        n: number;
      }
      const [sagaCommandsBefore] = await ordersDb.query<CountRow>(
        'SELECT COUNT(*) AS n FROM saga_commands WHERE order_id = ? AND command = ?',
        [placed.orderId, 'stock.reserve'],
      );
      const [reservationsBefore] = await fulfillmentDb.query<CountRow>(
        'SELECT COUNT(*) AS n FROM reservations WHERE order_reference = ?',
        [placed.orderReference],
      );
      // The Projector runs its OWN, independent Kafka consumer group — it
      // can genuinely lag Orders' own saga consumer by a beat, so wait for
      // its document to exist (never a bare read-then-assert) before
      // taking the "before" snapshot.
      await waitFor(async () => (await mongoDb.collection<TimelineDoc>(ORDER_TIMELINE_COLLECTION).findOne({ _id: placed.orderId })) !== null, 60_000);
      const documentBefore = await mongoDb.collection<TimelineDoc>(ORDER_TIMELINE_COLLECTION).findOne({ _id: placed.orderId });
      const eventsBefore = ((documentBefore?.events as unknown[]) ?? []).filter(
        (e) => (e as { eventType?: string }).eventType === 'order.placed.v1',
      ).length;
      expect(eventsBefore).toBeGreaterThanOrEqual(1);

      // Redeliver the SAME fact (identical eventId — the idempotent-consumer's
      // exact dedup key) to a FIXED partition, then a well-formed but
      // UNKNOWN-order marker fact to the SAME partition right behind it —
      // two independent, positive "the consumer got past the redelivery"
      // proofs (Orders' own saga_ignored_facts ledger, and the Projector's
      // own Mongo write for the marker's synthetic order id), never a bare
      // sleep.
      await publishToFixedPartition(rawProducer, ORDERS_FACTS_TOPIC, originalEnvelope.correlationId, originalEnvelope, 0);

      const markerEventId = randomUUID();
      const markerOrderId = randomUUID();
      const markerEnvelope = orderPlacedEnvelope(markerEventId, markerOrderId, markerOrderId, 'ORD-E2E-MARKER-3');
      await publishToFixedPartition(rawProducer, ORDERS_FACTS_TOPIC, markerOrderId, markerEnvelope, 0);

      interface IgnoredFactRow {
        marker: string;
      }
      await waitFor(async () => {
        const rows = await ordersDb.query<IgnoredFactRow>(
          'SELECT * FROM saga_ignored_facts WHERE event_id = ? AND marker = ?',
          [markerEventId, 'unknown_order'],
        );
        return rows.length === 1;
      }, 60_000);
      await waitFor(async () => (await mongoDb.collection<TimelineDoc>(ORDER_TIMELINE_COLLECTION).findOne({ _id: markerOrderId })) !== null, 60_000);

      // AFTER — exact counts unchanged; no duplicate side effect.
      const [sagaCommandsAfter] = await ordersDb.query<CountRow>(
        'SELECT COUNT(*) AS n FROM saga_commands WHERE order_id = ? AND command = ?',
        [placed.orderId, 'stock.reserve'],
      );
      const [reservationsAfter] = await fulfillmentDb.query<CountRow>(
        'SELECT COUNT(*) AS n FROM reservations WHERE order_reference = ?',
        [placed.orderReference],
      );
      expect(sagaCommandsAfter.n).toBe(sagaCommandsBefore.n);
      expect(sagaCommandsBefore.n).toBe(1);
      expect(reservationsAfter.n).toBe(reservationsBefore.n);
      expect(reservationsBefore.n).toBe(1);

      const documentAfter = await mongoDb.collection<TimelineDoc>(ORDER_TIMELINE_COLLECTION).findOne({ _id: placed.orderId });
      const eventsAfter = ((documentAfter?.events as unknown[]) ?? []).filter(
        (e) => (e as { eventType?: string }).eventType === 'order.placed.v1',
      ).length;
      expect(eventsAfter).toBe(eventsBefore);
      expect(eventsAfter).toBe(1);
    },
    240_000,
  );

  it(
    'criterion 4 — a poisoned message (non-UUID correlationId, the live Phase-12 shape) reaches the DLQ, the offset commits, and a distinct valid fact right behind it on the SAME partition still processes',
    async () => {
      const dlqMessages: Array<{ headers: Record<string, string>; value: { eventId: string; correlationId: string } }> = [];
      const dlqConsumer = rawKafka.consumer({ groupId: `dlq-probe-${randomUUID()}`, sessionTimeout: 30_000 });
      await dlqConsumer.connect();
      await dlqConsumer.subscribe({ topic: ORDERS_FACTS_DLQ_TOPIC, fromBeginning: true });
      await dlqConsumer.run({
        eachMessage: async ({ message }) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(message.headers ?? {})) headers[k] = v ? v.toString('utf8') : '';
          dlqMessages.push({ headers, value: JSON.parse(message.value!.toString('utf8')) });
        },
      });

      try {
        const poisonEventId = randomUUID();
        const poisonEnvelope = orderPlacedEnvelope(poisonEventId, 'not-a-uuid-correlation-id', randomUUID(), 'ORD-E2E-POISON');
        await publishToFixedPartition(rawProducer, ORDERS_FACTS_TOPIC, poisonEnvelope.correlationId, poisonEnvelope, 0);

        await waitFor(async () => dlqMessages.some((m) => m.value.eventId === poisonEventId), 60_000);
        const dlq = dlqMessages.find((m) => m.value.eventId === poisonEventId)!;
        expect(dlq.headers['x-failed-consumer']).toBe('orders.saga');
        expect(dlq.headers['x-original-topic']).toBe(ORDERS_FACTS_TOPIC);
        expect(dlq.headers['x-error']).toBeTruthy();
        expect(dlq.value.correlationId).toBe('not-a-uuid-correlation-id');

        // The property that actually failed live (progress/current.md, the
        // Phase-12 incident): a distinct, WELL-FORMED fact right behind the
        // poison message on the SAME partition is still processed — the
        // offset committed, the partition was not blocked forever.
        const validEventId = randomUUID();
        const validOrderId = randomUUID();
        const validEnvelope = orderPlacedEnvelope(validEventId, validOrderId, validOrderId, 'ORD-E2E-AFTER-POISON');
        await publishToFixedPartition(rawProducer, ORDERS_FACTS_TOPIC, validOrderId, validEnvelope, 0);

        interface IgnoredFactRow {
          marker: string;
        }
        await waitFor(async () => {
          const rows = await ordersDb.query<IgnoredFactRow>(
            'SELECT * FROM saga_ignored_facts WHERE event_id = ? AND marker = ?',
            [validEventId, 'unknown_order'],
          );
          return rows.length === 1;
        }, 60_000);
      } finally {
        await dlqConsumer.disconnect();
      }
    },
    120_000,
  );

  it(
    'criterion 5 (R56) — one trace identifier spans a real order across the composed stack: every Orders saga-command dispatch AND the real trace_parent Fulfillment and Billing each independently recorded on their OWN write-model transaction, all identical, across three real separate processes',
    async () => {
      const placed = await placeOrder(1_200, 1); // 1200 — not a .99 total, no compensation branch
      try {
        await waitFor(async () => (await orderRow(placed.orderId))?.status === 'invoiced', 60_000);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${await dumpOrderDiagnostics(placed.orderId)}`, { cause: error });
      }

      // ── 1. Orders' OWN structured stdout — every `command sent` line for
      //    THIS order (real, separate process #1). ──────────────────────
      const ordersEntries = ordersCommandSentLogEntries(ordersProcess.output(), placed.orderId);
      // R56's own wording is "every command" — require at least two
      // DISTINCT commands observed (a real happy-path order to 'invoiced'
      // dispatches four: stock.reserve, credit.hold, despatch.create,
      // invoice.issue), so this is genuinely a multi-command trace, not one
      // coincidental line.
      const distinctCommands = new Set(ordersEntries.map((entry) => entry.command));
      expect(distinctCommands.size).toBeGreaterThanOrEqual(2);
      const ordersTraceIds = ordersEntries.map((entry) => entry.traceId);
      for (const traceId of ordersTraceIds) {
        expect(
          typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId),
          `saga-command-dispatcher "command sent" line missing a traceId — commands seen: ${[...distinctCommands].join(', ')}, got ${JSON.stringify(traceId)}`,
        ).toBe(true);
      }

      // ── 2. Fulfillment's OWN durable record (real, separate process #2)
      //    — the real `trace_parent` its OutboxRecorder wrote at the
      //    moment IT performed stock.reserved.v1's write-model transaction
      //    for this order. ──────────────────────────────────────────────
      interface TraceRow {
        trace_parent: string | null;
      }
      const [fulfillmentRow] = await fulfillmentDb.query<TraceRow>(
        'SELECT trace_parent FROM outbox WHERE correlation_id = ? AND event_type = ?',
        [placed.orderId, 'stock.reserved.v1'],
      );
      expect(fulfillmentRow, 'expected a stock.reserved.v1 outbox row for this order in Fulfillment').toBeDefined();
      const fulfillmentTraceId = traceIdFromTraceParent(fulfillmentRow.trace_parent);

      // ── 3. Billing's OWN durable record (real, separate process #3) —
      //    TWO independent write-model transactions in that SAME process:
      //    credit.approved.v1, then invoice.issued.v1. ───────────────────
      const [creditRow] = await billingDb.query<TraceRow>(
        'SELECT trace_parent FROM outbox WHERE correlation_id = ? AND event_type = ?',
        [placed.orderId, 'credit.approved.v1'],
      );
      const [invoiceRow] = await billingDb.query<TraceRow>(
        'SELECT trace_parent FROM outbox WHERE correlation_id = ? AND event_type = ?',
        [placed.orderId, 'invoice.issued.v1'],
      );
      expect(creditRow, 'expected a credit.approved.v1 outbox row for this order in Billing').toBeDefined();
      expect(invoiceRow, 'expected an invoice.issued.v1 outbox row for this order in Billing').toBeDefined();
      const billingCreditTraceId = traceIdFromTraceParent(creditRow.trace_parent);
      const billingInvoiceTraceId = traceIdFromTraceParent(invoiceRow.trace_parent);

      // ── 4. ONE trace identifier — genuinely observed identical, not
      //    merely each individually present — across THREE real, separate
      //    processes, for this ONE order. ────────────────────────────────
      const namedTraceIds: Record<string, string | null | undefined> = {
        'orders (stock.reserve dispatch)': ordersTraceIds[0],
        'fulfillment (stock.reserved.v1 outbox)': fulfillmentTraceId,
        'billing (credit.approved.v1 outbox)': billingCreditTraceId,
        'billing (invoice.issued.v1 outbox)': billingInvoiceTraceId,
      };
      for (const [label, traceId] of Object.entries(namedTraceIds)) {
        expect(
          typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId),
          `${label}: expected a real 32-hex traceId, got ${JSON.stringify(traceId)}`,
        ).toBe(true);
      }
      const distinctTraceIds = new Set([...ordersTraceIds, fulfillmentTraceId, billingCreditTraceId, billingInvoiceTraceId]);
      expect(distinctTraceIds, `expected exactly ONE trace id across the composed stack, saw: ${JSON.stringify([...distinctTraceIds])}`).toEqual(
        new Set([ordersTraceIds[0]]),
      );
    },
    120_000,
  );
});
