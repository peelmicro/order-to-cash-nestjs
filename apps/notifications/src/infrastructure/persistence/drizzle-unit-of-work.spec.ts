// Pure unit: a fake `db.transaction` that throws on command — no Docker,
// no real MySQL. Proves the retry LOOP works in isolation; the genuine
// concurrent-deadlock scenario is proven separately, against real MySQL, by
// apps/billing/src/infrastructure/persistence/invoice-payment-deadlock.integration.spec.ts
// (see progress/impl_deadlock_retry.md).
import { describe, expect, it, vi } from 'vitest';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import type { NotificationsDb } from './client';

function driverError(code: string, message: string): Error {
  const error = new Error(message) as Error & { cause: { code: string } };
  error.cause = { code };
  return error;
}

function deadlockError(): Error {
  return driverError('ER_LOCK_DEADLOCK', 'Deadlock found when trying to get lock; try restarting transaction');
}

function lockWaitTimeoutError(): Error {
  return driverError('ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded; try restarting transaction');
}

function duplicateEntryError(): Error {
  return driverError('ER_DUP_ENTRY', "Duplicate entry 'PAY-1' for key 'payments.uq_payments_payment_reference'");
}

/** A fake `NotificationsDb` exposing only the `.transaction` method `DrizzleUnitOfWork` calls. */
function fakeDb(transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>): NotificationsDb {
  return { transaction } as unknown as NotificationsDb;
}

describe('DrizzleUnitOfWork — retry on transient InnoDB lock contention', () => {
  it('retries the whole unit of work once on ER_LOCK_DEADLOCK, then succeeds', async () => {
    let transactionCalls = 0;
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      transactionCalls++;
      if (transactionCalls === 1) {
        throw deadlockError();
      }
      return work({});
    });
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));
    const work = vi.fn(async () => 'ok');

    await expect(unitOfWork.execute(work)).resolves.toBe('ok');

    // `db.transaction` was entered twice (the failed attempt, the retry);
    // `work` itself only ran on the attempt that actually reached it —
    // this is the "retry the WHOLE unit of work" design, not a wrapper
    // that re-invokes `work` directly while reusing the failed transaction.
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries on ER_LOCK_WAIT_TIMEOUT the same way as ER_LOCK_DEADLOCK — same contention class, same response', async () => {
    let transactionCalls = 0;
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      transactionCalls++;
      if (transactionCalls === 1) {
        throw lockWaitTimeoutError();
      }
      return work({});
    });
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));

    await expect(unitOfWork.execute(async () => 'ok')).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('never retries ER_DUP_ENTRY — a permanent conflict must surface immediately, not hang behind a retry loop', async () => {
    const permanentConflict = duplicateEntryError();
    const transaction = vi.fn(async () => {
      throw permanentConflict;
    });
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));

    await expect(unitOfWork.execute(async () => 'unused')).rejects.toBe(permanentConflict);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('is bounded — gives up after MAX_ATTEMPTS and rethrows the ORIGINAL last error unchanged, not something vaguer', async () => {
    const persistentDeadlock = deadlockError();
    const transaction = vi.fn(async () => {
      throw persistentDeadlock;
    });
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));

    await expect(unitOfWork.execute(async () => 'unused')).rejects.toBe(persistentDeadlock);
    // Bounded: a genuine, permanent hot-spot must not turn into an outage —
    // the exact attempt count is an implementation detail (see the file's
    // own MAX_ATTEMPTS), but it must be small and finite.
    expect(transaction.mock.calls.length).toBeGreaterThan(1);
    expect(transaction.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('an error with no MySQL driver cause code at all is never treated as retryable', async () => {
    const genericError = new Error('boom');
    const transaction = vi.fn(async () => {
      throw genericError;
    });
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));

    await expect(unitOfWork.execute(async () => 'unused')).rejects.toBe(genericError);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('commits without any retry when the callback simply succeeds', async () => {
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({}));
    const unitOfWork = new DrizzleUnitOfWork(fakeDb(transaction));

    await expect(unitOfWork.execute(async () => 'ok')).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
