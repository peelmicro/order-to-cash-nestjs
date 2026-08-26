// W3C trace-context propagation helpers (OR4, R57, design.md §4.3) — the
// Kafka-only subset of
// apps/orders/src/infrastructure/observability/trace-context.ts's shape
// (this service consumes facts but issues no NATS RPC — see
// presentation/notification-facts.controller.ts's own header comment: "this
// service answers no RPC and emits no fact"). Two call sites: the
// fact-consume entry point (`route`) and the DLQ publisher's headers
// (`../messaging/kafka-dlq-publisher.ts`).
//
// The `outbox.trace_parent` shape does not exist in THIS service (it owns
// no outbox — it only consumes), so there is no "inject at write time"
// helper here, only extract (consume) and inject-into-a-plain-carrier
// (the DLQ republish).
import { context, propagation, trace, type Context, type Span, type SpanKind, type TextMapGetter } from '@opentelemetry/api';

export const TRACER_NAME = 'notifications';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
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

/** Extracts a trace context from an inbound Kafka message's headers — `notification-facts.controller.ts`'s `route`. */
export function extractKafkaTraceContext(headers: KafkaHeaderCarrier | undefined | null): Context {
  if (!headers) {
    return context.active();
  }
  return propagation.extract(context.active(), headers, KAFKA_GETTER);
}

/** Injects `ctx`'s (or, by default, the active context's) `traceparent` into a plain string-headers carrier — the DLQ publisher's headers, so a dead-lettered fact stays on the same trace as the retries that preceded it. */
export function injectIntoStringHeaders(headers: Record<string, string>, ctx: Context = context.active()): void {
  propagation.inject(ctx, headers);
}

/** Starts a child span under `parentContext` and returns both the span and a `Context` with it set active. */
export function startChildSpan(name: string, parentContext: Context, kind: SpanKind): { span: Span; spanContext: Context } {
  const span = tracer().startSpan(name, { kind }, parentContext);
  return { span, spanContext: trace.setSpan(parentContext, span) };
}
