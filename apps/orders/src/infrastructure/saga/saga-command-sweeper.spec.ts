// No-overlap self-scheduling (OutboxRelay spec pattern) + claim -> dispatch
// -> reschedule (design.md §6.4). Pure unit: fake timers, fakes for
// `UnitOfWork`, `SagaCommandStore`, the dispatcher and `Clock` — no Docker.
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../application/ports/clock.port';
import type { SagaCommandRecord, SagaCommandStore } from '../../application/ports/saga-command-store.port';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { DispatchesSagaCommands } from './saga-command-dispatcher';
import { SagaCommandSweeperService, type SagaCommandSweeperConfig } from './saga-command-sweeper.service';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeUnitOfWork(): UnitOfWork {
  return {
    async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return work({} as TransactionContext);
    },
  };
}

function row(overrides: Partial<SagaCommandRecord> = {}): SagaCommandRecord {
  return {
    id: UniqueId.generate(),
    orderId: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    command: 'stock.reserve',
    payload: {
      orderReference: 'ORD-000001',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      lines: [{ productCode: 'PRD-0001', units: 1 }],
    },
    triggeringEventId: UniqueId.generate(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

function config(overrides: Partial<SagaCommandSweeperConfig> = {}): SagaCommandSweeperConfig {
  return { enabled: true, intervalMs: 100, pendingGraceMs: 10_000, batchLimit: 100, ...overrides };
}

const fixedClock: Clock = { now: () => new Date('2026-08-20T10:00:00.000Z') };

describe('SagaCommandSweeperService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never starts a second sweep cycle while one is still in progress', async () => {
    const claim = deferred<readonly SagaCommandRecord[]>();
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn(() => claim.promise),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn().mockResolvedValue('sent') };
    const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.claimDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.claimDue).toHaveBeenCalledTimes(1);

    claim.resolve([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.claimDue).toHaveBeenCalledTimes(2);

    await service.onApplicationShutdown();
  });

  it('claims due rows in one transaction, then dispatches each claimed row OUTSIDE it, directly (not via any bus)', async () => {
    const claimed = [row({ command: 'stock.reserve' }), row({ command: 'credit.hold' })];
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn().mockResolvedValue(claimed),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatch = vi.fn().mockResolvedValue('sent');
    const dispatcher: DispatchesSagaCommands = { dispatch };
    const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    // Allow the async dispatch loop (after the claim transaction resolves) to run.
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, claimed[0]?.orderId, 'stock.reserve');
    expect(dispatch).toHaveBeenNthCalledWith(2, claimed[1]?.orderId, 'credit.hold');

    await service.onApplicationShutdown();
  });

  it('passes the pending grace and a batch limit through to claimDue', async () => {
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn().mockResolvedValue([]),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn() };
    const service = new SagaCommandSweeperService(
      fakeUnitOfWork(),
      store,
      dispatcher,
      fixedClock,
      config({ pendingGraceMs: 15_000, batchLimit: 25 }),
    );

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.claimDue).toHaveBeenCalledWith(expect.anything(), fixedClock.now(), 25, { pendingGraceMs: 15_000 });

    await service.onApplicationShutdown();
  });

  it('does not start any cycle when SAGA_SWEEPER_ENABLED is false', async () => {
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn().mockResolvedValue([]),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn() };
    const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config({ enabled: false }));

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.claimDue).not.toHaveBeenCalled();
    await service.onApplicationShutdown();
  });

  it('a dispatch that throws for one claimed row does not stop the others from being dispatched', async () => {
    const claimed = [row({ command: 'stock.reserve' }), row({ command: 'credit.hold' })];
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn().mockResolvedValue(claimed),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatch = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('sent');
    const dispatcher: DispatchesSagaCommands = { dispatch };
    const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatch).toHaveBeenCalledTimes(2);

    await service.onApplicationShutdown();
  });

  it('clears the pending timer and awaits the in-flight cycle on shutdown, starting no further cycle', async () => {
    const claim = deferred<readonly SagaCommandRecord[]>();
    const store: SagaCommandStore = {
      async enqueue() {
        return 'enqueued' as const;
      },
      async findByOrderAndCommand() {
        return null;
      },
      claimDue: vi.fn(() => claim.promise),
      async markSent() {
        return true;
      },
      async park() {
        return true;
      },
    };
    const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn().mockResolvedValue('sent') };
    const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.claimDue).toHaveBeenCalledTimes(1);

    const shutdown = service.onApplicationShutdown();
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    claim.resolve([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
    expect(store.claimDue).toHaveBeenCalledTimes(1);
  });
});
