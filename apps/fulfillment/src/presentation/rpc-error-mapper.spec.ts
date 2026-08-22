// Pure unit — no NestJS, no I/O. Every mapped error class -> code; unknown
// -> INTERNAL_ERROR; a plain DomainError -> DOMAIN_ERROR with details.code.
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { ValidationError } from 'class-validator';
import {
  FactAggregateMismatchError,
  InsufficientStockError,
  ReservationTerminalError,
} from '../domain/stock-errors';
import {
  ConcurrentReservationChangeError,
  NoKnownStockItemError,
  UnknownStockItemError,
} from '../application/stock-application-errors';
import { NoReservedStockForDespatchError } from '../application/despatch-application-errors';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

describe('rpc-error-mapper — toRpcError', () => {
  it('NoKnownStockItemError -> NOT_FOUND', () => {
    const error = toRpcError(new NoKnownStockItemError('ORD-000001'));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('UnknownStockItemError -> NOT_FOUND with details.productCode', () => {
    const error = toRpcError(new UnknownStockItemError('COM-0001', 'PRD-9999'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toMatchObject({ productCode: 'PRD-9999' });
  });

  it('ReservationTerminalError -> PRECONDITION_FAILED with details.code', () => {
    const error = toRpcError(
      new ReservationTerminalError(UniqueId.generate(), 'consumed', 'release'),
    );
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toMatchObject({ code: 'RESERVATION_TERMINAL' });
  });

  it('ConcurrentReservationChangeError -> CONFLICT', () => {
    const error = toRpcError(new ConcurrentReservationChangeError('ORD-000001'));
    expect(error.code).toBe('CONFLICT');
  });

  it('NoReservedStockForDespatchError -> PRECONDITION_FAILED with details.orderReference (R36)', () => {
    const error = toRpcError(new NoReservedStockForDespatchError('ORD-000001'));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toMatchObject({ orderReference: 'ORD-000001' });
  });

  it('any other DomainError -> DOMAIN_ERROR with details.code', () => {
    const error = toRpcError(new InsufficientStockError('PRD-0001', 5, 2));
    expect(error.code).toBe('DOMAIN_ERROR');
    expect(error.details).toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const error2 = toRpcError(
      new FactAggregateMismatchError(UniqueId.generate(), UniqueId.generate()),
    );
    expect(error2.code).toBe('DOMAIN_ERROR');
    expect(error2.details).toMatchObject({ code: 'FACT_AGGREGATE_MISMATCH' });
  });

  it('anything else -> INTERNAL_ERROR', () => {
    expect(toRpcError(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(toRpcError('a plain string').code).toBe('INTERNAL_ERROR');
    expect(toRpcError(undefined).code).toBe('INTERNAL_ERROR');
  });
});

describe('rpc-error-mapper — validationRpcError', () => {
  it('flattens class-validator violations into one VALIDATION_FAILED message', () => {
    const violations: ValidationError[] = [
      {
        property: 'companyCode',
        constraints: { isString: 'companyCode must be a string' },
      } as ValidationError,
    ];

    const error = validationRpcError(violations);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('companyCode must be a string');
  });
});
