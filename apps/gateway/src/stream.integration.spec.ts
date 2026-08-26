// Group D — `GET /orders/stream` (R55): real NATS, real MongoDB. The
// stream is fed by a SEPARATE NATS connection publishing directly onto
// `readmodel.order.updated.<orderId>`/`readmodel.timeline.appended.<orderId>`
// — exactly the subjects `apps/projector`'s own update-signal publisher
// uses (this gateway never talks to the projector directly; it only
// consumes the signal it publishes).
import { randomUUID } from 'node:crypto';
import { JSONCodec } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { collectUntil, openSseConnection } from './test-support/sse-test-client';

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

  // Acceptance criterion 1 of feature 26, "client reconnect resumes without
  // duplicates" — read literally against openapi.yaml's own admission that
  // delivery is AT-LEAST-ONCE (a frame may repeat after a reconnect;
  // clients deduplicate on `eventId`). That rules out "the transport
  // guarantees exactly-once" as the reading. What IS a transport-level
  // guarantee, and what THIS test proves: resuming from a given cursor
  // returns strictly the frames AFTER that cursor, never the cursor's own
  // frame again — "resumes after", never "resumes at-or-before". The test
  // above ('a known Last-Event-ID replays every frame missed since') proves
  // the replay is non-empty; it does not prove the boundary is exclusive.
  // This one does: it captures the cursor AND the eventId of a frame
  // actually delivered on connection one, reconnects with exactly that
  // cursor, and asserts neither the cursor nor the eventId reappears.
  it('R55 "without duplicates" — reconnecting with the cursor of an already-received frame never redelivers that frame', async () => {
    const orderId = randomUUID();
    const codec = JSONCodec<Record<string, unknown>>();
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();

    const first = await openSseConnection(port, token, `?orderId=${orderId}`);
    await collectUntil(first.res, (frames) => frames.some((f) => f.event === 'stream.ready'));

    publisherConnection.publish(
      `readmodel.order.updated.${orderId}`,
      codec.encode({ eventId: firstEventId, orderId, status: 'stock_reserved', occurredAt: new Date().toISOString() }),
    );
    const firstFrames = await collectUntil(first.res, (frames) => frames.some((f) => f.event === 'order.updated'));
    const cursorOfReceivedFrame = firstFrames.find((f) => f.event === 'order.updated')!.id;
    first.req.destroy();

    // Disconnected here. One more fact arrives — this IS what the reconnect
    // is legitimately supposed to replay; the assertion below is that it
    // replays ONLY this one, never the one already delivered above.
    publisherConnection.publish(
      `readmodel.order.updated.${orderId}`,
      codec.encode({ eventId: secondEventId, orderId, status: 'credit_approved', occurredAt: new Date().toISOString() }),
    );
    await publisherConnection.flush();

    // `flush()` only proves the publish reached the NATS server — not that
    // the app's OWN internal NATS subscription (started once at boot,
    // independent of any SSE client — see the comment on the previous
    // test) has run its handler and written the fact into the replay
    // buffer yet. A single fixed delay here (this test's previous version:
    // `await new Promise((resolve) => setTimeout(resolve, 100))`) let the
    // test PASS via the live-push path instead of the replay path under
    // load, silently, with every assertion below still green and the
    // off-by-one replay-boundary mutation surviving undetected (review
    // finding F3). Retry the reconnect itself on TERMINAL evidence instead
    // — `stream.ready`'s own `resumed` flag — so the test only proceeds
    // once the replay buffer has actually captured the fact. Every retry
    // opens a genuinely new, independent connection with the same cursor;
    // reading the buffer's state is side-effect-free, so repeating it is
    // safe.
    const deadlineAt = Date.now() + 10_000;
    let second: Awaited<ReturnType<typeof openSseConnection>> | undefined;
    let resumed: boolean;
    for (;;) {
      second = await openSseConnection(port, token, `?orderId=${orderId}`, cursorOfReceivedFrame);
      const readyFrames = await collectUntil(second.res, (frames) => frames.some((f) => f.event === 'stream.ready'), 2000);
      const readyFrame = readyFrames.find((f) => f.event === 'stream.ready')!;
      resumed = (readyFrame.data as { resumed: boolean }).resumed;
      if (resumed) break;
      second.req.destroy();
      if (Date.now() > deadlineAt) {
        throw new Error('R55 "without duplicates": stream.ready never reported resumed:true within 10s — the replay buffer never captured the second publish.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(resumed).toBe(true);

    const frames = await collectUntil(second.res, (collected) => collected.some((f) => f.event === 'order.updated'));
    second.req.destroy();

    const updateFrames = frames.filter((f) => f.event === 'order.updated');
    expect(updateFrames.some((f) => f.id === cursorOfReceivedFrame)).toBe(false);
    expect(updateFrames.some((f) => (f.data as { eventId: string }).eventId === firstEventId)).toBe(false);
    expect(updateFrames).toHaveLength(1);
    expect((updateFrames[0]!.data as { eventId: string }).eventId).toBe(secondEventId);
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

  // Regression for the human hand-testing finding: `writeFrame` used to put
  // an `id:` line on EVERY frame, `ping` included. A browser `EventSource`
  // updates its `lastEventId` from any dispatched event carrying an `id`,
  // heartbeat or not — and `ping`'s minted cursor is never pushed into the
  // replay buffer (`StreamHub.mintCursor()`'s docstring), so a client whose
  // remembered cursor happened to be a ping's would answer every reconnect
  // with `resumed: false`, even though nothing was actually missed. This
  // test proves the fix from the client's own vantage point, exactly the
  // way the human found the bug: capture a REAL content frame's id, observe
  // a `ping` arriving after it has NO `id` at all, then reconnect with the
  // content frame's id and confirm the stream resumes.
  it('F: ping frames carry no id, and reconnecting with a real content frame\'s id still resumes (review finding, hand-tested)', async () => {
    const orderId = randomUUID();
    const codec = JSONCodec<Record<string, unknown>>();
    const publisherConnection = await nats.connect();

    // Destroyed unconditionally in `finally` below (review finding, this
    // change): a failed assertion mid-test used to leave the raw HTTP
    // socket open, which could stall this describe block's `afterAll`
    // (`testApp.close()`) waiting on it — burying the real assertion
    // failure under an unrelated 120s hook timeout.
    let firstReq: Awaited<ReturnType<typeof openSseConnection>>['req'] | undefined;
    let secondReq: Awaited<ReturnType<typeof openSseConnection>>['req'] | undefined;

    try {
      const { req, res } = await openSseConnection(port, token);
      firstReq = req;
      await collectUntil(res, (frames) => frames.some((f) => f.event === 'stream.ready'));

      publisherConnection.publish(
        `readmodel.order.updated.${orderId}`,
        codec.encode({ eventId: randomUUID(), orderId, status: 'confirmed', occurredAt: new Date().toISOString() }),
      );

      // Wait until a `ping` has arrived STRICTLY AFTER the content frame —
      // not merely "a ping was seen somewhere in the connection" — so the
      // assertion below is genuinely about a heartbeat the client received
      // once it already held a real, resumable cursor.
      const framesSoFar = await collectUntil(
        res,
        (frames) => {
          const contentIndex = frames.findIndex((f) => f.event === 'order.updated');
          if (contentIndex === -1) return false;
          return frames.slice(contentIndex + 1).some((f) => f.event === 'ping');
        },
        5000,
      );
      const contentIndex = framesSoFar.findIndex((f) => f.event === 'order.updated');
      const contentFrame = framesSoFar[contentIndex]!;
      const pingFrame = framesSoFar.slice(contentIndex + 1).find((f) => f.event === 'ping')!;

      expect(contentFrame.id).toBeDefined();
      expect(pingFrame.id).toBeUndefined();

      const contentCursor = contentFrame.id!;
      req.destroy();

      const second = await openSseConnection(port, token, '', contentCursor);
      secondReq = second.req;
      const readyFrames = await collectUntil(second.res, (frames) => frames.some((f) => f.event === 'stream.ready'));
      const ready = readyFrames.find((f) => f.event === 'stream.ready')!;
      expect((ready.data as { resumed: boolean }).resumed).toBe(true);

      second.req.destroy();
    } finally {
      firstReq?.destroy();
      secondReq?.destroy();
      await publisherConnection.close();
    }
  });
});
