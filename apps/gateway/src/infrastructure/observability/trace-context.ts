// W3C trace-context propagation helpers (OR4, R57, design.md §4.3) — the
// NATS-only subset of
// apps/orders/src/infrastructure/observability/trace-context.ts's shape.
// The Gateway's inbound side needs no manual helper at all:
// `@opentelemetry/instrumentation-http` auto-instruments Express, so the
// inbound HTTP request already carries a real, active span by the time any
// application code runs — this file exists only for the ONE outbound call
// this service makes over a transport with no auto-instrumentation:
// `../messaging/nats-rpc-client.adapter.ts`'s `requestHeaders(meta)`.
import { context, propagation, trace, type TextMapSetter } from '@opentelemetry/api';
import type { MsgHdrs } from 'nats';

const NATS_SETTER: TextMapSetter<MsgHdrs> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

/** Injects the active trace context's `traceparent`/`tracestate` into an outbound NATS request's headers — `nats-rpc-client.adapter.ts`'s `requestHeaders(meta)`. */
export function injectNatsTraceContext(headers: MsgHdrs): void {
  propagation.inject(context.active(), headers, NATS_SETTER);
}

/**
 * R58 (design.md §4.4) — `problem-json.filter.ts`'s own structured error
 * log gains a `traceId` alongside `correlationId`, read from the ACTIVE
 * span (`@opentelemetry/instrumentation-http` already leaves a real one
 * active for the whole lifetime of an inbound HTTP request — see
 * `tracing.ts`'s own header comment). `undefined` when genuinely none is
 * active (no provider registered, e.g. a plain unit test) — the caller
 * omits the `traceId` key rather than log the literal string `"undefined"`.
 * Same formula, same shape as Orders' own copy of this function
 * (`trace-context.ts`) — not shared runtime code, per the same
 * "~30 lines per service" reasoning `OI12`/`design.md` §4.6 already
 * establish for other small, service-local helpers.
 */
export function activeTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
