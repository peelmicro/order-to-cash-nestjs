import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { RpcError } from '@otc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ProblemJsonExceptionFilter } from './problem-json.filter';
import { InvalidCredentialsError } from '../application/commands/login.command';
import { InvoiceNotFoundError, InvoiceScanBudgetExceededError, OrderNotYetProjectedError } from '../application/commands/register-payment.command';
import { RpcBusinessError, RpcTimeoutError } from '../application/ports/rpc-client.port';

function fakeHost(requestCorrelationId?: string) {
  const json = vi.fn();
  const type = vi.fn().mockReturnValue({ json });
  const status = vi.fn().mockReturnValue({ type });
  const response = { status };
  const request = { correlationId: requestCorrelationId };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
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

  // Contract-implementation gap closure (openapi.yaml `POST /auth/login`'s
  // `components.responses.TooManyRequests` — progress/impl_auth_rate_limit.md).
  // `ThrottlerException` extends `HttpException`, so it MUST be classified
  // BEFORE the generic `instanceof HttpException` fallback below — proves
  // it does not fall through to a title of the raw class name or a detail
  // of the library's own internal wording.
  it('maps a ThrottlerException (POST /auth/login rate limit) to 429 TOO_MANY_REQUESTS, never the generic HttpException fallback', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, type, json } = fakeHost();

    filter.catch(new ThrottlerException(), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('TOO_MANY_REQUESTS');
    expect(body.status).toBe(429);
    expect(body.title).not.toBe('ThrottlerException');
    expect(body.detail).not.toContain('ThrottlerException');
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

  // A6b/A6d — the problem-json response and its own log line share the
  // SAME correlationId as the request that triggered it (design.md
  // §4.4's named defect: this filter used to mint a FRESH
  // `UniqueId.generate()` instead of reusing `CorrelationIdMiddleware`'s
  // request-scoped id).
  it('reuses the request-scoped correlationId — the response body and its own log line share the SAME id as the request, not a freshly minted one', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, json } = fakeHost('11111111-1111-4111-8111-111111111111');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      filter.catch(new Error('boom'), host);

      const body = json.mock.calls[0]![0];
      expect(body.correlationId).toBe('11111111-1111-4111-8111-111111111111');

      const loggedLine = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(loggedLine.correlationId).toBe('11111111-1111-4111-8111-111111111111');
      expect(loggedLine.correlationId).toBe(body.correlationId);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // A6a (R58, design.md §4.4) — alongside `correlationId`, the same log
  // line gains a `traceId`, read from the ACTIVE span
  // (`@opentelemetry/instrumentation-http` already leaves a real one
  // active for the whole lifetime of an inbound HTTP request in
  // production; here a real `NodeTracerProvider` is registered for the
  // duration of these two cases only, never `sdk-node`'s own OTLP
  // exporter, matching every other trace-proof file's own convention).
  describe('traceId (A6a, R58, design.md §4.4)', () => {
    it('carries the REAL active span\'s traceId, extracted via the exact trace.getActiveSpan() formula design.md §4.4 names', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      const contextManager = new AsyncLocalStorageContextManager();
      provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

      try {
        const span = trace.getTracer('problem-json.filter.spec').startSpan('test-http-server-span');
        const { traceId: originTraceId } = span.spanContext();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        context.with(trace.setSpan(context.active(), span), () => {
          const filter = new ProblemJsonExceptionFilter(clock);
          const { host } = fakeHost('22222222-2222-4222-8222-222222222222');
          filter.catch(new Error('boom'), host);
        });
        span.end();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
        expect(logged.correlationId).toBe('22222222-2222-4222-8222-222222222222');
        expect(logged.traceId).toBe(originTraceId);
        expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

        errorSpy.mockRestore();
      } finally {
        contextManager.disable();
        await provider.shutdown();
      }
    });

    it('omits traceId entirely — never the literal string "undefined" — when no span is active', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const filter = new ProblemJsonExceptionFilter(clock);
      const { host } = fakeHost('33333333-3333-4333-8333-333333333333');

      filter.catch(new Error('boom'), host);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('undefined');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);

      errorSpy.mockRestore();
    });
  });
});
