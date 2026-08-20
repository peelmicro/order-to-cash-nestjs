import { describe, expect, it } from 'vitest';

import {
  assertValidDomainEventEnvelope,
  createDomainEvent,
  type DomainEventEnvelope,
  InvalidDomainEventEnvelopeError,
} from './event-envelope.js';
import { UniqueId } from './unique-id.js';

function validParams() {
  return {
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate(),
    correlationId: UniqueId.generate(),
    causationId: UniqueId.generate(),
    occurredAt: new Date('2026-08-19T10:00:00.000Z'),
    payload: { orderReference: 'ORD-000001' },
  };
}

describe('DomainEventEnvelope — R11: complete envelope, eventType pattern', () => {
  it('builds a valid envelope, generating eventId in the domain when none is supplied', () => {
    const envelope = createDomainEvent(validParams());

    expect(envelope.eventId).toBeInstanceOf(UniqueId);
    expect(envelope.eventType).toBe('order.placed.v1');
    expect(envelope.payload).toEqual({ orderReference: 'ORD-000001' });
  });

  it('accepts every real eventType from the fact catalogue (domain-model.md §7.2)', () => {
    const eventTypes = [
      'order.placed.v1',
      'stock.reserved.v1',
      'stock.rejected.v1',
      'stock.released.v1',
      'credit.approved.v1',
      'credit.rejected.v1',
      'credit.released.v1',
      'order.confirmed.v1',
      'order.despatched.v1',
      'invoice.issued.v1',
      'payment.received.v1',
      'order.completed.v1',
      'order.cancelled.v1',
    ];

    for (const eventType of eventTypes) {
      expect(() => createDomainEvent({ ...validParams(), eventType })).not.toThrow();
    }
  });

  it('accepts a version suffix beyond v1 (e.g. v2, v10) as a genuinely new type', () => {
    expect(() => createDomainEvent({ ...validParams(), eventType: 'order.placed.v2' })).not.toThrow();
    expect(() => createDomainEvent({ ...validParams(), eventType: 'order.placed.v10' })).not.toThrow();
  });

  it('refuses a completely absent envelope', () => {
    expect(() => assertValidDomainEventEnvelope(null as unknown as DomainEventEnvelope)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() =>
      assertValidDomainEventEnvelope(undefined as unknown as DomainEventEnvelope),
    ).toThrow(InvalidDomainEventEnvelopeError);
  });

  it('refuses an envelope with an absent, null or empty field', () => {
    const base = createDomainEvent(validParams());

    const withoutEventId: DomainEventEnvelope = { ...base, eventId: undefined as never };
    const withoutEventType: DomainEventEnvelope = { ...base, eventType: '' };
    const withoutAggregateId: DomainEventEnvelope = { ...base, aggregateId: null as never };
    const withoutCorrelationId: DomainEventEnvelope = { ...base, correlationId: undefined as never };
    const withoutCausationId: DomainEventEnvelope = { ...base, causationId: null as never };
    const withoutOccurredAt: DomainEventEnvelope = { ...base, occurredAt: undefined as never };
    const withEmptyPayload: DomainEventEnvelope = { ...base, payload: {} };
    const withNullPayload: DomainEventEnvelope = { ...base, payload: null as never };

    expect(() => assertValidDomainEventEnvelope(withoutEventId)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withoutEventType)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withoutAggregateId)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withoutCorrelationId)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withoutCausationId)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withoutOccurredAt)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withEmptyPayload)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
    expect(() => assertValidDomainEventEnvelope(withNullPayload)).toThrow(
      InvalidDomainEventEnvelopeError,
    );
  });

  it('refuses an eventType that does not match <aggregate>.<fact>.v<n>', () => {
    const badEventTypes = [
      'orderplaced',
      'order.placed',
      'order.placed.v',
      'order.placed.v0',
      'order.placed.1',
      'ORDER.PLACED.V1',
      'order..v1',
      '.placed.v1',
      'order.placed.v1.extra',
    ];

    for (const eventType of badEventTypes) {
      expect(() => createDomainEvent({ ...validParams(), eventType })).toThrow(
        InvalidDomainEventEnvelopeError,
      );
    }
  });

  it('refuses occurredAt that is not a valid instant', () => {
    expect(() =>
      createDomainEvent({ ...validParams(), occurredAt: new Date('not-a-date') }),
    ).toThrow(InvalidDomainEventEnvelopeError);
  });

  it('honours an explicitly supplied eventId instead of generating a new one', () => {
    const explicitEventId = UniqueId.generate();

    const envelope = createDomainEvent({ ...validParams(), eventId: explicitEventId });

    expect(envelope.eventId.equals(explicitEventId)).toBe(true);
  });
});
