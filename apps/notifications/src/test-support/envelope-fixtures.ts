import type { Envelope } from '@otc/contracts';

/** Builds a minimal, valid `Envelope` for a test, with `payload` supplied by the caller. Every required field (Envelope's own contract, `packages/contracts`) has a fixed, deterministic fixture value unless overridden. */
export function makeEnvelope(eventType: string, payload: unknown, overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: 'event-1',
    eventType,
    aggregateId: 'aggregate-1',
    correlationId: 'order-1',
    causationId: 'cause-1',
    occurredAt: '2026-08-24T10:00:00.000Z',
    payload: payload as Record<string, never>,
    ...overrides,
  };
}
