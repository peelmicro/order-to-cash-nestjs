// The ONE place every thrown error becomes an RFC 9457
// `application/problem+json` body (openapi.yaml `components.schemas.Problem`,
// R58). Catches everything (`@Catch()` with no argument) so a controller
// or command/query handler never has to know this shape exists — it just
// throws the error that is true (`RpcBusinessError`, `RpcTimeoutError`,
// `InvalidCredentialsError`, a plain domain error, a Nest `HttpException`
// from the `ValidationPipe`, ...) and this filter translates.
import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { UniqueId } from '@otc/shared-kernel';
import type { RequestWithCorrelationId } from './correlation-id.middleware';
import { classifyRpcError } from '../domain/problem/rpc-error-mapping';
import { activeTraceId } from '../infrastructure/observability/trace-context';
import { CLOCK, type Clock } from '../application/ports/clock.port';
import { InvalidCredentialsError } from '../application/commands/login.command';
import { UnknownOperatorError } from '../application/queries/get-current-user.query';
import { InvoiceNotFoundError, InvoiceScanBudgetExceededError, OrderNotYetProjectedError } from '../application/commands/register-payment.command';
import { InvalidTokenError } from '../application/ports/token.port';
import { RpcBusinessError, RpcCallError } from '../application/ports/rpc-client.port';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  correlationId: string;
  occurredAt: string;
  errors?: { field: string; message: string }[];
  shortages?: unknown;
}

@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<RequestWithCorrelationId>();
    const { status, code, title, detail, extra } = this.classify(exception);
    // A6b — reuse the request-scoped id `CorrelationIdMiddleware` already
    // stamped on every inbound request, so this error-path log line and
    // response share the SAME correlationId as any other line logged
    // about this request (R58's "every line" guarantee). Falls back to a
    // fresh id only for the (untested-in-production) case of a context
    // this middleware never ran for.
    const correlationId = request?.correlationId ?? UniqueId.generate().value;
    const occurredAt = this.clock.now().toISOString();
    // A6a (R58, design.md §4.4) — alongside `correlationId`, read from the
    // ACTIVE span (`@opentelemetry/instrumentation-http` already leaves a
    // real one active for the request's whole lifetime). `undefined` when
    // genuinely none is active (no OTel provider registered) — omitted
    // entirely rather than logged as the literal string `"undefined"`.
    const traceId = activeTraceId();

    console.error(
      JSON.stringify({ level: 'error', correlationId, ...(traceId ? { traceId } : {}), code, status, message: detail, occurredAt }),
    );

    const body: ProblemBody = {
      type: 'about:blank',
      title,
      status,
      detail,
      code,
      correlationId,
      occurredAt,
      ...extra,
    };
    response.status(status).type('application/problem+json').json(body);
  }

  private classify(exception: unknown): { status: number; code: string; title: string; detail: string; extra?: Record<string, unknown> } {
    if (exception instanceof RpcBusinessError) {
      const classified = classifyRpcError(exception.rpcError);
      const extra = exception.code === 'STOCK_UNAVAILABLE' ? { shortages: exception.details?.shortages ?? [] } : undefined;
      return { status: classified.status, code: classified.code, title: classified.title, detail: exception.message, extra };
    }
    if (exception instanceof RpcCallError) {
      const classified = classifyRpcError({ code: exception.code, message: exception.message });
      return { status: classified.status, code: classified.code, title: classified.title, detail: exception.message };
    }
    if (exception instanceof InvalidCredentialsError) {
      return { status: 401, code: 'INVALID_CREDENTIALS', title: 'Bad credentials', detail: exception.message };
    }
    if (exception instanceof InvalidTokenError) {
      return { status: 401, code: 'UNAUTHORIZED', title: 'Missing, expired or invalid bearer token', detail: exception.message };
    }
    if (exception instanceof InvoiceNotFoundError) {
      return { status: 404, code: 'NOT_FOUND', title: 'No such invoice', detail: exception.message };
    }
    if (exception instanceof InvoiceScanBudgetExceededError) {
      // F4 (review) — the invoice may exist; the gateway only stopped
      // looking. A 404 would be a false statement, so this is a distinct
      // 503, honestly framed as "could not resolve within budget" rather
      // than "not found".
      return {
        status: 503,
        code: 'SCAN_BUDGET_EXCEEDED',
        title: 'Could not resolve the invoice within this gateway\'s search window',
        detail: exception.message,
      };
    }
    if (exception instanceof OrderNotYetProjectedError) {
      return { status: 503, code: 'UPSTREAM_UNAVAILABLE', title: 'The order is not yet available for this operation', detail: exception.message };
    }
    if (exception instanceof UnknownOperatorError) {
      return { status: 500, code: 'INTERNAL_ERROR', title: 'An unexpected error occurred', detail: exception.message };
    }
    if (exception instanceof BadRequestException) {
      const response = exception.getResponse();
      const validationErrors = this.validationErrorsOf(response);
      return {
        status: 400,
        code: 'VALIDATION_FAILED',
        title: 'The request was malformed or failed schema validation',
        detail: typeof response === 'string' ? response : (response as { message?: string }).message ?? exception.message,
        extra: validationErrors ? { errors: validationErrors } : undefined,
      };
    }
    if (exception instanceof HttpException) {
      const httpResponse = exception.getResponse();
      const detail = typeof httpResponse === 'string' ? httpResponse : (httpResponse as { message?: string }).message ?? exception.message;
      return { status: exception.getStatus(), code: this.codeForStatus(exception.getStatus()), title: exception.name, detail };
    }

    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'An unexpected error occurred',
      detail: exception instanceof Error ? exception.message : 'an unexpected error occurred',
    };
  }

  private validationErrorsOf(response: unknown): { field: string; message: string }[] | undefined {
    if (typeof response === 'object' && response !== null && Array.isArray((response as { errors?: unknown }).errors)) {
      return (response as { errors: { field: string; message: string }[] }).errors;
    }
    if (typeof response === 'object' && response !== null && typeof (response as { field?: unknown }).field === 'string') {
      return [response as { field: string; message: string }];
    }
    return undefined;
  }

  private codeForStatus(status: number): string {
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status === 429) return 'TOO_MANY_REQUESTS';
    return 'DOMAIN_ERROR';
  }
}
