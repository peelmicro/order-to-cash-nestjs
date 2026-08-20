import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.BILLING_PORT ?? 3004);
  await app.listen(port);
  console.log(`[billing] listening on port ${port}`);
}

void bootstrap();
