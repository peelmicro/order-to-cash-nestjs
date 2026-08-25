// Group B (RPC list queries — GET /stock, GET /invoices, GET /credits are
// LIVE reads of Fulfillment's/Billing's write models, openapi.yaml's own
// words, never the read model) + Group C (POST /stock/replenish,
// POST /invoices/{id}/payments) — real NATS + real MongoDB, Fulfillment's/
// Billing's responders answered by TEST-ONLY stubs.
import { randomUUID } from 'node:crypto';
import { JSONCodec } from 'nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { InvoiceListReplyPayload, PaymentRegisterRequestPayload } from '@otc/contracts';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { startStubResponder, type StubResponder } from './test-support/stub-rpc-responder';
import type { OrderTimelineDocumentLike } from './domain/projection/order-read-model-mapper';

describe('Gateway stock/invoices/credits — Group B (live RPC reads) + Group C (RPC commands)', () => {
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

  it('GET /stock translates to fulfillment.stock.list', async () => {
    stubs.push(
      await startStubResponder(stubConnection, 'fulfillment.stock.list', () => ({
        items: [{ companyCode: 'IBERFOODS', productCode: 'PRD-0001', units: 100, reservedUnits: 5, availableUnits: 95, lowStockThreshold: 20 }],
        page: { page: 1, pageSize: 25, total: 1 },
      })),
    );

    const response = await request(testApp.app.getHttpServer()).get('/stock').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
  });

  it('R61 — POST /stock/replenish translates to fulfillment.stock.replenish', async () => {
    stubs.push(
      await startStubResponder(stubConnection, 'fulfillment.stock.replenish', () => ({
        items: [{ companyCode: 'IBERFOODS', productCode: 'PRD-0001', units: 200, reservedUnits: 5, availableUnits: 195, lowStockThreshold: 20 }],
      })),
    );

    const response = await request(testApp.app.getHttpServer())
      .post('/stock/replenish')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyCode: 'IBERFOODS', lines: [{ productCode: 'PRD-0001', units: 100 }] });

    expect(response.status).toBe(200);
    expect(response.body.items[0].units).toBe(200);
  });

  it('GET /invoices translates to billing.invoice.list', async () => {
    stubs.push(
      await startStubResponder(stubConnection, 'billing.invoice.list', () => ({
        items: [
          {
            invoiceId: randomUUID(),
            invoiceReference: 'INV-000027',
            invoiceDate: '2026-08-18T09:00:00.000Z',
            orderReference: 'ORD-000042',
            retailerCode: 'CarrefourEs',
            companyCode: 'IBERFOODS',
            currency: 'EUR',
            amount: 124250,
            discount: 0,
            totalAmount: 124250,
            status: 'issued',
          },
        ],
        page: { page: 1, pageSize: 25, total: 1 },
      })),
    );

    const response = await request(testApp.app.getHttpServer()).get('/invoices').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].orderReference).toBe('ORD-000042');
  });

  it('GET /credits translates to billing.credit.list', async () => {
    stubs.push(
      await startStubResponder(stubConnection, 'billing.credit.list', () => ({
        items: [
          {
            creditCode: 'CR-000001',
            retailerCode: 'CarrefourEs',
            companyCode: 'IBERFOODS',
            currency: 'EUR',
            creditLimit: 1000000,
            activeHolds: 0,
            openExposure: 0,
            availableCredit: 1000000,
          },
        ],
        page: { page: 1, pageSize: 25, total: 1 },
      })),
    );

    const response = await request(testApp.app.getHttpServer()).get('/credits').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
  });

  it('every catalog endpoint answers 503 UPSTREAM_UNAVAILABLE without a live catalog.reference.list responder (the recorded gap)', async () => {
    for (const path of ['/catalog/products', '/catalog/retailers', '/catalog/companies']) {
      const response = await request(testApp.app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(503);
    }
  });

  describe('POST /invoices/{id}/payments — R47-R49, and the correlationId=orderId resolution gap', () => {
    it('resolves invoiceId -> orderReference (billing.invoice.list) -> orderId (Mongo read model _id), sends it as x-correlation-id, and answers 201', async () => {
      const invoiceId = randomUUID();
      const orderDoc: OrderTimelineDocumentLike = {
        _id: 'order-1',
        orderId: 'order-1',
        orderReference: 'ORD-000042',
        orderDate: '2026-08-18T09:00:00.000Z',
        retailer: { code: 'CarrefourEs', name: null, gln: null },
        company: { code: 'IBERFOODS', name: null, gln: null },
        status: 'invoiced',
        cancellationReason: null,
        currency: 'EUR',
        totals: { initialAmount: 124250, initialDiscount: 0, totalAmount: 124250 },
        items: [],
        references: { despatchReference: null, invoiceReference: 'INV-000027', paymentReference: null },
        events: [],
        headerComplete: true,
        updatedAt: '2026-08-18T09:00:00.000Z',
      };
      await testApp.db.collection('order_timeline').insertOne(orderDoc as never);

      const listReply: InvoiceListReplyPayload = {
        items: [
          {
            invoiceId,
            invoiceReference: 'INV-000027',
            invoiceDate: '2026-08-18T09:00:00.000Z',
            orderReference: 'ORD-000042',
            retailerCode: 'CarrefourEs',
            companyCode: 'IBERFOODS',
            currency: 'EUR',
            amount: 124250,
            discount: 0,
            totalAmount: 124250,
            status: 'issued',
          },
        ],
        page: { page: 1, pageSize: 200, total: 1 },
      };
      stubs.push(await startStubResponder(stubConnection, 'billing.invoice.list', () => listReply));

      let seenCorrelationId: string | undefined;
      let seenPayload: PaymentRegisterRequestPayload | undefined;
      const requestCodec = JSONCodec<PaymentRegisterRequestPayload>();
      const replyCodec = JSONCodec<Record<string, unknown>>();
      const sub = stubConnection.subscribe('billing.payment.register');
      void (async () => {
        for await (const msg of sub) {
          seenCorrelationId = msg.headers?.get('x-correlation-id');
          seenPayload = requestCodec.decode(msg.data);
          if (msg.reply) {
            msg.respond(
              replyCodec.encode({
                outcome: 'accepted',
                paymentReference: seenPayload.paymentReference,
                invoiceReference: 'INV-000027',
                orderReference: 'ORD-000042',
                invoiceStatus: 'paid',
                paidAt: '2026-08-18T11:02:00.000Z',
              }),
            );
          }
        }
      })();
      await stubConnection.flush();
      stubs.push({ stop: async () => { sub.unsubscribe(); await stubConnection.flush(); } });

      const response = await request(testApp.app.getHttpServer())
        .post(`/invoices/${invoiceId}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          paymentReference: 'PAY-2026-08-18-000019',
          amount: { amount: 124250, currency: 'EUR' },
          valueDate: '2026-08-18T11:02:00.000Z',
          source: 'robot',
        });

      expect(response.status).toBe(201);
      expect(response.body.outcome).toBe('accepted');
      expect(response.headers['x-correlation-id']).toBe('order-1');
      expect(seenCorrelationId).toBe('order-1');
      expect(seenPayload?.invoiceId).toBe(invoiceId);
    });

    it('answers 404 when no invoice in billing.invoice.list matches the given id', async () => {
      stubs.push(await startStubResponder(stubConnection, 'billing.invoice.list', () => ({ items: [], page: { page: 1, pageSize: 200, total: 0 } })));

      const response = await request(testApp.app.getHttpServer())
        .post(`/invoices/${randomUUID()}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ paymentReference: 'PAY-1', amount: { amount: 100, currency: 'EUR' }, valueDate: '2026-08-18T11:02:00.000Z', source: 'robot' });

      expect(response.status).toBe(404);
    });
  });
});
