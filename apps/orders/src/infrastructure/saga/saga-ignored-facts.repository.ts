// The R25/SO8 durable ignored-fact record (design.md §5.4) — inserted in
// the caller's transaction, same as `OutboxRecorder` (outbox-recorder.ts).
// A plain class, composed directly by the application layer's
// `SagaFactHandler` — the same "infrastructure class reused unmodified,
// not behind a port" shape `outbox_and_idempotency` established for
// `IdempotentConsumer` (design.md §5.1's header note).
import { UniqueId } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port.js';
import type { TransactionContext } from '../../application/ports/unit-of-work.port.js';
import type { OrderStatus } from '../../domain/order-status.js';
import { asDrizzleTx } from '../persistence/drizzle-unit-of-work.js';
import { sagaIgnoredFacts, type SagaIgnoredFactMarkerRow } from '../persistence/schema/index.js';

export interface RecordIgnoredFactInput {
  readonly eventId: UniqueId;
  readonly eventType: string;
  /** `null` for the unknown-order case (SO8) — there is no order row to point at. */
  readonly orderId: UniqueId | null;
  readonly correlationId: UniqueId;
  readonly observedStatus: OrderStatus | null;
  readonly expectedStatus: OrderStatus | null;
  readonly marker: SagaIgnoredFactMarkerRow;
}

export class SagaIgnoredFactsRepository {
  constructor(private readonly clock: Clock) {}

  async record(tx: TransactionContext, input: RecordIgnoredFactInput): Promise<void> {
    const db = asDrizzleTx(tx);
    await db.insert(sagaIgnoredFacts).values({
      id: UniqueId.generate().value,
      eventId: input.eventId.value,
      eventType: input.eventType,
      orderId: input.orderId?.value ?? null,
      correlationId: input.correlationId.value,
      observedStatus: input.observedStatus,
      expectedStatus: input.expectedStatus,
      marker: input.marker,
      recordedAt: this.clock.now(),
    });
  }
}
