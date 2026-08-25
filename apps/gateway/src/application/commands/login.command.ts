// `POST /auth/login` (openapi.yaml `login`) — the only unauthenticated
// command endpoint. Compares the submitted pair against the single,
// statically-configured operator identity (`domain/auth/operator-credentials.ts`,
// `domain-model.md` §9) and, on a match, issues a bearer token.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { matchesOperator, type OperatorIdentity } from '../../domain/auth/operator-credentials';
import { OPERATOR_IDENTITY } from '../ports/operator-identity.port';
import { TOKEN_SERVICE, type IssuedToken, type TokenService } from '../ports/token.port';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('username or password is incorrect');
  }
}

export class LoginCommand {
  constructor(
    readonly username: string,
    readonly password: string,
  ) {}
}

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand, IssuedToken> {
  constructor(
    @Inject(OPERATOR_IDENTITY) private readonly operator: OperatorIdentity,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  async execute(command: LoginCommand): Promise<IssuedToken> {
    if (!matchesOperator({ username: command.username, password: command.password }, this.operator)) {
      throw new InvalidCredentialsError();
    }
    return this.tokens.issue({ sub: this.operator.username, roles: this.operator.roles });
  }
}
