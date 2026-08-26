// OR3's actual dead-letter work (`observability_reliability` design.md
// §4.2, R29's dead-letter clause) — the ONE real implementation of
// `HandlesFirstPark`, called by `SagaCommandDispatcher.dispatch(...)`
// only after it has ALREADY confirmed (via `store.claimDeadLetter`) that
// this is the row's first park. Two side effects, in this order: (a)
// publish the triggering fact to its source topic's `.dlq` (the SAME
// `DlqPublisher` `FactRetryDispatcher` uses, OR1 — reused, not a third
// variant); (b) append exactly one `order.saga_failed.v1` fact via
// `Order.recordSagaFailure(...)`, persisted through the existing outbox
// pipeline inside one short `UnitOfWork` transaction. Kafka is not
// transactional with MySQL, so (a) runs first and best-effort — a crash
// between (a) and (b) leaves a genuine DLQ entry with no matching
// timeline entry, an acceptable window for a "purely diagnostic"
// mechanism (design.md §4.2's own framing) that never touches SO5's
// underlying retry.
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port.js';
import type { OrderRepository } from '../../application/ports/order-repository.port.js';
import type { SagaCommandRecord } from '../../application/ports/saga-command-store.port.js';
import type { UnitOfWork } from '../../application/ports/unit-of-work.port.js';
import type { DlqPublisher } from '../messaging/fact-retry-dispatcher.js';
import type { HandlesFirstPark, SagaCommandParkContext } from './saga-command-dispatcher.js';

export interface SagaFirstParkDeadLetterHandlerLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: SagaFirstParkDeadLetterHandlerLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

export class SagaFirstParkDeadLetterHandler implements HandlesFirstPark {
  constructor(
    private readonly dlq: DlqPublisher,
    private readonly unitOfWork: UnitOfWork,
    private readonly orders: OrderRepository,
    private readonly clock: Clock,
    private readonly logger: SagaFirstParkDeadLetterHandlerLogger = CONSOLE_LOGGER,
  ) {}

  async onFirstPark(row: SagaCommandRecord, context: SagaCommandParkContext): Promise<void> {
    const now = this.clock.now();
    const envelope: Envelope = row.triggeringEventEnvelope;

    await this.dlq.publish(row.triggeringEventTopic, envelope, {
      failedConsumer: 'orders.saga',
      attempts: context.attempts,
      error: context.lastError,
      firstFailedAt: now,
      failedAt: now,
    });

    await this.unitOfWork.execute(async (tx) => {
      const order = await this.orders.findById(row.orderId, tx);
      if (!order) {
        // SO8-style residue (design.md §4.2 names no such case explicitly,
        // but `order.placed.v1` always commits with the order row, R13,
        // so an unknown order here is cross-environment residue, exactly
        // like SagaFactHandler's own SO8 case) — log and move on, never
        // throw: this hook must not turn a diagnostic side effect into a
        // reason the park transition itself fails.
        this.logger.error('saga-first-park-dead-letter-handler: no order row for orderId, fact not recorded', {
          orderId: row.orderId.value,
          command: row.command,
        });
        return;
      }
      order.recordSagaFailure(
        { command: row.command, attempts: context.attempts, lastError: context.lastError },
        { occurredAt: now, causationId: row.triggeringEventId },
      );
      await this.orders.save(order, tx);
    });
  }
}
