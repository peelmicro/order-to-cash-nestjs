import { Entity } from './entity.js';
import type { DomainEventEnvelope } from './event-envelope.js';
import type { UniqueId } from './unique-id.js';

/**
 * An {@link Entity} that is also a consistency boundary: it collects the
 * domain events its own mutations produce and hands them to the caller —
 * infrastructure, never the aggregate itself — for outbox persistence and
 * publication (domain-model.md §8, rule 5: "aggregates emit; infrastructure
 * publishes").
 */
export abstract class AggregateRoot<T> extends Entity<T> {
  private domainEvents: DomainEventEnvelope[] = [];

  protected constructor(id: UniqueId) {
    super(id);
  }

  /** Appends one domain event to the aggregate's uncommitted collection. */
  protected addDomainEvent(event: DomainEventEnvelope): void {
    this.domainEvents.push(event);
  }

  /**
   * Returns every uncommitted domain event, in the order they were
   * appended, and clears the aggregate's internal collection so a second
   * call returns an empty array.
   */
  pullDomainEvents(): DomainEventEnvelope[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }
}
