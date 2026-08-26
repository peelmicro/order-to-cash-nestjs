// Group E — the seam feature 24's review recorded as owed (finding N4: the
// `gateway → orders → Kafka → projector → NATS` chain was never walked in
// one run) narrowed to what feature 26 actually owns: `Kafka fact → REAL
// projector → NATS signal → gateway SSE client`. Every OTHER stream spec in
// this service (`stream.integration.spec.ts`) publishes directly onto
// `readmodel.order.updated.*`/`readmodel.timeline.appended.*` — exactly the
// subjects the projector's own publisher uses — which proves the gateway's
// HALF of the wire but never proves the projector actually produces that
// wire from a real fact. This spec is the one place in the repo that boots
// the real, unmodified `apps/projector` service (as a genuine child
// process — see `test-support/spawn-real-projector.ts`'s header for why not
// an imported `AppModule`) against real Kafka, real MongoDB and real NATS,
// and asserts a fact this spec produces on Kafka arrives at a real,
// connected SSE client having passed through the actual projector.
//
// The `orders → Kafka` leg (the outbox relay actually publishing
// `order.placed.v1`) is proven elsewhere (`outbox_and_idempotency`,
// `orders_acceptance`) and is out of this feature's scope — this spec picks
// up the chain at "a fact exists on the topic", the same seam
// `apps/projector`'s own integration specs (`timeline-projection.integration.spec.ts`
// etc.) start from.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Envelope, OrderPlacedPayload } from '@otc/contracts';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startOpenNatsTestFixture, type OpenNatsTestFixture } from './test-support/open-nats-test-fixture';
import { createTopic, publishFact, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';
import { spawnRealProjector, type RealProjectorProcess } from './test-support/spawn-real-projector';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import type { NatsTestFixture } from './test-support/nats-test-fixture';
import { collectUntil, openSseConnection } from './test-support/sse-test-client';

// Copied literally from apps/projector/src/infrastructure/messaging/kafka.config.ts
// (out of scope to import cross-app — see this repo's convention of small,
// guarded literal copies, e.g. apps/notifications' and apps/billing's own
// kafka.config.ts). `kafka.config.spec.ts` in THAT service is what guards
// drift between this literal and asyncapi.yaml; nothing here re-guards it.
const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';
const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';

function orderPlacedEnvelope(orderId: string): Envelope {
  const payload: OrderPlacedPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RETAILER01',
    companyCode: 'COMPANY01',
    buyerGln: '1234567890128',
    supplierGln: '1234567890128',
    currency: 'USD',
    orderDate: new Date().toISOString(),
    lines: [{ productCode: 'P1', quantity: 2, unitPrice: 1000, lineDiscount: 0 }],
    initialAmount: 2000,
    initialDiscount: 0,
    totalAmount: 2000,
  };
  return {
    eventId: randomUUID(),
    eventType: 'order.placed.v1',
    aggregateId: orderId,
    correlationId: orderId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: payload as unknown as Record<string, never>,
  };
}

describe('SSE stream × the REAL projector — group E (R55 seam, review N4)', () => {
  let mongo: StandaloneMongoTestFixture;
  let kafka: KafkaTestFixture;
  let nats: OpenNatsTestFixture;
  let projector: RealProjectorProcess;
  let testApp: GatewayTestApp;
  let token: string;
  let port: number;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    kafka = await startKafkaTestFixture();
    await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
    await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);
    nats = await startOpenNatsTestFixture();

    const dbName = mongo.db().databaseName;
    projector = await spawnRealProjector({
      mongoHost: mongo.host,
      mongoPort: mongo.port,
      mongoDatabase: dbName,
      kafkaBrokers: kafka.brokers,
      natsUrl: nats.url,
    });

    // `bootGatewayTestApp`'s parameter type is `NatsTestFixture`
    // (`@testcontainers/nats`'s own `StartedNatsContainer`) purely because
    // every OTHER caller in this repo happens to use that fixture; it only
    // ever calls `.connect()` on what is passed in, which `OpenNatsTestFixture`
    // implements identically. See `open-nats-test-fixture.ts`'s header for
    // why THIS spec cannot use `@testcontainers/nats` itself.
    testApp = await bootGatewayTestApp(mongo, nats as unknown as NatsTestFixture, dbName);
    await testApp.app.listen(0);
    port = (testApp.app.getHttpServer().address() as { port: number }).port;

    const login = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    token = login.body.accessToken;
  }, 240_000);

  // Tolerates a half-torn-down world (review finding F5): if the `it` above
  // fails, several of `projector`/`testApp`/`nats`/`kafka`/`mongo` may
  // already be in a broken state (the projector's own child process may
  // have exited, the app's NATS/Kafka clients may be mid-error). Letting
  // ONE step's teardown throw used to abort the rest AND surface as a
  // second, unrelated failure report that buried the real assertion/timeout
  // message. Every step now runs regardless of the others' outcome, and a
  // teardown failure is logged rather than re-thrown, so `afterAll` itself
  // never manufactures a failure that competes with the test's own.
  afterAll(async () => {
    const steps: ReadonlyArray<readonly [string, () => Promise<unknown> | undefined]> = [
      ['projector.stop', () => projector?.stop()],
      ['testApp.close', () => testApp?.close()],
      ['nats.teardown', () => nats?.teardown()],
      ['kafka.teardown', () => kafka?.teardown()],
      ['mongo.teardown', () => mongo?.teardown()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        console.error(`stream-projector-e2e afterAll: "${name}" failed during teardown (continuing with the remaining steps; this is logged, not thrown, so it cannot bury a real test failure — see review finding F5):`, error);
      }
    }
  }, 60_000);

  it(
    'a fact published on the real orders facts topic, consumed by the REAL projector, arrives at a connected SSE client as order.updated and timeline.appended',
    async () => {
      const orderId = randomUUID();
      const envelope = orderPlacedEnvelope(orderId);

      // Subscribe BEFORE producing — terminal evidence, no sleep (same
      // discipline design.md §10 rule 1 requires of every spec in this
      // family).
      const { req, res } = await openSseConnection(port, token, `?orderId=${orderId}`);
      await collectUntil(res, (frames) => frames.some((f) => f.event === 'stream.ready'));

      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, envelope);

      const frames = await collectUntil(
        res,
        (collected) => collected.some((f) => f.event === 'order.updated') && collected.some((f) => f.event === 'timeline.appended'),
        90_000,
      );
      req.destroy();

      const update = frames.find((f) => f.event === 'order.updated')!;
      const timeline = frames.find((f) => f.event === 'timeline.appended')!;

      expect((update.data as { orderId: string; eventId: string; status: string }).orderId).toBe(orderId);
      expect((update.data as { eventId: string }).eventId).toBe(envelope.eventId);
      expect((update.data as { status: string }).status).toBe('placed');

      expect((timeline.data as { orderId: string; eventType: string }).orderId).toBe(orderId);
      expect((timeline.data as { eventType: string }).eventType).toBe('order.placed.v1');
    },
    120_000,
  );
});
