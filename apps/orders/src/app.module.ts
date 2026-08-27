import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import type { NatsConnection } from 'nats';
import { Kafka as KafkaJsClient } from 'kafkajs';
import type { Pool } from 'mysql2/promise';
import { AppController } from './presentation/app.controller';
import { CatalogReferenceListController } from './presentation/catalog-reference-list.controller';
import { HealthController } from './presentation/health.controller';
import { OrdersCancelController } from './presentation/orders-cancel.controller';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { SagaFactsController } from './presentation/saga-facts.controller';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { CATALOG_REFERENCE_LIST } from './application/ports/catalog-reference-list.port';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { ORDER_NUMBER_ALLOCATOR } from './application/ports/order-number-allocator.port';
import { ORDER_REFERENCE_DATA } from './application/ports/order-reference-data.port';
import { ORDER_REPOSITORY, type OrderRepository } from './application/ports/order-repository.port';
import { SAGA_COMMANDS } from './application/ports/saga-commands.port';
import { SAGA_COMMAND_STORE, type SagaCommandStore } from './application/ports/saga-command-store.port';
import { STOCK_AVAILABILITY } from './application/ports/stock-availability.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { CancelOrderHandler } from './application/cancel-order.handler';
import { PlaceOrderHandler } from './application/place-order.handler';
import { ListCatalogReferenceHandler } from './application/queries/list-catalog-reference.query';
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
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC, loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay, type DlqDepthPort } from './infrastructure/outbox/outbox-relay';
import { KafkaDlqDepth } from './infrastructure/observability/kafka-dlq-depth';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { KafkaHealthCheck, createKafkaHealthClient } from './infrastructure/health/kafka-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';
import { createNatsConnection } from './infrastructure/messaging/nats-client';
import { IdempotentConsumer } from './infrastructure/messaging/idempotent-consumer';
import { FACT_RETRY_DISPATCHER, FactRetryDispatcher, REAL_DELAY, loadFactRetryPolicy } from './infrastructure/messaging/fact-retry-dispatcher';
import { KafkaDlqPublisher } from './infrastructure/messaging/kafka-dlq-publisher';
import { loadNatsConfig, loadStockCheckTimeoutMs } from './infrastructure/messaging/nats.config';
import { NatsStockAvailabilityAdapter } from './infrastructure/messaging/nats-stock-availability.adapter';
import { NatsSagaCommandsAdapter } from './infrastructure/messaging/nats-saga-commands.adapter';
import { DrizzleSagaCommandStore } from './infrastructure/saga/drizzle-saga-command-store';
import { SagaIgnoredFactsRepository } from './infrastructure/saga/saga-ignored-facts.repository';
import { SAGA_COMMAND_DISPATCHER, SagaCommandDispatcher } from './infrastructure/saga/saga-command-dispatcher';
import { SagaFirstParkDeadLetterHandler } from './infrastructure/saga/saga-first-park-dead-letter-handler';
import { OtelSagaMetrics } from './infrastructure/observability/otel-saga-metrics';
import {
  SAGA_COMMAND_SWEEPER_CONFIG,
  SagaCommandSweeperService,
  type SagaCommandSweeperConfig,
} from './infrastructure/saga/saga-command-sweeper.service';
import { loadSagaCommandDispatcherConfig, loadSagaCommandSweeperConfig } from './infrastructure/saga/saga.config';

/** Module-local token — the raw `mysql2` `Pool` `ORDERS_DB` is built from. Exposed as its own provider (rather than left inline inside `ORDERS_DB`'s factory, as before A8) so `MysqlHealthCheck` (R60/OR6) can probe the SAME pool the app actually reads/writes through, without opening a second one. Not exported: nothing outside this module needs it. */
const ORDERS_DB_POOL = Symbol('OrdersDbPool');
/** Module-local token — the shared `OrdersDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const ORDERS_DB = Symbol('OrdersDb');
/** The ONE outbound `NatsConnection` this service opens for its own RPC calls (`fulfillment.stock.check` AND, since feature 16, the five saga commands — reused, no second connection; also NatsHealthCheck's R60/OR6 probe). Distinct from the INBOUND `orders.create`/Kafka transports, which `@nestjs/microservices` opens and owns itself (main.ts). Exported (A8, R60/OR6) — same "a plain symbol, not a domain port" shape `apps/projector/src/app.module.ts` already exports its own `NATS_CONNECTION` for: `health-probes.integration.spec.ts` overrides this with a real, pre-authenticated fixture connection (the `@testcontainers/nats` image requires `--user test --pass test`, which a bare `NATS_URL` env var cannot carry), the same reason every other integration harness in this repo overrides it too. */
export const NATS_CONNECTION = Symbol('NatsConnection');
/** Module-local token — the ONE `DlqPublisher` instance, shared by `FactRetryDispatcher` (OR1) and `SagaCommandDispatcher`'s park hook (OR3) — design.md §4.2 point 2: "via the same DlqPublisher §4.1 defines — reused, not a third variant." */
const DLQ_PUBLISHER = Symbol('DlqPublisher');
/** Module-local token — A7's `DlqDepthPort` (`otc_dlq_depth`, R59/OR5), a Kafka admin client connected once at bootstrap and reused by `OutboxRelay.runOnce()`'s own poll cycle. */
const DLQ_DEPTH_PORT = Symbol('DlqDepthPort');
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
  controllers: [
    AppController,
    OrdersCreateController,
    OrdersCancelController,
    CatalogReferenceListController,
    SagaFactsController,
    HealthController,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: ORDERS_DB_POOL,
      useFactory: (): Pool => createOrdersPool(loadOrdersDbConfig()),
    },
    {
      provide: ORDERS_DB,
      useFactory: (pool: Pool): OrdersDb => createOrdersDb(pool),
      inject: [ORDERS_DB_POOL],
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
    // `orders_catalog_responder` — an ALIAS (`useExisting`), not a second
    // `useFactory`: `DrizzleOrderReferenceDataRepository` implements BOTH
    // `OrderReferenceDataPort` and `CatalogReferenceListPort` (see that
    // port's own header comment), so this token resolves to the EXACT SAME
    // instance `ORDER_REFERENCE_DATA` above does — one adapter, one `OrdersDb`
    // connection, never a second repository that could read the four
    // reference tables differently.
    {
      provide: CATALOG_REFERENCE_LIST,
      useExisting: ORDER_REFERENCE_DATA,
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
      // R60/OR6 (A8) — design.md §4.6's Orders row: write model (MySQL),
      // fact stream (Kafka producer/admin ping), RPC transport (NATS). The
      // Kafka check uses a DEDICATED, short-timeout, no-retry client
      // (`createKafkaHealthClient`) rather than the outbox's own
      // long-lived producer — see kafka-health-check.ts's header for why.
      provide: READINESS_CHECKS,
      useFactory: (pool: Pool, connection: NatsConnection): readonly HealthCheck[] => [
        new MysqlHealthCheck(pool),
        new KafkaHealthCheck(createKafkaHealthClient(loadKafkaConfig())),
        new NatsHealthCheck(connection),
      ],
      inject: [ORDERS_DB_POOL, NATS_CONNECTION],
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
      // `orders_cancel_responder` (feature 41) — `SAGA_COMMAND_STORE` and
      // `CommandBus` (the same fast-path hop `saga-dispatch.handlers.ts`
      // uses) are wired here rather than resolved lazily, so this handler's
      // `stock_reserved` branch reuses R27/R28's EXACT durable-command
      // mechanism, never a second one. `ORDERS_FACTS_TOPIC` is threaded in
      // as a plain string — see cancel-order.handler.ts's own header for
      // why the application layer does not import the infrastructure
      // constant itself.
      provide: CancelOrderHandler,
      useFactory: (
        unitOfWork: DrizzleUnitOfWork,
        orders: DrizzleOrderRepository,
        commandStore: DrizzleSagaCommandStore,
        commandBus: CommandBus,
        clock: Clock,
      ): CancelOrderHandler => new CancelOrderHandler(unitOfWork, orders, commandStore, commandBus, clock, ORDERS_FACTS_TOPIC),
      inject: [UNIT_OF_WORK, ORDER_REPOSITORY, SAGA_COMMAND_STORE, CommandBus, CLOCK],
    },
    {
      provide: FACT_PUBLISHER,
      useFactory: (): KafkaFactPublisher => new KafkaFactPublisher(createKafkaClient(loadKafkaConfig())),
    },
    {
      provide: DLQ_PUBLISHER,
      useFactory: (): KafkaDlqPublisher => new KafkaDlqPublisher(createKafkaClient(loadKafkaConfig())),
    },
    {
      provide: FACT_RETRY_DISPATCHER,
      useFactory: (clock: Clock, dlq: KafkaDlqPublisher): FactRetryDispatcher =>
        new FactRetryDispatcher(clock, REAL_DELAY, dlq, loadFactRetryPolicy()),
      inject: [CLOCK, DLQ_PUBLISHER],
    },
    {
      provide: OUTBOX_RELAY_CONFIG,
      useFactory: (): OutboxRelayConfig => loadOutboxRelayConfig(),
    },
    {
      // A7 (metrics, R59/OR5) — `otc_dlq_depth`'s admin client, connected
      // once at bootstrap; `KafkaDlqDepth` reuses it for every poll cycle
      // rather than reconnecting per call.
      provide: DLQ_DEPTH_PORT,
      useFactory: async (): Promise<DlqDepthPort> => {
        const kafkaConfig = loadKafkaConfig();
        const admin = new KafkaJsClient({ clientId: kafkaConfig.clientId, brokers: [...kafkaConfig.brokers] }).admin();
        await admin.connect();
        return new KafkaDlqDepth(admin);
      },
    },
    {
      provide: OUTBOX_RELAY,
      useFactory: (
        db: OrdersDb,
        publisher: KafkaFactPublisher,
        clock: Clock,
        config: OutboxRelayConfig,
        dlqDepth: DlqDepthPort,
      ): OutboxRelay =>
        new OutboxRelay({
          db,
          publisher,
          clock,
          config,
          dlqDepth,
          dlqTopics: [`${ORDERS_FACTS_TOPIC}.dlq`, `${FULFILLMENT_FACTS_TOPIC}.dlq`, `${BILLING_FACTS_TOPIC}.dlq`],
        }),
      inject: [ORDERS_DB, FACT_PUBLISHER, CLOCK, OUTBOX_RELAY_CONFIG, DLQ_DEPTH_PORT],
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
          new OtelSagaMetrics(),
        ),
      inject: [UNIT_OF_WORK, CLOCK, ORDER_REPOSITORY, SAGA_COMMAND_STORE],
    },
    {
      provide: SAGA_COMMAND_DISPATCHER,
      useFactory: (
        commands: NatsSagaCommandsAdapter,
        store: SagaCommandStore,
        dlq: KafkaDlqPublisher,
        unitOfWork: DrizzleUnitOfWork,
        orders: DrizzleOrderRepository,
        clock: Clock,
      ): SagaCommandDispatcher =>
        new SagaCommandDispatcher(
          commands,
          store,
          loadSagaCommandDispatcherConfig(),
          undefined,
          undefined,
          new SagaFirstParkDeadLetterHandler(dlq, unitOfWork, orders, clock),
        ),
      inject: [SAGA_COMMANDS, SAGA_COMMAND_STORE, DLQ_PUBLISHER, UNIT_OF_WORK, ORDER_REPOSITORY, CLOCK],
    },
    {
      provide: SAGA_COMMAND_SWEEPER_CONFIG,
      useFactory: (): SagaCommandSweeperConfig => loadSagaCommandSweeperConfig(),
    },
    SagaCommandSweeperService,
    OrderSagas,
    ...SAGA_FACT_COMMAND_HANDLERS,
    ...SAGA_DISPATCH_COMMAND_HANDLERS,

    // ── orders_catalog_responder ────────────────────────────────────────
    ListCatalogReferenceHandler,
  ],
})
export class AppModule {}
