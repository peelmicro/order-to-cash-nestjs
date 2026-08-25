// `POST /auth/login`, `GET /auth/me` (openapi.yaml `auth` tag).
import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { LoginCommand } from '../application/commands/login.command';
import type { CurrentUser, LoginResponse } from '../application/contracts-aliases';
import { GetCurrentUserQuery } from '../application/queries/get-current-user.query';
import type { IssuedToken } from '../application/ports/token.port';
import { LoginRequestDto } from './dto/login.dto';
import { Public } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginRequestDto): Promise<LoginResponse> {
    const issued = await this.commands.execute<LoginCommand, IssuedToken>(new LoginCommand(dto.username, dto.password));
    return { accessToken: issued.accessToken, tokenType: 'Bearer', expiresIn: issued.expiresIn };
  }

  @Get('me')
  async me(@Req() request: AuthenticatedRequest): Promise<CurrentUser> {
    return this.queries.execute<GetCurrentUserQuery, CurrentUser>(new GetCurrentUserQuery(request.user!.sub));
  }
}
