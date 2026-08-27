// W3C trace-context propagation helpers (A5b/A5c, R57, mirrors
// apps/orders/src/infrastructure/observability/trace-context.ts's own NATS
// extraction and `activeTraceParent` functions verbatim). Only the NATS
// half is copied here — this service has no outbound NATS RPC calls (it is
// an RPC RESPONDER only, `credit.controller.ts`/`invoice.controller.ts`)
// and consumes no Kafka fact (no `@EventPattern` handler, saga.md §5), so
// Orders' Kafka getter/injector and outbound-NATS injector functions have
// no caller here and are deliberately not copied.
import { context, propagation, trace, type Context, type TextMapGetter } from '@opentelemetry/api';
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
