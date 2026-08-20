import { describe, expect, it } from 'vitest';
import { GLN } from '@otc/shared-kernel';
import { RETAILERS } from './retailers.data';
import { COMPANIES } from './companies.data';
import { CURRENCIES } from './currencies.data';
import { PRODUCTS } from './products.data';
import { CREDITS } from './credits.data';

describe('feature_list.json #12 acceptance: "10+ products, 7 retailers, 20+ companies, credit limits for every retailer"', () => {
  it('seeds exactly the 7 named retailers', () => {
    expect(RETAILERS).toHaveLength(7);
    expect(RETAILERS.map((r) => r.code)).toEqual([
      'CarrefourEs',
      'CarrefourFr',
      'LeroyMerlinEs',
      'LeroyMerlinFr',
      'AldiEs',
      'AldiDe',
      'AldiGb',
    ]);
  });

  it('seeds at least 20 companies', () => {
    expect(COMPANIES.length).toBeGreaterThanOrEqual(20);
  });

  it('seeds at least 10 products', () => {
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(10);
  });

  it('seeds exactly the 3 named currencies (USD, EUR, GBP)', () => {
    expect(CURRENCIES.map((c) => c.code).sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('seeds one credit limit for every one of the 7 retailers', () => {
    expect(CREDITS).toHaveLength(RETAILERS.length);
    const retailerCodes = new Set(CREDITS.map((c) => c.retailerCode));
    for (const retailer of RETAILERS) {
      expect(retailerCodes.has(retailer.code)).toBe(true);
    }
  });
});

describe('every seeded retailer and company GLN is genuinely valid (task prompt: "do not invent digits")', () => {
  it.each(RETAILERS.map((r) => [r.code, r.gln] as const))('retailer %s has a valid GLN', (_code, gln) => {
    expect(() => GLN.of(gln)).not.toThrow();
  });

  it.each(COMPANIES.map((c) => [c.code, c.gln] as const))('company %s has a valid GLN', (_code, gln) => {
    expect(() => GLN.of(gln)).not.toThrow();
  });

  it('every GLN across retailers and companies is unique', () => {
    const glns = [...RETAILERS.map((r) => r.gln), ...COMPANIES.map((c) => c.gln)];
    expect(new Set(glns).size).toBe(glns.length);
  });
});

describe('reference data is internally consistent', () => {
  it('every retailer/company currencyCode is one of the 3 seeded currencies', () => {
    const codes = new Set(CURRENCIES.map((c) => c.code));
    for (const retailer of RETAILERS) {
      expect(codes.has(retailer.currencyCode)).toBe(true);
    }
    for (const company of COMPANIES) {
      expect(codes.has(company.currencyCode)).toBe(true);
    }
  });

  it('every credit line references a real retailer and a real company', () => {
    const retailerCodes = new Set(RETAILERS.map((r) => r.code));
    const companyCodes = new Set(COMPANIES.map((c) => c.code));
    for (const credit of CREDITS) {
      expect(retailerCodes.has(credit.retailerCode)).toBe(true);
      expect(companyCodes.has(credit.companyCode)).toBe(true);
    }
  });

  it('(retailerCode, companyCode) is unique per credit line (domain-model.md §5.1)', () => {
    const pairs = CREDITS.map((c) => `${c.retailerCode}::${c.companyCode}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
