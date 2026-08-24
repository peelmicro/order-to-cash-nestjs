import { describe, expect, it, vi } from 'vitest';
import { MailtrapNotificationSender } from './mailtrap-notification-sender';
import type { MailtrapConfig } from './mailtrap.config';

const CONFIG: MailtrapConfig = {
  host: 'sandbox.smtp.mailtrap.io',
  port: 2525,
  user: 'real-user',
  password: 'real-password',
  fromEmail: 'no-reply@order-to-cash.example',
};

const MESSAGE = { to: 'retailer01@retailer.order-to-cash.example', subject: 'subject', text: 'text', html: '<p>html</p>' };

describe('MailtrapNotificationSender — this unit test never opens a real SMTP socket (a fake transporter factory is injected)', () => {
  it('sends via the injected transporter with the configured from address', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailtrap>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new MailtrapNotificationSender(CONFIG, createTransporter as never);
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
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailtrap>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new MailtrapNotificationSender(CONFIG, createTransporter as never);
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

    void new MailtrapNotificationSender(CONFIG, createTransporter as never);

    expect(createTransporter).not.toHaveBeenCalled();
  });

  it('reuses the same transporter across multiple sends (created once)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@mailtrap>' });
    const createTransporter = vi.fn().mockReturnValue({ sendMail });

    const sender = new MailtrapNotificationSender(CONFIG, createTransporter as never);
    await sender.send(MESSAGE);
    await sender.send(MESSAGE);

    expect(createTransporter).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
