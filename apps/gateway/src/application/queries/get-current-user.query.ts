// `GET /auth/me` (openapi.yaml `getCurrentUser`) — describes the operator
// identified by the already-verified bearer token (`presentation/guards/jwt-auth.guard.ts`
// attaches the decoded claims to the request; this query re-resolves the
// full identity from configuration rather than trusting `displayName`/`roles`
// baked into an old token, so a config change takes effect on the very next
// call even for a token issued before it).
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { CurrentUser } from '../contracts-aliases';
import { OPERATOR_IDENTITY, type OperatorIdentity } from '../ports/operator-identity.port';

export class UnknownOperatorError extends Error {
  constructor(username: string) {
    super(`no operator identity for "${username}"`);
  }
}

export class GetCurrentUserQuery {
  constructor(readonly username: string) {}
}

@QueryHandler(GetCurrentUserQuery)
export class GetCurrentUserHandler implements IQueryHandler<GetCurrentUserQuery, CurrentUser> {
  constructor(@Inject(OPERATOR_IDENTITY) private readonly operator: OperatorIdentity) {}

  async execute(query: GetCurrentUserQuery): Promise<CurrentUser> {
    if (query.username !== this.operator.username) {
      throw new UnknownOperatorError(query.username);
    }
    return { username: this.operator.username, displayName: this.operator.displayName, roles: [...this.operator.roles] };
  }
}
