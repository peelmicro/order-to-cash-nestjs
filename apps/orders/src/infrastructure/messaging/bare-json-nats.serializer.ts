// COPY OF — apps/fulfillment/src/infrastructure/messaging/bare-json-nats.serializer.ts
// (also copied to apps/billing under the same name.)
//
// The reply half of the wire finding (design.md §6.3, fulfillment_stock;
// also progress/review_gateway_rest_auth.md F1): `@nestjs/microservices`'s
// default `NatsRecordSerializer` wraps every reply in the Nest packet
// `{ response, isDisposed, id, err }` — not the bare payload a bare-JSON
// caller (the Gateway's `NatsRpcClientAdapter`, and the saga's own
// `NatsSagaCommandsAdapter`) decodes. `BareJsonNatsSerializer` emits
// `packet.response` ALONE when present; when `packet.err` is set (the only
// source is Nest's own `NO_MESSAGE_HANDLER`, since `OrdersCreateController`
// never throws) it emits a bare `RpcError` `INTERNAL_ERROR`. Nothing else
// from the packet reaches the wire.
import { JSONCodec } from 'nats';
import { NatsRecord } from '@nestjs/microservices';
import type { Serializer } from '@nestjs/microservices';
import type { RpcError } from '@otc/contracts';

interface NestOutgoingPacket {
  readonly response?: unknown;
  readonly err?: unknown;
  readonly id?: string;
  readonly isDisposed?: boolean;
}

const jsonCodec = JSONCodec();

export class BareJsonNatsSerializer implements Serializer<NestOutgoingPacket, NatsRecord> {
  serialize(packet: NestOutgoingPacket): NatsRecord {
    if (packet?.err !== undefined && packet?.err !== null) {
      const rpcError: RpcError = {
        code: 'INTERNAL_ERROR',
        message: String(packet.err),
        occurredAt: new Date().toISOString(),
      };
      return new NatsRecord(jsonCodec.encode(rpcError));
    }
    return new NatsRecord(jsonCodec.encode(packet?.response));
  }
}
