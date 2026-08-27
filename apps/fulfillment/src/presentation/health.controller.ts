// COPY OF (adapted) — apps/gateway/src/presentation/health.controller.ts
// `GET /health/live`, `GET /health/ready` (R60/OR6). No auth guard: this
// service has none (unlike the gateway) — every route here is already
// unauthenticated. `HealthResponse` is defined LOCALLY rather than
// generated from `specs/shared/openapi.yaml`: that contract documents only
// the Gateway's own REST surface — this service's HTTP port exists purely
// for health/metrics (main.ts's own comment), never a consumer-facing API.
// `ResponseLike` (not `express`'s own `Response`): this service has no
// `@types/express` dependency (only the gateway does) — the ONLY method
// `ready()` needs from the injected response object is `status(code)`, so a
// minimal structural type avoids adding a devDependency for one method.
import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { READINESS_CHECKS, type HealthCheck, type HealthCheckResult } from '../application/ports/health-check.port';

export interface HealthResponse {
  readonly status: 'up' | 'down';
  readonly checks?: Readonly<Record<string, HealthCheckResult>>;
}

interface ResponseLike {
  status(code: number): void;
}

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: readonly HealthCheck[]) {}

  @Get('live')
  @HttpCode(200)
  live(): HealthResponse {
    // R60 — deliberately independent of every dependency: the process is
    // alive, no more, no less.
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: ResponseLike): Promise<HealthResponse> {
    const results = await Promise.all(this.checks.map(async (check) => [check.name, await check.check()] as const));
    const allUp = results.every(([, result]) => result.status === 'up');
    if (!allUp) {
      res.status(503);
    }
    return {
      status: allUp ? 'up' : 'down',
      checks: Object.fromEntries(results),
    };
  }
}
