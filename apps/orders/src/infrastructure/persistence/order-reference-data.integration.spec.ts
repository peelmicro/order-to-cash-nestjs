// Real MySQL (Testcontainers, mysql:8.4.11). Proves `DrizzleOrderReferenceDataRepository`
// resolves the fixture's reference rows and correctly reports a code that
// does not exist as absent (`null` / missing from the products map) rather
// than throwing — `PlaceOrderHandler` turns that into a clean NOT_FOUND
// RpcError.
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
});
