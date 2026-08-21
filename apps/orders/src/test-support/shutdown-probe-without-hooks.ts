// D2 probe (review_orders_acceptance.md): the OLD, pre-fix shape — identical
// to shutdown-probe-with-hooks.ts EXCEPT it never calls
// `app.enableShutdownHooks()`, exactly like `apps/orders/src/main.ts` before
// this fix. Used by `main-shutdown-hooks.spec.ts` to demonstrate the failure
// mode the fix closes: the same SIGTERM produces ZERO hook firings.
//
// Test-support only: excluded from the build artefact by
// tsconfig.build.json's `src/**/test-support/**` exclude (D5).
import 'reflect-metadata';
import { appendFileSync } from 'node:fs';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const LOG_PATH = process.argv[2];
if (!LOG_PATH) {
  throw new Error('shutdown-probe-without-hooks: expected the log file path as argv[2]');
}

@Injectable()
class ShutdownProbe implements OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void {
    // Never expected to fire; that is the point of this probe.
    appendFileSync(LOG_PATH, `SHUTDOWN_HOOK_FIRED:${signal ?? ''}\n`);
  }
}

@Module({ providers: [ShutdownProbe] })
class ProbeModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  // Deliberately NO app.enableShutdownHooks() call — reproduces the exact
  // defect D2 described.
  await app.listen(0);
  appendFileSync(LOG_PATH, 'PROBE_READY\n');
}

void main();
