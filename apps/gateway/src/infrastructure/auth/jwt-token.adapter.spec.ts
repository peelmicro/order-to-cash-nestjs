import { describe, expect, it } from 'vitest';
import { JwtTokenAdapter } from './jwt-token.adapter';
import { InvalidTokenError } from '../../application/ports/token.port';

const config = { secret: 'test-secret', expiresIn: '1h', issuer: 'order-to-cash-test' };

describe('JwtTokenAdapter', () => {
  it('issues a token that verify() decodes back to the same claims', () => {
    const adapter = new JwtTokenAdapter(config);

    const issued = adapter.issue({ sub: 'operator', roles: ['operator'] });
    expect(issued.expiresIn).toBeGreaterThan(0);

    const claims = adapter.verify(issued.accessToken);
    expect(claims).toEqual({ sub: 'operator', roles: ['operator'] });
  });

  it('rejects a token signed with a different secret', () => {
    const adapter = new JwtTokenAdapter(config);
    const otherAdapter = new JwtTokenAdapter({ ...config, secret: 'a-different-secret' });
    const issued = otherAdapter.issue({ sub: 'operator', roles: ['operator'] });

    expect(() => adapter.verify(issued.accessToken)).toThrow(InvalidTokenError);
  });

  it('rejects a token issued for a different issuer', () => {
    const adapter = new JwtTokenAdapter(config);
    const otherIssuer = new JwtTokenAdapter({ ...config, issuer: 'someone-else' });
    const issued = otherIssuer.issue({ sub: 'operator', roles: ['operator'] });

    expect(() => adapter.verify(issued.accessToken)).toThrow(InvalidTokenError);
  });

  it('rejects a garbage token', () => {
    const adapter = new JwtTokenAdapter(config);
    expect(() => adapter.verify('not-a-jwt')).toThrow(InvalidTokenError);
  });

  it('rejects an expired token', () => {
    const adapter = new JwtTokenAdapter({ ...config, expiresIn: '-1s' });
    const issued = adapter.issue({ sub: 'operator', roles: ['operator'] });

    expect(() => adapter.verify(issued.accessToken)).toThrow(InvalidTokenError);
  });
});
