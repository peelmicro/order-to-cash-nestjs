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

/**
 * A SETTABLE clock — `now()` returns whatever was last `set(...)`, exactly
 * like a real wall clock would to two calls straddling some work, and
 * UNLIKE `fixedClock` above: `fixedClock` advances on every CALL, so it
 * cannot tell apart "read before the retry loop starts" from "read inside
 * the first catch", because both are simply "the Nth call" when nothing
 * between them also reads the clock — the two shapes consume the same
 * array index and produce the same value. Mirrors the dotnet reference's
 * `FakeClock` (`tests/Orders.UnitTests/FactRetryDispatcherTests.cs`,
 * `DeadLetterPublication_FirstFailedAt_IsTheFirstAttemptsClockReading_NeverALaterOne`),
 * which is exactly this shape for exactly this reason.
 */
function mutableClock(initial: Date): Clock & { set(value: Date): void } {
  let current = initial;
  return {
    now: () => current,
    set(value: Date): void {
      current = value;
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
    // A SETTABLE clock, advanced by the process callback itself the
    // instant each attempt fails — so `firstFailedAt`
    // (asyncapi.yaml:2227-2229, SA-3) is proven to be the FIRST attempt's
    // own failure instant (t1), told apart from BOTH `enteredAt` (t0, the
    // dispatch-entry instant the contract explicitly forbids) and
    // `failedAt` (t3, the last attempt's instant). A dispatcher that reads
    // `firstFailedAt` before the loop starts (the old, wrong meaning)
    // observes t0 here, not t1 — genuinely distinguishable because the
    // clock has not yet been advanced at that point in real execution,
    // not merely because of how many times `clock.now()` happens to be
    // called (see `mutableClock`'s own comment).
    const t0 = new Date('2026-08-26T09:00:00.000Z'); // enteredAt
    const t1 = new Date('2026-08-26T09:00:01.000Z'); // attempt 1's own failure
    const t2 = new Date('2026-08-26T09:00:02.000Z'); // attempt 2's own failure
    const t3 = new Date('2026-08-26T09:00:03.000Z'); // attempt 3's own failure — also failedAt
    const clock = mutableClock(t0);
    const advances = [t1, t2, t3];
    const { delay, calls: delayCalls } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 3, backoffBaseMs: 500 });
    const env = envelope();
    let processCalls = 0;

    await dispatcher.dispatch('otc.orders.facts.v1', env, 'orders.saga', async () => {
      clock.set(advances[processCalls]!);
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
      firstFailedAt: t1, // the FIRST attempt's own failure, never enteredAt (t0) nor the last attempt's (t3)
      failedAt: t3,
    });
    expect((dlqCalls[0]!.meta.error as Error).message).toBe('boom');
  });

  it('x-first-failed-at equals x-failed-at when a single attempt was made (asyncapi.yaml:2227-2229, SA-3)', async () => {
    const t0 = new Date('2026-08-26T09:00:00.000Z'); // enteredAt
    const tFail = new Date('2026-08-26T09:00:05.000Z'); // the single attempt's own failure
    const clock = mutableClock(t0);
    const { delay } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 1, backoffBaseMs: 500 });

    await dispatcher.dispatch('otc.orders.facts.v1', envelope(), 'orders.saga', async () => {
      clock.set(tFail);
      throw new Error('boom');
    });

    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]!.meta.firstFailedAt).toEqual(dlqCalls[0]!.meta.failedAt);
    expect(dlqCalls[0]!.meta.firstFailedAt).toEqual(tFail); // never t0, the entry instant
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
