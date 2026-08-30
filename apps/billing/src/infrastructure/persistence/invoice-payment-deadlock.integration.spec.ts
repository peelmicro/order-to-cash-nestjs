// The genuine reproduction — real MySQL, real InnoDB, real lock contention
// — for the defect `progress/impl_observability_dashboards.md`'s "D1-D5"
// section found and `progress/impl_deadlock_retry.md` fixes: a MySQL
// deadlock (`ER_LOCK_DEADLOCK`) on the concurrent `payments` INSERT was
// falling through every `instanceof` branch in `rpc-error-mapper.ts` and
// surfacing as the generic `INTERNAL_ERROR`, never `CONFLICT`.
//
// This file carries TWO tests, deliberately different in kind:
//
// 1. The REALISTIC reproduction — many DISTINCT, already-issued invoices
//    (each its own retailer/company/credit line, so no two requests ever
//    contend on the SAME `credits` row or the SAME `invoices` row —
//    nothing to serialise there), all registering a payment with the exact
//    SAME `paymentReference`, fired concurrently in one `Promise.all`, at
//    the SAME 140-way concurrency N11's own decisive run used. The unique
//    index on `payments.payment_reference` guarantees exactly one winner;
//    the losers are what proves the fix. PROBABILISTIC, and confirmed so
//    in this feature's own verification pass: across 7 runs on this
//    machine (some under artificial 8-way CPU load, matching N11's own
//    escalation), this test's OWN traffic pattern did not cross into a
//    genuine `ER_LOCK_DEADLOCK` a single time — every loser took the
//    cheaper non-transactional fast-path conflict (N11's identity check)
//    before ever reaching the `payments` INSERT, because the winning
//    transaction (credit lock + invoice lock + two inserts) commits fast
//    enough, on this machine, that most concurrent siblings' own
//    `findPaymentByReference` pre-check does not even get scheduled until
//    after it has already committed. N11's original finding DID observe a
//    genuine `ER_LOCK_DEADLOCK` directly on this statement, escalating to
//    220+ trials across four runs to do so reliably — this test's
//    deterministic guarantee (below) does not depend on repeating that
//    exact escalation, but the test is left at N11's own scale, unchanged,
//    specifically so a future run on a different machine/load profile that
//    DOES cross into a genuine deadlock is exercising this fix, not a
//    smaller regime tuned to avoid ever finding one.
//
// 2. The DETERMINISTIC reproduction (below, second `it`) — an ENGINEERED
//    two-transaction crossed-lock-order deadlock, which InnoDB's
//    wait-for-graph detector reliably kills one side of by construction,
//    not by chance. This is what actually proves, on every run, that
//    `DrizzleUnitOfWork.execute` recovers from a REAL MySQL
//    `ER_LOCK_DEADLOCK` — confirmed 4/4 runs in this feature's
//    verification pass (a temporary diagnostic in `drizzle-unit-of-work.ts`,
//    added, exercised, then reverted byte-exact, logged the genuine
//    `causeCode= ER_LOCK_DEADLOCK` firing — see progress/impl_deadlock_retry.md).
//
// PROBABILISTIC VS DETERMINISTIC — read before relying on test 1 for
// anything stronger than what it actually guarantees. The single assertion
// test 1 enforces on EVERY run, deterministically, is: no reply among the
// losers is ever `INTERNAL_ERROR`. That holds whichever path a given loser
// actually took — the unique-index `ER_DUP_ENTRY` (no deadlock involved at
// all), `ER_LOCK_DEADLOCK`/`ER_LOCK_WAIT_TIMEOUT` retried into a subsequent
// `ER_DUP_ENTRY` (the fix under test, proven deterministically by test 2
// instead), or the non-transactional fast-path identity check (N11) — the
// mapper produces `CONFLICT` on every one of those, and test 1 cannot tell
// them apart from the RPC reply alone, nor does it need to.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentRegisterReplyPayload, RpcError } from '@otc/contracts';
import { PAYMENT_REGISTER_SUBJECT } from '../../presentation/invoice.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from '../../test-support/billing-integration-harness';
import { asDrizzleTx, DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { credits, invoiceItems } from './schema';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';

const CURRENCY = 'EUR';
// N11's own decisive run escalated to 70 pairs / 140 concurrent
// `billing.payment.register` calls to hit a genuine `ER_LOCK_DEADLOCK`
// reliably on the `payments` table — matched here, not scaled down, so
// this test exercises the SAME contention regime the finding was made
// under, not a smaller one that happens to still pass.
const CONCURRENT_REGISTRATIONS = 140;

function shortId(): string {
  return randomUUID().slice(0, 8);
}

// `OrderNumber`/`InvoiceReference` (@otc/shared-kernel business-reference.ts)
// both require the EXACT `PREFIX-######` shape (6 digits, no extra
// characters) — `Invoice.reconstitute` parses `invoiceReference` through
// it, so a loosely-shaped fixture value fails as a `DOMAIN_ERROR` before
// this test's own race is ever reached. A random base offset keeps
// concurrent runs of this file from colliding with each other's sequence
// numbers within one MySQL instance.
const REFERENCE_BASE = 100_000 + Math.floor(Math.random() * 800_000);

function sixDigits(i: number): string {
  return String(REFERENCE_BASE + i).padStart(6, '0');
}

function orderRef(i: number): string {
  return `ORD-${sixDigits(i)}`;
}

function invoiceRef(i: number): string {
  return `INV-${sixDigits(i)}`;
}

function isRpcError(value: unknown): value is RpcError {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isAccepted(value: unknown): value is PaymentRegisterReplyPayload {
  return typeof value === 'object' && value !== null && 'outcome' in value && (value as PaymentRegisterReplyPayload).outcome === 'accepted';
}

describe('billing.payment.register — concurrent same-paymentReference registrations against real MySQL never surface INTERNAL_ERROR (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it(
    `${CONCURRENT_REGISTRATIONS} concurrent billing.payment.register calls sharing one paymentReference across ${CONCURRENT_REGISTRATIONS} distinct invoices: exactly one accepted, every loser CONFLICT, zero INTERNAL_ERROR`,
    async () => {
      const paymentReference = `PAY-DL-${shortId()}`;

      // Fixtures pre-created SERIALLY (N11's own methodology) so every one
      // of the 140 payment-register RPCs below races the SAME instant,
      // rather than the fixture-creation itself being part of the race.
      const invoiceIds: string[] = [];
      for (let i = 0; i < CONCURRENT_REGISTRATIONS; i++) {
        const retailerCode = `RET-DL-${i}-${shortId()}`;
        const companyCode = `COM-DL-${i}-${shortId()}`;
        const orderReference = orderRef(i);
        await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
        const invoiceId = await harness.seedInvoice({
          orderReference,
          invoiceReference: invoiceRef(i),
          retailerCode,
          companyCode,
          currencyCode: CURRENCY,
          amount: 10_000,
          discount: 0,
          totalAmount: 10_000,
          status: 'issued',
        });
        // `Invoice.reconstitute` enforces B6 (stored `amount` reconciles
        // with the lines' own total) — the seeded invoice needs a real
        // line, not just an `invoices` row, for `markPaid` to reconstitute
        // without throwing before this test's own race is ever reached.
        const now = new Date(Math.floor(Date.now() / 1000) * 1000);
        await harness.db.insert(invoiceItems).values({
          id: randomUUID(),
          invoiceId,
          productCode: `PROD-DL-${i}`,
          units: 1,
          price: 10_000,
          createdAt: now,
          updatedAt: now,
        });
        invoiceIds.push(invoiceId);
      }

      const results = await Promise.all(
        invoiceIds.map((invoiceId) => {
          const correlationId = UniqueId.generate();
          const requestId = UniqueId.generate();
          return harness.requestBare<PaymentRegisterReplyPayload>(
            PAYMENT_REGISTER_SUBJECT,
            harness.paymentRequest({ invoiceId, paymentReference, amount: 10_000, currency: CURRENCY }),
            { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value },
          );
        }),
      );

      const accepted = results.filter(isAccepted);
      const rpcErrors = results.filter(isRpcError);
      const internalErrors = rpcErrors.filter((error) => error.code === 'INTERNAL_ERROR');
      const conflicts = rpcErrors.filter((error) => error.code === 'CONFLICT');

      // The load-bearing assertion — the literal defect this file
      // reproduces. Printing the codes on failure so a regression is
      // diagnosable from the test output alone, no re-run needed.
      expect(internalErrors, `expected zero INTERNAL_ERROR replies, got codes: ${rpcErrors.map((e) => e.code).join(', ')}`).toHaveLength(0);

      // The unique index on payment_reference guarantees exactly one
      // winner — deterministic regardless of HOW many attempts hit a
      // deadlock along the way.
      expect(accepted).toHaveLength(1);
      expect(conflicts).toHaveLength(CONCURRENT_REGISTRATIONS - 1);
      expect(accepted.length + rpcErrors.length).toBe(CONCURRENT_REGISTRATIONS);

      // Sanity: exactly one `payments` row exists anywhere for this
      // reference — the unique constraint held under the race, not just
      // the RPC-level count above.
      const paymentRowCounts = await Promise.all(
        invoiceIds.map(async (invoiceId) => (await harness.paymentsOf(invoiceId)).filter((row) => row.paymentReference === paymentReference).length),
      );
      const totalPaymentRows = paymentRowCounts.reduce((sum, count) => sum + count, 0);
      expect(totalPaymentRows).toBe(1);
    },
    180_000,
  );

  it(
    'DrizzleUnitOfWork.execute recovers from a GENUINE, ENGINEERED InnoDB deadlock (crossed lock order, two real concurrent transactions) — deterministic, not a race',
    async () => {
      // The concurrency test above reproduces the defect's REAL trigger
      // (contention this codebase's own traffic pattern creates) but
      // whether it actually crosses into a genuine ER_LOCK_DEADLOCK on any
      // given run depends on MySQL's own scheduling (see the file header).
      // This test does not wait for that to happen — it ENGINEERS it,
      // the textbook two-transaction crossed-lock-order recipe InnoDB's
      // wait-for-graph detector reliably kills one side of: transaction A
      // locks row 1 then wants row 2; transaction B locks row 2 then wants
      // row 1, with a barrier forcing both to hold their FIRST lock before
      // either attempts its SECOND — guaranteeing the cycle, not hoping
      // for it. This is the deterministic proof that the retry loop
      // recovers from a REAL MySQL deadlock, not a mocked one.
      const rowAId = await harness.seedCreditLine({ retailerCode: `RET-XL-A-${shortId()}`, companyCode: `COM-XL-A-${shortId()}`, creditLimit: 100_000, currencyCode: CURRENCY });
      const rowBId = await harness.seedCreditLine({ retailerCode: `RET-XL-B-${shortId()}`, companyCode: `COM-XL-B-${shortId()}`, creditLimit: 100_000, currencyCode: CURRENCY });

      function barrier(): { readonly promise: Promise<void>; readonly resolve: () => void } {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      }
      const aHasFirstLock = barrier();
      const bHasFirstLock = barrier();

      let attemptsA = 0;
      let attemptsB = 0;

      async function workA(tx: TransactionContext): Promise<void> {
        attemptsA++;
        const db = asDrizzleTx(tx);
        await db.update(credits).set({ creditLimit: 111_000 }).where(eq(credits.id, rowAId));
        aHasFirstLock.resolve();
        await bHasFirstLock.promise;
        // Blocks until B releases row B (commit or the deadlock kills A) —
        // this is the crossed wait.
        await db.update(credits).set({ creditLimit: 111_001 }).where(eq(credits.id, rowBId));
      }

      async function workB(tx: TransactionContext): Promise<void> {
        attemptsB++;
        const db = asDrizzleTx(tx);
        await db.update(credits).set({ creditLimit: 222_000 }).where(eq(credits.id, rowBId));
        bHasFirstLock.resolve();
        await aHasFirstLock.promise;
        await db.update(credits).set({ creditLimit: 222_001 }).where(eq(credits.id, rowAId));
      }

      const unitOfWork = new DrizzleUnitOfWork(harness.db);

      // Both settle successfully — whichever side InnoDB picks as the
      // deadlock victim is retried by `DrizzleUnitOfWork.execute` and
      // recovers; the OTHER side simply proceeds once the victim's
      // rollback releases the row it was waiting on.
      await expect(Promise.all([unitOfWork.execute(workA), unitOfWork.execute(workB)])).resolves.toBeDefined();

      // The genuine-deadlock proof: at least one side needed more than
      // one attempt. Without a real `ER_LOCK_DEADLOCK` firing, both would
      // settle at attempt 1 (nothing to recover from) and this would fail
      // — this is the assertion an implementer who deletes the retry
      // would break (see progress/impl_deadlock_retry.md's armed-mutation
      // record).
      expect(attemptsA + attemptsB, `expected at least one retried attempt (genuine deadlock), got attemptsA=${attemptsA} attemptsB=${attemptsB}`).toBeGreaterThan(2);

      // Both writes committed — a recovered deadlock is not a silent
      // partial write. Reads its OWN row directly by id (not through
      // `creditRowOf`, which is keyed on retailer/company, not id).
      // Each transaction writes BOTH rows atomically, so the final state is
      // whichever of the two transactions committed LAST — not a
      // predictable side (retry order is InnoDB's, not this test's), but
      // it must be exactly ONE of the two complete, self-consistent pairs,
      // never a mix (which would mean a lost/partial write).
      const [rowA] = await harness.db.select().from(credits).where(eq(credits.id, rowAId));
      const [rowB] = await harness.db.select().from(credits).where(eq(credits.id, rowBId));
      const committedAsA = rowA?.creditLimit === 111_000 && rowB?.creditLimit === 111_001;
      const committedAsB = rowA?.creditLimit === 222_001 && rowB?.creditLimit === 222_000;
      expect(
        committedAsA || committedAsB,
        `expected a self-consistent final state from whichever transaction committed last, got rowA=${rowA?.creditLimit} rowB=${rowB?.creditLimit}`,
      ).toBe(true);
    },
    60_000,
  );
});
