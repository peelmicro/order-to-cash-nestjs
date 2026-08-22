// R27, R28, SO6, SO7 — compensation path B: credit.rejected.v1 leaves the
// order in stock_reserved and owes stock.release; stock.released.v1 then
// cancels with one stock_released compensation step built from the
// observed fact. The business-rejected credit.hold is marked sent and
// never retried (SO6) — the saga advances only on the credit.rejected.v1
// FACT, not the reply.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  publishFact,
  startStubSagaResponders,
  type StubSagaResponders,
} from './infrastructure/messaging/test-support/stub-saga-responders';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): the harness now blocks
// `beforeAll` on `waitForConsumerGroupReady` (saga-integration-harness.ts),
// so the "coordinator loading" crash/restart cost this spec used to pay
// out of THIS budget is paid once, up front, inside beforeAll's own
// container boot plus several ~3s Kafka consumer-group joins plus
// dispatcher retry backoff, and must stay under vitest's 180s `testTimeout`
// so a true hang still fails fast. What is left inside each `waitFor` call
// is genuine hop latency only: test 2's heaviest chain is order.placed.v1
// (Kafka consume) -> stock.reserve (NATS RPC) -> stock.reserved.v1 (Kafka)
// -> credit.hold (NATS RPC, rejected — SO6, not retried) ->
// credit.rejected.v1 (Kafka) -> stock.release (NATS RPC) ->
// stock.released.v1 (Kafka) -> cancelled — 4 Kafka round trips + 3 NATS
// round trips, each observed sub-second once the consumer group is Stable.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-compensation-credit-rejected: condition not met within ${timeoutMs}ms`);
}

async function orderRow(harness: SagaIntegrationHarness, orderId: string) {
  const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
  return row;
}

describe('saga-compensation-credit-rejected — R27, R28, SO6, SO7 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let harness: SagaIntegrationHarness;
  let responders: StubSagaResponders;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness();
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
      { rejectCreditHold: true },
    );
  }, 300_000);

  afterAll(async () => {
    await responders?.stop();
    await harness?.teardown();
  }, 120_000);

  it('does not retry a business-rejected credit.hold and advances only on the credit.rejected.v1 fact', async () => {
    const order = await harness.placeOrderAndRelay();

    await waitFor(async () => responders.creditHoldRequests.length > 0);

    // SO6 (durable evidence, replacing a race): the original assertion
    // here polled `orders.status === 'stock_reserved'` as a synchronisation
    // barrier before checking for retries below. That status is only held
    // *transiently* — the sibling test in this file proves the full
    // credit.rejected -> stock.release -> cancelled round trip can complete
    // in well under one 200ms poll interval — so on a fast run the poll can
    // miss the window entirely and hang until timeout on a state that has
    // already passed. That is a race in the TEST, not in the saga (see the
    // 2026-08-21 addendum in progress/impl_order_saga_orchestrator.md).
    // The `saga_commands` row for `credit.hold` gives the same
    // synchronisation point without the race: once the dispatcher marks it
    // `sent` that status is terminal for this row (design.md §6.3 — one row
    // per (order_id, command), `markSent` never revisits a `sent` row), so
    // there is no window to miss, unlike a live column the saga races
    // through. R27's "status stays stock_reserved from the reply alone"
    // clause (the aggregate-state half of SO6) is proven directly, without
    // any polling race, at the unit level by saga-steps.spec.ts, and the
    // end-to-end causal ordering is proven by the sibling test below; this
    // barrier exists only to gate the retry check that follows.
    await waitFor(async () => {
      const rows = await harness.db
        .select()
        .from(ordersSchema.sagaCommands)
        .where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
      return rows.find((row) => row.command === 'credit.hold')?.status === 'sent';
    });

    // SO6 — the business rejection was marked sent, never retried: give it
    // a moment and assert exactly one request was ever recorded. This is
    // itself non-racy: `creditHoldRequests` only ever grows, so waiting out
    // the grace period and then reading its length cannot land on a window
    // that has already passed the way a live status poll can.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(responders.creditHoldRequests).toHaveLength(1);

    const commandRows = await harness.db
      .select()
      .from(ordersSchema.sagaCommands)
      .where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
    const creditHoldRow = commandRows.find((row) => row.command === 'credit.hold');
    expect(creditHoldRow?.status).toBe('sent');
  }, 60_000);

  it('release-then-cancel in causal order, with one stock_released compensation step built from the observed fact (R27, R28, SO7)', async () => {
    const order = await harness.placeOrderAndRelay();

    // credit.rejected.v1 owes stock.release — R27's "status unchanged"
    // clause is proven directly by saga-steps.spec.ts; here we prove the
    // end-to-end causal order instead: release happens, THEN cancellation,
    // strictly on the observed stock.released.v1 fact (not on the reply).
    await waitFor(async () => responders.stockReleaseRequests.length > 0);
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status === 'cancelled');
    const row = await orderRow(harness, order.id.value);
    expect(row).toMatchObject({ status: 'cancelled', cancellationReason: 'credit_rejected' });

    const outboxRows = await harness.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    const cancelledFact = outboxRows.find((r) => r.eventType === 'order.cancelled.v1');
    expect(cancelledFact).toBeDefined();
    const payload = cancelledFact?.payload as { compensationSteps: Array<Record<string, unknown>> };
    expect(payload.compensationSteps).toHaveLength(1);
    expect(payload.compensationSteps[0]).toMatchObject({ step: 'stock_released', eventType: 'stock.released.v1' });

    const stockReleaseRequest = responders.stockReleaseRequests[0]?.request;
    expect(stockReleaseRequest?.reason).toBe('credit_rejected');
  }, 60_000);
}, 300_000);

// FS1/D1 — the reviewer's P3 crash-loop reproduction (progress/review_order_saga_orchestrator.md):
// a distinct-eventId duplicate of a fact whose precondition still holds (here,
// credit.rejected.v1 redelivered mid-compensation, while stock.release sits
// PARKED because no responder answers it) must not violate
// uq_saga_commands_order_command, must not crash the Kafka consumer, and must
// re-dispatch the SAME existing row rather than creating a second one. Own
// harness/containers: this scenario needs stock.release to have NO responder,
// which the shared beforeAll's responders (this file's first describe) do not
// provide.
describe('saga-compensation-credit-rejected — FS1/D1: a duplicate credit.rejected.v1 mid-compensation (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let harness: SagaIntegrationHarness;
  let responders: StubSagaResponders;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness({
      // Fast, bounded retry/park budget so a `stock.release` with no
      // responder reaches `parked` well inside this test's own timeout.
      dispatcherConfig: { timeoutMs: 500, maxAttempts: 3, backoffBaseMs: 20, parkRetryCapMs: 2_000 },
    });
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
      { rejectCreditHold: true, respondToStockRelease: false },
    );
  }, 300_000);

  afterAll(async () => {
    await responders?.stop();
    await harness?.teardown();
  }, 120_000);

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`saga-compensation-credit-rejected FS1/D1: condition not met within ${timeoutMs}ms`);
  }

  async function releaseRow(orderId: string) {
    const rows = await harness.db
      .select()
      .from(ordersSchema.sagaCommands)
      .where(and(eq(ordersSchema.sagaCommands.orderId, orderId), eq(ordersSchema.sagaCommands.command, 'stock.release')));
    return rows[0];
  }

  async function processedEventsCount(): Promise<number> {
    const rows = await harness.db.select().from(ordersSchema.processedEvents).where(eq(ordersSchema.processedEvents.consumer, 'orders.saga'));
    return rows.length;
  }

  it('a distinct-eventId duplicate of credit.rejected.v1 mid-compensation neither crashes the consumer nor creates a second stock.release row, and the existing row is re-dispatched', async () => {
    const order = await harness.placeOrderAndRelay();

    // stock.release stays parked — no responder is subscribed
    // (`respondToStockRelease: false`) — so the in-line dispatcher's 3
    // attempts all fail with NoResponders and the row parks. `parked` is
    // terminal for this row until the (disabled) sweeper next runs, so
    // waiting on it is durable/monotonic evidence, not a transient poll.
    await waitFor(async () => (await releaseRow(order.id.value))?.status === 'parked');

    const original = await releaseRow(order.id.value);
    expect(original).toBeDefined();
    const originalId = original!.id;
    const originalAttempts = original!.attempts;
    const baselineProcessed = await processedEventsCount();

    // A distinct-eventId redelivery of credit.rejected.v1 — same
    // correlationId (the order), same payload shape, a fact whose
    // precondition (order.status === 'stock_reserved') still holds because
    // the first delivery's compensation never completed (stock.release
    // never got a reply). Before D1 this crashed the consumer on
    // ER_DUP_ENTRY against uq_saga_commands_order_command.
    await publishFact(harness.billingFactPublisher, 'credit.rejected.v1', order.id.value, {
      orderReference: order.orderReference.value,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: 'EUR',
      reason: 'over_limit',
    });

    // Durable, append-only evidence that the duplicate was consumed (not
    // ignored, not crashed) rather than polling a transient status.
    await waitFor(async () => (await processedEventsCount()) > baselineProcessed);

    // D1's whole point: still exactly one stock.release row, same id — not
    // reset, not duplicated — and it was re-dispatched (attempts climbed
    // again from the fast path's retry loop rather than staying frozen).
    const allReleaseRows = await harness.db
      .select()
      .from(ordersSchema.sagaCommands)
      .where(
        and(eq(ordersSchema.sagaCommands.orderId, order.id.value), eq(ordersSchema.sagaCommands.command, 'stock.release')),
      );
    expect(allReleaseRows).toHaveLength(1);
    expect(allReleaseRows[0]?.id).toBe(originalId);

    await waitFor(async () => {
      const row = await releaseRow(order.id.value);
      return row?.status === 'parked' && row.attempts > originalAttempts;
    });

    // The order is untouched by the duplicate: no crash, no premature
    // cancellation, still stock_reserved (compensation never completed).
    const [orderRow] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value));
    expect(orderRow?.status).toBe('stock_reserved');
  }, 60_000);
}, 300_000);
