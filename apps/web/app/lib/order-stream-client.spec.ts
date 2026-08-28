// @vitest-environment node
//
// `OrderStreamClient` is exercised here against a REAL `EventSource`
// implementation (the `eventsource` npm package — a standards-compliant
// client, not a stand-in written for this test) talking real HTTP to a
// real local `node:http` server that emits genuine SSE-formatted bytes
// (`id:`/`event:`/`data:`/`retry:` lines, byte for byte what
// `openapi.yaml`'s "Frame format" section documents). Nothing about
// dedup or reconnection is assumed or mocked — the class under test parses
// whatever the real `EventSource` hands it, exactly as it would in the
// browser.
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventSource } from 'eventsource';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderStreamClient, type EventSourceLike, type StreamConnectionStatus } from './order-stream-client';
import type { OrderStreamUpdate, TimelineStreamEntry } from '#shared/types/gateway';

const realEventSourceFactory = (url: string): EventSourceLike => new EventSource(url) as unknown as EventSourceLike;

function frame(id: string | null, event: string, data: unknown): string {
  const idLine = id !== null ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('OrderStreamClient — real EventSource, real HTTP, real SSE bytes', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function listen(handler: RequestListener): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('R51 — a redelivered order.updated frame (same eventId, sent twice) reaches onOrderUpdated exactly once', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const update: OrderStreamUpdate = { eventId: 'evt-dup-1', orderId: 'ord-1', status: 'stock_reserved', occurredAt: new Date().toISOString() };
      res.write(frame(null, 'stream.ready', { cursor: 'c0', resumed: false }));
      // Genuine at-least-once redelivery, simulated the honest way the
      // contract itself admits can happen — the exact same frame twice in
      // the byte stream, not two different JS objects with the same shape.
      res.write(frame('c1', 'order.updated', update));
      res.write(frame('c1', 'order.updated', update));
    });

    const received: OrderStreamUpdate[] = [];
    const client = new OrderStreamClient(
      url,
      { onOrderUpdated: (u) => received.push(u), onTimelineAppended: () => {}, onResync: () => {}, onStatusChange: () => {} },
      realEventSourceFactory,
    );
    client.connect();

    try {
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 3000 });
      // Give any (wrongly) duplicated second delivery a real chance to land before asserting the count.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toHaveLength(1);
      expect(received[0]!.eventId).toBe('evt-dup-1');
    } finally {
      client.disconnect();
    }
  });

  // Pass 3 review Finding 1 (progress/review_web_app.md): the projector
  // deliberately stamps the SAME eventId onto both the `order.updated` and
  // `timeline.appended` payloads it emits for one fact
  // (apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts:51,61),
  // and the two frame types travel over independent NATS subjects with no
  // ordering guarantee between them
  // (apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.ts).
  // A dedup Set shared across both frame types treats the second type to
  // arrive for a fact as a duplicate of the first and silently drops it —
  // this is the real, universal shape of every fact this system emits, not
  // an edge case. Both wire orders are proved here so neither direction of
  // the race can regress unnoticed.
  it('R51 — order.updated then timeline.appended sharing one eventId are BOTH applied (not treated as duplicates of each other)', async () => {
    const sharedEventId = 'evt-shared-1';
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const update: OrderStreamUpdate = { eventId: sharedEventId, orderId: 'ord-1', status: 'stock_reserved', occurredAt: new Date().toISOString() };
      const entry: TimelineStreamEntry = {
        eventId: sharedEventId,
        orderId: 'ord-1',
        orderReference: 'ORD-000001',
        eventType: 'order.stock_reserved.v1',
        occurredAt: new Date().toISOString(),
        summary: 'Stock reserved',
      };
      res.write(frame(null, 'stream.ready', { cursor: 'c0', resumed: false }));
      res.write(frame('c1', 'order.updated', update));
      res.write(frame('c2', 'timeline.appended', entry));
    });

    const orderUpdates: OrderStreamUpdate[] = [];
    const timelineEntries: TimelineStreamEntry[] = [];
    const client = new OrderStreamClient(
      url,
      {
        onOrderUpdated: (u) => orderUpdates.push(u),
        onTimelineAppended: (e) => timelineEntries.push(e),
        onResync: () => {},
        onStatusChange: () => {},
      },
      realEventSourceFactory,
    );
    client.connect();

    try {
      await vi.waitFor(() => {
        expect(orderUpdates.length).toBeGreaterThan(0);
        expect(timelineEntries.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
      expect(orderUpdates).toHaveLength(1);
      expect(timelineEntries).toHaveLength(1);
      expect(orderUpdates[0]!.eventId).toBe(sharedEventId);
      expect(timelineEntries[0]!.eventId).toBe(sharedEventId);
    } finally {
      client.disconnect();
    }
  });

  it('R51 — timeline.appended then order.updated sharing one eventId (reverse wire order) are BOTH applied', async () => {
    const sharedEventId = 'evt-shared-2';
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const update: OrderStreamUpdate = { eventId: sharedEventId, orderId: 'ord-1', status: 'confirmed', occurredAt: new Date().toISOString() };
      const entry: TimelineStreamEntry = {
        eventId: sharedEventId,
        orderId: 'ord-1',
        orderReference: 'ORD-000001',
        eventType: 'order.confirmed.v1',
        occurredAt: new Date().toISOString(),
        summary: 'Order confirmed',
      };
      res.write(frame(null, 'stream.ready', { cursor: 'c0', resumed: false }));
      // Reverse order from the test above — proves the fix is not
      // sensitive to which frame type happens to win the wire race.
      res.write(frame('c1', 'timeline.appended', entry));
      res.write(frame('c2', 'order.updated', update));
    });

    const orderUpdates: OrderStreamUpdate[] = [];
    const timelineEntries: TimelineStreamEntry[] = [];
    const client = new OrderStreamClient(
      url,
      {
        onOrderUpdated: (u) => orderUpdates.push(u),
        onTimelineAppended: (e) => timelineEntries.push(e),
        onResync: () => {},
        onStatusChange: () => {},
      },
      realEventSourceFactory,
    );
    client.connect();

    try {
      await vi.waitFor(() => {
        expect(orderUpdates.length).toBeGreaterThan(0);
        expect(timelineEntries.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
      expect(orderUpdates).toHaveLength(1);
      expect(timelineEntries).toHaveLength(1);
      expect(orderUpdates[0]!.eventId).toBe(sharedEventId);
      expect(timelineEntries[0]!.eventId).toBe(sharedEventId);
    } finally {
      client.disconnect();
    }
  });

  it('resumed: false (stream.ready) triggers onResync — the honest re-fetch-to-resynchronise path', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(frame(null, 'stream.ready', { cursor: 'c0', resumed: false }));
    });

    let resyncCalls = 0;
    const client = new OrderStreamClient(
      url,
      { onOrderUpdated: () => {}, onTimelineAppended: () => {}, onResync: () => { resyncCalls += 1; }, onStatusChange: () => {} },
      realEventSourceFactory,
    );
    client.connect();

    try {
      await vi.waitFor(() => expect(resyncCalls).toBe(1), { timeout: 3000 });
    } finally {
      client.disconnect();
    }
  });

  it('resumed: true does NOT trigger onResync, and a real reconnect (forced socket close + automatic EventSource retry) delivers the frame missed while disconnected, exactly once, alongside the one already delivered', async () => {
    let connectionCount = 0;
    let observedLastEventIdOnSecondConnect: string | undefined;

    const url = await listen((req, res) => {
      connectionCount += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      // Fast reconnect for this test only — real openapi.yaml frames never carry `retry:`, this is a local test-server-only SSE field to keep the test fast, not a contract behaviour under test.
      res.write('retry: 20\n\n');

      if (connectionCount === 1) {
        res.write(frame(null, 'stream.ready', { cursor: 'c0', resumed: false }));
        res.write(frame('cursor-1', 'order.updated', { eventId: 'evt-1', orderId: 'ord-1', status: 'stock_reserved', occurredAt: new Date().toISOString() } satisfies OrderStreamUpdate));
        // Force a real disconnect shortly after — this is what the
        // automatic EventSource reconnect (with the real Last-Event-ID it
        // remembered) is being asked to recover from.
        setTimeout(() => res.destroy(), 40);
        return;
      }

      observedLastEventIdOnSecondConnect = req.headers['last-event-id'] as string | undefined;
      const resumed = observedLastEventIdOnSecondConnect === 'cursor-1';
      res.write(frame(null, 'stream.ready', { cursor: observedLastEventIdOnSecondConnect ?? 'c0', resumed }));
      res.write(frame('cursor-2', 'order.updated', { eventId: 'evt-2', orderId: 'ord-1', status: 'confirmed', occurredAt: new Date().toISOString() } satisfies OrderStreamUpdate));
    });

    const received: OrderStreamUpdate[] = [];
    let resyncCalls = 0;
    const statuses: StreamConnectionStatus[] = [];
    const client = new OrderStreamClient(
      url,
      {
        onOrderUpdated: (u) => received.push(u),
        onTimelineAppended: () => {},
        onResync: () => { resyncCalls += 1; },
        onStatusChange: (s) => statuses.push(s),
      },
      realEventSourceFactory,
    );
    client.connect();

    try {
      await vi.waitFor(() => expect(received.map((u) => u.eventId)).toEqual(['evt-1', 'evt-2']), { timeout: 5000 });
      expect(observedLastEventIdOnSecondConnect).toBe('cursor-1');
      // Only the FIRST connection answered resumed:false — the reconnect answered resumed:true, so onResync must have fired exactly once, not twice.
      expect(resyncCalls).toBe(1);
      expect(statuses).toContain('reconnecting');
    } finally {
      client.disconnect();
    }
  });
});
