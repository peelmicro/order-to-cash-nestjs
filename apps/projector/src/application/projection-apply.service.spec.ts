// PR19 › logs and swallows a signal publication failure, acknowledging the
// fact rather than entering a retry that could never re-emit; plus
// publishes nothing when the writer reports duplicate; plus rethrows a
// writer failure so the fact is redelivered. Fakes only — no container.
import { describe, expect, it, vi } from 'vitest';
import { orderPlacedEnvelope } from '../test-support/envelope-fixtures';
import type { AppliedOrderTimeline, ApplyOutcome, ReadModelWriter } from './ports/read-model-writer.port';
import type { UpdateSignalPublisher } from './ports/update-signal.port';
import { ProjectionApplyService } from './projection-apply.service';

const APPLIED_DOCUMENT: AppliedOrderTimeline = {
  orderId: 'order-1',
  orderReference: 'ORD-000001',
  status: 'placed',
  cancellationReason: null,
  references: { despatchReference: null, invoiceReference: null, paymentReference: null },
  totals: { initialAmount: 2000, initialDiscount: 0, totalAmount: 2000 },
  latestEntry: {
    eventId: 'event-1',
    eventType: 'order.placed.v1',
    occurredAt: '2026-08-24T10:00:00.000Z',
    summary: 'Order ORD-000001 placed for RETAILER01',
    causationId: 'cause-1',
  },
};

/** A writer fake that invokes `afterApplied` exactly as `mongo-read-model-writer.ts` does: only on the 'processed' branch. */
function processingWriter(): ReadModelWriter {
  return {
    apply: async (_delta, _eventId, _consumer, afterApplied): Promise<ApplyOutcome> => {
      await afterApplied(APPLIED_DOCUMENT);
      return 'processed';
    },
  };
}

function duplicateWriter(): ReadModelWriter {
  return {
    apply: async (): Promise<ApplyOutcome> => 'duplicate', // afterApplied deliberately NEVER invoked
  };
}

function failingWriter(error: Error): ReadModelWriter {
  return {
    apply: async (): Promise<ApplyOutcome> => {
      throw error;
    },
  };
}

describe('projection-apply.service', () => {
  it('PR18/happy path: on a first delivery, applies the fact and publishes the update signal', async () => {
    const publisher: UpdateSignalPublisher = { publish: vi.fn(async () => {}) };
    const service = new ProjectionApplyService(processingWriter(), publisher, { error: vi.fn() });

    const outcome = await service.apply(orderPlacedEnvelope());

    expect(outcome).toBe('processed');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(APPLIED_DOCUMENT);
  });

  it('PR19 › logs and swallows a signal publication failure, acknowledging the fact rather than entering a retry that could never re-emit', async () => {
    const publishError = new Error('NATS unreachable');
    const publisher: UpdateSignalPublisher = { publish: vi.fn(async () => { throw publishError; }) };
    const logger = { error: vi.fn() };
    const service = new ProjectionApplyService(processingWriter(), publisher, logger);

    // The critical assertion: this must NOT throw/reject.
    await expect(service.apply(orderPlacedEnvelope())).resolves.toBe('processed');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('PR19');
    expect(meta).toMatchObject({ orderId: 'order-1', error: 'NATS unreachable' });
  });

  it('publishes nothing when the writer reports duplicate (PR18 suppress-on-duplicate)', async () => {
    const publisher: UpdateSignalPublisher = { publish: vi.fn(async () => {}) };
    const service = new ProjectionApplyService(duplicateWriter(), publisher, { error: vi.fn() });

    const outcome = await service.apply(orderPlacedEnvelope());

    expect(outcome).toBe('duplicate');
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('rethrows a writer failure so the fact is redelivered', async () => {
    const writerError = new Error('Mongo unreachable');
    const publisher: UpdateSignalPublisher = { publish: vi.fn(async () => {}) };
    const service = new ProjectionApplyService(failingWriter(writerError), publisher, { error: vi.fn() });

    await expect(service.apply(orderPlacedEnvelope())).rejects.toThrow('Mongo unreachable');
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
