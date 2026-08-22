// Pure unit — fake `QueryBus`/`CommandBus` (CLAUDE.md § Testing
// conventions). Proves: BC1's header refusal on hold; the subject constants
// equal the AsyncAPI channel addresses (read-the-spec-as-text); a
// validation failure replies RpcError and dispatches nothing; a handler
// error is mapped to an RpcError; the controller never throws.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NatsContext } from '@nestjs/microservices';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import { CREDIT_HOLD_SUBJECT, CREDIT_LIST_SUBJECT, CreditController } from './credit.controller';
import { CreditLineNotFoundError } from '../application/credit-application-errors';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/asyncapi.yaml');

function channelAddress(specText: string, channelName: string): string {
  const blockMatch = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!blockMatch) {
    throw new Error(`credit.controller.spec: could not locate the ${channelName} channel block`);
  }
  const addressMatch = blockMatch[1]!.match(/address:\s*(\S+)/);
  if (!addressMatch) {
    throw new Error(`credit.controller.spec: ${channelName} channel has no address`);
  }
  return addressMatch[1]!;
}

describe('CreditController — subject constants match the AsyncAPI addresses', () => {
  it('uses exactly the two documented subjects, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(CREDIT_HOLD_SUBJECT).toBe(channelAddress(specText, 'creditHold'));
    expect(CREDIT_LIST_SUBJECT).toBe(channelAddress(specText, 'creditList'));
  });
});

function fakeContext(headers?: Record<string, string>): NatsContext {
  const headerRecord: Record<string, string> = headers ?? {};
  const hdrs = headers ? { get: (key: string) => headerRecord[key] ?? '' } : undefined;
  return new NatsContext(['billing.credit.hold', hdrs]);
}

function buses() {
  const queryExecute = vi.fn();
  const commandExecute = vi.fn();
  const queries = { execute: queryExecute } as unknown as import('@nestjs/cqrs').QueryBus;
  const commands = { execute: commandExecute } as unknown as import('@nestjs/cqrs').CommandBus;
  return { queries, commands, queryExecute, commandExecute };
}

const VALID_REQUEST = { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', amount: { amount: 4_000, currency: 'EUR' } };

describe('CreditController — BC1 header refusal', () => {
  it('replies VALIDATION_FAILED and dispatches nothing when x-correlation-id or x-request-id is missing or malformed on billing.credit.hold', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new CreditController(queries, commands);

    const noHeaders = await controller.hold(VALID_REQUEST, fakeContext());
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    const malformed = await controller.hold(VALID_REQUEST, fakeContext({ 'x-correlation-id': 'not-a-uuid', 'x-request-id': UniqueId.generate().value }));
    expect(malformed).toMatchObject({ code: 'VALIDATION_FAILED' });

    const missingOne = await controller.hold(VALID_REQUEST, fakeContext({ 'x-correlation-id': UniqueId.generate().value }));
    expect(missingOne).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('dispatches with the parsed correlationId/requestId when headers are present and valid', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockResolvedValue({ outcome: 'approved', orderReference: 'ORD-000001', currency: 'EUR', availableCredit: 6_000 });
    const controller = new CreditController(queries, commands);
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    await controller.hold(VALID_REQUEST, fakeContext({ 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value }));

    expect(commandExecute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = commandExecute.mock.calls[0]![0];
    expect(dispatchedCommand.correlationId.equals(correlationId)).toBe(true);
    expect(dispatchedCommand.requestId.equals(requestId)).toBe(true);
  });
});

describe('CreditController — validation and error mapping, never throws', () => {
  it('a validation failure on billing.credit.hold replies RpcError and dispatches nothing', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new CreditController(queries, commands);

    const result = await controller.hold(
      { orderReference: 'not-a-valid-reference', retailerCode: 'RET-0001', companyCode: 'COM-0001', amount: { amount: 4_000, currency: 'EUR' } },
      fakeContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('a validation failure on billing.credit.list replies RpcError and dispatches nothing', async () => {
    const { queries, commands, queryExecute } = buses();
    const controller = new CreditController(queries, commands);

    const result = await controller.list({ page: 0 });

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(queryExecute).not.toHaveBeenCalled();
  });

  it('a handler error on billing.credit.hold is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockRejectedValue(new CreditLineNotFoundError('AldiDe', 'ALBIONFOODS'));
    const controller = new CreditController(queries, commands);

    const result = await controller.hold(
      VALID_REQUEST,
      fakeContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a handler error on billing.credit.list is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, queryExecute } = buses();
    queryExecute.mockRejectedValue(new Error('boom'));
    const controller = new CreditController(queries, commands);

    const result = await controller.list({ page: 1, pageSize: 25 });

    expect(result).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
