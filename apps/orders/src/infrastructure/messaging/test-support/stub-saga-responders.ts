// TEST-ONLY stand-ins for the Fulfillment/Billing responders of the five
// saga command subjects (design.md §8.1) — features 17-22 have not landed.
// Same "stub responder inside the integration test harness, never inside
// production code" discipline as `stub-stock-check-responder.ts`: this
// module lives under `test-support/` and is imported only by integration
// specs.
//
// Crucially, a stub here ALSO stands in for the responder's own outbox
// side: in the real system a command's reply and its resulting fact are
// two separate things (the fact travels via the responder's own outbox
// relay, asynchronously). This harness's stubs therefore, after replying
// over NATS, publish the corresponding fact envelope directly to the REAL
// Kafka topic via `publishFact` — exercising the true loop this feature
// promises: command out over real NATS, fact in over real Kafka, aggregate
// advanced through real MySQL (design.md §8.1).
//
// A fact's `correlationId` MUST be the order's UUID (asyncapi.yaml, R12) —
// but the five request payloads carry only `orderReference` (the
// AsyncAPI-documented shape; the order id would travel via the `x-correlation-id`
// RPC header, R58, which no adapter in this codebase populates yet —
// feature 27's OTel/observability pass). `resolveOrderId` is this harness's
// stand-in for that not-yet-wired mechanism: callers pass a function that
// looks the id up (in practice, a query against the same MySQL fixture the
// spec already seeded through).
import { randomUUID } from 'node:crypto';
import { JSONCodec, type NatsConnection, type Subscription } from 'nats';
import type {
  CreditHoldReplyPayload,
  CreditHoldRequestPayload,
  DespatchCreateReplyPayload,
  DespatchCreateRequestPayload,
  Envelope,
  InvoiceIssueReplyPayload,
  InvoiceIssueRequestPayload,
  StockReleaseReplyPayload,
  StockReleaseRequestPayload,
  StockReserveReplyPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';
import type { KafkaFactPublisher } from '../../outbox/kafka-fact-publisher';
import {
  CREDIT_HOLD_SUBJECT,
  DESPATCH_CREATE_SUBJECT,
  INVOICE_ISSUE_SUBJECT,
  STOCK_RELEASE_SUBJECT,
  STOCK_RESERVE_SUBJECT,
} from '../nats-saga-commands.adapter';

export interface RecordedRequest<TRequest> {
  readonly request: TRequest;
  readonly at: Date;
}

export type ResolveOrderId = (orderReference: string) => Promise<string>;

/** Publishes one envelope to a real Kafka topic via the given publisher — the stub's stand-in for "the responder's own outbox relay eventually published this fact". */
export async function publishFact(
  publisher: KafkaFactPublisher,
  eventType: string,
  correlationId: string,
  payload: Record<string, unknown>,
  occurredAt: Date = new Date(),
): Promise<void> {
  const envelope: Envelope = {
    eventId: randomUUID(),
    eventType,
    aggregateId: correlationId,
    correlationId,
    causationId: randomUUID(),
    occurredAt: occurredAt.toISOString(),
    payload,
  };
  await publisher.publish([
    { key: correlationId, envelope, headers: { 'x-event-type': eventType, 'content-type': 'application/json' } },
  ]);
}

async function respond<TRequest, TReply>(
  connection: NatsConnection,
  subject: string,
  handler: (request: TRequest) => Promise<TReply> | TReply,
  recorded: RecordedRequest<TRequest>[],
): Promise<{ stop(): Promise<void> }> {
  const requestCodec = JSONCodec<TRequest>();
  const replyCodec = JSONCodec<TReply>();
  const subscription: Subscription = connection.subscribe(subject);

  void (async () => {
    for await (const message of subscription) {
      if (!message.reply) {
        continue;
      }
      const request = requestCodec.decode(message.data);
      recorded.push({ request, at: new Date() });
      const reply = await handler(request);
      message.respond(replyCodec.encode(reply));
    }
  })();

  await connection.flush();

  return {
    async stop(): Promise<void> {
      subscription.unsubscribe();
      await connection.flush();
    },
  };
}

export interface StubSagaResponders {
  readonly stockReserveRequests: RecordedRequest<StockReserveRequestPayload>[];
  readonly stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[];
  readonly despatchCreateRequests: RecordedRequest<DespatchCreateRequestPayload>[];
  readonly creditHoldRequests: RecordedRequest<CreditHoldRequestPayload>[];
  readonly invoiceIssueRequests: RecordedRequest<InvoiceIssueRequestPayload>[];
  stop(): Promise<void>;
}

export interface StubSagaRespondersOptions {
  /** Set to answer `stock.reserve` as rejected instead of accepted. */
  readonly rejectStockReserve?: boolean;
  /** Set to answer `credit.hold` as rejected instead of approved. */
  readonly rejectCreditHold?: boolean;
}

/**
 * Starts all five stub responders on `connection`, wired to publish the
 * resulting fact to `factPublishers` (one `KafkaFactPublisher` per topic —
 * `stock.reserve`/`stock.release` -> fulfillment, `credit.hold` ->
 * billing, `despatch.create` -> fulfillment, `invoice.issue` -> billing).
 */
export async function startStubSagaResponders(
  connection: NatsConnection,
  factPublishers: { fulfillment: KafkaFactPublisher; billing: KafkaFactPublisher },
  resolveOrderId: ResolveOrderId,
  options: StubSagaRespondersOptions = {},
): Promise<StubSagaResponders> {
  const stockReserveRequests: RecordedRequest<StockReserveRequestPayload>[] = [];
  const stockReleaseRequests: RecordedRequest<StockReleaseRequestPayload>[] = [];
  const despatchCreateRequests: RecordedRequest<DespatchCreateRequestPayload>[] = [];
  const creditHoldRequests: RecordedRequest<CreditHoldRequestPayload>[] = [];
  const invoiceIssueRequests: RecordedRequest<InvoiceIssueRequestPayload>[] = [];

  const stockReserve = await respond<StockReserveRequestPayload, StockReserveReplyPayload>(
    connection,
    STOCK_RESERVE_SUBJECT,
    async (request) => {
      const orderId = await resolveOrderId(request.orderReference);
      if (options.rejectStockReserve) {
        await publishFact(factPublishers.fulfillment, 'stock.rejected.v1', orderId, {
          orderReference: request.orderReference,
          companyCode: request.companyCode,
          shortages: request.lines.map((line) => ({ productCode: line.productCode, requested: line.units, available: 0 })),
          reason: 'insufficient_stock',
        });
        return { outcome: 'rejected', orderReference: request.orderReference, shortages: [] };
      }
      const reservations = request.lines.map((line) => ({
        reservationId: randomUUID(),
        productCode: line.productCode,
        units: line.units,
      }));
      await publishFact(factPublishers.fulfillment, 'stock.reserved.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: request.companyCode,
        reservations,
      });
      return { outcome: 'accepted', orderReference: request.orderReference, reservations };
    },
    stockReserveRequests,
  );

  const stockRelease = await respond<StockReleaseRequestPayload, StockReleaseReplyPayload>(
    connection,
    STOCK_RELEASE_SUBJECT,
    async (request) => {
      const orderId = await resolveOrderId(request.orderReference);
      await publishFact(factPublishers.fulfillment, 'stock.released.v1', orderId, {
        orderReference: request.orderReference,
        companyCode: 'COM-0001',
        released: [{ reservationId: randomUUID(), productCode: 'PRD-0001', units: 1 }],
        reason: request.reason,
      });
      return { outcome: 'released', orderReference: request.orderReference, released: [] };
    },
    stockReleaseRequests,
  );

  const despatchCreate = await respond<DespatchCreateRequestPayload, DespatchCreateReplyPayload>(
    connection,
    DESPATCH_CREATE_SUBJECT,
    async (request) => {
      const orderId = await resolveOrderId(request.orderReference);
      const despatchReference = `DES-${randomUUID().slice(0, 6)}`;
      await publishFact(factPublishers.fulfillment, 'order.despatched.v1', orderId, {
        orderReference: request.orderReference,
        despatchReference,
        despatchDate: new Date().toISOString(),
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        lines: [{ productCode: 'PRD-0001', units: 1 }],
      });
      return {
        orderReference: request.orderReference,
        despatchReference,
        despatchDate: new Date().toISOString(),
        created: true,
      };
    },
    despatchCreateRequests,
  );

  const creditHold = await respond<CreditHoldRequestPayload, CreditHoldReplyPayload>(
    connection,
    CREDIT_HOLD_SUBJECT,
    async (request) => {
      const orderId = await resolveOrderId(request.orderReference);
      if (options.rejectCreditHold) {
        await publishFact(factPublishers.billing, 'credit.rejected.v1', orderId, {
          orderReference: request.orderReference,
          retailerCode: request.retailerCode,
          companyCode: request.companyCode,
          currency: request.amount.currency,
          reason: 'over_limit',
        });
        return {
          outcome: 'rejected',
          orderReference: request.orderReference,
          currency: request.amount.currency,
          availableCredit: 0,
          reason: 'over_limit',
        };
      }
      const creditCode = `CR-${randomUUID().slice(0, 6)}`;
      await publishFact(factPublishers.billing, 'credit.approved.v1', orderId, {
        orderReference: request.orderReference,
        retailerCode: request.retailerCode,
        companyCode: request.companyCode,
        creditCode,
        currency: request.amount.currency,
        heldAmount: request.amount.amount,
      });
      return {
        outcome: 'approved',
        orderReference: request.orderReference,
        creditCode,
        currency: request.amount.currency,
        heldAmount: request.amount.amount,
        availableCredit: 1_000_000,
      };
    },
    creditHoldRequests,
  );

  const invoiceIssue = await respond<InvoiceIssueRequestPayload, InvoiceIssueReplyPayload>(
    connection,
    INVOICE_ISSUE_SUBJECT,
    async (request) => {
      const orderId = await resolveOrderId(request.orderReference);
      const invoiceReference = `INV-${randomUUID().slice(0, 6)}`;
      const totalAmount = request.lines.reduce((sum, line) => sum + line.units * line.unitPrice, 0);
      await publishFact(factPublishers.billing, 'invoice.issued.v1', orderId, {
        orderReference: request.orderReference,
        invoiceReference,
        invoiceDate: new Date().toISOString(),
        currency: request.currency,
        totalAmount,
      });
      return {
        orderReference: request.orderReference,
        invoiceReference,
        invoiceDate: new Date().toISOString(),
        currency: request.currency,
        totalAmount,
        status: 'issued',
        created: true,
      };
    },
    invoiceIssueRequests,
  );

  return {
    stockReserveRequests,
    stockReleaseRequests,
    despatchCreateRequests,
    creditHoldRequests,
    invoiceIssueRequests,
    async stop(): Promise<void> {
      await Promise.all([stockReserve.stop(), stockRelease.stop(), despatchCreate.stop(), creditHold.stop(), invoiceIssue.stop()]);
    },
  };
}
