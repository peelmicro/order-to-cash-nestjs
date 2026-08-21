// Shared Testcontainers harness for the `order_saga_orchestrator`
// integration specs (design.md §8.1): real MySQL (mysql:8.4.11), real
// Kafka (apache/kafka:4.3.1, 6-partition topics), real NATS
// (nats:2.14.5-alpine), and a real `NestApplication` hosting
// `SagaFactsController` + the full cqrs wiring (fifteen `@CommandHandler`s,
// `OrderSagas`, the sweeper), built the same way `app.module.ts` does but
// pointed at the fixtures' own connections rather than process-env config
// (same shape `orders-acceptance.integration.spec.ts` already uses).
//
// NOT itself a `*.spec.ts` file — neither vitest config picks it up.
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import type { NatsConnection } from 'nats';
import { connect } from 'nats';
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput } from '../domain/order';
import { CLOCK } from '../application/ports/clock.port';
import { ORDER_REPOSITORY, type OrderRepository } from '../application/ports/order-repository.port';
import { SAGA_COMMANDS } from '../application/ports/saga-commands.port';
import { SAGA_COMMAND_STORE, type SagaCommandStore } from '../application/ports/saga-command-store.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.port';
import { SagaFactHandler } from '../application/saga-fact-handler';
import { SAGA_DISPATCH_COMMAND_HANDLERS } from '../application/commands/saga-dispatch.handlers';
import { SAGA_FACT_COMMAND_HANDLERS } from '../application/commands/saga-fact.handlers';
import { OrderSagas } from '../application/sagas/order.sagas';
import { SagaFactsController } from '../presentation/saga-facts.controller';
import { DrizzleUnitOfWork } from '../infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../infrastructure/persistence/order.repository';
import * as ordersSchema from '../infrastructure/persistence/schema/index';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_COMPANY_GLN,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  FIXTURE_RETAILER_GLN,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../infrastructure/persistence/test-support/orders-test-fixture';
import { FakeClock } from '../infrastructure/persistence/test-support/fake-clock';
import { IdempotentConsumer } from '../infrastructure/messaging/idempotent-consumer';
import { createKafkaClient } from '../infrastructure/outbox/create-kafka-client';
import { KafkaFactPublisher } from '../infrastructure/outbox/kafka-fact-publisher';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';
import { OutboxRelay } from '../infrastructure/outbox/outbox-relay';
import {
  createTopic,
  KAFKA_TEST_CLIENT_RETRY,
  startKafkaTestFixture,
  waitForConsumerGroupReady,
  type KafkaTestFixture,
} from '../infrastructure/outbox/test-support/kafka-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from '../infrastructure/messaging/test-support/nats-test-fixture';
import { NatsSagaCommandsAdapter } from '../infrastructure/messaging/nats-saga-commands.adapter';
import { DrizzleSagaCommandStore } from '../infrastructure/saga/drizzle-saga-command-store';
import { SagaIgnoredFactsRepository } from '../infrastructure/saga/saga-ignored-facts.repository';
import {
  SAGA_COMMAND_DISPATCHER,
  SagaCommandDispatcher,
  type SagaCommandDispatcherConfig,
} from '../infrastructure/saga/saga-command-dispatcher';
import {
  SAGA_COMMAND_SWEEPER_CONFIG,
  SagaCommandSweeperService,
  type SagaCommandSweeperConfig,
} from '../infrastructure/saga/saga-command-sweeper.service';
import type { ResolveOrderId } from '../infrastructure/messaging/test-support/stub-saga-responders';

export const SAGA_CONSUMER_GROUP = 'orders.saga';

export interface SagaIntegrationHarnessOptions {
  readonly dispatcherConfig?: Partial<SagaCommandDispatcherConfig>;
  readonly sweeperConfig?: Partial<SagaCommandSweeperConfig>;
  /** Wraps the real `OrderRepository` before it is wired into the app — the SO1/E3 specs use this to inject a controllable, transient failure without touching the shared fixture plumbing. */
  readonly wrapOrderRepository?: (real: OrderRepository) => OrderRepository;
}

export interface PreparedSagaFixtures {
  readonly mysqlFixture: OrdersTestFixture;
  readonly kafkaFixture: KafkaTestFixture;
  readonly natsFixture: NatsTestFixture;
  readonly clock: FakeClock;
  readonly unitOfWork: UnitOfWork;
  readonly orders: OrderRepository;
  readonly commandStore: SagaCommandStore;
  readonly ordersFactPublisher: KafkaFactPublisher;
  readonly fulfillmentFactPublisher: KafkaFactPublisher;
  readonly billingFactPublisher: KafkaFactPublisher;
  readonly appNatsConnection: NatsConnection;
  readonly testNatsConnection: NatsConnection;
  readonly dispatcherConfig: SagaCommandDispatcherConfig;
  readonly sweeperConfig: SagaCommandSweeperConfig;
  readonly resolveOrderId: ResolveOrderId;
  placeOrder(overrides?: Partial<PlaceOrderInput>): Promise<Order>;
  placeOrderAndRelay(overrides?: Partial<PlaceOrderInput>): Promise<Order>;
  teardownFixturesOnly(): Promise<void>;
}

export interface SagaIntegrationHarness {
  readonly mysqlFixture: OrdersTestFixture;
  readonly kafkaFixture: KafkaTestFixture;
  readonly natsFixture: NatsTestFixture;
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly db: OrdersTestFixture['db'];
  /** Publishes to `otc.orders.facts.v1` — used to relay `order.placed.v1` after `placeOrder`. */
  readonly ordersFactPublisher: KafkaFactPublisher;
  readonly fulfillmentFactPublisher: KafkaFactPublisher;
  readonly billingFactPublisher: KafkaFactPublisher;
  /** A NATS connection the test itself owns — for stub responders or direct probes. */
  readonly testNatsConnection: NatsConnection;
  readonly resolveOrderId: ResolveOrderId;
  placeOrder(overrides?: Partial<PlaceOrderInput>): Promise<Order>;
  /** Places an order AND relays its `order.placed.v1` fact over real Kafka via the real `OutboxRelay` — the harness's "an order already exists and the saga's first fact has arrived" fixture. */
  placeOrderAndRelay(overrides?: Partial<PlaceOrderInput>): Promise<Order>;
  teardown(): Promise<void>;
}

const FIXTURE_BUYER_GLN = FIXTURE_RETAILER_GLN;
const FIXTURE_SUPPLIER_GLN = FIXTURE_COMPANY_GLN;

function placeOrderInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  const line: PlaceOrderLineInput = {
    productCode: FIXTURE_PRODUCT_CODE,
    description: 'Widget',
    quantity: Quantity.of(2),
    unitPrice: Money.of(1_000, FIXTURE_CURRENCY),
    lineDiscount: Money.of(0, FIXTURE_CURRENCY),
  };
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(Math.floor(Math.random() * 900_000) + 1),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: GLN.of(FIXTURE_BUYER_GLN), code: FIXTURE_RETAILER_CODE },
    supplier: { gln: GLN.of(FIXTURE_SUPPLIER_GLN), code: FIXTURE_COMPANY_CODE },
    currency: FIXTURE_CURRENCY,
    lines: [line],
    ...overrides,
  };
}

/**
 * Stage 1 — starts every Testcontainers fixture and builds the plain
 * (non-Nest) collaborators, but does NOT build or start the Nest app or
 * its Kafka consumer group. Split out so SO1 can publish a fact BEFORE the
 * consumer group's first-ever subscription, and E3 can wrap the
 * repository, before `startSagaAppFromFixtures` brings the app up.
 */
export async function prepareSagaFixtures(options: SagaIntegrationHarnessOptions = {}): Promise<PreparedSagaFixtures> {
  const [mysqlFixture, kafkaFixture, natsFixture] = await Promise.all([
    startOrdersTestFixture(),
    startKafkaTestFixture(),
    startNatsTestFixture(),
  ]);

  // Sequential, not `Promise.all` — three concurrent `admin.createTopics`
  // calls against the single-node KRaft broker this fixture starts have
  // been observed to race (`KafkaJSProtocolError: This server does not
  // host this topic-partition`, a metadata-propagation timing issue, not a
  // real partitioning bug).
  await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
  await createTopic(kafkaFixture.brokers, FULFILLMENT_FACTS_TOPIC);
  await createTopic(kafkaFixture.brokers, BILLING_FACTS_TOPIC);

  const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
  const unitOfWork: UnitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
  const realOrders: OrderRepository = new DrizzleOrderRepository(mysqlFixture.db, clock);
  const orders: OrderRepository = options.wrapOrderRepository ? options.wrapOrderRepository(realOrders) : realOrders;
  const commandStore: SagaCommandStore = new DrizzleSagaCommandStore(mysqlFixture.db, clock);

  const ordersFactPublisher = new KafkaFactPublisher(
    createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-test-relay' }),
    ORDERS_FACTS_TOPIC,
  );
  const fulfillmentFactPublisher = new KafkaFactPublisher(
    createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-fulfillment-test-stub' }),
    FULFILLMENT_FACTS_TOPIC,
  );
  const billingFactPublisher = new KafkaFactPublisher(
    createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-billing-test-stub' }),
    BILLING_FACTS_TOPIC,
  );

  const [appNatsConnection, testNatsConnection] = await Promise.all([natsFixture.connect(), natsFixture.connect()]);

  const dispatcherConfig: SagaCommandDispatcherConfig = {
    timeoutMs: 1500,
    maxAttempts: 3,
    backoffBaseMs: 50,
    parkRetryCapMs: 5000,
    ...options.dispatcherConfig,
  };
  const sweeperConfig: SagaCommandSweeperConfig = {
    enabled: false,
    intervalMs: 200,
    pendingGraceMs: 500,
    batchLimit: 100,
    ...options.sweeperConfig,
  };

  const resolveOrderId: ResolveOrderId = async (orderReference) => {
    const [row] = await mysqlFixture.db
      .select({ id: ordersSchema.orders.id })
      .from(ordersSchema.orders)
      .where(eq(ordersSchema.orders.orderReference, orderReference));
    if (!row) {
      throw new Error(`saga-integration-harness: no order row for orderReference "${orderReference}"`);
    }
    return row.id;
  };

  async function placeOrder(overrides: Partial<PlaceOrderInput> = {}): Promise<Order> {
    const input = placeOrderInput(overrides);
    const order = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => realOrders.save(order, tx));
    return order;
  }

  async function placeOrderAndRelay(overrides: Partial<PlaceOrderInput> = {}): Promise<Order> {
    const order = await placeOrder(overrides);
    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: ordersFactPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    await relay.runOnce();
    return order;
  }

  return {
    mysqlFixture,
    kafkaFixture,
    natsFixture,
    clock,
    unitOfWork,
    orders,
    commandStore,
    ordersFactPublisher,
    fulfillmentFactPublisher,
    billingFactPublisher,
    appNatsConnection,
    testNatsConnection,
    dispatcherConfig,
    sweeperConfig,
    resolveOrderId,
    placeOrder,
    placeOrderAndRelay,
    async teardownFixturesOnly(): Promise<void> {
      await ordersFactPublisher.disconnect();
      await fulfillmentFactPublisher.disconnect();
      await billingFactPublisher.disconnect();
      await appNatsConnection.close();
      await testNatsConnection.close();
      await mysqlFixture.teardown();
      await kafkaFixture.teardown();
      await natsFixture.teardown();
    },
  };
}

/** Stage 2 — compiles and starts the Nest app (and its `orders.saga` Kafka consumer group) against already-prepared fixtures. */
export async function startSagaAppFromFixtures(prepared: PreparedSagaFixtures): Promise<SagaIntegrationHarness> {
  const {
    mysqlFixture,
    kafkaFixture,
    natsFixture,
    clock,
    unitOfWork,
    orders,
    commandStore,
    ordersFactPublisher,
    fulfillmentFactPublisher,
    billingFactPublisher,
    appNatsConnection,
    testNatsConnection,
    dispatcherConfig,
    sweeperConfig,
    resolveOrderId,
    placeOrder,
    placeOrderAndRelay,
  } = prepared;

  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    controllers: [SagaFactsController],
    providers: [
      { provide: CLOCK, useValue: clock },
      { provide: UNIT_OF_WORK, useValue: unitOfWork },
      { provide: ORDER_REPOSITORY, useValue: orders },
      { provide: SAGA_COMMAND_STORE, useValue: commandStore },
      { provide: SAGA_COMMANDS, useValue: new NatsSagaCommandsAdapter(appNatsConnection, dispatcherConfig.timeoutMs) },
      {
        provide: SagaFactHandler,
        useFactory: () =>
          new SagaFactHandler(
            new IdempotentConsumer(unitOfWork, clock),
            orders,
            commandStore,
            new SagaIgnoredFactsRepository(clock),
          ),
      },
      {
        provide: SAGA_COMMAND_DISPATCHER,
        useFactory: () =>
          new SagaCommandDispatcher(
            new NatsSagaCommandsAdapter(appNatsConnection, dispatcherConfig.timeoutMs),
            commandStore,
            dispatcherConfig,
          ),
      },
      { provide: SAGA_COMMAND_SWEEPER_CONFIG, useValue: sweeperConfig },
      SagaCommandSweeperService,
      OrderSagas,
      ...SAGA_FACT_COMMAND_HANDLERS,
      ...SAGA_DISPATCH_COMMAND_HANDLERS,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      // `retry` here is TEST-ONLY hardening — see
      // `KAFKA_TEST_CLIENT_RETRY`'s comment (kafka-test-fixture.ts) for
      // why kafkajs's own `NODE_ENV=test` defaults are too short/coarse
      // for a freshly-started single-node KRaft broker.
      client: { clientId: 'otc-orders-saga-test', brokers: [...kafkaFixture.brokers], retry: KAFKA_TEST_CLIENT_RETRY },
      consumer: { groupId: SAGA_CONSUMER_GROUP, sessionTimeout: 30_000 },
      subscribe: { fromBeginning: true },
      run: { partitionsConsumedConcurrently: 1 },
    },
  });
  await app.startAllMicroservices();
  await app.init();

  // Readiness, not sleep (post-approval hardening, 2026-08-21): NestJS's
  // `ServerKafka` appends `-server` to the configured `groupId`
  // unconditionally (`server-kafka.js`, `postfixId` default `'-server'`),
  // so the broker-side group is `orders.saga-server`, not
  // `SAGA_CONSUMER_GROUP` itself. `app.startAllMicroservices()` resolves
  // once `consumer.run()` has been CALLED, not once the consumer group
  // has actually finished joining/rebalancing — kafkajs's own group-join
  // sequence (find coordinator -> join -> sync) still runs asynchronously
  // afterwards, and on a brand-new single-node KRaft broker that sequence
  // can itself be retried several times while the coordinator subsystem
  // finishes loading. Blocking HERE, inside `beforeAll` (hook budget
  // 300_000ms across every saga spec), means that startup cost is paid
  // once per suite file and never eats into a test's own `waitFor`
  // window — which is exactly the flake this hardening pass fixes.
  await waitForConsumerGroupReady([...kafkaFixture.brokers], `${SAGA_CONSUMER_GROUP}-server`);

  return {
    mysqlFixture,
    kafkaFixture,
    natsFixture,
    app,
    clock,
    db: mysqlFixture.db,
    ordersFactPublisher,
    fulfillmentFactPublisher,
    billingFactPublisher,
    testNatsConnection,
    resolveOrderId,
    placeOrder,
    placeOrderAndRelay,
    async teardown(): Promise<void> {
      await app.close();
      await prepared.teardownFixturesOnly();
    },
  };
}

/**
 * Convenience: the common case of every spec so far — prepare fixtures AND
 * start the app in one call, in that order (fact publication always
 * happens after the consumer group already exists). SO1's spec needs the
 * two stages split, so it calls `prepareSagaFixtures`/`startSagaAppFromFixtures`
 * directly instead.
 */
export async function startSagaIntegrationHarness(
  options: SagaIntegrationHarnessOptions = {},
): Promise<SagaIntegrationHarness> {
  const prepared = await prepareSagaFixtures(options);
  return startSagaAppFromFixtures(prepared);
}

/** Re-exported so specs need only one import for a raw connection when they need a THIRD independent NATS client (rare — most specs share `testNatsConnection`). */
export { connect as connectNats };
