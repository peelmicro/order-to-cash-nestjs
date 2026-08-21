// Pure unit — a fake `NatsRequestClient`, never a real broker (that is
// `stock-check.integration.spec.ts`'s job, real NATS via Testcontainers).
// Proves the outbound `fulfillment.stock.check` adapter distinguishes a
// business rejection (`available: false`) from a transport-level timeout,
// which the caller (`PlaceOrderHandler`) must handle explicitly rather than
// let hang — the Kafka-vs-NATS decision matrix's "a timeout is a
// legitimate, handled answer".
import { ErrorCode, JSONCodec, NatsError } from 'nats';
import { describe, expect, it } from 'vitest';
import type { RpcError, StockCheckReplyPayload } from '@otc/contracts';
import { StockCheckTimeoutError, StockCheckTransportError } from '../../application/ports/stock-availability.port';
import { NatsStockAvailabilityAdapter, STOCK_CHECK_SUBJECT, type NatsRequestClient } from './nats-stock-availability.adapter';

const replyCodec = JSONCodec<StockCheckReplyPayload | RpcError>();

function fakeClient(handler: NatsRequestClient['request']): NatsRequestClient {
  return { request: handler };
}

describe('NatsStockAvailabilityAdapter', () => {
  it('returns the parsed reply when every line is sufficient', async () => {
    const body: StockCheckReplyPayload = {
      available: true,
      lines: [{ productCode: 'PRD-0001', requested: 2, available: 10, sufficient: true }],
    };
    const client = fakeClient(async (subject, _data, opts) => {
      expect(subject).toBe(STOCK_CHECK_SUBJECT);
      expect(opts.timeout).toBe(2000);
      return { data: replyCodec.encode(body) };
    });
    const adapter = new NatsStockAvailabilityAdapter(client, 2000);

    const result = await adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 2 }]);

    expect(result).toEqual(body);
  });

  it('returns the parsed reply when a line is insufficient — a business outcome, not a thrown error', async () => {
    const body: StockCheckReplyPayload = {
      available: false,
      lines: [{ productCode: 'PRD-0001', requested: 50, available: 3, sufficient: false }],
    };
    const client = fakeClient(async () => ({ data: replyCodec.encode(body) }));
    const adapter = new NatsStockAvailabilityAdapter(client, 2000);

    const result = await adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 50 }]);

    expect(result.available).toBe(false);
    expect(result.lines[0]?.sufficient).toBe(false);
  });

  it('throws StockCheckTimeoutError, never hangs, when the NATS client reports a TIMEOUT', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('timeout', ErrorCode.Timeout);
    });
    const adapter = new NatsStockAvailabilityAdapter(client, 1500);

    await expect(adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 1 }])).rejects.toThrow(
      StockCheckTimeoutError,
    );
  });

  it('throws StockCheckTransportError, distinct from a timeout, when nobody is subscribed to the subject', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('no responders', ErrorCode.NoResponders);
    });
    const adapter = new NatsStockAvailabilityAdapter(client, 1500);

    await expect(adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 1 }])).rejects.toThrow(
      StockCheckTransportError,
    );
  });

  it('throws StockCheckTransportError when the responder itself replies with an RpcError', async () => {
    const errorReply: RpcError = { code: 'INTERNAL_ERROR', message: 'boom' };
    const client = fakeClient(async () => ({ data: replyCodec.encode(errorReply) }));
    const adapter = new NatsStockAvailabilityAdapter(client, 1500);

    await expect(adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 1 }])).rejects.toThrow(
      StockCheckTransportError,
    );
  });
});
