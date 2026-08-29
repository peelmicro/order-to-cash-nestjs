// The `*ByCode` / `*Of` lookup helpers each have a found-branch and a
// not-found-branch; the reference-data fixtures they read from are only
// ever exercised by their happy path elsewhere (writers, mongo.writer.ts),
// so the "unknown code" branch of every one of these was previously never
// hit by the unit suite (feature 34, sonarqube_quality_gates).
import { describe, expect, it } from 'vitest';
import { RETAILERS, retailerByCode } from './retailers.data';
import { COMPANIES, companyByCode } from './companies.data';
import { PRODUCTS, productByCode } from './products.data';
import { CURRENCIES, currencyIdByCode } from './currencies.data';
import { primarySupplierOf, creditByRetailerAndCompany, CREDITS } from './credits.data';

describe('retailerByCode', () => {
  it('finds every seeded retailer by its own code', () => {
    for (const retailer of RETAILERS) {
      expect(retailerByCode(retailer.code)).toEqual(retailer);
    }
  });

  it('throws, naming the code, for an unknown retailer code', () => {
    expect(() => retailerByCode('NoSuchRetailer')).toThrow(
      /retailerByCode: unknown retailer code "NoSuchRetailer"/,
    );
  });
});

describe('companyByCode', () => {
  it('finds every seeded company by its own code', () => {
    for (const company of COMPANIES) {
      expect(companyByCode(company.code)).toEqual(company);
    }
  });

  it('throws, naming the code, for an unknown company code', () => {
    expect(() => companyByCode('NOSUCHCOMPANY')).toThrow(
      /companyByCode: unknown company code "NOSUCHCOMPANY"/,
    );
  });
});

describe('productByCode', () => {
  it('finds every seeded product by its own code', () => {
    for (const product of PRODUCTS) {
      expect(productByCode(product.code)).toEqual(product);
    }
  });

  it('throws, naming the code, for an unknown product code', () => {
    expect(() => productByCode('NOSUCHPRODUCT')).toThrow(
      /productByCode: unknown product code "NOSUCHPRODUCT"/,
    );
  });
});

describe('currencyIdByCode', () => {
  it('finds every seeded currency id by its own code', () => {
    for (const currency of CURRENCIES) {
      expect(currencyIdByCode(currency.code)).toBe(currency.id);
    }
  });

  it('throws, naming the code, for an unknown currency code', () => {
    expect(() => currencyIdByCode('XXX')).toThrow(
      /currencyIdByCode: unknown currency code "XXX"/,
    );
  });
});

describe('primarySupplierOf', () => {
  it('returns the primary supplier company code for every seeded retailer', () => {
    for (const retailer of RETAILERS) {
      expect(typeof primarySupplierOf(retailer.code)).toBe('string');
    }
  });

  it('throws, naming the code, for an unknown retailer code', () => {
    expect(() => primarySupplierOf('NoSuchRetailer')).toThrow(
      /primarySupplierOf: no primary supplier configured for retailer "NoSuchRetailer"/,
    );
  });
});

describe('creditByRetailerAndCompany', () => {
  it('finds the credit line for every seeded (retailer, company) pair', () => {
    for (const credit of CREDITS) {
      expect(creditByRetailerAndCompany(credit.retailerCode, credit.companyCode)).toEqual(credit);
    }
  });

  it('throws, naming both codes, when no credit line exists for the pair', () => {
    expect(() => creditByRetailerAndCompany('NoSuchRetailer', 'NOSUCHCOMPANY')).toThrow(
      /creditByRetailerAndCompany: no credit line for NoSuchRetailer\/NOSUCHCOMPANY/,
    );
  });
});
