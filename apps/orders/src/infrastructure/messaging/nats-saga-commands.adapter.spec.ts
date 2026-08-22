// Pure unit — a fake `NatsRequestClient`, never a real broker (real NATS is
// the integration specs' job). Proves the timeout / no-responders /
// transport / RpcError-body taxonomy per subject (feature-15 adapter spec
// pattern, design.md §6.1), and that a business rejection resolves
// normally (SO6, unit half).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCode, JSONCodec, NatsError, type MsgHdrs } from 'nats';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type {
  CreditHoldReplyPayload,
  RpcError,
  StockReserveReplyPayload,
} from '@otc/contracts';
import { SagaCommandTimeoutError, SagaCommandTransportError, type SagaCommandMeta } from '../../application/ports/saga-commands.port';
import {
  CREDIT_HOLD_SUBJECT,
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
  it('uses exactly the five documented RPC subjects, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(STOCK_RESERVE_SUBJECT).toBe(channelAddress(specText, 'stockReserve'));
    expect(STOCK_RELEASE_SUBJECT).toBe(channelAddress(specText, 'stockRelease'));
    expect(DESPATCH_CREATE_SUBJECT).toBe(channelAddress(specText, 'despatchCreate'));
    expect(CREDIT_HOLD_SUBJECT).toBe(channelAddress(specText, 'creditHold'));
    expect(INVOICE_ISSUE_SUBJECT).toBe(channelAddress(specText, 'invoiceIssue'));
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
});
