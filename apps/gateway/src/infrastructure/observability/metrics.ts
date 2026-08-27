// A7 — the Gateway's own OTel metric instrument (`observability_reliability`
// design.md §4.5, R59/OR5): `otc_request_latency_ms`, the ONE instrument
// design.md scopes to "Gateway only, per endpoint." Same "global `Meter`
// proxy, resolved fresh per call" convention `apps/orders`'s own
// `metrics.ts` establishes — production registers a real `MeterProvider`
// via `tracing.ts`; every metrics test registers its own
// `MeterProvider` + `InMemoryMetricExporter` (design.md §8).
import { metrics } from '@opentelemetry/api';

export const METER_NAME = 'gateway';

export function meter() {
  return metrics.getMeter(METER_NAME);
}

export const REQUEST_LATENCY_INSTRUMENT = 'otc_request_latency_ms';

export function requestLatencyHistogram() {
  return meter().createHistogram(REQUEST_LATENCY_INSTRUMENT, {
    unit: 'ms',
    description: 'HTTP request latency, per endpoint (controller.handler) (R59, OR5)',
  });
}
