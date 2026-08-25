// `GET /credits` (openapi.yaml `listCredits`) → NATS RPC `billing.credit.list`.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { CreditListReplyPayload, CreditListRequestPayload } from '@otc/contracts';
import type { CreditPage } from '../contracts-aliases';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const CREDIT_LIST_SUBJECT = 'billing.credit.list';

export class ListCreditsQuery {
  constructor(readonly request: CreditListRequestPayload) {}
}

@QueryHandler(ListCreditsQuery)
export class ListCreditsHandler implements IQueryHandler<ListCreditsQuery, CreditPage> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(query: ListCreditsQuery): Promise<CreditPage> {
    const requestId = UniqueId.generate().value;
    return this.rpc.call<CreditListRequestPayload, CreditListReplyPayload>(CREDIT_LIST_SUBJECT, query.request, {
      correlationId: requestId,
      requestId,
    });
  }
}
