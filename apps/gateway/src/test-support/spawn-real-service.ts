// Generalized `spawn-real-*` pattern (saga_e2e_verification, Pass 1, Part
// 3) — the SAME "build with the app's own `tsc`, spawn the real
// `dist/main.js`, inspect the build's exit status so a failed build cannot
// silently proceed against a stale `dist/`" discipline
// `spawn-real-projector.ts` (feature 26, group F1) established for the
// projector specifically, widened here into a function any test can call
// for ANY named service under `apps/*` — Pass 2 (this feature's own next
// pass) needs to spawn multiple, possibly all six, real services
// (Orders, Fulfillment, Billing, Notifications, Projector, Gateway)
// simultaneously to drive a genuine end-to-end saga, and `spawn-real-
// projector.ts` was hard-coded to one service and one readiness strategy
// (a Kafka consumer-group poll) that does not generalize to a service with
// no Kafka consumer (Fulfillment, Billing, Gateway all have none).
//
// Lives under `apps/gateway/src/test-support/` — NOT a new `packages/`
// entry (CLAUDE.md restricts shared RUNTIME code to `shared-kernel`/
// `contracts`; this is test-only code, never imported by any service's own
// `src/`, but a new package is still unjustified for one helper reachable
// from a single caller today). Every existing `spawn-real-*`-shaped file
// in this repo already lives inside the CALLING service's own
// `test-support/`, never a cross-app shared location (no service imports
// another service's `src/` anywhere in this monorepo — `spawn-real-
// projector.ts`'s own header comment). Gateway is that caller today (the
// only service that spawns another service's real process, for its SSE
// E2E spec) and stays the natural home for Pass 2's own composed-stack
// test, so widening this file IN PLACE, rather than inventing a new
// shared test-support location nothing yet needs, is the smaller, more
// conservative move — revisit only if a Pass 2 caller genuinely outside
// `apps/gateway` needs this same helper.
//
// Deliberately NOT `tsx`: `CLAUDE.md`'s DI-tokens rule records that `tsx`
// is esbuild-based and does not implement `emitDecoratorMetadata`, so a
// bare-typed constructor parameter resolves to `undefined` SILENTLY under
// it (`apps/orders/src/di-metadata-divergence.spec.ts` reproduces exactly
// this) — every service's own `dev`/`build`/`start` script already avoids
// it for that reason, and a spawn helper that reintroduced it would boot
// every service on a path production never uses.
import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** A free TCP port on the loopback interface — picked fresh per boot so parallel/sequential spawns of the same service never collide on its repo-default port. Moved here (Pass 1, Part 3) from `spawn-real-projector.ts`, which had its own private copy; now shared by every `spawnRealService` caller. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('getFreePort: no address assigned'));
        return;
      }
      const { port } = address;
      server.close((closeError) => (closeError ? reject(closeError) : resolve(port)));
    });
  });
}

/**
 * How `spawnRealService` decides the child process is ready to receive
 * traffic. Two shapes, matching the two readiness signals this repo's
 * services actually expose:
 *  - `'log'`: every service's own `main.ts` prints a `[service] listening
 *    on port ...` line (the literal convention every service's own
 *    main.ts already follows) — the default, general-purpose case.
 *  - `'custom'`: a caller-supplied async check for a service whose
 *    readiness is NOT visible on stdout at all — e.g. the projector's own
 *    Kafka consumer-group-`Stable` poll (`spawn-real-projector.ts`, which
 *    `ServerKafka` never logs a line for).
 */
export type ServiceReadiness =
  | { readonly type: 'log'; readonly pattern: RegExp; readonly timeoutMs?: number }
  | { readonly type: 'custom'; readonly check: () => Promise<void> };

export interface SpawnRealServiceOptions {
  /** The directory name under `apps/` — `'orders'`, `'fulfillment'`, `'billing'`, `'notifications'`, `'projector'`, `'gateway'`. */
  readonly serviceName: string;
  /** Merged OVER `process.env` (never replaces it) — every value the target service's own `main.ts`/`app.module.ts` reads via its own `load*Config()` functions, exactly the shape `spawn-real-projector.ts`'s own `RealProjectorOptions` already established for the projector alone. */
  readonly env: NodeJS.ProcessEnv;
  readonly readiness: ServiceReadiness;
}

export interface RealServiceProcess {
  readonly serviceName: string;
  readonly pid: number;
  /** A snapshot of everything captured on stdout+stderr so far — for a caller's own diagnostics, or a readiness assertion against the literal log line. */
  output(): string;
  stop(): Promise<void>;
}

function appDir(serviceName: string): string {
  return path.resolve(__dirname, '../../../', serviceName);
}

/**
 * Builds `apps/<serviceName>` with its own `tsc`, exactly as `pnpm
 * --filter @otc/<serviceName> build` (and, transitively, `tsc-watch
 * --onSuccess`) does — so `spawnRealService` starts the same `dist/main.js`
 * production runs. Throws with the captured compiler output if the build
 * fails, rather than spawning a stale or absent `dist/main.js` — the exact
 * guard `spawn-real-projector.ts`'s own `buildProjector()` established,
 * unchanged here except for the service name becoming a parameter.
 */
function buildService(serviceName: string): void {
  const dir = appDir(serviceName);
  const tscBin = path.join(dir, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(tscBin, ['-p', 'tsconfig.build.json'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `spawnRealService: building apps/${serviceName} (tsc -p tsconfig.build.json) failed with exit code ${result.status}.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function waitForReadiness(readiness: ServiceReadiness, output: () => string, serviceName: string): Promise<void> {
  if (readiness.type === 'custom') {
    return readiness.check();
  }
  const { pattern, timeoutMs = 60_000 } = readiness;
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (pattern.test(output())) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`spawnRealService(${serviceName}): readiness pattern ${String(pattern)} not observed within ${timeoutMs}ms`));
      }
    }, 200);
  });
}

/**
 * Builds and spawns the REAL, UNMODIFIED `apps/<serviceName>` — `node
 * dist/main.js`, the same artefact and runtime every service's own
 * `pnpm start`/`tsc-watch --onSuccess` restarts, never `tsx` (see this
 * file's own header comment). Waits for `options.readiness`, racing
 * against the process exiting first (a broken boot is diagnosable via the
 * captured output in the rejection message, never a bare timeout) — the
 * same race `spawn-real-projector.ts` already established, generalized to
 * any readiness strategy rather than one hard-coded Kafka poll.
 */
export async function spawnRealService(options: SpawnRealServiceOptions): Promise<RealServiceProcess> {
  const dir = appDir(options.serviceName);
  buildService(options.serviceName);
  const main = path.join(dir, 'dist', 'main.js');

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [main], {
    cwd: dir,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const output = (): string => chunks.join('');

  let exited = false;
  let exitInfo = '';
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = `exit code=${code} signal=${signal}`;
  });

  try {
    await Promise.race([
      waitForReadiness(options.readiness, output, options.serviceName),
      new Promise((_resolve, reject) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            reject(
              new Error(
                `spawnRealService(${options.serviceName}): process exited before becoming ready (${exitInfo}). Output:\n${output()}`,
              ),
            );
          }
        }, 200);
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error instanceof Error ? new Error(`${error.message}\nOutput so far:\n${output()}`) : error;
  }

  return {
    serviceName: options.serviceName,
    pid: child.pid!,
    output,
    async stop(): Promise<void> {
      if (exited) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 5_000);
      });
    },
  };
}
