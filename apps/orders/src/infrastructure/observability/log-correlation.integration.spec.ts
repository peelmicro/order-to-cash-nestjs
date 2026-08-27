// R58's own named test file (specs/shared/test-matrix.md's R58 row, A6c) —
// Testcontainers real MySQL (mysql:8.4.11) + real Kafka
// (apache/kafka:4.3.1), matching `outbox-relay.integration.spec.ts`'s own
// scope (NATS is not part of this file's own flow — the command under
// test is a direct write, mirroring `trace-context-propagation.integration
// .spec.ts`'s own "unit proof of the WIRE-LEVEL propagation, not a full
// Nest boot" convention for its Kafka-facts cases).
//
// The point of THIS file, per the brief: not "every log line has SOME
// traceId field" (a shape check proves nothing) but "the SAME real,
// OTel-generated traceId appears on MULTIPLE structured log lines
// produced during ONE flow" — proven by capturing the ACTUAL
// `console.error` output (never a fake logger substitute) and
// cross-checking every parsed traceId against the exported spans'
// OWN `spanContext().traceId`, never a bare string-equality coincidence.
//
// Concrete shape chosen, stated honestly: `outbox-relay.ts`'s own
// publish-failure log is the ONE of design.md §4.4's three confirmed
// JSON-shaped call sites whose OWN mechanism (a still-unpublished row is
// retried, unchanged, on every subsequent poll — OI8) naturally produces
// MULTIPLE real log lines from a SINGLE originating command without
// inventing a call site design.md does not name. A command (an order
// placement, run inside a real active span) writes ONE outbox row; the
// relay's publish is forced to fail on its first two polls (a
// `FlakyFactPublisher`, the same fake `outbox-relay.integration.spec.ts`
// already uses) before succeeding for real on the third — the two
// resulting failure log lines are what this file proves share the
// identical, real, extracted traceId.
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Order } from '../../domain/order';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
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
import { tracer } from './trace-context';

/** Same fake `outbox-relay.integration.spec.ts` already establishes — delegates to a real publisher but rejects the first `failTimes` calls. */
class FlakyFactPublisher implements FactPublisher {
  private calls = 0;
  constructor(private readonly delegate: FactPublisher, private readonly failTimes: number) {}

  async publish(facts: readonly PublishableFact[]): Promise<void> {
    this.calls++;
    if (this.calls <= this.failTimes) {
      throw new Error(`FlakyFactPublisher: synthetic failure #${this.calls}`);
    }
    await this.delegate.publish(facts);
  }
}

describe('log-correlation — R58, A6a/A6c (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;
  const consumers: Consumer[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startOrdersTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-log-correlation-test' }));

    // A real TracerProvider, registered for this file only — never
    // sdk-node's own OTLP exporter (design.md §8: InMemorySpanExporter is
    // sufficient proof, no live collector needed).
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
  }, 300_000);

  beforeEach(() => {
    exporter.reset();
  });

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) {
      await consumer.disconnect();
    }
  });

  afterAll(async () => {
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
    contextManager?.disable();
    await provider?.shutdown();
  }, 120_000);

  it('two real publish-retry failure log lines for the SAME still-unpublished fact carry the IDENTICAL real traceId — equality across lines, not merely field presence', async () => {
    const clock = new FakeClock(new Date('2026-08-26T12:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();

    const writerSpan = tracer().startSpan('test-place-order-handler-span');
    const { traceId: originTraceId } = writerSpan.spanContext();

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
    expect(row?.traceParent).toBe(`00-${originTraceId}-${writerSpan.spanContext().spanId}-01`);

    const flakyPublisher = new FlakyFactPublisher(realPublisher, 2);
    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: flakyPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = await relay.runOnce();
    expect(first.published).toBe(0);
    const second = await relay.runOnce();
    expect(second.published).toBe(0);

    // Both failed polls of the SAME row logged — capture and parse both
    // JSON lines produced by THIS row's failures (the shared Kafka
    // fixture may carry other suites' lines too, but this test's own spy
    // is fresh per `it()`, so every captured call belongs to this flow).
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const loggedLines = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((line) => line.eventId === row!.eventId);
    expect(loggedLines).toHaveLength(2);

    const traceIds = loggedLines.map((line) => line.traceId);
    expect(traceIds.every((id) => typeof id === 'string')).toBe(true);
    // The actual property under test: the SAME real traceId on both
    // lines — not merely "a traceId key exists" on each independently.
    expect(new Set(traceIds).size).toBe(1);
    expect(traceIds[0]).toBe(originTraceId);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIds[0]).not.toBe('00000000000000000000000000000000'.slice(0, 32));

    // Cross-checked against the ACTUAL exported spans, not a
    // self-referential re-parse of the same JSON: two real, ended
    // "outbox.publish" spans (one per failed poll), both on the writer's
    // own trace, both ended with an ERROR status.
    const publishSpans = exporter.getFinishedSpans().filter((s) => s.name === `outbox.publish ${row!.eventType}`);
    expect(publishSpans).toHaveLength(2);
    for (const span of publishSpans) {
      expect(span.spanContext().traceId).toBe(originTraceId);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    }

    errorSpy.mockRestore();

    // The third, real poll succeeds for real — proving the retried fact
    // is not lost, and giving the SAME trace a genuine third hop (a real
    // Kafka wire delivery) beyond this test's own two log lines.
    const third = await relay.runOnce();
    expect(third.published).toBe(1);

    const kafka = new Kafka({ clientId: 'otc-orders-log-correlation-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId: `log-correlation-test-${randomUUID()}` });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: ORDERS_FACTS_TOPIC, fromBeginning: true });
    const delivered = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the eventually-published order.placed.v1 fact')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== order.id.value) {
              return;
            }
            clearTimeout(timeout);
            resolve(true);
          },
        })
        .catch(reject);
    });
    expect(delivered).toBe(true);
  }, 60_000);

  it('a publish-failure log for a row written with NO active span carries no traceId at all — never the literal string "undefined" (sane behaviour with genuinely no trace)', async () => {
    const clock = new FakeClock(new Date('2026-08-26T13:00:00.000Z'));
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

    const flakyPublisher = new FlakyFactPublisher(realPublisher, 1);
    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: flakyPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await relay.runOnce();
    expect(first.published).toBe(0);

    const line = errorSpy.mock.calls.map((call) => call[0] as string).find((raw) => JSON.parse(raw).eventId === row!.eventId);
    expect(line).toBeDefined();
    expect(line).not.toContain('undefined');
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'traceId')).toBe(false);

    errorSpy.mockRestore();

    // Restore the row to a publishable state for good fixture hygiene
    // (not asserted further — the negative case above is this test's
    // whole point).
    const second = await relay.runOnce();
    expect(second.published).toBe(1);
  }, 60_000);
});
