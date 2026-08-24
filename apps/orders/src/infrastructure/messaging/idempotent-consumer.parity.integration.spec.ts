// OI12 — the behavioural half of the parity guard (design.md §6.4, N5
// amendment, progress/review_notifications_service.md). The Docker-free
// `idempotent-consumer.parity.spec.ts` proves the per-service copies are
// byte-identical to the canonical AND that the generic conformance suite
// (`idempotent-consumer-conformance.ts`) is real and non-vacuous — but it
// cannot exercise the actual canonical `IdempotentConsumer` class without a
// database, and design.md §6.4 fixes `pnpm quality` to stay Docker-free.
//
// This file is the other half: it imports the REAL canonical
// `IdempotentConsumer` and runs it, over Testcontainers MySQL, through the
// exact same generic suite. Composed with the parity spec's byte-identity
// case (every 'mysql-copy' app's `idempotent-consumer.ts` +
// `processed-events.repository.ts` is byte-identical to this file's
// subject, post-banner), this is what turns OI12 from "these files match"
// into "these files match AND the pattern actually works" for every
// 'mysql-copy' service (fulfillment, billing, notifications today) without
// this repo's test-per-service-database boundary (CLAUDE.md § Database per
// service) needing to be crossed: proving the canonical behaves correctly,
// plus proving the copies are byte-identical to it, together prove the
// copies behave correctly too.
//
// Run via `pnpm --filter @otc/orders test:integration` (root alias `pnpm
// test:integration`) — outside `pnpm quality`'s fast gate, same as every
// other Testcontainers spec in this app.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import type { ConsumerName } from '../../application/ports/consumer-name';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { startOrdersTestFixture, type OrdersTestFixture } from '../persistence/test-support/orders-test-fixture';
import { IdempotentConsumer } from './idempotent-consumer';
import {
  describeIdempotentConsumerConformance,
  type ConformableIdempotentConsumer,
} from './test-support/idempotent-consumer-conformance';

describe('idempotent-consumer.parity — OI12, the canonical over real MySQL (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;
  const clock = new FakeClock(new Date('2026-08-24T09:00:00.000Z'));

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  function toConformable(real: IdempotentConsumer): ConformableIdempotentConsumer {
    return {
      runOnce: (eventId, consumer, work) => real.runOnce(eventId, consumer as ConsumerName, () => work()),
    };
  }

  describeIdempotentConsumerConformance('the canonical IdempotentConsumer over real MySQL', {
    createConsumer: () => toConformable(new IdempotentConsumer(new DrizzleUnitOfWork(fixture.db), clock)),
    newEventId: () => randomUUID(),
  });
});
