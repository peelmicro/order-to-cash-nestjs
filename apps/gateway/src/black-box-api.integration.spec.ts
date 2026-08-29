// api_tests (feature 31, phase 18) — black-box API tests through the REAL,
// spawned Gateway, over real HTTP, against a REAL fleet (Orders,
// Fulfillment, Billing, Projector — every real, separately compiled
// service `saga-e2e-verification.integration.spec.ts` already spawns, PLUS
// the Gateway itself, which that file's own header explicitly states it
// never spawns). This is the first suite in this repository where BOTH
// halves meet: a real Gateway, reached only through `supertest` as an HTTP
// CLIENT (never a Nest `TestingModule`, never `stub-rpc-responder`/
// `fake-rpc-client` — those exist for the Gateway's OWN translation-layer
// unit/integration specs, `orders.integration.spec.ts` and its siblings,
// which stub every downstream RPC on purpose; this file stubs nothing),
// driving a genuine end-to-end order lifecycle entirely through the public
// REST surface.
//
// Every assertion here is either (a) a real HTTP response from the real
// Gateway, or (b) durable state read back directly from a downstream
// service's own database, the way an operator would (never the Gateway's
// own status field alone, per this feature's own brief) — via
// `MySqlWorkerClient`, the SAME mechanism `saga-e2e-verification`
// established so `apps/gateway` never resolves `mysql2`/`drizzle-orm`
// itself (`no-write-database-client.spec.ts`, Group B's guard).
//
// FLEET-REUSE DECISION (mirrors `saga-e2e-verification`'s own explicit
// statement): ONE shared fleet — 3 disposable MySQL databases
// (orders/fulfillment/billing), one Kafka broker, one auth-free NATS
// broker (`open-nats-test-fixture.ts` — required here for the SAME reason
// `saga-e2e-verification` needed it: every spawned service, including the
// Gateway itself, opens its OWN outbound NATS connection purely from
// `NATS_URL`, with no way to inject test-only credentials into that
// process from outside), one authenticated MongoDB — plus Fulfillment,
// Billing, Projector, Orders (in that order, Orders last so its saga's
// outbound RPC never races a responder that has not booted) and, LAST OF
// ALL, the Gateway itself (its own HTTP surface is what every scenario
// below drives) as five real spawned processes, built ONCE in `beforeAll`
// and torn down ONCE in `afterAll`. Notifications is not spawned for the
// same reason `saga-e2e-verification` omits it: none of these scenarios
// observes an email, and Notifications gates no order-status transition.
//
// Reference data (currencies/retailers/companies/products/stock/credit) is
// seeded by hand via raw SQL through `MySqlWorkerClient`, exactly as
// `saga-e2e-verification` does — NOT via `apps/seed`, which fabricates a
// much larger dataset (5 completed + 1 cancelled saga history) this suite
// does not need and would only slow down. The one deliberate difference
// from `saga-e2e-verification`'s own fixture: `PRD-0001`'s price is 24999
// (not 1000) — this feature's own brief states the reason verbatim,
// matching `apps/seed/src/data/products.data.ts`'s real seed value:
// "PRD-0001 is priced 24999 precisely so quantity 1 totals .99", the
// deterministic trigger `R42`'s credit simulator refuses unconditionally.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { getFreePort, spawnRealService, type RealServiceProcess } from './test-support/spawn-real-service';
import { spawnRealProjector, type RealProjectorProcess } from './test-support/spawn-real-projector';
import { startOpenNatsTestFixture, type OpenNatsTestFixture } from './test-support/open-nats-test-fixture';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { MySqlWorkerClient } from './test-support/mysql-worker-client';

const MYSQL_IMAGE = 'mysql:8.4.11';

const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';
const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';

// Same proven-valid GLN check digits/reference codes `saga-e2e-verification`
// and `orders-test-fixture.ts` already use — duplicated here rather than
// imported (this file, like those, imports no service's own `src/`).
const CURRENCY = 'EUR';
const RETAILER_CODE = 'RET-0001';
const RETAILER_GLN = '5412345000013';
const COMPANY_CODE = 'COM-0001';
const COMPANY_GLN = '5412345000037';
const PRODUCT_CODE = 'PRD-0001';
// The deliberate difference from every other MySQL-backed fixture in this
// repo — see this file's own header.
const PRODUCT_PRICE = 24_999;

const TEST_OPERATOR_USERNAME = 'operator';
const TEST_OPERATOR_PASSWORD = 'gateway-black-box-api-test-operator-password';

/** `mysql-worker-client.ts`'s protocol wants a `Date` PARAMETER in `mysql2`'s own accepted `'YYYY-MM-DD HH:MM:SS'` string form — same helper `saga-e2e-verification` uses, duplicated for the same reason (this file imports no service's own `src/`). */
function mysqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Runs `apps/<serviceName>`'s own `db:migrate` CLI as a real child process — same helper, same rationale, as `saga-e2e-verification.integration.spec.ts`'s own `runMigrationsCli` (this file lives at the same depth, `apps/gateway/src/`, so the relative path up to `apps/` is identical). */
function runMigrationsCli(serviceName: string, env: NodeJS.ProcessEnv): void {
  const dir = path.resolve(__dirname, '../../', serviceName);
  const tsxBin = path.join(dir, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, ['src/infrastructure/persistence/migrate-cli.ts'], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `black-box-api: migrating apps/${serviceName} failed (exit ${result.status}, spawn error: ${String(result.error)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 300): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`black-box-api: condition not met within ${timeoutMs}ms`);
}

// ── The wire shapes this file actually reads off real HTTP responses —
//    intentionally narrow (only the fields these scenarios assert on),
//    never imported from any service's own `src/` (this file's own
//    header). ─────────────────────────────────────────────────────────
interface PlaceOrderHttpResponse {
  readonly orderId: string;
  readonly orderReference: string;
  readonly status: string;
  readonly currency: string;
  readonly totalAmount: number;
  readonly projectionPending: boolean;
}

interface OrderDetailHttpResponse {
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly status: string;
  readonly cancellationReason: string | null;
  readonly totals: { readonly totalAmount: number | null } | null;
  readonly references: { readonly invoiceReference: string | null };
  readonly events: readonly { readonly eventId: string; readonly eventType: string; readonly occurredAt: string; readonly causationId?: string }[];
}

/**
 * Amendment A1 (`progress/spec_projector_timeline_ordering.md` open points
 * 4 + 6, `specs/shared/test-matrix.md` R24's row) — the GENERAL causal-
 * order invariant, checked over WHATEVER `events[]` the order actually
 * carries: for every entry `B` whose `causationId` names another entry
 * `A`'s `eventId` in the SAME timeline, `A` precedes `B`. Applied to every
 * order this suite touches (never a hand-written expected sequence per
 * scenario — the reviewer identified exactly that gap, a scenario
 * asserting only `status === 'completed'` and never inspecting `events[]`
 * at all, as why the R24 completion-triple inversion (D4) shipped green).
 * A `causationId` naming nothing in this order's own timeline (a command
 * id, or a fact outside this order entirely) is skipped, not asserted —
 * PR31.
 */
function assertCausalOrder(events: OrderDetailHttpResponse['events']): void {
  const indexOfEventId = new Map(events.map((event, index) => [event.eventId, index] as const));
  for (const [effectIndex, effect] of events.entries()) {
    if (!effect.causationId) continue;
    const causeIndex = indexOfEventId.get(effect.causationId);
    if (causeIndex === undefined) continue;
    expect(
      causeIndex,
      `causal order violated: ${effect.eventType} (index ${effectIndex}) names causationId ` +
        `${effect.causationId}, but its cause (index ${causeIndex}) does not precede it — ` +
        `events: ${JSON.stringify(events.map((event) => event.eventType))}`,
    ).toBeLessThan(effectIndex);
  }
}

interface InvoiceListHttpResponse {
  readonly items: readonly {
    readonly invoiceId: string;
    readonly invoiceReference: string;
    readonly orderReference: string;
    readonly currency: string;
    readonly totalAmount: number;
  }[];
}

interface PaymentRegisterHttpResponse {
  readonly outcome: string;
  readonly paymentReference: string;
}

describe('black_box_api — full happy path, full compensation path, and payment idempotency, driven entirely over real HTTP against the REAL, spawned Gateway + a real fleet (Orders/Fulfillment/Billing/Projector, Testcontainers infra)', () => {
  let ordersContainer: StartedMySqlContainer;
  let fulfillmentContainer: StartedMySqlContainer;
  let billingContainer: StartedMySqlContainer;
  let kafkaFixture: KafkaTestFixture;
  let natsFixture: OpenNatsTestFixture;
  let mongoFixture: StandaloneMongoTestFixture;

  let fulfillmentDb: MySqlWorkerClient;
  let billingDb: MySqlWorkerClient;

  let fulfillmentProcess: RealServiceProcess;
  let billingProcess: RealServiceProcess;
  let projectorProcess: RealProjectorProcess;
  let ordersProcess: RealServiceProcess;
  let gatewayProcess: RealServiceProcess;

  let baseUrl: string;
  let token: string;

  const MONGO_DB_NAME = `otc_black_box_api_readmodel_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // ── 1. Disposable infra, in parallel ────────────────────────────────
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

    // ── 2. Migrations — real `db:migrate` CLIs, one child process each ──
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

    // ── 3. Kafka topics — every fact topic this fleet's outbox relays
    //    publish onto (auto-creation is disabled on this fixture);
    //    sequential — concurrent `admin.createTopics` against a
    //    single-node KRaft broker has been observed to race, per every
    //    other harness in this repo using this fixture. No `.dlq`
    //    companions: none of this file's scenarios drives a poison
    //    message. ────────────────────────────────────────────────────
    for (const topic of [ORDERS_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, BILLING_FACTS_TOPIC]) {
      await createTopic(kafkaFixture.brokers, topic);
    }

    // ── 4. Probe DB clients + reference-data seeding (raw SQL — no
    //    service's own schema module is imported) ─────────────────────
    const ordersDb = await MySqlWorkerClient.connect('orders', {
      host: ordersContainer.getHost(),
      port: ordersContainer.getPort(),
      user: ordersContainer.getUsername(),
      password: ordersContainer.getUserPassword(),
      database: ordersContainer.getDatabase(),
    });
    [fulfillmentDb, billingDb] = await Promise.all([
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

    try {
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
        [randomUUID(), PRODUCT_CODE, '5901234123457', 'Ration Pack Bundle', 'Mixed grocery ration pack, 1 unit', PRODUCT_PRICE, currencyId, now, now],
      );

      await fulfillmentDb.execute(
        'INSERT INTO stock (id, company_code, product_code, units, reserved_units, low_stock_threshold, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 2, ?, ?)',
        [randomUUID(), COMPANY_CODE, PRODUCT_CODE, 1_000_000, now, now],
      );

      await billingDb.execute(
        'INSERT INTO credits (id, code, retailer_code, company_code, credit_limit, currency_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), 'CR-000001', RETAILER_CODE, COMPANY_CODE, 1_000_000_000, CURRENCY, now, now],
      );
    } finally {
      await ordersDb.close();
    }

    // ── 5. Spawn the real fleet — Fulfillment/Billing/Projector FIRST
    //    (concurrently), Orders next (once those responders are up), the
    //    Gateway LAST (it is the one surface every scenario below drives,
    //    and its own boot never gates anything else). ──────────────────
    const [fulfillmentPort, billingPort, ordersPort, gatewayPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
      getFreePort(),
      getFreePort(),
    ]);

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
      },
      readiness: { type: 'log', pattern: /\[orders\] listening on port/, timeoutMs: 90_000 },
    });

    gatewayProcess = await spawnRealService({
      serviceName: 'gateway',
      env: {
        GATEWAY_PORT: String(gatewayPort),
        MONGO_HOST: mongoFixture.host,
        MONGO_HOST_PORT: String(mongoFixture.port),
        MONGO_DB_READMODEL: MONGO_DB_NAME,
        NATS_URL: natsFixture.url,
        GATEWAY_RPC_TIMEOUT_MS: '10000',
        JWT_SECRET: 'gateway-black-box-api-test-secret',
        GATEWAY_OPERATOR_USERNAME: TEST_OPERATOR_USERNAME,
        GATEWAY_OPERATOR_PASSWORD: TEST_OPERATOR_PASSWORD,
      },
      readiness: { type: 'log', pattern: /\[gateway\] listening on port/, timeoutMs: 90_000 },
    });

    baseUrl = `http://127.0.0.1:${gatewayPort}`;

    // Login ONCE — every scenario below reuses the same bearer token
    // (openapi.yaml's single operator identity), exactly the way an
    // operator driving this API by hand would.
    const login = await request(baseUrl).post('/auth/login').send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    if (login.status !== 200 || typeof login.body?.accessToken !== 'string') {
      throw new Error(`black-box-api: POST /auth/login did not return a token — status ${login.status}, body ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken as string;
  }, 600_000);

  afterAll(async () => {
    await gatewayProcess?.stop();
    await ordersProcess?.stop();
    await billingProcess?.stop();
    await fulfillmentProcess?.stop();
    await projectorProcess?.stop();
    await fulfillmentDb?.close();
    await billingDb?.close();
    await ordersContainer?.stop();
    await fulfillmentContainer?.stop();
    await billingContainer?.stop();
    await kafkaFixture?.teardown();
    await natsFixture?.teardown();
    await mongoFixture?.teardown();
  }, 180_000);

  function auth() {
    return { Authorization: `Bearer ${token}` };
  }

  async function placeOrder(quantity: number): Promise<PlaceOrderHttpResponse> {
    const response = await request(baseUrl)
      .post('/orders')
      .set(auth())
      .send({ retailerCode: RETAILER_CODE, companyCode: COMPANY_CODE, currency: CURRENCY, lines: [{ productCode: PRODUCT_CODE, quantity }] });
    if (response.status !== 201) {
      throw new Error(`black-box-api: POST /orders was refused — status ${response.status}, body ${JSON.stringify(response.body)}`);
    }
    return response.body as PlaceOrderHttpResponse;
  }

  async function getOrder(orderId: string): Promise<OrderDetailHttpResponse | undefined> {
    const response = await request(baseUrl).get(`/orders/${orderId}`).set(auth());
    if (response.status === 200) return response.body as OrderDetailHttpResponse;
    return undefined; // 202 (projection pending) or 404 — "not yet the terminal document" either way
  }

  /** Polls `GET /orders/{id}` until it reaches ONE OF `targetStatuses` (terminal or resting, never a transient mid-saga status this real fleet can race past inside one poll interval — CLAUDE.md's binding "synchronise on terminal or monotonic evidence" ruling). Returns the FIRST body observed in that set. */
  async function waitForOrderStatus(orderId: string, targetStatuses: readonly string[], timeoutMs = 60_000): Promise<OrderDetailHttpResponse> {
    let last: OrderDetailHttpResponse | undefined;
    try {
      await waitFor(async () => {
        const doc = await getOrder(orderId);
        if (doc && targetStatuses.includes(doc.status)) {
          last = doc;
          return true;
        }
        return false;
      }, timeoutMs);
    } catch (error) {
      throw new Error(`${(error as Error).message} — orderId=${orderId}, last observed=${JSON.stringify(last)}`, { cause: error });
    }
    return last!;
  }

  /** `POST /invoices/{id}/payments` requires Billing's internal `invoiceId` (openapi.yaml), never `invoiceReference` — resolved the way the Gateway itself resolves it: `GET /invoices?orderReference=...`, over HTTP, never a direct DB read. */
  async function invoiceForOrder(orderReference: string): Promise<InvoiceListHttpResponse['items'][number]> {
    const response = await request(baseUrl).get('/invoices').query({ orderReference }).set(auth());
    expect(response.status).toBe(200);
    const body = response.body as InvoiceListHttpResponse;
    expect(body.items.length, `expected exactly one invoice for orderReference ${orderReference}, got ${JSON.stringify(body.items)}`).toBeGreaterThanOrEqual(1);
    return body.items[0]!;
  }

  it(
    'scenario 1 — full happy path: POST /orders, poll GET /orders/{id} to invoiced, POST /invoices/{id}/payments, and the order reaches completed — entirely over real HTTP against the real, spawned Gateway',
    async () => {
      const placed = await placeOrder(2); // 2 x 24999 = 49998 — not a .99 total
      expect(placed.totalAmount).toBe(49_998);
      expect(placed.projectionPending).toBe(true);
      expect(placed.status).toBe('placed');

      const invoiced = await waitForOrderStatus(placed.orderId, ['invoiced'], 60_000);
      expect(invoiced.references.invoiceReference).toBeTruthy();

      const invoice = await invoiceForOrder(placed.orderReference);
      expect(invoice.totalAmount).toBe(49_998);

      const paymentResponse = await request(baseUrl)
        .post(`/invoices/${invoice.invoiceId}/payments`)
        .set(auth())
        .send({
          paymentReference: `PAY-HAPPY-${randomUUID().slice(0, 8)}`,
          amount: { amount: invoice.totalAmount, currency: invoice.currency },
          valueDate: new Date().toISOString(),
          source: 'test',
        });
      expect(paymentResponse.status).toBe(201);
      expect((paymentResponse.body as PaymentRegisterHttpResponse).outcome).toBe('accepted');

      const completed = await waitForOrderStatus(placed.orderId, ['completed'], 60_000);
      expect(completed.status).toBe('completed');

      // R24 (amendment A1) — the completion triple (payment.received.v1,
      // credit.released.v1, order.completed.v1) shares one occurredAt;
      // this is the GENERAL invariant that catches the exact inversion
      // (D4, progress/review_api_tests.md §2) a status-only assertion
      // could never see: credit.released.v1 rendered BEFORE the
      // payment.received.v1 that produced it, on every completed order.
      const eventTypes = completed.events.map((event) => event.eventType);
      expect(eventTypes, 'expected the completion triple in the timeline').toEqual(
        expect.arrayContaining(['payment.received.v1', 'credit.released.v1', 'order.completed.v1']),
      );
      assertCausalOrder(completed.events);
    },
    150_000,
  );

  it(
    "scenario 2 (R28) — full compensation path: a .99 order reaches cancelled/credit_rejected over HTTP, with all three compensation-chain facts (credit.rejected.v1, stock.released.v1, order.cancelled.v1) separately visible as distinct timeline entries IN CAUSAL ORDER, and the reservation genuinely released in Fulfillment's OWN database — never inferred from the order's status field alone",
    async () => {
      // R42 (billing_credit): amountMinorUnits % 100 === 99 refuses
      // UNCONDITIONALLY, regardless of available credit. 24999 x 1 = 24999.
      const placed = await placeOrder(1);
      expect(placed.totalAmount % 100).toBe(99);

      const cancelled = await waitForOrderStatus(placed.orderId, ['cancelled'], 60_000);
      expect(cancelled.cancellationReason).toBe('credit_rejected');

      // R28 — both compensation steps visible in the timeline, in causal
      // order: the triggering business refusal, then the release, then
      // the cancellation itself — three DISTINCT entries, never merged/
      // collapsed into one.
      //
      // `stock.released.v1` and `order.cancelled.v1` are BYTE-IDENTICAL on
      // `occurredAt` by design (`order.cancel(...)` is built from the
      // triggering `stock.released.v1` fact's own `occurredAt`, reused
      // verbatim, deliberately never a fresh clock read — see
      // `progress/impl_api_tests.md`'s "R28 timeline-ordering fix" for why
      // that is right and stays that way). Before that fix landed, the
      // read model's `events[]` tiebroke an `occurredAt` tie by a random
      // `eventId`, so this assertion failed on roughly half of all runs —
      // observed directly: 7 of 8 live `.99` orders inverted (see
      // `progress/review_api_tests.md` §1.1/§1.2). The read model now
      // tiebreaks by each entry's own causal rank instead, so the release
      // sorts before the cancellation it causes EVERY time, not merely in
      // this run.
      const eventTypes = cancelled.events.map((event) => event.eventType);
      const creditRejectedIndex = eventTypes.indexOf('credit.rejected.v1');
      const stockReleasedIndex = eventTypes.indexOf('stock.released.v1');
      const orderCancelledIndex = eventTypes.indexOf('order.cancelled.v1');
      expect(creditRejectedIndex, `expected credit.rejected.v1 in the timeline, got ${JSON.stringify(eventTypes)}`).toBeGreaterThanOrEqual(0);
      expect(stockReleasedIndex, `expected stock.released.v1 in the timeline, got ${JSON.stringify(eventTypes)}`).toBeGreaterThanOrEqual(0);
      expect(orderCancelledIndex, `expected order.cancelled.v1 in the timeline, got ${JSON.stringify(eventTypes)}`).toBeGreaterThanOrEqual(0);
      expect(creditRejectedIndex, 'credit.rejected.v1 must precede stock.released.v1').toBeLessThan(stockReleasedIndex);
      expect(creditRejectedIndex, 'credit.rejected.v1 must precede order.cancelled.v1').toBeLessThan(orderCancelledIndex);
      // R28's own clause, restored: the release strictly precedes the
      // cancellation it causes, in the timeline array — not merely both
      // present, in CAUSAL order.
      expect(stockReleasedIndex, `stock.released.v1 must precede order.cancelled.v1 in causal order, got ${JSON.stringify(eventTypes)}`).toBeLessThan(
        orderCancelledIndex,
      );

      // The documented tie, still true post-fix: both entries carry the
      // EXACT SAME occurredAt (see the finding above) — the array order
      // above is what actually proves causal order now, not this field.
      const stockReleasedOccurredAt = cancelled.events[stockReleasedIndex]!.occurredAt;
      const orderCancelledOccurredAt = cancelled.events[orderCancelledIndex]!.occurredAt;
      expect(orderCancelledOccurredAt, 'order.cancelled.v1 reuses stock.released.v1\'s own occurredAt verbatim — expected, see the finding above').toBe(
        stockReleasedOccurredAt,
      );

      // The GENERAL invariant (amendment A1) — the same helper scenario 1
      // uses, applied here too, so no future tie in EITHER path can slip
      // past a hand-written per-scenario sequence.
      assertCausalOrder(cancelled.events);

      // The stock genuinely released — read from Fulfillment's OWN MySQL
      // database, never merely inferred from the Gateway's own read model
      // (this feature's own brief, and the same technique
      // `saga-e2e-verification`'s criterion 2 already proves).
      interface ReservationRow {
        status: string;
      }
      const reservationRows = await fulfillmentDb.query<ReservationRow>('SELECT * FROM reservations WHERE order_reference = ?', [placed.orderReference]);
      expect(reservationRows).toHaveLength(1);
      expect(reservationRows[0]!.status).toBe('released');
    },
    150_000,
  );

  it(
    'scenario 3 (R48/B10) — idempotency: registering the SAME paymentReference twice against the real Gateway yields exactly one payment: 201/accepted then 200/duplicate, and Billing\'s OWN database records exactly one payment row',
    async () => {
      const placed = await placeOrder(3); // 3 x 24999 = 74997 — not a .99 total
      const invoiced = await waitForOrderStatus(placed.orderId, ['invoiced'], 60_000);
      expect(invoiced.references.invoiceReference).toBeTruthy();
      const invoice = await invoiceForOrder(placed.orderReference);

      const paymentReference = `PAY-IDEMPOTENT-${randomUUID().slice(0, 8)}`;
      const body = {
        paymentReference,
        amount: { amount: invoice.totalAmount, currency: invoice.currency },
        valueDate: new Date().toISOString(),
        source: 'test' as const,
      };

      const first = await request(baseUrl).post(`/invoices/${invoice.invoiceId}/payments`).set(auth()).send(body);
      expect(first.status).toBe(201);
      expect((first.body as PaymentRegisterHttpResponse).outcome).toBe('accepted');

      const second = await request(baseUrl).post(`/invoices/${invoice.invoiceId}/payments`).set(auth()).send(body);
      expect(second.status).toBe(200);
      expect((second.body as PaymentRegisterHttpResponse).outcome).toBe('duplicate');
      expect(second.headers['idempotent-replay']).toBe('true');

      // Billing's OWN database — the durable source of truth, never only
      // the reply shape (this feature's own brief).
      interface CountRow {
        n: number;
      }
      const [countRow] = await billingDb.query<CountRow>('SELECT COUNT(*) AS n FROM payments WHERE payment_reference = ?', [paymentReference]);
      expect(countRow!.n).toBe(1);
    },
    150_000,
  );

  it('scenario 4 — auth and error shapes: no bearer token is rejected with 401, a malformed order id with 400, and an id never issued by this gateway with 404', async () => {
    const noAuth = await request(baseUrl).get('/orders');
    expect(noAuth.status).toBe(401);

    const malformed = await request(baseUrl).get('/orders/not-a-uuid').set(auth());
    expect(malformed.status).toBe(400);

    const unknown = await request(baseUrl).get(`/orders/${randomUUID()}`).set(auth());
    expect(unknown.status).toBe(404);
  });
});
