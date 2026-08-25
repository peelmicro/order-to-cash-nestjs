import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { loadNatsConfig } from './infrastructure/messaging/nats.config';
import { BareJsonNatsDeserializer } from './infrastructure/messaging/bare-json-nats.deserializer';
import { BareJsonNatsSerializer } from './infrastructure/messaging/bare-json-nats.serializer';

/**
 * G6 (progress/review_gateway_rest_auth.md, Round 3, H2's cheap half) — the
 * NATS `connectMicroservice` options for the `orders.create` responder,
 * EXPORTED rather than left as an inline literal, so that
 * `orders-create-wire.integration.spec.ts` can IMPORT this function instead
 * of hand-mirroring the pair it installs. Before this export existed, the
 * spec restated `deserializer: new BareJsonNatsDeserializer()` /
 * `serializer: new BareJsonNatsSerializer()` itself — a second, independent
 * copy that could silently drift from what `bootstrap()` actually installs
 * (exactly the shape of trap F1 was: a hand-mirrored spec agreeing with
 * itself, not with production). Only `servers`/`user`/`pass` remain
 * parameterised, because those genuinely differ between a Testcontainers
 * NATS instance and `loadNatsConfig()`'s runtime servers; the
 * (de)serializer pair — the part F1 was actually about — is fixed inside
 * this function and therefore identical in both callers by construction.
 */
export interface OrdersNatsConnectionOptions {
  servers?: string | string[];
  user?: string;
  pass?: string;
}

export function createOrdersNatsMicroserviceOptions(
  connection: OrdersNatsConnectionOptions,
): MicroserviceOptions {
  return {
    transport: Transport.NATS,
    options: {
      ...connection,
      deserializer: new BareJsonNatsDeserializer(),
      serializer: new BareJsonNatsSerializer(),
    },
  };
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // D2 (review_orders_acceptance.md): `onApplicationShutdown` only ever
  // fires from `app.close()`, and only `enableShutdownHooks()` wires
  // process signals (SIGTERM/SIGINT) to that call. Without this line,
  // `NatsConnectionCloser` (app.module.ts) AND `OutboxRelayService`'s
  // graceful drain (outbox-relay.service.ts, feature 14) are both
  // permanently inert — a container stop could kill the process mid-cycle.
  app.enableShutdownHooks();

  // Hybrid app (orders_acceptance): the existing HTTP port stays for
  // health/metrics; NATS core (no JetStream) is added as a second,
  // in-process transport for the `orders.create` RPC responder
  // (@MessagePattern, orders-create.controller.ts).
  //
  // F1 (progress/review_gateway_rest_auth.md): the bare-JSON (de)serializer
  // pair — same as apps/fulfillment/src/main.ts and apps/billing/src/main.ts
  // already install — is what lets a Nest-served NATS handler answer a raw
  // `nats` bare-JSON caller (the Gateway's `NatsRpcClientAdapter`, and the
  // saga's own `NatsSagaCommandsAdapter` shape) at all. Without it, Nest's
  // default `NatsRequestJSONDeserializer` sees an id-less request and routes
  // it through `ServerNats.handleEvent` — the handler runs (the order is
  // placed and its outbox row written) but the reply subject is never
  // answered, so the caller times out and retries, placing a SECOND real
  // order. Verified against a disposable NATS container by the reviewer of
  // gateway_rest_auth; reproduced here in
  // orders-create-wire.integration.spec.ts (armed: removing this pair makes
  // that spec's bare-JSON case fail with a timeout, never a reply).
  const natsConfig = loadNatsConfig();
  app.connectMicroservice<MicroserviceOptions>(
    createOrdersNatsMicroserviceOptions({ servers: [...natsConfig.servers] }),
  );

  // The saga orchestrator's Kafka consumer (order_saga_orchestrator design.md
  // §3.1) — a SECOND, independent microservice transport, client id
  // `otc-orders-saga` (distinct from the outbox relay's own producer,
  // `otc-orders`, kafka.config.ts). Consumer group `orders.saga` —
  // deliberately identical to the `ConsumerName` used in `processed_events`
  // (idempotent-consumer.ts), so the broker-side identity and the
  // dedup-ledger identity of "the orchestrator" are the same string.
  //
  // `fromBeginning: true` (SO1): a first boot with no committed offsets
  // must read facts already in the topics — this is what makes the
  // live-stack behaviour of design.md §8.2 happen at all.
  //
  // Task E3 finding (verified against the installed `@nestjs/microservices`
  // ^11.2.1, `apps/orders/src/saga-consumption.integration.spec.ts`):
  // `ServerKafka.handleEvent` awaits the `@EventPattern` handler with NO
  // try/catch — `onProcessingStartHook` is `(transportId, context, done) =>
  // done()`, a direct pass-through. A rejection therefore propagates
  // straight out of kafkajs's `eachMessage` callback, so kafkajs itself
  // does NOT commit the offset and redelivers on the next poll — exactly
  // the at-least-once semantics §3.1 requires. No `KafkaRetriableException`
  // wrapping is needed for this installed version; it exists in the code
  // only as a documented fallback should a future upgrade change this.
  const kafkaConfig = loadKafkaConfig();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: 'otc-orders-saga', brokers: [...kafkaConfig.brokers] },
      consumer: { groupId: 'orders.saga', sessionTimeout: 30000 },
      subscribe: { fromBeginning: true },
      run: { partitionsConsumedConcurrently: 1 },
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.ORDERS_PORT ?? 3002);
  await app.listen(port);
  console.log(
    `[orders] listening on port ${port} (HTTP) and NATS (${natsConfig.servers.join(', ')})`,
  );
}

// G6's export means this module can now be `import`ed (not just executed)
// by orders-create-wire.integration.spec.ts for
// createOrdersNatsMicroserviceOptions alone — guarded so that import does
// NOT also boot the whole app (AppModule's providers open a real MySQL
// connection at construction time, which the spec's own Testcontainers
// MySQL is not standing in for). `require.main === module` is true only
// when this file is executed directly (`node dist/main.js`), never on
// import from another module — verified in this repo's `type: "commonjs"`
// package (apps/orders/package.json), which is why this guard, not an
// import.meta.url ESM equivalent, is correct here.
if (require.main === module) {
  void bootstrap();
}
