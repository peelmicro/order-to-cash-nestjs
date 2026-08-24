import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { loadKafkaConfig } from './infrastructure/messaging/kafka.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // `onApplicationShutdown` only ever fires from `app.close()`, and only
  // `enableShutdownHooks()` wires process signals (SIGTERM/SIGINT) to that
  // call — same finding as every other service's main.ts in this repo.
  app.enableShutdownHooks();

  // Hybrid app: the HTTP port stays for health; ONE Kafka microservice
  // transport consumes all three fact topics
  // (notification-facts.controller.ts) — NO NATS transport (this service
  // answers no RPC) and NO second Kafka transport for anything else (this
  // service emits no fact and has no outbox — feature 23's scope).
  //
  // N3 (notifications_service re-review) — `fromBeginning: false`,
  // DELIBERATELY the opposite choice from Orders' saga consumer
  // (apps/orders/src/main.ts's `fromBeginning: true`). The two services are
  // not the same kind of consumer: the saga orchestrator MUST replay
  // history on a fresh consumer group, because it owns the order state
  // machine and an order that predates the orchestrator still has to reach
  // `completed`/`cancelled` (SO1). Notifications owns no aggregate and no
  // state machine (domain-model.md §6) — a fact never notified is simply a
  // fact about an order that gets no extra notification, which is the
  // correct default for a "tell a human about something new" service, not
  // a correctness violation. With `fromBeginning: true` here, a brand-new
  // consumer group (a deliberate `NOTIFICATIONS_CONSUMER_GROUP` change, a
  // Kafka volume reset, a first-ever deploy against topics that already
  // carry months of history) would re-send a real email for every
  // historical order the moment this service starts — exactly what
  // happened live against real Kafka and real Mailtrap credentials before
  // this fix (see progress/impl_notifications_service.md's N3 entry for the
  // corrected account of that incident). The durable `processed_events`
  // ledger (N1/N2) prevents a DUPLICATE send for a fact this service has
  // already processed, but it cannot prevent a FIRST send for a fact this
  // service has genuinely never seen before — `fromBeginning: false` is
  // what keeps "never seen before" meaning "genuinely new", not "existed
  // before this consumer group did".
  const kafkaConfig = loadKafkaConfig();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: kafkaConfig.clientId, brokers: [...kafkaConfig.brokers] },
      consumer: { groupId: kafkaConfig.groupId, sessionTimeout: 30000 },
      subscribe: { fromBeginning: false },
      run: { partitionsConsumedConcurrently: 1 },
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.NOTIFICATIONS_PORT ?? 3005);
  await app.listen(port);
  console.log(
    `[notifications] listening on port ${port} (HTTP) and Kafka (${kafkaConfig.brokers.join(', ')})`,
  );
}

void bootstrap();
