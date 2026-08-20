// 12 products across the 3 currencies (feature_list.json #12 acceptance:
// "10+ products"). PRD-0001's price (24999 = 249.99) is chosen deliberately
// so a single line of quantity 1 already totals `.99` — "a `.99`-total order
// is easy to construct from small quantities" (task prompt) — this is the
// line the cancelled sample order (sagas.data.ts) uses.
import { deterministicId, makeEan13 } from '../deterministic';

export interface ProductSeed {
  id: string;
  code: string;
  ean: string;
  name: string;
  description: string;
  price: number;
  currencyCode: string;
}

const RAW: ReadonlyArray<Omit<ProductSeed, 'id' | 'ean'>> = [
  // EUR (8) — PRD-0001 is the ".99 line" (see header comment above).
  { code: 'PRD-0001', name: 'Ration Pack Bundle', description: 'Mixed grocery ration pack, 1 unit', price: 24999, currencyCode: 'EUR' },
  { code: 'PRD-0002', name: 'Pasta 500g Case (24u)', description: 'Case of 24 x 500g dried pasta', price: 1999, currencyCode: 'EUR' },
  { code: 'PRD-0003', name: 'Olive Oil 1L Case (12u)', description: 'Case of 12 x 1L extra virgin olive oil', price: 2499, currencyCode: 'EUR' },
  { code: 'PRD-0004', name: 'Claw Hammer 16oz', description: 'Forged steel claw hammer, 16oz head', price: 1299, currencyCode: 'EUR' },
  { code: 'PRD-0005', name: 'Screwdriver Set 6pc', description: '6-piece flathead/Phillips screwdriver set', price: 899, currencyCode: 'EUR' },
  { code: 'PRD-0006', name: 'Paint Roller Kit', description: 'Roller, tray and 2 refill sleeves', price: 699, currencyCode: 'EUR' },
  { code: 'PRD-0007', name: 'Garden Hose 20m', description: 'Reinforced PVC garden hose, 20 metres', price: 3499, currencyCode: 'EUR' },
  { code: 'PRD-0008', name: 'Laundry Detergent 5L', description: '5L concentrated liquid laundry detergent', price: 1599, currencyCode: 'EUR' },
  // GBP (2)
  { code: 'PRD-0009', name: 'English Breakfast Tea 250g', description: '250g loose-leaf English breakfast tea', price: 349, currencyCode: 'GBP' },
  { code: 'PRD-0010', name: 'Digestive Biscuits 400g', description: '400g pack of digestive biscuits', price: 199, currencyCode: 'GBP' },
  // USD (2)
  { code: 'PRD-0011', name: 'Maple Syrup 1L', description: '1L pure maple syrup', price: 1899, currencyCode: 'USD' },
  { code: 'PRD-0012', name: 'Almond Butter 500g', description: '500g smooth almond butter', price: 999, currencyCode: 'USD' },
];

export const PRODUCTS: readonly ProductSeed[] = RAW.map((entry, index) => ({
  ...entry,
  id: deterministicId(`product:${entry.code}`),
  ean: makeEan13(index + 1),
}));

export function productByCode(code: string): ProductSeed {
  const found = PRODUCTS.find((product) => product.code === code);
  if (!found) {
    throw new Error(`productByCode: unknown product code "${code}"`);
  }
  return found;
}
