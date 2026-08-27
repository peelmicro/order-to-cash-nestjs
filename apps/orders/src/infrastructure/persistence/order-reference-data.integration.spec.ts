// Real MySQL (Testcontainers, mysql:8.4.11). Proves `DrizzleOrderReferenceDataRepository`
// resolves the fixture's reference rows and correctly reports a code that
// does not exist as absent (`null` / missing from the products map) rather
// than throwing — `PlaceOrderHandler` turns that into a clean NOT_FOUND
// RpcError.
//
// `orders_catalog_responder` (`describe('list', ...)` below): the SAME
// repository instance, proving `CatalogReferenceListPort.list` reads the
// SAME fixture rows `resolve` above reads — the whole point of "one class,
// two ports" (catalog-reference-list.port.ts's header).
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { DrizzleOrderReferenceDataRepository } from './order-reference-data.repository';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_COMPANY_GLN,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  FIXTURE_RETAILER_GLN,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from './test-support/orders-test-fixture';
import { currencies as currenciesTable, products as productsTable } from './schema';

describe('DrizzleOrderReferenceDataRepository (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;
  let repository: DrizzleOrderReferenceDataRepository;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
    repository = new DrizzleOrderReferenceDataRepository(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  it('resolves the retailer, company, currency and product rows the fixture seeded', async () => {
    const result = await repository.resolve({
      retailerCode: FIXTURE_RETAILER_CODE,
      companyCode: FIXTURE_COMPANY_CODE,
      currency: FIXTURE_CURRENCY,
      productCodes: [FIXTURE_PRODUCT_CODE],
    });

    expect(result.retailer).toMatchObject({ code: FIXTURE_RETAILER_CODE });
    expect(result.retailer?.gln.value).toBe(FIXTURE_RETAILER_GLN);
    expect(result.company).toMatchObject({ code: FIXTURE_COMPANY_CODE });
    expect(result.company?.gln.value).toBe(FIXTURE_COMPANY_GLN);
    expect(result.currencyExists).toBe(true);
    const product = result.products.get(FIXTURE_PRODUCT_CODE);
    expect(product?.description).toBe('A widget for integration testing');
    expect(product?.price.amount).toBe(1_000);
    expect(product?.price.currency).toBe(FIXTURE_CURRENCY);
  });

  it('reports an unknown retailer/company/currency/product as absent rather than throwing', async () => {
    const result = await repository.resolve({
      retailerCode: 'RET-9999',
      companyCode: 'COM-9999',
      currency: 'ZZZ',
      productCodes: ['PRD-9999'],
    });

    expect(result.retailer).toBeNull();
    expect(result.company).toBeNull();
    expect(result.currencyExists).toBe(false);
    expect(result.products.has('PRD-9999')).toBe(false);
  });

  describe('list — orders_catalog_responder, the SAME repository/db as resolve() above', () => {
    const DISABLED_PRODUCT_CODE = 'PRD-DISABLED';

    beforeAll(async () => {
      const [currencyRow] = await fixture.db
        .select({ id: currenciesTable.id })
        .from(currenciesTable);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      await fixture.db.insert(productsTable).values({
        id: randomUUID(),
        code: DISABLED_PRODUCT_CODE,
        ean: '5901234123464',
        name: 'Discontinued Widget',
        description: 'No longer sold',
        price: 500,
        currencyId: currencyRow.id,
        disabledAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    it('with no kinds requested, returns all four collections, keyed by kind, matching the fixture rows', async () => {
      const reply = await repository.list({ kinds: [], includeDisabled: false });

      expect(reply.products).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: FIXTURE_PRODUCT_CODE, currency: FIXTURE_CURRENCY, enabled: true }),
      ]));
      expect(reply.retailers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: FIXTURE_RETAILER_CODE, gln: FIXTURE_RETAILER_GLN, enabled: true }),
      ]));
      expect(reply.companies).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: FIXTURE_COMPANY_CODE, gln: FIXTURE_COMPANY_GLN, enabled: true }),
      ]));
      expect(reply.currencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: FIXTURE_CURRENCY, decimalPoints: 2 }),
      ]));
    });

    it('honours a `kinds` filter — only the requested collections are present on the reply (others are undefined, never an empty array)', async () => {
      const reply = await repository.list({ kinds: ['products'], includeDisabled: false });

      expect(reply.products).toBeDefined();
      expect(reply.retailers).toBeUndefined();
      expect(reply.companies).toBeUndefined();
      expect(reply.currencies).toBeUndefined();
    });

    it('excludes a disabled product by default (includeDisabled: false)', async () => {
      const reply = await repository.list({ kinds: ['products'], includeDisabled: false });

      expect(reply.products?.some((product) => product.code === DISABLED_PRODUCT_CODE)).toBe(false);
    });

    it('includes the disabled product, correctly flagged enabled: false, when includeDisabled: true', async () => {
      const reply = await repository.list({ kinds: ['products'], includeDisabled: true });

      const disabled = reply.products?.find((product) => product.code === DISABLED_PRODUCT_CODE);
      expect(disabled).toMatchObject({ code: DISABLED_PRODUCT_CODE, enabled: false, price: 500, currency: FIXTURE_CURRENCY });
    });
  });
});
