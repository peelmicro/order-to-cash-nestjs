// A7 (metrics, R59/OR5, design.md §4.5, §8) — the shared test harness
// every Gateway metrics spec uses: a real `MeterProvider` +
// `InMemoryMetricExporter`, registered globally exactly the way
// production's `tracing.ts` registers its OTLP-exporting one — the SAME
// convention `apps/orders/src/test-support/metrics-test-provider.ts`
// establishes (this is that file's Gateway-side copy; not OI12/OB1-guarded
// — it is test-only support code, not a canonical production pattern).
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export interface MetricsTestHarness {
  collect(): Promise<ResourceMetrics[]>;
  teardown(): Promise<void>;
}

export function startMetricsTestHarness(): MetricsTestHarness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  return {
    async collect(): Promise<ResourceMetrics[]> {
      await reader.forceFlush();
      return exporter.getMetrics();
    },
    async teardown(): Promise<void> {
      metrics.disable();
      await provider.shutdown();
    },
  };
}

/**
 * Searches `batches` from the MOST RECENT collection backward —
 * `InMemoryMetricExporter` only ACCUMULATES across `export()` calls, so a
 * caller that collects more than once needs the LATEST reading (see
 * `apps/orders`'s own copy of this helper for the fuller rationale).
 */
export function findMetric(batches: ResourceMetrics[], instrumentName: string) {
  for (let i = batches.length - 1; i >= 0; i--) {
    for (const scope of batches[i]!.scopeMetrics) {
      const found = scope.metrics.find((metric) => metric.descriptor.name === instrumentName);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
