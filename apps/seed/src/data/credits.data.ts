// A credit limit for every retailer (feature_list.json #12 acceptance:
// "credit limits for every retailer"), each against one chosen supplier —
// domain-model.md §5.1: "One credit line per (retailerCode, companyCode)
// pair". The chosen supplier is that retailer's "primary" one — the same
// pair the sample sagas (sagas.data.ts) place their orders against, so the
// fabricated history and the reference data tell one consistent story.
//
// 500000 minor units (EUR 5 000,00 / GBP 5 000,00) — the same figure
// specs/shared/asyncapi.yaml's own CreditRejected example uses for
// `availableCredit`, and "deliberately modest" per the task prompt so a
// genuine over-limit rejection stays demoable against these seeded limits.
import { CreditLineReference } from '@otc/shared-kernel';
import { deterministicId } from '../deterministic';
import { RETAILERS } from './retailers.data';

export interface CreditSeed {
  id: string;
  code: string;
  retailerCode: string;
  companyCode: string;
  creditLimit: number;
  currencyCode: string;
}

const PRIMARY_SUPPLIER_BY_RETAILER: Record<string, string> = {
  CarrefourEs: 'IBERFOODS',
  CarrefourFr: 'FRESHFR',
  LeroyMerlinEs: 'TOOLIBERIA',
  LeroyMerlinFr: 'OUTILFRANCE',
  AldiEs: 'SPANATURAL',
  AldiDe: 'GERMANFOODS',
  AldiGb: 'UKDISTRIB',
};

const CREDIT_LIMIT_MINOR_UNITS = 500_000;

export const CREDITS: readonly CreditSeed[] = RETAILERS.map((retailer, index) => {
  const companyCode = PRIMARY_SUPPLIER_BY_RETAILER[retailer.code];
  if (!companyCode) {
    throw new Error(`credits.data: no primary supplier configured for retailer "${retailer.code}"`);
  }
  return {
    id: deterministicId(`credit:${retailer.code}:${companyCode}`),
    code: CreditLineReference.fromSequence(index + 1).toString(),
    retailerCode: retailer.code,
    companyCode,
    creditLimit: CREDIT_LIMIT_MINOR_UNITS,
    currencyCode: retailer.currencyCode,
  };
});

export function primarySupplierOf(retailerCode: string): string {
  const companyCode = PRIMARY_SUPPLIER_BY_RETAILER[retailerCode];
  if (!companyCode) {
    throw new Error(`primarySupplierOf: no primary supplier configured for retailer "${retailerCode}"`);
  }
  return companyCode;
}

export function creditByRetailerAndCompany(retailerCode: string, companyCode: string): CreditSeed {
  const found = CREDITS.find(
    (credit) => credit.retailerCode === retailerCode && credit.companyCode === companyCode,
  );
  if (!found) {
    throw new Error(`creditByRetailerAndCompany: no credit line for ${retailerCode}/${companyCode}`);
  }
  return found;
}
