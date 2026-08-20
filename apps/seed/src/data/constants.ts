// The single fixed instant every master-data row (currencies, products,
// retailers, companies, credit lines, stock) is stamped with. Distinct from
// — and safely before — the sample sagas' dates (sagas.data.ts's
// BASE_DATE, 2026-06-01), so "master data existed before any order was ever
// placed" reads true in the seeded history too.
export const MASTER_DATA_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z');
