// The real-wire proof for `orders_catalog_responder` — mirrors
// `orders-create-wire.integration.spec.ts`'s own shape exactly (same
// rationale: F1's bare-JSON finding applies to EVERY responder registered
// on this NATS microservice, not just `orders.create`), driven against the
// REAL `catalog.reference.list` responder wired the same way
// `apps/orders/src/main.ts` wires it in production (bare-JSON
// (de)serializer pair), over real NATS (Testcontainers, nats:2.14.5-alpine)
// and real MySQL (Testcontainers, mysql:8.4.11) — the SAME `OrdersTestFixture`
// seed `orders-create-wire.integration.spec.ts` and
// `order-reference-data.integration.spec.ts` already use.
//
// A raw `nats` bare-JSON request carrying a reply subject is driven here —
// exactly the shape `apps/gateway`'s `NatsRpcClientAdapter`
// (nats-rpc-client.adapter.ts) sends — proving the Gateway's `503
// UPSTREAM_UNAVAILABLE` (list-catalog.query.ts's own recorded gap comment)
// is now answered with real data end to end through the real NATS wire.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { JSONCodec, type NatsConnection } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogReferenceListReplyPayload, RpcError } from '@otc/contracts';
import { CatalogReferenceListController, CATALOG_REFERENCE_LIST_SUBJECT } from './presentation/catalog-reference-list.controller';
import { ListCatalogReferenceHandler } from './application/queries/list-catalog-reference.query';
import { CATALOG_REFERENCE_LIST } from './application/ports/catalog-reference-list.port';
import { DrizzleOrderReferenceDataRepository } from './infrastructure/persistence/order-reference-data.repository';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_COMPANY_GLN,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  FIXTURE_RETAILER_GLN,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from './infrastructure/persistence/test-support/orders-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './infrastructure/messaging/test-support/nats-test-fixture';
// The production shape (apps/orders/src/main.ts, post-F1/G6): the SAME
// function bootstrap() calls, not a hand-mirrored copy — see main.ts's own
// header comment for why this removes the class of drift F1 exploited.
import { createOrdersNatsMicroserviceOptions } from './main';

const codec = JSONCodec();
const FRAMEWORK_PACKET_KEYS = ['response', 'isDisposed', 'id'];

function isRpcError(reply: CatalogReferenceListReplyPayload | RpcError): reply is RpcError {
  return typeof (reply as RpcError).code === 'string';
}

function assertBareShape(decoded: unknown): void {
  expect(typeof decoded).toBe('object');
  const keys = Object.keys(decoded as Record<string, unknown>);
  for (const forbidden of FRAMEWORK_PACKET_KEYS) {
    expect(keys).not.toContain(forbidden);
  }
}

describe('catalog.reference.list — the bare-JSON wire, proven against apps/orders/src/main.ts\'s real configuration (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let natsFixture: NatsTestFixture;
  let rawNatsConnection: NatsConnection;
  let app: INestApplication;

  beforeAll(async () => {
    [mysqlFixture, natsFixture] = await Promise.all([startOrdersTestFixture(), startNatsTestFixture()]);
    rawNatsConnection = await natsFixture.connect();

    const repository = new DrizzleOrderReferenceDataRepository(mysqlFixture.db);

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      controllers: [CatalogReferenceListController],
      providers: [ListCatalogReferenceHandler, { provide: CATALOG_REFERENCE_LIST, useValue: repository }],
    }).compile();

    app = moduleRef.createNestApplication();
    const connectionOptions = natsFixture.container.getConnectionOptions();
    app.connectMicroservice<MicroserviceOptions>(
      createOrdersNatsMicroserviceOptions({
        servers: connectionOptions.servers,
        user: connectionOptions.user,
        pass: connectionOptions.pass,
      }),
    );
    await app.startAllMicroservices();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await rawNatsConnection?.close();
    await mysqlFixture?.teardown();
    await natsFixture?.teardown();
  }, 120_000);

  async function rawRequest(payload: unknown): Promise<unknown> {
    const reply = await rawNatsConnection.request(CATALOG_REFERENCE_LIST_SUBJECT, codec.encode(payload), { timeout: 10_000 });
    return codec.decode(reply.data);
  }

  it('answers a bare-JSON request from a raw nats client (the Gateway shape) with the fixture\'s real products/retailers/companies/currencies — no Nest envelope, no 503', async () => {
    const decoded = (await rawRequest({})) as CatalogReferenceListReplyPayload;

    assertBareShape(decoded);
    expect(isRpcError(decoded)).toBe(false);
    expect(decoded.products).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: FIXTURE_PRODUCT_CODE, currency: FIXTURE_CURRENCY, enabled: true })]),
    );
    expect(decoded.retailers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: FIXTURE_RETAILER_CODE, gln: FIXTURE_RETAILER_GLN })]),
    );
    expect(decoded.companies).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: FIXTURE_COMPANY_CODE, gln: FIXTURE_COMPANY_GLN })]),
    );
    expect(decoded.currencies).toEqual(expect.arrayContaining([expect.objectContaining({ code: FIXTURE_CURRENCY })]));
  });

  it('honours a `kinds` filter over the real wire — only the requested collection is present on the reply', async () => {
    const decoded = (await rawRequest({ kinds: ['products'] })) as CatalogReferenceListReplyPayload;

    assertBareShape(decoded);
    expect(decoded.products).toBeDefined();
    expect(decoded.retailers).toBeUndefined();
    expect(decoded.companies).toBeUndefined();
    expect(decoded.currencies).toBeUndefined();
  });

  it('answers a bare-JSON RpcError over the real wire on a validation failure (an unknown kind) — never a hang, never a Nest envelope', async () => {
    const decoded = (await rawRequest({ kinds: ['not-a-real-kind'] })) as RpcError;

    assertBareShape(decoded);
    expect(decoded).toHaveProperty('code', 'VALIDATION_FAILED');
  });
}, 180_000);
