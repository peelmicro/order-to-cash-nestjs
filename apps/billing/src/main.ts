import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { loadNatsConfig } from './infrastructure/messaging/nats.config';
import { BareJsonNatsDeserializer } from './infrastructure/messaging/bare-json-nats.deserializer';
import { BareJsonNatsSerializer } from './infrastructure/messaging/bare-json-nats.serializer';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // `onApplicationShutdown` only ever fires from `app.close()`, and only
  // `enableShutdownHooks()` wires process signals (SIGTERM/SIGINT) to that
  // call — without this, `OutboxRelayService`'s graceful drain would be
  // permanently inert (same finding as apps/orders'/apps/fulfillment's
  // main.ts).
  app.enableShutdownHooks();

  // Hybrid app: the existing HTTP port stays for health; ONE NATS
  // microservice transport is added for the two `billing.credit.*`
  // responders (design.md §4.1, §8) — NO Kafka consumer transport, because
  // Billing consumes no fact in this feature (saga.md §5). The bare-JSON
  // (de)serializer pair (design.md §4.3) is what lets a Nest-served NATS
  // handler answer a raw `nats` caller (Orders' `nats-saga-commands.adapter.ts`)
  // in the exact wire shape `asyncapi.yaml` documents, instead of the
  // framework's default Nest packet.
  const natsConfig = loadNatsConfig();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.NATS,
    options: {
      servers: [...natsConfig.servers],
      deserializer: new BareJsonNatsDeserializer(),
      serializer: new BareJsonNatsSerializer(),
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.BILLING_PORT ?? 3004);
  await app.listen(port);
  console.log(`[billing] listening on port ${port} (HTTP) and NATS (${natsConfig.servers.join(', ')})`);
}

void bootstrap();
