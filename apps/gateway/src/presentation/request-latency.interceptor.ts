// A7 — `otc_request_latency_ms` (`observability_reliability` design.md
// §4.5, R59/OR5): a global `NestInterceptor`, mounted app-wide (same
// "runs for every route" shape `CorrelationIdMiddleware`/`ProblemJsonExceptionFilter`
// already establish, `APP_INTERCEPTOR` rather than `APP_FILTER`/a
// middleware since this needs `ExecutionContext`'s controller/handler
// names for a low-cardinality "per endpoint" label — a raw URL like
// `/orders/123` would mint one attribute-set PER ORDER ID, which is
// exactly the metric-cardinality mistake design.md's own "per endpoint"
// wording exists to avoid). Records on EVERY response, success or error
// (`tap`'s `finalize`-shaped pairing below), since a slow failing request
// is exactly as latency-relevant as a slow successful one.
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { CLOCK, type Clock } from '../application/ports/clock.port';
import { requestLatencyHistogram } from '../infrastructure/observability/metrics';

@Injectable()
export class RequestLatencyInterceptor implements NestInterceptor {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = this.clock.now();
    const request = context.switchToHttp().getRequest<Request>();
    const endpoint = `${context.getClass().name}.${context.getHandler().name}`;
    const method = request?.method ?? 'UNKNOWN';

    // No `statusCode` attribute: at the point EITHER callback below fires,
    // an error path has not yet been through `ProblemJsonExceptionFilter`
    // (interceptors wrap the handler, filters run AFTER), so Express's
    // `response.statusCode` would still read its pre-error default — a
    // misleading attribute is worse than an absent one.
    const record = (): void => {
      const durationMs = this.clock.now().getTime() - startedAt.getTime();
      requestLatencyHistogram().record(durationMs, { endpoint, method });
    };

    return new Observable((subscriber) => {
      const subscription = next.handle().subscribe({
        next: (value) => subscriber.next(value),
        error: (error) => {
          record();
          subscriber.error(error);
        },
        complete: () => {
          record();
          subscriber.complete();
        },
      });
      return () => subscription.unsubscribe();
    });
  }
}
