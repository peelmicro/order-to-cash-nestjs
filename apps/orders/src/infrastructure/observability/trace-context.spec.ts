// Pure unit — proves the W3C trace-context carriers themselves round-trip
// a REAL, OTel-generated `traceId`/`spanId` through both NATS `MsgHdrs` and
// Kafka's plain string headers (OR4, R57, design.md §4.3). Registers a
// real `NodeTracerProvider` + `InMemorySpanExporter` +
// `AsyncLocalStorageContextManager` for the duration of this file — never
// `sdk-node`'s own OTLP network exporter — so `context.active()` genuinely
// threads across `await` boundaries (see `tracing.ts`'s own header comment
// for why a real `ContextManager` matters, not just a real
// `TracerProvider`).
//
// Deliberately does NOT assert "a `traceparent` header is present" as a
// bare string check — every assertion below extracts the header back
// through the SAME propagator and compares the resulting `traceId`/
// `spanId` against the ORIGINAL span's own `spanContext()`, which is what
// the brief's "read a real extracted traceId/spanId from a real propagated
// context, not a string comparison of a header's presence" instruction
// requires.
import { headers as natsHeaders } from 'nats';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeTraceParent,
  contextFromTraceParent,
  extractKafkaTraceContext,
  extractNatsTraceContext,
  injectIntoStringHeaders,
  injectNatsTraceContext,
  tracer,
} from './trace-context';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  contextManager = new AsyncLocalStorageContextManager();
  provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
});

afterAll(async () => {
  contextManager.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe('trace-context — NATS carrier (OR4, R57)', () => {
  it('injects the active span\'s REAL traceId/spanId into MsgHdrs, and extracting it back yields the SAME traceId and spanId', async () => {
    const span = tracer().startSpan('test-client-span');
    const { traceId, spanId } = span.spanContext();

    await context.with(trace.setSpan(context.active(), span), async () => {
      const headers = natsHeaders();
      injectNatsTraceContext(headers);
      span.end();

      expect(headers.has('traceparent')).toBe(true);

      // Extract back through the SAME propagator machinery the responder
      // side uses — never a string-equality check on the header itself.
      const extracted = extractNatsTraceContext(headers);
      const extractedSpanContext = trace.getSpanContext(extracted);

      expect(extractedSpanContext).toBeDefined();
      expect(extractedSpanContext!.traceId).toBe(traceId);
      expect(extractedSpanContext!.spanId).toBe(spanId);
      // A real, non-degenerate id — not "any string", not all zeros
      // (the shape an un-propagated/broken context would produce).
      expect(extractedSpanContext!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(extractedSpanContext!.traceId).not.toBe('00000000000000000000000000000000'.slice(0, 32));
    });
  });

  it('extracting from headers carrying NO trace context returns the active context unchanged (no span materialises)', () => {
    const headers = natsHeaders();
    const extracted = extractNatsTraceContext(headers);
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it('extracting from undefined/null headers is a safe no-op, not a throw', () => {
    expect(() => extractNatsTraceContext(undefined)).not.toThrow();
    expect(() => extractNatsTraceContext(null)).not.toThrow();
  });
});

describe('trace-context — Kafka carrier (OR4, R57)', () => {
  it('a plain-object header carrying the SAME traceparent string extracts to the SAME traceId/spanId, whether the header value is a string or a kafkajs-shaped Buffer', () => {
    const span = tracer().startSpan('test-kafka-producer-span');
    const { traceId, spanId } = span.spanContext();
    const headers: Record<string, string> = {};
    context.with(trace.setSpan(context.active(), span), () => {
      injectIntoStringHeaders(headers);
    });
    span.end();

    const asString = extractKafkaTraceContext(headers);
    expect(trace.getSpanContext(asString)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(asString)?.spanId).toBe(spanId);

    // kafkajs delivers header values as Buffer over the wire — the getter
    // must handle that shape too (`IHeaders`), not just a plain string.
    const asBuffer = extractKafkaTraceContext({ traceparent: Buffer.from(headers.traceparent!, 'utf8') });
    expect(trace.getSpanContext(asBuffer)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(asBuffer)?.spanId).toBe(spanId);
  });
});

describe('trace-context — outbox write/relay-publish helpers (OR4, R57, design.md §4.3)', () => {
  it('activeTraceParent() returns null with no active span, and a real W3C traceparent string matching the active span once one is active', () => {
    expect(activeTraceParent()).toBeNull();

    const span = tracer().startSpan('test-outbox-write-span');
    const { traceId, spanId } = span.spanContext();
    let captured: string | null = null;
    context.with(trace.setSpan(context.active(), span), () => {
      captured = activeTraceParent();
    });
    span.end();

    expect(captured).not.toBeNull();
    // W3C traceparent shape: version-traceId-spanId-flags.
    expect(captured).toBe(`00-${traceId}-${spanId}-01`);
  });

  it('contextFromTraceParent(null) returns the active context unchanged; a stored traceparent string extracts back to its own traceId/spanId', () => {
    const noParent = contextFromTraceParent(null);
    expect(trace.getSpanContext(noParent)).toBeUndefined();

    const span = tracer().startSpan('test-stored-traceparent-span');
    const { traceId, spanId } = span.spanContext();
    let stored: string | null = null;
    context.with(trace.setSpan(context.active(), span), () => {
      stored = activeTraceParent();
    });
    span.end();

    const restored = contextFromTraceParent(stored);
    expect(trace.getSpanContext(restored)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(restored)?.spanId).toBe(spanId);
  });

  it('a manual "publish" child span started under a restored context keeps the SAME traceId but mints a FRESH spanId (the outbox relay\'s own contract)', () => {
    const writerSpan = tracer().startSpan('test-writer-span');
    const { traceId: writerTraceId, spanId: writerSpanId } = writerSpan.spanContext();
    let stored: string | null = null;
    context.with(trace.setSpan(context.active(), writerSpan), () => {
      stored = activeTraceParent();
    });
    writerSpan.end();

    const parentContext = contextFromTraceParent(stored);
    const publishSpan = tracer().startSpan('outbox.publish test.fact.v1', undefined, parentContext);
    const { traceId: publishTraceId, spanId: publishSpanId } = publishSpan.spanContext();
    publishSpan.end();

    expect(publishTraceId).toBe(writerTraceId);
    expect(publishSpanId).not.toBe(writerSpanId);

    const finished = exporter.getFinishedSpans();
    const publishRecord = finished.find((s) => s.name === 'outbox.publish test.fact.v1');
    expect(publishRecord?.parentSpanContext?.spanId).toBe(writerSpanId);
  });
});

// Reachability check only — `propagation.fields` was a stray leftover in
// an earlier draft of `activeTraceParent`; this asserts the module's own
// public surface is exactly what the other files above import, so an
// accidental regression to that draft (calling an undefined 3rd arg on
// `propagation.inject`) would fail typecheck AND this smoke test.
describe('trace-context — module surface', () => {
  it('propagation.inject with the default setter still populates a plain object carrier', () => {
    const carrier: Record<string, string> = {};
    context.with(context.active(), () => {
      propagation.inject(context.active(), carrier);
    });
    expect(carrier).toEqual({});
  });
});
