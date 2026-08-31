import { JSONCodec, type MsgHdrs } from 'nats';
import { describe, expect, it, vi } from 'vitest';
import { StreamHub } from '../../application/stream-hub';
import { NatsStreamSignalAdapter, ORDER_UPDATED_WILDCARD_SUBJECT, TIMELINE_APPENDED_WILDCARD_SUBJECT } from './nats-stream-signal.adapter';

interface FakeFrame {
  data: Uint8Array;
  subject?: string;
  headers?: MsgHdrs;
}

function fakeSubscription(frames: (Uint8Array | FakeFrame)[], subject: string) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        yield frame instanceof Uint8Array ? { data: frame, subject } : { subject, ...frame };
      }
    },
    unsubscribe: vi.fn(),
  };
}

describe('NatsStreamSignalAdapter', () => {
  it('R55 — decodes readmodel.order.updated frames and publishes them onto the StreamHub', async () => {
    const codec = JSONCodec<{ orderId: string; status: string }>();
    const orderUpdatedSub = fakeSubscription([codec.encode({ orderId: 'order-1', status: 'placed' })], 'readmodel.order.updated.order-1');
    const timelineSub = fakeSubscription([], 'readmodel.timeline.appended.order-1');
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

  it('a malformed frame is logged — as a structured JSON line naming its subject — and skipped, without breaking consumption of the next well-formed frame', async () => {
    const codec = JSONCodec<{ orderId: string }>();
    const malformed = new TextEncoder().encode('not json');
    const wellFormed = codec.encode({ orderId: 'order-2' });
    const orderUpdatedSub = fakeSubscription([malformed, wellFormed], 'readmodel.order.updated.order-2');
    const timelineSub = fakeSubscription([], 'readmodel.timeline.appended.order-2');
    const connection = { subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)) };
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 10);
    const received: unknown[] = [];
    hub.frames$.subscribe((frame) => received.push(frame));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = new NatsStreamSignalAdapter(connection as never, hub);
    adapter.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.level).toBe('error');
    expect(logged.message).toBe('gateway: nats-stream-signal — failed to decode a signal frame');
    expect(logged.subject).toBe('readmodel.order.updated.order-2');
    expect(received).toHaveLength(1);
    expect((received[0] as { orderId: string }).orderId).toBe('order-2');
    errorSpy.mockRestore();
  });

  it('stop() unsubscribes both subscriptions', async () => {
    const orderUpdatedSub = fakeSubscription([], 'readmodel.order.updated.*');
    const timelineSub = fakeSubscription([], 'readmodel.timeline.appended.*');
    const connection = { subscribe: vi.fn((subject: string) => (subject === ORDER_UPDATED_WILDCARD_SUBJECT ? orderUpdatedSub : timelineSub)) };
    const hub = new StreamHub({ now: () => new Date() }, 10);

    const adapter = new NatsStreamSignalAdapter(connection as never, hub);
    adapter.start();
    await adapter.stop();

    expect(orderUpdatedSub.unsubscribe).toHaveBeenCalled();
    expect(timelineSub.unsubscribe).toHaveBeenCalled();
  });
});
