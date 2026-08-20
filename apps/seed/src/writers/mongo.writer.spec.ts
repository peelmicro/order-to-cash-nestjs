import { describe, expect, it } from 'vitest';
import { SAGAS, COMPLETED_SAGAS, CANCELLED_SAGAS } from '../data/sagas.data';
import { toTimelineDocument } from './mongo.writer';

describe('toTimelineDocument — matches specs/shared/openapi.yaml OrderDetail shape exactly', () => {
  it.each(SAGAS.map((saga) => [saga.orderReference, saga] as const))(
    '%s: every OrderDetail-required field is present',
    (_reference, saga) => {
      const doc = toTimelineDocument(saga);

      // required: [orderId, status, events, updatedAt] per openapi.yaml, plus
      // every other property this seed actually populates.
      expect(doc._id).toBe(saga.orderId);
      expect(doc.orderId).toBe(saga.orderId);
      expect(doc.orderReference).toBe(saga.orderReference);
      expect(doc.status).toBe(saga.status);
      expect(Array.isArray(doc.events)).toBe(true);
      expect(doc.events.length).toBeGreaterThan(0);
      expect(typeof doc.updatedAt).toBe('string');
      expect(doc.headerComplete).toBe(true);
      // PartyRef required: [code, gln].
      expect(doc.retailer.code).toBeTruthy();
      expect(doc.retailer.gln).toBeTruthy();
      expect(doc.company.code).toBeTruthy();
      expect(doc.company.gln).toBeTruthy();
      // OrderTotals required: [initialAmount, initialDiscount, totalAmount].
      expect(doc.totals.totalAmount).toBe(saga.totalAmount);
      // TimelineEntry required: [eventId, eventType, occurredAt, summary].
      for (const event of doc.events) {
        expect(event.eventId).toBeTruthy();
        expect(event.eventType).toBeTruthy();
        expect(event.occurredAt).toBeTruthy();
        expect(event.summary).toBeTruthy();
      }
    },
  );

  it('orders events by occurredAt, ascending', () => {
    for (const saga of SAGAS) {
      const doc = toTimelineDocument(saga);
      const timestamps = doc.events.map((e) => new Date(e.occurredAt).getTime());
      const sorted = [...timestamps].sort((a, b) => a - b);
      expect(timestamps).toEqual(sorted);
    }
  });

  it('a completed order carries despatch/invoice/payment references; a cancelled one carries none', () => {
    for (const saga of COMPLETED_SAGAS) {
      const doc = toTimelineDocument(saga);
      expect(doc.references.despatchReference).toBe(saga.despatch!.despatchReference);
      expect(doc.references.invoiceReference).toBe(saga.invoice!.invoiceReference);
      expect(doc.references.paymentReference).toBe(saga.invoice!.payment.paymentReference);
    }
    for (const saga of CANCELLED_SAGAS) {
      const doc = toTimelineDocument(saga);
      expect(doc.references.despatchReference).toBeNull();
      expect(doc.references.invoiceReference).toBeNull();
      expect(doc.references.paymentReference).toBeNull();
    }
  });

  it('the cancelled order timeline shows both compensation steps, separately and in causal order (R28)', () => {
    const [cancelled] = CANCELLED_SAGAS;
    const doc = toTimelineDocument(cancelled);
    expect(doc.events.map((e) => e.eventType)).toEqual([
      'order.placed.v1',
      'stock.reserved.v1',
      'credit.rejected.v1',
      'stock.released.v1',
      'order.cancelled.v1',
    ]);
    expect(doc.cancellationReason).toBe('credit_rejected');
  });
});
