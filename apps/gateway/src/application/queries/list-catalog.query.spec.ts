import { describe, expect, it } from 'vitest';
import { CATALOG_REFERENCE_LIST_SUBJECT, ListCatalogHandler, ListCatalogQuery } from './list-catalog.query';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';
import { RpcTransportError } from '../ports/rpc-client.port';

describe('ListCatalogHandler', () => {
  it('translates to catalog.reference.list, requesting only the requested kind', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(CATALOG_REFERENCE_LIST_SUBJECT, { products: [{ code: 'PRD-0001', name: 'Widget', price: 999, currency: 'EUR', enabled: true }] });
    const handler = new ListCatalogHandler(rpc);

    const result = await handler.execute(new ListCatalogQuery('products', false));

    expect(rpc.calls[0]?.subject).toBe(CATALOG_REFERENCE_LIST_SUBJECT);
    expect((rpc.calls[0]?.payload as { kinds: string[] }).kinds).toEqual(['products']);
    expect(result.products).toHaveLength(1);
  });

  it('surfaces UNAVAILABLE as a typed error when no responder answers catalog.reference.list (the recorded gap)', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(CATALOG_REFERENCE_LIST_SUBJECT, new RpcTransportError(CATALOG_REFERENCE_LIST_SUBJECT, 'no responder is subscribed to this subject'));
    const handler = new ListCatalogHandler(rpc);

    await expect(handler.execute(new ListCatalogQuery('retailers', false))).rejects.toBeInstanceOf(RpcTransportError);
  });
});
