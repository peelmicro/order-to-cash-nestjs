// Group B (R54, read model only) + Group C (POST /orders, POST /orders/{id}/cancel
// over NATS RPC) — real NATS + real MongoDB, `orders.create`/`orders.cancel`
// answered by TEST-ONLY stub responders (neither has a live responder in
// this repository yet for `.cancel`; `.create` does, in apps/orders, but
// that service does not run in this suite either — this is the gateway's
// OWN translation under test, never another service's behaviour).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { OrdersCancelReplyPayload, OrdersCreateReplyPayload } from '@otc/contracts';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { startStubResponder, type StubResponder } from './test-support/stub-rpc-responder';
import type { OrderTimelineDocumentLike } from './domain/projection/order-read-model-mapper';

function seedOrderDoc(overrides: Partial<OrderTimelineDocumentLike> = {}): OrderTimelineDocumentLike {
  const orderId = overrides.orderId ?? randomUUID();
  return {
    _id: orderId,
    orderId,
    orderReference: 'ORD-000042',
    orderDate: '2026-08-18T09:00:00.000Z',
    retailer: { code: 'CarrefourEs', name: 'Carrefour ES', gln: '8412345000013' },
    company: { code: 'IBERFOODS', name: 'Iberfoods', gln: '8412345000020' },
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 124950, initialDiscount: 0, totalAmount: 124950 },
    items: [{ productCode: 'PRD-0001', quantity: 5, unitPrice: 24999, lineDiscount: 0 }],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    events: [{ eventId: randomUUID(), eventType: 'order.placed.v1', occurredAt: '2026-08-18T09:00:00.000Z', summary: 'Order placed' }],
    headerComplete: true,
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

describe('Gateway orders — R54 read model + Group C RPC commands', () => {
  let mongo: StandaloneMongoTestFixture;
  let nats: NatsTestFixture;
  let testApp: GatewayTestApp;
  let token: string;
  let stubConnection: Awaited<ReturnType<NatsTestFixture['connect']>>;
  let stubs: StubResponder[] = [];

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    nats = await startNatsTestFixture();
    testApp = await bootGatewayTestApp(mongo, nats);
    stubConnection = await nats.connect();
    const login = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    token = login.body.accessToken;
  });

  afterEach(async () => {
    await Promise.all(stubs.map((stub) => stub.stop()));
    stubs = [];
  });

  afterAll(async () => {
    await stubConnection.close();
    await testApp.close();
    await nats.teardown();
    await mongo.teardown();
  });

  it('F3 — GET /orders/{id} for an id this gateway never issued and the read model has never seen answers 404, not 202 (openapi.yaml: "a genuine 404 means the identifier is unknown to the system")', async () => {
    const response = await request(testApp.app.getHttpServer())
      .get(`/orders/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('R55/F3 — GET /orders/{id} for an id THIS GATEWAY JUST ISSUED (via POST /orders), not yet projected, answers 202 projection pending — "an order identifier that the caller has just been given"', async () => {
    const reply: OrdersCreateReplyPayload = {
      orderId: randomUUID(),
      orderReference: 'ORD-000123',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 100,
      initialDiscount: 0,
      totalAmount: 100,
      orderDate: '2026-08-18T10:00:00.000Z',
    };
    stubs.push(await startStubResponder(stubConnection, 'orders.create', () => reply));

    const placeResponse = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [{ productCode: 'PRD-0001', quantity: 5 }] });
    expect(placeResponse.status).toBe(201);

    // No document was inserted into MongoDB for this order — it is
    // genuinely not projected yet. Answering 202 rather than 404 is what
    // proves the IssuedOrderWindow, not a blanket "always pending", is
    // driving this response.
    const getResponse = await request(testApp.app.getHttpServer())
      .get(`/orders/${reply.orderId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getResponse.status).toBe(202);
    expect(getResponse.body.status).toBe('projection_pending');
    expect(getResponse.headers['retry-after']).toBeDefined();
  });

  it('GET /orders/{id} rejects a malformed id with 400, never reaching the read model', async () => {
    const response = await request(testApp.app.getHttpServer()).get('/orders/not-a-uuid').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
  });

  it('R54 — GET /orders/{id} returns the projected document once one exists in MongoDB', async () => {
    const doc = seedOrderDoc();
    await testApp.db.collection('order_timeline').insertOne(doc as never);

    const response = await request(testApp.app.getHttpServer()).get(`/orders/${doc.orderId}`).set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.orderReference).toBe('ORD-000042');
    expect(response.body.headerComplete).toBe(true);
    expect(response.body.events).toHaveLength(1);
  });

  it('R53/R54 — GET /orders excludes a placeholder document (no orderReference yet) from the list', async () => {
    const placeholder = seedOrderDoc({
      orderReference: null,
      orderDate: null,
      currency: null,
      retailer: { code: null, name: null, gln: null },
      company: { code: null, name: null, gln: null },
      totals: { initialAmount: null, initialDiscount: null, totalAmount: null },
      headerComplete: false,
    });
    await testApp.db.collection('order_timeline').insertOne(placeholder as never);

    const response = await request(testApp.app.getHttpServer()).get('/orders').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.items.some((item: { orderId: string }) => item.orderId === placeholder.orderId)).toBe(false);
  });

  it('R13 — POST /orders translates to orders.create and answers 201 with projectionPending:true and a Location header', async () => {
    const reply: OrdersCreateReplyPayload = {
      orderId: randomUUID(),
      orderReference: 'ORD-000099',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 124950,
      initialDiscount: 0,
      totalAmount: 124950,
      orderDate: '2026-08-18T10:00:00.000Z',
    };
    stubs.push(await startStubResponder(stubConnection, 'orders.create', () => reply));

    const response = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [{ productCode: 'PRD-0001', quantity: 5 }] });

    expect(response.status).toBe(201);
    expect(response.body.projectionPending).toBe(true);
    expect(response.body.orderId).toBe(reply.orderId);
    expect(response.headers.location).toBe(`/orders/${reply.orderId}`);
  });

  it('R42/R26 — POST /orders surfaces a STOCK_UNAVAILABLE business rejection as 409 with shortages', async () => {
    stubs.push(
      await startStubResponder(stubConnection, 'orders.create', () => ({
        code: 'STOCK_UNAVAILABLE',
        message: 'short lines',
        details: { shortages: [{ productCode: 'PRD-0001', requested: 5, available: 2 }] },
      })),
    );

    const response = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [{ productCode: 'PRD-0001', quantity: 5 }] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STOCK_UNAVAILABLE');
    expect(response.body.shortages).toEqual([{ productCode: 'PRD-0001', requested: 5, available: 2 }]);
  });

  it('POST /orders answers 503 UpstreamUnavailable when no orders.create responder is subscribed', async () => {
    const response = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [{ productCode: 'PRD-0001', quantity: 5 }] });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('POST /orders rejects a malformed request body with 400 VALIDATION_FAILED before any RPC call', async () => {
    const response = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(response.body.errors)).toBe(true);
  });

  it('R27/R28 — POST /orders/{id}/cancel translates to orders.cancel (correlationId = the KNOWN order id) and answers 202 with compensationPlanned', async () => {
    const orderId = randomUUID();
    let seenCorrelationId: string | undefined;
    const { JSONCodec } = await import('nats');
    const requestCodec = JSONCodec<{ orderId: string }>();
    const replyCodec = JSONCodec<OrdersCancelReplyPayload>();
    const reply: OrdersCancelReplyPayload = { orderId, orderReference: 'ORD-000042', status: 'stock_reserved', compensationPlanned: ['stock_release'] };
    const sub = stubConnection.subscribe('orders.cancel');
    void (async () => {
      for await (const msg of sub) {
        seenCorrelationId = msg.headers?.get('x-correlation-id');
        requestCodec.decode(msg.data);
        if (msg.reply) {
          msg.respond(replyCodec.encode(reply));
        }
      }
    })();
    await stubConnection.flush();
    stubs.push({ stop: async () => { sub.unsubscribe(); await stubConnection.flush(); } });

    const response = await request(testApp.app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'demo cancel' });

    expect(response.status).toBe(202);
    expect(response.body.compensationPlanned).toEqual(['stock_release']);
    expect(seenCorrelationId).toBe(orderId);
  });
});
