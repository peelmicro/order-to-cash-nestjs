// Domain ↔ `@otc/contracts` parity — the domain owns `OrderStatus` and
// `CancellationReason` (design.md §3, open point 7), `@otc/contracts` is
// generated independently from `asyncapi.yaml`. This test turns "must track
// it, never the reverse" into a failing build the moment the two drift.
import { describe, expect, it } from 'vitest';
import type {
  CancellationReason as ContractsCancellationReason,
  OrderStatus as ContractsOrderStatus,
} from '@otc/contracts';
import { CANCELLATION_REASONS, isCancellationReason } from './order-cancellation-reason';
import { ORDER_STATUSES, isOrderStatus } from './order-status';

describe('OrderStatus — domain ↔ @otc/contracts parity', () => {
  it('every domain OrderStatus value is assignable to the generated contracts OrderStatus, and vice versa', () => {
    // Mutual assignability, proved at compile time: if either union grows
    // or shrinks relative to the other, one of these two assignments stops
    // compiling.
    const domainToContracts: (status: (typeof ORDER_STATUSES)[number]) => ContractsOrderStatus = (
      status,
    ) => status;
    const contractsToDomain: (status: ContractsOrderStatus) => (typeof ORDER_STATUSES)[number] = (
      status,
    ) => status;
    expect(typeof domainToContracts).toBe('function');
    expect(typeof contractsToDomain).toBe('function');
  });

  it('the domain ORDER_STATUSES value set equals the set of literals the generated OrderStatus union permits', () => {
    const contractsValues: ContractsOrderStatus[] = [
      'placed',
      'stock_reserved',
      'credit_approved',
      'confirmed',
      'despatched',
      'invoiced',
      'paid',
      'completed',
      'cancelled',
    ];
    expect([...ORDER_STATUSES].sort()).toEqual([...contractsValues].sort());
    for (const value of contractsValues) {
      expect(isOrderStatus(value)).toBe(true);
    }
  });

  it('rejects a status string outside the closed set', () => {
    expect(isOrderStatus('shipped')).toBe(false);
    expect(isOrderStatus('')).toBe(false);
    expect(isOrderStatus(undefined)).toBe(false);
  });
});

describe('CancellationReason — domain ↔ @otc/contracts parity', () => {
  it('every domain CancellationReason value is assignable to the generated contracts CancellationReason, and vice versa', () => {
    const domainToContracts: (
      reason: (typeof CANCELLATION_REASONS)[number],
    ) => ContractsCancellationReason = (reason) => reason;
    const contractsToDomain: (
      reason: ContractsCancellationReason,
    ) => (typeof CANCELLATION_REASONS)[number] = (reason) => reason;
    expect(typeof domainToContracts).toBe('function');
    expect(typeof contractsToDomain).toBe('function');
  });

  it('the domain CANCELLATION_REASONS value set equals the set of literals the generated CancellationReason union permits', () => {
    const contractsValues: ContractsCancellationReason[] = [
      'stock_rejected',
      'credit_rejected',
      'operator_cancelled',
    ];
    expect([...CANCELLATION_REASONS].sort()).toEqual([...contractsValues].sort());
    for (const value of contractsValues) {
      expect(isCancellationReason(value)).toBe(true);
    }
  });

  it('rejects a reason string outside the closed set', () => {
    expect(isCancellationReason('buyer_remorse')).toBe(false);
  });
});
