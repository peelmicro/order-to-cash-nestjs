// Pure unit — fake `CommandBus` (CLAUDE.md § Testing conventions). Proves:
// FS3's header refusal on despatch.create; the subject constant equals the
// AsyncAPI channel address (read-the-spec-as-text); a validation failure
// replies RpcError and dispatches nothing; a handler error is mapped to an
// RpcError; the controller never throws.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NatsContext } from '@nestjs/microservices';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import { DESPATCH_CREATE_SUBJECT, DespatchController } from './despatch.controller';
import { NoReservedStockForDespatchError } from '../application/despatch-application-errors';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/asyncapi.yaml');

function channelAddress(specText: string, channelName: string): string {
  const blockMatch = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!blockMatch) {
    throw new Error(`despatch.controller.spec: could not locate the ${channelName} channel block`);
  }
  const addressMatch = blockMatch[1]!.match(/address:\s*(\S+)/);
  if (!addressMatch) {
    throw new Error(`despatch.controller.spec: ${channelName} channel has no address`);
  }
  return addressMatch[1]!;
}

describe('DespatchController — subject constant matches the AsyncAPI address', () => {
  it('uses exactly the documented subject, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(DESPATCH_CREATE_SUBJECT).toBe(channelAddress(specText, 'despatchCreate'));
  });
});

function fakeContext(headers?: Record<string, string>): NatsContext {
  const headerRecord: Record<string, string> = headers ?? {};
  const hdrs = headers ? { get: (key: string) => headerRecord[key] ?? '' } : undefined;
  return new NatsContext(['fulfillment.despatch.create', hdrs]);
}

function commandBus() {
  const commandExecute = vi.fn();
  const commands = { execute: commandExecute } as unknown as import('@nestjs/cqrs').CommandBus;
  return { commands, commandExecute };
}

describe('DespatchController — FS3 header refusal', () => {
  it('replies VALIDATION_FAILED and dispatches nothing when x-correlation-id or x-request-id is missing or malformed', async () => {
    const { commands, commandExecute } = commandBus();
    const controller = new DespatchController(commands);
    const validRequest = { orderReference: 'ORD-000001' };

    const noHeaders = await controller.create(validRequest, fakeContext());
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    const malformed = await controller.create(
      validRequest,
      fakeContext({ 'x-correlation-id': 'not-a-uuid', 'x-request-id': UniqueId.generate().value }),
    );
    expect(malformed).toMatchObject({ code: 'VALIDATION_FAILED' });

    const missingOne = await controller.create(
      validRequest,
      fakeContext({ 'x-correlation-id': UniqueId.generate().value }),
    );
    expect(missingOne).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('dispatches with the parsed correlationId/requestId when headers are present and valid', async () => {
    const { commands, commandExecute } = commandBus();
    commandExecute.mockResolvedValue({
      orderReference: 'ORD-000001',
      despatchReference: 'DES-000001',
      despatchDate: new Date().toISOString(),
      created: true,
      lines: [],
    });
    const controller = new DespatchController(commands);
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    await controller.create(
      { orderReference: 'ORD-000001' },
      fakeContext({ 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value }),
    );

    expect(commandExecute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = commandExecute.mock.calls[0]![0];
    expect(dispatchedCommand.correlationId.equals(correlationId)).toBe(true);
    expect(dispatchedCommand.requestId.equals(requestId)).toBe(true);
  });
});

describe('DespatchController — validation and error mapping, never throws', () => {
  it('a validation failure replies RpcError and dispatches nothing', async () => {
    const { commands, commandExecute } = commandBus();
    const controller = new DespatchController(commands);

    const result = await controller.create(
      { orderReference: 'not-an-order-reference' },
      fakeContext({
        'x-correlation-id': UniqueId.generate().value,
        'x-request-id': UniqueId.generate().value,
      }),
    );

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('a handler error (R36 precondition) is mapped to an RpcError, not thrown', async () => {
    const { commands, commandExecute } = commandBus();
    commandExecute.mockRejectedValue(new NoReservedStockForDespatchError('ORD-000001'));
    const controller = new DespatchController(commands);

    const result = await controller.create(
      { orderReference: 'ORD-000001' },
      fakeContext({
        'x-correlation-id': UniqueId.generate().value,
        'x-request-id': UniqueId.generate().value,
      }),
    );

    expect(result).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
