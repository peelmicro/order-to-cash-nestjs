// RI1–RI4, R62 (`observability_reliability` requirements.md §4, design.md
// §3) — `orders.create`'s `requestId` idempotent replay, proven against the
// REAL `orders.create` responder over real NATS (Testcontainers,
// nats:2.14.5-alpine) and real MySQL (Testcontainers, mysql:8.4.11), the
// same harness shape `orders-create-wire.integration.spec.ts` already
// established.
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { eq } from 'drizzle-orm';
import { ClientProxyFactory, Transport, type ClientProxy, type MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NatsConnection } from 'nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OrdersCreateReplyPayload, RpcError } from '@otc/contracts';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { PlaceOrderHandler } from './application/place-order.handler';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderNumberAllocator } from './infrastructure/persistence/order-number-allocator';
import { DrizzleOrderReferenceDataRepository } from './infrastructure/persistence/order-reference-data.repository';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
import { orders } from './infrastructure/persistence/schema';
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
  startStubStockCheckResponder,
  type StubStockCheckResponder,
} from './infrastructure/messaging/test-support/stub-stock-check-responder';
import { createOrdersNatsMicroserviceOptions } from './main';

function isRpcError(reply: OrdersCreateReplyPayload | RpcError): reply is RpcError {
  return typeof (reply as RpcError).code === 'string';
}

function requestPayload(overrides: Record<string, unknown> = {}) {
  return {
    retailerCode: FIXTURE_RETAILER_CODE,
    companyCode: FIXTURE_COMPANY_CODE,
    currency: FIXTURE_CURRENCY,
    lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2 }],
    ...overrides,
  };
}

describe('orders.create — requestId idempotent replay (RI1–RI4, R62; Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let natsFixture: NatsTestFixture;
  let stockResponderConnection: NatsConnection;
  let app: INestApplication;
  let clientProxy: ClientProxy;
  let stubResponder: StubStockCheckResponder | undefined;

  beforeAll(async () => {
    [mysqlFixture, natsFixture] = await Promise.all([startOrdersTestFixture(), startNatsTestFixture()]);
    stockResponderConnection = await natsFixture.connect();

    const clock = new FakeClock(new Date('2026-08-26T09:00:00.000Z'));
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const orderRepository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const orderNumbers = new DrizzleOrderNumberAllocator();
    const referenceData = new DrizzleOrderReferenceDataRepository(mysqlFixture.db);
    const stockCheckConnection = await natsFixture.connect();
    const stockAvailability = new NatsStockAvailabilityAdapter(stockCheckConnection, 1500);
    const handler = new PlaceOrderHandler(unitOfWork, orderRepository, orderNumbers, referenceData, stockAvailability, clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersCreateController],
      providers: [{ provide: PlaceOrderHandler, useValue: handler }],
    }).compile();

    app = moduleRef.createNestApplication();
    const connectionOptions = natsFixture.container.getConnectionOptions();
    app.connectMicroservice<MicroserviceOptions>(
      createOrdersNatsMicroserviceOptions({
        servers: connectionOptions.servers,
        user: connectionOptions.user,
        pass: connectionOptions.pass,
      }),
    );
    await app.startAllMicroservices();
    await app.init();

    clientProxy = ClientProxyFactory.create({
      transport: Transport.NATS,
      options: { servers: connectionOptions.servers, user: connectionOptions.user, pass: connectionOptions.pass },
    });
    await clientProxy.connect();
  }, 180_000);

  afterEach(async () => {
    await stubResponder?.stop();
    stubResponder = undefined;
  });

  afterAll(async () => {
    await clientProxy?.close();
    await app?.close();
    await stockResponderConnection?.close();
    await mysqlFixture?.teardown();
    await natsFixture?.teardown();
  }, 120_000);

  async function create(payload: unknown): Promise<OrdersCreateReplyPayload | RpcError> {
    return firstValueFrom(
      clientProxy.send<OrdersCreateReplyPayload | RpcError>('orders.create', payload).pipe(timeout(10_000)),
    );
  }

  async function requestIdRowCount(requestId: string): Promise<number> {
    const rows = await mysqlFixture.db.select().from(orders).where(eq(orders.requestId, requestId));
    return rows.length;
  }

  it('RI1 — persists requestId against the created order under a uniqueness constraint', async () => {
    stubResponder = await startStubStockCheckResponder(stockResponderConnection, alwaysAvailable);
    const requestId = randomUUID();

    const reply = (await create(requestPayload({ requestId }))) as OrdersCreateReplyPayload;
    expect(isRpcError(reply)).toBe(false);

    const [row] = await mysqlFixture.db.select().from(orders).where(eq(orders.id, reply.orderId));
    expect(row?.requestId).toBe(requestId);

    // A sequential repeat of the SAME, now-committed requestId (RI2's
    // named partner behaviour, proven end to end here too) — returns the
    // SAME order, never a second row.
    const repeat = (await create(requestPayload({ requestId }))) as OrdersCreateReplyPayload;
    expect(repeat.orderId).toBe(reply.orderId);
    expect(repeat.orderReference).toBe(reply.orderReference);
    expect(await requestIdRowCount(requestId)).toBe(1);
  });

  it('RI3 — two concurrent first-time orders.create requests carrying the same requestId create exactly one order, and the loser\'s reply matches the winner\'s', async () => {
    stubResponder = await startStubStockCheckResponder(stockResponderConnection, alwaysAvailable);
    const requestId = randomUUID();

    const [replyA, replyB] = await Promise.all([
      create(requestPayload({ requestId })),
      create(requestPayload({ requestId })),
    ]);

    expect(isRpcError(replyA)).toBe(false);
    expect(isRpcError(replyB)).toBe(false);
    const successA = replyA as OrdersCreateReplyPayload;
    const successB = replyB as OrdersCreateReplyPayload;

    // Never a second order, never an error (R62, RI3) — both replies name
    // the SAME winning order.
    expect(successB.orderId).toBe(successA.orderId);
    expect(successB.orderReference).toBe(successA.orderReference);
    expect(successB.totalAmount).toBe(successA.totalAmount);
    expect(await requestIdRowCount(requestId)).toBe(1);
  });

  it('RI4 — omitting requestId places a normal order with no lookup performed and no constraint consulted', async () => {
    stubResponder = await startStubStockCheckResponder(stockResponderConnection, alwaysAvailable);

    const replyA = (await create(requestPayload())) as OrdersCreateReplyPayload;
    const replyB = (await create(requestPayload())) as OrdersCreateReplyPayload;

    expect(isRpcError(replyA)).toBe(false);
    expect(isRpcError(replyB)).toBe(false);
    // Two DIFFERENT orders — no dedup performed merely because both omit
    // requestId (MySQL's UNIQUE index admits any number of NULLs).
    expect(replyB.orderId).not.toBe(replyA.orderId);

    const [rowA] = await mysqlFixture.db.select().from(orders).where(eq(orders.id, replyA.orderId));
    const [rowB] = await mysqlFixture.db.select().from(orders).where(eq(orders.id, replyB.orderId));
    expect(rowA?.requestId).toBeNull();
    expect(rowB?.requestId).toBeNull();
  });
}, 180_000);
