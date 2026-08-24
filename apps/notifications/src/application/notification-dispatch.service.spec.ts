import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@otc/contracts';
import type { NotificationMessage, NotificationSender } from './ports/notification-sender.port';
import {
  NotificationDispatchService,
  type ConsumptionOutcome,
  type DeletesProcessedEvent,
  type RunsIdempotently,
} from './notification-dispatch.service';

const ENVELOPE: Envelope = {
  eventId: 'event-1',
  eventType: 'order.placed.v1',
  aggregateId: 'aggregate-1',
  correlationId: 'order-1',
  causationId: 'cause-1',
  occurredAt: '2026-08-24T10:00:00.000Z',
  payload: {},
};

const MESSAGE: NotificationMessage = { to: 'to@example.com', subject: 'subject', text: 'text', html: '<p>html</p>' };

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
        // Mirrors the real IdempotentConsumer: the row "commits" (is added
        // to `seen`) regardless of what `work` does, BEFORE work runs —
        // insert-first (N6).
        seen.add(key);
        await work({} as never);
        return 'processed';
      },
    },
  };
}

function fakeCompensation(): { compensation: DeletesProcessedEvent; deletions: Array<{ eventId: string; consumer: string }> } {
  const deletions: Array<{ eventId: string; consumer: string }> = [];
  return {
    deletions,
    compensation: {
      async delete(eventId, consumer): Promise<void> {
        deletions.push({ eventId, consumer });
      },
    },
  };
}

describe('NotificationDispatchService', () => {
  it('builds the message and sends it exactly once for a fresh eventId, using the "notifications" consumer name', async () => {
    const { idempotency } = realIdempotency();
    const { compensation, deletions } = fakeCompensation();
    const sender: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    const outcome = await service.dispatch(ENVELOPE, buildMessage);

    expect(outcome).toBe('processed');
    expect(buildMessage).toHaveBeenCalledWith(ENVELOPE);
    expect(sender.send).toHaveBeenCalledTimes(1);
    // N4 — messageId is attached by dispatch itself, from the envelope's
    // own eventId; defence in depth only, never the dedup mechanism.
    expect(sender.send).toHaveBeenCalledWith({ ...MESSAGE, messageId: 'event-1@order-to-cash' });
    expect(deletions).toEqual([]);
  });

  // N4 — messageId set from eventId (defence in depth, never the dedup
  // mechanism — see NotificationMessage.messageId's doc).
  it('N4 — sets messageId to `<eventId>@order-to-cash`', async () => {
    const { idempotency } = realIdempotency();
    const { compensation } = fakeCompensation();
    const sender: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    await service.dispatch({ ...ENVELOPE, eventId: 'a-different-event-id' }, buildMessage);

    const [sentMessage] = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sentMessage.messageId).toBe('a-different-event-id@order-to-cash');
  });

  // NS8 — idempotent by eventId, at the dispatch-service level: a
  // redelivered eventId must produce EXACTLY ONE send, proven with a call
  // counter on the port (feature 21's N10: a rolled-back or absent side
  // effect proves nothing about whether it was attempted).
  it('NS8 — a redelivered eventId sends exactly once, never twice', async () => {
    const { idempotency } = realIdempotency();
    const { compensation } = fakeCompensation();
    const sender: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    const first = await service.dispatch(ENVELOPE, buildMessage);
    const redelivered = await service.dispatch(ENVELOPE, buildMessage);

    expect(first).toBe('processed');
    expect(redelivered).toBe('duplicate');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(buildMessage).toHaveBeenCalledTimes(1);
  });

  it('never calls buildMessage or sender.send for a duplicate — proven with a fake that answers "duplicate" unconditionally', async () => {
    const idempotency: RunsIdempotently = { runOnce: vi.fn().mockResolvedValue('duplicate') };
    const { compensation } = fakeCompensation();
    const sender: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    const outcome = await service.dispatch(ENVELOPE, buildMessage);

    expect(outcome).toBe('duplicate');
    expect(buildMessage).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  // N6 — insert-first, then send, then delete the row if the send throws.
  it('N6 — deletes the just-recorded ledger row and rethrows when sender.send throws, so redelivery gets a fresh attempt', async () => {
    const { idempotency, seen } = realIdempotency();
    const { compensation, deletions } = fakeCompensation();
    const sendError = new Error('SMTP timeout');
    const sender: NotificationSender = { send: vi.fn().mockRejectedValue(sendError) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    await expect(service.dispatch(ENVELOPE, buildMessage)).rejects.toThrow('SMTP timeout');

    expect(deletions).toEqual([{ eventId: 'event-1', consumer: 'notifications' }]);
    // The FAKE ledger (`seen`) is not itself wired to `compensation` — this
    // assertion documents intent only; the real wiring (app.module.ts) both
    // point at the SAME database, so the delete really does undo the insert.
    expect(seen.has('notifications:event-1')).toBe(true);
  });

  it('N6 — does NOT call the compensating delete when sender.send succeeds', async () => {
    const { idempotency } = realIdempotency();
    const { compensation, deletions } = fakeCompensation();
    const sender: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const service = new NotificationDispatchService(idempotency, sender, compensation);

    await service.dispatch(ENVELOPE, buildMessage);

    expect(deletions).toEqual([]);
  });

  // N13 — an error that masks its own cause. If the compensating delete
  // ALSO throws (a transient MySQL error on top of a genuine SMTP
  // failure), the SMTP error — the actual cause — must be what this method
  // throws, never the compensation failure. This is the test that fails if
  // that guarantee regresses: deleting the inner try/catch around
  // `compensation.delete(...)` (or letting `compensationError` propagate
  // instead of `sendError`) makes this assertion see the WRONG message.
  it('N13 — when the compensating delete ALSO throws, the SMTP error still propagates, not the compensation error', async () => {
    const { idempotency } = realIdempotency();
    const sendError = new Error('SMTP timeout');
    const compensationError = new Error('MySQL connection reset');
    const sender: NotificationSender = { send: vi.fn().mockRejectedValue(sendError) };
    const compensation: DeletesProcessedEvent = { delete: vi.fn().mockRejectedValue(compensationError) };
    const buildMessage = vi.fn().mockReturnValue(MESSAGE);
    const errorLog = vi.fn();
    const service = new NotificationDispatchService(idempotency, sender, compensation, { error: errorLog });

    await expect(service.dispatch(ENVELOPE, buildMessage)).rejects.toBe(sendError);

    // The compensation failure is still surfaced — just not as the thrown
    // error. Both messages are visible to whoever reads the log, but only
    // one is what the caller (and Kafka's redelivery machinery) sees.
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [, meta] = errorLog.mock.calls[0]!;
    expect(meta.eventId).toBe('event-1');
    expect(meta.consumer).toBe('notifications');
    expect(meta.sendError).toBe('SMTP timeout');
    expect(meta.compensationError).toBe('MySQL connection reset');
  });
});
