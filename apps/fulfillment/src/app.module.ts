// design.md §6, §12: `CqrsModule.forRoot()`, the five `@nestjs/cqrs`
// handlers as CLASS providers (decorator discovery needs the class),
// everything else wired with `useFactory` + `inject: [...]` — the same
// shape `apps/orders/src/app.module.ts` established. `NatsConnection` is
// NOT needed here: Fulfillment makes no outbound RPC call (design.md §5.1)
// — its only outbound integration is the outbox relay's Kafka producer.
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AppController } from './presentation/app.controller';
import { StockController } from './presentation/stock.controller';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { STOCK_ITEM_REPOSITORY } from './application/ports/stock-item-repository.port';
import { STOCK_READ } from './application/ports/stock-read.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { STOCK_COMMAND_HANDLERS } from './application/commands/stock.command-handlers';
import { STOCK_QUERY_HANDLERS } from './application/queries/stock.query-handlers';
import { StockReservationHandler } from './application/stock-reservation.handler';
import { createFulfillmentDb, createFulfillmentPool, type FulfillmentDb } from './infrastructure/persistence/client';
import { loadFulfillmentDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleStockItemRepository } from './infrastructure/persistence/stock-item.repository';
import { DrizzleStockReadRepository } from './infrastructure/persistence/stock-read.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';

/** Module-local token — the shared `FulfillmentDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const FULFILLMENT_DB = Symbol('FulfillmentDb');

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, StockController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: FULFILLMENT_DB,
      useFactory: (): FulfillmentDb => createFulfillmentDb(createFulfillmentPool(loadFulfillmentDbConfig())),
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: FulfillmentDb): DrizzleUnitOfWork => new DrizzleUnitOfWork(db),
      inject: [FULFILLMENT_DB],
    },
    {
      provide: STOCK_ITEM_REPOSITORY,
      useFactory: (db: FulfillmentDb, clock: Clock): DrizzleStockItemRepository => new DrizzleStockItemRepository(db, clock),
      inject: [FULFILLMENT_DB, CLOCK],
    },
    {
      provide: STOCK_READ,
      useFactory: (db: FulfillmentDb): DrizzleStockReadRepository => new DrizzleStockReadRepository(db),
      inject: [FULFILLMENT_DB],
    },
    {
      provide: StockReservationHandler,
      useFactory: (
        unitOfWork: UnitOfWork,
        stock: DrizzleStockItemRepository,
        clock: Clock,
      ): StockReservationHandler => new StockReservationHandler(unitOfWork, stock, clock),
      inject: [UNIT_OF_WORK, STOCK_ITEM_REPOSITORY, CLOCK],
    },
    {
      provide: FACT_PUBLISHER,
      useFactory: (): KafkaFactPublisher => new KafkaFactPublisher(createKafkaClient(loadKafkaConfig())),
    },
    {
      provide: OUTBOX_RELAY_CONFIG,
      useFactory: (): OutboxRelayConfig => loadOutboxRelayConfig(),
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (
        db: FulfillmentDb,
        publisher: KafkaFactPublisher,
        clock: Clock,
        config: OutboxRelayConfig,
      ): OutboxRelay => new OutboxRelay({ db, publisher, clock, config }),
      inject: [FULFILLMENT_DB, FACT_PUBLISHER, CLOCK, OUTBOX_RELAY_CONFIG],
    },
    OutboxRelayService,

    ...STOCK_QUERY_HANDLERS,
    ...STOCK_COMMAND_HANDLERS,
  ],
})
export class AppModule {}
