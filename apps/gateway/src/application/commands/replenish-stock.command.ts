// `POST /stock/replenish` (openapi.yaml `replenishStock`) → NATS RPC
// `fulfillment.stock.replenish` (asyncapi.yaml `requestStockReplenish`,
// R61). Emits no fact and advances no order — a deliberately plain
// request/reply translation, no correlationId semantics beyond "this
// gateway request".
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { StockReplenishReplyPayload, StockReplenishRequestPayload } from '@otc/contracts';
import type { ReplenishStockResponse } from '../contracts-aliases';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const STOCK_REPLENISH_SUBJECT = 'fulfillment.stock.replenish';

export class ReplenishStockCommand {
  constructor(readonly request: StockReplenishRequestPayload) {}
}

@CommandHandler(ReplenishStockCommand)
export class ReplenishStockHandler implements ICommandHandler<ReplenishStockCommand, ReplenishStockResponse> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(command: ReplenishStockCommand): Promise<ReplenishStockResponse> {
    const requestId = UniqueId.generate().value;
    const reply = await this.rpc.call<StockReplenishRequestPayload, StockReplenishReplyPayload>(
      STOCK_REPLENISH_SUBJECT,
      command.request,
      { correlationId: requestId, requestId },
    );
    return { items: reply.items };
  }
}
