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
//
// **Baseline coverage for every OTHER (retailer, company) pair
// (billing_credit feature, the human gate's binding amendment to open
// point 12).** `PRIMARY_SUPPLIER_BY_RETAILER` only ever gives each retailer
// ONE credit line, so any order against any OTHER supplier had NO credit
// line at all — 7 lines where 7 × 22 pairs are reachable (`stock.data.ts`'s
// baseline already covers every company for every product, so any retailer
// CAN place an order against any company). This is the exact class of
// incoherence `review_fulfillment_stock.md` found for `stock`, which
// feature 18 fixed by adding a baseline row per uncovered pair — the same
// fix, additively, here: every retailer gets a baseline credit line
// against every company its primary-supplier line does NOT already cover,
// at the same 500 000 limit in the retailer's own currency. Purely
// additive: not one primary-supplier id, code or amount above is touched —
// `CR-000001`..`CR-000007` (the primary lines, in RETAILERS order) keep
// their existing codes and ids exactly; the baseline lines continue the
// sequence from `CR-000008`.
import { CreditLineReference } from '@otc/shared-kernel';
import { deterministicId } from '../deterministic';
import { COMPANIES } from './companies.data';
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

/** The 7 primary-supplier lines, unchanged: `CR-000001`..`CR-000007`, in `RETAILERS` order — not one id, code or amount here is touched by the baseline addition below. */
const PRIMARY_CREDITS: readonly CreditSeed[] = RETAILERS.map((retailer, index) => {
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

/**
 * Baseline coverage: every retailer against every company its primary line
 * does NOT already cover (billing_credit, human-gate amendment to open
 * point 12) — same 500 000 limit, in the RETAILER's currency (a credit
 * line's currency is the buyer's, mirroring the primary lines above).
 * Sequenced deterministically (`RETAILERS` order, then `COMPANIES` order)
 * continuing from `CR-000008`, so the codes are stable across seed runs.
 */
const BASELINE_CREDITS: readonly CreditSeed[] = RETAILERS.flatMap((retailer, retailerIndex) =>
  COMPANIES.filter((company) => company.code !== PRIMARY_SUPPLIER_BY_RETAILER[retailer.code]).map((company, companyIndex) => ({
    id: deterministicId(`credit:baseline:${retailer.code}:${company.code}`),
    code: CreditLineReference.fromSequence(PRIMARY_CREDITS.length + retailerIndex * (COMPANIES.length - 1) + companyIndex + 1).toString(),
    retailerCode: retailer.code,
    companyCode: company.code,
    creditLimit: CREDIT_LIMIT_MINOR_UNITS,
    currencyCode: retailer.currencyCode,
  })),
);

export const CREDITS: readonly CreditSeed[] = [...PRIMARY_CREDITS, ...BASELINE_CREDITS];

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
