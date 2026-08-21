// D2 probe (review_orders_acceptance.md): the minimal reproduction of
// main.ts's fixed shape — `NestFactory.create` + `app.enableShutdownHooks()`
// + a provider implementing `OnApplicationShutdown`. Spawned as a real
// child process by `main-shutdown-hooks.spec.ts`, which sends it a genuine
// SIGTERM and asserts the hook actually ran, so this is proved by process
// behaviour, not by mocking Nest's lifecycle internals.
//
// Test-support only: excluded from the build artefact by
// tsconfig.build.json's `src/**/test-support/**` exclude (D5).
import 'reflect-metadata';
import { appendFileSync } from 'node:fs';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

// A file, not stdout: `process.kill(pid, signal)` re-delivered by Nest's
// own shutdown cleanup (nest-application-context.js) can terminate this
// process before an async pipe-backed stdout write flushes, silently
// dropping the line. `appendFileSync` is synchronous regardless of the
// destination, so nothing can race it.
const LOG_PATH = process.argv[2];
if (!LOG_PATH) {
  throw new Error('shutdown-probe-with-hooks: expected the log file path as argv[2]');
}

@Injectable()
class ShutdownProbe implements OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void {
    appendFileSync(LOG_PATH, `SHUTDOWN_HOOK_FIRED:${signal ?? ''}\n`);
  }
}

@Module({ providers: [ShutdownProbe] })
class ProbeModule {}

process.prependOnceListener('SIGTERM', () => appendFileSync(LOG_PATH, 'SIGTERM_RECEIVED\n'));

async function main(): Promise<void> {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  app.enableShutdownHooks();
  // An ephemeral HTTP listener, exactly like main.ts's `app.listen(port)` —
  // without an open handle the process would exit on its own the instant
  // `main()` resolves, never leaving a window to receive a signal at all.
  await app.listen(0);
  appendFileSync(LOG_PATH, 'PROBE_READY\n');
}

void main();
