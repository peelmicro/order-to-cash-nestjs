import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { loadNatsConfig } from './infrastructure/messaging/nats.config';

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
  const natsConfig = loadNatsConfig();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.NATS,
    options: { servers: [...natsConfig.servers] },
  });

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

void bootstrap();
