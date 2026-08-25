import { JSONCodec } from 'nats';
import { describe, expect, it, vi } from 'vitest';
import { StreamHub } from '../../application/stream-hub';
import { NatsStreamSignalAdapter, ORDER_UPDATED_WILDCARD_SUBJECT, TIMELINE_APPENDED_WILDCARD_SUBJECT } from './nats-stream-signal.adapter';

function fakeSubscription(frames: Uint8Array[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const data of frames) {
        yield { data };
      }
    },
    unsubscribe: vi.fn(),
  };
}

describe('NatsStreamSignalAdapter', () => {
  it('R55 — decodes readmodel.order.updated frames and publishes them onto the StreamHub', async () => {
    const codec = JSONCodec<{ orderId: string; status: string }>();
    const orderUpdatedSub = fakeSubscription([codec.encode({ orderId: 'order-1', status: 'placed' })]);
    const timelineSub = fakeSubscription([]);
    const connection = {
      subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)),
    };
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 10);
    const received: unknown[] = [];
    hub.frames$.subscribe((frame) => received.push(frame));

    const adapter = new NatsStreamSignalAdapter(connection as never, hub);
    adapter.start();
    // Let the async iterator loops run one microtask turn.
    await new Promise((resolve) => setImmediate(resolve));

    expect(connection.subscribe).toHaveBeenCalledWith(ORDER_UPDATED_WILDCARD_SUBJECT);
    expect(connection.subscribe).toHaveBeenCalledWith(TIMELINE_APPENDED_WILDCARD_SUBJECT);
    expect(received).toHaveLength(1);
    expect((received[0] as { event: string }).event).toBe('order.updated');
    expect((received[0] as { orderId: string }).orderId).toBe('order-1');
  });

  it('a malformed frame is logged and skipped, without breaking consumption of the next well-formed frame', async () => {
    const codec = JSONCodec<{ orderId: string }>();
    const malformed = new TextEncoder().encode('not json');
    const wellFormed = codec.encode({ orderId: 'order-2' });
    const orderUpdatedSub = fakeSubscription([malformed, wellFormed]);
    const timelineSub = fakeSubscription([]);
    const connection = { subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)) };
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 10);
    const received: unknown[] = [];
    hub.frames$.subscribe((frame) => received.push(frame));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = new NatsStreamSignalAdapter(connection as never, hub);
    adapter.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect((received[0] as { orderId: string }).orderId).toBe('order-2');
    errorSpy.mockRestore();
  });

  it('stop() unsubscribes both subscriptions', async () => {
    const orderUpdatedSub = fakeSubscription([]);
    const timelineSub = fakeSubscription([]);
    const connection = { subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)) };
    const hub = new StreamHub({ now: () => new Date() }, 10);

    const adapter = new NatsStreamSignalAdapter(connection as never, hub);
    adapter.start();
    await adapter.stop();

    expect(orderUpdatedSub.unsubscribe).toHaveBeenCalled();
    expect(timelineSub.unsubscribe).toHaveBeenCalled();
  });
});
