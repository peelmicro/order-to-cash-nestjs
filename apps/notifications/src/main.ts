import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.NOTIFICATIONS_PORT ?? 3005);
  await app.listen(port);
  console.log(`[notifications] listening on port ${port}`);
}

void bootstrap();
