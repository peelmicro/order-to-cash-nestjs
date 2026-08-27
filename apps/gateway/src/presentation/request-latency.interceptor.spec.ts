// Pure unit — A7 (metrics, R59/OR5, design.md §4.5): `RequestLatencyInterceptor`'s
// `otc_request_latency_ms`, proven against a real `InMemoryMetricExporter`
// (design.md §8, "no live collector needed"), with a fake `Clock` making
// the recorded duration exact and deterministic. Proves the VALUE, not
// merely that a number was emitted, on both the success AND error paths
// (design.md: latency matters for a slow failing request too).
import { describe, expect, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { Clock } from '../application/ports/clock.port';
import { findMetric, startMetricsTestHarness } from '../test-support/metrics-test-provider';
import { RequestLatencyInterceptor } from './request-latency.interceptor';

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

function fakeContext(handlerName: string, className: string, method = 'GET'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method }),
      getResponse: () => ({ statusCode: 200 }),
    }),
    getClass: () => ({ name: className }),
    getHandler: () => ({ name: handlerName }),
  } as unknown as ExecutionContext;
}

describe('RequestLatencyInterceptor — otc_request_latency_ms (A7, R59, OR5, design.md §4.5)', () => {
  it('records the REAL entry-to-exit duration, attributed by controller.handler, on a successful response', async () => {
    const harness = startMetricsTestHarness();
    try {
      const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z'), new Date('2026-08-26T09:00:00.180Z')]);
      const interceptor = new RequestLatencyInterceptor(clock);
      const handler: CallHandler = { handle: () => of({ ok: true }) };

      const result = await firstValueFrom(interceptor.intercept(fakeContext('create', 'OrdersController'), handler));

      expect(result).toEqual({ ok: true });
      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_request_latency_ms');
      expect(metric).toBeDefined();
      const point = metric!.dataPoints.find((p) => p.attributes.endpoint === 'OrdersController.create');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(180);
      expect(point!.attributes.method).toBe('GET');
    } finally {
      await harness.teardown();
    }
  });

  it('records the REAL entry-to-exit duration on an ERROR response too (latency matters for a failing request)', async () => {
    const harness = startMetricsTestHarness();
    try {
      const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z'), new Date('2026-08-26T09:00:00.075Z')]);
      const interceptor = new RequestLatencyInterceptor(clock);
      const handler: CallHandler = { handle: () => throwError(() => new Error('boom')) };

      await expect(firstValueFrom(interceptor.intercept(fakeContext('list', 'StockController'), handler))).rejects.toThrow('boom');

      const batches = await harness.collect();
      const metric = findMetric(batches, 'otc_request_latency_ms');
      const point = metric!.dataPoints.find((p) => p.attributes.endpoint === 'StockController.list');
      expect(point).toBeDefined();
      const histogram = point!.value as { count: number; sum?: number };
      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(75);
    } finally {
      await harness.teardown();
    }
  });
});
