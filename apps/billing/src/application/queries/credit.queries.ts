// The `QueryBus` side (design.md §5.1) — `billing.credit.list`, never
// locking, never mutating.
import { Query } from '@nestjs/cqrs';
import type { CreditListReplyPayload, CreditListRequestPayload } from '@otc/contracts';

export class ListCreditQuery extends Query<CreditListReplyPayload> {
  constructor(readonly request: CreditListRequestPayload) {
    super();
  }
}
