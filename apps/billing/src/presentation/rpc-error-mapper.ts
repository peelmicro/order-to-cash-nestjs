// Translates every failure `credit.controller.ts` can observe — class-validator
// violations, the application-layer errors of `credit-application-errors.ts`,
// the domain errors of `domain/credit-errors.ts`, and anything unexpected —
// into the ONE wire shape `asyncapi.yaml`'s `RpcError` schema names
// (design.md §4.4). A pure function: no NestJS, no I/O, fully unit-testable
// on its own. Billing's OWN mapping — a different file with different cases
// from Orders'/Fulfillment's (the error vocabularies differ by service), not
// a parity-guarded copy.
//
// **A business rejection is never an `RpcError`.** An over-limit or
// adapter-refused hold resolves with `outcome: 'rejected'` and a `reason` —
// this mapper is never consulted on that path at all.
import type { ValidationError } from 'class-validator';
import { DomainError } from '@otc/shared-kernel';
import type { RpcError } from '@otc/contracts';
import { CreditReleaseUnderflowError, NoActiveHoldError } from '../domain/credit-errors';
import { CreditCurrencyMismatchError, CreditLineNotFoundError } from '../application/credit-application-errors';

function flattenViolations(violations: readonly ValidationError[]): string[] {
  return violations.flatMap((violation) => {
    const ownMessages = Object.values(violation.constraints ?? {});
    const nested = violation.children ? flattenViolations(violation.children) : [];
    return [...ownMessages, ...nested];
  });
}

export function validationRpcError(violations: readonly ValidationError[]): RpcError {
  return {
    code: 'VALIDATION_FAILED',
    message: flattenViolations(violations).join('; ') || 'request payload failed validation',
    occurredAt: new Date().toISOString(),
  };
}

export function toRpcError(error: unknown): RpcError {
  const occurredAt = new Date().toISOString();

  if (error instanceof CreditLineNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message: error.message,
      details: { retailerCode: error.retailerCode, companyCode: error.companyCode },
      occurredAt,
    };
  }
  if (error instanceof CreditCurrencyMismatchError) {
    return {
      code: 'VALIDATION_FAILED',
      message: error.message,
      details: { expected: error.expected, received: error.received },
      occurredAt,
    };
  }
  if (error instanceof CreditReleaseUnderflowError || error instanceof NoActiveHoldError) {
    return {
      code: 'PRECONDITION_FAILED',
      message: error.message,
      details: { code: error.code },
      occurredAt,
    };
  }
  if (error instanceof DomainError) {
    // Billing's remaining domain refusals (CreditLimitExceededError,
    // CreditRefusalMismatchError, InvalidBuyerCreditSnapshotError,
    // FactAggregateMismatchError) are programming-error guards, not client
    // input — DOMAIN_ERROR, the same vocabulary Fulfillment's mapper uses
    // for its own remaining domain refusals (design.md §4.4).
    return {
      code: 'DOMAIN_ERROR',
      message: error.message,
      details: { code: error.code },
      occurredAt,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'an unexpected error occurred',
    occurredAt,
  };
}
