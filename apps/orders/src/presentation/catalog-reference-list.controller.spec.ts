// Pure unit — a faked `QueryBus`, no NestJS bootstrap, no NATS, no database.
// Proves the controller never throws: every outcome resolves with a plain
// object discriminated by shape (`products`/... vs `code`) — mirrors
// orders-create.controller.spec.ts's own shape for the same reason.
import { describe, expect, it, vi } from 'vitest';
import type { NatsContext } from '@nestjs/microservices';
import type { QueryBus } from '@nestjs/cqrs';
import type { CatalogReferenceListReplyPayload } from '@otc/contracts';
import { CatalogReferenceListController } from './catalog-reference-list.controller';
import { ListCatalogReferenceQuery } from '../application/queries/list-catalog-reference.query';

function fakeNatsContext(): NatsContext {
  return { getHeaders: () => undefined } as unknown as NatsContext;
}

function fakeQueryBus(execute: (query: ListCatalogReferenceQuery) => Promise<CatalogReferenceListReplyPayload>): QueryBus {
  return { execute } as unknown as QueryBus;
}

describe('CatalogReferenceListController — catalog.reference.list', () => {
  it('returns the QueryBus reply as-is on success', async () => {
    const reply: CatalogReferenceListReplyPayload = {
      products: [{ code: 'PRD-0001', name: 'Widget', price: 999, currency: 'EUR', enabled: true }],
    };
    const bus = fakeQueryBus(async () => reply);
    const controller = new CatalogReferenceListController(bus);

    const result = await controller.list({ kinds: ['products'] }, fakeNatsContext());

    expect(result).toEqual(reply);
  });

  it('defaults an omitted request body to kinds: [] (=> all) and includeDisabled: false', async () => {
    let seenQuery: ListCatalogReferenceQuery | undefined;
    const bus = fakeQueryBus(async (query) => {
      seenQuery = query;
      return {};
    });
    const controller = new CatalogReferenceListController(bus);

    await controller.list(undefined, fakeNatsContext());

    expect(seenQuery?.kinds).toEqual([]);
    expect(seenQuery?.includeDisabled).toBe(false);
  });

  it('returns a VALIDATION_FAILED RpcError, never throws, for a malformed request (kinds carrying an unknown value)', async () => {
    const bus = fakeQueryBus(vi.fn());
    const controller = new CatalogReferenceListController(bus);

    const reply = await controller.list({ kinds: ['not-a-real-kind'] }, fakeNatsContext());

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns an INTERNAL_ERROR RpcError, never throws, when the QueryBus rejects', async () => {
    const bus = fakeQueryBus(async () => {
      throw new Error('boom');
    });
    const controller = new CatalogReferenceListController(bus);

    const reply = await controller.list({ kinds: ['products'] }, fakeNatsContext());

    expect(reply).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
