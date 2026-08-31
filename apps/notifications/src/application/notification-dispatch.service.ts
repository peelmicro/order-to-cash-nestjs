// The ONE generic dispatch unit every fact `@CommandHandler`
// (commands/notify.command-handlers.ts) delegates to — mirrors
// apps/orders/src/application/saga-fact-handler.ts's composition of the
// SAME `IdempotentConsumer` class: `RunsIdempotently` is a narrow
// structural interface `IdempotentConsumer`
// (infrastructure/messaging/idempotent-consumer.ts, byte-identical to the
// canonical — notifications_service re-review, N1/N2) satisfies WITHOUT
// this file importing it, so `notification-dispatch.service.spec.ts` fakes
// it directly and never touches a real database.
//
// N6 (re-review) — "insert-first, then send, then delete the row if the
// send throws": `runOnce` is called with a NO-OP `work`, so the canonical
// pattern's dedup INSERT commits on its own, as its own short transaction
// (this is genuinely "insert-first", not a disguise for check-then-mark —
// see idempotent-consumer.ts, unmodified). Only AFTER that commits does
// `dispatch` call `sender.send`, deliberately OUTSIDE any database
// transaction — an SMTP round-trip should not hold a MySQL transaction (and
// the row lock the unique index takes) open for its duration. If the send
// throws, `compensation.delete(...)` removes the just-committed row before
// this method rethrows, so Kafka's redelivery (no offset commit on a thrown
// `@EventPattern` handler) gets a genuinely fresh attempt rather than a
// permanently-swallowed one. This is a deliberate divergence from the
// canonical's own "record + effect in ONE transaction" ordering (which this
// service cannot reproduce for a non-database effect) — see
// progress/impl_notifications_service.md's N6 entry for the full reasoning.
//
// N13 (re-review) — the SMTP error is what must propagate, never a
// compensation failure. If `compensation.delete(...)` itself throws (e.g. a
// transient MySQL error), that failure is caught HERE, logged with enough
// detail to find and clear the orphaned row by hand (`eventId`, consumer),
// and swallowed — the ORIGINAL `sender.send` error is always what this
// method rethrows. Letting a MySQL error replace the real SMTP cause would
// send whoever debugs the incident to the wrong subsystem, which is worse
// than losing the orphaned-row cleanup automation for that one event.
import type { Envelope } from '@otc/contracts';
import { activeTraceId } from '../infrastructure/observability/trace-context';
import { CONSUMER_NAMES, type ConsumerName } from './ports/consumer-name';
import type { NotificationMessage, NotificationSender } from './ports/notification-sender.port';
import type { TransactionContext } from './ports/unit-of-work.port';

export type ConsumptionOutcome = 'processed' | 'duplicate';

/** The narrow surface this service needs from `IdempotentConsumer` — same reasoning as `RunsIdempotently` in saga-fact-handler.ts. */
export interface RunsIdempotently {
  runOnce(
    eventId: string,
    consumer: ConsumerName,
    work: (tx: TransactionContext) => Promise<void>,
  ): Promise<ConsumptionOutcome>;
}

/** The narrow surface this service needs from `DrizzleProcessedEventCompensation` — same reasoning as `RunsIdempotently` above. */
export interface DeletesProcessedEvent {
  delete(eventId: string, consumer: ConsumerName): Promise<void>;
}

export interface NotificationDispatchServiceLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

// R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3) — the compensating-delete-
// failure log now carries `traceId`, read from the ACTIVE span at the
// moment it logs (this method's own caller — `notification-facts.controller
// .ts`'s `route` — wraps the whole retry-then-DLQ dispatch, including this
// call, in the fact-consume span). `activeTraceId()` lives in
// `infrastructure/observability/` — a direct cross-layer import from this
// application-layer file, a deliberate, narrow exception: an OTel-only
// helper with zero framework/driver coupling, reused via this repo's one
// existing pattern (every presentation/infrastructure call site this
// closeout touches) rather than inventing a port for a single call site.
const CONSOLE_LOGGER: NotificationDispatchServiceLogger = {
  error: (message, meta) => {
    const traceId = activeTraceId();
    console.error(JSON.stringify({ level: 'error', message, ...meta, ...(traceId ? { traceId } : {}) }));
  },
};

const CONSUMER: ConsumerName = CONSUMER_NAMES[0];

export class NotificationDispatchService {
  private readonly logger: NotificationDispatchServiceLogger;

  constructor(
    private readonly idempotency: RunsIdempotently,
    private readonly sender: NotificationSender,
    private readonly compensation: DeletesProcessedEvent,
    logger: NotificationDispatchServiceLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger;
  }

  /**
   * Records `(eventId, "notifications")` in the durable ledger FIRST
   * (`idempotency.runOnce` with a no-op `work` — insert-first, this file's
   * header), builds the message via `buildMessage(envelope)` and hands it
   * to the bound `NotificationSender` — exactly once per `eventId`
   * (specs/shared/saga.md §6, layer 1). On a redelivered `eventId` this
   * resolves to `'duplicate'` WITHOUT calling `buildMessage` or
   * `sender.send` at all, and without touching the ledger a second time —
   * deleting that guard, and having `sender.send` fire a second time for
   * the same `eventId`, is exactly what
   * `notification-dispatch.service.spec.ts`'s armed deletion proves (see
   * progress/impl_notifications_service.md for the verbatim failure). On a
   * throw from `sender.send`, the ledger row is deleted (N6) before the
   * throw propagates, so the fact is redelivered as if never recorded.
   */
  async dispatch(
    envelope: Envelope,
    buildMessage: (envelope: Envelope) => NotificationMessage,
  ): Promise<ConsumptionOutcome> {
    const outcome = await this.idempotency.runOnce(envelope.eventId, CONSUMER, async () => {
      // Intentionally empty — see this file's header. The INSERT alone is
      // the effect of this transaction; the SMTP send happens afterwards.
    });
    if (outcome === 'duplicate') {
      return outcome;
    }

    try {
      const message = buildMessage(envelope);
      // N4 — attach messageId here, once, so every one of the seven
      // templates stays free of this concern (NotificationMessage.messageId's
      // doc: defence in depth only). R58 closeout — `correlationId`
      // attached the same way, for the same reason (see
      // `NotificationMessage.correlationId`'s own doc).
      await this.sender.send({
        ...message,
        messageId: `${envelope.eventId}@order-to-cash`,
        correlationId: envelope.correlationId,
      });
    } catch (sendError) {
      // N13 — the compensating delete's OWN failure must never replace
      // `sendError` as what this method throws (this file's header). Caught,
      // logged with the identifiers needed to clear the orphaned row by
      // hand, and swallowed.
      try {
        await this.compensation.delete(envelope.eventId, CONSUMER);
      } catch (compensationError) {
        this.logger.error(
          'notification-dispatch.service: compensating delete failed after a failed send — the ledger row is orphaned and must be cleared by hand',
          {
            eventId: envelope.eventId,
            correlationId: envelope.correlationId,
            consumer: CONSUMER,
            sendError: sendError instanceof Error ? sendError.message : String(sendError),
            compensationError: compensationError instanceof Error ? compensationError.message : String(compensationError),
          },
        );
      }
      throw sendError;
    }

    return outcome;
  }
}
