// A7 (metrics, R59/OR5, design.md §4.5, §8) — the shared test harness
// every metrics spec in this feature uses: a real `MeterProvider` +
// `InMemoryMetricExporter`, registered globally exactly the way
// production's `tracing.ts` registers its OTLP-exporting one, so
// `metrics.ts`'s `meter()` (`metrics.getMeter('orders')`) resolves against
// it — "no live collector needed for the test" (design.md §8), the SAME
// convention `trace-context.spec.ts`/`saga-facts-trace-continuity.spec.ts`
// already established for spans via `NodeTracerProvider` +
// `InMemorySpanExporter`.
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export interface MetricsTestHarness {
  /** Forces one collection cycle and returns every `ResourceMetrics` batch collected SINCE the harness started (never just the latest — a caller that wants only the newest reads the array's last element). */
  collect(): Promise<ResourceMetrics[]>;
  /** Unregisters the global `MeterProvider` and shuts it down — call in every test's own `finally`, mirroring the trace-test convention. */
  teardown(): Promise<void>;
}

export function startMetricsTestHarness(): MetricsTestHarness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A long `exportIntervalMillis` — this harness never waits for the
  // periodic timer; `collect()` below calls `reader.forceFlush()`
  // directly, the same "force a synchronous collection, no bare sleep"
  // discipline this project applies everywhere else.
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
 * Finds one instrument's `MetricData` by name — searching `batches` from
 * the MOST RECENT collection backward. `InMemoryMetricExporter` never
 * replaces or merges across `export()` calls, it only ACCUMULATES
 * (`collect()` appends one more `ResourceMetrics` batch every time it is
 * called) — a caller that calls `collect()` more than once (e.g. to
 * observe a gauge's value change between two poll cycles) needs the
 * LATEST reading, not whichever batch happened to be pushed first.
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
