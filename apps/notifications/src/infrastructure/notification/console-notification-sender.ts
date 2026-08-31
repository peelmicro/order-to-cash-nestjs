import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import { activeTraceId } from '../observability/trace-context';

/**
 * Bound in every automated test and by default whenever
 * `smtp.config.ts` finds no complete, valid-looking SMTP credential
 * pair — AND, wrapped in `DegradingNotificationSender`, as the production
 * degradation fallback (`app.module.ts`'s `NOTIFICATION_SENDER` factory):
 * on that path this line is the ONLY record that a notification went out.
 * Logs one structured JSON line per message (CLAUDE.md § Logging) and
 * keeps every sent message in `sent` — the "call counter on the port" the
 * testing rules ask for: feature 21's N10 (a rolled-back or absent side
 * effect proves nothing about whether it was attempted) is why assertions
 * in this feature's tests read `sender.sent.length` / `sender.callCount`
 * directly, never a downstream row count.
 *
 * B5 closeout (progress/review_final_checkpoint.md) — `correlationId` and
 * `traceId` now ride this line, same formula as every other R58 site in
 * this service (`degrading-notification-sender.ts`'s `CONSOLE_LOGGER`):
 * `message.correlationId` (the fact's own, set by
 * `NotificationDispatchService.dispatch`) plus `activeTraceId()` (the
 * ACTIVE span's real `traceId`), each key omitted — never logged as the
 * literal string `"undefined"` — when no value is available.
 */
export class ConsoleNotificationSender implements NotificationSender {
  readonly sent: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<void> {
    this.sent.push(message);
    const traceId = activeTraceId();
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'notifications: console adapter — would have sent an email',
        to: message.to,
        subject: message.subject,
        ...(message.correlationId ? { correlationId: message.correlationId } : {}),
        ...(traceId ? { traceId } : {}),
      }),
    );
  }

  get callCount(): number {
    return this.sent.length;
  }
}
