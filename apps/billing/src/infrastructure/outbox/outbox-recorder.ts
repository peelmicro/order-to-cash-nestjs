// COPY OF — apps/orders/src/infrastructure/outbox/outbox-recorder.ts
// Turns pulled domain events into outbox rows, inside the caller's
// transaction (design.md §4.4). Called by `DrizzleOrderRepository.save`
// after it drains `order.pullDomainEvents()` — never by a handler directly,
// so a dual-write (aggregate row without its facts, or vice versa) cannot
// happen by omission.
import type { DomainEventEnvelope } from '@otc/shared-kernel';
import { UniqueId } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import { activeTraceParent } from '../observability/trace-context';
import { asDrizzleTx } from '../persistence/drizzle-unit-of-work';
import { outbox } from '../persistence/schema';

export class OutboxRecorder {
  constructor(private readonly clock: Clock) {}

  /**
   * Appends one outbox row per envelope, in array order, inside `tx`.
   * Assigns no sequence — the store does, via AUTO_INCREMENT (§3.2) — and
   * no MySQL cursor: a single multi-row INSERT assigns strictly increasing
   * `seq` values in statement order, which is what makes emission order
   * (`pullDomainEvents()`'s own append order) survive into `seq` order.
   */
  async record(tx: TransactionContext, events: readonly DomainEventEnvelope[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const db = asDrizzleTx(tx);
    const createdAt = this.clock.now();
    // A5c (design.md §4.3, R57) — captured ONCE per call, from the active
    // OTel trace context of the command handler that produced these
    // events (extracted-and-continued upstream by the `@MessagePattern`
    // responder that triggered this write, `trace-context.ts`'s
    // `extractNatsTraceContext`) — `null` if no trace context is active (a
    // caller that never extracted one, or a test that never registered a
    // `TracerProvider`). Previously always `null` here (a pre-existing gap
    // this pass closes, `outbox-relay.ts`'s own "until feature 27
    // populates the column" comment); `outbox-relay.ts` itself already
    // forwards a non-null `row.traceParent` verbatim as the outbound Kafka
    // `traceparent` header and needs no change.
    const traceParent = activeTraceParent();

    await db.insert(outbox).values(
      events.map((event) => ({
        id: UniqueId.generate().value,
        eventId: event.eventId.value,
        eventType: event.eventType,
        aggregateId: event.aggregateId.value,
        correlationId: event.correlationId.value,
        causationId: event.causationId.value,
        payload: event.payload,
        occurredAt: event.occurredAt,
        publishedAt: null,
        createdAt,
        traceParent,
      })),
    );
  }
}
