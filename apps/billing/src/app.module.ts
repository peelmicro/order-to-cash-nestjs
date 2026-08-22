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
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AppController } from './presentation/app.controller';
import { CreditController } from './presentation/credit.controller';
import { CLOCK, type Clock } from './application/ports/clock.port';
import { BUYER_CREDIT_REPOSITORY } from './application/ports/buyer-credit-repository.port';
import { CREDIT_DECISION } from './application/ports/credit-decision.port';
import { CREDIT_READ } from './application/ports/credit-read.port';
import { FACT_PUBLISHER } from './application/ports/fact-publisher.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work.port';
import { CREDIT_COMMAND_HANDLERS } from './application/commands/credit.command-handlers';
import { CREDIT_QUERY_HANDLERS } from './application/queries/credit.query-handlers';
import { CreditHoldHandler } from './application/credit-hold.handler';
import type { CreditDecisionPort } from './application/ports/credit-decision.port';
import type { BuyerCreditRepository } from './application/ports/buyer-credit-repository.port';
import { loadCreditSimulatorConfig, SimulatorCreditDecision } from './infrastructure/credit/simulator-credit-decision';
import { createBillingDb, createBillingPool, type BillingDb } from './infrastructure/persistence/client';
import { loadBillingDbConfig } from './infrastructure/persistence/db-config';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from './infrastructure/persistence/buyer-credit.repository';
import { DrizzleCreditReadRepository } from './infrastructure/persistence/credit-read.repository';
import { SystemClock } from './infrastructure/system-clock';
import { createKafkaClient } from './infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from './infrastructure/outbox/kafka-fact-publisher';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import { loadOutboxRelayConfig, type OutboxRelayConfig } from './infrastructure/outbox/outbox-relay.config';
import { OUTBOX_RELAY, OUTBOX_RELAY_CONFIG, OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';

/** Module-local token — the shared `BillingDb` connection every persistence provider below is built from. Not exported: nothing outside this module needs to depend on the raw Drizzle handle. */
const BILLING_DB = Symbol('BillingDb');

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [AppController, CreditController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: BILLING_DB,
      useFactory: (): BillingDb => createBillingDb(createBillingPool(loadBillingDbConfig())),
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
  ],
})
export class AppModule {}
