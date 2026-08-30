// W3C trace-context propagation helpers (A5b/A5c, R57, mirrors
// apps/orders/src/infrastructure/observability/trace-context.ts's own NATS
// extraction and `activeTraceParent` functions verbatim). Only the NATS
// half is copied here — this service has no outbound NATS RPC calls (it is
// an RPC RESPONDER only, `credit.controller.ts`/`invoice.controller.ts`)
// and consumes no Kafka fact (no `@EventPattern` handler, saga.md §5), so
// Orders' Kafka getter/injector and outbound-NATS injector functions have
// no caller here and are deliberately not copied.
//
// `contextFromTraceParent`/`startChildSpan` (observability_dashboards,
// phase 22) are the two exceptions to that "not copied" rule, added to
// close a genuine gap the phase's live-trace verification found: this
// service never created a single span of its own — `outbox-relay.ts`
// forwarded a stored `trace_parent` verbatim as the outbound Kafka header
// (a correct trace ID, continuing the caller's trace) but attached no span
// of billing's own to it, so this service never appeared as a participant
// in Jaeger even when it correctly held and forwarded the trace. Mirrors
// apps/orders/src/infrastructure/observability/trace-context.ts's own
// functions of the same name/shape verbatim.
import { context, propagation, trace, type Context, type Span, type SpanKind, type TextMapGetter } from '@opentelemetry/api';
import type { MsgHdrs } from 'nats';

export const TRACER_NAME = 'billing';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

const NATS_GETTER: TextMapGetter<MsgHdrs> = {
  keys: (carrier) => carrier.keys(),
  get: (carrier, key) => (carrier.has(key) ? carrier.get(key) : undefined),
};

/** Extracts a trace context from an inbound NATS request's headers (every `@MessagePattern` responder in this service — `credit.controller.ts`, `invoice.controller.ts`), or the current active context unchanged if none/absent. */
export function extractNatsTraceContext(headers: MsgHdrs | undefined | null): Context {
  if (!headers) {
    return context.active();
  }
  return propagation.extract(context.active(), headers, NATS_GETTER);
}

/** The active context's own `traceparent` string, or `null` if no trace context is active — what `OutboxRecorder.record` stores in `outbox.trace_parent`, continuing the trace the responder above extracted into the write and, from there, into the outbox-relayed Kafka fact (`outbox-relay.ts` already forwards a stored `trace_parent` verbatim as the outbound header; this function is what makes that forwarded value real instead of always-null). */
export function activeTraceParent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Builds a `Context` that continues from a stored `traceparent` string (the outbox relay's own manual "publish" span parents on this), or the current active context unchanged if none was stored (a pre-observability_dashboards row, or a fact produced with no active trace). Mirrors apps/orders' own function of the same name/shape verbatim. */
export function contextFromTraceParent(traceParent: string | null | undefined): Context {
  if (!traceParent) {
    return context.active();
  }
  return propagation.extract(context.active(), { traceparent: traceParent });
}

/** Starts a child span under `parentContext` and returns both the span and a `Context` with it set active — this service's own `outbox-relay.ts` "publish" span. Mirrors apps/orders' own function of the same name/shape verbatim. */
export function startChildSpan(name: string, parentContext: Context, kind: SpanKind): { span: Span; spanContext: Context } {
  const span = tracer().startSpan(name, { kind }, parentContext);
  return { span, spanContext: trace.setSpan(parentContext, span) };
}
