import { describe, expect, it } from 'vitest';
import { StreamHub } from './stream-hub';

describe('StreamHub', () => {
  it('R55 — publishing emits a frame to live subscribers with a fresh cursor', () => {
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:15:00.000Z') }, 10);
    const received: string[] = [];
    hub.frames$.subscribe((frame) => received.push(frame.cursor));

    const frame = hub.publish('order.updated', 'order-1', { orderId: 'order-1', status: 'placed' });

    expect(received).toEqual([frame.cursor]);
    expect(frame.event).toBe('order.updated');
    expect(frame.orderId).toBe('order-1');
  });

  it('replayAfter resumes from the buffer, resumed:true, everything after the given cursor', () => {
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:15:00.000Z') }, 10);
    const first = hub.publish('order.updated', 'order-1', { orderId: 'order-1' });
    hub.publish('timeline.appended', 'order-1', { orderId: 'order-1', eventType: 'stock.reserved.v1' });

    const result = hub.replayAfter(first.cursor);
    expect(result.resumed).toBe(true);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0]?.event).toBe('timeline.appended');
  });

  it('replayAfter(undefined) — a fresh connection with no Last-Event-ID — is resumed:false', () => {
    const hub = new StreamHub({ now: () => new Date('2026-08-18T10:15:00.000Z') }, 10);
    hub.publish('order.updated', 'order-1', { orderId: 'order-1' });

    expect(hub.replayAfter(undefined)).toEqual({ resumed: false, missed: [] });
  });
});
