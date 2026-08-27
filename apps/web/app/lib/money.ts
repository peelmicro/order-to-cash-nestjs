/**
 * Formats an integer-minor-units amount for humans. openapi.yaml notes that
 * formatting should derive from `currency.decimalPoints`, which no endpoint
 * in this pass's scope exposes — `Intl.NumberFormat` derives the same
 * fact (EUR/GBP/USD all being 2-decimal minor units) from the ISO 4217 code
 * itself, which is what this system's seeded currencies are, so dividing by
 * 100 is accurate for them. A currency with a different minor-unit exponent
 * would need the real `decimalPoints` value; noted as a simplification.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minorUnits / 100);
}

export interface DraftLine {
  productCode: string;
  quantity: number;
  unitPrice?: number;
  lineDiscount?: number;
}

/** One line's total, honouring an explicit `unitPrice` override (R42's `.99` affordance) over the catalogue price. */
export function draftLineTotal(line: DraftLine, catalogPrice: number | undefined): number {
  const price = line.unitPrice ?? catalogPrice ?? 0;
  const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
  return price * quantity - (line.lineDiscount ?? 0);
}

/** The running order total shown live as lines are added — mirrors the aggregate's own `initialAmount − initialDiscount` (invariant O3, R6), computed client-side purely for display; the server always recomputes and owns the authoritative total. */
export function draftOrderTotal(
  lines: DraftLine[],
  priceByProductCode: Map<string, number>,
  orderDiscount: number,
): number {
  const gross = lines.reduce((sum, line) => sum + draftLineTotal(line, priceByProductCode.get(line.productCode)), 0);
  return gross - orderDiscount;
}
