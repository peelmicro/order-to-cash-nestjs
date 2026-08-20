// The 7 retailers, exactly as specified (feature_list.json #12 acceptance:
// "7 retailers"). GLNs are computed via makeGln (genuine GS1 check digit —
// see deterministic.ts); VATs are shape-plausible per country, not
// domain-validated (no VAT value object in this model).
import { deterministicId, makeGln } from '../deterministic';

export interface RetailerSeed {
  id: string;
  code: string;
  name: string;
  country: string;
  vat: string;
  gln: string;
  currencyCode: string;
}

export const RETAILERS: readonly RetailerSeed[] = [
  {
    id: deterministicId('retailer:CarrefourEs'),
    code: 'CarrefourEs',
    name: 'Carrefour España',
    country: 'ES',
    vat: 'ESA28425270',
    gln: makeGln(1),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:CarrefourFr'),
    code: 'CarrefourFr',
    name: 'Carrefour France',
    country: 'FR',
    vat: 'FR45652014051',
    gln: makeGln(2),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:LeroyMerlinEs'),
    code: 'LeroyMerlinEs',
    name: 'Leroy Merlin España',
    country: 'ES',
    vat: 'ESA28398950',
    gln: makeGln(3),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:LeroyMerlinFr'),
    code: 'LeroyMerlinFr',
    name: 'Leroy Merlin France',
    country: 'FR',
    vat: 'FR32384657943',
    gln: makeGln(4),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:AldiEs'),
    code: 'AldiEs',
    name: 'Aldi España',
    country: 'ES',
    vat: 'ESA65037725',
    gln: makeGln(5),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:AldiDe'),
    code: 'AldiDe',
    name: 'Aldi Deutschland',
    country: 'DE',
    vat: 'DE812631079',
    gln: makeGln(6),
    currencyCode: 'EUR',
  },
  {
    id: deterministicId('retailer:AldiGb'),
    code: 'AldiGb',
    name: 'Aldi UK',
    country: 'GB',
    vat: 'GB245012348',
    gln: makeGln(7),
    currencyCode: 'GBP',
  },
] as const;

export function retailerByCode(code: string): RetailerSeed {
  const found = RETAILERS.find((retailer) => retailer.code === code);
  if (!found) {
    throw new Error(`retailerByCode: unknown retailer code "${code}"`);
  }
  return found;
}
