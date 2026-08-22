// Application-layer errors of `CreditHoldHandler` (design.md §5.4) — the
// two contract violations `evaluateHold` has no domain vocabulary for:
// an unresolved `(retailerCode, companyCode)` pair (`BC3` — a credit line
// is master data, not something a saga command can conjure) and a
// currency other than the resolved line's (`BC4` — an order is
// single-currency by M2/O1, so a mismatch is a defective message, not a
// statement about the buyer's credit). Mirrors
// `apps/fulfillment/src/application/despatch-application-errors.ts`'s
// shape: neither is a statement about a credit line's state.
export abstract class CreditApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `credit.hold` names a `(retailerCode, companyCode)` pair for which no credit line exists (BC3). */
export class CreditLineNotFoundError extends CreditApplicationError {
  readonly code = 'CREDIT_LINE_NOT_FOUND';

  constructor(
    readonly retailerCode: string,
    readonly companyCode: string,
  ) {
    super(`credit.hold: no credit line for retailerCode "${retailerCode}", companyCode "${companyCode}"`);
  }
}

/** `credit.hold` names a currency other than the resolved credit line's (BC4). */
export class CreditCurrencyMismatchError extends CreditApplicationError {
  readonly code = 'CREDIT_CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`credit.hold: requested currency "${received}" does not match the credit line's currency "${expected}"`);
  }
}
