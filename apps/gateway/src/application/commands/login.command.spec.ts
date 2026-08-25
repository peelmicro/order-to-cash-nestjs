import { describe, expect, it } from 'vitest';
import { InvalidCredentialsError, LoginCommand, LoginHandler } from './login.command';
import type { OperatorIdentity } from '../../domain/auth/operator-credentials';
import type { IssuedToken, TokenClaims, TokenService } from '../ports/token.port';

const operator: OperatorIdentity = { username: 'operator', password: 'secret', displayName: 'Operator', roles: ['operator'] };

class FakeTokenService implements TokenService {
  issued: TokenClaims[] = [];
  issue(claims: TokenClaims): IssuedToken {
    this.issued.push(claims);
    return { accessToken: 'fake-token', expiresIn: 3600 };
  }
  verify(): TokenClaims {
    throw new Error('not used in this test');
  }
}

describe('LoginHandler', () => {
  it('R58-adjacent — issues a token when the credentials match the configured operator', async () => {
    const tokens = new FakeTokenService();
    const handler = new LoginHandler(operator, tokens);

    const result = await handler.execute(new LoginCommand('operator', 'secret'));

    expect(result).toEqual({ accessToken: 'fake-token', expiresIn: 3600 });
    expect(tokens.issued).toEqual([{ sub: 'operator', roles: ['operator'] }]);
  });

  it('rejects a wrong password without issuing a token', async () => {
    const tokens = new FakeTokenService();
    const handler = new LoginHandler(operator, tokens);

    await expect(handler.execute(new LoginCommand('operator', 'wrong'))).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(tokens.issued).toHaveLength(0);
  });
});
