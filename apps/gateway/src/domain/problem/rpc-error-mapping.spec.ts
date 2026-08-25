import { describe, expect, it } from 'vitest';
import { classifyRpcError } from './rpc-error-mapping';

describe('classifyRpcError', () => {
  it('R58 — maps VALIDATION_FAILED to 400', () => {
    expect(classifyRpcError({ code: 'VALIDATION_FAILED', message: 'bad' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'The request was malformed or failed validation',
    });
  });

  it('maps NOT_FOUND to 404', () => {
    expect(classifyRpcError({ code: 'NOT_FOUND', message: 'missing' }).status).toBe(404);
  });

  it('maps STOCK_UNAVAILABLE to 409 with the STOCK_UNAVAILABLE code (R26)', () => {
    expect(classifyRpcError({ code: 'STOCK_UNAVAILABLE', message: 'short' })).toEqual({
      status: 409,
      code: 'STOCK_UNAVAILABLE',
      title: 'Insufficient stock at acceptance',
    });
  });

  it('maps a bare CONFLICT to 409', () => {
    expect(classifyRpcError({ code: 'CONFLICT', message: 'conflict' }).status).toBe(409);
  });

  it('maps DOMAIN_ERROR to 422', () => {
    expect(classifyRpcError({ code: 'DOMAIN_ERROR', message: 'refused' }).status).toBe(422);
  });

  it('maps TIMEOUT to 503 with UPSTREAM_TIMEOUT (R58 — the stable code openapi.yaml names)', () => {
    expect(classifyRpcError({ code: 'TIMEOUT', message: 'no reply' })).toEqual({
      status: 503,
      code: 'UPSTREAM_TIMEOUT',
      title: 'The owning context did not answer within the deadline',
    });
  });

  it('maps UNAVAILABLE (no responders) to 503', () => {
    expect(classifyRpcError({ code: 'UNAVAILABLE', message: 'no responder' }).status).toBe(503);
  });

  it('falls back to 500 INTERNAL_ERROR for an unrecognised code', () => {
    expect(classifyRpcError({ code: 'SOMETHING_NEW', message: 'huh' })).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'An unexpected error occurred',
    });
  });

  it('R49 — overrides PRECONDITION_FAILED/INVOICE_ALREADY_PAID (details.code) to 409 INVOICE_ALREADY_PAID', () => {
    expect(
      classifyRpcError({ code: 'PRECONDITION_FAILED', message: 'already paid', details: { code: 'INVOICE_ALREADY_PAID' } }),
    ).toEqual({ status: 409, code: 'INVOICE_ALREADY_PAID', title: 'Invoice already paid' });
  });

  it('R49 — overrides an amount mismatch (details.code) to 422 PAYMENT_MISMATCH', () => {
    expect(
      classifyRpcError({
        code: 'PRECONDITION_FAILED',
        message: 'amount mismatch',
        details: { code: 'INVOICE_PAYMENT_AMOUNT_MISMATCH' },
      }),
    ).toEqual({ status: 422, code: 'PAYMENT_MISMATCH', title: 'Payment amount does not match the invoice total' });
  });

  it('R49 — overrides a currency mismatch (details.code) to 422 PAYMENT_MISMATCH', () => {
    expect(
      classifyRpcError({
        code: 'PRECONDITION_FAILED',
        message: 'currency mismatch',
        details: { code: 'INVOICE_PAYMENT_CURRENCY_MISMATCH' },
      }),
    ).toEqual({ status: 422, code: 'PAYMENT_MISMATCH', title: 'Payment currency does not match the invoice total' });
  });

  it('R48 — overrides a reused paymentReference (details.code) to 409 PAYMENT_REFERENCE_REUSED', () => {
    expect(
      classifyRpcError({ code: 'CONFLICT', message: 'reused', details: { code: 'PAYMENT_REFERENCE_CONFLICT' } }),
    ).toEqual({ status: 409, code: 'PAYMENT_REFERENCE_REUSED', title: 'Payment reference reused for a different invoice or amount' });
  });

  it('leaves an unrelated details.code untouched — only the known overrides apply', () => {
    expect(classifyRpcError({ code: 'NOT_FOUND', message: 'missing', details: { code: 'INVOICE_NOT_FOUND' } }).status).toBe(404);
  });
});
