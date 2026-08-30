// observability_dashboards (phase 22) — the named test for the trace-
// linkage fix's own test-matrix row: this service's outbox relay now
// creates a manual "outbox.publish" span, mirroring
// apps/orders/src/infrastructure/messaging/trace-context-propagation.
// integration.spec.ts's own "Kafka facts" case verbatim. Before this fix,
// `outbox-relay.ts` forwarded a row's stored `trace_parent` verbatim as the
// outbound Kafka header — a correct trace ID, but no span of billing's own
// attached to it, so this service never appeared as a participant in
// Jaeger even on a request that correctly held and forwarded the trace
// (the live-stack finding this phase's brief opened with: `ORD-000184`
// produced a trace touching only `gateway`/`orders`/`projector`/
// `notifications`, never `billing`/`fulfillment`).
//
// Real MySQL + real Kafka (Testcontainers), a real `NodeTracerProvider` +
// `InMemorySpanExporter` registered for this file only (no live collector
// needed for the assertion, same as Orders' own copy). Every assertion
// reads a REAL, OTel-generated `traceId`/`spanId` back out of the actually-
// published Kafka message headers through the SAME extraction path a real
// consumer would use.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer } from 'kafkajs';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from '../persistence/buyer-credit.repository';
import * as billingSchema from '../persistence/schema/index';
import { startBillingTestFixture, type BillingTestFixture } from '../persistence/test-support/billing-test-fixture';
import { createKafkaClient } from './create-kafka-client';
import { KafkaFactPublisher } from './kafka-fact-publisher';
import { BILLING_FACTS_TOPIC } from './kafka.config';
import { OutboxRelay } from './outbox-relay';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';

const CURRENCY = 'EUR';
const fixedClock = { now: () => new Date('2026-08-30T10:00:00.000Z') };

function headerValueToString(value: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return headerValueToString(value[0]);
  return value;
}

describe('outbox-relay trace linkage — observability_dashboards (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: BillingTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;
  const consumers: Consumer[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startBillingTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, BILLING_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-billing-trace-linkage-test' }));

    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
  }, 300_000);

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) {
      await consumer.disconnect();
    }
    exporter.reset();
  });

  afterAll(async () => {
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
    contextManager?.disable();
    await provider?.shutdown();
  }, 120_000);

  it('a credit-hold row written inside an active span is published with billing\'s OWN "outbox.publish" span — same trace, a fresh child span id, not the raw stored header forwarded verbatim', async () => {
    const repository = new DrizzleBuyerCreditRepository(mysqlFixture.db, fixedClock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const creditId = randomUUID();
    const now = fixedClock.now();
    await mysqlFixture.db.insert(billingSchema.credits).values({
      id: creditId,
      code: 'CR-900002',
      retailerCode: 'RET-TRACE',
      companyCode: 'COM-TRACE',
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      createdAt: now,
      updatedAt: now,
    });
    const orderReference = OrderNumber.fromSequence(2);
    const correlationId = UniqueId.generate();

    const writerSpan = trace.getTracer('billing-trace-linkage-test').startSpan('test-credit-hold-handler-span');
    const { traceId: originTraceId, spanId: writerSpanId } = writerSpan.spanContext();

    await context.with(trace.setSpan(context.active(), writerSpan), async () => {
      await unitOfWork.execute(async (tx) => {
        const credit = await repository.lockForOrder(tx, 'RET-TRACE', 'COM-TRACE', orderReference);
        credit!.approveHold(
          { orderReference, amount: Money.of(10_000, CURRENCY), correlationId },
          { occurredAt: fixedClock.now(), causationId: UniqueId.generate() },
          () => UniqueId.generate(),
        );
        await repository.save(credit!, tx);
      });
    });
    writerSpan.end();

    const [row] = await mysqlFixture.db.select().from(billingSchema.outbox).where(eq(billingSchema.outbox.aggregateId, creditId));
    expect(row).toBeDefined();
    expect(row!.traceParent).toBe(`00-${originTraceId}-${writerSpanId}-01`);

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock: fixedClock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();
    expect(result.published).toBe(1);

    const kafka = new Kafka({ clientId: 'otc-billing-trace-linkage-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId: `trace-linkage-${randomUUID()}` });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: BILLING_FACTS_TOPIC, fromBeginning: true });

    const receivedHeaders = await new Promise<Record<string, Buffer | string | undefined>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the consumed credit.approved.v1 fact')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== correlationId.value) return;
            clearTimeout(timeout);
            resolve(message.headers as never);
          },
        })
        .catch(reject);
    });

    const traceparentHeader = headerValueToString(receivedHeaders.traceparent);
    expect(traceparentHeader).toBeDefined();
    const extracted = propagation.extract(context.active(), { traceparent: traceparentHeader });
    const extractedSpanContext = trace.getSpanContext(extracted);
    expect(extractedSpanContext).toBeDefined();
    // Same TRACE as the writer's — continued, not restarted.
    expect(extractedSpanContext!.traceId).toBe(originTraceId);
    // A DIFFERENT span id — billing's own manual "outbox.publish" span, a
    // fresh child of the writer's span, not the writer's raw span id
    // forwarded verbatim (the pre-fix behaviour this test guards against).
    expect(extractedSpanContext!.spanId).not.toBe(writerSpanId);
    expect(extractedSpanContext!.spanId).toMatch(/^[0-9a-f]{16}$/);

    // The exported "outbox.publish" span itself: a real, ended span on the
    // same trace, parented on the writer's span, attributing THIS SERVICE
    // (billing) as a real Jaeger participant in the order's trace.
    const publishSpan = exporter.getFinishedSpans().find((s) => s.name === `outbox.publish ${row!.eventType}`);
    expect(publishSpan).toBeDefined();
    expect(publishSpan!.spanContext().traceId).toBe(originTraceId);
    expect(publishSpan!.parentSpanContext?.spanId).toBe(writerSpanId);
    expect(publishSpan!.spanContext().spanId).toBe(extractedSpanContext!.spanId);
    expect(publishSpan!.kind).toBe(SpanKind.PRODUCER);
  }, 60_000);

  it('a row with NO active trace at write time is published with no traceparent header — no span, no spurious trace fabricated', async () => {
    const repository = new DrizzleBuyerCreditRepository(mysqlFixture.db, fixedClock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const creditId = randomUUID();
    const now = fixedClock.now();
    await mysqlFixture.db.insert(billingSchema.credits).values({
      id: creditId,
      code: 'CR-900003',
      retailerCode: 'RET-NOTRACE',
      companyCode: 'COM-NOTRACE',
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      createdAt: now,
      updatedAt: now,
    });
    const orderReference = OrderNumber.fromSequence(3);
    const correlationId = UniqueId.generate();

    await unitOfWork.execute(async (tx) => {
      const credit = await repository.lockForOrder(tx, 'RET-NOTRACE', 'COM-NOTRACE', orderReference);
      credit!.approveHold(
        { orderReference, amount: Money.of(5_000, CURRENCY), correlationId },
        { occurredAt: fixedClock.now(), causationId: UniqueId.generate() },
        () => UniqueId.generate(),
      );
      await repository.save(credit!, tx);
    });

    const [row] = await mysqlFixture.db.select().from(billingSchema.outbox).where(eq(billingSchema.outbox.aggregateId, creditId));
    expect(row?.traceParent).toBeNull();

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock: fixedClock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    await relay.runOnce();

    const kafka = new Kafka({ clientId: 'otc-billing-trace-linkage-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId: `trace-linkage-${randomUUID()}` });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: BILLING_FACTS_TOPIC, fromBeginning: true });

    const receivedHeaders = await new Promise<Record<string, Buffer | string | undefined>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the consumed credit.approved.v1 fact')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== correlationId.value) return;
            clearTimeout(timeout);
            resolve(message.headers as never);
          },
        })
        .catch(reject);
    });

    expect(receivedHeaders.traceparent).toBeUndefined();
    expect(exporter.getFinishedSpans().find((s) => s.name.startsWith('outbox.publish'))).toBeUndefined();
  }, 60_000);
});
