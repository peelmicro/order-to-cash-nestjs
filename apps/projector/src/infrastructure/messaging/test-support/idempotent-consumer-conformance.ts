// COPY OF — apps/orders/src/infrastructure/messaging/test-support/idempotent-consumer-conformance.ts
//
// VERBATIM copy per that file's own header ("A future documented variant
// (projector, feature 24) is expected to copy THIS file..."). If you are
// editing this file, edit the canonical and re-copy; never fork it here.
//
// The behavioural conformance suite EVERY implementation of the
// idempotent-consumer pattern (design.md §6, specs/shared/requirements.md
// R17/R18) must pass, whatever its backing store — MySQL (the canonical and
// its byte-identical copies, §6.3) or a documented variant (e.g. the
// projector's MongoDB ledger, feature 24).
//
// Exists to close N5 (progress/review_notifications_service.md): the old
// `idempotent-consumer.parity.spec.ts` (OI12) variant branch read only the
// leading `//` banner and asserted two substrings — it never imported a
// class, never read a body, executed no behaviour. A reviewer proved it by
// replacing a service's entire `runOnce` with a body performing NO
// deduplication at all, leaving the banner untouched: OI12 passed 4/4.
//
// This file is deliberately generic — it knows nothing about MySQL, Mongo,
// Drizzle or any service. It is handed a harness (a factory for fresh
// instances of the implementation under test, sharing one backing store)
// and asserts five behaviours any conforming implementation must exhibit.
// It is invoked from `idempotent-consumer.parity.spec.ts` against a
// Docker-free reference implementation (so the fast `pnpm quality` gate
// stays Docker-independent, per that file's own design constraint) and
// from `idempotent-consumer.parity.integration.spec.ts` against the REAL
// canonical `IdempotentConsumer` over Testcontainers MySQL.
//
// A future documented variant (projector, feature 24) is expected to copy
// THIS file the same way §6.3 has services copy `idempotent-consumer.ts`
// itself, and to point its own integration spec at it — see
// `idempotent-consumer.parity.spec.ts`'s case 4, which requires a variant's
// banner to name an existing behavioural-conformance spec file.
import { describe, expect, it, vi } from 'vitest';

export type ConformanceOutcome = 'processed' | 'duplicate';

/**
 * The minimal shape every implementation of the pattern must expose. The
 * real `IdempotentConsumer.runOnce` also threads a `TransactionContext`
 * through to `work` (R17 — same transaction) — that parameter is erased
 * here on purpose: a variant backed by a document store may have no SQL
 * transaction at all (§6.3), and this suite must stay meaningful for it.
 * Callers adapt their concrete `runOnce` to this shape (see both spec
 * files' `toConformable` helpers).
 */
export interface ConformableIdempotentConsumer {
  runOnce(eventId: string, consumer: string, work: () => Promise<void>): Promise<ConformanceOutcome>;
}

export interface IdempotentConsumerConformanceHarness {
  /**
   * Constructs a genuinely FRESH instance of the implementation under
   * test — never the same JS object twice — but every instance must talk
   * to the SAME underlying backing store. A durable store (MySQL, Mongo, a
   * file on disk) makes a fresh instance see prior work; a purely
   * in-memory implementation that keeps its ledger in a per-instance field
   * cannot, and fails case 3 below. That is the single most valuable
   * assertion in this suite — it is the one that would have caught N1
   * (progress/review_notifications_service.md), a real, live-caught defect
   * of exactly this shape.
   */
  createConsumer(): ConformableIdempotentConsumer | Promise<ConformableIdempotentConsumer>;
  /** A fresh, collision-free eventId per call — usually `randomUUID()`. */
  newEventId(): string;
}

/**
 * Registers the conformance suite as a `describe` block. `label` identifies
 * the implementation under test in the vitest output (e.g. "the canonical
 * IdempotentConsumer over Testcontainers MySQL", "the file-backed reference
 * variant").
 */
export function describeIdempotentConsumerConformance(
  label: string,
  harness: IdempotentConsumerConformanceHarness,
): void {
  describe(`idempotent-consumer behavioural conformance — ${label}`, () => {
    it('a first call for an unseen (eventId, consumer) pair runs the work and reports processed', async () => {
      const consumer = await harness.createConsumer();
      const work = vi.fn(async () => {});

      const outcome = await consumer.runOnce(harness.newEventId(), 'orders.saga', work);

      expect(outcome).toBe('processed');
      expect(work).toHaveBeenCalledTimes(1);
    });

    it('a second call for the same (eventId, consumer) pair does NOT run the work and reports duplicate', async () => {
      const consumer = await harness.createConsumer();
      const eventId = harness.newEventId();
      const work = vi.fn(async () => {});

      const first = await consumer.runOnce(eventId, 'orders.saga', work);
      const second = await consumer.runOnce(eventId, 'orders.saga', work);

      expect(first).toBe('processed');
      expect(second).toBe('duplicate');
      expect(work).toHaveBeenCalledTimes(1); // NOT invoked a second time
    });

    it(
      'a consumer constructed fresh over the SAME backing store still returns duplicate — ' +
        'a purely in-memory implementation must fail this',
      async () => {
        const eventId = harness.newEventId();
        const first = await harness.createConsumer();
        await first.runOnce(eventId, 'orders.saga', async () => {});

        const second = await harness.createConsumer(); // fresh instance, same store
        const work = vi.fn(async () => {});
        const outcome = await second.runOnce(eventId, 'orders.saga', work);

        expect(outcome).toBe('duplicate');
        expect(work).toHaveBeenCalledTimes(0);
      },
    );

    it('two different eventIds both run', async () => {
      const consumer = await harness.createConsumer();
      const workA = vi.fn(async () => {});
      const workB = vi.fn(async () => {});

      const outcomeA = await consumer.runOnce(harness.newEventId(), 'orders.saga', workA);
      const outcomeB = await consumer.runOnce(harness.newEventId(), 'orders.saga', workB);

      expect(outcomeA).toBe('processed');
      expect(outcomeB).toBe('processed');
      expect(workA).toHaveBeenCalledTimes(1);
      expect(workB).toHaveBeenCalledTimes(1);
    });

    it('the same eventId under a DIFFERENT consumer name runs — the key is the pair, not the id alone (R17)', async () => {
      const consumer = await harness.createConsumer();
      const eventId = harness.newEventId();
      const workA = vi.fn(async () => {});
      const workB = vi.fn(async () => {});

      const outcomeA = await consumer.runOnce(eventId, 'orders.saga', workA);
      const outcomeB = await consumer.runOnce(eventId, 'projector', workB);

      expect(outcomeA).toBe('processed');
      expect(outcomeB).toBe('processed');
      expect(workA).toHaveBeenCalledTimes(1);
      expect(workB).toHaveBeenCalledTimes(1);

      // The redelivery guard still holds per pair.
      const redelivery = await consumer.runOnce(eventId, 'orders.saga', workA);
      expect(redelivery).toBe('duplicate');
      expect(workA).toHaveBeenCalledTimes(1);
    });
  });
}
