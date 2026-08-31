// R1 (`specs/shared/requirements.md`) — "THE SYSTEM SHALL represent every
// monetary amount as an integer count of minor units together with an ISO
// 4217 alpha-3 currency code ... in every API response." The domain half of
// R1 is `packages/shared-kernel/src/domain/money.spec.ts`; this file is the
// API half, which `progress/review_traceability_audit.md` §5 found had NO
// test anywhere — the nearest evidence was incidental and per-field
// (`apps/gateway/src/black-box-api.integration.spec.ts:489`
// `expect(placed.totalAmount).toBe(49_998)`), which proves THAT amount in
// THAT response, never the universal claim R1 actually makes.
//
// This is a GENERAL black-box sweep, not a per-field assertion list: for
// every money-bearing endpoint below, `sweepForMoneyFields`
// (`test-support/money-field-sweep.ts`) walks the real HTTP response body
// and DISCOVERS every field it recognises as monetary by shape (an amount
// travelling beside its own currency, or a number living under an ancestor
// object's declared currency — see that module's header for the full
// reasoning and the deliberate name-based exception it takes for the
// canonical `Money.amount` key). Nothing here names `totalAmount`,
// `creditLimit`, etc. as an expectation — a future field renamed or added
// to the wire is swept automatically, which is the whole point.
//
// Boot pattern copied verbatim from `orders.integration.spec.ts` and
// `billing-fulfillment.integration.spec.ts` (Group B/C: `bootGatewayTestApp`
// over a REAL, spawned Gateway `TestingModule`, real NATS, real MongoDB;
// Orders/Billing are NOT spawned — their RPC responders are TEST-ONLY stubs,
// since this file, like those, tests the GATEWAY's own wire shaping, never
// another service's behaviour). Deliberately NOT the full 5-process fleet
// `black-box-api.integration.spec.ts` spawns — R1's claim is about SHAPE,
// which the Gateway alone decides on every response it hands back,
// regardless of which upstream produced the payload.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { CreditListReplyPayload, InvoiceListReplyPayload, OrdersCreateReplyPayload } from '@otc/contracts';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { startStubResponder, type StubResponder } from './test-support/stub-rpc-responder';
import type { OrderTimelineDocumentLike } from './domain/projection/order-read-model-mapper';
import { sweepForMoneyFields, type MoneyFinding } from './test-support/money-field-sweep';

const ISO_CURRENCY_SHAPE = /^[A-Z]{3}$/;

function seedOrderDocForSweep(overrides: Partial<OrderTimelineDocumentLike> = {}): OrderTimelineDocumentLike {
  const orderId = overrides.orderId ?? randomUUID();
  return {
    _id: orderId,
    orderId,
    orderReference: 'ORD-000777',
    orderDate: '2026-08-18T09:00:00.000Z',
    retailer: { code: 'CarrefourEs', name: 'Carrefour ES', gln: '8412345000013' },
    company: { code: 'IBERFOODS', name: 'Iberfoods', gln: '8412345000020' },
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    // Nested one level down (`totals` carries no `currency` of its own —
    // exactly the ancestor-inherited pattern this sweep must catch).
    totals: { initialAmount: 217_450, initialDiscount: 3_500, totalAmount: 213_950 },
    // Nested inside an array two levels down (`items[]` entries carry no
    // `currency` of their own either).
    items: [{ productCode: 'PRD-0001', quantity: 5, unitPrice: 43_490, lineDiscount: 700 }],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    events: [{ eventId: randomUUID(), eventType: 'order.placed.v1', occurredAt: '2026-08-18T09:00:00.000Z', summary: 'Order placed' }],
    headerComplete: true,
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

/** Every finding in `findings` must be an integer amount with an ISO-4217-shaped currency — the two clauses R1's wording actually makes. */
function assertEveryFindingIsIntegerMinorUnitsWithCurrency(endpointLabel: string, findings: readonly MoneyFinding[]): void {
  expect(
    findings.length,
    `expected at least one monetary field discovered in ${endpointLabel}'s response — found none, which would make this sweep vacuous rather than proving R1`,
  ).toBeGreaterThan(0);

  for (const finding of findings) {
    expect(
      Number.isInteger(finding.amount),
      `${endpointLabel} ${finding.path}: R1 requires an integer count of minor units, got ${JSON.stringify(finding.amount)} (typeof ${typeof finding.amount})`,
    ).toBe(true);
    expect(
      typeof finding.currency === 'string' && ISO_CURRENCY_SHAPE.test(finding.currency),
      `${endpointLabel} ${finding.path}: R1 requires an ISO 4217 alpha-3 currency code accompanying the amount, got ${JSON.stringify(finding.currency)}`,
    ).toBe(true);
  }
}

describe('money_representation (R1, API half) — every monetary field of every response the Gateway hands back', () => {
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

  function auth() {
    return { Authorization: `Bearer ${token}` };
  }

  it('every monetary field of every response is an integer accompanied by a currency code', async () => {
    const findingsByEndpoint: Record<string, MoneyFinding[]> = {};

    // ── POST /orders — orders.create is stubbed; the Gateway's own
    //    translation of THAT reply into the wire response is what is under
    //    test (`OrdersCreateReplyPayload` -> `PlaceOrderResponse`). ───────
    const createReply: OrdersCreateReplyPayload = {
      orderId: randomUUID(),
      orderReference: 'ORD-000778',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 217_450,
      initialDiscount: 3_500,
      totalAmount: 213_950,
      orderDate: '2026-08-18T10:00:00.000Z',
    };
    stubs.push(await startStubResponder(stubConnection, 'orders.create', () => createReply));
    const placeResponse = await request(testApp.app.getHttpServer())
      .post('/orders')
      .set(auth())
      .send({ retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', lines: [{ productCode: 'PRD-0001', quantity: 5 }] });
    expect(placeResponse.status).toBe(201);
    findingsByEndpoint['POST /orders'] = sweepForMoneyFields(placeResponse.body);

    // ── GET /orders/{id} and GET /orders — both read directly off the
    //    projected MongoDB document (R54), never off a stub. ────────────
    const doc = seedOrderDocForSweep();
    await testApp.db.collection('order_timeline').insertOne(doc as never);

    const detailResponse = await request(testApp.app.getHttpServer()).get(`/orders/${doc.orderId}`).set(auth());
    expect(detailResponse.status).toBe(200);
    findingsByEndpoint['GET /orders/{id}'] = sweepForMoneyFields(detailResponse.body);

    const listResponse = await request(testApp.app.getHttpServer()).get('/orders').set(auth());
    expect(listResponse.status).toBe(200);
    findingsByEndpoint['GET /orders'] = sweepForMoneyFields(listResponse.body);

    // ── GET /invoices — billing.invoice.list is stubbed. ────────────────
    const invoiceListReply: InvoiceListReplyPayload = {
      items: [
        {
          invoiceId: randomUUID(),
          invoiceReference: 'INV-000091',
          invoiceDate: '2026-08-18T09:00:00.000Z',
          orderReference: 'ORD-000778',
          retailerCode: 'CarrefourEs',
          companyCode: 'IBERFOODS',
          currency: 'EUR',
          amount: 217_450,
          discount: 3_500,
          totalAmount: 213_950,
          status: 'issued',
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
    };
    stubs.push(await startStubResponder(stubConnection, 'billing.invoice.list', () => invoiceListReply));
    const invoicesResponse = await request(testApp.app.getHttpServer()).get('/invoices').set(auth());
    expect(invoicesResponse.status).toBe(200);
    findingsByEndpoint['GET /invoices'] = sweepForMoneyFields(invoicesResponse.body);

    // ── GET /credits — billing.credit.list is stubbed. Note the four
    //    money fields here (`creditLimit`/`activeHolds`/`openExposure`/
    //    `availableCredit`) share none of the vocabulary `/orders` or
    //    `/invoices` use — exactly the case a name-based recogniser would
    //    have missed and the shape-based one does not. ───────────────────
    const creditListReply: CreditListReplyPayload = {
      items: [
        {
          creditCode: 'CR-000001',
          retailerCode: 'CarrefourEs',
          companyCode: 'IBERFOODS',
          currency: 'EUR',
          creditLimit: 1_000_000,
          activeHolds: 213_950,
          openExposure: 0,
          availableCredit: 786_050,
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
    };
    stubs.push(await startStubResponder(stubConnection, 'billing.credit.list', () => creditListReply));
    const creditsResponse = await request(testApp.app.getHttpServer()).get('/credits').set(auth());
    expect(creditsResponse.status).toBe(200);
    findingsByEndpoint['GET /credits'] = sweepForMoneyFields(creditsResponse.body);

    // ── The assertion, applied uniformly, per endpoint. ──────────────────
    for (const [endpointLabel, findings] of Object.entries(findingsByEndpoint)) {
      assertEveryFindingIsIntegerMinorUnitsWithCurrency(endpointLabel, findings);
    }
  });
});
