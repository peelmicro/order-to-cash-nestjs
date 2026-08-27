// Pure unit test — a fake `CatalogReferenceListPort`, no NestJS test module,
// no DB. Proves `ListCatalogReferenceHandler` is a thin pass-through onto
// the port (the port's own Drizzle implementation is proven separately,
// against real MySQL, in `order-reference-data.integration.spec.ts`).
import { describe, expect, it, vi } from 'vitest';
import type { CatalogReferenceListReplyPayload } from '@otc/contracts';
import { ListCatalogReferenceHandler, ListCatalogReferenceQuery } from './list-catalog-reference.query';
import type { CatalogReferenceListInput, CatalogReferenceListPort } from '../ports/catalog-reference-list.port';

describe('ListCatalogReferenceHandler', () => {
  it('forwards kinds and includeDisabled to the port and returns its reply unchanged', async () => {
    const reply: CatalogReferenceListReplyPayload = {
      products: [{ code: 'PRD-0001', name: 'Widget', price: 999, currency: 'EUR', enabled: true }],
    };
    let seenInput: CatalogReferenceListInput | undefined;
    const port: CatalogReferenceListPort = {
      list: vi.fn(async (input) => {
        seenInput = input;
        return reply;
      }),
    };
    const handler = new ListCatalogReferenceHandler(port);

    const result = await handler.execute(new ListCatalogReferenceQuery(['products'], true));

    expect(seenInput).toEqual({ kinds: ['products'], includeDisabled: true });
    expect(result).toBe(reply);
  });

  it('passes an empty kinds array through unchanged — the port, not the handler, resolves "all four"', async () => {
    let seenInput: CatalogReferenceListInput | undefined;
    const port: CatalogReferenceListPort = {
      list: vi.fn(async (input) => {
        seenInput = input;
        return {};
      }),
    };
    const handler = new ListCatalogReferenceHandler(port);

    await handler.execute(new ListCatalogReferenceQuery([], false));

    expect(seenInput).toEqual({ kinds: [], includeDisabled: false });
  });
});
