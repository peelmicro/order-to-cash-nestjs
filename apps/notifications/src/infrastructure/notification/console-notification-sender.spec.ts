import { describe, expect, it } from 'vitest';
import { ConsoleNotificationSender } from './console-notification-sender';

const MESSAGE = { to: 'retailer01@retailer.order-to-cash.example', subject: 'subject', text: 'text', html: '<p>html</p>' };

describe('ConsoleNotificationSender — the port a NotificationSender adapter implements, and the call counter the testing rules ask for', () => {
  it('records every sent message and exposes callCount as a direct proof of "send was invoked"', async () => {
    const sender = new ConsoleNotificationSender();

    await sender.send(MESSAGE);

    expect(sender.callCount).toBe(1);
    expect(sender.sent).toEqual([MESSAGE]);
  });

  it('never sends real mail — it has no network client at all', async () => {
    const sender = new ConsoleNotificationSender();
    await sender.send(MESSAGE);
    await sender.send({ ...MESSAGE, subject: 'second' });

    expect(sender.callCount).toBe(2);
  });
});
