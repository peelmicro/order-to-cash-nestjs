import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { NatsConnection } from 'nats';
import { AppController } from './presentation/app.controller';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { SagaFactsController } from './presentation/saga-facts.controller';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { ORDER_NUMBER_ALLOCATOR } from './application/ports/order-number-allocator.port';
import { ORDER_REFERENCE_DATA } from './application/ports/order-reference-data.port';
import { ORDER_REPOSITORY, type OrderRepository } from './application/ports/order-repository.port';
import { SAGA_COMMANDS } from './application/ports/saga-commands.port';
import { SAGA_COMMAND_STORE, type SagaCommandStore } from './application/ports/saga-command-store.port';
import { STOCK_AVAILABILITY } from './application/ports/stock-availability.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { PlaceOrderHandler } from './application/place-order.handler';
import { SagaFactHandler } from './application/saga-fact-handler';
import { SAGA_DISPATCH_COMMAND_HANDLERS } from './application/commands/saga-dispatch.handlers';
import { SAGA_FACT_COMMAND_HANDLERS } from './application/commands/saga-fact.handlers';
import { OrderSagas } from './application/sagas/order.sagas';
import { createOrdersDb, createOrdersPool, type OrdersDb } from './infrastructure/persistence/client';
import { loadOrdersDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderNumberAllocator } from './infrastructure/persistence/order-number-allocator';
import { DrizzleOrderReferenceDataRepository } from './infrastructure/persistence/order-reference-data.repository';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';
import { createNatsConnection } from './infrastructure/messaging/nats-client';
import { IdempotentConsumer } from './infrastructure/messaging/idempotent-consumer';
import { loadNatsConfig, loadStockCheckTimeoutMs } from './infrastructure/messaging/nats.config';
import { NatsStockAvailabilityAdapter } from './infrastructure/messaging/nats-stock-availability.adapter';
import { NatsSagaCommandsAdapter } from './infrastructure/messaging/nats-saga-commands.adapter';
import { DrizzleSagaCommandStore } from './infrastructure/saga/drizzle-saga-command-store';
import { SagaIgnoredFactsRepository } from './infrastructure/saga/saga-ignored-facts.repository';
import { SAGA_COMMAND_DISPATCHER, SagaCommandDispatcher } from './infrastructure/saga/saga-command-dispatcher';
import {
  SAGA_COMMAND_SWEEPER_CONFIG,
  SagaCommandSweeperService,
  type SagaCommandSweeperConfig,
} from './infrastructure/saga/saga-command-sweeper.service';
import { loadSagaCommandDispatcherConfig, loadSagaCommandSweeperConfig } from './infrastructure/saga/saga.config';

/** Module-local token — the shared `OrdersDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const ORDERS_DB = Symbol('OrdersDb');
/** Module-local token — the ONE outbound `NatsConnection` this service opens for its own RPC calls (`fulfillment.stock.check` AND, since feature 16, the five saga commands — reused, no second connection). Distinct from the INBOUND `orders.create`/Kafka transports, which `@nestjs/microservices` opens and owns itself (main.ts). */
const NATS_CONNECTION = Symbol('NatsConnection');
/** Module-local token — the concrete `SagaCommandDispatcher` used both by `dispatch: SAGA_COMMAND_DISPATCHER` port consumers (dispatch handlers, the sweeper) and — via this token — by the sweeper's constructor. */

/** Closes the outbound NATS connection on shutdown — the same lifecycle discipline `KafkaFactPublisher.disconnect()` gives the outbox relay's producer. */
class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, OrdersCreateController, SagaFactsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: ORDERS_DB,
      useFactory: (): OrdersDb => createOrdersDb(createOrdersPool(loadOrdersDbConfig())),
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: OrdersDb): DrizzleUnitOfWork => new DrizzleUnitOfWork(db),
      inject: [ORDERS_DB],
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (db: OrdersDb, clock: Clock): DrizzleOrderRepository => new DrizzleOrderRepository(db, clock),
      inject: [ORDERS_DB, CLOCK],
    },
    {
      provide: ORDER_NUMBER_ALLOCATOR,
      useFactory: (): DrizzleOrderNumberAllocator => new DrizzleOrderNumberAllocator(),
    },
    {
      provide: ORDER_REFERENCE_DATA,
      useFactory: (db: OrdersDb): DrizzleOrderReferenceDataRepository => new DrizzleOrderReferenceDataRepository(db),
      inject: [ORDERS_DB],
    },
    {
      provide: NATS_CONNECTION,
      useFactory: (): Promise<NatsConnection> => createNatsConnection(loadNatsConfig()),
    },
    {
      provide: STOCK_AVAILABILITY,
      useFactory: (connection: NatsConnection): NatsStockAvailabilityAdapter =>
        new NatsStockAvailabilityAdapter(connection, loadStockCheckTimeoutMs()),
      inject: [NATS_CONNECTION],
    },
    {
      provide: NatsConnectionCloser,
      useFactory: (connection: NatsConnection): NatsConnectionCloser => new NatsConnectionCloser(connection),
      inject: [NATS_CONNECTION],
    },
    {
      provide: PlaceOrderHandler,
      useFactory: (
        unitOfWork: DrizzleUnitOfWork,
        orders: DrizzleOrderRepository,
        orderNumbers: DrizzleOrderNumberAllocator,
        referenceData: DrizzleOrderReferenceDataRepository,
        stockAvailability: NatsStockAvailabilityAdapter,
        clock: Clock,
      ): PlaceOrderHandler =>
        new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock),
      inject: [UNIT_OF_WORK, ORDER_REPOSITORY, ORDER_NUMBER_ALLOCATOR, ORDER_REFERENCE_DATA, STOCK_AVAILABILITY, CLOCK],
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
        db: OrdersDb,
        publisher: KafkaFactPublisher,
        clock: Clock,
        config: OutboxRelayConfig,
      ): OutboxRelay => new OutboxRelay({ db, publisher, clock, config }),
      inject: [ORDERS_DB, FACT_PUBLISHER, CLOCK, OUTBOX_RELAY_CONFIG],
    },
    OutboxRelayService,

    // ── order_saga_orchestrator (feature 16) ──────────────────────────────
    {
      provide: SAGA_COMMANDS,
      useFactory: (connection: NatsConnection): NatsSagaCommandsAdapter =>
        new NatsSagaCommandsAdapter(connection, loadSagaCommandDispatcherConfig().timeoutMs),
      inject: [NATS_CONNECTION],
    },
    {
      provide: SAGA_COMMAND_STORE,
      useFactory: (db: OrdersDb, clock: Clock): DrizzleSagaCommandStore => new DrizzleSagaCommandStore(db, clock),
      inject: [ORDERS_DB, CLOCK],
    },
    {
      // Class token — `@Inject(SagaFactHandler)` in the ten fact
      // `@CommandHandler`s resolves this. Composes `IdempotentConsumer`
      // (existing, unmodified) and `SagaIgnoredFactsRepository` directly —
      // neither gets its own module-level token, since nothing else in the
      // graph needs them (design.md §5.1's header note).
      provide: SagaFactHandler,
      useFactory: (
        unitOfWork: UnitOfWork,
        clock: Clock,
        orders: OrderRepository,
        commandStore: SagaCommandStore,
      ): SagaFactHandler =>
        new SagaFactHandler(
          new IdempotentConsumer(unitOfWork, clock),
          orders,
          commandStore,
          new SagaIgnoredFactsRepository(clock),
        ),
      inject: [UNIT_OF_WORK, CLOCK, ORDER_REPOSITORY, SAGA_COMMAND_STORE],
    },
    {
      provide: SAGA_COMMAND_DISPATCHER,
      useFactory: (
        commands: NatsSagaCommandsAdapter,
        store: SagaCommandStore,
      ): SagaCommandDispatcher => new SagaCommandDispatcher(commands, store, loadSagaCommandDispatcherConfig()),
      inject: [SAGA_COMMANDS, SAGA_COMMAND_STORE],
    },
    {
      provide: SAGA_COMMAND_SWEEPER_CONFIG,
      useFactory: (): SagaCommandSweeperConfig => loadSagaCommandSweeperConfig(),
    },
    SagaCommandSweeperService,
    OrderSagas,
    ...SAGA_FACT_COMMAND_HANDLERS,
    ...SAGA_DISPATCH_COMMAND_HANDLERS,
  ],
})
export class AppModule {}
