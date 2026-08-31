// B5 closeout (progress/review_final_checkpoint.md) — `NatsStreamSignalAdapter`'s
// "failed to decode a signal frame" line was `console.error('[gateway]
// ...', error)`, not JSON-shaped and carrying no id at all: a CLAUDE.md §
// Logging violation (arguably outside R58's three named categories, since
// a signal frame is neither a fact-handling log nor a boot/CLI line — the
// reviewer did not press it as an R58 violation, only as this one).
//
// Two things proven here, honestly:
//
//   1. `correlationId` IS genuinely available on this path, even though
//      `message.data` failed to decode: NATS headers are a SEPARATE
//      channel from the payload
//      (`apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts`
//      sets `x-correlation-id` via `natsHeaders()` BEFORE encoding the
//      body), so a malformed body does not take the header with it. This
//      is not the same class as `saga-facts.controller.ts`'s
//      malformed-envelope exclusion, where no trustworthy value exists at
//      all — here one does, and it is threaded.
//   2. `traceId` follows the SAME `activeTraceId()` formula as every other
//      R58 site in this service: whatever span is active when the log
//      fires, or omitted — never the literal string `"undefined"` — when
//      none is. `main.ts` calls `NatsStreamSignalAdapter.start()` at boot,
//      OUTSIDE any request span (there is no HTTP-style
//      auto-instrumentation for a plain core-NATS subscribe loop, unlike
//      the inbound-HTTP case `problem-json.filter.ts` relies on), so in
//      this service's actual production call site the key is honestly
//      absent — proven by the second test below, which registers a real
//      OTel provider but starts the adapter with NO span active, exactly
//      `main.ts`'s own shape. The third test proves the mechanism itself
//      is real (not a dead `activeTraceId()` call that always returns
//      `undefined`) by showing it DOES thread a real `traceId` when one
//      genuinely is active — the same "prove the plumbing, not just the
//      absence" shape `degrading-notification-sender-log-trace-id.spec.ts`
//      uses.
import { headers as natsHeaders } from 'nats';
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StreamHub } from '../../application/stream-hub';
import { NatsStreamSignalAdapter, ORDER_UPDATED_WILDCARD_SUBJECT } from './nats-stream-signal.adapter';

function fakeSubscription(frames: { data: Uint8Array; subject: string; headers?: ReturnType<typeof natsHeaders> }[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        yield frame;
      }
    },
    unsubscribe: vi.fn(),
  };
}

function buildAdapter(orderUpdatedFrames: { data: Uint8Array; subject: string; headers?: ReturnType<typeof natsHeaders> }[]) {
  const orderUpdatedSub = fakeSubscription(orderUpdatedFrames);
  const timelineSub = fakeSubscription([]);
  const connection = { subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)) };
  const hub = new StreamHub({ now: () => new Date('2026-08-31T10:00:00.000Z') }, 10);
  return new NatsStreamSignalAdapter(connection as never, hub);
}

const MALFORMED = new TextEncoder().encode('not json');

describe('NatsStreamSignalAdapter — decode-failure log carries a real correlationId, and honestly omits traceId (B5 closeout)', () => {
  it('reads x-correlation-id from the NATS HEADERS (a channel separate from the malformed payload), never from the body it failed to decode', async () => {
    const h = natsHeaders();
    h.set('x-correlation-id', 'order-42');
    const adapter = buildAdapter([{ data: MALFORMED, subject: 'readmodel.order.updated.order-42', headers: h }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    adapter.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.correlationId).toBe('order-42');
    errorSpy.mockRestore();
  });

  it('omits correlationId entirely — never the literal string "undefined" — when the frame carries no x-correlation-id header at all', async () => {
    const adapter = buildAdapter([{ data: MALFORMED, subject: 'readmodel.order.updated.order-99' }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    adapter.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const rawLine = errorSpy.mock.calls[0]![0] as string;
    expect(rawLine).not.toContain('"correlationId"');
    errorSpy.mockRestore();
  });

  it('omits traceId when the adapter is started with NO span active — the ACTUAL production shape (main.ts calls start() at boot, outside any request span), even with a real OTel provider registered', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const adapter = buildAdapter([{ data: MALFORMED, subject: 'readmodel.order.updated.order-7' }]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      adapter.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it("threads the REAL active span's traceId when one genuinely IS active at the moment the decode failure is logged — proves activeTraceId() is really wired, not a dead call", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const adapter = buildAdapter([{ data: MALFORMED, subject: 'readmodel.order.updated.order-8' }]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const originSpan = trace.getTracer('test').startSpan('gateway boot');
      const { traceId: originTraceId } = originSpan.spanContext();

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        adapter.start();
        await new Promise((resolve) => setImmediate(resolve));
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
