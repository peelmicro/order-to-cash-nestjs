// F1 (progress/review_gateway_rest_auth.md) — the wire finding proven
// against the REAL `orders.create` responder, wired the same way
// `apps/orders/src/main.ts` wires it in production (bare-JSON
// (de)serializer pair installed on the NATS microservice), over real NATS
// (Testcontainers, nats:2.14.5-alpine) and real MySQL (Testcontainers,
// mysql:8.4.11).
//
// Two callers are driven against the SAME running responder, because the
// defect this spec exists to catch is precisely that each side of the repo
// was previously tested only against the wire it prefers
// (apps/gateway's own bare-JSON stub vs. apps/orders' `ClientProxy`
// envelope), and nothing ever put the two together:
//
//   1. A raw `nats` bare-JSON request carrying a reply subject — exactly
//      the shape apps/gateway's `NatsRpcClientAdapter` and the saga's own
//      `NatsSagaCommandsAdapter` send. Before this fix landed, this request
//      ran the handler to completion (order persisted, outbox row written)
//      and then got NO reply — the caller would time out and retry,
//      placing a second real order. Model: apps/billing's `invoice-wire.
//      integration.spec.ts` (BI16) / apps/fulfillment's `stock-wire.
//      integration.spec.ts` (FS4).
//
//   2. A `@nestjs/microservices` `ClientProxy` — the SAME caller
//      `orders-acceptance.integration.spec.ts` already drives — to prove
//      the fix does NOT regress that caller. `ClientProxy`'s default
//      `NatsResponseJSONDeserializer` classifies a reply carrying none of
//      `err`/`response`/`isDisposed` as "external" (`IncomingResponse
//      Deserializer.isExternal`) and auto-wraps it as
//      `{ response: <bare payload>, isDisposed: true }` — this is verified
//      here by execution, not assumed from reading the framework source.
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { ClientProxyFactory, Transport, type ClientProxy, type MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JSONCodec, type NatsConnection } from 'nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OrdersCreateReplyPayload, RpcError } from '@otc/contracts';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { PlaceOrderHandler } from './application/place-order.handler';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderNumberAllocator } from './infrastructure/persistence/order-number-allocator';
import { DrizzleOrderReferenceDataRepository } from './infrastructure/persistence/order-reference-data.repository';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
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
// G6 (progress/review_gateway_rest_auth.md, Round 3, H2's cheap half): the
// microservice options come from main.ts itself now, not a hand-mirrored
// copy — see main.ts's own header comment on createOrdersNatsMicroserviceOptions
// for why this removes the class of drift F1 exploited.
import { createOrdersNatsMicroserviceOptions } from './main';

const codec = JSONCodec();
const FRAMEWORK_PACKET_KEYS = ['response', 'isDisposed', 'id'];
const ORDERS_CREATE_SUBJECT = 'orders.create';

function isRpcError(reply: OrdersCreateReplyPayload | RpcError): reply is RpcError {
  return typeof (reply as RpcError).code === 'string';
}

function assertBareShape(decoded: unknown): void {
  expect(typeof decoded).toBe('object');
  const keys = Object.keys(decoded as Record<string, unknown>);
  for (const forbidden of FRAMEWORK_PACKET_KEYS) {
    expect(keys).not.toContain(forbidden);
  }
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

describe('orders.create — F1, the bare-JSON wire, proven against apps/orders/src/main.ts\'s real configuration (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let natsFixture: NatsTestFixture;
  let stockResponderConnection: NatsConnection;
  let rawNatsConnection: NatsConnection;
  let app: INestApplication;
  let clientProxy: ClientProxy;
  let stubResponder: StubStockCheckResponder | undefined;

  beforeAll(async () => {
    [mysqlFixture, natsFixture] = await Promise.all([startOrdersTestFixture(), startNatsTestFixture()]);
    [stockResponderConnection, rawNatsConnection] = await Promise.all([natsFixture.connect(), natsFixture.connect()]);

    const clock = new FakeClock(new Date('2026-08-25T09:00:00.000Z'));
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const orders = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const orderNumbers = new DrizzleOrderNumberAllocator();
    const referenceData = new DrizzleOrderReferenceDataRepository(mysqlFixture.db);
    // A separate connection again, dedicated to the stock-availability
    // adapter — mirrors orders-acceptance.integration.spec.ts's own
    // three-connection layout (responder / stock-check-caller / app-client).
    const stockCheckConnection = await natsFixture.connect();
    const stockAvailability = new NatsStockAvailabilityAdapter(stockCheckConnection, 1500);
    const handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersCreateController],
      providers: [{ provide: PlaceOrderHandler, useValue: handler }],
    }).compile();

    app = moduleRef.createNestApplication();
    const connectionOptions = natsFixture.container.getConnectionOptions();
    // The production shape (apps/orders/src/main.ts, post-G6-fix): the SAME
    // function bootstrap() calls, not a second hand-copied literal — so a
    // future edit to main.ts's (de)serializer pair is impossible to leave
    // unmirrored here, because there is nothing left to mirror.
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
    await rawNatsConnection?.close();
    await mysqlFixture?.teardown();
    await natsFixture?.teardown();
  }, 120_000);

  async function rawRequest(payload: unknown): Promise<unknown> {
    const reply = await rawNatsConnection.request(ORDERS_CREATE_SUBJECT, codec.encode(payload), { timeout: 10_000 });
    return codec.decode(reply.data);
  }

  it('answers a bare-JSON request from a raw nats client (the Gateway/saga shape) with a bare-JSON reply — no Nest envelope, and a synchronous 201-worthy id (the F1 regression)', async () => {
    stubResponder = await startStubStockCheckResponder(stockResponderConnection, alwaysAvailable);

    const decoded = (await rawRequest(requestPayload())) as OrdersCreateReplyPayload;

    assertBareShape(decoded);
    expect(decoded.status).toBe('placed');
    expect(decoded.orderId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(decoded).not.toHaveProperty('err');
  });

  it('answers a bare-JSON RpcError from a raw nats client on a validation failure — never a hang, never a Nest envelope', async () => {
    const decoded = (await rawRequest(requestPayload({ lines: [] }))) as RpcError;

    assertBareShape(decoded);
    expect(decoded).toHaveProperty('code');
    expect(typeof decoded.code).toBe('string');
  });

  it('a ClientProxy caller (orders-acceptance.integration.spec.ts\'s own shape) still resolves correctly against the bare-JSON-configured responder — backward compatibility, verified by execution', async () => {
    stubResponder = await startStubStockCheckResponder(stockResponderConnection, alwaysAvailable);

    const reply = await firstValueFrom(
      clientProxy
        .send<OrdersCreateReplyPayload | RpcError>('orders.create', requestPayload())
        .pipe(timeout(10_000)),
    );

    expect(isRpcError(reply)).toBe(false);
    const success = reply as OrdersCreateReplyPayload;
    expect(success.status).toBe('placed');
    expect(success.orderId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('a ClientProxy caller still gets the RPC error shape on a rejection against the bare-JSON-configured responder', async () => {
    // A distinct requestId per call so this does not collide with the
    // idempotency behaviour of any other test in this file.
    const reply = await firstValueFrom(
      clientProxy
        .send<OrdersCreateReplyPayload | RpcError>(
          'orders.create',
          requestPayload({ lines: [], requestId: randomUUID() }),
        )
        .pipe(timeout(10_000)),
    );

    expect(isRpcError(reply)).toBe(true);
  });
}, 180_000);
