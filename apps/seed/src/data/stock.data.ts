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
//
// **Baseline coverage for every OTHER company (fulfillment_despatch feature,
// review_fulfillment_stock.md's owed item).** `SAGAS` only ever touches 5 of
// the 22 seeded companies, so a company outside that set had NO `stock` row
// at all — a live order against it (`ALBIONFOODS`/`PRD-0001` in the
// feature-17 live-boot pass, `ORD-000007/8/9`) could never get past
// `stock.reserve`: `NOT_FOUND`, parked forever, by design (design.md §3.3's
// documented open point) but not a useful demo state. Every company the
// SAGAS-derived pairs above do NOT already cover gets a full row per
// PRODUCT — not just the one or two lines a future live order happens to
// pick — so no company can EVER hit that wall regardless of which product a
// later demo order names. Purely additive: not one SAGA-derived id, company
// or quantity above is touched.
import { COMPANIES } from './companies.data';
import { PRODUCTS } from './products.data';
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

const sagaCoveredCompanies = new Set(Array.from(pairs.values(), (pair) => pair.companyCode));

const SAGA_DERIVED_STOCK: readonly StockSeed[] = Array.from(pairs.values()).map((pair) => {
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

const BASELINE_STOCK: readonly StockSeed[] = COMPANIES.filter(
  (company) => !sagaCoveredCompanies.has(company.code),
).flatMap((company) =>
  PRODUCTS.map((product) => ({
    id: stockRowId(company.code, product.code),
    companyCode: company.code,
    productCode: product.code,
    units: INITIAL_UNITS_ON_HAND,
    reservedUnits: 0,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
  })),
);

export const STOCK: readonly StockSeed[] = [...SAGA_DERIVED_STOCK, ...BASELINE_STOCK].sort((a, b) =>
  (a.companyCode + a.productCode).localeCompare(b.companyCode + b.productCode),
);
