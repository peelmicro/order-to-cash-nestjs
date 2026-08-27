// design.md §6, §14: `CqrsModule.forRoot()`, the two `@nestjs/cqrs`
// handlers as CLASS providers (decorator discovery needs the class),
// everything else wired with `useFactory` + `inject: [...]` — the same
// shape `apps/orders/src/app.module.ts` and `apps/fulfillment/src/app.module.ts`
// established. `CREDIT_DECISION` is bound to `SimulatorCreditDecision`
// (feature 20, requirements.md §5.1, R42–R44) — the ONE provider feature
// 20 replaces. Bound UNCONDITIONALLY, not behind an env flag: there is no
// second, real credit-assessment adapter in this codebase to choose
// between, `CREDIT_FAILURE_RATE` defaults to `0` so the simulator is a
// pure superset of `AlwaysApproveCreditDecision`'s behaviour at its
// default (it only ever narrows an approval — credit-decision.port.ts),
// and every existing amount used by the fixtures in
// `credit-hold.integration.spec.ts` / `credit-hold-race.integration.spec.ts`
// / `credit-wire.integration.spec.ts` / `credit-list.integration.spec.ts`
// avoids `…99` deliberately, so those harnesses keep passing unchanged.
// `AlwaysApproveCreditDecision` remains in the tree, still covered by its
// own spec — nothing about this feature deletes it, only app.module.ts's
// binding moves off it.
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { NatsConnection } from 'nats';
import type { Pool } from 'mysql2/promise';
import { AppController } from './presentation/app.controller';
import { HealthController } from './presentation/health.controller';
import { CreditController } from './presentation/credit.controller';
import { InvoiceController } from './presentation/invoice.controller';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { BUYER_CREDIT_REPOSITORY } from './application/ports/buyer-credit-repository.port';
import { CREDIT_DECISION } from './application/ports/credit-decision.port';
import { CREDIT_READ } from './application/ports/credit-read.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { INVOICE_NUMBER_ALLOCATOR } from './application/ports/invoice-number-allocator.port';
import { INVOICE_READ } from './application/ports/invoice-read.port';
import { INVOICE_REPOSITORY } from './application/ports/invoice-repository.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { CREDIT_COMMAND_HANDLERS } from './application/commands/credit.command-handlers';
import { CREDIT_QUERY_HANDLERS } from './application/queries/credit.query-handlers';
import { INVOICE_COMMAND_HANDLERS } from './application/commands/invoice.command-handlers';
import { INVOICE_QUERY_HANDLERS } from './application/queries/invoice.query-handlers';
import { PAYMENT_COMMAND_HANDLERS } from './application/commands/payment.command-handlers';
import { CreditHoldHandler } from './application/credit-hold.handler';
import { InvoiceIssueHandler } from './application/invoice-issue.handler';
import { PaymentRegisterHandler } from './application/payment-register.handler';
import type { CreditDecisionPort } from './application/ports/credit-decision.port';
import type { BuyerCreditRepository } from './application/ports/buyer-credit-repository.port';
import type { InvoiceNumberAllocator } from './application/ports/invoice-number-allocator.port';
import type { InvoiceRepository } from './application/ports/invoice-repository.port';
import { loadCreditSimulatorConfig, SimulatorCreditDecision } from './infrastructure/credit/simulator-credit-decision';
import { createBillingDb, createBillingPool, type BillingDb } from './infrastructure/persistence/client';
import { loadBillingDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from './infrastructure/persistence/buyer-credit.repository';
import { DrizzleCreditReadRepository } from './infrastructure/persistence/credit-read.repository';
import { DrizzleInvoiceNumberAllocator } from './infrastructure/persistence/invoice-number-allocator';
import { DrizzleInvoiceReadRepository } from './infrastructure/persistence/invoice-read.repository';
import { DrizzleInvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';
import { createNatsConnection } from './infrastructure/messaging/nats-client';
import { loadNatsConfig } from './infrastructure/messaging/nats.config';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';

/** Module-local token — the raw `mysql2` `Pool` `BILLING_DB` is built from. Exposed as its own provider (A8) so `MysqlHealthCheck` (R60/OR6) can probe the SAME pool the app actually reads/writes through, without opening a second one. Not exported: nothing outside this module needs it. */
const BILLING_DB_POOL = Symbol('BillingDbPool');
/** Module-local token — the shared `BillingDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const BILLING_DB = Symbol('BillingDb');
/** The ONE outbound `NatsConnection` this service opens — SOLELY for `NatsHealthCheck`'s R60/OR6 probe, same reasoning as `apps/fulfillment/src/app.module.ts`'s own copy: Billing issues no outbound RPC call of its own in this feature, only inbound `billing.credit.*` responders. Exported (A8) for the same reason those services export theirs: `health-probes.integration.spec.ts` overrides this with a real, pre-authenticated fixture connection. */
export const NATS_CONNECTION = Symbol('NatsConnection');

/** Closes the outbound NATS connection on shutdown — same lifecycle discipline as every other service's own `NatsConnectionCloser`. */
class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, CreditController, InvoiceController, HealthController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: BILLING_DB_POOL,
      useFactory: (): Pool => createBillingPool(loadBillingDbConfig()),
    },
    {
      provide: BILLING_DB,
      useFactory: (pool: Pool): BillingDb => createBillingDb(pool),
      inject: [BILLING_DB_POOL],
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
      // R60/OR6 (A8) — design.md §4.6's Billing row: write model (MySQL),
      // RPC transport (NATS). No fact-stream check (this service consumes
      // no fact in this feature).
      provide: READINESS_CHECKS,
      useFactory: (pool: Pool, connection: NatsConnection): readonly HealthCheck[] => [
        new MysqlHealthCheck(pool),
        new NatsHealthCheck(connection),
      ],
      inject: [BILLING_DB_POOL, NATS_CONNECTION],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: BillingDb): DrizzleUnitOfWork => new DrizzleUnitOfWork(db),
      inject: [BILLING_DB],
    },
    {
      provide: BUYER_CREDIT_REPOSITORY,
      useFactory: (db: BillingDb, clock: Clock): DrizzleBuyerCreditRepository => new DrizzleBuyerCreditRepository(db, clock),
      inject: [BILLING_DB, CLOCK],
    },
    {
      provide: CREDIT_READ,
      useFactory: (db: BillingDb): DrizzleCreditReadRepository => new DrizzleCreditReadRepository(db),
      inject: [BILLING_DB],
    },
    {
      // Throws synchronously (via `loadCreditSimulatorConfig`) when
      // `CREDIT_FAILURE_RATE` is set to a value outside `[0, 1]` — Nest's
      // module compilation fails and the service fails to start,
      // reporting the offending value (R43's last clause).
      provide: CREDIT_DECISION,
      useFactory: (): SimulatorCreditDecision => new SimulatorCreditDecision(loadCreditSimulatorConfig()),
    },
    {
      provide: CreditHoldHandler,
      useFactory: (
        unitOfWork: UnitOfWork,
        credits: BuyerCreditRepository,
        decision: CreditDecisionPort,
        clock: Clock,
      ): CreditHoldHandler => new CreditHoldHandler(unitOfWork, credits, decision, clock),
      inject: [UNIT_OF_WORK, BUYER_CREDIT_REPOSITORY, CREDIT_DECISION, CLOCK],
    },
    {
      provide: INVOICE_REPOSITORY,
      useFactory: (db: BillingDb, clock: Clock): DrizzleInvoiceRepository => new DrizzleInvoiceRepository(db, clock),
      inject: [BILLING_DB, CLOCK],
    },
    {
      provide: INVOICE_READ,
      useFactory: (db: BillingDb): DrizzleInvoiceReadRepository => new DrizzleInvoiceReadRepository(db),
      inject: [BILLING_DB],
    },
    {
      provide: INVOICE_NUMBER_ALLOCATOR,
      useFactory: (): DrizzleInvoiceNumberAllocator => new DrizzleInvoiceNumberAllocator(),
    },
    {
      provide: InvoiceIssueHandler,
      useFactory: (
        unitOfWork: UnitOfWork,
        credits: BuyerCreditRepository,
        invoices: InvoiceRepository,
        invoiceNumbers: InvoiceNumberAllocator,
        clock: Clock,
      ): InvoiceIssueHandler => new InvoiceIssueHandler(unitOfWork, credits, invoices, invoiceNumbers, clock),
      inject: [UNIT_OF_WORK, BUYER_CREDIT_REPOSITORY, INVOICE_REPOSITORY, INVOICE_NUMBER_ALLOCATOR, CLOCK],
    },
    {
      provide: PaymentRegisterHandler,
      useFactory: (unitOfWork: UnitOfWork, credits: BuyerCreditRepository, invoices: InvoiceRepository, clock: Clock): PaymentRegisterHandler =>
        new PaymentRegisterHandler(unitOfWork, credits, invoices, clock),
      inject: [UNIT_OF_WORK, BUYER_CREDIT_REPOSITORY, INVOICE_REPOSITORY, CLOCK],
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
      useFactory: (db: BillingDb, publisher: KafkaFactPublisher, clock: Clock, config: OutboxRelayConfig): OutboxRelay =>
        new OutboxRelay({ db, publisher, clock, config }),
      inject: [BILLING_DB, FACT_PUBLISHER, CLOCK, OUTBOX_RELAY_CONFIG],
    },
    OutboxRelayService,

    ...CREDIT_QUERY_HANDLERS,
    ...CREDIT_COMMAND_HANDLERS,
    ...INVOICE_QUERY_HANDLERS,
    ...INVOICE_COMMAND_HANDLERS,
    ...PAYMENT_COMMAND_HANDLERS,
  ],
})
export class AppModule {}
