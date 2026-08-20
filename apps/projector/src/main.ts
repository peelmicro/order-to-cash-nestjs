import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PROJECTOR_PORT ?? 3006);
  await app.listen(port);
  console.log(`[projector] listening on port ${port}`);
}

void bootstrap();
