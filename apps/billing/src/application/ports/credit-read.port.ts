// The `QueryBus` side (design.md §5.2, §7.2) — never locks, never mutates.
// Plain SELECTs behind `billing.credit.list`.
import type { CreditListReplyPayload, CreditListRequestPayload } from '@otc/contracts';

export const CREDIT_READ = Symbol('CreditRead');

export interface CreditReadPort {
  list(query: CreditListRequestPayload): Promise<CreditListReplyPayload>;
}
