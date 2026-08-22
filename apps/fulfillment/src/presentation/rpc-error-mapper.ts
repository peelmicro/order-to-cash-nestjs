// Translates every failure `stock.controller.ts` can observe — class-validator
// violations, the application-layer errors of `stock-application-errors.ts`,
// the domain errors of `domain/stock-errors.ts`, and anything unexpected —
// into the ONE wire shape `asyncapi.yaml`'s `RpcError` schema names
// (design.md §6.4). A pure function: no NestJS, no I/O, fully unit-testable
// on its own. Fulfillment's OWN mapping — a different file with different
// cases from Orders' (the error vocabularies differ by service), not a
// parity-guarded copy.
import type { ValidationError } from 'class-validator';
import { DomainError } from '@otc/shared-kernel';
import type { RpcError } from '@otc/contracts';
import { ReservationTerminalError } from '../domain/stock-errors';
import { ConcurrentReservationChangeError, NoKnownStockItemError, UnknownStockItemError } from '../application/stock-application-errors';

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

  if (error instanceof NoKnownStockItemError) {
    return { code: 'NOT_FOUND', message: error.message, details: { orderReference: error.orderReference }, occurredAt };
  }
  if (error instanceof UnknownStockItemError) {
    return {
      code: 'NOT_FOUND',
      message: error.message,
      details: { companyCode: error.companyCode, productCode: error.productCode },
      occurredAt,
    };
  }
  if (error instanceof ReservationTerminalError) {
    return { code: 'PRECONDITION_FAILED', message: error.message, details: { code: error.code }, occurredAt };
  }
  if (error instanceof ConcurrentReservationChangeError) {
    return { code: 'CONFLICT', message: error.message, details: { orderReference: error.orderReference }, occurredAt };
  }
  if (error instanceof DomainError) {
    // Fulfillment's remaining domain refusals (InsufficientStockError,
    // InvalidStockItemSnapshotError, FactAggregateMismatchError,
    // UnknownReservationError) are not client-caused the way an order's
    // are — DOMAIN_ERROR rather than Orders' VALIDATION_FAILED mapping
    // (design.md §6.4).
    return { code: 'DOMAIN_ERROR', message: error.message, details: { code: error.code }, occurredAt };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'an unexpected error occurred',
    occurredAt,
  };
}
