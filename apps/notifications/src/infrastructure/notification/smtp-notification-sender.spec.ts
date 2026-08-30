import { describe, expect, it, vi } from 'vitest';
import { SmtpNotificationSender } from './smtp-notification-sender';
import type { SmtpConfig } from './smtp.config';

const CONFIG: SmtpConfig = {
  host: 'localhost',
  port: 1025,
  user: 'real-user',
  password: 'real-password',
  fromEmail: 'no-reply@order-to-cash.example',
};

const MESSAGE = { to: 'retailer01@retailer.order-to-cash.example', subject: 'subject', text: 'text', html: '<p>html</p>' };

describe('SmtpNotificationSender — this unit test never opens a real SMTP socket (a fake transporter factory is injected)', () => {
  it('sends via the injected transporter with the configured from address', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailpit>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new SmtpNotificationSender(CONFIG, createTransporter as never);
    await sender.send(MESSAGE);

    expect(sendMail).toHaveBeenCalledWith({
      from: CONFIG.fromEmail,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  // N4 — messageId, when present, is forwarded verbatim to nodemailer as
  // the SMTP Message-ID header; omitted entirely (not sent as `undefined`)
  // when the message carries none, per the case above.
  it('N4 — forwards messageId to the transporter when the message carries one', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailpit>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new SmtpNotificationSender(CONFIG, createTransporter as never);
    await sender.send({ ...MESSAGE, messageId: 'event-1@order-to-cash' });

    expect(sendMail).toHaveBeenCalledWith({
      from: CONFIG.fromEmail,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      messageId: 'event-1@order-to-cash',
    });
  });

  it('creates the transporter lazily — never at construction time', () => {
    const createTransporter = vi.fn();

    void new SmtpNotificationSender(CONFIG, createTransporter as never);

    expect(createTransporter).not.toHaveBeenCalled();
  });

  it('reuses the same transporter across multiple sends (created once)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailpit>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new SmtpNotificationSender(CONFIG, createTransporter as never);
    await sender.send(MESSAGE);
    await sender.send(MESSAGE);

    expect(createTransporter).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
