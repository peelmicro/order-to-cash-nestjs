// @vitest-environment node
//
// `openUpstreamOrderStream` is the ONE function that decides what actually
// goes out over the wire to the Gateway for `GET /orders/stream` — this
// test proves it against a REAL local HTTP server (`node:http`), not a
// mocked `fetch`, so what's asserted here is the literal bytes/headers a
// real socket received, not an assumption about what our own code intended
// to send. This is the load-bearing proof that the streaming proxy
// genuinely forwards `Last-Event-ID` rather than dropping it (the brief's
// specific, named requirement).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openUpstreamOrderStream } from './stream-proxy';

describe('openUpstreamOrderStream — real HTTP, proves what actually reaches the Gateway', () => {
  let server: Server;
  let baseUrl: string;
  let received: IncomingMessage | undefined;

  beforeEach(async () => {
    received = undefined;
    server = createServer((req, res) => {
      received = req;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: stream.ready\ndata: {"cursor":"0","resumed":false}\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('forwards a real Last-Event-ID header verbatim to the upstream request — the browser reconnect cursor, not dropped', async () => {
    const response = await openUpstreamOrderStream({
      gatewayBaseUrl: baseUrl,
      token: 'tok-123',
      lastEventId: '1755511234901-18',
    });
    expect(response.ok).toBe(true);
    expect(received?.headers['last-event-id']).toBe('1755511234901-18');
  });

  it('sends no Last-Event-ID header at all on a fresh connection (none supplied) — never an empty/undefined-string header', async () => {
    await openUpstreamOrderStream({ gatewayBaseUrl: baseUrl, token: 'tok-123' });
    expect(received?.headers['last-event-id']).toBeUndefined();
  });

  it('attaches the real bearer token server-side, exactly like every other proxied route (F14)', async () => {
    await openUpstreamOrderStream({ gatewayBaseUrl: baseUrl, token: 'the-real-jwt' });
    expect(received?.headers.authorization).toBe('Bearer the-real-jwt');
  });

  it('appends orderId as a query parameter when the caller restricts the subscription to one order', async () => {
    await openUpstreamOrderStream({ gatewayBaseUrl: baseUrl, token: 'tok-123', orderId: 'ord-abc' });
    expect(received?.url).toBe('/orders/stream?orderId=ord-abc');
  });

  it('omits the orderId query parameter entirely when the caller did not restrict the subscription', async () => {
    await openUpstreamOrderStream({ gatewayBaseUrl: baseUrl, token: 'tok-123' });
    expect(received?.url).toBe('/orders/stream');
  });

  it('sends both Last-Event-ID and orderId together — the real reconnect-to-one-order case', async () => {
    await openUpstreamOrderStream({ gatewayBaseUrl: baseUrl, token: 'tok-123', orderId: 'ord-abc', lastEventId: 'cursor-9' });
    expect(received?.url).toBe('/orders/stream?orderId=ord-abc');
    expect(received?.headers['last-event-id']).toBe('cursor-9');
  });
});
