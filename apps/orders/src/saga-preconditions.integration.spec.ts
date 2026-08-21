// R25 + SO8 + saga.md §6's per-fact redelivery table, swept literally: an
// order driven all the way to `completed`, then EVERY one of the ten
// consumed facts redelivered against it — every row of the table becomes a
// precondition mismatch against a terminal order, changing nothing and
// issuing nothing, recorded with the `precondition_unmet` marker. Plus a
// dedicated dedup-layer (R18) redelivery and the SO8 unknown-order case.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import { publishFact, startStubSagaResponders, type StubSagaResponders } from './infrastructure/messaging/test-support/stub-saga-responders';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): `beforeAll` now blocks on
// `waitForConsumerGroupReady` before any `it` in this suite runs
// (saga-integration-harness.ts) — the "coordinator loading" startup cost
// is paid once, inside beforeAll's 300_000ms hook budget, not here. The
// vitest's 180s `testTimeout` so a true hang still fails fast. The
// heaviest test chains the full happy path plus 10 redelivered facts
// swept in a loop.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-preconditions: condition not met within ${timeoutMs}ms`);
}

async function orderRow(harness: SagaIntegrationHarness, orderId: string) {
  const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
  return row;
}

async function outboxCount(harness: SagaIntegrationHarness, orderId: string): Promise<number> {
  const rows = await harness.db.select().from(ordersSchema.outbox).where(eq(ordersSchema.outbox.aggregateId, orderId));
  return rows.length;
}

async function ignoredCount(
  harness: SagaIntegrationHarness,
  orderId: string,
  marker: 'precondition_unmet' | 'unknown_order',
): Promise<number> {
  const rows = await harness.db
    .select()
    .from(ordersSchema.sagaIgnoredFacts)
    .where(and(eq(ordersSchema.sagaIgnoredFacts.correlationId, orderId), eq(ordersSchema.sagaIgnoredFacts.marker, marker)));
  return rows.length;
}

const CONSUMED_FACT_TYPES = [
  'order.placed.v1',
  'stock.reserved.v1',
  'stock.rejected.v1',
  'credit.approved.v1',
  'credit.rejected.v1',
  'stock.released.v1',
  'order.despatched.v1',
  'invoice.issued.v1',
  'payment.received.v1',
  'credit.released.v1',
] as const;

/** A minimal-but-valid payload per fact type — content does not matter for a precondition-mismatch redelivery (it is ignored before the aggregate ever reads it), except `stock.released.v1`'s `reason`, which `SAGA_STEPS.reason()` reads unconditionally. */
function payloadFor(eventType: string): Record<string, unknown> {
  if (eventType === 'stock.released.v1') {
    return { orderReference: 'ORD-999999', companyCode: 'COM-0001', released: [], reason: 'credit_rejected' };
  }
  return { orderReference: 'ORD-999999' };
}

describe('saga-preconditions — R25, SO8, the full saga.md §6 redelivery sweep (Testcontainers)', () => {
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

  it('every one of the ten consumed facts, redelivered against a completed order, changes nothing, issues nothing, and is recorded precondition_unmet', async () => {
    const order = await harness.placeOrderAndRelay();

    await waitFor(async () => responders.invoiceIssueRequests.length > 0);
    await publishFact(harness.billingFactPublisher, 'payment.received.v1', order.id.value, {
      orderReference: order.orderReference.value,
      invoiceReference: 'INV-000001',
      paymentReference: 'PAY-000001',
      currency: order.currency,
      amount: order.totalAmount.amount,
      source: 'operator',
      receivedAt: new Date().toISOString(),
    });
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status === 'paid');
    await publishFact(harness.billingFactPublisher, 'credit.released.v1', order.id.value, {
      orderReference: order.orderReference.value,
      retailerCode: order.retailerCode,
      companyCode: order.companyCode,
      creditCode: 'CR-000001',
      currency: order.currency,
      releasedAmount: order.totalAmount.amount,
    });
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status === 'completed');

    const outboxCountBefore = await outboxCount(harness, order.id.value);
    const releaseRequestsBefore = responders.stockReleaseRequests.length;

    for (const eventType of CONSUMED_FACT_TYPES) {
      await publishFact(harness.fulfillmentFactPublisher, eventType, order.id.value, payloadFor(eventType));
    }

    // Give the last redelivered fact's consumption a moment, then assert
    // NOTHING changed — a fixed sleep rather than a positive waitFor,
    // because the assertion IS "nothing happens".
    await waitFor(async () => (await ignoredCount(harness, order.id.value, 'precondition_unmet')) >= CONSUMED_FACT_TYPES.length);

    expect(await orderRow(harness, order.id.value)).toMatchObject({ status: 'completed' });
    expect(await outboxCount(harness, order.id.value)).toBe(outboxCountBefore);
    // R26's "still no release command" clause, swept here too — the
    // redelivered stock.rejected.v1 must never trigger a stock.release.
    expect(responders.stockReleaseRequests.length).toBe(releaseRequestsBefore);
  }, 90_000);

  it('R18 — a literal same-eventId redelivery of order.placed.v1 hits the dedup record and mutates nothing (Layer 1)', async () => {
    const order = await harness.placeOrderAndRelay();

    const [outboxRow] = await harness.db
      .select()
      .from(ordersSchema.outbox)
      .where(and(eq(ordersSchema.outbox.aggregateId, order.id.value), eq(ordersSchema.outbox.eventType, 'order.placed.v1')));
    expect(outboxRow).toBeDefined();

    // Filtered by THIS order's own reference — `responders` is shared
    // across every `it` in this file, so a raw `.length` would also count
    // requests other tests' orders already made.
    function reservesForThisOrder(): number {
      return responders.stockReserveRequests.filter((r) => r.request.orderReference === order.orderReference.value).length;
    }

    await waitFor(async () => reservesForThisOrder() > 0);
    const reserveRequestsBefore = reservesForThisOrder();

    // The exact same eventId, re-published — the true "redelivery" case.
    await harness.ordersFactPublisher.publish([
      {
        key: order.id.value,
        envelope: {
          eventId: outboxRow!.eventId,
          eventType: 'order.placed.v1',
          aggregateId: order.id.value,
          correlationId: order.id.value,
          causationId: outboxRow!.causationId,
          occurredAt: outboxRow!.occurredAt.toISOString(),
          payload: outboxRow!.payload as Record<string, unknown>,
        },
        headers: {},
      },
    ]);

    await waitFor(async () => {
      const processed = await harness.db
        .select()
        .from(ordersSchema.processedEvents)
        .where(eq(ordersSchema.processedEvents.eventId, outboxRow!.eventId));
      return processed.length === 1;
    });
    // Give a moment to be sure a SECOND stock.reserve is not on its way.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(reservesForThisOrder()).toBe(reserveRequestsBefore);
  }, 60_000);

  it('SO8 — a fact whose correlationId matches no order is recorded ignored with the unknown_order marker and acknowledged (no throw)', async () => {
    const unknownOrderId = UniqueId.generate().value;

    await publishFact(harness.fulfillmentFactPublisher, 'stock.reserved.v1', unknownOrderId, {
      orderReference: 'ORD-000000',
      companyCode: 'COM-0001',
      reservations: [{ reservationId: randomUUID(), productCode: 'PRD-0001', units: 1 }],
    });

    await waitFor(async () => (await ignoredCount(harness, unknownOrderId, 'unknown_order')) === 1);
    const [row] = await harness.db
      .select()
      .from(ordersSchema.sagaIgnoredFacts)
      .where(eq(ordersSchema.sagaIgnoredFacts.correlationId, unknownOrderId));
    expect(row).toMatchObject({
      eventType: 'stock.reserved.v1',
      orderId: null,
      correlationId: unknownOrderId,
      observedStatus: null,
      expectedStatus: 'placed',
      marker: 'unknown_order',
    });
  }, 60_000);
}, 300_000);
