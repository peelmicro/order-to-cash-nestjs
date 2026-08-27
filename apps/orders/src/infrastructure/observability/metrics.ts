// A7 — the five OTel metric instruments (`observability_reliability`
// design.md §4.5, R59/OR5). One `Meter`, read via the GLOBAL API
// (`metrics.getMeter('orders')`), the SAME convention `trace-context.ts`'s
// `tracer()` already establishes for spans: production registers a real
// `MeterProvider` globally via `tracing.ts` (this service's `main.ts`
// FIRST import, mirroring the existing trace bootstrap); every metrics
// TEST registers its own `MeterProvider` + `InMemoryMetricExporter`
// directly (design.md §8's "no live collector needed"), never this
// OTLP-exporting one.
//
// Instruments are (re-)created via `meter().createHistogram(...)`/
// `createGauge(...)` on every call rather than cached module-level — the
// OTel SDK matches instruments by `(name, kind)` internally against
// whichever `MeterProvider` is CURRENTLY globally registered, which is
// exactly what lets each test's own freshly-registered `MeterProvider`
// observe recordings without this module needing to know a new provider
// was swapped in.
import { metrics } from '@opentelemetry/api';

export const METER_NAME = 'orders';

export function meter() {
  return metrics.getMeter(METER_NAME);
}

/** Histogram — Gateway only in practice (`apps/gateway`'s own copy of this function), per-endpoint request latency. Declared here too only for the shared doc comment; `apps/orders` never records it. */
export const REQUEST_LATENCY_INSTRUMENT = 'otc_request_latency_ms';

/** Histogram — per consumer, `FactRetryDispatcher.dispatch`'s entry-to-exit duration (design.md §4.5). */
export const FACT_PROCESSING_LATENCY_INSTRUMENT = 'otc_fact_processing_latency_ms';

/** Histogram — Orders only, recorded when `order.completed.v1`/`order.cancelled.v1` closes a saga started by the order's own `order.placed.v1` timestamp (`order.orderDate`, R59). */
export const SAGA_COMPLETION_INSTRUMENT = 'otc_saga_completion_ms';

/** Gauge — the age (ms) of the oldest unpublished outbox record, or 0 when the outbox is fully caught up. */
export const OUTBOX_LAG_INSTRUMENT = 'otc_outbox_lag_ms';

/** Gauge — per topic, the message count sitting in a `.dlq` topic (a broker admin-client partition-offset query). */
export const DLQ_DEPTH_INSTRUMENT = 'otc_dlq_depth';

export function factProcessingLatencyHistogram() {
  return meter().createHistogram(FACT_PROCESSING_LATENCY_INSTRUMENT, {
    unit: 'ms',
    description: 'FactRetryDispatcher.dispatch entry-to-exit duration, per consumer (R59, OR5)',
  });
}

export function sagaCompletionHistogram() {
  return meter().createHistogram(SAGA_COMPLETION_INSTRUMENT, {
    unit: 'ms',
    description: "Duration from an order's own order.placed.v1 timestamp to the fact that closed its saga (R59, OR5)",
  });
}

export function outboxLagGauge() {
  return meter().createGauge(OUTBOX_LAG_INSTRUMENT, {
    unit: 'ms',
    description: 'Age of the oldest unpublished outbox record, 0 when caught up (R59, OR5)',
  });
}

export function dlqDepthGauge() {
  return meter().createGauge(DLQ_DEPTH_INSTRUMENT, {
    unit: '1',
    description: 'Message count currently in a .dlq topic, per topic (R59, OR5)',
  });
}
