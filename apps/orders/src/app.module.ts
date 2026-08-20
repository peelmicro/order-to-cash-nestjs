import { Module } from '@nestjs/common';
import { AppController } from './presentation/app.controller';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { createOrdersDb, createOrdersPool, type OrdersDb } from './infrastructure/persistence/client';
import { loadOrdersDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';

/** Module-local token — the shared `OrdersDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const ORDERS_DB = Symbol('OrdersDb');

@Module({
  controllers: [AppController],
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
