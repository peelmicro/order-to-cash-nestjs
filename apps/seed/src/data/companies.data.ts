// 22 companies (suppliers), varied countries (feature_list.json #12
// acceptance: "20+ companies"). GLN sequences start at 21 — the 7 retailers
// already own sequences 1-7 (retailers.data.ts) and GLNs must be unique
// across the whole seeded catalogue.
import { deterministicId, makeGln } from '../deterministic';

export interface CompanySeed {
  id: string;
  code: string;
  name: string;
  country: string;
  vat: string;
  gln: string;
  currencyCode: string;
}

const RAW: ReadonlyArray<Omit<CompanySeed, 'id' | 'gln'>> = [
  // ES (4)
  { code: 'IBERFOODS', name: 'Iberian Foods Distribution SA', country: 'ES', vat: 'ESA80907397', currencyCode: 'EUR' },
  { code: 'SPANATURAL', name: 'Hispania Natural Foods SL', country: 'ES', vat: 'ESB82591744', currencyCode: 'EUR' },
  { code: 'TOOLIBERIA', name: 'Herramientas Ibéricas SA', country: 'ES', vat: 'ESA84606310', currencyCode: 'EUR' },
  { code: 'MEDFRESH', name: 'Mediterráneo Fresh Goods SL', country: 'ES', vat: 'ESB63022260', currencyCode: 'EUR' },
  // FR (3)
  { code: 'FRESHFR', name: 'Fraîcheur de France SARL', country: 'FR', vat: 'FR76403355947', currencyCode: 'EUR' },
  { code: 'OUTILFRANCE', name: 'Outillage de France SAS', country: 'FR', vat: 'FR89552120222', currencyCode: 'EUR' },
  { code: 'GALLIAGOODS', name: 'Gallia Goods Distribution SA', country: 'FR', vat: 'FR23334028554', currencyCode: 'EUR' },
  // DE (3)
  { code: 'GERMANFOODS', name: 'Deutsche Lebensmittel GmbH', country: 'DE', vat: 'DE136695970', currencyCode: 'EUR' },
  { code: 'BAUWERK', name: 'Bauwerk Werkzeuge GmbH', country: 'DE', vat: 'DE811115660', currencyCode: 'EUR' },
  { code: 'RHEINGOODS', name: 'Rheingold Handels GmbH', country: 'DE', vat: 'DE147426685', currencyCode: 'EUR' },
  // GB (3)
  { code: 'UKDISTRIB', name: 'British Isles Distribution Ltd', country: 'GB', vat: 'GB434031494', currencyCode: 'GBP' },
  { code: 'LONDONTOOLS', name: 'London Tools Supply Ltd', country: 'GB', vat: 'GB113292750', currencyCode: 'GBP' },
  { code: 'ALBIONFOODS', name: 'Albion Foods Ltd', country: 'GB', vat: 'GB980780684', currencyCode: 'GBP' },
  // IT (3)
  { code: 'ITALPASTA', name: 'Pastificio Italiano SRL', country: 'IT', vat: 'IT00743110157', currencyCode: 'EUR' },
  { code: 'ROMATOOLS', name: 'Attrezzi di Roma SRL', country: 'IT', vat: 'IT01654060157', currencyCode: 'EUR' },
  { code: 'MILANOGOODS', name: 'Milano Distribuzione SRL', country: 'IT', vat: 'IT12842760151', currencyCode: 'EUR' },
  // PT (2)
  { code: 'LUSOFOODS', name: 'Luso Alimentos Lda', country: 'PT', vat: 'PT502757191', currencyCode: 'EUR' },
  { code: 'PORTOTOOLS', name: 'Porto Ferramentas Lda', country: 'PT', vat: 'PT503504457', currencyCode: 'EUR' },
  // NL (2)
  { code: 'DUTCHGOODS', name: 'Nederlandse Groothandel BV', country: 'NL', vat: 'NL805806053B01', currencyCode: 'EUR' },
  { code: 'HOLLANDTOOLS', name: 'Holland Gereedschap BV', country: 'NL', vat: 'NL818838663B01', currencyCode: 'EUR' },
  // BE (2)
  { code: 'BENELUXFOODS', name: 'Benelux Voeding NV', country: 'BE', vat: 'BE0429646425', currencyCode: 'EUR' },
  { code: 'BRUSSELSTOOLS', name: 'Brussels Outillage NV', country: 'BE', vat: 'BE0475747019', currencyCode: 'EUR' },
];

export const COMPANIES: readonly CompanySeed[] = RAW.map((entry, index) => ({
  ...entry,
  id: deterministicId(`company:${entry.code}`),
  gln: makeGln(21 + index),
}));

export function companyByCode(code: string): CompanySeed {
  const found = COMPANIES.find((company) => company.code === code);
  if (!found) {
    throw new Error(`companyByCode: unknown company code "${code}"`);
  }
  return found;
}
