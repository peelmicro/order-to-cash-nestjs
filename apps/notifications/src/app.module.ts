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
import { AppController } from './presentation/app.controller';
import { NotificationFactsController } from './presentation/notification-facts.controller';
import { NOTIFY_COMMAND_HANDLERS } from './application/commands/notify.command-handlers';
import { NotificationDispatchService } from './application/notification-dispatch.service';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { NOTIFICATION_SENDER, type NotificationSender } from './application/ports/notification-sender.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { IdempotentConsumer } from './infrastructure/messaging/idempotent-consumer';
import { DrizzleProcessedEventCompensation } from './infrastructure/messaging/processed-events-compensation';
import { ConsoleNotificationSender } from './infrastructure/notification/console-notification-sender';
import { MailtrapNotificationSender } from './infrastructure/notification/mailtrap-notification-sender';
import { resolveNotificationSenderBinding } from './infrastructure/notification/mailtrap.config';
import { createNotificationsDb, createNotificationsPool, type NotificationsDb } from './infrastructure/persistence/client';
import { loadNotificationsDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { SystemClock } from './infrastructure/system-clock';

/** Module-local token — the shared `NotificationsDb` connection `UNIT_OF_WORK` is built from. Not exported: nothing outside this module needs the raw Drizzle handle (same "module-local, not exported" shape apps/fulfillment/apps/orders use for their own DB token). */
const NOTIFICATIONS_DB = Symbol('NotificationsDb');

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, NotificationFactsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: NOTIFICATIONS_DB,
      useFactory: (): NotificationsDb => createNotificationsDb(createNotificationsPool(loadNotificationsDbConfig())),
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
      provide: NOTIFICATION_SENDER,
      useFactory: (): NotificationSender => {
        const binding = resolveNotificationSenderBinding();
        return binding.kind === 'mailtrap'
          ? new MailtrapNotificationSender(binding.config)
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
