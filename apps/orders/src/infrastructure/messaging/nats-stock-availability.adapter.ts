// The `StockAvailabilityPort` adapter — calls `fulfillment.stock.check`
// over NATS core request-reply, design.md-equivalent asymmetry to the
// outbox relay's kafkajs-direct producer (outbox_and_idempotency
// design.md §5.3: "kafkajs directly, not `@nestjs/microservices`... the
// asymmetry is deliberate and recorded"): this OUTBOUND call needs
// explicit, per-call control of the request timeout, which is exactly what
// the plain `nats` client's `request(subject, data, { timeout })` gives —
// `@nestjs/microservices`'s NATS transport is used for the INBOUND
// `orders.create` responder only (`main.ts`, `orders-create.controller.ts`).
//
// `NatsRequestClient` is the minimal structural surface this adapter needs
// from a real `nats` `NatsConnection` — narrow on purpose, so
// `nats-stock-availability.adapter.spec.ts` can assert timeout/transport-error
// handling with a plain fake, never a real broker (that is what
// `stock-check.integration.spec.ts` is for).
import { ErrorCode, JSONCodec, type NatsConnection } from 'nats';
import type { RpcError, StockCheckReplyPayload, StockCheckRequestPayload } from '@otc/contracts';
import {
  StockCheckTimeoutError,
  StockCheckTransportError,
  type StockAvailabilityLine,
  type StockAvailabilityPort,
  type StockAvailabilityResult,
} from '../../application/ports/stock-availability.port';

export const STOCK_CHECK_SUBJECT = 'fulfillment.stock.check';

export interface NatsRequestMessage {
  readonly data: Uint8Array;
}

export interface NatsRequestClient {
  request(subject: string, data: Uint8Array, opts: { timeout: number }): Promise<NatsRequestMessage>;
}

function isRpcErrorReply(body: unknown): body is RpcError {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string';
}

/** `nats`'s `NatsError.code` values that mean "nobody is listening", distinct from a timeout — worth surfacing immediately rather than waiting out the full deadline. */
function isNoRespondersError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === ErrorCode.NoResponders
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === ErrorCode.Timeout
  );
}

export class NatsStockAvailabilityAdapter implements StockAvailabilityPort {
  private readonly requestCodec = JSONCodec<StockCheckRequestPayload>();
  private readonly replyCodec = JSONCodec<StockCheckReplyPayload | RpcError>();

  constructor(
    private readonly connection: NatsRequestClient | NatsConnection,
    private readonly timeoutMs: number,
    private readonly subject: string = STOCK_CHECK_SUBJECT,
  ) {}

  async check(companyCode: string, lines: readonly StockAvailabilityLine[]): Promise<StockAvailabilityResult> {
    const requestLines = lines as unknown as StockCheckRequestPayload['lines'];
    const payload: StockCheckRequestPayload = { companyCode, lines: requestLines };

    let reply: NatsRequestMessage;
    try {
      reply = await this.connection.request(this.subject, this.requestCodec.encode(payload), {
        timeout: this.timeoutMs,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new StockCheckTimeoutError(this.subject, this.timeoutMs);
      }
      if (isNoRespondersError(error)) {
        throw new StockCheckTransportError(this.subject, 'no responder is subscribed to this subject');
      }
      throw new StockCheckTransportError(this.subject, error instanceof Error ? error.message : String(error));
    }

    let body: StockCheckReplyPayload | RpcError;
    try {
      body = this.replyCodec.decode(reply.data);
    } catch (error) {
      throw new StockCheckTransportError(
        this.subject,
        `reply payload was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (isRpcErrorReply(body)) {
      throw new StockCheckTransportError(this.subject, `responder returned ${body.code}: ${body.message}`);
    }

    return { available: body.available, lines: body.lines };
  }
}
