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
//
// Pass 1's own Part 3 (saga_e2e_verification) generalized this file's
// build-then-spawn discipline into `spawn-real-service.ts` — a function
// any test can call for ANY named service, not only the projector. This
// file is now a thin, projector-specific WRAPPER over that generic
// function: same exported `spawnRealProjector`/`RealProjectorOptions`/
// `RealProjectorProcess` shape, so `stream-projector-e2e.integration.spec.ts`
// (feature 26, group E), its only caller, needed no change. The projector
// needs its own wrapper rather than a bare `spawnRealService` call at the
// call site because its readiness signal is NOT a stdout log line (like
// every other service's `[service] listening on port ...`) — `ServerKafka`
// never logs a line for "consumer group joined" — so this wrapper supplies
// the `'custom'` readiness strategy (`waitForConsumerGroupReady`) the
// generic function's `ServiceReadiness` union exists to support.
import { randomUUID } from 'node:crypto';
import { waitForConsumerGroupReady } from './kafka-test-fixture';
import { getFreePort, spawnRealService } from './spawn-real-service';

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

/**
 * Spawns the real projector, waits until its Kafka consumer group is
 * `Stable` with a joined member (`ServerKafka` appends `-server` to the
 * configured `groupId` unconditionally — same finding
 * `test-support/projector-app-test-harness.ts` records for the in-process
 * boot) — never a fixed `sleep`. Captured stdout/stderr are surfaced in the
 * rejection/failure message if the process exits before becoming ready, so a
 * broken boot is diagnosable rather than a bare timeout. Delegates the
 * actual build-then-spawn work to `spawnRealService` (Pass 1, Part 3).
 */
export async function spawnRealProjector(options: RealProjectorOptions): Promise<RealProjectorProcess> {
  const groupId = `gateway-e2e-projector-${randomUUID().slice(0, 8)}`;
  const port = await getFreePort();

  const env: NodeJS.ProcessEnv = {
    MONGO_HOST: options.mongoHost,
    MONGO_HOST_PORT: String(options.mongoPort),
    MONGO_DB_READMODEL: options.mongoDatabase,
    KAFKA_BROKERS: options.kafkaBrokers.join(','),
    PROJECTOR_KAFKA_CLIENT_ID: `otc-projector-e2e-${groupId}`,
    PROJECTOR_CONSUMER_GROUP: groupId,
    PROJECTOR_PORT: String(port),
    NATS_URL: options.natsUrl,
  };

  const process_ = await spawnRealService({
    serviceName: 'projector',
    env,
    readiness: { type: 'custom', check: () => waitForConsumerGroupReady(options.kafkaBrokers, `${groupId}-server`, 90_000, 300) },
  });

  return {
    groupId,
    stop: process_.stop,
  };
}
