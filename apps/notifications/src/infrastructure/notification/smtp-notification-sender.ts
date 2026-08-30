import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import type { SmtpConfig } from './smtp.config';

/**
 * Nodemailer over SMTP — provider-neutral by construction (Mailpit locally,
 * `mailpit:1025` inside the compose network / `localhost:1025` outside it —
 * see .env.example § SMTP and docker-compose.infra.yml's `mailpit` service
 * header for why Mailpit replaced Mailtrap). `SMTP_HOST`/`SMTP_PORT` can
 * point this adapter at ANY SMTP server, Mailtrap included; nothing in this
 * class is vendor-specific. Bound only when `smtp.config.ts` finds a
 * complete, valid-looking credential pair (`app.module.ts`'s
 * `NOTIFICATION_SENDER` factory).
 *
 * The transporter is created lazily, once, on first `send` — never at
 * construction time — so building an `SmtpNotificationSender` in a test
 * that never calls `send` never opens a socket.
 */
export class SmtpNotificationSender implements NotificationSender {
  private transporter: Transporter | undefined;

  constructor(
    private readonly config: SmtpConfig,
    private readonly createTransporter: (config: SmtpConfig) => Transporter = defaultCreateTransporter,
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

function defaultCreateTransporter(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    auth: { user: config.user, pass: config.password },
  });
}
