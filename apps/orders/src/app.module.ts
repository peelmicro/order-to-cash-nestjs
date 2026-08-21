import { Module, type OnApplicationShutdown } from '@nestjs/common';
import type { NatsConnection } from 'nats';
import { AppController } from './presentation/app.controller';
import { OrdersCreateController } from './presentation/orders-create.controller';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { ORDER_NUMBER_ALLOCATOR } from './application/ports/order-number-allocator.port';
import { ORDER_REFERENCE_DATA } from './application/ports/order-reference-data.port';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { STOCK_AVAILABILITY } from './application/ports/stock-availability.port';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { PlaceOrderHandler } from './application/place-order.handler';
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
import { loadNatsConfig, loadStockCheckTimeoutMs } from './infrastructure/messaging/nats.config';
import { NatsStockAvailabilityAdapter } from './infrastructure/messaging/nats-stock-availability.adapter';

/** Module-local token — the shared `OrdersDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const ORDERS_DB = Symbol('OrdersDb');
/** Module-local token — the ONE outbound `NatsConnection` this service opens for its own RPC calls (`fulfillment.stock.check`). Distinct from the INBOUND `orders.create` transport, which `@nestjs/microservices` opens and owns itself (main.ts). */
const NATS_CONNECTION = Symbol('NatsConnection');

/** Closes the outbound NATS connection on shutdown — the same lifecycle discipline `KafkaFactPublisher.disconnect()` gives the outbox relay's producer. */
class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Module({
  controllers: [AppController, OrdersCreateController],
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
  ],
})
export class AppModule {}
