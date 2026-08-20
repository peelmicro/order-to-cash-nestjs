import { describe, expect, it } from 'vitest';
import { SAGAS } from './sagas.data';
import { STOCK } from './stock.data';

describe('STOCK — derived from SAGAS, never hand-duplicated (single source of truth)', () => {
  it('has one row per distinct (companyCode, productCode) pair touched by a seeded saga', () => {
    const pairs = new Set<string>();
    for (const saga of SAGAS) {
      for (const reservation of saga.reservations) {
        pairs.add(`${reservation.companyCode}::${reservation.productCode}`);
      }
    }
    expect(STOCK).toHaveLength(pairs.size);
  });

  it('every row has non-negative units and zero reservedUnits (every saga is terminal)', () => {
    for (const item of STOCK) {
      expect(item.units).toBeGreaterThanOrEqual(0);
      expect(item.reservedUnits).toBe(0);
      expect(item.lowStockThreshold).toBeGreaterThan(0);
    }
  });

  it('a "consumed" reservation permanently reduced units below the generous initial baseline', () => {
    const consumedPairs = new Map<string, number>();
    for (const saga of SAGAS) {
      for (const reservation of saga.reservations) {
        if (reservation.status === 'consumed') {
          const key = `${reservation.companyCode}::${reservation.productCode}`;
          consumedPairs.set(key, (consumedPairs.get(key) ?? 0) + reservation.units);
        }
      }
    }
    for (const item of STOCK) {
      const consumed = consumedPairs.get(`${item.companyCode}::${item.productCode}`) ?? 0;
      if (consumed > 0) {
        expect(item.units).toBeLessThan(500);
      }
    }
  });

  it('a "released" reservation left units untouched (goods were never consumed, domain-model.md §4.2)', () => {
    const releasedOnlyPairs = new Set<string>();
    const consumedPairs = new Set<string>();
    for (const saga of SAGAS) {
      for (const reservation of saga.reservations) {
        const key = `${reservation.companyCode}::${reservation.productCode}`;
        if (reservation.status === 'released') releasedOnlyPairs.add(key);
        if (reservation.status === 'consumed') consumedPairs.add(key);
      }
    }
    for (const key of releasedOnlyPairs) {
      if (consumedPairs.has(key)) continue; // touched by both — skip, covered by the consumed assertion above
      const [companyCode, productCode] = key.split('::');
      const item = STOCK.find((s) => s.companyCode === companyCode && s.productCode === productCode);
      expect(item?.units).toBe(500);
    }
  });

  it('ids are unique', () => {
    expect(new Set(STOCK.map((s) => s.id)).size).toBe(STOCK.length);
  });
});
