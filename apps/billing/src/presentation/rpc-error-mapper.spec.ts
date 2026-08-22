// Pure unit — every mapped error class -> its RpcError code; unknown ->
// INTERNAL_ERROR; a business rejection is never an RpcError (design.md
// §4.4).
import { describe, expect, it } from 'vitest';
import type { ValidationError } from 'class-validator';
import { UniqueId } from '@otc/shared-kernel';
import {
  CreditLimitExceededError,
  CreditRefusalMismatchError,
  CreditReleaseUnderflowError,
  FactAggregateMismatchError,
  InvalidBuyerCreditSnapshotError,
  NoActiveHoldError,
} from '../domain/credit-errors';
import { CreditCurrencyMismatchError, CreditLineNotFoundError } from '../application/credit-application-errors';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

describe('rpc-error-mapper — validation', () => {
  it('validationRpcError flattens class-validator violations into VALIDATION_FAILED', () => {
    const violations = [{ property: 'orderReference', constraints: { matches: 'orderReference must match /^ORD-\\d{6}$/' } }] as unknown as ValidationError[];

    const error = validationRpcError(violations);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('orderReference must match');
  });
});

describe('rpc-error-mapper — toRpcError, every mapped class', () => {
  it('CreditLineNotFoundError -> NOT_FOUND naming the pair (BC3)', () => {
    const error = toRpcError(new CreditLineNotFoundError('AldiDe', 'ALBIONFOODS'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ retailerCode: 'AldiDe', companyCode: 'ALBIONFOODS' });
  });

  it('CreditCurrencyMismatchError -> VALIDATION_FAILED naming expected/received (BC4)', () => {
    const error = toRpcError(new CreditCurrencyMismatchError('EUR', 'GBP'));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ expected: 'EUR', received: 'GBP' });
  });

  it('CreditReleaseUnderflowError -> PRECONDITION_FAILED naming the code', () => {
    const error = toRpcError(new CreditReleaseUnderflowError('ORD-000001', -100));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual({ code: 'CREDIT_RELEASE_UNDERFLOW' });
  });

  it('NoActiveHoldError -> PRECONDITION_FAILED naming the code', () => {
    const error = toRpcError(new NoActiveHoldError('ORD-000001'));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual({ code: 'NO_ACTIVE_HOLD' });
  });

  it('any other DomainError -> DOMAIN_ERROR naming the code', () => {
    expect(toRpcError(new CreditLimitExceededError(1_000, 500)).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new CreditRefusalMismatchError('over_limit')).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new InvalidBuyerCreditSnapshotError('bad')).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new FactAggregateMismatchError(UniqueId.generate(), UniqueId.generate())).code).toBe('DOMAIN_ERROR');
  });

  it('anything else -> INTERNAL_ERROR', () => {
    expect(toRpcError(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(toRpcError('a string is not even an Error').code).toBe('INTERNAL_ERROR');
  });
});

describe('rpc-error-mapper — a business rejection is never an RpcError', () => {
  it('has no bespoke case for a rejected CreditHoldReplyPayload shape — it is not an Error, so it falls through to INTERNAL_ERROR rather than being mistaken for one of the mapped refusals', () => {
    // `credit.controller.ts` only calls `toRpcError` in its catch block,
    // and `CreditHoldHandler.hold` never throws for a business rejection
    // (`refuseHold` resolves normally, the reply carries `outcome:
    // 'rejected'`) — so a value shaped like that reply reaching this
    // mapper at all would be a bug elsewhere, and this mapper has no
    // special-cased vocabulary that would silently "recognise" it.
    const rejectedReplyShape = { outcome: 'rejected', reason: 'over_limit' };

    const error = toRpcError(rejectedReplyShape);

    expect(error.code).toBe('INTERNAL_ERROR');
  });
});
