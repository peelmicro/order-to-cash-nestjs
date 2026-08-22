// Three `@CommandHandler` classes (design.md §5.1). `ReserveStockHandler`/
// `ReleaseStockHandler` are thin — they delegate to `StockReservationHandler`,
// the plain class that owns the whole transactional flow (§5.3).
// `ReplenishStockHandler` IS its own transactional unit: lock the named
// items (same index-ordered `FOR UPDATE`), `UnknownStockItemError` if any
// line names a product this company does not stock (all-or-nothing,
// FS14), `replenish` each, `saveAll` (no outbox row — `R61` appends no
// domain event), reply the affected items as `StockView`s.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Quantity } from '@otc/shared-kernel';
import type { StockReleaseReplyPayload, StockReplenishReplyPayload, StockReserveReplyPayload, StockView } from '@otc/contracts';
import { StockReservationHandler } from '../stock-reservation.handler.js';
import { UnknownStockItemError } from '../stock-application-errors.js';
import { STOCK_ITEM_REPOSITORY, type StockItemRepository } from '../ports/stock-item-repository.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { ReleaseStockCommand, ReplenishStockCommand, ReserveStockCommand } from './stock.commands.js';

@CommandHandler(ReserveStockCommand)
export class ReserveStockHandler implements ICommandHandler<ReserveStockCommand, StockReserveReplyPayload> {
  constructor(@Inject(StockReservationHandler) private readonly handler: StockReservationHandler) {}

  execute(command: ReserveStockCommand): Promise<StockReserveReplyPayload> {
    return this.handler.reserve(command);
  }
}

@CommandHandler(ReleaseStockCommand)
export class ReleaseStockHandler implements ICommandHandler<ReleaseStockCommand, StockReleaseReplyPayload> {
  constructor(@Inject(StockReservationHandler) private readonly handler: StockReservationHandler) {}

  execute(command: ReleaseStockCommand): Promise<StockReleaseReplyPayload> {
    return this.handler.release(command);
  }
}

@CommandHandler(ReplenishStockCommand)
export class ReplenishStockHandler implements ICommandHandler<ReplenishStockCommand, StockReplenishReplyPayload> {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(STOCK_ITEM_REPOSITORY) private readonly stock: StockItemRepository,
  ) {}

  async execute(command: ReplenishStockCommand): Promise<StockReplenishReplyPayload> {
    const request = command.request;
    const distinctProductCodes = [...new Set(request.lines.map((line) => line.productCode))];

    return this.unitOfWork.execute(async (tx) => {
      const itemsByProduct = await this.stock.lockByProductCodes(tx, request.companyCode, distinctProductCodes);

      // All-or-nothing (FS14): a half-applied top-up cannot exist.
      for (const line of request.lines) {
        if (!itemsByProduct.has(line.productCode)) {
          throw new UnknownStockItemError(request.companyCode, line.productCode);
        }
      }

      for (const line of request.lines) {
        const item = itemsByProduct.get(line.productCode)!;
        item.replenish(Quantity.of(line.units));
      }

      const items = [...itemsByProduct.values()];
      // R61 appends no domain event — `saveAll` still upserts the rows and
      // drains (an always-empty) event list, exactly as every other
      // command's transactional unit does.
      await this.stock.saveAll(items, tx);

      const affectedItems = request.lines.map((line) => itemsByProduct.get(line.productCode)!);
      const seen = new Set<string>();
      const views: StockView[] = [];
      for (const item of affectedItems) {
        if (seen.has(item.productCode)) continue;
        seen.add(item.productCode);
        views.push({
          companyCode: item.companyCode,
          productCode: item.productCode,
          units: item.units,
          reservedUnits: item.reservedUnits,
          availableUnits: item.availableUnits,
          lowStockThreshold: item.lowStockThreshold,
        });
      }

      return { items: views };
    });
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const STOCK_COMMAND_HANDLERS = [ReserveStockHandler, ReleaseStockHandler, ReplenishStockHandler] as const;
