// Initial Fulfillment stock — "initial stock per (company, product) pair for
// at least the companies used in sample orders" (task prompt). Derived
// straight from SAGAS (single source of truth: sagas.data.ts) rather than
// duplicating quantities here, so the stock table and the fabricated
// reservation/despatch history can never drift apart.
//
// A `consumed` reservation permanently removed units from stock (the
// despatch happened, domain-model.md §4.2); a `released` reservation never
// removed units in the first place — it only ever held them. `reservedUnits`
// is 0 for every row because every seeded saga has already reached a
// terminal state (`completed` or `cancelled`) — nothing is left reserved.
import { SAGAS, stockRowId } from './sagas.data';

export interface StockSeed {
  id: string;
  companyCode: string;
  productCode: string;
  units: number;
  reservedUnits: number;
  lowStockThreshold: number;
}

const INITIAL_UNITS_ON_HAND = 500;
const LOW_STOCK_THRESHOLD = 20;

interface PairAccumulator {
  companyCode: string;
  productCode: string;
  consumed: number;
}

const pairs = new Map<string, PairAccumulator>();
for (const saga of SAGAS) {
  for (const reservation of saga.reservations) {
    const key = `${reservation.companyCode}::${reservation.productCode}`;
    const accumulator = pairs.get(key) ?? {
      companyCode: reservation.companyCode,
      productCode: reservation.productCode,
      consumed: 0,
    };
    if (reservation.status === 'consumed') {
      accumulator.consumed += reservation.units;
    }
    pairs.set(key, accumulator);
  }
}

export const STOCK: readonly StockSeed[] = Array.from(pairs.values())
  .sort((a, b) => (a.companyCode + a.productCode).localeCompare(b.companyCode + b.productCode))
  .map((pair) => {
    const units = INITIAL_UNITS_ON_HAND - pair.consumed;
    if (units < 0) {
      throw new Error(
        `stock.data: (${pair.companyCode}, ${pair.productCode}) would go negative — raise INITIAL_UNITS_ON_HAND`,
      );
    }
    return {
      id: stockRowId(pair.companyCode, pair.productCode),
      companyCode: pair.companyCode,
      productCode: pair.productCode,
      units,
      reservedUnits: 0,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
    };
  });
