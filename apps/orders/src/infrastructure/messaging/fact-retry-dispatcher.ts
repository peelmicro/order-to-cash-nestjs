// The retry-then-DLQ wrapper — R16 (`outbox_and_idempotency` §2, deferred
// to this feature), OR1/OR2 (`observability_reliability` design.md §4.1).
// CANONICAL — the second `OI12`-guarded pair alongside
// `idempotent-consumer.ts`. Copied verbatim (after its own banner) into
// `apps/projector`/`apps/notifications` — the same three services that
// already own an `idempotent-consumer.ts` copy, since a service with no
// fact consumer has nothing to wrap. `apps/fulfillment`/`apps/billing`
// consume no fact today (`ConsumerName` is `never` there), so no copy
// lands in either.
//
// Sits ONE LAYER ABOVE `IdempotentConsumer`, never inside it
// (`outbox_and_idempotency` design.md §7: "wrap `IdempotentConsumer.
// runOnce(...)`. A rejection is already the failure signal; feature 27
// adds attempts, backoff and the dead-letter publication around it, and
// only then acknowledges. Nothing in §6 needs to change.") — at the
// `@EventPattern` controller's own dispatch point
// (`SagaFactsController.route`'s `await this.commandBus.execute(...)` in
// Orders, the equivalent single dispatch call in the projector/
// notifications).
//
// This is the mechanism the live Phase-12 incident exposed the ABSENCE
// of: a fact with a non-UUID `correlationId` passed `parseFactEnvelope`'s
// envelope-shape guard (which only checks the seven envelope fields are
// PRESENT), then threw deep inside the transactional unit — propagating,
// unwrapped, out of `@nestjs/microservices`'s Kafka transport, which does
// not commit the offset on a thrown handler. Every redelivery repeated
// the identical throw, forever, on that partition
// (`apps/orders/src/saga-dead-letter.integration.spec.ts` reproduces this
// exact shape).
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port.js';
import type { ConsumerName } from '../../application/ports/consumer-name.js';

export interface FactRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

export const DEFAULT_FACT_RETRY_POLICY: FactRetryPolicy = {
  maxAttempts: 3,
  backoffBaseMs: 500,
};

export function loadFactRetryPolicy(env: NodeJS.ProcessEnv = process.env): FactRetryPolicy {
  const maxAttempts = Number(env.FACT_RETRY_MAX_ATTEMPTS ?? DEFAULT_FACT_RETRY_POLICY.maxAttempts);
  const backoffBaseMs = Number(env.FACT_RETRY_BACKOFF_MS ?? DEFAULT_FACT_RETRY_POLICY.backoffBaseMs);
  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_FACT_RETRY_POLICY.maxAttempts,
    backoffBaseMs: Number.isFinite(backoffBaseMs) && backoffBaseMs >= 0 ? backoffBaseMs : DEFAULT_FACT_RETRY_POLICY.backoffBaseMs,
  };
}

/** Same "Clock-port-style delay abstraction" `SagaCommandDispatcher` (SO4) already uses, so unit tests run instantly against a fake. */
export interface DelayPort {
  for(ms: number): Promise<void>;
}

export const REAL_DELAY: DelayPort = {
  for: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface DlqPublishMeta {
  readonly failedConsumer: ConsumerName;
  readonly attempts: number;
  readonly error: unknown;
  readonly firstFailedAt: Date;
  readonly failedAt: Date;
}

/**
 * Publishes the UNMODIFIED original envelope to `<sourceTopic>.dlq`,
 * annotated per `asyncapi.yaml`'s `DeadLetterHeaders` (OR1). Reused by
 * `SagaCommandDispatcher.park(...)`'s DLQ step (OR3) — never a third
 * variant.
 */
export interface DlqPublisher {
  publish(sourceTopic: string, envelope: Envelope, meta: DlqPublishMeta): Promise<void>;
}

export const FACT_RETRY_DISPATCHER = Symbol('FactRetryDispatcher');

/** The one method a caller needs — decoupled from the concrete class so `SagaFactsController`/the equivalent controllers can each be tested against a controllable fake (same shape as `DispatchesSagaCommands`). */
export interface DispatchesFactRetries {
  dispatch(
    sourceTopic: string,
    envelope: Envelope,
    consumer: ConsumerName,
    process: (envelope: Envelope) => Promise<void>,
  ): Promise<void>;
}

export interface FactRetryDispatcherLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: FactRetryDispatcherLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

/**
 * Retries `process(envelope)` in line, up to `policy.maxAttempts`, with
 * exponential backoff (`policy.backoffBaseMs * 2 ** (attempt - 1)`
 * between attempts). On success, returns normally — the caller
 * (`SagaFactsController.route` et al.) returns normally in turn, and
 * `@nestjs/microservices` commits the offset. On exhausting every
 * attempt, publishes the ORIGINAL envelope to the DLQ and — deliberately
 * — does NOT rethrow: the caller still returns normally, the offset still
 * commits (R16's "acknowledge the original fact so the partition is not
 * blocked"), and the poison message can never block redelivery of the
 * next, distinct fact on the same partition again.
 */
export class FactRetryDispatcher implements DispatchesFactRetries {
  constructor(
    private readonly clock: Clock,
    private readonly delay: DelayPort,
    private readonly dlq: DlqPublisher,
    private readonly policy: FactRetryPolicy = DEFAULT_FACT_RETRY_POLICY,
    private readonly logger: FactRetryDispatcherLogger = CONSOLE_LOGGER,
  ) {}

  async dispatch(
    sourceTopic: string,
    envelope: Envelope,
    consumer: ConsumerName,
    process: (envelope: Envelope) => Promise<void>,
  ): Promise<void> {
    const firstFailedAt = this.clock.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      try {
        await process(envelope);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.policy.maxAttempts) {
          await this.delay.for(this.policy.backoffBaseMs * 2 ** (attempt - 1));
        }
      }
    }

    const failedAt = this.clock.now();
    await this.dlq.publish(sourceTopic, envelope, {
      failedConsumer: consumer,
      attempts: this.policy.maxAttempts,
      error: lastError,
      firstFailedAt,
      failedAt,
    });
    this.logger.error('fact-retry-dispatcher: exhausted attempts, fact dead-lettered', {
      sourceTopic,
      consumer,
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      attempts: this.policy.maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    // Deliberately NOT rethrown — see the class-level comment.
  }
}
