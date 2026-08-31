// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `MongoReadModelWriter`'s own
// lost-insert-race retry log (`upsertPlaceholder`'s log-and-retry-once
// branch, PR7) now carries `traceId` (the ACTIVE span's real `traceId`,
// `activeTraceId()`) AND `correlationId` (`orderId` doubles as the fact's
// own `correlationId` by construction — `domain/fact-projection.ts`:
// `orderId: envelope.correlationId`; specs/shared/saga.md: "the order id
// is the correlationId of every fact") — where before it carried `orderId`
// only. Exercises the REAL default `CONSOLE_LOGGER` (no injected fake
// logger), a fake `Collection` whose FIRST `updateOne` throws a genuine
// Mongo E11000 duplicate-key shape (forcing the retry branch), never a
// fake logger's `meta` object.
import { describe, expect, it, vi } from 'vitest';
import type { Collection } from 'mongodb';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UniqueId } from '@otc/shared-kernel';
import type { ProjectionDelta } from '../../domain/projection-delta';
import { tracer } from '../observability/trace-context';
import { MongoReadModelWriter } from './mongo-read-model-writer';
import type { OrderTimelineDocument } from './order-timeline.document';

function delta(orderId: string): ProjectionDelta {
  return {
    orderId,
    entry: {
      eventId: UniqueId.generate().value,
      eventType: 'order.placed.v1',
      occurredAt: '2026-08-31T09:00:00.000Z',
      summary: 'order placed',
      causationId: UniqueId.generate().value,
    },
    impliedStatus: null,
    statusRank: 0,
    fillIfAbsent: {},
  };
}

/** Fakes the exact two `Collection<OrderTimelineDocument>` calls `MongoReadModelWriter` makes: `updateOne` (twice, on the lost-race path) and `findOneAndUpdate` (once, returning `null` — a duplicate, so `afterApplied` never fires and this test's own scope stays narrow to the retry log). */
function fakeCollection(): Collection<OrderTimelineDocument> {
  let updateOneCalls = 0;
  return {
    updateOne: vi.fn(async () => {
      updateOneCalls += 1;
      if (updateOneCalls === 1) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      return { acknowledged: true };
    }),
    findOneAndUpdate: vi.fn(async () => null),
  } as unknown as Collection<OrderTimelineDocument>;
}

describe('MongoReadModelWriter — lost-insert-race retry log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it("logs the REAL active span's traceId and orderId-as-correlationId — not merely field presence, equal to the real originating ids", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const orderId = UniqueId.generate().value;
      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const writer = new MongoReadModelWriter(fakeCollection());

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await writer.apply(delta(orderId), UniqueId.generate().value, 'projector', async () => undefined);
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('mongo-read-model-writer: placeholder upsert lost the insert race, retrying once');
      expect(logged.orderId).toBe(orderId);
      expect(logged.correlationId).toBe(orderId);
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when no span is active, while still carrying correlationId', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const orderId = UniqueId.generate().value;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const writer = new MongoReadModelWriter(fakeCollection());

      await writer.apply(delta(orderId), UniqueId.generate().value, 'projector', async () => undefined);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
      expect(logged.correlationId).toBe(orderId);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
