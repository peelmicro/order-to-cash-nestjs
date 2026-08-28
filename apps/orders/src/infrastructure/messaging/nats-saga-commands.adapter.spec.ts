// Pure unit — a fake `NatsRequestClient`, never a real broker (real NATS is
// the integration specs' job). Proves the timeout / no-responders /
// transport / RpcError-body taxonomy per subject (feature-15 adapter spec
// pattern, design.md §6.1), and that a business rejection resolves
// normally (SO6, unit half).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCode, JSONCodec, NatsError, type MsgHdrs } from 'nats';
import { UniqueId } from '@otc/shared-kernel';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractNatsTraceContext, tracer } from '../observability/trace-context';
import type {
  CreditHoldReplyPayload,
  RpcError,
  StockReleaseReplyPayload,
  StockReserveReplyPayload,
} from '@otc/contracts';
import {
  SagaCommandBusinessRejectionError,
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandMeta,
} from '../../application/ports/saga-commands.port';
import {
  CREDIT_HOLD_SUBJECT,
  CREDIT_RELEASE_SUBJECT,
  DESPATCH_CREATE_SUBJECT,
  INVOICE_ISSUE_SUBJECT,
  NatsSagaCommandsAdapter,
  STOCK_RELEASE_SUBJECT,
  STOCK_RESERVE_SUBJECT,
  type NatsRequestClient,
} from './nats-saga-commands.adapter';

function fakeClient(handler: NatsRequestClient['request']): NatsRequestClient {
  return { request: handler };
}

const META: SagaCommandMeta = { correlationId: UniqueId.generate(), requestId: UniqueId.generate() };

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../../specs/shared/asyncapi.yaml');

/** Reads `specs/shared/asyncapi.yaml` as TEXT (no YAML parser dependency, same discipline as `kafka.config.spec.ts`) and returns the `address:` of the named request channel. */
function channelAddress(specText: string, channelName: string): string {
  const blockMatch = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!blockMatch) {
    throw new Error(`nats-saga-commands.adapter.spec: could not locate the ${channelName} channel block`);
  }
  const addressMatch = blockMatch[1]!.match(/address:\s*(\S+)/);
  if (!addressMatch) {
    throw new Error(`nats-saga-commands.adapter.spec: ${channelName} channel has no address`);
  }
  return addressMatch[1]!;
}

describe('NatsSagaCommandsAdapter — subject constants match the AsyncAPI addresses (design.md §6.1)', () => {
  it('uses exactly the six documented RPC subjects, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(STOCK_RESERVE_SUBJECT).toBe(channelAddress(specText, 'stockReserve'));
    expect(STOCK_RELEASE_SUBJECT).toBe(channelAddress(specText, 'stockRelease'));
    expect(DESPATCH_CREATE_SUBJECT).toBe(channelAddress(specText, 'despatchCreate'));
    expect(CREDIT_HOLD_SUBJECT).toBe(channelAddress(specText, 'creditHold'));
    expect(INVOICE_ISSUE_SUBJECT).toBe(channelAddress(specText, 'invoiceIssue'));
    // Feature 41's follow-up pass, closing the credit_approved/confirmed cancel gap.
    expect(CREDIT_RELEASE_SUBJECT).toBe(channelAddress(specText, 'creditRelease'));
  });
});

describe('NatsSagaCommandsAdapter — reserveStock', () => {
  const replyCodec = JSONCodec<StockReserveReplyPayload | RpcError>();

  it('returns the parsed reply on a resolved request, including a business rejection (SO6 — not thrown)', async () => {
    const body: StockReserveReplyPayload = { outcome: 'rejected', orderReference: 'ORD-000001', shortages: [] };
    const client = fakeClient(async (subject, _data, opts) => {
      expect(subject).toBe(STOCK_RESERVE_SUBJECT);
      expect(opts.timeout).toBe(5000);
      return { data: replyCodec.encode(body) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    const result = await adapter.reserveStock(
      {
        orderReference: 'ORD-000001',
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode: 'PRD-0001', units: 1 }],
      },
      META,
    );

    expect(result).toEqual(body);
  });

  it('FS2 — sends x-correlation-id and x-request-id headers on every saga command request', async () => {
    const body: StockReserveReplyPayload = { outcome: 'accepted', orderReference: 'ORD-000001', reservations: [] };
    let capturedHeaders: MsgHdrs | undefined;
    const client = fakeClient(async (_subject, _data, opts) => {
      capturedHeaders = opts.headers;
      return { data: replyCodec.encode(body) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    await adapter.reserveStock(
      {
        orderReference: 'ORD-000001',
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode: 'PRD-0001', units: 1 }],
      },
      META,
    );

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get('x-correlation-id')).toBe(META.correlationId.value);
    expect(capturedHeaders!.get('x-request-id')).toBe(META.requestId.value);
  });

  it('throws SagaCommandTimeoutError on a NATS timeout', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('timeout', ErrorCode.Timeout);
    });
    const adapter = new NatsSagaCommandsAdapter(client, 1500);

    await expect(
      adapter.reserveStock(
        {
          orderReference: 'ORD-000001',
          retailerCode: 'RET-0001',
          companyCode: 'COM-0001',
          lines: [{ productCode: 'PRD-0001', units: 1 }],
        },
        META,
      ),
    ).rejects.toThrow(SagaCommandTimeoutError);
  });

  it('throws SagaCommandTransportError (not a timeout) when nobody is subscribed', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('no responders', ErrorCode.NoResponders);
    });
    const adapter = new NatsSagaCommandsAdapter(client, 1500);

    await expect(
      adapter.reserveStock(
        {
          orderReference: 'ORD-000001',
          retailerCode: 'RET-0001',
          companyCode: 'COM-0001',
          lines: [{ productCode: 'PRD-0001', units: 1 }],
        },
        META,
      ),
    ).rejects.toThrow(SagaCommandTransportError);
  });

  it('throws SagaCommandTransportError when the responder replies with an RpcError body', async () => {
    const errorReply: RpcError = { code: 'INTERNAL_ERROR', message: 'boom' };
    const client = fakeClient(async () => ({ data: replyCodec.encode(errorReply) }));
    const adapter = new NatsSagaCommandsAdapter(client, 1500);

    await expect(
      adapter.reserveStock(
        {
          orderReference: 'ORD-000001',
          retailerCode: 'RET-0001',
          companyCode: 'COM-0001',
          lines: [{ productCode: 'PRD-0001', units: 1 }],
        },
        META,
      ),
    ).rejects.toThrow(SagaCommandTransportError);
  });

  it('throws SagaCommandTransportError when the reply body is not valid JSON', async () => {
    const client = fakeClient(async () => ({ data: new Uint8Array([0xff, 0xfe, 0x00]) }));
    const adapter = new NatsSagaCommandsAdapter(client, 1500);

    await expect(
      adapter.reserveStock(
        {
          orderReference: 'ORD-000001',
          retailerCode: 'RET-0001',
          companyCode: 'COM-0001',
          lines: [{ productCode: 'PRD-0001', units: 1 }],
        },
        META,
      ),
    ).rejects.toThrow(SagaCommandTransportError);
  });
});

// Feature 42 — the terminal-vs-transient RpcError split. Reproduces the
// live bug's exact scenario: `stock.release` on an already-`consumed`
// reservation, which Fulfillment correctly answers with `PRECONDITION_FAILED`
// (an `RpcError`-shaped reply, distinct from `StockReleaseReplyPayload`'s
// own typed `outcome` field — SO6 is unrelated to this path). Armed: with
// `isTerminalRpcErrorCode` reverted to "every code is terminal" or removed
// entirely (the pre-fix state, where `isRpcErrorReply` alone decided the
// outcome and every RpcError became `SagaCommandTransportError`), the
// `PRECONDITION_FAILED` case below fails — it throws `SagaCommandTransportError`
// instead of `SagaCommandBusinessRejectionError` (verbatim recorded in
// progress/impl_orders_saga_terminal_rejection.md).
describe('NatsSagaCommandsAdapter — feature 42 (terminal vs. transient RpcError classification)', () => {
  const replyCodec = JSONCodec<StockReleaseReplyPayload | RpcError>();

  async function releaseStockWithReply(errorReply: RpcError) {
    const client = fakeClient(async () => ({ data: replyCodec.encode(errorReply) }));
    const adapter = new NatsSagaCommandsAdapter(client, 1500);
    return adapter.releaseStock({ orderReference: 'ORD-000001', reason: 'order_cancelled' }, META);
  }

  it.each(['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_FAILED', 'ORDER_NOT_CANCELLABLE', 'STOCK_UNAVAILABLE', 'INVOICE_NOT_PAYABLE', 'PAYMENT_MISMATCH', 'DOMAIN_ERROR'] as const)(
    'throws SagaCommandBusinessRejectionError (terminal, not transport) for RpcError code %s',
    async (code) => {
      await expect(releaseStockWithReply({ code, message: 'reservation already consumed' })).rejects.toThrow(
        SagaCommandBusinessRejectionError,
      );
    },
  );

  it('the exact reproduced bug: stock.release against an already-consumed reservation (PRECONDITION_FAILED) is terminal, carries the subject and the responder code', async () => {
    await expect(
      releaseStockWithReply({ code: 'PRECONDITION_FAILED', message: 'reservation already consumed' }),
    ).rejects.toMatchObject({
      subject: STOCK_RELEASE_SUBJECT,
      rpcErrorCode: 'PRECONDITION_FAILED',
    });
  });

  it.each(['TIMEOUT', 'UNAVAILABLE', 'INTERNAL_ERROR'] as const)(
    'throws SagaCommandTransportError (still retryable, UNCHANGED) for RpcError code %s',
    async (code) => {
      await expect(releaseStockWithReply({ code, message: 'boom' })).rejects.toThrow(SagaCommandTransportError);
      await expect(releaseStockWithReply({ code, message: 'boom' })).rejects.not.toThrow(SagaCommandBusinessRejectionError);
    },
  );
});

describe('NatsSagaCommandsAdapter — holdCredit (business rejection is not an error, SO6)', () => {
  const replyCodec = JSONCodec<CreditHoldReplyPayload | RpcError>();

  it('resolves normally with outcome rejected — a domain outcome, not a thrown error', async () => {
    const body: CreditHoldReplyPayload = {
      outcome: 'rejected',
      orderReference: 'ORD-000001',
      currency: 'EUR',
      availableCredit: 0,
      reason: 'over_limit',
    };
    const client = fakeClient(async (subject) => {
      expect(subject).toBe(CREDIT_HOLD_SUBJECT);
      return { data: replyCodec.encode(body) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    const result = await adapter.holdCredit(
      {
        orderReference: 'ORD-000001',
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        amount: { amount: 10_000, currency: 'EUR' },
      },
      META,
    );

    expect(result.outcome).toBe('rejected');
  });
});

describe('NatsSagaCommandsAdapter — releaseStock, createDespatch, issueInvoice each call their own subject', () => {
  it('releaseStock calls fulfillment.stock.release', async () => {
    let calledSubject = '';
    const client = fakeClient(async (subject) => {
      calledSubject = subject;
      const codec = JSONCodec();
      return { data: codec.encode({ outcome: 'released', orderReference: 'ORD-000001', released: [] }) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    await adapter.releaseStock({ orderReference: 'ORD-000001', reason: 'credit_rejected' }, META);

    expect(calledSubject).toBe(STOCK_RELEASE_SUBJECT);
  });

  it('createDespatch calls fulfillment.despatch.create', async () => {
    let calledSubject = '';
    const client = fakeClient(async (subject) => {
      calledSubject = subject;
      const codec = JSONCodec();
      return {
        data: codec.encode({
          orderReference: 'ORD-000001',
          despatchReference: 'DES-000001',
          despatchDate: '2026-08-20T10:00:00.000Z',
          created: true,
        }),
      };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    await adapter.createDespatch({ orderReference: 'ORD-000001' }, META);

    expect(calledSubject).toBe(DESPATCH_CREATE_SUBJECT);
  });

  it('issueInvoice calls billing.invoice.issue', async () => {
    let calledSubject = '';
    const client = fakeClient(async (subject) => {
      calledSubject = subject;
      const codec = JSONCodec();
      return {
        data: codec.encode({
          orderReference: 'ORD-000001',
          invoiceReference: 'INV-000001',
          invoiceDate: '2026-08-20T10:00:00.000Z',
          currency: 'EUR',
          totalAmount: 1000,
          status: 'issued',
          created: true,
        }),
      };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    await adapter.issueInvoice(
      {
        orderReference: 'ORD-000001',
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        currency: 'EUR',
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1000 }],
      },
      META,
    );

    expect(calledSubject).toBe(INVOICE_ISSUE_SUBJECT);
  });

  it('releaseCredit calls billing.credit.release', async () => {
    let calledSubject = '';
    const client = fakeClient(async (subject) => {
      calledSubject = subject;
      const codec = JSONCodec();
      return { data: codec.encode({ released: true, orderReference: 'ORD-000001', currency: 'EUR', releasedAmount: 10_000, availableCreditAfter: 50_000 }) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    await adapter.releaseCredit({ orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001' }, META);

    expect(calledSubject).toBe(CREDIT_RELEASE_SUBJECT);
  });
});

describe('NatsSagaCommandsAdapter — trace propagation (OR4, R57, design.md §4.3)', () => {
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    const exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
  });

  afterAll(async () => {
    contextManager.disable();
    await provider.shutdown();
  });

  it('every outbound call injects the active span\'s REAL traceId — extractable back to the SAME traceId, not merely "a header is present"', async () => {
    const replyCodec = JSONCodec<StockReserveReplyPayload>();
    const body: StockReserveReplyPayload = { outcome: 'accepted', orderReference: 'ORD-000001', reservations: [] };
    let capturedHeaders: MsgHdrs | undefined;
    const client = fakeClient(async (_subject, _data, opts) => {
      capturedHeaders = opts.headers;
      return { data: replyCodec.encode(body) };
    });
    const adapter = new NatsSagaCommandsAdapter(client, 5000);

    const span = tracer().startSpan('test-saga-command-span');
    const { traceId } = span.spanContext();

    await context.with(trace.setSpan(context.active(), span), () =>
      adapter.reserveStock(
        {
          orderReference: 'ORD-000001',
          retailerCode: 'RET-0001',
          companyCode: 'COM-0001',
          lines: [{ productCode: 'PRD-0001', units: 1 }],
        },
        META,
      ),
    );
    span.end();

    expect(capturedHeaders).toBeDefined();
    const extracted = extractNatsTraceContext(capturedHeaders);
    const extractedSpanContext = trace.getSpanContext(extracted);
    expect(extractedSpanContext).toBeDefined();
    expect(extractedSpanContext!.traceId).toBe(traceId);
  });
});
