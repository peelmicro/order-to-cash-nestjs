import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';

/**
 * Bound in every automated test and by default whenever
 * `smtp.config.ts` finds no complete, valid-looking SMTP credential
 * pair. Logs one structured JSON line per message (CLAUDE.md § Logging) and
 * keeps every sent message in `sent` — the "call counter on the port" the
 * testing rules ask for: feature 21's N10 (a rolled-back or absent side
 * effect proves nothing about whether it was attempted) is why assertions
 * in this feature's tests read `sender.sent.length` / `sender.callCount`
 * directly, never a downstream row count.
 */
export class ConsoleNotificationSender implements NotificationSender {
  readonly sent: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<void> {
    this.sent.push(message);
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'notifications: console adapter — would have sent an email',
        to: message.to,
        subject: message.subject,
      }),
    );
  }

  get callCount(): number {
    return this.sent.length;
  }
}
