// Translates every failure `orders-create.controller.ts` can observe —
// class-validator violations, the application-layer errors of
// `place-order.errors.ts`, the domain errors of `domain/order-errors.ts`,
// the stock-check port's transport errors, and anything unexpected — into
// the ONE wire shape `asyncapi.yaml`'s `RpcError` schema names. A pure
// function: no NestJS, no I/O, fully unit-testable on its own.
//
// `order-errors.ts` §7's own comment names this file as where its `code`
// vocabulary gets translated ("Codes are the vocabulary the RPC error
// mapping (feature 15) ... will translate; they are stable from here on.").
import type { ValidationError } from 'class-validator';
import { DomainError } from '@otc/shared-kernel';
import type { RpcError } from '@otc/contracts';
import { OrderDiscountNotSupportedError, ReferenceDataNotFoundError, StockUnavailableError } from '../application/place-order.errors';
import { StockCheckTimeoutError, StockCheckTransportError } from '../application/ports/stock-availability.port';

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

  if (error instanceof StockUnavailableError) {
    return {
      code: 'STOCK_UNAVAILABLE',
      message: error.message,
      details: { shortages: error.shortages },
      occurredAt,
    };
  }
  if (error instanceof StockCheckTimeoutError) {
    return {
      code: 'TIMEOUT',
      message: error.message,
      details: { subject: error.subject, timeoutMs: error.timeoutMs },
      occurredAt,
    };
  }
  if (error instanceof StockCheckTransportError) {
    return {
      code: 'UNAVAILABLE',
      message: error.message,
      details: { subject: error.subject },
      occurredAt,
    };
  }
  if (error instanceof ReferenceDataNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message: error.message,
      details: { field: error.field, value: error.value },
      occurredAt,
    };
  }
  if (error instanceof OrderDiscountNotSupportedError) {
    return { code: 'VALIDATION_FAILED', message: error.message, occurredAt };
  }
  if (error instanceof DomainError) {
    // Every aggregate refusal (order-errors.ts) is client-caused — the
    // request described an order that violates an invariant. `details.code`
    // preserves the specific domain code for a caller that wants it.
    return { code: 'VALIDATION_FAILED', message: error.message, details: { code: error.code }, occurredAt };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'an unexpected error occurred',
    occurredAt,
  };
}
