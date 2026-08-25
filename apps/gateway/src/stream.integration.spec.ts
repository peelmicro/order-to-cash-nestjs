// Group D — `GET /orders/stream` (R55): real NATS, real MongoDB. The
// stream is fed by a SEPARATE NATS connection publishing directly onto
// `readmodel.order.updated.<orderId>`/`readmodel.timeline.appended.<orderId>`
// — exactly the subjects `apps/projector`'s own update-signal publisher
// uses (this gateway never talks to the projector directly; it only
// consumes the signal it publishes).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { JSONCodec } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';

interface SseFrame {
  id: string;
  event: string;
  data: unknown;
}

/** Parses complete `id:`/`event:`/`data:`\n\n blocks out of an accumulating SSE text buffer, returning the parsed frames and the unconsumed remainder. */
function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    if (!block.trim()) continue;
    const idLine = block.match(/^id: (.*)$/m);
    const eventLine = block.match(/^event: (.*)$/m);
    const dataLine = block.match(/^data: (.*)$/m);
    if (idLine && eventLine && dataLine) {
      frames.push({ id: idLine[1]!, event: eventLine[1]!, data: JSON.parse(dataLine[1]!) });
    }
  }
  return { frames, rest };
}

function openSseConnection(port: number, token: string, query = '', lastEventId?: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/orders/stream${query}`, headers: { Authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) } },
      (res) => resolve({ req, res }),
    );
    req.on('error', reject);
    req.end();
  });
}

function collectUntil(res: http.IncomingMessage, predicate: (frames: SseFrame[]) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const collected: SseFrame[] = [];
    const timer = setTimeout(() => reject(new Error(`collectUntil: timed out, collected so far: ${JSON.stringify(collected)}`)), timeoutMs);
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const { frames, rest } = parseSseFrames(buffer);
      buffer = rest;
      collected.push(...frames);
      if (predicate(collected)) {
        clearTimeout(timer);
        resolve(collected);
      }
    });
    res.on('error', reject);
  });
}

describe('Gateway SSE stream — Group D (R55)', () => {
  let mongo: StandaloneMongoTestFixture;
  let nats: NatsTestFixture;
  let testApp: GatewayTestApp;
  let token: string;
  let port: number;
  let publisherConnection: Awaited<ReturnType<NatsTestFixture['connect']>>;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    nats = await startNatsTestFixture();
    testApp = await bootGatewayTestApp(mongo, nats);
    await testApp.app.listen(0);
    port = (testApp.app.getHttpServer().address() as { port: number }).port;
    publisherConnection = await nats.connect();
    const login = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await publisherConnection.close();
    await testApp.close();
    await nats.teardown();
    await mongo.teardown();
  });

  it('sends stream.ready on connect, then a live frame published on readmodel.order.updated.<orderId>', async () => {
    const orderId = randomUUID();
    const { req, res } = await openSseConnection(port, token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.connection).toBe('keep-alive');

    const codec = JSONCodec<Record<string, unknown>>();
    const readyFrames = await collectUntil(res, (frames) => frames.some((f) => f.event === 'stream.ready'));
    expect((readyFrames[0]?.data as { resumed: boolean }).resumed).toBe(false);

    publisherConnection.publish(
      `readmodel.order.updated.${orderId}`,
      codec.encode({ eventId: randomUUID(), orderId, status: 'confirmed', occurredAt: new Date().toISOString() }),
    );

    const framesAfter = await collectUntil(res, (frames) => frames.some((f) => f.event === 'order.updated'));
    const updateFrame = framesAfter.find((f) => f.event === 'order.updated')!;
    expect((updateFrame.data as { orderId: string }).orderId).toBe(orderId);

    req.destroy();
  });

  it('orderId filter — a client subscribed to one order never receives another order’s frames', async () => {
    const watchedOrderId = randomUUID();
    const otherOrderId = randomUUID();
    const { req, res } = await openSseConnection(port, token, `?orderId=${watchedOrderId}`);
    await collectUntil(res, (frames) => frames.some((f) => f.event === 'stream.ready'));

    const codec = JSONCodec<Record<string, unknown>>();
    publisherConnection.publish(`readmodel.order.updated.${otherOrderId}`, codec.encode({ eventId: randomUUID(), orderId: otherOrderId, status: 'confirmed', occurredAt: new Date().toISOString() }));
    publisherConnection.publish(`readmodel.order.updated.${watchedOrderId}`, codec.encode({ eventId: randomUUID(), orderId: watchedOrderId, status: 'confirmed', occurredAt: new Date().toISOString() }));

    const frames = await collectUntil(res, (collected) => collected.some((f) => f.event === 'order.updated'));
    const updateFrames = frames.filter((f) => f.event === 'order.updated');
    expect(updateFrames).toHaveLength(1);
    expect((updateFrames[0]!.data as { orderId: string }).orderId).toBe(watchedOrderId);

    req.destroy();
  });

  it('R55 reconnection — a known Last-Event-ID replays every frame missed since, resumed:true', async () => {
    const orderId = randomUUID();
    const codec = JSONCodec<Record<string, unknown>>();

    const first = await openSseConnection(port, token);
    await collectUntil(first.res, (frames) => frames.some((f) => f.event === 'stream.ready'));

    publisherConnection.publish(`readmodel.order.updated.${orderId}`, codec.encode({ eventId: randomUUID(), orderId, status: 'stock_reserved', occurredAt: new Date().toISOString() }));
    const firstFrames = await collectUntil(first.res, (frames) => frames.some((f) => f.event === 'order.updated'));
    const cursorAfterFirstFrame = firstFrames.find((f) => f.event === 'order.updated')!.id;
    first.req.destroy();

    // The client was disconnected when this second frame was published —
    // this is exactly what the bounded replay buffer exists to recover.
    // The APP's own internal NATS subscription (started once at boot,
    // independent of any SSE client) is what actually captures it into
    // the buffer; `flush()` is a PING/PONG round trip that confirms the
    // publish reached the server before the assertions below run.
    publisherConnection.publish(`readmodel.timeline.appended.${orderId}`, codec.encode({ eventId: randomUUID(), orderId, eventType: 'stock.reserved.v1', occurredAt: new Date().toISOString(), summary: 'Stock reserved' }));
    await publisherConnection.flush();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await openSseConnection(port, token, '', cursorAfterFirstFrame);
    const frames = await collectUntil(second.res, (collected) => collected.some((f) => f.event === 'stream.ready') && collected.some((f) => f.event === 'timeline.appended'));
    const readyFrame = frames.find((f) => f.event === 'stream.ready')!;
    expect((readyFrame.data as { resumed: boolean; cursor: string }).resumed).toBe(true);
    expect((readyFrame.data as { cursor: string }).cursor).toBe(cursorAfterFirstFrame);
    const timelineFrame = frames.find((f) => f.event === 'timeline.appended')!;
    expect((timelineFrame.data as { orderId: string }).orderId).toBe(orderId);

    second.req.destroy();
  });

  it('R55 reconnection — an unknown/aged-out Last-Event-ID answers stream.ready with resumed:false, never an error', async () => {
    const { req, res } = await openSseConnection(port, token, '', 'not-a-real-cursor');
    const frames = await collectUntil(res, (collected) => collected.some((f) => f.event === 'stream.ready'));
    const ready = frames.find((f) => f.event === 'stream.ready')!;
    expect((ready.data as { resumed: boolean }).resumed).toBe(false);
    req.destroy();
  });
});


describe('Gateway SSE stream — ping heartbeat (F7, review finding)', () => {
  // A SEPARATE app instance, own fixtures: `GATEWAY_SSE_PING_INTERVAL_MS`
  // is read once, at DI-container-build time (`app.module.ts`'s
  // `SSE_CONFIG` provider factory), so overriding it for just this test
  // means booting a dedicated app rather than reaching into the shared
  // one above (whose ping interval is already fixed at its own default,
  // 15 000 ms — comfortably longer than any test's own timeout, which is
  // exactly why F7 named this branch as untested: nothing in the suite
  // above could ever wait long enough to observe a `ping` frame).
  let mongo: StandaloneMongoTestFixture;
  let nats: NatsTestFixture;
  let testApp: GatewayTestApp;
  let token: string;
  let port: number;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    nats = await startNatsTestFixture();
    process.env.GATEWAY_SSE_PING_INTERVAL_MS = '200';
    testApp = await bootGatewayTestApp(mongo, nats);
    await testApp.app.listen(0);
    port = (testApp.app.getHttpServer().address() as { port: number }).port;
    const login = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await testApp.close();
    delete process.env.GATEWAY_SSE_PING_INTERVAL_MS;
    await nats.teardown();
    await mongo.teardown();
  });

  it('sends a ping frame on the configured interval, with a well-formed StreamPing body', async () => {
    const { req, res } = await openSseConnection(port, token);

    const frames = await collectUntil(res, (collected) => collected.filter((f) => f.event === 'ping').length >= 2, 5000);

    const pings = frames.filter((f) => f.event === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(2);
    for (const ping of pings) {
      expect(typeof (ping.data as { at: string }).at).toBe('string');
      expect(() => new Date((ping.data as { at: string }).at).toISOString()).not.toThrow();
    }

    req.destroy();
  });
});
