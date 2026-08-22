// The three `CommandBus` commands (design.md §5.1). `ReserveStockCommand`/
// `ReleaseStockCommand` carry `correlationId`/`requestId` as `UniqueId` —
// derived from the request's `x-correlation-id`/`x-request-id` headers by
// the controller (FS3) — so the transactional flow never has to re-parse a
// header. `ReplenishStockCommand` carries neither: it is not a saga
// command and needs no causation carrier (design.md §4.5).
import { Command } from '@nestjs/cqrs';
import type {
  StockReleaseReplyPayload,
  StockReleaseRequestPayload,
  StockReplenishReplyPayload,
  StockReplenishRequestPayload,
  StockReserveReplyPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';
import type { UniqueId } from '@otc/shared-kernel';

export class ReserveStockCommand extends Command<StockReserveReplyPayload> {
  constructor(
    readonly request: StockReserveRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}

export class ReleaseStockCommand extends Command<StockReleaseReplyPayload> {
  constructor(
    readonly request: StockReleaseRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}

export class ReplenishStockCommand extends Command<StockReplenishReplyPayload> {
  constructor(readonly request: StockReplenishRequestPayload) {
    super();
  }
}
