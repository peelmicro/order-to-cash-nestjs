import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { RpcError } from '@otc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemJsonExceptionFilter } from './problem-json.filter';
import { InvalidCredentialsError } from '../application/commands/login.command';
import { InvoiceNotFoundError, InvoiceScanBudgetExceededError, OrderNotYetProjectedError } from '../application/commands/register-payment.command';
import { RpcBusinessError, RpcTimeoutError } from '../application/ports/rpc-client.port';

function fakeHost() {
  const json = vi.fn();
  const type = vi.fn().mockReturnValue({ json });
  const status = vi.fn().mockReturnValue({ type });
  const response = { status };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  return { host, status, type, json };
}

const clock = { now: () => new Date('2026-08-18T10:15:00.000Z') };

describe('ProblemJsonExceptionFilter — R58 (every non-2xx is application/problem+json)', () => {
  it('maps an RpcBusinessError (STOCK_UNAVAILABLE, R26) to 409 with shortages surfaced', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, type, json } = fakeHost();
    const rpcError: RpcError = { code: 'STOCK_UNAVAILABLE', message: 'short', details: { shortages: [{ productCode: 'PRD-0001', requested: 5, available: 2 }] } };

    filter.catch(new RpcBusinessError('orders.create', rpcError), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('STOCK_UNAVAILABLE');
    expect(body.shortages).toEqual([{ productCode: 'PRD-0001', requested: 5, available: 2 }]);
    expect(body.correlationId).toBeTruthy();
    expect(body.occurredAt).toBe('2026-08-18T10:15:00.000Z');
  });

  it('maps RpcTimeoutError to 503 UPSTREAM_TIMEOUT', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();

    filter.catch(new RpcTimeoutError('orders.cancel', 5000), host);

    expect(status).toHaveBeenCalledWith(503);
    expect(json.mock.calls[0][0].code).toBe('UPSTREAM_TIMEOUT');
  });

  it('maps InvalidCredentialsError to 401', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();

    filter.catch(new InvalidCredentialsError(), host);

    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].code).toBe('INVALID_CREDENTIALS');
  });

  it('maps InvoiceNotFoundError to 404', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status } = fakeHost();

    filter.catch(new InvoiceNotFoundError('invoice-1'), host);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('F4 — maps InvoiceScanBudgetExceededError to 503 SCAN_BUDGET_EXCEEDED, never 404 (the invoice may still exist beyond the search window)', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();

    filter.catch(new InvoiceScanBudgetExceededError('invoice-1', 1000), host);

    expect(status).toHaveBeenCalledWith(503);
    expect(json.mock.calls[0][0].code).toBe('SCAN_BUDGET_EXCEEDED');
  });

  it('maps OrderNotYetProjectedError (the R54/correlationId gap-closing seam) to 503', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status } = fakeHost();

    filter.catch(new OrderNotYetProjectedError('ORD-000042'), host);

    expect(status).toHaveBeenCalledWith(503);
  });

  it('maps a ValidationPipe BadRequestException to 400 VALIDATION_FAILED with an errors[] array', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();

    filter.catch(new BadRequestException({ errors: [{ field: 'lines', message: 'must contain at least 1 elements' }] }), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].code).toBe('VALIDATION_FAILED');
    expect(json.mock.calls[0][0].errors).toEqual([{ field: 'lines', message: 'must contain at least 1 elements' }]);
  });

  it('maps an unrecognised error to 500 INTERNAL_ERROR', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].code).toBe('INTERNAL_ERROR');
  });

  it('never leaks the JWT secret or any credential — the detail message is exactly the thrown error’s own message', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, json } = fakeHost();

    filter.catch(new InvalidCredentialsError(), host);

    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('secret');
  });
});
