// design.md §6, §12: `CqrsModule.forRoot()`, the five `@nestjs/cqrs`
// handlers as CLASS providers (decorator discovery needs the class),
// everything else wired with `useFactory` + `inject: [...]` — the same
// shape `apps/orders/src/app.module.ts` established. Fulfillment makes no
// outbound RPC CALL of its own (design.md §5.1) — its only outbound
// integration is the outbox relay's Kafka producer — but R60/OR6 (A8) still
// needs a live outbound `NatsConnection` to probe the RPC transport's
// reachability, so one is opened below SOLELY for that readiness check.
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { NatsConnection } from 'nats';
import type { Pool } from 'mysql2/promise';
import { AppController } from './presentation/app.controller';
import { HealthController } from './presentation/health.controller';
import { StockController } from './presentation/stock.controller';
import { DespatchController } from './presentation/despatch.controller';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { CLOCK, type Clock } from './application/ports/clock.port';
import {
  DESPATCH_NUMBER_ALLOCATOR,
  type DespatchNumberAllocator,
} from './application/ports/despatch-number-allocator.port';
import { DESPATCH_REPOSITORY } from './application/ports/despatch-repository.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import {
  STOCK_ITEM_REPOSITORY,
  type StockItemRepository,
} from './application/ports/stock-item-repository.port';
import { STOCK_READ } from './application/ports/stock-read.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { STOCK_COMMAND_HANDLERS } from './application/commands/stock.command-handlers';
import { DESPATCH_COMMAND_HANDLERS } from './application/commands/despatch.command-handlers';
import { STOCK_QUERY_HANDLERS } from './application/queries/stock.query-handlers';
import { StockReservationHandler } from './application/stock-reservation.handler';
import { DespatchCreationHandler } from './application/despatch-creation.handler';
import {
  createFulfillmentDb,
  createFulfillmentPool,
  type FulfillmentDb,
} from './infrastructure/persistence/client';
import { loadFulfillmentDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleDespatchNumberAllocator } from './infrastructure/persistence/despatch-number-allocator';
import { DrizzleDespatchRepository } from './infrastructure/persistence/despatch.repository';
import { DrizzleStockItemRepository } from './infrastructure/persistence/stock-item.repository';
import { DrizzleStockReadRepository } from './infrastructure/persistence/stock-read.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import {
  loadOutboxRelayConfig,
  type OutboxRelayConfig,
} from './infrastructure/outbox/outbox-relay.config';
import {
  OUTBOX_RELAY,
  OUTBOX_RELAY_CONFIG,
  OutboxRelayService,
} from './infrastructure/outbox/outbox-relay.service';
import { createNatsConnection } from './infrastructure/messaging/nats-client';
import { loadNatsConfig } from './infrastructure/messaging/nats.config';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';

/** Module-local token — the raw `mysql2` `Pool` `FULFILLMENT_DB` is built from. Exposed as its own provider (A8) so `MysqlHealthCheck` (R60/OR6) can probe the SAME pool the app actually reads/writes through, without opening a second one. Not exported: nothing outside this module needs it. */
const FULFILLMENT_DB_POOL = Symbol('FulfillmentDbPool');
/** Module-local token — the shared `FulfillmentDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const FULFILLMENT_DB = Symbol('FulfillmentDb');
/** The ONE outbound `NatsConnection` this service opens — SOLELY for `NatsHealthCheck`'s R60/OR6 probe (see the header comment above: Fulfillment issues no RPC call of its own). Exported (A8) — same "a plain symbol, not a domain port" shape `apps/orders/src/app.module.ts`/`apps/projector/src/app.module.ts` already export their own `NATS_CONNECTION` for: `health-probes.integration.spec.ts` overrides this with a real, pre-authenticated fixture connection (the `@testcontainers/nats` image requires `--user test --pass test`, which a bare `NATS_URL` env var cannot carry). */
export const NATS_CONNECTION = Symbol('NatsConnection');

/** Closes the outbound NATS connection on shutdown — the same lifecycle discipline `apps/orders/src/app.module.ts`'s own `NatsConnectionCloser` gives its RPC connection. */
class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, StockController, DespatchController, HealthController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: FULFILLMENT_DB_POOL,
      useFactory: (): Pool => createFulfillmentPool(loadFulfillmentDbConfig()),
    },
    {
      provide: FULFILLMENT_DB,
      useFactory: (pool: Pool): FulfillmentDb => createFulfillmentDb(pool),
      inject: [FULFILLMENT_DB_POOL],
    },
    {
      provide: NATS_CONNECTION,
      useFactory: (): Promise<NatsConnection> => createNatsConnection(loadNatsConfig()),
    },
    {
      provide: NatsConnectionCloser,
      useFactory: (connection: NatsConnection): NatsConnectionCloser => new NatsConnectionCloser(connection),
      inject: [NATS_CONNECTION],
    },
    {
      // R60/OR6 (A8) — design.md §4.6's Fulfillment row: write model
      // (MySQL), RPC transport (NATS). No fact-stream check (this service
      // consumes no fact in this feature).
      provide: READINESS_CHECKS,
      useFactory: (pool: Pool, connection: NatsConnection): readonly HealthCheck[] => [
        new MysqlHealthCheck(pool),
        new NatsHealthCheck(connection),
      ],
      inject: [FULFILLMENT_DB_POOL, NATS_CONNECTION],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: FulfillmentDb): DrizzleUnitOfWork => new DrizzleUnitOfWork(db),
      inject: [FULFILLMENT_DB],
    },
    {
      provide: STOCK_ITEM_REPOSITORY,
      useFactory: (db: FulfillmentDb, clock: Clock): DrizzleStockItemRepository =>
        new DrizzleStockItemRepository(db, clock),
      inject: [FULFILLMENT_DB, CLOCK],
    },
    {
      provide: STOCK_READ,
      useFactory: (db: FulfillmentDb): DrizzleStockReadRepository =>
        new DrizzleStockReadRepository(db),
      inject: [FULFILLMENT_DB],
    },
    {
      provide: DESPATCH_REPOSITORY,
      useFactory: (db: FulfillmentDb, clock: Clock): DrizzleDespatchRepository =>
        new DrizzleDespatchRepository(db, clock),
      inject: [FULFILLMENT_DB, CLOCK],
    },
    {
      provide: DESPATCH_NUMBER_ALLOCATOR,
      useFactory: (): DrizzleDespatchNumberAllocator => new DrizzleDespatchNumberAllocator(),
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
      provide: DespatchCreationHandler,
      useFactory: (
        unitOfWork: UnitOfWork,
        stock: StockItemRepository,
        despatches: DrizzleDespatchRepository,
        despatchNumbers: DespatchNumberAllocator,
        clock: Clock,
      ): DespatchCreationHandler =>
        new DespatchCreationHandler(unitOfWork, stock, despatches, despatchNumbers, clock),
      inject: [
        UNIT_OF_WORK,
        STOCK_ITEM_REPOSITORY,
        DESPATCH_REPOSITORY,
        DESPATCH_NUMBER_ALLOCATOR,
        CLOCK,
      ],
    },
    {
      provide: FACT_PUBLISHER,
      useFactory: (): KafkaFactPublisher =>
        new KafkaFactPublisher(createKafkaClient(loadKafkaConfig())),
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
    ...DESPATCH_COMMAND_HANDLERS,
  ],
})
export class AppModule {}
