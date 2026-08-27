// Pure unit — A7 (metrics, R59/OR5, design.md §4.5): `FactRetryDispatcher.
// dispatch`'s own `otc_fact_processing_latency_ms` histogram, recorded
// entry-to-exit (design.md's own orientation names this method's
// "entry/exit" as where consumer latency is measured), attributed by
// `consumer`. Proves the recorded VALUE, not merely that a number was
// emitted — the fake `Clock` makes the exact duration deterministic.
import { describe, expect, it } from 'vitest';
import { DataPointType } from '@opentelemetry/sdk-metrics';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import { findMetric, startMetricsTestHarness } from '../../test-support/metrics-test-provider';
import {
  FactRetryDispatcher,
  type DelayPort,
  type DlqPublisher,
} from './fact-retry-dispatcher';

function fixedClock(instants: readonly Date[]): Clock {
  let index = 0;
  return {
    now(): Date {
      const value = instants[Math.min(index, instants.length - 1)]!;
      index += 1;
      return value;
    },
  };
}

const instantDelay: DelayPort = { for: async () => undefined };
const noopDlq: DlqPublisher = { publish: async () => undefined };

function envelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: new Date('2026-08-26T09:00:00.000Z'),
    payload: {},
  } as unknown as Envelope;
}

describe('FactRetryDispatcher — otc_fact_processing_latency_ms (A7, R59, OR5, design.md §4.5)', () => {
  it('records the REAL entry-to-exit duration, by consumer, on the success path', async () => {
    const harness = startMetricsTestHarness();
    try {
      const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z'), new Date('2026-08-26T09:00:00.240Z')]);
      const dispatcher = new FactRetryDispatcher(clock, instantDelay, noopDlq, { maxAttempts: 3, backoffBaseMs: 500 });

      await dispatcher.dispatch('otc.orders.facts.v1', envelope(), 'orders.saga', async () => undefined);

      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_fact_processing_latency_ms');
      expect(metric).toBeDefined();
      expect(metric!.dataPointType).toBe(DataPointType.HISTOGRAM);

      const point = metric!.dataPoints.find((p) => p.attributes.consumer === 'orders.saga');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(240); // 09:00:00.240 - 09:00:00.000, the EXACT clock-driven duration
    } finally {
      await harness.teardown();
    }
  });

  it('records the REAL entry-to-exit duration on the exhausted-retry/DLQ path too (design.md: "entry/exit" of the WHOLE call, not only the success branch)', async () => {
    const harness = startMetricsTestHarness();
    try {
      const clock = fixedClock([
        new Date('2026-08-26T09:00:00.000Z'), // entry
        new Date('2026-08-26T09:00:05.000Z'), // failedAt (existing DLQ-meta timestamp)
        new Date('2026-08-26T09:00:05.750Z'), // exit — the histogram record
      ]);
      const dispatcher = new FactRetryDispatcher(clock, instantDelay, noopDlq, { maxAttempts: 1, backoffBaseMs: 0 });

      await dispatcher.dispatch('otc.orders.facts.v1', envelope(), 'projector', async () => {
        throw new Error('boom');
      });

      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_fact_processing_latency_ms');
      const point = metric!.dataPoints.find((p) => p.attributes.consumer === 'projector');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(5750); // 09:00:05.750 - 09:00:00.000
    } finally {
      await harness.teardown();
    }
  });
});
