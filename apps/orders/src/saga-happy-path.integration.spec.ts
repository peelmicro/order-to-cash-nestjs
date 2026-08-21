// R19-R24 (matrix test names verbatim) — the full happy path against real
// MySQL + Kafka + NATS (Testcontainers), stub NATS responders standing in
// for Fulfillment/Billing (design.md §8.1): place -> ... -> invoiced, then
// stub payment.received.v1 + credit.released.v1 -> paid -> completed.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from './domain/order-status';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  publishFact,
  startStubSagaResponders,
  type StubSagaResponders,
} from './infrastructure/messaging/test-support/stub-saga-responders';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): `beforeAll` now blocks on
// `waitForConsumerGroupReady` before this suite's single `it` ever runs
// (saga-integration-harness.ts), so the post-container-start "coordinator
// loading" cost is paid once, inside beforeAll's own 300_000ms hook
// must exceed container boot plus several ~3s Kafka consumer-group joins
// plus dispatcher retry backoff, and must stay under vitest's 180s
// `testTimeout` so a true hang still fails fast. The heaviest test
// (150_000ms overall) chains 9 checkpoints — 7 saga-driven Kafka/NATS hops
// plus 2 manually-published closing facts — each individually sub-second
// once the group is Stable.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-happy-path: condition not met within ${timeoutMs}ms`);
}

async function orderStatus(harness: SagaIntegrationHarness, orderId: string): Promise<OrderStatus | undefined> {
  const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
  return row?.status as OrderStatus | undefined;
}

// The linear happy-path rank of a status — used to wait for "at least this
// far along" rather than "exactly this status", because the whole chain
// commonly advances several steps within one poll interval (each hop is a
// sub-second Kafka round trip): polling for an exact intermediate value can
// race past it entirely and time out on a transition that genuinely
// happened, just too fast to observe.
const HAPPY_PATH_RANK: Readonly<Record<OrderStatus, number>> = Object.fromEntries(
  ORDER_STATUSES.filter((status) => status !== 'cancelled').map((status, index) => [status, index]),
) as Record<OrderStatus, number>;

async function waitUntilAtLeast(harness: SagaIntegrationHarness, orderId: string, target: OrderStatus): Promise<void> {
  await waitFor(async () => {
    const current = await orderStatus(harness, orderId);
    return current !== undefined && current !== 'cancelled' && HAPPY_PATH_RANK[current] >= HAPPY_PATH_RANK[target];
  });
}

describe('saga-happy-path — R19-R24 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let harness: SagaIntegrationHarness;
  let responders: StubSagaResponders;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness();
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
    );
  }, 300_000);

  afterAll(async () => {
    await responders?.stop();
    await harness?.teardown();
  }, 120_000);

  it('reaches invoiced against stubbed responders, then paid -> completed on stub payment.received.v1 + credit.released.v1, with exactly one order.confirmed.v1 and one order.completed.v1 in the outbox', async () => {
    const order = await harness.placeOrderAndRelay();

    // R19 — order.placed.v1 owes stock.reserve.
    await waitFor(async () => responders.stockReserveRequests.length > 0);
    // stock.reserved.v1 advances to stock_reserved and owes credit.hold.
    await waitUntilAtLeast(harness, order.id.value, 'stock_reserved');
    await waitFor(async () => responders.creditHoldRequests.length > 0);
    // R21 — credit.approved.v1 performs both edges (approveCredit + confirm) in one save, owes despatch.create.
    await waitUntilAtLeast(harness, order.id.value, 'confirmed');
    await waitFor(async () => responders.despatchCreateRequests.length > 0);
    // order.despatched.v1 owes invoice.issue.
    await waitUntilAtLeast(harness, order.id.value, 'despatched');
    await waitFor(async () => responders.invoiceIssueRequests.length > 0);
    // R23 — invoice.issued.v1 advances to invoiced and owes NOTHING; the saga now waits for the outside world.
    await waitUntilAtLeast(harness, order.id.value, 'invoiced');

    const outboxRows = await harness.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(outboxRows.filter((row) => row.eventType === 'order.confirmed.v1')).toHaveLength(1);
    // R23 has genuinely stopped here: nothing beyond invoiced can happen
    // without an external fact, so THIS status is safe to assert exactly.
    expect(await orderStatus(harness, order.id.value)).toBe('invoiced');

    // Stub the two Billing facts that close the loop — payment.received.v1
    // then credit.released.v1, same causal order the real Billing context
    // would emit them in (saga.md §6 "Ordering guarantees").
    await publishFact(harness.billingFactPublisher, 'payment.received.v1', order.id.value, {
      orderReference: order.orderReference.value,
      invoiceReference: 'INV-000001',
      paymentReference: 'PAY-000001',
      currency: order.currency,
      amount: order.totalAmount.amount,
      source: 'operator',
      receivedAt: new Date().toISOString(),
    });
    await waitUntilAtLeast(harness, order.id.value, 'paid');

    await publishFact(harness.billingFactPublisher, 'credit.released.v1', order.id.value, {
      orderReference: order.orderReference.value,
      retailerCode: order.retailerCode,
      companyCode: order.companyCode,
      creditCode: 'CR-000001',
      currency: order.currency,
      releasedAmount: order.totalAmount.amount,
    });

    // R24 — credit.released.v1 closes the saga: completed, exactly one order.completed.v1.
    await waitUntilAtLeast(harness, order.id.value, 'completed');
    expect(await orderStatus(harness, order.id.value)).toBe('completed');
    const finalOutboxRows = await harness.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(finalOutboxRows.filter((row) => row.eventType === 'order.completed.v1')).toHaveLength(1);
    expect(finalOutboxRows.filter((row) => row.eventType === 'order.confirmed.v1')).toHaveLength(1);
  }, 150_000);
}, 300_000);
