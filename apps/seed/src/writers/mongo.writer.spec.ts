import { describe, expect, it } from 'vitest';
import { SAGAS, COMPLETED_SAGAS, CANCELLED_SAGAS } from '../data/sagas.data';
import { toTimelineDocument, TIMELINE_ORDER_VERSION } from './mongo.writer';

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

  it('PR34 (A1) — every entry carries a causationId from the fixture\'s OWN declared causal chain, and the document is stamped at the CURRENT timelineOrderVersion', () => {
    for (const saga of SAGAS) {
      const doc = toTimelineDocument(saga);
      expect(doc.timelineOrderVersion).toBe(TIMELINE_ORDER_VERSION);
      for (const event of doc.events) {
        expect(typeof event.causationId).toBe('string');
        expect(event.causationId.length).toBeGreaterThan(0);
      }
    }
  });

  it('PR34 (A1) — the compensation pair\'s causal edge is real in the seeded data: order.cancelled.v1.causationId names stock.released.v1\'s OWN eventId', () => {
    const [cancelled] = CANCELLED_SAGAS;
    const doc = toTimelineDocument(cancelled);
    const released = doc.events.find((e) => e.eventType === 'stock.released.v1')!;
    const cancelledEntry = doc.events.find((e) => e.eventType === 'order.cancelled.v1')!;
    expect(cancelledEntry.causationId).toBe(released.eventId);
  });

  it('PR34 (A1) — the Billing edge (amendment A1 open point 2) is real in the seeded data too: credit.released.v1.causationId names payment.received.v1\'s OWN eventId, not a synthetic command id', () => {
    for (const saga of COMPLETED_SAGAS) {
      const doc = toTimelineDocument(saga);
      const payment = doc.events.find((e) => e.eventType === 'payment.received.v1')!;
      const released = doc.events.find((e) => e.eventType === 'credit.released.v1')!;
      const completed = doc.events.find((e) => e.eventType === 'order.completed.v1')!;
      expect(released.causationId).toBe(payment.eventId);
      expect(completed.causationId).toBe(released.eventId);
    }
  });
});
