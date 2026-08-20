import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.FULFILLMENT_PORT ?? 3003);
  await app.listen(port);
  console.log(`[fulfillment] listening on port ${port}`);
}

void bootstrap();
