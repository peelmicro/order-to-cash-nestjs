import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.ORDERS_PORT ?? 3002);
  await app.listen(port);
  console.log(`[orders] listening on port ${port}`);
}

void bootstrap();
