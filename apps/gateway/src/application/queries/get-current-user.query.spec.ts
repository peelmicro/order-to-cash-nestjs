import { describe, expect, it } from 'vitest';
import { GetCurrentUserHandler, GetCurrentUserQuery, UnknownOperatorError } from './get-current-user.query';
import type { OperatorIdentity } from '../../domain/auth/operator-credentials';

const operator: OperatorIdentity = { username: 'operator', password: 'secret', displayName: 'Operator', roles: ['operator'] };

describe('GetCurrentUserHandler', () => {
  it('R58-adjacent — describes the configured operator identity', async () => {
    const handler = new GetCurrentUserHandler(operator);
    await expect(handler.execute(new GetCurrentUserQuery('operator'))).resolves.toEqual({
      username: 'operator',
      displayName: 'Operator',
      roles: ['operator'],
    });
  });

  it('rejects a username that is not the configured operator (a token could name no one else, but defends anyway)', async () => {
    const handler = new GetCurrentUserHandler(operator);
    await expect(handler.execute(new GetCurrentUserQuery('someone-else'))).rejects.toBeInstanceOf(UnknownOperatorError);
  });
});
