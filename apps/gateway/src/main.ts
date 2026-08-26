// A5 (observability_reliability design.md §4.3/§6): OTel bootstrap FIRST,
// before every other import — `HttpInstrumentation` (this file's own
// import) must patch `http` before `@nestjs/platform-express` requires it.
import './infrastructure/observability/tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NatsConnection } from 'nats';
import { AppModule, NATS_CONNECTION } from './app.module';
import { NatsStreamSignalAdapter } from './infrastructure/messaging/nats-stream-signal.adapter';
import { setupDocs } from './presentation/setup-docs';
import { createValidationPipe } from './presentation/validation-pipe';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  app.useGlobalPipes(createValidationPipe());

  // `GET /docs` — unauthenticated (bypasses the global `JwtAuthGuard`
  // entirely: this is raw Express middleware, not a Nest-routed
  // controller, mounted before Nest's own router takes over).
  setupDocs(app);

  // The SSE signal subscription (Group D) starts once, at boot, over the
  // SAME outbound NATS connection the RPC client uses.
  const natsConnection = await app.get<NatsConnection>(NATS_CONNECTION);
  app.get(NatsStreamSignalAdapter).start();

  const port = Number(process.env.GATEWAY_PORT ?? 3001);
  await app.listen(port);
  console.log(`[gateway] listening on port ${port}, NATS (${natsConnection.getServer()}), docs at /docs`);
}

void bootstrap();
