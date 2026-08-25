// `GET /health/live`, `GET /health/ready` (openapi.yaml `ops` tag, R60).
// Both unauthenticated (`@Public()`).
import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { READINESS_CHECKS, type HealthCheck } from '../application/ports/health-check.port';
import type { HealthResponse } from '../application/contracts-aliases';
import { Public } from './guards/public.decorator';

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: readonly HealthCheck[]) {}

  @Public()
  @Get('live')
  @HttpCode(200)
  live(): HealthResponse {
    // R60 — deliberately independent of every dependency: the process is
    // alive, no more, no less.
    return { status: 'up' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
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
