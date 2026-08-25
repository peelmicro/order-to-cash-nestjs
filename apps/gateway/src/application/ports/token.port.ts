// Issues and verifies the single operator's bearer token
// (openapi.yaml `bearerAuth`, `POST /auth/login`). The adapter
// (infrastructure/auth/jwt-token.adapter.ts) is the only file that imports
// `jsonwebtoken`.
export const TOKEN_SERVICE = Symbol('TokenService');

export interface TokenClaims {
  readonly sub: string;
  readonly roles: readonly string[];
}

export interface IssuedToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`bearer token rejected: ${reason}`);
  }
}

export interface TokenService {
  issue(claims: TokenClaims): IssuedToken;
  /** Throws `InvalidTokenError` on a missing, malformed, expired or wrongly-signed token. */
  verify(token: string): TokenClaims;
}
