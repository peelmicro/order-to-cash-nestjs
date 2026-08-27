// A7 — R59's own named integration test (`observability_reliability`
// design.md §4.5, OR5): records request latency (Gateway only, proven
// separately in `apps/gateway/src/presentation/request-latency.interceptor.spec.ts`
// — not repeated here), fact-processing latency per consumer, saga
// completion time, outbox lag and dead-letter depth as OTel metric
// instruments with the documented names — against a real
// `InMemoryMetricExporter` (design.md §8, no live collector needed), but
// EVERY value the instrument reports is produced by a REAL Testcontainers
// dependency (MySQL, Kafka), never synthesised: `otc_outbox_lag_ms` tracks
// a genuinely aged, real unpublished row; `otc_dlq_depth` reflects the
// REAL broker's own partition-offset count, not a locally-tracked
// publish-attempt tally; `otc_saga_completion_ms` is measured end to end
// through the real `SagaFactHandler`/saga pipeline, from the real
// order.placed.v1 timestamp to the real closing fact's own timestamp;
// `otc_fact_processing_latency_ms` is recorded by the real
// `FactRetryDispatcher.dispatch` processing a real Kafka-delivered fact.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Kafka, type Admin } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ordersSchema from '../persistence/schema/index';
import { startOrdersTestFixture, type OrdersTestFixture } from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { createKafkaClient } from '../outbox/create-kafka-client';
import { KafkaFactPublisher } from '../outbox/kafka-fact-publisher';
import { ORDERS_FACTS_TOPIC } from '../outbox/kafka.config';
import { OutboxRelay } from '../outbox/outbox-relay';
import { placeOrderInput } from '../outbox/test-support/order-factory';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from '../outbox/test-support/kafka-test-fixture';
import { Order } from '../../domain/order';
import { UniqueId } from '@otc/shared-kernel';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import { KafkaDlqDepth } from './kafka-dlq-depth';
import { findMetric, startMetricsTestHarness } from '../../test-support/metrics-test-provider';
import { publishFact } from '../messaging/test-support/stub-saga-responders';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from '../../test-support/saga-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`metrics-exposure: condition not met within ${timeoutMs}ms`);
}

// --- otc_outbox_lag_ms / otc_dlq_depth — real MySQL + real Kafka, no full app ---

describe('metrics-exposure — otc_outbox_lag_ms, otc_dlq_depth (A7, R59, OR5, Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  let admin: Admin;
  const dlqTopic = `otc.orders.facts.v1.metrics-test.${randomUUID()}.dlq`;

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startOrdersTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafkaFixture.brokers, dlqTopic);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-test' }));
    const kafka = new Kafka({ clientId: 'otc-orders-metrics-test-admin', brokers: [...kafkaFixture.brokers] });
    admin = kafka.admin();
    await admin.connect();
  }, 300_000);

  afterAll(async () => {
    await admin?.disconnect();
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
  }, 120_000);

  it('otc_outbox_lag_ms tracks a genuinely aged unpublished row, then drops once the backlog is actually caught up', async () => {
    const metricsHarness = startMetricsTestHarness();
    try {
      const clock = new FakeClock(new Date('2026-08-26T09:00:00.000Z'));
      const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
      const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
      const order = Order.place(placeOrderInput(), { occurredAt: clock.now(), causationId: UniqueId.generate() });
      await unitOfWork.execute((tx) => repository.save(order, tx));

      // The real order.placed.v1 outbox row now sits unpublished. Advance
      // the REAL clock the relay reads from — this is what makes the row
      // genuinely aged, not merely "some time elapsed during the test".
      clock.advance(5 * 60 * 1000); // 5 minutes

      const relay = new OutboxRelay({
        db: mysqlFixture.db,
        publisher: realPublisher,
        clock,
        config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
      });

      // First cycle: `recordOutboxLag()` runs BEFORE the claim/publish
      // below, so it reports the age of the backlog ENTERING this cycle —
      // the row this test just aged by exactly 5 minutes.
      await relay.runOnce();
      const firstBatches = await metricsHarness.collect();
      const firstMetric = findMetric(firstBatches, 'otc_outbox_lag_ms');
      expect(firstMetric).toBeDefined();
      const firstPoint = firstMetric!.dataPoints.at(-1);
      expect(firstPoint!.value as number).toBe(5 * 60 * 1000);

      // Second cycle: the row published (and stamped) during the first
      // cycle, so the backlog is now genuinely empty — the gauge must
      // report 0, not merely "a different number".
      await relay.runOnce();
      const secondBatches = await metricsHarness.collect();
      const secondMetric = findMetric(secondBatches, 'otc_outbox_lag_ms');
      const secondPoint = secondMetric!.dataPoints.at(-1);
      expect(secondPoint!.value as number).toBe(0);
    } finally {
      await metricsHarness.teardown();
    }
  });

  it('otc_dlq_depth reflects the REAL broker-reported message count of a .dlq topic, tracking a genuine increase, not a locally-tracked tally', async () => {
    const metricsHarness = startMetricsTestHarness();
    try {
      const clock = new FakeClock(new Date('2026-08-26T09:00:00.000Z'));
      const relay = new OutboxRelay({
        db: mysqlFixture.db,
        publisher: realPublisher,
        clock,
        config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
        dlqDepth: new KafkaDlqDepth(admin),
        dlqTopics: [dlqTopic],
      });

      // Nothing published to the DLQ topic yet — a real, freshly created
      // topic's genuine depth is 0.
      await relay.runOnce();
      const zeroBatches = await metricsHarness.collect();
      const zeroPoint = findMetric(zeroBatches, 'otc_dlq_depth')?.dataPoints.find((p) => p.attributes.topic === dlqTopic);
      expect(zeroPoint?.value as number).toBe(0);

      // Publish 3 real messages directly to the topic — a raw producer,
      // simulating 3 real dead-lettered facts.
      const producer = new Kafka({ clientId: 'otc-orders-metrics-test-producer', brokers: [...kafkaFixture.brokers] }).producer();
      await producer.connect();
      try {
        await producer.send({
          topic: dlqTopic,
          messages: [{ value: 'poison-1' }, { value: 'poison-2' }, { value: 'poison-3' }],
        });
      } finally {
        await producer.disconnect();
      }

      await relay.runOnce();
      const threeBatches = await metricsHarness.collect();
      const threePoint = findMetric(threeBatches, 'otc_dlq_depth')?.dataPoints.find((p) => p.attributes.topic === dlqTopic);
      expect(threePoint?.value as number).toBe(3);
    } finally {
      await metricsHarness.teardown();
    }
  });
});

// --- otc_fact_processing_latency_ms / otc_saga_completion_ms — the real saga pipeline ---

describe('metrics-exposure — otc_fact_processing_latency_ms, otc_saga_completion_ms (A7, R59, OR5, Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let harness: SagaIntegrationHarness;

  beforeAll(async () => {
    harness = await startSagaIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('otc_fact_processing_latency_ms is recorded by the REAL FactRetryDispatcher processing a REAL, Kafka-delivered order.placed.v1 fact', async () => {
    const metricsHarness = startMetricsTestHarness();
    try {
      const order = await harness.placeOrderAndRelay();

      // Genuine, terminal evidence of real end-to-end consumption: a real
      // saga_commands row for THIS order appears once the fact is
      // actually processed — not a bare sleep.
      await waitFor(async () => {
        const rows = await harness.db.select().from(ordersSchema.sagaCommands).where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
        return rows.length > 0;
      });

      const batches = await metricsHarness.collect();
      const metric = findMetric(batches, 'otc_fact_processing_latency_ms');
      expect(metric).toBeDefined();
      const point = metric!.dataPoints.find((p) => p.attributes.consumer === 'orders.saga');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBeGreaterThanOrEqual(1);
      // A real value, genuinely bounded (never negative, never absurdly
      // large — this ran over a real, healthy local Kafka broker).
      expect(histogram.sum).toBeGreaterThanOrEqual(0);
      expect(histogram.sum).toBeLessThan(30_000);
    } finally {
      await metricsHarness.teardown();
    }
  });

  it('otc_saga_completion_ms is measured end to end from the REAL order.placed.v1 timestamp to the REAL closing fact\'s own timestamp — an exact, independently-verifiable value, not merely a positive number', async () => {
    const metricsHarness = startMetricsTestHarness();
    try {
      const order = await harness.placeOrderAndRelay();

      // A deliberately explicit, far-from-"now" occurredAt — publishFact's
      // own default (`new Date()`) would make the expected duration
      // depend on wall-clock timing; supplying it directly keeps this
      // test's own expectation exact and independent of test-run speed.
      const closingOccurredAt = new Date(order.orderDate.getTime() + 47 * 60 * 1000); // +47 minutes

      await publishFact(
        harness.fulfillmentFactPublisher,
        'stock.rejected.v1',
        order.id.value,
        {
          orderReference: order.orderReference.value,
          companyCode: order.companyCode,
          shortages: [{ productCode: 'PRD-0001', requested: 2, available: 0 }],
          reason: 'insufficient_stock',
        },
        closingOccurredAt,
      );

      await waitFor(async () => {
        const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value));
        return row?.status === 'cancelled';
      });

      const batches = await metricsHarness.collect();
      const metric = findMetric(batches, 'otc_saga_completion_ms');
      expect(metric).toBeDefined();
      const point = metric!.dataPoints.find((p) => p.attributes.outcome === 'cancelled');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBeGreaterThanOrEqual(1);
      // The EXACT, independently-computable duration: closingOccurredAt
      // minus the order's OWN order.placed.v1 timestamp (order.orderDate)
      // — proves the measurement is genuinely anchored to the real facts,
      // not to an arbitrary handler-invocation instant.
      expect(histogram.sum).toBe(closingOccurredAt.getTime() - order.orderDate.getTime());
    } finally {
      await metricsHarness.teardown();
    }
  });
});
