// Boots the REAL, UNMODIFIED `apps/projector` service as a genuine child
// process — not an imported `AppModule` (gateway carries none of
// `@nestjs/microservices`, `kafkajs` or `apps/projector`'s own dependency
// graph, and importing another app's TypeScript source across app
// boundaries has no precedent anywhere in this repo; every service is an
// isolated package with its own dependencies). This is the only way
// `stream-projector-e2e.integration.spec.ts` (feature 26, group E) can prove
// the projector's OWN publication reaches a connected SSE client, rather
// than a fake standing in for it.
//
// Builds `apps/projector` with its own `tsc` (`tsc -p tsconfig.build.json`,
// the exact command `apps/projector`'s `build` script runs) and spawns
// `node dist/main.js` — the SAME artefact and the SAME runtime
// `pnpm dev:projector` restarts on every recompile (`package.json:7`:
// `tsc-watch --onSuccess "node dist/main.js"`) and the same one `pnpm start`
// runs directly. This is deliberately NOT `tsx`: `CLAUDE.md`'s DI-tokens
// rule records that `tsx` is esbuild-based and does not implement
// `emitDecoratorMetadata`, so a bare-typed constructor parameter resolves
// to `undefined` SILENTLY under it — the container still builds and the
// failure surfaces only at first use (`apps/orders/src/di-metadata-divergence.spec.ts`
// reproduces exactly this). Every service's `dev` script was moved off
// `tsx` for that reason; an E2E fixture that reintroduced it here would
// boot the projector on a path production never uses, and a green run
// against that path would be the same false assurance the DI-tokens rule
// exists to make impossible (review finding F1). A full projector build is
// ≈2.5 s against a ≈20 s test, so the cost of the production path is
// negligible. `dist/` is `.gitignore`d and not assumed fresh — this
// function rebuilds it on every call.
//
// Entirely through the same env vars its own `mongo.config.ts`/
// `kafka.config.ts`/`infrastructure/signal/nats.config.ts` already read —
// the identical "env-var driven, single source of truth" contract every
// service in this repo's own test harnesses rely on. No file under
// `apps/projector` is patched; its `src/` is read only by ITS OWN `tsc`.
import { randomUUID } from 'node:crypto';
import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { waitForConsumerGroupReady } from './kafka-test-fixture';

const PROJECTOR_DIR = path.resolve(__dirname, '../../../projector');
const TSC_BIN = path.join(PROJECTOR_DIR, 'node_modules', '.bin', 'tsc');
const PROJECTOR_MAIN = path.join(PROJECTOR_DIR, 'dist', 'main.js');

/**
 * Builds `apps/projector` with its own `tsc`, exactly as `pnpm --filter
 * @otc/projector build` (and, transitively, `tsc-watch --onSuccess`) does —
 * so `spawnRealProjector` starts the same `dist/main.js` production runs.
 * Throws with the captured compiler output if the build fails, rather than
 * spawning a stale or absent `dist/main.js`.
 */
function buildProjector(): void {
  const result = spawnSync(TSC_BIN, ['-p', 'tsconfig.build.json'], {
    cwd: PROJECTOR_DIR,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `spawnRealProjector: building apps/projector (tsc -p tsconfig.build.json) failed with exit code ${result.status}.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

export interface RealProjectorOptions {
  readonly mongoHost: string;
  readonly mongoPort: number;
  readonly mongoDatabase: string;
  readonly kafkaBrokers: readonly string[];
  readonly natsUrl: string;
}

export interface RealProjectorProcess {
  readonly groupId: string;
  stop(): Promise<void>;
}

/** A free TCP port on the loopback interface, for the projector's own (unused by this test) HTTP health listener — picked fresh per boot so parallel/sequential runs never collide on the repo's default `3006`. */
async function getFreePort(): Promise<number> {
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
 * Spawns the real projector, waits until its Kafka consumer group is
 * `Stable` with a joined member (`ServerKafka` appends `-server` to the
 * configured `groupId` unconditionally — same finding
 * `test-support/projector-app-test-harness.ts` records for the in-process
 * boot) — never a fixed `sleep`. Captured stdout/stderr are surfaced in the
 * rejection/failure message if the process exits before becoming ready, so a
 * broken boot is diagnosable rather than a bare timeout.
 */
export async function spawnRealProjector(options: RealProjectorOptions): Promise<RealProjectorProcess> {
  buildProjector();

  const groupId = `gateway-e2e-projector-${randomUUID().slice(0, 8)}`;
  const port = await getFreePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONGO_HOST: options.mongoHost,
    MONGO_HOST_PORT: String(options.mongoPort),
    MONGO_DB_READMODEL: options.mongoDatabase,
    KAFKA_BROKERS: options.kafkaBrokers.join(','),
    PROJECTOR_KAFKA_CLIENT_ID: `otc-projector-e2e-${groupId}`,
    PROJECTOR_CONSUMER_GROUP: groupId,
    PROJECTOR_PORT: String(port),
    NATS_URL: options.natsUrl,
  };

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [PROJECTOR_MAIN], {
    cwd: PROJECTOR_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));

  let exited = false;
  let exitInfo = '';
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = `exit code=${code} signal=${signal}`;
  });

  try {
    await Promise.race([
      waitForConsumerGroupReady(options.kafkaBrokers, `${groupId}-server`, 90_000, 300),
      new Promise((_resolve, reject) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            reject(new Error(`spawnRealProjector: process exited before becoming ready (${exitInfo}). Output:\n${output.join('')}`));
          }
        }, 200);
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error instanceof Error
      ? new Error(`${error.message}\nOutput so far:\n${output.join('')}`)
      : error;
  }

  return {
    groupId,
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
