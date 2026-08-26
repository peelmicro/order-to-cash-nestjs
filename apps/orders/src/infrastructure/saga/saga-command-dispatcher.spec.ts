// Pure unit — fake port + fake instant delay (CLAUDE.md § Testing
// conventions). Proves SO4's retry policy (3 attempts, 500ms-base
// exponential backoff), SO5's park transition, SO6 (business rejection
// marks sent, never retried), and the stale-hop no-op (design.md §5.5).
import { UniqueId, OrderNumber } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@otc/contracts';
import type { SagaCommandStore, SagaCommandRecord } from '../../application/ports/saga-command-store.port';
import {
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandsPort,
} from '../../application/ports/saga-commands.port';
import { DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, SagaCommandDispatcher, type HandlesFirstPark } from './saga-command-dispatcher';

function triggeringEnvelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-26T09:00:00.000Z',
    payload: {},
  } as unknown as Envelope;
}

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
    triggeringEventEnvelope: triggeringEnvelope(),
    triggeringEventTopic: 'otc.orders.facts.v1',
    status: 'pending',
    attempts: 0,
    deadLetteredAt: null,
    ...overrides,
  };
}

function fakeStore(
  row: SagaCommandRecord | null,
  options: { parkReturns?: boolean; claimDeadLetterReturns?: boolean } = {},
): SagaCommandStore & {
  markSentCalls: UniqueId[];
  parkCalls: Array<{ id: UniqueId; attempts: number; lastError: string; nextAttemptAt: Date }>;
  claimDeadLetterCalls: UniqueId[];
} {
  const markSentCalls: UniqueId[] = [];
  const parkCalls: Array<{ id: UniqueId; attempts: number; lastError: string; nextAttemptAt: Date }> = [];
  const claimDeadLetterCalls: UniqueId[] = [];
  return {
    markSentCalls,
    parkCalls,
    claimDeadLetterCalls,
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
      return options.parkReturns ?? true;
    },
    async claimDeadLetter(id) {
      claimDeadLetterCalls.push(id);
      return options.claimDeadLetterReturns ?? true;
    },
  };
}

function fakeFirstParkHandler(): HandlesFirstPark & { calls: Array<{ row: SagaCommandRecord; attempts: number; lastError: string }> } {
  const calls: Array<{ row: SagaCommandRecord; attempts: number; lastError: string }> = [];
  return {
    calls,
    async onFirstPark(row, context) {
      calls.push({ row, attempts: context.attempts, lastError: context.lastError });
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

// R29's dead-letter clause / OR3 (observability_reliability design.md §4.2)
describe('SagaCommandDispatcher — OR3 (the onFirstPark hook)', () => {
  it('calls onFirstPark exactly once, with the row and the accumulated attempts/lastError, when the row parks for the first time', async () => {
    const row = pendingRow();
    const store = fakeStore(row);
    const reserveStock = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'no responders'));
    const firstPark = fakeFirstParkHandler();
    const dispatcher = new SagaCommandDispatcher(
      fakePort({ reserveStock }),
      store,
      DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
      noDelay,
      undefined,
      firstPark,
    );

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('parked');
    expect(store.claimDeadLetterCalls).toEqual([row.id]);
    expect(firstPark.calls).toHaveLength(1);
    expect(firstPark.calls[0]?.row.id).toEqual(row.id);
    expect(firstPark.calls[0]?.attempts).toBe(3);
    expect(firstPark.calls[0]?.lastError).toContain('no responders');
  });

  it('does NOT call onFirstPark when claimDeadLetter reports the row already dead-lettered (a later re-park of the same row)', async () => {
    const row = pendingRow();
    const store = fakeStore(row, { claimDeadLetterReturns: false });
    const reserveStock = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'still down'));
    const firstPark = fakeFirstParkHandler();
    const dispatcher = new SagaCommandDispatcher(
      fakePort({ reserveStock }),
      store,
      DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
      noDelay,
      undefined,
      firstPark,
    );

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('parked');
    expect(store.claimDeadLetterCalls).toEqual([row.id]); // still claimed-attempted...
    expect(firstPark.calls).toHaveLength(0); // ...but never called, because the claim failed
  });

  it('does NOT call claimDeadLetter or onFirstPark when park() itself reports no transition (the row was already sent by a racing dispatcher)', async () => {
    const row = pendingRow();
    const store = fakeStore(row, { parkReturns: false });
    const reserveStock = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'no responders'));
    const firstPark = fakeFirstParkHandler();
    const dispatcher = new SagaCommandDispatcher(
      fakePort({ reserveStock }),
      store,
      DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
      noDelay,
      undefined,
      firstPark,
    );

    const outcome = await dispatcher.dispatch(row.orderId, 'stock.reserve');

    expect(outcome).toBe('parked');
    expect(store.claimDeadLetterCalls).toHaveLength(0);
    expect(firstPark.calls).toHaveLength(0);
  });
});
