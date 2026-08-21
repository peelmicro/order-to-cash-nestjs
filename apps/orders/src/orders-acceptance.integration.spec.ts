// The end-to-end proof for `orders_acceptance` — real MySQL (Testcontainers,
// mysql:8.4.11) AND real NATS (Testcontainers, nats:2.14.5-alpine, the SAME
// pinned tag docker-compose.infra.yml uses; core-only, no JetStream).
//
// `fulfillment.stock.check` has no real responder yet (feature 17,
// `fulfillment_stock`, has not landed) — the ONLY stand-in is
// `test-support/stub-stock-check-responder.ts`, imported ONLY from this
// spec, never from `src/{application,infrastructure/{persistence,outbox,messaging},presentation}`
// (grep it: nothing outside `test-support/` and `*.spec.ts` references it).
//
// The caller is `@nestjs/microservices`'s own `ClientProxyFactory`
// (Transport.NATS) — the same client a future Gateway feature would use —
// so this test exercises the REAL wire protocol `orders-create.controller.ts`
// (`@MessagePattern`) speaks, not a hand-rolled substitute.
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { ClientProxyFactory, Transport, type ClientProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NatsConnection } from 'nats';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OrdersCreateReplyPayload, RpcError } from '@otc/contracts';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { PlaceOrderHandler } from './application/place-order.handler';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderNumberAllocator } from './infrastructure/persistence/order-number-allocator';
import { DrizzleOrderReferenceDataRepository } from './infrastructure/persistence/order-reference-data.repository';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from './infrastructure/persistence/test-support/orders-test-fixture';
import { FakeClock } from './infrastructure/persistence/test-support/fake-clock';
import { NatsStockAvailabilityAdapter } from './infrastructure/messaging/nats-stock-availability.adapter';
import { startNatsTestFixture, type NatsTestFixture } from './infrastructure/messaging/test-support/nats-test-fixture';
import {
  alwaysAvailable,
  alwaysUnavailable,
  startStubStockCheckResponder,
  type StubStockCheckResponder,
} from './infrastructure/messaging/test-support/stub-stock-check-responder';

function isRpcError(reply: OrdersCreateReplyPayload | RpcError): reply is RpcError {
  return typeof (reply as RpcError).code === 'string';
}

describe('orders.create — end to end (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let natsFixture: NatsTestFixture;
  let responderConnection: NatsConnection;
  let stockCheckConnection: NatsConnection;
  let app: INestApplication;
  let client: ClientProxy;
  let stubResponder: StubStockCheckResponder | undefined;

  beforeAll(async () => {
    [mysqlFixture, natsFixture] = await Promise.all([startOrdersTestFixture(), startNatsTestFixture()]);
    [responderConnection, stockCheckConnection] = await Promise.all([natsFixture.connect(), natsFixture.connect()]);

    const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const orders = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const orderNumbers = new DrizzleOrderNumberAllocator();
    const referenceData = new DrizzleOrderReferenceDataRepository(mysqlFixture.db);
    const stockAvailability = new NatsStockAvailabilityAdapter(stockCheckConnection, 1500);
    const handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersCreateController],
      providers: [{ provide: PlaceOrderHandler, useValue: handler }],
    }).compile();

    app = moduleRef.createNestApplication();
    const connectionOptions = natsFixture.container.getConnectionOptions();
    app.connectMicroservice({
      transport: Transport.NATS,
      options: { servers: connectionOptions.servers, user: connectionOptions.user, pass: connectionOptions.pass },
    });
    await app.startAllMicroservices();
    await app.init();

    client = ClientProxyFactory.create({
      transport: Transport.NATS,
      options: { servers: connectionOptions.servers, user: connectionOptions.user, pass: connectionOptions.pass },
    });
    await client.connect();
  }, 180_000);

  afterEach(async () => {
    await stubResponder?.stop();
    stubResponder = undefined;
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await responderConnection?.close();
    await stockCheckConnection?.close();
    await mysqlFixture?.teardown();
    await natsFixture?.teardown();
  }, 120_000);

  function requestPayload(overrides: Record<string, unknown> = {}) {
    return {
      retailerCode: FIXTURE_RETAILER_CODE,
      companyCode: FIXTURE_COMPANY_CODE,
      currency: FIXTURE_CURRENCY,
      lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2 }],
      ...overrides,
    };
  }

  async function send(payload: Record<string, unknown>): Promise<OrdersCreateReplyPayload | RpcError> {
    return firstValueFrom(client.send<OrdersCreateReplyPayload | RpcError>('orders.create', payload).pipe(timeout(10_000)));
  }

  it('returns an order id synchronously, and the order row + its outbox record commit together', async () => {
    stubResponder = await startStubStockCheckResponder(responderConnection, alwaysAvailable);

    // A non-zero lineDiscount on purpose (D1 regression,
    // review_orders_acceptance.md): with a zero discount, totalAmount ===
    // initialAmount and the wire-level reply cannot distinguish a
    // `totalAmount: initialAmount` mapping bug from the correct mapping.
    const reply = await send(
      requestPayload({ lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2, lineDiscount: 300 }] }),
    );
    expect(isRpcError(reply)).toBe(false);
    const success = reply as OrdersCreateReplyPayload;
    expect(success.status).toBe('placed');
    expect(success.orderId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(success).toMatchObject({
      currency: FIXTURE_CURRENCY,
      initialAmount: 2_000,
      initialDiscount: 300,
      totalAmount: 1_700,
    });
    expect(success.totalAmount).not.toBe(success.initialAmount);

    const [orderRow] = await mysqlFixture.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, success.orderId));
    expect(orderRow).toMatchObject({ id: success.orderId, orderReference: success.orderReference, status: 'placed' });

    const outboxRows = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, success.orderId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ eventType: 'order.placed.v1', publishedAt: null });
  });

  it('rejects when the stock check reports unavailability, and persists NOTHING for that attempt', async () => {
    stubResponder = await startStubStockCheckResponder(responderConnection, alwaysUnavailable);

    const reply = await send(requestPayload());
    expect(isRpcError(reply)).toBe(true);
    expect((reply as RpcError).code).toBe('STOCK_UNAVAILABLE');

    const rowsBefore = await mysqlFixture.db.select().from(ordersSchema.orders);
    const rowCountBefore = rowsBefore.length;

    // A second identical rejection must not have grown the table either —
    // proves rejection is not a partial/leaky write, run twice for
    // confidence rather than trusting a single sample.
    await send(requestPayload());
    const rowsAfter = await mysqlFixture.db.select().from(ordersSchema.orders);
    expect(rowsAfter).toHaveLength(rowCountBefore);
  });

  it('handles a stock-check timeout — never hangs — and persists NOTHING for that attempt', async () => {
    // A subscriber is present (avoids the fast NoResponders path) but never
    // replies — the genuine "peer up but stuck" timeout case.
    const silent = responderConnection.subscribe('fulfillment.stock.check');
    void (async () => {
      for await (const _message of silent) {
        // never responds
      }
    })();

    const rowsBefore = await mysqlFixture.db.select().from(ordersSchema.orders);

    const startedAt = Date.now();
    const reply = await send(requestPayload());
    const elapsedMs = Date.now() - startedAt;

    silent.unsubscribe();

    expect(isRpcError(reply)).toBe(true);
    expect((reply as RpcError).code).toBe('TIMEOUT');
    // Bounded by the adapter's own 1500ms deadline, not by the test's
    // outer 10s client-side timeout — proves the RESPONDER itself did not
    // hang waiting on the stock check.
    expect(elapsedMs).toBeLessThan(5_000);

    const rowsAfter = await mysqlFixture.db.select().from(ordersSchema.orders);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
  });
}, 180_000);
