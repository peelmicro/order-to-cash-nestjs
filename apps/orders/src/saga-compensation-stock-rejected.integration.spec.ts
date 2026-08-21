// R26 — compensation path A: stock.rejected.v1 cancels the order from
// placed with compensationSteps: [] and owes NOTHING — the stub's
// stock.release subject is asserted to observe ZERO requests, including
// after redelivering stock.rejected.v1 against the now-cancelled order.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  publishFact,
  startStubSagaResponders,
  type StubSagaResponders,
} from './infrastructure/messaging/test-support/stub-saga-responders';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): `beforeAll` now blocks on
// `waitForConsumerGroupReady` before this suite's `it` runs
// (saga-integration-harness.ts) — the "coordinator loading" cost is paid
// default budget must exceed container boot plus several ~3s Kafka
// vitest's 180s `testTimeout` so a true hang still fails fast. The two
// `waitFor` calls below cover only 2 real hops plus a fixed 3s sleep.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-compensation-stock-rejected: condition not met within ${timeoutMs}ms`);
}

async function orderRow(harness: SagaIntegrationHarness, orderId: string) {
  const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
  return row;
}

describe('saga-compensation-stock-rejected — R26 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let harness: SagaIntegrationHarness;
  let responders: StubSagaResponders;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness();
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
      { rejectStockReserve: true },
    );
  }, 300_000);

  afterAll(async () => {
    await responders?.stop();
    await harness?.teardown();
  }, 120_000);

  it('cancelled with reason stock_rejected, compensationSteps: [], and the release subject stub observes ZERO requests, including after redelivering stock.rejected.v1 against cancelled', async () => {
    const order = await harness.placeOrderAndRelay();

    await waitFor(async () => responders.stockReserveRequests.length > 0);
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status === 'cancelled');

    const row = await orderRow(harness, order.id.value);
    expect(row).toMatchObject({ status: 'cancelled', cancellationReason: 'stock_rejected' });

    const outboxRows = await harness.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    const cancelledFact = outboxRows.find((r) => r.eventType === 'order.cancelled.v1');
    expect(cancelledFact).toBeDefined();
    expect((cancelledFact?.payload as { compensationSteps: unknown[] }).compensationSteps).toEqual([]);

    // Nothing was ever acquired (R26) — the release subject must NEVER be
    // called, not even after the cancellation committed.
    expect(responders.stockReleaseRequests).toHaveLength(0);

    // A second stock.rejected.v1 arriving against the now-cancelled order
    // (precondition mismatch — R25) must change nothing and issue nothing;
    // the full redelivery-table sweep (including literal same-eventId
    // redelivery, R18) lives in saga-preconditions.integration.spec.ts.
    await publishFact(harness.fulfillmentFactPublisher, 'stock.rejected.v1', order.id.value, {
      orderReference: order.orderReference.value,
      companyCode: order.companyCode,
      shortages: [{ productCode: 'PRD-0001', requested: 2, available: 0 }],
      reason: 'insufficient_stock',
    });
    // Give the redelivery a moment to be (correctly) ignored, then assert
    // the state is unchanged and still nothing was released.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const rowAfterRedelivery = await orderRow(harness, order.id.value);
    expect(rowAfterRedelivery).toMatchObject({ status: 'cancelled', cancellationReason: 'stock_rejected' });
    expect(responders.stockReleaseRequests).toHaveLength(0);

    const ignoredRows = await harness.db
      .select()
      .from(ordersSchema.sagaIgnoredFacts)
      .where(eq(ordersSchema.sagaIgnoredFacts.correlationId, order.id.value));
    expect(ignoredRows.some((r) => r.marker === 'precondition_unmet')).toBe(true);
  }, 90_000);
}, 300_000);
