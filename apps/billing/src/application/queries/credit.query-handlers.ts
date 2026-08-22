// One thin `@QueryHandler` class (design.md §5.1) — no logic beyond
// delegation, every dependency through `@Inject(TOKEN)`, registered as a
// class provider in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { CreditListReplyPayload } from '@otc/contracts';
import { CREDIT_READ, type CreditReadPort } from '../ports/credit-read.port.js';
import { ListCreditQuery } from './credit.queries.js';

@QueryHandler(ListCreditQuery)
export class ListCreditHandler implements IQueryHandler<ListCreditQuery, CreditListReplyPayload> {
  constructor(@Inject(CREDIT_READ) private readonly creditRead: CreditReadPort) {}

  execute(query: ListCreditQuery): Promise<CreditListReplyPayload> {
    return this.creditRead.list(query.request);
  }
}

/** Every `@QueryHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const CREDIT_QUERY_HANDLERS = [ListCreditHandler] as const;
