// Pure unit — fake `QueryBus`/`CommandBus` (CLAUDE.md § Testing
// conventions). Proves: FS3's header refusal on reserve/release; the
// subject constants equal the AsyncAPI channel addresses (read-the-spec-
// as-text); a validation failure replies RpcError and dispatches nothing;
// a handler error is mapped to an RpcError; the controller never throws.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NatsContext } from '@nestjs/microservices';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import {
  STOCK_CHECK_SUBJECT,
  STOCK_LIST_SUBJECT,
  STOCK_RELEASE_SUBJECT,
  STOCK_REPLENISH_SUBJECT,
  STOCK_RESERVE_SUBJECT,
  StockController,
} from './stock.controller';
import { NoKnownStockItemError } from '../application/stock-application-errors';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/asyncapi.yaml');

function channelAddress(specText: string, channelName: string): string {
  const blockMatch = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!blockMatch) {
    throw new Error(`stock.controller.spec: could not locate the ${channelName} channel block`);
  }
  const addressMatch = blockMatch[1]!.match(/address:\s*(\S+)/);
  if (!addressMatch) {
    throw new Error(`stock.controller.spec: ${channelName} channel has no address`);
  }
  return addressMatch[1]!;
}

describe('StockController — subject constants match the AsyncAPI addresses', () => {
  it('uses exactly the five documented subjects, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(STOCK_CHECK_SUBJECT).toBe(channelAddress(specText, 'stockCheck'));
    expect(STOCK_RESERVE_SUBJECT).toBe(channelAddress(specText, 'stockReserve'));
    expect(STOCK_RELEASE_SUBJECT).toBe(channelAddress(specText, 'stockRelease'));
    expect(STOCK_LIST_SUBJECT).toBe(channelAddress(specText, 'stockList'));
    expect(STOCK_REPLENISH_SUBJECT).toBe(channelAddress(specText, 'stockReplenish'));
  });
});

function fakeContext(headers?: Record<string, string>): NatsContext {
  const headerRecord: Record<string, string> = headers ?? {};
  const hdrs = headers
    ? {
        get: (key: string) => headerRecord[key] ?? '',
      }
    : undefined;
  return new NatsContext(['fulfillment.stock.reserve', hdrs]);
}

function buses() {
  const queryExecute = vi.fn();
  const commandExecute = vi.fn();
  const queries = { execute: queryExecute } as unknown as import('@nestjs/cqrs').QueryBus;
  const commands = { execute: commandExecute } as unknown as import('@nestjs/cqrs').CommandBus;
  return { queries, commands, queryExecute, commandExecute };
}

describe('StockController — FS3 header refusal', () => {
  it('replies VALIDATION_FAILED and dispatches nothing when x-correlation-id or x-request-id is missing or malformed on stock.reserve', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new StockController(queries, commands);
    const validRequest = { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', units: 1 }] };

    const noHeaders = await controller.reserve(validRequest, fakeContext());
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    const malformed = await controller.reserve(validRequest, fakeContext({ 'x-correlation-id': 'not-a-uuid', 'x-request-id': UniqueId.generate().value }));
    expect(malformed).toMatchObject({ code: 'VALIDATION_FAILED' });

    const missingOne = await controller.reserve(validRequest, fakeContext({ 'x-correlation-id': UniqueId.generate().value }));
    expect(missingOne).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('replies VALIDATION_FAILED and dispatches nothing when headers are missing on stock.release', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new StockController(queries, commands);

    const result = await controller.release({ orderReference: 'ORD-000001', reason: 'credit_rejected' }, fakeContext());

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('dispatches with the parsed correlationId/requestId when headers are present and valid', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockResolvedValue({ outcome: 'accepted', orderReference: 'ORD-000001', reservations: [] });
    const controller = new StockController(queries, commands);
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    await controller.reserve(
      { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', units: 1 }] },
      fakeContext({ 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value }),
    );

    expect(commandExecute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = commandExecute.mock.calls[0]![0];
    expect(dispatchedCommand.correlationId.equals(correlationId)).toBe(true);
    expect(dispatchedCommand.requestId.equals(requestId)).toBe(true);
  });
});

describe('StockController — validation and error mapping, never throws', () => {
  it('a validation failure on stock.check replies RpcError and dispatches nothing', async () => {
    const { queries, commands, queryExecute } = buses();
    const controller = new StockController(queries, commands);

    const result = await controller.check({ companyCode: 'COM-0001', lines: [] });

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(queryExecute).not.toHaveBeenCalled();
  });

  it('a handler error on stock.check is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, queryExecute } = buses();
    queryExecute.mockRejectedValue(new Error('boom'));
    const controller = new StockController(queries, commands);

    const result = await controller.check({ companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', quantity: 1 }] });

    expect(result).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('a handler error on stock.replenish maps NoKnownStockItemError-shaped domain errors through toRpcError', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockRejectedValue(new NoKnownStockItemError('ORD-000001'));
    const controller = new StockController(queries, commands);

    const result = await controller.replenish({ companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', units: 1 }] });

    expect(result).toMatchObject({ code: 'NOT_FOUND' });
  });
});
