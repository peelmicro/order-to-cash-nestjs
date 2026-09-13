// Pure unit — SA-3 (asyncapi.yaml:2227-2229): "x-first-failed-at is the
// instant the FIRST processing attempt failed — never the instant
// processing began; it equals x-failed-at only when a single attempt was
// made." This copy of `FactRetryDispatcher` (COPY OF banner at the top of
// `fact-retry-dispatcher.ts`) had no spec of its own asserting this header
// at all — its only dispatcher spec,
// `fact-retry-dispatcher-log-trace-id.spec.ts`, is about trace ids — so the
// wrong-meaning defect (`firstFailedAt = this.clock.now()` taken BEFORE the
// retry loop, i.e. the dispatch-ENTRY instant) shipped unguarded here. Same
// shape as the corrected `apps/orders` spec (dead_letter_first_failed_at_semantics,
// backlog id 75).
import { describe, expect, it } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import { FactRetryDispatcher, type DelayPort, type DlqPublishMeta, type DlqPublisher } from './fact-retry-dispatcher';

/**
 * A SETTABLE clock — `now()` returns whatever was last `set(...)`. Required
 * here (rather than a call-ordinal `fixedClock`) because this file, unlike
 * `apps/orders`'s canonical, has no separate `enteredAt` read: BOTH the old
 * (wrong) "read before the loop" code and the fixed "read inside the first
 * catch" code call `clock.now()` the exact same number of times, in the
 * same relative ORDER, so a clock that merely advances per-call cannot
 * tell them apart — both consume the same array index and read the same
 * value regardless of WHEN in real execution the call happens. A settable
 * clock, advanced by the process callback the instant an attempt actually
 * fails, makes "before the loop" and "inside the first catch" observably
 * different, mirroring the dotnet reference's `FakeClock`
 * (`tests/Orders.UnitTests/FactRetryDispatcherTests.cs`).
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

describe('FactRetryDispatcher (notifications) — x-first-failed-at semantics (asyncapi.yaml:2227-2229, SA-3)', () => {
  it('firstFailedAt is the FIRST attempt’s own failure instant, never the dispatch-entry instant nor the last attempt’s', async () => {
    const t0 = new Date('2026-08-26T09:00:00.000Z'); // dispatch entry — a dispatcher reading here is WRONG
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

    await dispatcher.dispatch('otc.notifications.facts.v1', env, 'notifications', async () => {
      clock.set(advances[processCalls]!);
      processCalls += 1;
      throw new Error('boom');
    });

    expect(processCalls).toBe(3);
    expect(delayCalls).toEqual([500, 1000]);
    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]!.meta).toMatchObject({
      failedConsumer: 'notifications',
      attempts: 3,
      firstFailedAt: t1, // the FIRST attempt's own failure, never t0 (entry) nor t3 (last attempt)
      failedAt: t3,
    });
  });

  it('firstFailedAt equals failedAt when a single attempt was made', async () => {
    const t0 = new Date('2026-08-26T09:00:00.000Z'); // dispatch entry
    const tFail = new Date('2026-08-26T09:00:05.000Z'); // the single attempt's own failure
    const clock = mutableClock(t0);
    const { delay } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 1, backoffBaseMs: 500 });

    await dispatcher.dispatch('otc.notifications.facts.v1', envelope(), 'notifications', async () => {
      clock.set(tFail);
      throw new Error('boom');
    });

    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]!.meta.firstFailedAt).toEqual(dlqCalls[0]!.meta.failedAt);
    expect(dlqCalls[0]!.meta.firstFailedAt).toEqual(tFail); // never t0, the entry instant
  });
});
