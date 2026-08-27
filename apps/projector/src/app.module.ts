// `CqrsModule.forRoot()` plus the ONE `@CommandHandler` as a class provider
// (decorator discovery needs the class) — everything else `useFactory` +
// `inject: [...]` with explicit tokens (CLAUDE.md § Explicit DI tokens).
// This service consumes only (projector-facts.controller.ts's header) and
// PUBLISHES the update signal on NATS (design.md §7) — it is the ONLY
// runtime writer of `order_timeline` (PR20) and issues NO RPC request to
// any service (PR21).
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { NatsConnection } from 'nats';
import { AppController } from './presentation/app.controller';
import { HealthController } from './presentation/health.controller';
import { ProjectorFactsController } from './presentation/projector-facts.controller';
import { ProjectFactCommandHandler } from './application/commands/project-fact.command-handler';
import { ProjectionApplyService } from './application/projection-apply.service';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { READ_MODEL_WRITER, type ReadModelWriter } from './application/ports/read-model-writer.port';
import { UPDATE_SIGNAL_PUBLISHER, type UpdateSignalPublisher } from './application/ports/update-signal.port';
import { createKafkaClient } from './infrastructure/messaging/create-kafka-client';
import { createKafkaHealthClient, KafkaHealthCheck } from './infrastructure/health/kafka-health-check';
import { MongoHealthCheck } from './infrastructure/health/mongo-health-check';
import {
  FACT_RETRY_DISPATCHER,
  FactRetryDispatcher,
  REAL_DELAY,
  loadFactRetryPolicy,
} from './infrastructure/messaging/fact-retry-dispatcher';
import { KafkaDlqPublisher } from './infrastructure/messaging/kafka-dlq-publisher';
import { loadKafkaConfig } from './infrastructure/messaging/kafka.config';
import { connectMongo, orderTimelineCollection, type MongoHandle } from './infrastructure/persistence/mongo-client';
import { loadMongoConfig } from './infrastructure/persistence/mongo.config';
import type { OrderTimelineDocument } from './infrastructure/persistence/order-timeline.document';
import { MongoReadModelWriter } from './infrastructure/persistence/mongo-read-model-writer';
import { createNatsConnection } from './infrastructure/signal/nats-client';
import { loadNatsConfig } from './infrastructure/signal/nats.config';
import { NatsUpdateSignalPublisher } from './infrastructure/signal/nats-update-signal.publisher';
import { SystemClock } from './infrastructure/system-clock';
import type { Collection, Db } from 'mongodb';

/** Module-local token — the outbound MongoDB connection handle. Exported (a plain symbol, not a domain port) so `main.ts` can retrieve the SAME connection via `app.get(MONGO_DB)` to run `ensureReadModelIndexes`/`backfillLegacyDocuments` BEFORE `startAllMicroservices()`, without opening a second client. */
export const MONGO_DB = Symbol('MongoDb');
/** Module-local token — the `order_timeline` collection every persistence provider below is built from. */
const READ_MODEL_COLLECTION = Symbol('ReadModelCollection');
/** The ONE outbound `NatsConnection` this service opens, for the update signal ONLY (design.md §7.1 — publish, never request). Exported (a plain symbol, not a domain port) so integration specs that exercise only the Kafka+MongoDB half (R50-R53, tasks.md group G) can `overrideProvider(NATS_CONNECTION)` with a fake, without needing a NATS broker for tests that are not about the signal at all — the signal itself (PR17-PR19) is proved separately, against a REAL NATS Testcontainers fixture, by update-signal.integration.spec.ts. */
export const NATS_CONNECTION = Symbol('NatsConnection');
/** Module-local token — the ONE `DlqPublisher` instance `FACT_RETRY_DISPATCHER` is built from (OR1/A4b) — same "module-local, not exported" shape apps/orders/src/app.module.ts uses for its own `DLQ_PUBLISHER`. A SEPARATE outbound Kafka producer from `UPDATE_SIGNAL_PUBLISHER`'s NATS connection above — this one targets `<topic>.dlq`, kafkajs, not NATS. */
const DLQ_PUBLISHER = Symbol('DlqPublisher');

/** Closes the outbound MongoDB connection on shutdown. */
class MongoConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly handle: MongoHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.client.close();
  }
}

/** Closes the outbound NATS connection on shutdown — same lifecycle discipline apps/orders' own `NatsConnectionCloser` gives its RPC connection. */
class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, ProjectorFactsController, HealthController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: MONGO_DB,
      useFactory: (): Promise<MongoHandle> => connectMongo(loadMongoConfig()),
    },
    {
      // R60/OR6 (A8) — design.md §4.6's Projector row: fact stream
      // (Kafka), this service's own store (MongoDB, `order_timeline`). No
      // RPC-transport check (PR21 — this service issues no RPC).
      provide: READINESS_CHECKS,
      useFactory: (handle: MongoHandle): readonly HealthCheck[] => [
        new MongoHealthCheck(handle.db as Db),
        new KafkaHealthCheck(createKafkaHealthClient(loadKafkaConfig())),
      ],
      inject: [MONGO_DB],
    },
    {
      provide: READ_MODEL_COLLECTION,
      useFactory: (handle: MongoHandle): Collection<OrderTimelineDocument> => orderTimelineCollection(handle.db),
      inject: [MONGO_DB],
    },
    {
      provide: MongoConnectionCloser,
      useFactory: (handle: MongoHandle): MongoConnectionCloser => new MongoConnectionCloser(handle),
      inject: [MONGO_DB],
    },
    {
      provide: NATS_CONNECTION,
      useFactory: (): Promise<NatsConnection> => createNatsConnection(loadNatsConfig()),
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
      provide: NatsConnectionCloser,
      useFactory: (connection: NatsConnection): NatsConnectionCloser => new NatsConnectionCloser(connection),
      inject: [NATS_CONNECTION],
    },
    {
      provide: READ_MODEL_WRITER,
      useFactory: (collection: Collection<OrderTimelineDocument>): ReadModelWriter =>
        new MongoReadModelWriter(collection),
      inject: [READ_MODEL_COLLECTION],
    },
    {
      provide: UPDATE_SIGNAL_PUBLISHER,
      useFactory: (connection: NatsConnection): UpdateSignalPublisher => new NatsUpdateSignalPublisher(connection),
      inject: [NATS_CONNECTION],
    },
    {
      // Class token — `@Inject(ProjectionApplyService)` in
      // ProjectFactCommandHandler resolves this.
      provide: ProjectionApplyService,
      useFactory: (
        writer: ReadModelWriter,
        publisher: UpdateSignalPublisher,
      ): ProjectionApplyService => new ProjectionApplyService(writer, publisher),
      inject: [READ_MODEL_WRITER, UPDATE_SIGNAL_PUBLISHER],
    },
    ProjectFactCommandHandler,
  ],
})
export class AppModule {}
