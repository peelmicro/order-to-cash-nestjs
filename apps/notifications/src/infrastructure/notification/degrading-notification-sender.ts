// Graceful degradation for permanent send failures (an SMTP provider's
// quota exhaustion is the live incident this exists for — see
// progress/impl_notification_degradation.md; the provider at the time was
// Mailtrap, since replaced by Mailpit — progress/impl_mailpit_migration.md
// — but the failure shape, and this wrapper's defence against it, is
// provider-independent and stays exactly as it was).
//
// `app.module.ts`'s `NOTIFICATION_SENDER` binding used to be a ONE-TIME,
// startup-only choice between `SmtpNotificationSender` and
// `ConsoleNotificationSender` (`resolveNotificationSenderBinding`, decided
// once from env vars). That choice is still made once — whether SMTP
// is configured AT ALL — but a quota exhausted, or credentials gone bad,
// or the SMTP host itself down (Mailpit is a container, and containers
// stop), AFTER startup is invisible to it. This wrapper reconsiders on
// EVERY send: it delegates to the real (`inner`) sender, and only on
// failure asks `classifySendFailure` whether retrying could ever succeed.
//
//   - `'transient'` — rethrows the ORIGINAL error, completely unchanged.
//     Every caller above this (`NotificationDispatchService.dispatch`'s
//     N6 compensation, `FactRetryDispatcher`'s retry-then-DLQ) behaves
//     EXACTLY as it does today — this is the "must not change" half of
//     the brief. Deleting this rethrow (making every failure look
//     permanent) is exactly the "trap" the brief warns about — silent
//     degradation on every failure, not just genuinely permanent ones —
//     and is the branch `degrading-notification-sender.spec.ts`'s armed
//     deletion targets (see the progress doc for the verbatim failure).
//   - `'permanent'` — renders the SAME message to the console via
//     `fallback` (the existing `ConsoleNotificationSender`, unmodified —
//     the content stays visible), logs ONE loud, structured line naming
//     the cause, and returns NORMALLY (does not rethrow). A caller that
//     never sees a throw never retries and never dead-letters — the fact
//     is acknowledged (`NotificationDispatchService`'s ledger row stays
//     committed, nothing calls `compensation.delete`, the Kafka offset
//     commits) exactly as if the send had genuinely succeeded.
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import { activeTraceId } from '../observability/trace-context';
import { classifySendFailure } from './send-failure-classifier';

export interface DegradingNotificationSenderLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

// R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3) — alongside `message`/`meta`,
// read from the ACTIVE span, same formula every other call site this
// closeout touches uses. `correlationId` is threaded from the call site
// below (`NotificationMessage.correlationId`, set by
// `NotificationDispatchService.dispatch`).
const CONSOLE_LOGGER: DegradingNotificationSenderLogger = {
  error: (message, meta) => {
    const traceId = activeTraceId();
    console.error(JSON.stringify({ level: 'error', message, ...meta, ...(traceId ? { traceId } : {}) }));
  },
};

function describeError(error: unknown): { message: string; code?: unknown; responseCode?: unknown } {
  if (error instanceof Error) {
    const { code, responseCode } = error as Error & { code?: unknown; responseCode?: unknown };
    return { message: error.message, code, responseCode };
  }
  return { message: String(error) };
}

export class DegradingNotificationSender implements NotificationSender {
  private readonly logger: DegradingNotificationSenderLogger;

  constructor(
    private readonly inner: NotificationSender,
    private readonly fallback: NotificationSender,
    logger: DegradingNotificationSenderLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger;
  }

  async send(message: NotificationMessage): Promise<void> {
    try {
      await this.inner.send(message);
    } catch (error) {
      if (classifySendFailure(error) === 'transient') {
        throw error;
      }

      // Permanent — loud and structural, on purpose (the brief's own
      // "the trap to avoid" clause): a reader of the logs must be able to
      // tell "we are not sending email right now, and here is why"
      // without inspecting a DLQ. `event` is a stable field name so a
      // log-based alert/metric can match on it without parsing `message`.
      this.logger.error(
        'notifications: email delivery degraded — permanent send failure, will NOT retry or dead-letter; rendering to console and acknowledging the fact',
        {
          event: 'notification.send.degraded',
          to: message.to,
          subject: message.subject,
          messageId: message.messageId,
          correlationId: message.correlationId,
          reason: describeError(error),
        },
      );

      await this.fallback.send(message);
    }
  }
}
