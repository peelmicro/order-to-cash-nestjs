// `orders_cancel_responder` (feature 41, extended by its own follow-up
// pass) — the `orders.cancel` NATS responder proven against real
// MySQL/Kafka/NATS (Testcontainers), reusing `saga-integration-harness.ts`
// (wired with `OrdersCancelController` + `CancelOrderHandler` alongside the
// existing saga machinery, see that file's own comments). Covers all FOUR
// branches, now that the follow-up pass closed the `credit_approved`/
// `confirmed` gap the first pass correctly refused to fake:
//
//   - `placed`                          -> immediate cancel, `operator_cancelled`
//   - `stock_reserved`                  -> `stock.release` (reason
//                                          `order_cancelled`) over REAL NATS,
//                                          completed by a REAL
//                                          `stock.released.v1` fact over REAL
//                                          Kafka — the exact R27/R28
//                                          mechanism, re-triggered
//   - `credit_approved`/`confirmed`     -> `stock.release` over REAL NATS
//                                          FIRST (SA-4: the contested
//                                          resource goes first so
//                                          Fulfillment's one lock can
//                                          arbitrate it against the despatch
//                                          already requested, saga.md §4.3),
//                                          then `credit.release`, proven
//                                          strictly ordered
//   - `despatched`                      -> `ORDER_NOT_CANCELLABLE` (terminal, R8)
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { JSONCodec, type NatsConnection, type Subscription } from 'nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreditHoldReplyPayload,
  CreditHoldRequestPayload,
  CreditReleaseReplyPayload,
  CreditReleaseRequestPayload,
  OrdersCancelReplyPayload,
  RpcError,
  StockReleaseReplyPayload,
  StockReleaseRequestPayload,
  StockReserveReplyPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  publishFact,
  startStubSagaResponders,
  type RecordedRequest,
  type StubSagaResponders,
} from './infrastructure/messaging/test-support/stub-saga-responders';
import {
  CREDIT_HOLD_SUBJECT,
  CREDIT_RELEASE_SUBJECT,
  STOCK_RELEASE_SUBJECT,
  STOCK_RESERVE_SUBJECT,
} from './infrastructure/messaging/nats-saga-commands.adapter';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

const codec = JSONCodec();
const ORDERS_CANCEL_SUBJECT = 'orders.cancel';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`orders-cancel.integration: condition not met within ${timeoutMs}ms`);
}

function isRpcError(reply: OrdersCancelReplyPayload | RpcError): reply is RpcError {
  return typeof (reply as RpcError).code === 'string';
}

/**
 * A DELIBERATELY NARROWER stub than `startStubSagaResponders`: answers ONLY
 * `stock.reserve`/`stock.release` — `credit.hold` has NO responder at all
 * (same "Fulfillment/Billing is down" shape `saga-command-retry.integration.spec.ts`
 * already uses on purpose). Without this, the real saga's own fast path
 * races the operator's cancel decision: the moment `stock.reserved.v1`
 * lands, `credit.hold` is ALSO dispatched immediately (design.md §5.5), and
 * a fully-responsive Billing stub would approve it and advance the order to
 * `credit_approved`/`confirmed` within the same test tick — an entirely
 * real race in production too, just compressed to zero latency by a stub
 * that never blocks. Pinning `stock_reserved` this way isolates the
 * `stock_reserved` branch this feature DOES implement from the
 * `credit_approved`/`confirmed` branch it does NOT (cancel-order.handler.ts's
 * header) — proving the former without the latter's unbuilt path ever
 * entering the picture.
 */
async function startFulfillmentOnlyResponder(
  harness: SagaIntegrationHarness,
): Promise<{ stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[]; stop(): Promise<void> }> {
  const stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[] = [];
  const requestCodec = JSONCodec();

  const reserveSub: Subscription = harness.testNatsConnection.subscribe(STOCK_RESERVE_SUBJECT);
  void (async () => {
    for await (const message of reserveSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as StockReserveRequestPayload;
      const orderId = await harness.resolveOrderId(request.orderReference);
      const reservations = request.lines.map((line) => ({ reservationId: randomUUID(), productCode: line.productCode, units: line.units }));
      await publishFact(harness.fulfillmentFactPublisher, 'stock.reserved.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: request.companyCode,
        reservations,
      });
      const reply: StockReserveReplyPayload = { outcome: 'accepted', orderReference: request.orderReference, reservations };
      message.respond(requestCodec.encode(reply));
    }
  })();

  const releaseSub: Subscription = harness.testNatsConnection.subscribe(STOCK_RELEASE_SUBJECT);
  void (async () => {
    for await (const message of releaseSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as StockReleaseRequestPayload;
      stockReleaseRequests.push({ request, at: new Date() });
      const orderId = await harness.resolveOrderId(request.orderReference);
      await publishFact(harness.fulfillmentFactPublisher, 'stock.released.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: 'COM-0001',
        released: [{ reservationId: randomUUID(), productCode: 'PRD-0001', units: 1 }],
        reason: request.reason,
      });
      const reply: StockReleaseReplyPayload = { outcome: 'released', orderReference: request.orderReference, released: [] };
      message.respond(requestCodec.encode(reply));
    }
  })();

  await harness.testNatsConnection.flush();

  return {
    stockReleaseRequests,
    async stop(): Promise<void> {
      reserveSub.unsubscribe();
      releaseSub.unsubscribe();
      await harness.testNatsConnection.flush();
    },
  };
}

/**
 * A responder set that pins the order at `confirmed` deterministically:
 * answers `stock.reserve` and `credit.hold` — both required for the real
 * saga's own forward progress to REACH `confirmed` (design.md §5.5's
 * automatic `stock.reserved.v1` -> `credit.hold` -> `credit.approved.v1`
 * chain) — plus `credit.release` and `stock.release`, both required to
 * complete THIS branch's reverse-order compensation chain. Deliberately
 * answers NO `despatch.create` — the next command the real saga would
 * issue automatically the instant `credit.approved.v1` lands — so the
 * order cannot race past `confirmed` before the cancel RPC is issued, the
 * same isolation `startFulfillmentOnlyResponder` above already established
 * for the `stock_reserved` branch. `issuedOrder` records EACH request's
 * kind in the exact sequence it was received — the SA-4 ordering proof this
 * test needs: `stock.release` strictly BEFORE `credit.release`, not merely
 * "both eventually happen".
 */
async function startBillingApprovedOnlyResponder(harness: SagaIntegrationHarness): Promise<{
  issuedOrder: string[];
  creditReleaseRequests: RecordedRequest<CreditReleaseRequestPayload>[];
  stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[];
  stop(): Promise<void>;
}> {
  const issuedOrder: string[] = [];
  const creditReleaseRequests: RecordedRequest<CreditReleaseRequestPayload>[] = [];
  const stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[] = [];
  const requestCodec = JSONCodec();

  const reserveSub: Subscription = harness.testNatsConnection.subscribe(STOCK_RESERVE_SUBJECT);
  void (async () => {
    for await (const message of reserveSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as StockReserveRequestPayload;
      const orderId = await harness.resolveOrderId(request.orderReference);
      const reservations = request.lines.map((line) => ({ reservationId: randomUUID(), productCode: line.productCode, units: line.units }));
      await publishFact(harness.fulfillmentFactPublisher, 'stock.reserved.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: request.companyCode,
        reservations,
      });
      const reply: StockReserveReplyPayload = { outcome: 'accepted', orderReference: request.orderReference, reservations };
      message.respond(requestCodec.encode(reply));
    }
  })();

  const holdSub: Subscription = harness.testNatsConnection.subscribe(CREDIT_HOLD_SUBJECT);
  void (async () => {
    for await (const message of holdSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as CreditHoldRequestPayload;
      const orderId = await harness.resolveOrderId(request.orderReference);
      const creditCode = `CR-${randomUUID().slice(0, 6)}`;
      await publishFact(harness.billingFactPublisher, 'credit.approved.v1', orderId, {
        orderReference: request.orderReference,
        retailerCode: request.retailerCode,
        companyCode: request.companyCode,
        creditCode,
        currency: request.amount.currency,
        heldAmount: request.amount.amount,
      });
      const reply: CreditHoldReplyPayload = {
        outcome: 'approved',
        orderReference: request.orderReference,
        creditCode,
        currency: request.amount.currency,
        heldAmount: request.amount.amount,
        availableCredit: 1_000_000,
      };
      message.respond(requestCodec.encode(reply));
    }
  })();

  const releaseCreditSub: Subscription = harness.testNatsConnection.subscribe(CREDIT_RELEASE_SUBJECT);
  void (async () => {
    for await (const message of releaseCreditSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as CreditReleaseRequestPayload;
      creditReleaseRequests.push({ request, at: new Date() });
      issuedOrder.push('credit.release');
      const orderId = await harness.resolveOrderId(request.orderReference);
      await publishFact(harness.billingFactPublisher, 'credit.released.v1', orderId, {
        orderReference: request.orderReference,
        retailerCode: request.retailerCode,
        companyCode: request.companyCode,
        currency: 'EUR',
        releasedAmount: 2_000,
        availableCreditAfter: 1_000_000,
        reason: 'order_cancelled',
      });
      const reply: CreditReleaseReplyPayload = {
        released: true,
        orderReference: request.orderReference,
        currency: 'EUR',
        releasedAmount: 2_000,
        availableCreditAfter: 1_000_000,
      };
      message.respond(requestCodec.encode(reply));
    }
  })();

  const releaseStockSub: Subscription = harness.testNatsConnection.subscribe(STOCK_RELEASE_SUBJECT);
  void (async () => {
    for await (const message of releaseStockSub) {
      if (!message.reply) continue;
      const request = requestCodec.decode(message.data) as StockReleaseRequestPayload;
      stockReleaseRequests.push({ request, at: new Date() });
      issuedOrder.push('stock.release');
      const orderId = await harness.resolveOrderId(request.orderReference);
      await publishFact(harness.fulfillmentFactPublisher, 'stock.released.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: 'COM-0001',
        released: [{ reservationId: randomUUID(), productCode: 'PRD-0001', units: 1 }],
        reason: request.reason,
      });
      const reply: StockReleaseReplyPayload = { outcome: 'released', orderReference: request.orderReference, released: [] };
      message.respond(requestCodec.encode(reply));
    }
  })();

  await harness.testNatsConnection.flush();

  return {
    issuedOrder,
    creditReleaseRequests,
    stockReleaseRequests,
    async stop(): Promise<void> {
      reserveSub.unsubscribe();
      holdSub.unsubscribe();
      releaseCreditSub.unsubscribe();
      releaseStockSub.unsubscribe();
      await harness.testNatsConnection.flush();
    },
  };
}

describe('orders.cancel — operator-initiated cancellation (Testcontainers: real MySQL + Kafka + NATS)', () => {
  let harness: SagaIntegrationHarness;
  let cancelConnection: NatsConnection;
  let responders: StubSagaResponders | undefined;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness({
      dispatcherConfig: { timeoutMs: 3000, maxAttempts: 3, backoffBaseMs: 50 },
    });
    cancelConnection = await harness.natsFixture.connect();
  }, 300_000);

  afterEach(async () => {
    await responders?.stop();
    responders = undefined;
  });

  afterAll(async () => {
    await cancelConnection?.close();
    await harness?.teardown();
  }, 120_000);

  async function requestCancel(payload: unknown): Promise<OrdersCancelReplyPayload | RpcError> {
    const reply = await cancelConnection.request(ORDERS_CANCEL_SUBJECT, codec.encode(payload), { timeout: 10_000 });
    return codec.decode(reply.data) as OrdersCancelReplyPayload | RpcError;
  }

  async function orderStatus(orderId: string): Promise<string | undefined> {
    const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
    return row?.status;
  }

  it('OCR-placed — cancels a placed order immediately over the real wire', async () => {
    const order = await harness.placeOrder();

    const reply = await requestCancel({ orderId: order.id.value, reason: 'operator_cancelled', note: 'wire test' });

    expect(isRpcError(reply)).toBe(false);
    const success = reply as OrdersCancelReplyPayload;
    expect(success.status).toBe('cancelled');
    expect(success.cancellationReason).toBe('operator_cancelled');
    expect(success.compensationPlanned).toEqual([]);

    expect(await orderStatus(order.id.value)).toBe('cancelled');
  });

  it('OCR-stock_reserved — issues stock.release over real NATS; a real stock.released.v1 over real Kafka completes the cancellation', async () => {
    // `credit.hold` deliberately has NO responder — see
    // `startFulfillmentOnlyResponder`'s own header for why: it isolates
    // this branch from the race against the saga's own forward progression.
    const fulfillmentOnly = await startFulfillmentOnlyResponder(harness);

    const order = await harness.placeOrderAndRelay();
    // Drive the order to stock_reserved via the REAL saga (the stub
    // fulfillment responder answers stock.reserve and publishes
    // stock.reserved.v1 over real Kafka, which the app's own Kafka
    // consumer picks up).
    await waitFor(async () => (await orderStatus(order.id.value)) === 'stock_reserved');

    const reply = await requestCancel({ orderId: order.id.value, reason: 'operator_cancelled' });

    expect(isRpcError(reply)).toBe(false);
    const success = reply as OrdersCancelReplyPayload;
    expect(success.status).toBe('stock_reserved');
    expect(success.compensationPlanned).toEqual(['stock_release']);
    expect(success).not.toHaveProperty('cancellationReason');

    // Still stock_reserved immediately after the reply — cancellation is
    // NOT synchronous with the RPC reply for this branch (saga.md §4.3.1's
    // "release first, cancel second" ordering, reused for the operator path).
    expect(await orderStatus(order.id.value)).toBe('stock_reserved');

    // The stub fulfillment responder answers stock.release with reason
    // 'order_cancelled' echoed back, then publishes a REAL stock.released.v1
    // over REAL Kafka — the app's saga consumer group picks it up and,
    // because saga-steps.ts's stock.released.v1 step was already
    // reason-parametric (mapReason), completes the cancellation.
    await waitFor(async () => (await orderStatus(order.id.value)) === 'cancelled');
    expect(
      fulfillmentOnly.stockReleaseRequests.some(
        (r) => r.request.orderReference === order.orderReference.value && r.request.reason === 'order_cancelled',
      ),
    ).toBe(true);

    await fulfillmentOnly.stop();
  }, 60_000);

  it('OCR-stock-first (SA-4) — issues stock.release strictly BEFORE credit.release (the contested resource first, saga.md §4.3); real stock.released.v1 + credit.released.v1 facts over real Kafka complete the cancellation', async () => {
    // `despatch.create` deliberately has NO responder — see
    // `startBillingApprovedOnlyResponder`'s own header for why: it isolates
    // this branch from the saga's own forward progress past `confirmed`.
    const billingApproved = await startBillingApprovedOnlyResponder(harness);

    const order = await harness.placeOrderAndRelay();
    // Drive the order to confirmed via the REAL saga (stock.reserve ->
    // stock.reserved.v1 -> credit.hold -> credit.approved.v1, which
    // applies BOTH approveCredit and confirm before ONE save — the order
    // is never observably `credit_approved` in the database, only
    // `confirmed`, per saga-steps.ts's own credit.approved.v1 step).
    await waitFor(async () => (await orderStatus(order.id.value)) === 'confirmed');

    const reply = await requestCancel({ orderId: order.id.value, reason: 'operator_cancelled' });

    expect(isRpcError(reply)).toBe(false);
    const success = reply as OrdersCancelReplyPayload;
    expect(success.status).toBe('confirmed');
    expect(success.compensationPlanned).toEqual(['stock_release', 'credit_release']);
    expect(success).not.toHaveProperty('cancellationReason');

    // Still confirmed immediately after the reply — cancellation is NOT
    // synchronous with the RPC reply for this branch either (the same
    // "release first, cancel later" ordering every compensation branch
    // uses).
    expect(await orderStatus(order.id.value)).toBe('confirmed');

    // SA-4's ordering proof: wait for the full chain to complete, then
    // assert stock.release was issued STRICTLY BEFORE credit.release — the
    // exact sequence, not merely that both eventually happened.
    await waitFor(async () => (await orderStatus(order.id.value)) === 'cancelled');
    expect(billingApproved.issuedOrder).toEqual(['stock.release', 'credit.release']);

    expect(billingApproved.creditReleaseRequests).toHaveLength(1);
    expect(billingApproved.creditReleaseRequests[0]!.request).toMatchObject({
      orderReference: order.orderReference.value,
      retailerCode: order.retailerCode,
      companyCode: order.companyCode,
    });
    expect(billingApproved.stockReleaseRequests).toHaveLength(1);
    expect(billingApproved.stockReleaseRequests[0]!.request).toMatchObject({
      orderReference: order.orderReference.value,
      reason: 'order_cancelled',
    });

    await billingApproved.stop();
  }, 60_000);

  it('OCR-terminal — despatched onwards replies ORDER_NOT_CANCELLABLE, order status untouched', async () => {
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
    );

    const order = await harness.placeOrderAndRelay();
    // "at least despatched", not "exactly confirmed then despatched" — the
    // fully-responsive stub chain can outrun a single poll between two
    // sequential exact-match waits (same reasoning as
    // saga-happy-path.integration.spec.ts's own `waitUntilAtLeast`).
    const DESPATCHED_OR_LATER = new Set(['despatched', 'invoiced', 'paid', 'completed']);
    await waitFor(async () => DESPATCHED_OR_LATER.has((await orderStatus(order.id.value)) ?? ''));
    const statusBeforeCancel = await orderStatus(order.id.value);
    expect(DESPATCHED_OR_LATER.has(statusBeforeCancel ?? '')).toBe(true);

    const reply = await requestCancel({ orderId: order.id.value, reason: 'operator_cancelled' });

    expect(isRpcError(reply)).toBe(true);
    expect((reply as RpcError).code).toBe('ORDER_NOT_CANCELLABLE');

    // "order status untouched" (R8/R9) — whatever despatched-or-later
    // status the order had already reached (the fully-responsive stub
    // chain may keep advancing it in the background, unrelated to this
    // rejected cancel attempt), the rejected cancel itself changed nothing:
    // never `cancelled`, and never regressed either.
    const statusAfterCancel = await orderStatus(order.id.value);
    expect(statusAfterCancel).not.toBe('cancelled');
    expect(DESPATCHED_OR_LATER.has(statusAfterCancel ?? '')).toBe(true);
  }, 60_000);
});
