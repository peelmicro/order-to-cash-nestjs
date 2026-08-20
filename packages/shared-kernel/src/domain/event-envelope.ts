import { DomainError } from './domain-error.js';
import { UniqueId } from './unique-id.js';

// `<aggregate>.<fact>.v<n>` — e.g. `order.placed.v1`. `n` never has a
// leading zero (`v1`, `v2`, … `v10`), matching the coding-conventions table
// in CLAUDE.md.
const EVENT_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*\.v[1-9][0-9]*$/;

export class InvalidDomainEventEnvelopeError extends DomainError {
  readonly code = 'INVALID_DOMAIN_EVENT_ENVELOPE';

  constructor(reason: string) {
    super(`invalid domain event envelope: ${reason}`);
  }
}

/**
 * The fact envelope shared by every domain event in the trilogy —
 * domain-model.md §7.1. `payload` is fact-specific; every other field is
 * fixed by the envelope contract and identical across all thirteen facts.
 */
export interface DomainEventEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly eventId: UniqueId;
  readonly eventType: string;
  readonly aggregateId: UniqueId;
  readonly correlationId: UniqueId;
  readonly causationId: UniqueId;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

export interface CreateDomainEventParams<TPayload extends Record<string, unknown>> {
  eventType: string;
  aggregateId: UniqueId;
  /** Always the order id (domain-model.md §7.1). */
  correlationId: UniqueId;
  /** The `eventId` of the causing fact, or the id of the causing command. */
  causationId: UniqueId;
  /** Stamped by the aggregate through a clock port — never `new Date()` inside the kernel. */
  occurredAt: Date;
  payload: TPayload;
  /** Supply only when replaying/rehydrating; normally generated in the domain. */
  eventId?: UniqueId;
}

/**
 * Builds a validated {@link DomainEventEnvelope}. `eventId` is generated in
 * the domain, at creation time, if the caller does not supply one — never
 * at publication time (R11, R12).
 */
export function createDomainEvent<TPayload extends Record<string, unknown>>(
  params: CreateDomainEventParams<TPayload>,
): DomainEventEnvelope<TPayload> {
  const envelope: DomainEventEnvelope<TPayload> = {
    eventId: params.eventId ?? UniqueId.generate(),
    eventType: params.eventType,
    aggregateId: params.aggregateId,
    correlationId: params.correlationId,
    causationId: params.causationId,
    occurredAt: params.occurredAt,
    payload: params.payload,
  };
  assertValidDomainEventEnvelope(envelope);
  return envelope;
}

/**
 * Raises {@link InvalidDomainEventEnvelopeError} if any envelope field is
 * absent, null or empty, or if `eventType` does not match
 * `<aggregate>.<fact>.v<n>` (R11).
 */
export function assertValidDomainEventEnvelope(envelope: DomainEventEnvelope): void {
  if (envelope == null) {
    throw new InvalidDomainEventEnvelopeError('envelope is absent');
  }
  if (envelope.eventId == null) {
    throw new InvalidDomainEventEnvelopeError('eventId is absent');
  }
  if (envelope.eventType == null || envelope.eventType === '') {
    throw new InvalidDomainEventEnvelopeError('eventType is absent or empty');
  }
  if (!EVENT_TYPE_PATTERN.test(envelope.eventType)) {
    throw new InvalidDomainEventEnvelopeError(
      `eventType "${envelope.eventType}" does not match the pattern <aggregate>.<fact>.v<n>`,
    );
  }
  if (envelope.aggregateId == null) {
    throw new InvalidDomainEventEnvelopeError('aggregateId is absent');
  }
  if (envelope.correlationId == null) {
    throw new InvalidDomainEventEnvelopeError('correlationId is absent');
  }
  if (envelope.causationId == null) {
    throw new InvalidDomainEventEnvelopeError('causationId is absent');
  }
  if (
    envelope.occurredAt == null ||
    !(envelope.occurredAt instanceof Date) ||
    Number.isNaN(envelope.occurredAt.getTime())
  ) {
    throw new InvalidDomainEventEnvelopeError('occurredAt is absent or not a valid instant');
  }
  if (
    envelope.payload == null ||
    typeof envelope.payload !== 'object' ||
    Object.keys(envelope.payload).length === 0
  ) {
    throw new InvalidDomainEventEnvelopeError('payload is absent, null or empty');
  }
}
