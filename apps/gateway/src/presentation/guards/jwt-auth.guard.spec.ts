import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';
import { InvalidTokenError, type TokenClaims, type TokenService } from '../../application/ports/token.port';

function fakeContext(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getHandler: () => vi.fn(),
    getClass: () => vi.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function fakeReflector(isPublic: boolean): Reflector {
  return { getAllAndOverride: () => isPublic } as unknown as Reflector;
}

const claims: TokenClaims = { sub: 'operator', roles: ['operator'] };

class FakeTokenService implements TokenService {
  issue(): never {
    throw new Error('not used');
  }
  verify(token: string): TokenClaims {
    if (token !== 'valid-token') {
      throw new InvalidTokenError('bad token');
    }
    return claims;
  }
}

describe('JwtAuthGuard', () => {
  it('allows a @Public() route through with no Authorization header at all', () => {
    const guard = new JwtAuthGuard(fakeReflector(true), new FakeTokenService());
    const context = fakeContext({ headers: {} } as never);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a protected route with no Authorization header', () => {
    const guard = new JwtAuthGuard(fakeReflector(false), new FakeTokenService());
    const context = fakeContext({ headers: {} } as never);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a protected route with an invalid bearer token', () => {
    const guard = new JwtAuthGuard(fakeReflector(false), new FakeTokenService());
    const context = fakeContext({ headers: { authorization: 'Bearer garbage' } } as never);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('accepts a valid bearer token and attaches its claims to request.user', () => {
    const guard = new JwtAuthGuard(fakeReflector(false), new FakeTokenService());
    const request: Partial<AuthenticatedRequest> = { headers: { authorization: 'Bearer valid-token' } } as never;
    const context = fakeContext(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual(claims);
  });
});
