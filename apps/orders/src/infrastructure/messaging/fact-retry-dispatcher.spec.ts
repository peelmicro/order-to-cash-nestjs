// Pure unit — fake Clock/DelayPort/DlqPublisher (CLAUDE.md § Testing
// conventions). Proves OR1's retry-then-DLQ policy: bounded in-line
// retries with exponential backoff, exactly one DLQ publish on
// exhaustion, no rethrow (the offset must still commit) — and, on the
// success path, that the DLQ is never touched at all.
import { describe, expect, it } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import {
  DEFAULT_FACT_RETRY_POLICY,
  FactRetryDispatcher,
  loadFactRetryPolicy,
  type DelayPort,
  type DlqPublishMeta,
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

function instantDelay(): { delay: DelayPort; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    delay: {
      async for(ms: number): Promise<void> {
        calls.push(ms);
      },
    },
  };
}

function fakeDlq(): { publisher: DlqPublisher; calls: Array<{ sourceTopic: string; envelope: Envelope; meta: DlqPublishMeta }> } {
  const calls: Array<{ sourceTopic: string; envelope: Envelope; meta: DlqPublishMeta }> = [];
  return {
    calls,
    publisher: {
      async publish(sourceTopic, envelope, meta) {
        calls.push({ sourceTopic, envelope, meta });
      },
    },
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: UniqueId.generate(),
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate(),
    correlationId: UniqueId.generate(),
    causationId: UniqueId.generate(),
    occurredAt: new Date('2026-08-26T09:00:00.000Z'),
    payload: {},
    ...overrides,
  } as unknown as Envelope;
}

describe('FactRetryDispatcher — OR1 (retry-then-DLQ)', () => {
  it('retries up to the configured maximum with exponential backoff, then publishes to the dlq topic and swallows', async () => {
    const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z'), new Date('2026-08-26T09:00:05.000Z')]);
    const { delay, calls: delayCalls } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 3, backoffBaseMs: 500 });
    const env = envelope();
    let processCalls = 0;

    await dispatcher.dispatch('otc.orders.facts.v1', env, 'orders.saga', async () => {
      processCalls += 1;
      throw new Error('boom');
    });

    expect(processCalls).toBe(3);
    expect(delayCalls).toEqual([500, 1000]); // backoffBaseMs * 2^(attempt-1), attempts 1 and 2 only
    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]!.sourceTopic).toBe('otc.orders.facts.v1');
    expect(dlqCalls[0]!.envelope).toBe(env); // the UNMODIFIED original envelope
    expect(dlqCalls[0]!.meta).toMatchObject({
      failedConsumer: 'orders.saga',
      attempts: 3,
      firstFailedAt: new Date('2026-08-26T09:00:00.000Z'),
      failedAt: new Date('2026-08-26T09:00:05.000Z'),
    });
    expect((dlqCalls[0]!.meta.error as Error).message).toBe('boom');
  });

  it('retries then succeeds without ever calling dlq.publish', async () => {
    const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z')]);
    const { delay, calls: delayCalls } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 3, backoffBaseMs: 500 });
    let processCalls = 0;

    await dispatcher.dispatch('otc.orders.facts.v1', envelope(), 'orders.saga', async () => {
      processCalls += 1;
      if (processCalls < 2) {
        throw new Error('transient');
      }
    });

    expect(processCalls).toBe(2);
    expect(delayCalls).toEqual([500]);
    expect(dlqCalls).toHaveLength(0);
  });

  it('succeeds on the first attempt without any delay or DLQ call', async () => {
    const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z')]);
    const { delay, calls: delayCalls } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher);
    let processCalls = 0;

    await dispatcher.dispatch('otc.orders.facts.v1', envelope(), 'projector', async () => {
      processCalls += 1;
    });

    expect(processCalls).toBe(1);
    expect(delayCalls).toEqual([]);
    expect(dlqCalls).toHaveLength(0);
  });
});

describe('loadFactRetryPolicy — env-var defaults (design.md §6)', () => {
  it('defaults to FACT_RETRY_MAX_ATTEMPTS=3, FACT_RETRY_BACKOFF_MS=500 when unset', () => {
    expect(loadFactRetryPolicy({})).toEqual(DEFAULT_FACT_RETRY_POLICY);
  });

  it('reads both from the environment when present', () => {
    expect(loadFactRetryPolicy({ FACT_RETRY_MAX_ATTEMPTS: '5', FACT_RETRY_BACKOFF_MS: '250' })).toEqual({
      maxAttempts: 5,
      backoffBaseMs: 250,
    });
  });
});
