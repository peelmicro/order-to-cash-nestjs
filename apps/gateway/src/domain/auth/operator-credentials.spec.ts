import { describe, expect, it } from 'vitest';
import { matchesOperator, type OperatorIdentity } from './operator-credentials';

const configured: OperatorIdentity = {
  username: 'operator',
  password: 'otc_operator_dev_password',
  displayName: 'Operator',
  roles: ['operator'],
};

describe('matchesOperator', () => {
  it('accepts the exact configured username and password', () => {
    expect(matchesOperator({ username: 'operator', password: 'otc_operator_dev_password' }, configured)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(matchesOperator({ username: 'operator', password: 'wrong' }, configured)).toBe(false);
  });

  it('rejects a wrong username', () => {
    expect(matchesOperator({ username: 'someone-else', password: 'otc_operator_dev_password' }, configured)).toBe(false);
  });

  it('is case-sensitive on both fields', () => {
    expect(matchesOperator({ username: 'Operator', password: 'otc_operator_dev_password' }, configured)).toBe(false);
  });
});
