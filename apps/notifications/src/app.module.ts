// `CqrsModule.forRoot()` plus the seven fact `@CommandHandler`s as CLASS
// providers (decorator discovery needs the class) — everything else wired
// with `useFactory` + `inject: [...]`, same shape every other service's
// `app.module.ts` establishes (CLAUDE.md § Explicit DI tokens). No NATS
// client, no outbox: this service consumes only
// (notification-facts.controller.ts's header). It DOES now own a MySQL
// connection to `otc_notifications` — the durable `processed_events`
// ledger added in the re-review (N1/N2), the same canonical shape
// orders/fulfillment/billing already use.
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { Pool } from 'mysql2/promise';
import { AppController } from './presentation/app.controller';
import { HealthController } from './presentation/health.controller';
import { NotificationFactsController } from './presentation/notification-facts.controller';
import { NOTIFY_COMMAND_HANDLERS } from './application/commands/notify.command-handlers';
import { NotificationDispatchService } from './application/notification-dispatch.service';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { NOTIFICATION_SENDER, type NotificationSender } from './application/ports/notification-sender.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { IdempotentConsumer } from './infrastructure/messaging/idempotent-consumer';
import { createKafkaClient } from './infrastructure/messaging/create-kafka-client';
import {
  FACT_RETRY_DISPATCHER,
  FactRetryDispatcher,
  REAL_DELAY,
  loadFactRetryPolicy,
} from './infrastructure/messaging/fact-retry-dispatcher';
import { KafkaDlqPublisher } from './infrastructure/messaging/kafka-dlq-publisher';
import { loadKafkaConfig } from './infrastructure/messaging/kafka.config';
import { DrizzleProcessedEventCompensation } from './infrastructure/messaging/processed-events-compensation';
import { ConsoleNotificationSender } from './infrastructure/notification/console-notification-sender';
import { DegradingNotificationSender } from './infrastructure/notification/degrading-notification-sender';
import { MailtrapNotificationSender } from './infrastructure/notification/mailtrap-notification-sender';
import { resolveNotificationSenderBinding } from './infrastructure/notification/mailtrap.config';
import { createNotificationsDb, createNotificationsPool, type NotificationsDb } from './infrastructure/persistence/client';
import { loadNotificationsDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { SystemClock } from './infrastructure/system-clock';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { createKafkaHealthClient, KafkaHealthCheck } from './infrastructure/health/kafka-health-check';

/** Module-local token — the raw `mysql2` `Pool` `NOTIFICATIONS_DB` is built from. Exposed as its own provider (A8) so `MysqlHealthCheck` (R60/OR6) can probe the SAME pool the app actually reads/writes through, without opening a second one. Not exported: nothing outside this module needs it. */
const NOTIFICATIONS_DB_POOL = Symbol('NotificationsDbPool');
/** Module-local token — the shared `NotificationsDb` connection `UNIT_OF_WORK` is built from. Not exported: nothing outside this module needs the raw Drizzle handle (same "module-local, not exported" shape apps/fulfillment/apps/orders use for their own DB token). */
const NOTIFICATIONS_DB = Symbol('NotificationsDb');
/** Module-local token — the ONE `DlqPublisher` instance `FACT_RETRY_DISPATCHER` is built from (OR1/A4b) — same "module-local, not exported" shape apps/orders/src/app.module.ts uses for its own `DLQ_PUBLISHER`. */
const DLQ_PUBLISHER = Symbol('DlqPublisher');

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, NotificationFactsController, HealthController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: NOTIFICATIONS_DB_POOL,
      useFactory: (): Pool => createNotificationsPool(loadNotificationsDbConfig()),
    },
    {
      provide: NOTIFICATIONS_DB,
      useFactory: (pool: Pool): NotificationsDb => createNotificationsDb(pool),
      inject: [NOTIFICATIONS_DB_POOL],
    },
    {
      provide: DLQ_PUBLISHER,
      useFactory: (): KafkaDlqPublisher => new KafkaDlqPublisher(createKafkaClient(loadKafkaConfig())),
    },
    {
      // R60/OR6 (A8) — design.md §4.6's Notifications row: fact stream
      // (Kafka), this service's own store (MySQL, `processed_events`). No
      // RPC-transport check (this service issues no RPC).
      provide: READINESS_CHECKS,
      useFactory: (pool: Pool): readonly HealthCheck[] => [
        new MysqlHealthCheck(pool),
        new KafkaHealthCheck(createKafkaHealthClient(loadKafkaConfig())),
      ],
      inject: [NOTIFICATIONS_DB_POOL],
    },
    {
      provide: FACT_RETRY_DISPATCHER,
      useFactory: (clock: Clock, dlq: KafkaDlqPublisher): FactRetryDispatcher =>
        new FactRetryDispatcher(clock, REAL_DELAY, dlq, loadFactRetryPolicy()),
      inject: [CLOCK, DLQ_PUBLISHER],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: NotificationsDb): DrizzleUnitOfWork => new DrizzleUnitOfWork(db),
      inject: [NOTIFICATIONS_DB],
    },
    {
      // The port-plus-two-adapters binding (feature 23's brief): Mailtrap
      // when mailtrap.config.ts finds a complete, valid-looking credential
      // pair; console otherwise (and always in every automated test, which
      // never sets MAILTRAP_USER/MAILTRAP_PASSWORD to a real value).
      //
      // Graceful-degradation addendum: when Mailtrap IS bound, it is never
      // handed to the rest of the app directly — it is wrapped in
      // `DegradingNotificationSender`, which reconsiders on EVERY send
      // (not once at startup, this factory's own former limitation) and
      // falls back to a `ConsoleNotificationSender` for a PERMANENT
      // failure (quota exhausted, bad credentials, malformed recipient)
      // while leaving a TRANSIENT failure's retry-then-DLQ behaviour
      // completely unchanged (see degrading-notification-sender.ts's
      // header). Console-only binding has nothing to degrade from, so it
      // is left unwrapped.
      provide: NOTIFICATION_SENDER,
      useFactory: (): NotificationSender => {
        const binding = resolveNotificationSenderBinding();
        return binding.kind === 'mailtrap'
          ? new DegradingNotificationSender(new MailtrapNotificationSender(binding.config), new ConsoleNotificationSender())
          : new ConsoleNotificationSender();
      },
    },
    {
      // Class token — `@Inject(NotificationDispatchService)` in the seven
      // fact `@CommandHandler`s resolves this. Composes the CANONICAL,
      // UNMODIFIED `IdempotentConsumer` (byte-identical to
      // apps/fulfillment's own copy — N1/N2) directly, same "compose the
      // existing, unmodified dedup class inline, no module-level token of
      // its own" shape apps/orders/src/app.module.ts uses for
      // `SagaFactHandler` + `IdempotentConsumer`. `DrizzleProcessedEventCompensation`
      // is N6's compensating delete, sharing the SAME `unitOfWork` (and
      // therefore the same `otc_notifications` connection pool) so its
      // DELETE really does undo the INSERT `IdempotentConsumer.runOnce`
      // committed moments earlier.
      provide: NotificationDispatchService,
      useFactory: (
        unitOfWork: UnitOfWork,
        clock: Clock,
        sender: NotificationSender,
      ): NotificationDispatchService =>
        new NotificationDispatchService(
          new IdempotentConsumer(unitOfWork, clock),
          sender,
          new DrizzleProcessedEventCompensation(unitOfWork),
        ),
      inject: [UNIT_OF_WORK, CLOCK, NOTIFICATION_SENDER],
    },
    ...NOTIFY_COMMAND_HANDLERS,
  ],
})
export class AppModule {}
