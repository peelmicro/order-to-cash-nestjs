// saga_e2e_verification, Pass 1, Part 3 — proves the GENERALIZED
// `spawnRealService` helper (`test-support/spawn-real-service.ts`) actually
// works, before Pass 2 builds on it to spawn multiple, possibly all six,
// real services simultaneously for a genuine end-to-end saga run. NOT
// Pass 2's real composed-stack test — this is only proof of the helper
// itself: builds and boots TWO real, unmodified services
// (`apps/fulfillment`, `apps/billing` — the two cheapest to stand up from
// `apps/gateway`, needing only a real NATS broker at boot; see the inline
// comments below for exactly why MySQL/Kafka do not need to be reachable
// for this particular proof), confirms each reaches its own
// `[service] listening on port ...` log line (the 'log' readiness
// strategy — the pathway `spawn-real-projector.ts`'s existing 'custom'
// Kafka-consumer-group strategy does NOT exercise), and confirms both tear
// down cleanly with no orphaned process.
//
// Real NATS (Testcontainers, `open-nats-test-fixture.ts` — the auth-free
// fixture built specifically so a SPAWNED, unmodified service's own
// `NATS_URL`-driven connection can reach it with no credentials the
// process's own env has no way to inject — see that file's own header for
// the full "nats 2.29.3 never parses user:pass out of a server URL"
// finding). MySQL/Kafka are deliberately left unreachable-but-unused:
// both services' `app.module.ts` builds their MySQL pool/Kafka client
// LAZILY (no query/connect at construction time), and `OUTBOX_RELAY_ENABLED
// =false` stops `OutboxRelayService.onApplicationBootstrap` from ever
// scheduling the poll cycle that would be the first thing to actually
// touch either — verified by reading both `outbox-relay.service.ts` (its
// `onApplicationBootstrap` returns immediately when `config.enabled` is
// false) and both `app.module.ts` files (no `OnApplicationBootstrap`/
// `onModuleInit` hook queries MySQL or connects to Kafka eagerly). This
// keeps the smoke test to exactly what it claims to prove — the spawn
// mechanism — without silently depending on more infrastructure than that.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, spawnRealService, type RealServiceProcess } from './test-support/spawn-real-service';
import { startOpenNatsTestFixture, type OpenNatsTestFixture } from './test-support/open-nats-test-fixture';

/** `process.kill(pid, 0)` sends no signal — it only tests whether the process still exists (throws ESRCH if not). This is the "no orphaned process" proof: a real OS-level check, not merely trusting `stop()`'s own promise resolved. */
function processStillExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnRealService — the generalized spawn-real-* helper (Testcontainers: nats:2.14.5-alpine, auth-free)', () => {
  let natsFixture: OpenNatsTestFixture;

  beforeAll(async () => {
    natsFixture = await startOpenNatsTestFixture();
  }, 120_000);

  afterAll(async () => {
    await natsFixture?.teardown();
  }, 60_000);

  it(
    'builds and spawns two real, unmodified services (fulfillment, billing) from their own dist/main.js, each reaching its own "listening on port" log line, then tears both down with no orphaned process',
    async () => {
      const [fulfillmentPort, billingPort] = await Promise.all([getFreePort(), getFreePort()]);

      let fulfillment: RealServiceProcess | undefined;
      let billing: RealServiceProcess | undefined;

      try {
        [fulfillment, billing] = await Promise.all([
          spawnRealService({
            serviceName: 'fulfillment',
            env: {
              FULFILLMENT_PORT: String(fulfillmentPort),
              NATS_URL: natsFixture.url,
              // Deliberately unreachable/default — never touched, see this
              // file's own header comment.
              FULFILLMENT_DB_HOST: 'localhost',
              MYSQL_HOST_PORT: '1', // a port nothing listens on
              KAFKA_BROKERS: 'localhost:1',
              OUTBOX_RELAY_ENABLED: 'false',
            },
            readiness: { type: 'log', pattern: /\[fulfillment\] listening on port/ },
          }),
          spawnRealService({
            serviceName: 'billing',
            env: {
              BILLING_PORT: String(billingPort),
              NATS_URL: natsFixture.url,
              BILLING_DB_HOST: 'localhost',
              MYSQL_HOST_PORT: '1',
              KAFKA_BROKERS: 'localhost:1',
              OUTBOX_RELAY_ENABLED: 'false',
            },
            readiness: { type: 'log', pattern: /\[billing\] listening on port/ },
          }),
        ]);

        expect(fulfillment.serviceName).toBe('fulfillment');
        expect(billing.serviceName).toBe('billing');
        // Two genuinely distinct OS processes.
        expect(fulfillment.pid).not.toBe(billing.pid);
        expect(processStillExists(fulfillment.pid)).toBe(true);
        expect(processStillExists(billing.pid)).toBe(true);

        expect(fulfillment.output()).toMatch(new RegExp(`\\[fulfillment\\] listening on port ${fulfillmentPort}`));
        expect(billing.output()).toMatch(new RegExp(`\\[billing\\] listening on port ${billingPort}`));
      } finally {
        await Promise.all([fulfillment?.stop(), billing?.stop()]);
      }

      // Terminal, monotonic evidence, not a bare sleep: `stop()`'s own
      // promise resolves only once the child's `exit` event fires
      // (`spawn-real-service.ts`), so by the time we get here the OS has
      // already reaped both — `process.kill(pid, 0)` must now throw ESRCH.
      expect(processStillExists(fulfillment!.pid)).toBe(false);
      expect(processStillExists(billing!.pid)).toBe(false);
    },
    120_000,
  );
});
