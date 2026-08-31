# `R1` API half — the money-representation sweep (Phase 25)

Brief: `progress/review_traceability_audit.md` §5, "`R1` API half — MISSING TEST". Domain half already covered by `packages/shared-kernel/src/domain/money.spec.ts`; this is the API half, which had no test anywhere before this change.

## What was built

- `apps/gateway/src/test-support/money-field-sweep.ts` — a pure, framework-free helper, `sweepForMoneyFields(body: unknown): MoneyFinding[]`, that recurses an already-parsed JSON response body and discovers every field it recognises as monetary **by shape**, not by name.
- `apps/gateway/src/money-representation.integration.spec.ts` — the one test case, containing exactly the required title:
  > `every monetary field of every response is an integer accompanied by a currency code`

  inside a `describe('money_representation (R1, API half) — every monetary field of every response the Gateway hands back', ...)`.

## Boot pattern chosen, and why

The brief pointed at `bootGatewayTestApp` (`apps/gateway/src/test-support/gateway-app-test-harness.ts`) as the reference, but `black-box-api.integration.spec.ts` (the file actually named in the brief as "how this repo boots a real Gateway") in fact uses the heavier 5-process `spawnRealService` fleet, not `bootGatewayTestApp`. I read both and chose `bootGatewayTestApp` deliberately: R1's claim is about **shape**, which the Gateway alone decides on every response it hands back regardless of which upstream produced the payload, so the lightweight `TestingModule` + real NATS + real MongoDB + stubbed downstream RPC responders (the pattern `orders.integration.spec.ts` and `billing-fulfillment.integration.spec.ts` already establish) is sufficient and far cheaper (~6-24s vs. minutes for a 5-process fleet). I record this deviation explicitly per the deletion-arming/record convention: it is a considered choice, not an oversight.

## How the sweep discovers monetary fields (shape, not name)

Read `specs/shared/openapi.yaml`'s `Money`/`MinorUnits`/`CurrencyCode` schemas first. Two real shapes exist on the wire:

1. **Standalone `Money`**: `{ amount, currency }` travelling together as a nested object (e.g. `RegisterPaymentRequest.amount`).
2. **Ancestor-declared currency**: an object declares `currency` once, and every `MinorUnits`-typed field anywhere beneath it — including several levels of nested objects/arrays, themselves carrying no `currency` of their own — is expressed in that currency. Concretely verified against the real schemas: `OrderDetail.currency` covers `OrderDetail.totals.totalAmount` (one level down) and `OrderDetail.items[].unitPrice`/`lineDiscount` (inside an array, two levels down); `Credit.currency` covers `creditLimit`/`activeHolds`/`openExposure`/`availableCredit` — none of which is named "amount" or "discount", which is the concrete proof a name-enumeration recogniser would have missed something the shape-based one does not.

The walk carries an "effective currency" down through nested objects and arrays (the nearest `currency` field found at or above the current node), and flags:
- any `number`-typed sibling field other than `currency` itself, once an effective currency exists, and
- the literal key `amount` whenever it sits directly beside its own `currency` key, **regardless of that value's runtime type** — the one deliberate name-based exception, tied to the documented `Money` schema itself, added specifically so a `Money.amount` regressing to a decimal string is still caught (a pure `typeof === 'number'` rule would silently stop looking at it, since a string never satisfies that check).

**Known, disclosed over-inclusion, left uncovered on purpose:** a genuinely non-monetary integer sharing an object with a `currency` sibling — e.g. `OrderItem.quantity`, which lives beside `unitPrice`/`lineDiscount` under the same order's currency — is also flagged as a "finding." This is harmless for R1's claim (a quantity is always a genuine integer, so "must be an integer, must carry a valid currency" holds for it trivially) and was preferred over a name-based denylist, which would silently stop protecting a future field the denylist's author did not anticipate. I considered also detecting decimal-STRING regressions generically (not just for the canonical `amount` key) but rejected it: `PartyRef.gln` is a pure-digit string (e.g. `"8412345000013"`) that lives under the same ambient currency context as `OrderDetail`/`OrderSummary`, so any generic "numeral-looking string under a currency context" rule would misclassify `gln` as money and fail spuriously. This is recorded as a deliberate scope boundary, not an oversight.

## Endpoints swept

Inside the one test case: `POST /orders` (orders.create stub), `GET /orders/{id}` and `GET /orders` (both direct MongoDB read-model reads, R54), `GET /invoices` (billing.invoice.list stub), `GET /credits` (billing.credit.list stub) — matching the brief's "at minimum" list plus the list/detail split for `/orders`. Fixture amounts are deliberately non-round (`217_450`, `3_500`, `213_950`, `43_490`, `700`, `786_050`, …) so a hypothetical `/100`-truncation or rounding bug would not accidentally look correct.

For each endpoint the test asserts:
1. `findings.length > 0` — "the sweep actually inspected at least one field", so a future rename that emptied the field set fails loudly instead of passing vacuously.
2. For every finding: `Number.isInteger(amount)` and `typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)`.

## Verification

Ran directly (not through the `-- money-representation` CLI filter, which — recorded as a real finding — did NOT actually restrict `vitest run --config vitest.integration.config.mts` to this file; it ran the full 12-file integration suite instead, in which an unrelated flake in `saga-e2e-verification.integration.spec.ts` — `fulfillment` failing to reach readiness within 90s, evidently container/resource contention on this run — surfaced. Re-run targeted directly at the file path instead):

```
$ npx vitest run --config vitest.integration.config.mts src/money-representation.integration.spec.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  24.21s (first run, cold containers) / ~6-8s on subsequent runs
```

### Armed-deletion evidence

**Probe 1 — vacuous sweep.** Changed `sweepForMoneyFields` to `return [];` unconditionally. Re-ran the exact file:

```
FAIL  src/money-representation.integration.spec.ts > money_representation (R1, API half) — every monetary field of every response the Gateway hands back > every monetary field of every response is an integer accompanied by a currency code
AssertionError: expected at least one monetary field discovered in POST /orders's response — found none, which would make this sweep vacuous rather than proving R1: expected 0 to be greater than 0
```

Reverted; confirmed green again before probe 2.

**Probe 2 — a float sneaks through.** Changed the `POST /orders` stub reply's `totalAmount` from `213_950` to `213_950.5`. Re-ran:

```
FAIL  src/money-representation.integration.spec.ts > money_representation (R1, API half) — every monetary field of every response the Gateway hands back > every monetary field of every response is an integer accompanied by a currency code
AssertionError: POST /orders $.totalAmount: R1 requires an integer count of minor units, got 213950.5 (typeof number): expected false to be true
```

Reverted; re-ran once more to confirm the file is back to a clean, green, unmodified state (`Test Files 1 passed (1)`).

### `pnpm quality`

Ran the full monorepo `pnpm quality` (lint + typecheck + `test:coverage` across every workspace, including `apps/web`) after restoring the clean state. **Exit code 0.** `apps/web`'s coverage run completed normally in this pass (88.12% statements) — no timeout was observed, so there is nothing to caveat here; noted per the brief's instruction to say so explicitly either way.

### `./init.sh`

Still exits 0 (6 uncommitted changes flagged as expected mid-session `[WARN]`, not a failure).

## Traceability

This test proves `R1`'s API half: `apps/gateway/src/money-representation.integration.spec.ts` › `every monetary field of every response is an integer accompanied by a currency code`. I did not edit `specs/shared/test-matrix.md` per the brief's explicit scope boundary (a spec pass owns that file concurrently) — the case name above is exact and citable verbatim.

## Files touched

- `apps/gateway/src/money-representation.integration.spec.ts` (new)
- `apps/gateway/src/test-support/money-field-sweep.ts` (new)

No other file was modified. Nothing was staged or committed.

## What was deliberately left uncovered

- Decimal-string regression detection is only guaranteed for the canonical `Money.amount` key (paired directly with its own `currency`), not for every ancestor-inherited `MinorUnits` field (e.g. `totalAmount`, `creditLimit`) — see the `gln` collision reasoning above for why a fully general string-shape rule was rejected rather than silently attempted.
- The sweep was exercised against Gateway-shaped fixture data (stub RPC replies + hand-inserted Mongo documents), not against a live spawned Orders/Billing/Fulfillment fleet — deliberate, since R1's claim is about the Gateway's own wire shaping of whatever payload it is handed, and the heavier fleet is already exercised elsewhere (`black-box-api.integration.spec.ts`) without a general money sweep.
- `/stock` (`fulfillment.stock.list`) and `/auth/login` responses were not swept — out of the brief's "at minimum" list and neither carries a `Money`-shaped field per `specs/shared/openapi.yaml`.
