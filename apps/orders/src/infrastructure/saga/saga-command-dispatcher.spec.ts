// Pure unit — fake port + fake instant delay (CLAUDE.md § Testing
// conventions). Proves SO4's retry policy (3 attempts, 500ms-base
// exponential backoff), SO5's park transition, SO6 (business rejection
// marks sent, never retried), and the stale-hop no-op (design.md §5.5).
import { UniqueId, OrderNumber } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { SagaCommandStore, SagaCommandRecord } from '../../application/ports/saga-command-store.port';
import {
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandsPort,
} from '../../application/ports/saga-commands.port';
import { DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, SagaCommandDispatcher } from './saga-command-dispatcher';

function pendingRow(overrides: Partial<SagaCommandRecord> = {}): SagaCommandRecord {
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

function fakeStore(row: SagaCommandRecord | null): SagaCommandStore & {
  markSentCalls: UniqueId[];
  parkCalls: Array<{ id: UniqueId; attempts: number; lastError: string; nextAttemptAt: Date }>;
} {
  const markSentCalls: UniqueId[] = [];
  const parkCalls: Array<{ id: UniqueId; attempts: number; lastError: string; nextAttemptAt: Date }> = [];
  return {
    markSentCalls,
    parkCalls,
    async enqueue() {
      throw new Error('not used by this test');
    },
    async findByOrderAndCommand() {
      return row;
    },
    async claimDue() {
      throw new Error('not used by this test');
    },
    async markSent(id) {
      markSentCalls.push(id);
      return true;
    },
    async park(id, attempts, lastError, nextAttemptAt) {
      parkCalls.push({ id, attempts, lastError, nextAttemptAt });
      return true;
    },
  };
}

function fakePort(overrides: Partial<SagaCommandsPort> = {}): SagaCommandsPort {
  return {
    reserveStock: vi.fn(),
    releaseStock: vi.fn(),
    createDespatch: vi.fn(),
    holdCredit: vi.fn(),
    issueInvoice: vi.fn(),
    ...overrides,
  };
}

async function noDelay(): Promise<void> {}

describe('SagaCommandDispatcher — SO4 retry policy', () => {
  it('sends on the first attempt and marks the row sent', async () => {
    const row = pendingRow();
    const store = fakeStore(row);
    const reserveStock = vi.fn().mockResolvedValue({ outcome: 'accepted', orderReference: 'ORD-000001' });
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('sent');
    expect(reserveStock).toHaveBeenCalledTimes(1);
    expect(store.markSentCalls).toEqual([row.id]);
    expect(store.parkCalls).toHaveLength(0);
  });

  it('retries a timed-out command up to maxAttempts, with the configured backoff schedule, then sends on the last attempt', async () => {
    const row = pendingRow();
    const store = fakeStore(row);
    const delays: number[] = [];
    const delay = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    let calls = 0;
    const reserveStock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        throw new SagaCommandTimeoutError('fulfillment.stock.reserve', 5000);
      }
      return { outcome: 'accepted', orderReference: 'ORD-000001' };
    });
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, delay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('sent');
    expect(reserveStock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
    expect(store.markSentCalls).toEqual([row.id]);
  });

  it('parks the row after exhausting maxAttempts, with attempts and the last error recorded, and leaves nothing else mutated', async () => {
    const row = pendingRow();
    const store = fakeStore(row);
    const reserveStock = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'no responders'));
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('parked');
    expect(reserveStock).toHaveBeenCalledTimes(3);
    expect(store.markSentCalls).toHaveLength(0);
    expect(store.parkCalls).toHaveLength(1);
    expect(store.parkCalls[0]?.id).toEqual(row.id);
    expect(store.parkCalls[0]?.attempts).toBe(3);
    expect(store.parkCalls[0]?.lastError).toContain('no responders');
  });

  it('FS2 — passes the order id and the row id as correlation and request ids on every attempt, unchanged across retries', async () => {
    const row = pendingRow();
    const store = fakeStore(row);
    const seenMeta: Array<{ correlationId: unknown; requestId: unknown }> = [];
    let calls = 0;
    const reserveStock = vi.fn().mockImplementation(async (_payload, meta) => {
      calls += 1;
      seenMeta.push(meta);
      if (calls < 3) {
        throw new SagaCommandTimeoutError('fulfillment.stock.reserve', 5000);
      }
      return { outcome: 'accepted', orderReference: 'ORD-000001' };
    });
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('sent');
    expect(seenMeta).toHaveLength(3);
    for (const meta of seenMeta) {
      expect(meta.correlationId).toEqual(row.orderId);
      expect(meta.requestId).toEqual(row.id);
    }
  });

  it('SO6 — a business rejection resolves normally, is marked sent, and is never retried', async () => {
    const row = pendingRow({ command: 'credit.hold' });
    const store = fakeStore(row);
    const holdCredit = vi
      .fn()
      .mockResolvedValue({ outcome: 'rejected', orderReference: 'ORD-000001', currency: 'EUR', availableCredit: 0 });
    const dispatcher = new SagaCommandDispatcher(fakePort({ holdCredit }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'credit.hold');

    expect(outcome).toBe('sent');
    expect(holdCredit).toHaveBeenCalledTimes(1);
    expect(store.markSentCalls).toEqual([row.id]);
  });

  it('a stale hop (row already sent) is a silent no-op — no port call, no store write', async () => {
    const row = pendingRow({ status: 'sent' });
    const store = fakeStore(row);
    const reserveStock = vi.fn();
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('noop');
    expect(reserveStock).not.toHaveBeenCalled();
    expect(store.markSentCalls).toHaveLength(0);
    expect(store.parkCalls).toHaveLength(0);
  });

  it('an absent row (no pending/parked row for this order+command) is a silent no-op', async () => {
    const store = fakeStore(null);
    const reserveStock = vi.fn();
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(UniqueId.generate(), 'stock.reserve');

    expect(outcome).toBe('noop');
    expect(reserveStock).not.toHaveBeenCalled();
  });

  it('resumes a previously PARKED row — dispatch on a parked row can still send', async () => {
    const row = pendingRow({ status: 'parked', attempts: 3 });
    const store = fakeStore(row);
    const reserveStock = vi.fn().mockResolvedValue({ outcome: 'accepted', orderReference: 'ORD-000001' });
    const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('sent');
    expect(store.markSentCalls).toEqual([row.id]);
  });
});
