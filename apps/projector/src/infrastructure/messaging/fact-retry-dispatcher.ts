// COPY OF — apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.ts
//
// VERBATIM copy of the canonical retry-then-DLQ dispatcher pattern
// (specs/observability_reliability/design.md §4.1), byte-identical (after
// this banner) to the canonical, guarded by
// idempotent-consumer.parity.spec.ts (OI12, widened for this second
// canonical pair — A4f/A4g), EXCEPT for the R58 closeout below, which
// `idempotent-consumer.parity.spec.ts`'s own comment on
// `RETRY_DISPATCHER_TRACE_DIVERGENT_MARKER` already anticipates: "a future
// pass that gives projector/notifications their own `activeTraceId()`
// should backport these lines." This IS that pass — this copy now matches
// its `apps/notifications` peer byte-for-byte (both gained the identical
// `activeTraceId()`/`correlationId` addition; the guard's own peer-parity
// case, not equality against the canonical, is what protects this).
// `FactRetryDispatcher` has no store of its own and no dependency on how
// this service's own idempotency ledger is kept (MongoDB here, MySQL in
// orders/notifications) — it sits one layer ABOVE `IdempotentConsumer`, at
// `projector-facts.controller.ts`'s own dispatch point, wrapping the SAME
// `commandBus.execute(...)` call that already existed. Because this file
// has no dependency on the storage layer, it is copied here even though
// this service is registered `'documented-variant'` for the (unrelated)
// `idempotent-consumer.ts` pattern — see idempotent-consumer.parity.spec.ts's
// own comment on why the two patterns are gated independently. Deliberately
// does NOT also backport A7's `otc_fact_processing_latency_ms` recording
// (out of R58's scope — neither service owns a `Meter` bootstrap yet), so
// this copy still diverges from the canonical on that one point; only the
// R58 traceId/correlationId lines are backported here.
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port.js';
import type { ConsumerName } from '../../application/ports/consumer-name.js';
import { activeTraceId } from '../observability/trace-context.js';

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
    const traceId = activeTraceId();
    this.logger.error('fact-retry-dispatcher: exhausted attempts, fact dead-lettered', {
      sourceTopic,
      consumer,
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      ...(traceId ? { traceId } : {}),
      attempts: this.policy.maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    // Deliberately NOT rethrown — see the class-level comment.
  }
}
