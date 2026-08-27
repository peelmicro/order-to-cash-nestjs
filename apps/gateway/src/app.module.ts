// `CqrsModule.forRoot()` plus every command/query `@CommandHandler`/
// `@QueryHandler` as class providers (decorator discovery needs the
// class) — everything else `useFactory` + `inject: [...]` with explicit
// tokens (CLAUDE.md § Explicit DI tokens), the same shape every other
// service's `app.module.ts` in this repo establishes. This service is the
// ONLY external entry point (openapi.yaml's own words): it opens an
// OUTBOUND NATS connection for RPC calls AND the SSE signal subscription
// (`NatsRpcClientAdapter` / `NatsStreamSignalAdapter`, sharing the SAME
// connection — a `request()` caller and a `subscribe()`r can coexist on
// one `NatsConnection`), a READ-ONLY MongoDB connection onto the
// projector's `order_timeline` collection (R54 — never a write model),
// and constructs NO write-database client of any kind (Group B's own
// rule, enforced behaviourally by `no-write-database-client.spec.ts`).
import { type MiddlewareConsumer, Module, type NestModule, type OnApplicationShutdown } from '@nestjs/common';
import { CorrelationIdMiddleware } from './presentation/correlation-id.middleware';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RequestLatencyInterceptor } from './presentation/request-latency.interceptor';
import type { Collection, Db } from 'mongodb';
import type { NatsConnection } from 'nats';
import { GetCurrentUserHandler } from './application/queries/get-current-user.query';
import { LoginHandler } from './application/commands/login.command';
import { PlaceOrderHandler } from './application/commands/place-order.command';
import { CancelOrderHandler } from './application/commands/cancel-order.command';
import { ReplenishStockHandler } from './application/commands/replenish-stock.command';
import { RegisterPaymentHandler } from './application/commands/register-payment.command';
import { ListOrdersHandler } from './application/queries/list-orders.query';
import { GetOrderHandler } from './application/queries/get-order.query';
import { ListStockHandler } from './application/queries/list-stock.query';
import { ListInvoicesHandler } from './application/queries/list-invoices.query';
import { ListCreditsHandler } from './application/queries/list-credits.query';
import { ListCatalogHandler } from './application/queries/list-catalog.query';
import { CLOCK } from './application/ports/clock.port';
import { OPERATOR_IDENTITY, type OperatorIdentity } from './application/ports/operator-identity.port';
import { TOKEN_SERVICE, type TokenService } from './application/ports/token.port';
import { RPC_CLIENT, type RpcClient } from './application/ports/rpc-client.port';
import { ORDER_READ_MODEL, type OrderReadModel } from './application/ports/order-read-model.port';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { ISSUED_ORDER_WINDOW } from './application/ports/issued-order-window.port';
import { StreamHub } from './application/stream-hub';
import { IssuedOrderWindow } from './domain/orders/issued-order-window';
import { loadJwtConfig } from './infrastructure/auth/jwt.config';
import { JwtTokenAdapter } from './infrastructure/auth/jwt-token.adapter';
import { loadOperatorIdentity } from './infrastructure/auth/operator.config';
import { createNatsConnection } from './infrastructure/messaging/nats-client';
import { loadNatsConfig, loadRpcTimeoutMs } from './infrastructure/messaging/nats.config';
import { NatsRpcClientAdapter } from './infrastructure/messaging/nats-rpc-client.adapter';
import { NatsStreamSignalAdapter } from './infrastructure/messaging/nats-stream-signal.adapter';
import { loadSseConfig } from './infrastructure/messaging/sse.config';
import { connectMongo, orderTimelineCollection, type MongoHandle } from './infrastructure/persistence/mongo-client';
import { loadMongoConfig } from './infrastructure/persistence/mongo.config';
import { loadIssuedOrderWindowConfig } from './infrastructure/orders/issued-order-window.config';
import { MongoOrderReadModelAdapter } from './infrastructure/persistence/mongo-order-read-model.adapter';
import { MongoHealthCheck } from './infrastructure/health/mongo-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';
import { SystemClock } from './infrastructure/system-clock';
import { AuthController } from './presentation/auth.controller';
import { OrdersController } from './presentation/orders.controller';
import { StockController } from './presentation/stock.controller';
import { InvoicesController } from './presentation/invoices.controller';
import { CreditsController } from './presentation/credits.controller';
import { CatalogController } from './presentation/catalog.controller';
import { HealthController } from './presentation/health.controller';
import { StreamController } from './presentation/stream.controller';
import { SSE_CONFIG } from './presentation/sse-config.token';
import { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
import { ProblemJsonExceptionFilter } from './presentation/problem-json.filter';
import type { OrderTimelineDocumentLike } from './domain/projection/order-read-model-mapper';

/** Module-local token — the outbound MongoDB connection handle. Exported so `main.ts` can retrieve the SAME connection to close it on shutdown / probe readiness without opening a second client (the same shape `apps/projector`'s own `MONGO_DB` token establishes). */
export const MONGO_DB = Symbol('MongoDb');
const READ_MODEL_COLLECTION = Symbol('ReadModelCollection');
/** The ONE outbound `NatsConnection` this service opens — RPC calls AND the SSE signal subscription share it. Exported for the same reason `apps/projector`'s own `NATS_CONNECTION` token is. */
export const NATS_CONNECTION = Symbol('NatsConnection');

class MongoConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly handle: MongoHandle) {}
  async onApplicationShutdown(): Promise<void> {
    await this.handle.client.close();
  }
}

class NatsConnectionCloser implements OnApplicationShutdown {
  constructor(private readonly connection: NatsConnection) {}
  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

/** Stops the SSE signal subscription BEFORE `NatsConnectionCloser` closes the connection it subscribes on — Nest calls every `onApplicationShutdown` hook, order of registration is not guaranteed, so this hook is independently safe to call even if the connection is already closing. */
class StreamSignalCloser implements OnApplicationShutdown {
  constructor(private readonly adapter: NatsStreamSignalAdapter) {}
  async onApplicationShutdown(): Promise<void> {
    await this.adapter.stop();
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  controllers: [
    AuthController,
    // StreamController's `GET /orders/stream` MUST be registered before
    // OrdersController's `GET /orders/:id` — Nest/Express matches routes
    // in REGISTRATION order, and `:id` is a wildcard that would otherwise
    // swallow the literal `/orders/stream` path first, sending it into
    // `parseOrderId('stream')` (a 400). Found live by
    // `stream.integration.spec.ts`.
    StreamController,
    OrdersController,
    StockController,
    InvoicesController,
    CreditsController,
    CatalogController,
    HealthController,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: OPERATOR_IDENTITY, useFactory: (): OperatorIdentity => loadOperatorIdentity() },
    {
      provide: TOKEN_SERVICE,
      useFactory: (): TokenService => new JwtTokenAdapter(loadJwtConfig()),
    },
    { provide: NATS_CONNECTION, useFactory: (): Promise<NatsConnection> => createNatsConnection(loadNatsConfig()) },
    {
      provide: NatsConnectionCloser,
      useFactory: (connection: NatsConnection): NatsConnectionCloser => new NatsConnectionCloser(connection),
      inject: [NATS_CONNECTION],
    },
    {
      provide: RPC_CLIENT,
      useFactory: (connection: NatsConnection): RpcClient => new NatsRpcClientAdapter(connection, loadRpcTimeoutMs()),
      inject: [NATS_CONNECTION],
    },
    {
      provide: MONGO_DB,
      useFactory: (): Promise<MongoHandle> => connectMongo(loadMongoConfig()),
    },
    {
      provide: MongoConnectionCloser,
      useFactory: (handle: MongoHandle): MongoConnectionCloser => new MongoConnectionCloser(handle),
      inject: [MONGO_DB],
    },
    {
      provide: READ_MODEL_COLLECTION,
      useFactory: (handle: MongoHandle): Collection<OrderTimelineDocumentLike> => orderTimelineCollection(handle.db),
      inject: [MONGO_DB],
    },
    {
      provide: ORDER_READ_MODEL,
      useFactory: (collection: Collection<OrderTimelineDocumentLike>): OrderReadModel => new MongoOrderReadModelAdapter(collection),
      inject: [READ_MODEL_COLLECTION],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (handle: MongoHandle, connection: NatsConnection): readonly HealthCheck[] => [
        new MongoHealthCheck(handle.db as Db),
        new NatsHealthCheck(connection),
      ],
      inject: [MONGO_DB, NATS_CONNECTION],
    },
    {
      // F3 (review) — a single, process-wide instance shared between
      // `PlaceOrderHandler` (records) and `GetOrderHandler` (reads);
      // `useFactory` (not a class provider) because it needs constructor
      // args (`ttlMs`, `capacity`) `IssuedOrderWindow` itself validates.
      provide: ISSUED_ORDER_WINDOW,
      useFactory: (clock: { now(): Date }): IssuedOrderWindow => {
        const config = loadIssuedOrderWindowConfig();
        return new IssuedOrderWindow(clock, config.ttlMs, config.capacity);
      },
      inject: [CLOCK],
    },
    {
      provide: StreamHub,
      useFactory: (clock: { now(): Date }): StreamHub => new StreamHub(clock, loadSseConfig().bufferCapacity),
      inject: [CLOCK],
    },
    { provide: SSE_CONFIG, useFactory: () => loadSseConfig() },
    {
      provide: NatsStreamSignalAdapter,
      useFactory: (connection: NatsConnection, hub: StreamHub): NatsStreamSignalAdapter => new NatsStreamSignalAdapter(connection, hub),
      inject: [NATS_CONNECTION, StreamHub],
    },
    {
      provide: StreamSignalCloser,
      useFactory: (adapter: NatsStreamSignalAdapter): StreamSignalCloser => new StreamSignalCloser(adapter),
      inject: [NatsStreamSignalAdapter],
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: ProblemJsonExceptionFilter },
    // A7 (metrics, R59/OR5) — `otc_request_latency_ms`, every route.
    { provide: APP_INTERCEPTOR, useClass: RequestLatencyInterceptor },
    LoginHandler,
    GetCurrentUserHandler,
    PlaceOrderHandler,
    CancelOrderHandler,
    ReplenishStockHandler,
    RegisterPaymentHandler,
    ListOrdersHandler,
    GetOrderHandler,
    ListStockHandler,
    ListInvoicesHandler,
    ListCreditsHandler,
    ListCatalogHandler,
  ],
})
export class AppModule implements NestModule {
  // A6b (observability_reliability) — stamps `req.correlationId` before
  // every route, including the error path `problem-json.filter.ts` reads
  // it from (R58's "every line" guarantee).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
