import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import type { MailtrapConfig } from './mailtrap.config';

/**
 * Nodemailer over SMTP against Mailtrap's sandbox inbox
 * (`sandbox.smtp.mailtrap.io:2525` by default — .env.example § Mailtrap).
 * Bound only when `mailtrap.config.ts` finds a complete, valid-looking
 * credential pair (`app.module.ts`'s `NOTIFICATION_SENDER` factory).
 *
 * The transporter is created lazily, once, on first `send` — never at
 * construction time — so building a `MailtrapNotificationSender` in a test
 * that never calls `send` never opens a socket.
 */
export class MailtrapNotificationSender implements NotificationSender {
  private transporter: Transporter | undefined;

  constructor(
    private readonly config: MailtrapConfig,
    private readonly createTransporter: (config: MailtrapConfig) => Transporter = defaultCreateTransporter,
  ) {}

  async send(message: NotificationMessage): Promise<void> {
    if (!this.transporter) {
      this.transporter = this.createTransporter(this.config);
    }
    await this.transporter.sendMail({
      from: this.config.fromEmail,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // N4 — defence in depth only (see NotificationMessage.messageId's
      // doc); nodemailer sets this verbatim as the SMTP `Message-ID`
      // header when present.
      ...(message.messageId ? { messageId: message.messageId } : {}),
    });
  }
}

function defaultCreateTransporter(config: MailtrapConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    auth: { user: config.user, pass: config.password },
  });
}
