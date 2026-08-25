// The ONLY file in this service that imports `jsonwebtoken` for its value
// — same "one adapter, one library import" discipline `nats-client.ts`/
// `mongo-client.ts` establish elsewhere in this repo. A plain client, no
// `@nestjs/jwt`/`@nestjs/passport` indirection: there is exactly one
// statically-configured identity to authenticate (`domain-model.md` §9),
// so a strategy/guard framework buys nothing a direct `jsonwebtoken`
// sign/verify pair does not already give.
import jwt from 'jsonwebtoken';
import type { JwtConfig } from './jwt.config';
import { InvalidTokenError, type IssuedToken, type TokenClaims, type TokenService } from '../../application/ports/token.port';

interface DecodedJwtPayload {
  readonly sub: string;
  readonly roles: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

export class JwtTokenAdapter implements TokenService {
  constructor(private readonly config: JwtConfig) {}

  issue(claims: TokenClaims): IssuedToken {
    const accessToken = jwt.sign({ roles: claims.roles }, this.config.secret, {
      subject: claims.sub,
      issuer: this.config.issuer,
      expiresIn: this.config.expiresIn as jwt.SignOptions['expiresIn'],
    });
    const decoded = jwt.decode(accessToken) as DecodedJwtPayload;
    return { accessToken, expiresIn: decoded.exp - decoded.iat };
  }

  verify(token: string): TokenClaims {
    let decoded: DecodedJwtPayload;
    try {
      decoded = jwt.verify(token, this.config.secret, { issuer: this.config.issuer }) as DecodedJwtPayload;
    } catch (error) {
      throw new InvalidTokenError(error instanceof Error ? error.message : 'unknown verification failure');
    }
    if (!decoded.sub) {
      throw new InvalidTokenError('token carries no subject');
    }
    return { sub: decoded.sub, roles: decoded.roles ?? [] };
  }
}
