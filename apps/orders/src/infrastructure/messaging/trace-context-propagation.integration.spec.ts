// R57, OR4 (design.md §4.3) — the named test file for R57's own
// test-matrix row: "injects `traceparent` into the outbound NATS request
// headers and into the outbox-relayed Kafka fact headers, and continues
// (does not restart) the trace when the corresponding fact is consumed."
// Real NATS + real MySQL + real Kafka (Testcontainers) — proven against a
// real `NodeTracerProvider` + `InMemorySpanExporter` registered for this
// file only (design.md §8: no live collector needed for the assertion).
//
// Every assertion below reads a REAL, OTel-generated `traceId`/`spanId`
// back out of the actually-transmitted wire bytes (NATS `MsgHdrs`
// delivered over a real socket, Kafka message headers delivered over a
// real broker) through the SAME extraction helpers production code uses —
// never a bare string-equality check on a header's presence.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import { NatsContext } from '@nestjs/microservices';
import { Kafka, type Consumer } from 'kafkajs';
import { headers as natsHeaders, type NatsConnection } from 'nats';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Order } from '../../domain/order';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import * as ordersSchema from '../persistence/schema/index';
import { startOrdersTestFixture, type OrdersTestFixture } from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { createKafkaClient } from '../outbox/create-kafka-client';
import { KafkaFactPublisher } from '../outbox/kafka-fact-publisher';
import { ORDERS_FACTS_TOPIC } from '../outbox/kafka.config';
import { OutboxRelay } from '../outbox/outbox-relay';
import { placeOrderInput } from '../outbox/test-support/order-factory';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from '../outbox/test-support/kafka-test-fixture';
import { extractKafkaTraceContext, extractNatsTraceContext, injectNatsTraceContext, tracer } from '../observability/trace-context';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';

describe('trace-context-propagation — R57, OR4 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let natsFixture: NatsTestFixture;
  let realPublisher: KafkaFactPublisher;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;
  const kafkaConsumers: Consumer[] = [];
  const natsConnections: NatsConnection[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture, natsFixture] = await Promise.all([
      startOrdersTestFixture(),
      startKafkaTestFixture(),
      startNatsTestFixture(),
    ]);
    await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-trace-test' }));

    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
  }, 300_000);

  afterEach(async () => {
    for (const consumer of kafkaConsumers.splice(0)) {
      await consumer.disconnect();
    }
    for (const connection of natsConnections.splice(0)) {
      await connection.close();
    }
  });

  afterAll(async () => {
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
    await natsFixture?.teardown();
    contextManager?.disable();
    await provider?.shutdown();
  }, 120_000);

  it('NATS RPC — injects the active span\'s real traceId into the outbound request headers over a REAL socket, and the responder\'s extraction continues the SAME trace (same traceId, a real parent spanId) rather than starting fresh', async () => {
    const server = await natsFixture.connect();
    const client = await natsFixture.connect();
    natsConnections.push(server, client);
    const subject = `test.trace.${randomUUID()}`;

    const receivedContexts: NatsContext[] = [];
    const sub = server.subscribe(subject);
    void (async () => {
      for await (const msg of sub) {
        receivedContexts.push(new NatsContext([subject, msg.headers]));
        msg.respond(new TextEncoder().encode(JSON.stringify({ ok: true })));
      }
    })();

    const clientSpan = tracer().startSpan('test-nats-client-span');
    const { traceId: originTraceId, spanId: originSpanId } = clientSpan.spanContext();

    await context.with(trace.setSpan(context.active(), clientSpan), async () => {
      const h = natsHeaders();
      injectNatsTraceContext(h);
      await client.request(subject, new TextEncoder().encode('{}'), { timeout: 5000, headers: h });
    });
    clientSpan.end();
    await sub.drain();

    expect(receivedContexts).toHaveLength(1);
    const extracted = extractNatsTraceContext(receivedContexts[0]!.getHeaders());
    const extractedSpanContext = trace.getSpanContext(extracted);

    expect(extractedSpanContext).toBeDefined();
    expect(extractedSpanContext!.traceId).toBe(originTraceId);
    expect(extractedSpanContext!.spanId).toBe(originSpanId);
    // Real ids, not degenerate/all-zero placeholders.
    expect(extractedSpanContext!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Kafka facts — a domain event written inside an active span carries that traceId into outbox.trace_parent; the relay\'s own manual "publish" span (a fresh child) is what the CONSUMED message\'s headers extract to, still on the SAME trace', async () => {
    const clock = new FakeClock(new Date('2026-08-26T10:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();

    const writerSpan = tracer().startSpan('test-order-placed-handler-span');
    const { traceId: originTraceId, spanId: writerSpanId } = writerSpan.spanContext();

    const order = await context.with(trace.setSpan(context.active(), writerSpan), async () => {
      const placed = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
      await unitOfWork.execute((tx) => repository.save(placed, tx));
      return placed;
    });
    writerSpan.end();

    const [row] = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(row).toBeDefined();
    expect(row!.traceParent).toBe(`00-${originTraceId}-${writerSpanId}-01`);

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();
    expect(result.published).toBeGreaterThanOrEqual(1);

    // Consume for real, over the wire, exactly like SagaFactsController's
    // own @EventPattern handler would (raw kafkajs, since this is a unit
    // proof of the WIRE-LEVEL propagation, not a full Nest boot).
    const kafka = new Kafka({ clientId: 'otc-orders-trace-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId: `trace-test-${randomUUID()}` });
    kafkaConsumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: ORDERS_FACTS_TOPIC, fromBeginning: true });

    const receivedHeaders = await new Promise<Record<string, Buffer | string | undefined>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the consumed order.placed.v1 fact')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== order.id.value) {
              return;
            }
            clearTimeout(timeout);
            resolve(message.headers as never);
          },
        })
        .catch(reject);
    });

    const extracted = extractKafkaTraceContext(receivedHeaders as never);
    const extractedSpanContext = trace.getSpanContext(extracted);

    expect(extractedSpanContext).toBeDefined();
    // Same TRACE, continued — not a fresh one.
    expect(extractedSpanContext!.traceId).toBe(originTraceId);
    // But a DIFFERENT span id — the relay's own manual "publish" span, a
    // fresh child of the writer's span, not the writer's raw span id
    // republished verbatim.
    expect(extractedSpanContext!.spanId).not.toBe(writerSpanId);
    expect(extractedSpanContext!.spanId).toMatch(/^[0-9a-f]{16}$/);

    // The exported "outbox.publish" span itself: a real, ended span on the
    // same trace, parented on the writer's span.
    const publishSpan = exporter.getFinishedSpans().find((s) => s.name === `outbox.publish ${row!.eventType}`);
    expect(publishSpan).toBeDefined();
    expect(publishSpan!.spanContext().traceId).toBe(originTraceId);
    expect(publishSpan!.parentSpanContext?.spanId).toBe(writerSpanId);
    expect(publishSpan!.spanContext().spanId).toBe(extractedSpanContext!.spanId);
  }, 60_000);

  it('Kafka facts — a domain event written with NO active span produces no traceparent at all, and the relay omits the header entirely (no spurious trace fabricated)', async () => {
    const clock = new FakeClock(new Date('2026-08-26T11:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();

    const order = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => repository.save(order, tx));

    const [row] = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(row?.traceParent).toBeNull();

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    await relay.runOnce();

    const kafka = new Kafka({ clientId: 'otc-orders-trace-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId: `trace-test-${randomUUID()}` });
    kafkaConsumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: ORDERS_FACTS_TOPIC, fromBeginning: true });

    const receivedHeaders = await new Promise<Record<string, Buffer | string | undefined>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the consumed order.placed.v1 fact')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== order.id.value) {
              return;
            }
            clearTimeout(timeout);
            resolve(message.headers as never);
          },
        })
        .catch(reject);
    });

    expect(receivedHeaders.traceparent).toBeUndefined();
  }, 60_000);
});
