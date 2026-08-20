import { describe, expect, it } from 'vitest';

import { AggregateRoot } from './aggregate-root.js';
import { createDomainEvent, type DomainEventEnvelope } from './event-envelope.js';
import { UniqueId } from './unique-id.js';

class SampleAggregate extends AggregateRoot<SampleAggregate> {
  private constructor(id: UniqueId) {
    super(id);
  }

  static create(): SampleAggregate {
    const aggregate = new SampleAggregate(UniqueId.generate());
    aggregate.record('sample.created.v1', { at: 'creation' });
    return aggregate;
  }

  touch(label: string): void {
    this.record('sample.touched.v1', { label });
  }

  private record(eventType: string, payload: Record<string, unknown>): void {
    this.addDomainEvent(
      createDomainEvent({
        eventType,
        aggregateId: this.id,
        correlationId: this.id,
        causationId: this.id,
        occurredAt: new Date(),
        payload,
      }),
    );
  }
}

describe('AggregateRoot — collects domain events (O8)', () => {
  it('accumulates domain events raised by successive mutations, in order', () => {
    const aggregate = SampleAggregate.create();
    aggregate.touch('first');
    aggregate.touch('second');

    const events = aggregate.pullDomainEvents();

    expect(events).toHaveLength(3);
    expect(events.map((e: DomainEventEnvelope) => e.eventType)).toEqual([
      'sample.created.v1',
      'sample.touched.v1',
      'sample.touched.v1',
    ]);
    expect((events[1].payload as { label: string }).label).toBe('first');
    expect((events[2].payload as { label: string }).label).toBe('second');
  });

  it('pullDomainEvents() empties the collection — a second call returns nothing', () => {
    const aggregate = SampleAggregate.create();

    const firstPull = aggregate.pullDomainEvents();
    const secondPull = aggregate.pullDomainEvents();

    expect(firstPull).toHaveLength(1);
    expect(secondPull).toHaveLength(0);
  });

  it('a freshly created aggregate with no mutation has no uncommitted events beyond creation', () => {
    const aggregate = SampleAggregate.create();

    expect(aggregate.pullDomainEvents()).toHaveLength(1);
  });

  it('every appended event stamps this aggregate as both aggregateId and correlationId', () => {
    const aggregate = SampleAggregate.create();

    const [event] = aggregate.pullDomainEvents();

    expect(event.aggregateId.equals(aggregate.id)).toBe(true);
    expect(event.correlationId.equals(aggregate.id)).toBe(true);
  });
});
