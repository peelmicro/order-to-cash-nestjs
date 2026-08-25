// Global `APP_GUARD` (wired in `app.module.ts`) — requires a valid bearer
// token on every route EXCEPT the ones `@Public()` marks (openapi.yaml
// `bearerAuth`'s own list: `POST /auth/login`, `GET /health/live`,
// `GET /health/ready`, `GET /docs`). Attaches the verified claims onto
// `request.user` so `AuthController.me()` and `StreamController` can read
// them without re-verifying.
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TOKEN_SERVICE, type TokenClaims, type TokenService } from '../../application/ports/token.port';
import { IS_PUBLIC_KEY } from './public.decorator';

export interface AuthenticatedRequest extends Request {
  user?: TokenClaims;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();

    try {
      request.user = this.tokens.verify(token);
    } catch {
      throw new UnauthorizedException('invalid or expired bearer token');
    }
    return true;
  }
}
