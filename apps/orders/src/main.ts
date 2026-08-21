import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
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
  await app.startAllMicroservices();

  const port = Number(process.env.ORDERS_PORT ?? 3002);
  await app.listen(port);
  console.log(
    `[orders] listening on port ${port} (HTTP) and NATS (${natsConfig.servers.join(', ')})`,
  );
}

void bootstrap();
