// COPY OF — apps/fulfillment/src/infrastructure/messaging/bare-json-nats.spec.ts
// Pure unit — no broker, no Nest application context (design.md §4.3): both
// (de)serializer directions, verified against the installed
// @nestjs/microservices@11.2.1's actual `ServerNats` call shape
// (`deserializer.deserialize(rawMessage, { channel, replyTo })`,
// `serializer.serialize({ response, err, id, isDisposed })`).
import { JSONCodec } from 'nats';
import { describe, expect, it } from 'vitest';
import type { RpcError } from '@otc/contracts';
import { BareJsonNatsDeserializer } from './bare-json-nats.deserializer';
import { BareJsonNatsSerializer } from './bare-json-nats.serializer';

const codec = JSONCodec();

describe('BareJsonNatsDeserializer', () => {
  it('an id-less bare-JSON request WITH a reply subject gains a synthetic id and is mapped to { pattern, data, id }', () => {
    const payload = { companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', quantity: 2 }] };
    const deserializer = new BareJsonNatsDeserializer();

    const message = deserializer.deserialize(codec.encode(payload), {
      channel: 'fulfillment.stock.check',
      replyTo: 'reply.subject.123',
    }) as { pattern: string; data: unknown; id?: string };

    expect(message.pattern).toBe('fulfillment.stock.check');
    expect(message.data).toEqual(payload);
    expect(message.id).toBeDefined();
    expect(typeof message.id).toBe('string');
  });

  it('an id-less bare-JSON message WITHOUT a reply subject stays an event (no id)', () => {
    const payload = { companyCode: 'COM-0001' };
    const deserializer = new BareJsonNatsDeserializer();

    const message = deserializer.deserialize(codec.encode(payload), {
      channel: 'fulfillment.stock.check',
    }) as { pattern: string; data: unknown; id?: string };

    expect(message.pattern).toBe('fulfillment.stock.check');
    expect(message.data).toEqual(payload);
    expect(message.id).toBeUndefined();
  });

  it('two id-less requests each get a DIFFERENT synthetic id', () => {
    const deserializer = new BareJsonNatsDeserializer();
    const options = { channel: 'fulfillment.stock.check', replyTo: 'reply.subject' };

    const first = deserializer.deserialize(codec.encode({ a: 1 }), options) as { id?: string };
    const second = deserializer.deserialize(codec.encode({ a: 2 }), options) as { id?: string };

    expect(first.id).not.toBe(second.id);
  });
});

describe('BareJsonNatsSerializer', () => {
  it('serialize emits packet.response bare — no response/isDisposed/id wrapper on the wire', () => {
    const serializer = new BareJsonNatsSerializer();
    const reply = { outcome: 'accepted', orderReference: 'ORD-000001', reservations: [] };

    const record = serializer.serialize({ response: reply, isDisposed: true, id: 'some-id' });

    const decoded = codec.decode(record.data as Uint8Array);
    expect(decoded).toEqual(reply);
  });

  it('packet.err ⇒ a bare RpcError with code INTERNAL_ERROR', () => {
    const serializer = new BareJsonNatsSerializer();

    const record = serializer.serialize({ err: 'No message handler defined', id: 'some-id' });

    const decoded = codec.decode(record.data as Uint8Array) as RpcError;
    expect(decoded.code).toBe('INTERNAL_ERROR');
    expect(decoded.message).toContain('No message handler defined');
    expect(decoded).not.toHaveProperty('response');
    expect(decoded).not.toHaveProperty('isDisposed');
    expect(decoded).not.toHaveProperty('id');
  });
});
