// Pure unit tests, three layers:
//
//  1. `DegradingNotificationSender` in isolation — the classify/rethrow-or-
//     fall-back decision itself.
//  2. Composed with the REAL `FactRetryDispatcher` (byte-identical copy of
//     the canonical, `../messaging/fact-retry-dispatcher.ts`) — proves a
//     TRANSIENT send failure still retries exactly as today and still
//     dead-letters on exhaustion. Nothing about that path may change.
//  3. Composed with the REAL `NotificationDispatchService` — proves a
//     PERMANENT send failure results in the fact being ACKNOWLEDGED (no
//     throw out of `dispatch`, no compensating delete of the idempotency
//     ledger row) rather than dead-lettered, with the message rendered to
//     the console (fallback) sender.
import { describe, expect, it, vi } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import {
  NotificationDispatchService,
  type ConsumptionOutcome,
  type DeletesProcessedEvent,
  type RunsIdempotently,
} from '../../application/notification-dispatch.service';
import {
  FactRetryDispatcher,
  type DelayPort,
  type DlqPublishMeta,
  type DlqPublisher,
} from '../messaging/fact-retry-dispatcher';
import { DegradingNotificationSender, type DegradingNotificationSenderLogger } from './degrading-notification-sender';

const MESSAGE: NotificationMessage = { to: 'retailer01@retailer.order-to-cash.example', subject: 'subject', text: 'text', html: '<p>html</p>' };

/** Shapes a fake error exactly the way nodemailer's `_formatError` does — see `send-failure-classifier.spec.ts`. */
function nodemailerError(message: string, extra: { code?: string; responseCode?: number } = {}): Error {
  return Object.assign(new Error(message), extra);
}

const QUOTA_EXHAUSTED_ERROR = nodemailerError(
  'Invalid login: 535 5.7.0 The email limit is reached. Please upgrade your plan https://mailtrap.io/billing/plans/testing',
  { code: 'EAUTH', responseCode: 535 },
);

const SOCKET_ERROR = nodemailerError('socket hang up', { code: 'ESOCKET' });

function recordingLogger(): { logger: DegradingNotificationSenderLogger; calls: Array<{ message: string; meta: Record<string, unknown> }> } {
  const calls: Array<{ message: string; meta: Record<string, unknown> }> = [];
  return {
    calls,
    logger: {
      error(message, meta) {
        calls.push({ message, meta });
      },
    },
  };
}

describe('DegradingNotificationSender — in isolation', () => {
  it('delegates to inner and never touches fallback on success', async () => {
    const inner: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = new DegradingNotificationSender(inner, fallback);

    await sender.send(MESSAGE);

    expect(inner.send).toHaveBeenCalledWith(MESSAGE);
    expect(fallback.send).not.toHaveBeenCalled();
  });

  // The transient half of the classification — R-degrade's "must not
  // change" requirement, proven at this layer before layer 2 proves it
  // end-to-end through the real FactRetryDispatcher.
  it('rethrows a transient failure UNCHANGED and never calls fallback', async () => {
    const inner: NotificationSender = { send: vi.fn().mockRejectedValue(SOCKET_ERROR) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = new DegradingNotificationSender(inner, fallback);

    await expect(sender.send(MESSAGE)).rejects.toBe(SOCKET_ERROR);
    expect(fallback.send).not.toHaveBeenCalled();
  });

  // The permanent half — the OTHER branch this armed test protects (see
  // this file's header, layer 2/3 below for the "arm the deletion" record
  // in progress/impl_notification_degradation.md).
  it('a permanent failure resolves normally (does not rethrow), renders to fallback, and logs loudly with the underlying reason', async () => {
    const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const { logger, calls } = recordingLogger();
    const sender = new DegradingNotificationSender(inner, fallback, logger);

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined();

    expect(fallback.send).toHaveBeenCalledWith(MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.meta.event).toBe('notification.send.degraded');
    expect(calls[0]!.meta.reason).toMatchObject({ code: 'EAUTH', responseCode: 535 });
    expect(String(calls[0]!.meta.reason)).not.toContain('undefined');
  });

  it('a permanent failure is distinguishable in logs from a successful send — the log line only fires on degradation', async () => {
    const inner: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const { logger, calls } = recordingLogger();
    const sender = new DegradingNotificationSender(inner, fallback, logger);

    await sender.send(MESSAGE);

    expect(calls).toHaveLength(0);
  });
});

// --- layer 2: composed with the REAL FactRetryDispatcher --------------

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
  return { calls, delay: { async for(ms: number): Promise<void> { calls.push(ms); } } };
}

function fakeDlq(): { publisher: DlqPublisher; calls: Array<{ sourceTopic: string; envelope: Envelope; meta: DlqPublishMeta }> } {
  const calls: Array<{ sourceTopic: string; envelope: Envelope; meta: DlqPublishMeta }> = [];
  return { calls, publisher: { async publish(sourceTopic, envelope, meta) { calls.push({ sourceTopic, envelope, meta }); } } };
}

function envelope(): Envelope {
  return {
    eventId: UniqueId.generate(),
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate(),
    correlationId: UniqueId.generate(),
    causationId: UniqueId.generate(),
    occurredAt: new Date('2026-08-26T09:00:00.000Z'),
    payload: {},
  } as unknown as Envelope;
}

describe('DegradingNotificationSender composed with the real FactRetryDispatcher — transient path is UNCHANGED', () => {
  it('a transient send failure retries 3x with backoff and dead-letters on exhaustion — same as before this feature', async () => {
    const inner: NotificationSender = { send: vi.fn().mockRejectedValue(SOCKET_ERROR) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = new DegradingNotificationSender(inner, fallback);

    const clock = fixedClock([new Date('2026-08-26T09:00:00.000Z'), new Date('2026-08-26T09:00:05.000Z')]);
    const { delay, calls: delayCalls } = instantDelay();
    const { publisher, calls: dlqCalls } = fakeDlq();
    const dispatcher = new FactRetryDispatcher(clock, delay, publisher, { maxAttempts: 3, backoffBaseMs: 500 });
    const env = envelope();

    await dispatcher.dispatch('otc.orders.facts.v1', env, 'notifications', async () => {
      await sender.send(MESSAGE);
    });

    expect(inner.send).toHaveBeenCalledTimes(3);
    expect(fallback.send).not.toHaveBeenCalled();
    expect(delayCalls).toEqual([500, 1000]);
    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]!.meta.attempts).toBe(3);
    expect((dlqCalls[0]!.meta.error as Error).message).toBe(SOCKET_ERROR.message);
  });
});

// --- layer 3: composed with the REAL NotificationDispatchService ------

function realIdempotency(): { idempotency: RunsIdempotently; seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    idempotency: {
      async runOnce(eventId, consumer, work): Promise<ConsumptionOutcome> {
        const key = `${consumer}:${eventId}`;
        if (seen.has(key)) {
          return 'duplicate';
        }
        seen.add(key);
        await work({} as never);
        return 'processed';
      },
    },
  };
}

function fakeCompensation(): { compensation: DeletesProcessedEvent; deletions: Array<{ eventId: string; consumer: string }> } {
  const deletions: Array<{ eventId: string; consumer: string }> = [];
  return { deletions, compensation: { async delete(eventId, consumer): Promise<void> { deletions.push({ eventId, consumer }); } } };
}

describe('DegradingNotificationSender composed with the real NotificationDispatchService — permanent path ACKNOWLEDGES the fact', () => {
  it('a permanent send failure: dispatch resolves (no throw), the idempotency row is NOT compensated/deleted, and the fallback received the message', async () => {
    const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = new DegradingNotificationSender(inner, fallback);

    const { idempotency, seen } = realIdempotency();
    const { compensation, deletions } = fakeCompensation();
    const service = new NotificationDispatchService(idempotency, sender, compensation);
    const env: Envelope = {
      eventId: 'event-degraded-1',
      eventType: 'order.placed.v1',
      aggregateId: 'aggregate-1',
      correlationId: 'order-1',
      causationId: 'cause-1',
      occurredAt: '2026-08-24T10:00:00.000Z',
      payload: {},
    };

    const outcome = await service.dispatch(env, () => MESSAGE);

    expect(outcome).toBe('processed');
    expect(seen.has('notifications:event-degraded-1')).toBe(true);
    // The whole point: NOT compensated. A compensated row means the next
    // redelivery would try again and dead-letter after 3 attempts —
    // exactly the outcome this feature exists to avoid for a PERMANENT
    // failure.
    expect(deletions).toEqual([]);
    expect(fallback.send).toHaveBeenCalledWith({ ...MESSAGE, messageId: 'event-degraded-1@order-to-cash' });
  });

  it('a redelivered eventId after a permanent-failure degrade is a genuine duplicate — never sent twice', async () => {
    const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
    const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const sender = new DegradingNotificationSender(inner, fallback);

    const { idempotency } = realIdempotency();
    const { compensation } = fakeCompensation();
    const service = new NotificationDispatchService(idempotency, sender, compensation);
    const env: Envelope = {
      eventId: 'event-degraded-2',
      eventType: 'order.placed.v1',
      aggregateId: 'aggregate-1',
      correlationId: 'order-1',
      causationId: 'cause-1',
      occurredAt: '2026-08-24T10:00:00.000Z',
      payload: {},
    };

    const first = await service.dispatch(env, () => MESSAGE);
    const redelivered = await service.dispatch(env, () => MESSAGE);

    expect(first).toBe('processed');
    expect(redelivered).toBe('duplicate');
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });
});
