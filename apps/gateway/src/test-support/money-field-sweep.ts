// R1 (`specs/shared/requirements.md`) — "THE SYSTEM SHALL represent every
// monetary amount as an integer count of minor units together with an ISO
// 4217 alpha-3 currency code ... in every API response." This module is the
// GENERAL discovery mechanism `money-representation.integration.spec.ts`
// needs to make that claim testable without hand-enumerating field names
// per endpoint (`apps/gateway/src/black-box-api.integration.spec.ts`'s own
// `expect(placed.totalAmount).toBe(49_998)` is exactly the per-field style
// that does NOT make R1's universal claim — see
// `progress/review_traceability_audit.md` §5).
//
// Two money shapes exist in `specs/shared/openapi.yaml`, discovered by
// reading its `Money`/`MinorUnits`/`CurrencyCode` schemas and the real
// response bodies:
//
//  1. A standalone `Money` object travelling on its own: `{ amount,
//     currency }` — e.g. `RegisterPaymentRequest.amount`. The `currency`
//     is a DIRECT SIBLING of `amount` inside that same object.
//
//  2. The far more common "enclosing object already declares its
//     currency" pattern (`MinorUnits`'s own schema description): an
//     ancestor object carries a `currency` field once, and every
//     `MinorUnits`-typed field anywhere inside it — including several
//     levels of nested objects/arrays down, with NO `currency` field of
//     their own — is expressed in that currency. Concretely:
//     `OrderDetail.currency` covers `OrderDetail.totals.totalAmount` (one
//     level down, `totals` has no `currency` of its own) AND
//     `OrderDetail.items[].unitPrice` (inside an array, two levels down,
//     each item has no `currency` of its own either) AND
//     `Credit.creditLimit`/`activeHolds`/`openExposure`/`availableCredit`
//     (direct siblings of `Credit.currency`, but NOT named "amount" or
//     "discount" — proving a name-based recogniser would have to
//     enumerate business vocabulary, exactly the per-field style this
//     sweep exists to avoid).
//
// The recogniser below is therefore SHAPE-based, not name-based, with
// exactly one deliberate exception tied to the documented `Money` schema
// itself (see `isCanonicalMoneyAmount` below): as the walk descends
// through a response body it carries an "effective currency" — the
// nearest `currency` field found at or above the current object, however
// deep — and flags every NUMBER-typed sibling field (other than
// `currency` itself) found under that context as a monetary finding,
// PLUS the `amount` key specifically whenever it sits directly beside a
// `currency` key, regardless of that value's own runtime type (this is
// what lets the sweep catch a `Money.amount` that regressed to a decimal
// STRING, which a number-typed-only rule would silently miss).
//
// Known, disclosed over-inclusion: a field that is merely an unrelated
// integer sharing an object with a `currency` sibling (e.g.
// `OrderItem.quantity`, which lives beside `unitPrice`/`lineDiscount`
// inside the SAME currency-bearing ancestor) is also flagged. This is
// harmless for R1's claim — a quantity is always a genuine integer, so
// the "must be an integer, must carry a valid currency" assertion holds
// for it trivially — and deliberately preferred over a name-based
// denylist, which would silently stop protecting a future field it did
// not anticipate. See `progress/impl_money_representation.md` for the
// full trade-off record.

export interface MoneyFinding {
  /** Dotted/bracketed path from the response root, for a legible failure message. */
  readonly path: string;
  readonly amount: unknown;
  readonly currency: unknown;
}

const CURRENCY_KEY = 'currency';
const CANONICAL_AMOUNT_KEY = 'amount';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(node: unknown, path: string, inheritedCurrency: unknown, findings: MoneyFinding[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`, inheritedCurrency, findings));
    return;
  }
  if (!isPlainObject(node)) {
    return;
  }

  const hasOwnCurrency = Object.prototype.hasOwnProperty.call(node, CURRENCY_KEY);
  const effectiveCurrency = hasOwnCurrency ? node[CURRENCY_KEY] : inheritedCurrency;

  for (const [key, value] of Object.entries(node)) {
    if (key === CURRENCY_KEY) {
      continue;
    }

    // The documented `Money` shape: `amount` travelling directly beside
    // its OWN `currency` — flagged regardless of `value`'s runtime type,
    // specifically so a regression to a decimal string is still caught
    // (a pure "typeof === 'number'" rule would silently stop looking).
    const isCanonicalMoneyAmount = key === CANONICAL_AMOUNT_KEY && hasOwnCurrency;
    const isNumberUnderCurrencyContext = typeof value === 'number' && effectiveCurrency !== undefined;

    if (effectiveCurrency !== undefined && (isCanonicalMoneyAmount || isNumberUnderCurrencyContext)) {
      findings.push({ path: `${path}.${key}`, amount: value, currency: effectiveCurrency });
      continue; // a recognised money field is a leaf — never itself walked into
    }

    if (isPlainObject(value) || Array.isArray(value)) {
      walk(value, `${path}.${key}`, effectiveCurrency, findings);
    }
  }
}

/**
 * Recurses `body` (an already-parsed JSON response) and returns every
 * field the shape-based rules above recognise as carrying a monetary
 * amount, each paired with the currency code it was matched against.
 * Never itself asserts anything — the caller decides what "integer,
 * ISO-4217 currency" means for each finding.
 */
export function sweepForMoneyFields(body: unknown): MoneyFinding[] {
  const findings: MoneyFinding[] = [];
  walk(body, '$', undefined, findings);
  return findings;
}
