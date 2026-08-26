// W3C trace-context propagation helpers (OR4, R57, design.md §4.3). This
// service is the ONLY one that needs both carriers: NATS `MsgHdrs` (the
// `orders.create` responder — `../../presentation/orders-create.controller.ts`
// — and the outbound saga-command calls —
// `../messaging/nats-saga-commands.adapter.ts`) and Kafka's plain string
// headers (the fact-consume entry point —
// `../../presentation/saga-facts.controller.ts` — and the outbox relay's
// publish call — `../outbox/outbox-relay.ts`).
//
// The `outbox.trace_parent` column stores exactly the W3C `traceparent`
// field's OWN value, nothing else (`outbox.schema.ts`'s own column
// comment) — this repo's schema provisions no `trace_state` column, so
// `tracestate` is deliberately not persisted or round-tripped through
// Kafka; a `traceparent` alone is sufficient for trace CONTINUITY (same
// `trace-id`, a real parent `span-id`), which is everything R57 asks for.
import { context, propagation, trace, type Context, type Span, type SpanKind, type TextMapGetter, type TextMapSetter } from '@opentelemetry/api';
import type { MsgHdrs } from 'nats';

export const TRACER_NAME = 'orders';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

const NATS_SETTER: TextMapSetter<MsgHdrs> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

const NATS_GETTER: TextMapGetter<MsgHdrs> = {
  keys: (carrier) => carrier.keys(),
  get: (carrier, key) => (carrier.has(key) ? carrier.get(key) : undefined),
};

/** Injects the active trace context's `traceparent`/`tracestate` into an outbound NATS request's headers — `nats-saga-commands.adapter.ts`'s `requestHeaders(meta)`. */
export function injectNatsTraceContext(headers: MsgHdrs): void {
  propagation.inject(context.active(), headers, NATS_SETTER);
}

/** Extracts a trace context from an inbound NATS request's headers (the `orders.create` responder), or the current active context unchanged if none/absent. */
export function extractNatsTraceContext(headers: MsgHdrs | undefined | null): Context {
  if (!headers) {
    return context.active();
  }
  return propagation.extract(context.active(), headers, NATS_GETTER);
}

/** kafkajs delivers header values as `Buffer | string | (Buffer | string)[] | undefined` (`IHeaders`) — never a bare string carrier. */
export type KafkaHeaderCarrier = Record<string, Buffer | string | (Buffer | string)[] | undefined>;

function headerValueToString(value: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (Array.isArray(value)) {
    const [first] = value;
    return first === undefined ? undefined : headerValueToString(first);
  }
  return value;
}

const KAFKA_GETTER: TextMapGetter<KafkaHeaderCarrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => headerValueToString(carrier[key]),
};

/** Extracts a trace context from an inbound Kafka message's headers — `saga-facts.controller.ts`'s `route`. */
export function extractKafkaTraceContext(headers: KafkaHeaderCarrier | undefined | null): Context {
  if (!headers) {
    return context.active();
  }
  return propagation.extract(context.active(), headers, KAFKA_GETTER);
}

/** The active context's own `traceparent` string, or `null` if no trace context is active — what `OutboxRecorder.record` stores in `outbox.trace_parent` (design.md §4.3: "captured from the active trace context of the command handler that produced it"). */
export function activeTraceParent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Builds a `Context` that continues from a stored `traceparent` string (the outbox relay's own manual "publish" span parents on this), or the current active context unchanged if none was stored (a pre-feature-27 row, or a fact produced with no active trace). */
export function contextFromTraceParent(traceParent: string | null | undefined): Context {
  if (!traceParent) {
    return context.active();
  }
  return propagation.extract(context.active(), { traceparent: traceParent });
}

/** Injects `ctx`'s (or, by default, the active context's) `traceparent` into a plain string-headers carrier — the outbox relay's per-fact headers, the DLQ publisher's headers. Reuses the propagator's own default object setter (assign-by-key), which is exactly what a plain `Record<string, string>` needs. */
export function injectIntoStringHeaders(headers: Record<string, string>, ctx: Context = context.active()): void {
  propagation.inject(ctx, headers);
}

/** Starts a child span under `parentContext` and returns both the span and a `Context` with it set active — the shared shape both manual-span points (`outbox-relay.ts`, `saga-facts.controller.ts`) use. */
export function startChildSpan(name: string, parentContext: Context, kind: SpanKind): { span: Span; spanContext: Context } {
  const span = tracer().startSpan(name, { kind }, parentContext);
  return { span, spanContext: trace.setSpan(parentContext, span) };
}
