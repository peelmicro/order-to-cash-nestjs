// Pure unit — A7 (metrics, R59/OR5, design.md §4.5): `OtelSagaMetrics`'s
// real wiring into `otc_saga_completion_ms`, against a real, globally
// registered `MeterProvider` + `InMemoryMetricExporter` (design.md §8, "no
// live collector needed"). `SagaFactHandler`'s own duration/gating logic
// is proven separately, against a fake, in
// `saga-fact-handler-saga-completion-metrics.spec.ts` — this file proves
// only that `OtelSagaMetrics.recordSagaCompletion` genuinely reaches the
// documented instrument name with the documented value and attribute.
import { describe, expect, it } from 'vitest';
import { findMetric, startMetricsTestHarness } from '../../test-support/metrics-test-provider';
import { OtelSagaMetrics } from './otel-saga-metrics';

describe('OtelSagaMetrics — otc_saga_completion_ms (A7, R59, OR5, design.md §4.5)', () => {
  it('records the exact duration and outcome attribute passed to it', async () => {
    const harness = startMetricsTestHarness();
    try {
      const metricsAdapter = new OtelSagaMetrics();

      metricsAdapter.recordSagaCompletion(1_234_567, 'completed');

      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_saga_completion_ms');
      expect(metric).toBeDefined();
      const point = metric!.dataPoints.find((p) => p.attributes.outcome === 'completed');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(1_234_567);
    } finally {
      await harness.teardown();
    }
  });

  it('distinguishes completed from cancelled by attribute, not a separate instrument', async () => {
    const harness = startMetricsTestHarness();
    try {
      const metricsAdapter = new OtelSagaMetrics();

      metricsAdapter.recordSagaCompletion(1_000, 'completed');
      metricsAdapter.recordSagaCompletion(2_000, 'cancelled');

      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_saga_completion_ms');
      const completed = metric!.dataPoints.find((p) => p.attributes.outcome === 'completed');
      const cancelled = metric!.dataPoints.find((p) => p.attributes.outcome === 'cancelled');
      expect((completed!.value as { sum?: number }).sum).toBe(1_000);
      expect((cancelled!.value as { sum?: number }).sum).toBe(2_000);
    } finally {
      await harness.teardown();
    }
  });
});
