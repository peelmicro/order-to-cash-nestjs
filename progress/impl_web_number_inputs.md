# impl_web_number_inputs: malformed number-box text in #7's web app (probe, then fix)

Authority: maintainer, 2026-10-15 (#9 Phase 16, session 3). Classification: full group (money parsing). No commit made. `Packages installed: none`.

Evidence and scratch live in `../order-to-cash-python/.arm/web7/` (git-ignored): `probe/` (stub gateway, probe script, `probe-before.json`, `probe-after.json`), `arm/` (backups, outputs), `arm_log.txt`, `mut/` (mutation scripts), `*.log` (gate runs).

## Population search (commands run in this session, in `apps/web`)

`grep -rn 'type="number"\|:type=\|v-bind:type\|inputmode' app --include=*.vue` (before the change) returned exactly:

```
app/pages/orders/place.vue:370:                  type="number"      (quantity-input)
app/pages/orders/place.vue:381:                  type="number"      (unit-price-input)
app/pages/orders/place.vue:395:                  type="number"      (line-discount-input)
app/pages/billing/index.vue:374:  (a comment: "`v-model` on `<input type="number">` auto-casts...")
app/pages/billing/index.vue:384:                        type="number"   (payment-amount-input)
app/pages/stock/index.vue:251:                        type="number"   (replenish-units-input)
```

No `:type=`, `v-bind:type` or `inputmode` hit. `app/components/ui/input/Input.vue` is the only `<input>` wrapper; it declares no `type` prop (attrs fall through), so no number input hides in a component. Five inputs, the sixth hit is a comment. The new population guard re-derives this set on every run (see Guards).

How #7's own tests reached these pages: `@vitest-environment nuxt`, `renderSuspended` of the page with `registerEndpoint` stubs (no server); `e2e/` is Playwright against a running base URL (`playwright.config.ts` has no `webServer`). Neither can produce Chromium's `badInput`, so the defect was never visible to #7's suite.

## Step 1: probe (before any edit)

Setup: `nuxt build` (exit 0, `build_before.log`), the built server `node .output/server/index.mjs` on **3017** (`NUXT_GATEWAY_BASE_URL=http://127.0.0.1:3018`), a stub Gateway on **3018** that logs every non-GET body (`probe/stub-gateway.mjs`), Chromium via #7's `@playwright/test` 1.62.1, real login through the UI. The stub answers `/catalog/*` with 503 so the order page falls back to its code text fields. Text is typed key by key (`pressSequentially`). "Bytes" are what the stub received. The #7 compose stack was never started. Both processes were stopped by PID; `ss -ltnp` shows 3017/3018 free; `docker ps` shows the one container that was already running before I started (the other session's), none of mine.

"Native" = Chromium's constraint validation on the field after the click (`validationMessage`).

| input | text | box shows | page shows | bytes sent | class |
|---|---|---|---|---|---|
| place quantity | `3` (control) | `3` | nothing | `{"productCode":"PRD-0001","quantity":3}` | control |
| place quantity | `1-2` | **`2`** (the page rewrote the box) | nothing | **`quantity":2`** | **DEFECT** (typed text lost, an order with a quantity the user did not type is placed) |
| place quantity | `12e` | `0` (rewritten) | nothing in the page; native bubble "Value must be greater than or equal to 1." | nothing | DEFECT (text replaced by `0`, refused only by a bubble that does not name what was typed) |
| place quantity | `2-` | `0` (rewritten) | native bubble as above | nothing | DEFECT (same) |
| place quantity | `0` / empty | `00` / `0` | native bubble as above | nothing | native refusal (min=1) |
| place unit price | `19.99` / `0.29` (control) | same | nothing | `"unitPrice":1999` / `29` | control |
| place unit price | `1-2`, `12e`, `19.99-`, `5-` | `""`, `badInput=true` | native bubble "Please enter a number." (field focused) | nothing | SAFE for text the browser cannot parse; **CORRECTED in Round 2: not safe for exponent text** (`1e3` passes native validation, see the correction below) |
| place unit price | `19.999` | `19.999` | native bubble "Please enter a valid value. The two nearest valid values are 19.99 and 20." | nothing | SAFE |
| place line discount | `19.99` / `0.29` (control) | same | nothing | `"lineDiscount":1999` / `29` | control |
| place line discount | `1-2`, `12e`, `19.99-`, `5-`, `19.999` | as unit price | as unit price | nothing | SAFE for these texts; **CORRECTED in Round 2: not safe for `1e3`** |
| billing payment amount | `19.99` / `0.29` (control) | same | outcome panel | `"amount":{"amount":1999,...}` / `29` | control |
| billing payment amount | `1-2`, `12e`, `19.99-`, `5-` | `""`, `badInput=true` | nothing; **Submit disabled** (`!amountInput`) | nothing | **DEFECT** (the user is told nothing; the button is just dead) |
| billing payment amount | `19.999` (EUR) | `19.999` | nothing (the handler returns silently) | nothing | **DEFECT** (told nothing) |
| stock replenish units | `7` (control) | `7` | outcome | `"units":7` | control |
| stock replenish units | `1-2`, `12e`, `5-` | `""`, `badInput=true` | nothing; **Add units disabled** | nothing | **DEFECT** (told nothing) |
| stock replenish units | `1.5` | `1.5` | outcome panel | **`"units":1.5`** | **DEFECT** (a non-integer unit count is sent) |

Why unit price and discount are safe and the others are not: they sit in a `<form @submit.prevent>` with no `novalidate`, so Chromium refuses the submit for `badInput`, `step` mismatch and `min` and shows its bubble. The quantity box also sits there but its `Number(v)` handler turns `""` into `0` and rewrites the box, which is what lost the text. Billing and stock use `type="button"` click handlers, not form submits, so no native validation runs.

Result as first written: three defects (quantity, payment amount, replenish units) and two "safe" (unit price, line discount). **That classification was wrong for the two money boxes on the order page, and the sentence that followed it ("the #9 failure mode does not occur in #7 for money boxes") was false.** The reviewer's probe (`.arm/web7r/probe/native.mjs`, output line `price "1e3" {"value":"1e3","valid":true,"badInput":false} form submitted: true`) shows Chromium holds `1e3` and `1e-2` in a `type="number" min=0 step=0.01` box as valid, so the form submits; HEAD then ran `decimalStringToMinorUnits("1e3")`, got `undefined`, and omitted `unitPrice` / `lineDiscount`: an order at the catalogue price, or with no discount, and no error shown (HEAD `place.vue` lines 216-222). My step-1 probe typed `12e`, which is malformed even to the browser, so it never exercised this class. **The inherited #9 finding (malformed number-box text silently dropped, B1 of #9's stage 2 review) RECURRED in #7, in its exponent form, and was closed by Round 1** (the two boxes became text boxes), then pinned with `1e3` / `1e-2` fixtures in Round 2. Billing returned silently on the same text at HEAD. It must be recorded as recurred, not avoided.

Judgement for the leader (superseded by the correction above and Round 1): the two inputs were thought safe through a browser bubble, not through words in the page that name the field. I read the brief's "refused in words, nothing sent" as satisfied by Chromium's own message and left them alone ("fix every input classified defect"). If uniform in-page refusal is wanted, switching those two to the same text mechanism is a small follow-up (it would change the two `step` assertions in `currency-exponent.spec.ts`).

## Mechanism chosen and why

`type="text"` with `inputmode` (`numeric` for quantity, units, 0-exponent currencies; `decimal` otherwise), #8's choice, for the three defect inputs. Reasons: (1) the page then sees the raw typed text, so one parser covers `"1-2"`, `"12e"`, `"19.999"` and `"1.5"` alike, where `validity.badInput` would cover only the first group and still need a parser for the rest; (2) it does not depend on Chromium's event semantics (the probe showed the quantity box being rewritten mid-typing, so a flag set from an input handler would race with the rewrite); (3) happy-dom needs no `validity` shim, so the component tests exercise the real code path. Cost: the spinner arrows, `min` and `step` of those boxes are gone. The only test that asserted `step` on one of them is `currency-exponent.spec.ts` (billing, `step` `'1'`): it now asserts `inputmode` `numeric` for the JPY invoice (the call-site claim it exists for, that the invoice's own currency reaches the box, is kept). `place.currency.spec.ts` asserts no `step` (verified by the premise check); the two `step` assertions on unit price/discount in `currency-exponent.spec.ts` are unchanged because those boxes stay `type="number"`.

Refusal rule (same as #9): the page shows a sentence naming the field and quoting the text; nothing is sent; nothing is substituted. Quantity: shown after the first submit attempt (so half-typed text is not nagged at) then live. Billing and stock: shown on the Submit click, cleared as soon as the text changes. Empty or whitespace is refused as "is required", not read as "not typed" (quantity empty previously dropped the line silently).

## Change per file (all under `apps/web/app/`)

- `lib/number-input.ts` (new): `wholeNumberProblem(text, label, min)`, `amountProblem(text, currency, label)` (reuses `decimalStringToMinorUnits` for the shape, so valid text keeps today's exact minor units), `currencyInputMode(currency)`.
- `pages/orders/place.vue`: `DraftLine.quantity: number` becomes `quantityInput: string`; quantity box is `type="text" inputmode="numeric"`; `submit` refuses a line with a product whose quantity text is not a whole number of 1 or more (`data-testid="quantity-problem"`, `role="alert"`, "Line N quantity ..."); the `l.quantity > 0` silent filter is removed (a bad quantity is now a refusal, not a drop); the running total counts an unparseable quantity as 0 (an estimate only; the refusal is at submit). Unit price and discount boxes untouched.
- `pages/billing/index.vue`: payment amount box is `type="text"` with `:inputmode="currencyInputMode(...)"`, `min`/`step` removed, `data-testid="payment-amount-problem"`; `submitPayment` refuses before sending; `currencyInputStep` import dropped from this file.
- `pages/stock/index.vue`: units box is `type="text" inputmode="numeric"`, `min`/`step` removed, `data-testid="replenish-units-problem"`; `submitReplenish` uses `wholeNumberProblem` (replaces `Number.isFinite`/`<= 0`, which accepted `1.5`, `1e2`).
- `pages/currency-exponent.spec.ts`: one assertion, `step` `'1'` becomes `inputmode` `numeric` (see above).
- New tests: `lib/number-input.spec.ts`, `pages/orders/place.number-inputs.spec.ts`, `pages/billing/payment-amount.spec.ts`, `pages/stock/replenish-units.spec.ts`, `number-inputs.population.spec.ts`.

## Guards and arming (protocol: backup into `.arm/web7/arm/` with sha256, violation, the ONE named test, verbatim failure, restore by `cp`, `cmp`, green re-run; arm log: `.arm/web7/arm_log.txt`, runner `.arm/web7/arm.sh`, mutations `.arm/web7/mut/`)

Guard 1, one component test per fixed input, each over a literal list of malformed texts (`1-2 12e 2-/5-/19.99- 0 whitespace 1.5/19.999 abc -4/1,5`; no text a substring of another or equal to a control): asserts the problem text names the field and quotes the text, **no request** reached the endpoint, the box still holds the typed text, and `box.type === 'text'`. Plus controls (`3` to 3; `19.99` to 1999; `0.29` to 29; `7` to 7), and "problem not shown before a submit attempt" / "problem goes away when the text changes".

| arm | mutation | test run | verbatim failure | sha256 of backup (= file after restore, `cmp` identical) |
|---|---|---|---|---|
| A1 | delete the quantity refusal in `place.vue`. That line was replaced in Round 1; the current line, re-runnable, is `if (quantityProblems.value.length > 0 \|\| amountProblems.value.length > 0) return;` and the mutation is to make it `if (amountProblems.value.length > 0) return;` (re-armed in Round 2 as M1, verbatim failure `expected 1 to be +0`; the reviewer's X1 is the same arm) | `place.number-inputs.spec.ts -t 'quantity-input refuses "1-2"'` | `AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1` | `851a9d37ab056e8235f6270c892f075b4e09cce4efc137ec11a6ac46cdc0da17` |
| A2 | delete the `if (problem) {...return}` block in `billing/index.vue` | `payment-amount.spec.ts -t 'payment-amount-input refuses "19.999"'` | `TestingLibraryElementError: Unable to find an element by: [data-testid="payment-amount-problem"]` | `934b1c0a3460a0ba8434f9dae522d447664ba09997ec36d1493d4bbfa25ef3a3` |
| A3 | delete the `if (problem) {...return}` block in `stock/index.vue` | `replenish-units.spec.ts -t 'replenish-units-input refuses "1.5"'` | `Unable to find an element by: [data-testid="replenish-units-problem"]` | `2813400bc5ce90e5553f361a79d2020513f06c79a263d2e161678514a852289d` |
| A4 | corrupt a supplied field: `wholeNumberProblem(..., 'Units to add', 1)` to `0` | `replenish-units.spec.ts -t 'replenish-units-input refuses "0"'` | `Unable to find an element by: [data-testid="replenish-units-problem"]` | same as A3 |

A1's message is about the request count, not the missing text: with the refusal deleted the problem text still renders (it is computed), so the test reaches the "no request" claim and fails there, which is the property the arm removes.

Guard 2, `number-inputs.population.spec.ts` (node environment, 15 tests). Unit: the number-like `<input>`/`<Input>`/number-field tag in the `<template>` of every `.vue` under `app/`. The found set must equal a literal (`pages/orders/place.vue#quantity-input`, `#unit-price-input`, `#line-discount-input`, `pages/billing/index.vue#payment-amount-input`, `pages/stock/index.vue#replenish-units-input`), checked both ways, failing with the name of the box. Each text member must be `type="text"` + `inputmode` and have a named refusal test in a literal spec file. Each native member must stay `type="number"` with `min` and `:step`, inside a `<form>` with no `novalidate`. The scanner is itself tested on 6 sentinels (bare number input, `:type`, `v-bind` spread, number-field component, `inputmode`, `=>` inside an attribute, a comment/script string it must ignore, `novalidate` detection).

| arm | mutation | test | verbatim failure |
|---|---|---|---|
| P1 | bare `<input type="number" />` added to `stock/index.vue` | `-t 'the found set equals'` | `number-like boxes with no listed refusal: expected 'pages/stock/index.vue#(no data-testid…' to be ''` |
| P2 | `novalidate` added to the order `<form>` | `-t 'stays type="number"'` | `expected ' class="flex flex-col gap-6" novalida…' not to match /novalidate/i` (both native members) |
| P3 | quantity reverted to `type="number"`, the text-box attributes left only in an HTML comment | `-t 'is a text box asking'` | `expected '\n :id="\`quantity-fi…' to match /\btype="text"/` |
| P4 | dead region: `<template v-if="false"><input type="number" data-testid="ghost"/></template>` | found-set test | `...with no listed refusal: expected 'pages/stock/index.vue#ghost' to be ''` |
| P5 | `<Input v-bind="{ type: 'number' }" data-testid="ghost" />` | found-set test | same naming `...#ghost` |
| P6 | new never-rendered `app/components/GhostArm.vue` with a bare number input (file removed afterwards) | found-set test | `expected 'components/GhostArm.vue#ghost' to be ''` |
| P7 | sibling identifier: quantity's testid changed to `line-discount-input` | found-set test | `listed boxes that no longer exist: expected 'pages/orders/place.vue#quantity-input' to be ''` |
| P8 | drop an optional element: `inputmode` removed from the quantity box | found-set test | `listed boxes that no longer exist: expected 'pages/orders/place.vue#quantity-input' to be ''` |

Backups: P1, P4, P5 are `stock/index.vue` (`2813400b…289d`); P2, P3, P7, P8 are `place.vue` (`851a9d37…da17`); every restore was by `cp` from the backup, `cmp` identical, population file re-run green (15 passed). P1, P7, P8, P4, P5 were re-armed after I changed the guard's assertion to name the culprit (first version printed `Array(1)`); the table shows the re-run messages.

Defeat list for guard 2 (rows that apply):

| row | result |
|---|---|
| 1 delete the behaviour | A1, A2, A3 (behaviour tests) |
| 2 corrupt a supplied field | A4 |
| 3 substitute a sibling identifier | P7 fails, naming the lost box. Map keys are `file#testid`, so a duplicated testid cannot hide a member |
| 4 shadow the pattern in a comment | P3 fails: HTML comments are stripped before scanning, so the comment does not satisfy `type="text"`. Sentinel: a number input only inside a comment or a script string is ignored (not a rendered input) |
| 5 hide it in a dead region | P4 fails: the scanner is structural and does not evaluate `v-if`, so a dead-region input still counts (conservative) |
| 6 raw or triple-quoted string | script strings and comments are not scanned (sentinel test proves it ignores them); the guard does not claim to see an input built in a script string, which renders through the runtime and is covered by row 12's note below |
| 7 drop an optional element | P8 fails |
| 8 compare a literal to a literal | the refusal-test check reads the spec file and `toContain`s the title fragment; a renamed title fails it. The fragment alone does not prove the test runs the refusal: that is A1-A4's job, run per input |
| 9 satisfy the closer half, leave the premise stale | A-arms, not the population guard, hold the behaviour; the population guard holds membership and attributes |
| 10 build output or caches join the population | only `app/` is scanned; `.nuxt/` and `.output/` are outside it by path (excluded at the source) |
| 11 a form the instrument does not recognise | P5 (`v-bind` object spread) and the number-field-component sentinel are caught. Not caught: a custom component that renders `<input type="number">` internally with no number-like name, tag attribute or `inputmode`. The component scan covers every `.vue` under `app/`, so the inner `<input>` would be found at its own definition (P6) |
| 12 serve the failure through a path the population never drives | P6: an unrendered component is still found, since the scan is over files, not over rendered pages. The behavioural tests drive each page; a number-like input in a page the tests do not render is covered by the file scan only |

Guard 3, step 3 probe on the fixed production build (`nuxt build` exit 0, `build_after.log`; same stub, same 3017/3018; `probe/probe-after.json`):

| input | text | box | page | bytes | class |
|---|---|---|---|---|---|
| quantity | `3` (control) | `3` | none | `quantity":3` | pass |
| quantity | `1-2`, `12e`, `2-`, `0` | the typed text kept | `Line 1 quantity must be a whole number of 1 or more, but "1-2" is not.` (and the same with each text) | nothing | refused |
| quantity | empty | empty | `Line 1 quantity is required: enter a whole number of 1 or more.` | nothing | refused |
| unit price | `19.99` / `0.29` | same | none | `unitPrice` 1999 / 29 | control pass |
| unit price | `1-2 12e 19.99- 5- 19.999` | as before | native bubble (unchanged) | nothing | safe, unchanged |
| line discount | `19.99` / `0.29` | same | none | `lineDiscount` 1999 / 29 | control pass |
| line discount | `1-2 12e 19.99- 5- 19.999` | as before | native bubble (unchanged) | nothing | safe, unchanged |
| payment amount | `19.99` / `0.29` | same | outcome | `amount` 1999 / 29 | control pass |
| payment amount | `1-2 12e 19.99- 5- 19.999` | the typed text kept | `Amount must be digits with up to 2 decimals, like 19.99, but "<text>" is not.` | nothing | refused |
| replenish units | `7` | `7` | outcome | `units` 7 | control pass |
| replenish units | `1-2 12e 5- 1.5` | the typed text kept | `Units to add must be a whole number of 1 or more, but "<text>" is not.` | nothing | refused |

## Gates (in `apps/web`, every run under `setsid --wait timeout -k 10 ...`)

| gate | before | after |
|---|---|---|
| `pnpm --filter @otc/web test` | 18 files, **148** tests passed | 23 files, **227** tests passed |
| `pnpm --filter @otc/web typecheck` (`nuxi typecheck`) | not run before the change | exit 0 |
| `pnpm --filter @otc/web lint` (`eslint apps/web`) | not run before the change | exit 0 |
| `nuxt build` | exit 0 (pre-change bundle, for the probe) | exit 0 (fixed bundle) |

Count reconciliation (per-file vitest counts, run this session): 227 − 148 = 79 new = `lib/number-input.spec.ts` 32 + `place.number-inputs.spec.ts` 11 + `payment-amount.spec.ts` 11 + `replenish-units.spec.ts` 10 + `number-inputs.population.spec.ts` 15; the edited `currency-exponent.spec.ts` adds 0. Files: 18 + 5 = 23.

Not run: `quality` at repo root (it chains the other workspaces' coverage and is out of scope), the Playwright e2e (needs the real stack; `e2e/happy-path.spec.ts` fills `quantity-input` with `fill('2')`, which works on a text box, but I did not run it).

## Surprises

- CORRECTED (Round 2, review A1): the first version of this bullet said the #9 failure (an order placed at the catalogue price with no error) does not happen in #7 for unit price and discount. It does, for exponent text: `1e3` passed native validation and the order went out at the catalogue price or with no discount. It recurred in #7 and Round 1 closed it.
- The real #7 defect was the quantity box: `Number("")` is `0`, and the page rewrote the box with `0`, so typing `1-2` placed an order with quantity 2.
- `step` is asserted in `currency-exponent.spec.ts`, not in `place.currency.spec.ts` as the brief guessed (the premise check had the second right).
- Billing/stock Submit buttons are disabled on `""`, which hid the defect behind a dead button.

## Effort

About 90 minutes of wall-clock (probe set-up and run 25, fix and tests 30, arming 25, record 10).

## Round 1 — unit price and line discount

Leader decision (this session): move the two `place.vue` money boxes to the same mechanism, because the native bubble does not name the field and nothing guarded it (a `novalidate` would have reopened the gap). Same bounds. Supersedes the "SAFE, unchanged" rows above for these two.

Change (all under `apps/web/app/`):
- `lib/number-input.ts`: added `optionalAmountProblem(text, currency, label)`: empty is "not typed" (catalogue price, no discount) and acceptable, any other text goes through `amountProblem`.
- `pages/orders/place.vue`: unit price override and line discount are `type="text"` with `:inputmode="currencyInputMode(form.currency)"` (`decimal` for EUR/BHD, `numeric` for JPY). `min` and `step` are removed from both, and the `currencyInputStep` import is dropped from this file. A new `amountProblems` computed (per line with a product, labels `Line N unit price override` / `Line N line discount`, parsed with the form's own currency) is shown like the quantity problems (after the first submit attempt, then live) in `data-testid="line-amount-problem"`, `role="alert"`. `submit` returns before sending when quantity or amount problems exist. `currencyInputStep` itself stays in `lib/money.ts` (its `money.spec.ts` test is untouched; nothing renders with it now).
- `pages/currency-exponent.spec.ts`: the two BHD `step` assertions (`'0.001'`) became `inputmode` `'decimal'` assertions. The exponent still drives parsing, and that is asserted in the same test (`1.005` BHD is 1005, `0.5` is 500) and in the new spec below (armed as R3). `place.currency.spec.ts` asserts no `step` (premise check), so it did not change.
- New `pages/orders/place.amount-inputs.spec.ts` (26 tests): for each of the two boxes, 8 malformed texts (`1-2 12e 19.99- 5- 19.999 "  x" abc 1,5`: refused in words naming line and field, quoting the text, no request, typed text kept, `box.type === 'text'`), controls `19.99` to 1999 and `0.29` to 29, empty box not refused and field omitted from the payload, BHD `1.005` to 1005 with `inputmode` `decimal`, JPY `19.5` refused with `inputmode` `numeric`.
- `number-inputs.population.spec.ts`: the expected set is now all five members, each `type="text"` + `inputmode` with a named refusal test (its spec file must contain the testid and the title fragment `refuses %j`); the native-members test and constant are removed, and the `novalidate` sentinel in the scanner tests stays.

Arms (backup into `.arm/web7/arm/` with sha256, restore by `cp`, `cmp` identical, green re-run each time; `place.vue` backup sha256 `8c71ab5cffa9751c7760f67d709d4067360c598716579deda8b27e3b16d6decb`):

| arm | mutation | test | verbatim failure |
|---|---|---|---|
| R1 | delete the unit-price entry from `amountProblems` | `place.amount-inputs.spec.ts -t 'unit-price-input refuses "1-2"'` | `Unable to find an element by: [data-testid="line-amount-problem"]` |
| R2 | delete the line-discount entry from `amountProblems` | `-t 'line-discount-input refuses "5-"'` | `Unable to find an element by: [data-testid="line-amount-problem"]` |
| R3 | corrupt a field: unit-price parsed with `"EUR"` instead of `form.currency` | `-t 'unit-price-input: the form'` (the BHD test) | `expected [] to have a length of 1 but got +0` (BHD `1.005` wrongly refused) |
| R4 | drop `amountProblems` from the early return in `submit` | `-t 'unit-price-input refuses "19.999"'` | `expected [ { …(4) } ] to have a length of +0 but got 1` (the request was sent) |
| R5 | revert unit price to `type="number" min step` | `number-inputs.population.spec.ts -t 'is a text box asking'` | `expected '\n :id="\`unit-price-…' to match /\btype="text"/` |
| R6 | bare `<input type="number" />` added to `stock/index.vue` (population arm re-run on the five-member set; backup sha256 `2813400bc5ce90e5553f361a79d2020513f06c79a263d2e161678514a852289d`) | `-t 'the found set equals'` | `number-like boxes with no listed refusal: expected 'pages/stock/index.vue#(no data-testid…' to be ''` |

Defeat list: the rows already run for guard 2 (3, 4, 5, 7, 11, 12) apply unchanged to the five-member set; R5 and R6 re-ran the population guard on it (revert to `type="number"` caught, a bare input caught). Rows 1 and 2 are R1/R2/R4 and R3.

Re-probe of the fixed production build (`nuxt build` exit 0, `build_r1.log`; stub 3018, server 3017; `probe/probe-round1.json`, script `probe/probe-r1.mjs`; both stopped by PID, ports free afterwards, `.output` removed):

| input | text | box | page | bytes | class |
|---|---|---|---|---|---|
| unit price | `19.99` (control) | `19.99`, `type=text` | none | `"unitPrice":1999` | pass |
| unit price | `0.29` (control) | `0.29` | none | `"unitPrice":29` | pass |
| unit price | `1-2` | `1-2` (kept) | `Line 1 unit price override must be digits with up to 2 decimals, like 19.99, but "1-2" is not.` | nothing | refused |
| unit price | `12e` | kept | same sentence with `"12e"` | nothing | refused |
| unit price | `19.99-` | kept | same sentence with `"19.99-"` | nothing | refused |
| line discount | `19.99` / `0.29` (controls) | same | none | `"lineDiscount":1999` / `29` | pass |
| line discount | `5-` | kept | `Line 1 line discount must be digits with up to 2 decimals, like 19.99, but "5-" is not.` | nothing | refused |
| unit price, currency BHD | `1.005` | kept | none | `"currency":"BHD"`, `"unitPrice":1005` | pass |
| line discount, currency BHD | `1.005` | kept | none | `"currency":"BHD"`, `"lineDiscount":1005` | pass |

Gates (`apps/web`, under `setsid --wait timeout -k 10`): tests 24 files and **255** passed. Reconciliation with 227: +28 = `place.amount-inputs.spec.ts` 26 (2 boxes x (8 malformed + 2 controls + empty + BHD + JPY)) + population spec net +2 (the two text-member tests gained 2 members each, +4, and the two native tests were removed, -2); files 23 + 1 = 24. `typecheck` exit 0, `lint` exit 0, `nuxt build` exit 0. Not run: root `quality`, e2e. Nothing committed, no packages added.

Effort for Round 1: about 35 minutes.

## Round 2 — after the first review

Review: `progress/review_web_number_inputs.md` (REJECTED, 1 blocking, 9 advisories). Brief: `../order-to-cash-python/progress/brief_impl_web7_number_inputs_round2.md`. Evidence and backups in `../order-to-cash-python/.arm/web7f/` (`arm/`, `arm_log.txt`, `mut/`, `probe/`, `*.log`). Arm runner `.arm/web7f/arm.sh`; each arm: backup with sha256, mutation, the one named test, restore by `cp`, `cmp identical`, green re-run. Backup sha256 values (equal to the file after restore): `place.vue` `cc591b90e090d034c755c619d58d87d27eef6557d1e407599164d223ae98c7dc`, `billing/index.vue` `d1f20483707e211516d001645dc159ef0896e3a3dd7c4722c26786b58f2be18e`, `stock/index.vue` `ff2c7287e379b984c196904925c56aeaa19fd13257c6df2ada53adc913024881`, `lib/number-input.ts` `46179f35f34bb58a7fa980b17403493dba2b58ca5eef365cd0b3831fa7cfe82f`.

### B1: the population guard is now render-based

`app/number-inputs.population.spec.ts` is rewritten (`@vitest-environment nuxt`, 18 tests). The source scanner is **removed**, not patched (defeat row 11: a syntax guard that keeps losing is replaced by inspecting what runs). What it gave up (CORRECTED in Round 3; the first wording, "an input in a component that no page mounts (never user-visible)", was false): a literal number box in a layout or `app.vue` (rendered around every page, so user-visible; reviewer's N1) and in any state the drivers do not reach (reviewer's N2, premise P5); Round 3 restores a source pre-check for exactly those. What the render-based instrument adds: it sees every form (unquoted attribute, `<component is>`, render function, spread, dynamic component) because it asks the DOM.

What it does: `import.meta.glob('./pages/**/*.vue')` derives the page list from the files; each page is mounted through the glob's own module (so the component under test is the file found); the forms that hold boxes are opened (order page: codes filled so a line exists; billing: Register payment; stock: Replenish); the DOM is asked for `input[type="number"], [role="spinbutton"]` (must be none) and for every `input[inputmode]` (must equal the literal set of five: `quantity-input`, `unit-price-input`, `line-discount-input`, `payment-amount-input`, `replenish-units-input`). Each of the five is then driven with `1e3`: the page must show the problem naming the field, send nothing (a counter at the stubbed endpoint), set `aria-invalid="true"`, and `aria-describedby` must point at an element whose text names the field and quotes `1e3`.

Premises of the new instrument (CLAUDE.md "Changing an instrument") and how each is armed:

| premise | guard | arm | verbatim failure |
|---|---|---|---|
| P1 every page file is classified (a new page joins the population) | `P1:` test: the file list vs the literal mounters/drivers, both ways | new `app/pages/ghost.vue` with a number input (created, removed, absent afterwards) | `page files with no mounter or driver: expected './pages/ghost.vue' to be ''` |
| P2 every page really mounts | each mounter waits for a literal anchor (the h1, or `Order-To-Cash` on login; `index.vue` is a redirect page that renders an empty div, so it has no anchor, stated in the spec) | P2F: `throw` in billing's `<script setup>` | `Error: arm: page does not mount` (both billing tests fail) |
| P2 (silent empty mount) | the anchor wait | P2H: stock `<h1>Stock</h1>` renamed `Stocks` | `Unable to find role="heading" and name "Stock"` |
| P3 every form really opens | drivers wait for the form's own controls | P3B: billing `register-payment-button` testid renamed | `Unable to find an element by: [data-testid="register-payment-button"]` |
| P3 | same | P3F: stock `replenish-button` testid renamed | `Unable to find an element by: [data-testid="replenish-button"]` |
| P4 the DOM query sees number-like boxes however built | 4 sentinels render a box through a render function, a dynamic component, a `spinbutton` role, and check an `inputmode` box is listed and a plain text box is not | sentinels are positive controls | (they must pass; the three B1 arms below show the same query failing the page) |
| P5 only states the drivers reach are seen | stated limit: the order page is driven with the catalogue unavailable (text code fields), not with a loaded catalogue | not armable; disclosed | |

The reviewer's three B1 mutations, each added to `pages/stock/index.vue`, now fail on the stock page by name (`renders no number box, and exactly its expected inputmode boxes`):

| arm | mutation | verbatim failure |
|---|---|---|
| O3 | `<input type=number data-testid="ghost" />` (unquoted) | `type="number" or spinbutton boxes in the rendered DOM: expected 'ghost' to be ''` |
| O2a | `<component is="input" type="number" data-testid="ghost" />` | same, naming `ghost` |
| O2b | render-function component `h('input', { type: 'number' })` in `<script setup>` plus `<GhostBox />` | same, naming `ghost` |
| GF | a ghost number input inside the replenish form (appears only once the form is opened) | same, naming `ghost` |

Removing one member's refusal (population spec):

| arm | mutation | verbatim failure |
|---|---|---|
| M1 | `place.vue`: drop `quantityProblems` from the early return in `submit` | `quantity-input refuses "1e3"...`: `AssertionError: expected 1 to be +0` (the request was sent) |
| M2 | `billing/index.vue`: delete the `if (problem) {...return}` block | `payment-amount-input refuses "1e3"...`: `AssertionError: expected null to be 'true'` |
| M3 | `stock/index.vue`: delete the `if (problem) {...return}` block | `replenish-units-input refuses "1e3"...`: `AssertionError: expected null to be 'true'` |

### Per item

- **A1, A8 (record).** Step-1 table rows, the "Result" paragraph and "Surprises" corrected above: unit price and line discount were NOT safe at HEAD (`1e3` passed native validation; the reviewer's `native.mjs` line is quoted); the inherited #9 finding **recurred** in #7 and was closed by Round 1. Behaviour change recorded: `1e3` as quantity or units used to be sent as 1000 (HEAD `Number(v)` and `Number.isFinite`) and is now refused in words.
- **A2 (fixtures).** `"1e3"` and `"1e-2"` added to `MALFORMED_AMOUNTS` / `MALFORMED_QUANTITIES` / `MALFORMED_UNITS` in `place.amount-inputs.spec.ts`, `payment-amount.spec.ts`, `place.number-inputs.spec.ts`, `replenish-units.spec.ts`, and to the `it.each` lists in `lib/number-input.spec.ts`. Arm A2: `wholeNumberProblem` made to accept `\d+(e-?\d+)?`; test `number-input.spec.ts -t 'refuses'`; failure `wholeNumberProblem > refuses "1e3", naming the field and quoting the text`: `AssertionError: expected undefined to be 'Units must be a whole number of 1 or …'`.
- **A3 (empty box said in words).** Dropped `|| !paymentForm.amountInput` from billing's Submit `:disabled` (now `registerPayment.isPending.value || !paymentForm.paymentReference`, double-submit guard kept) and `|| !unitsInput` from stock's (now `replenish.isPending.value`). Tests: `payment-amount-input: an EMPTY box is refused in words...` and the stock twin: Submit is not disabled, clicking shows `Amount is required` / `Units to add is required`, nothing sent. Arms A3B and A3S re-add the condition; failure `expect(element).not.toBeDisabled()` in each.
- **A4 (too large).** `lib/number-input.ts`: well-formed digits above `Number.MAX_SAFE_INTEGER` (quantity, units) or a well-formed amount whose minor units are not a safe integer get `... is too large: "<text>" ...` instead of "must be digits". Tests: `number-input.spec.ts` (`9007199254740993` too large, `9007199254740991` accepted; `90071992547409.92` EUR too large, `90071992547409.91` accepted, JPY `9007199254740992` too large) plus one test per box in the four page specs. Arm A4: delete the amount too-large branch; failure `amountProblem > says "too large"...: expected undefined to be 'Amount is too large: "90071992547409.…'`.
- **A5 (aria).** All five boxes carry `aria-invalid="true"` and `aria-describedby` (pointing at the problem element: `quantity-problems`, `line-amount-problems`, `payment-amount-problem`, `replenish-units-problem`) while their own problem is shown, and neither otherwise. On the order page the state is per box and per line (`shownProblem(index, box)`), not shared. Each per-box malformed test asserts both attributes and that the described element contains the problem text; each valid-text control asserts neither attribute. Arms A5B (billing `aria-describedby` removed): `aria-describedby must name the problem element: expected null to be truthy`; A5P (line discount `aria-invalid` removed): `expected null to be 'true'`.
- **A6.** The BHD test title no longer claims EUR/JPY: it says BHD `1.005` is 1005 and the box asks for the decimal keyboard. The EUR refusal is a new test (`"1.005" is refused in EUR (2 decimals), naming the field`, asserts `up to 2 decimals` and no request); JPY keeps its own test.
- **A7.** Record's arm A1 row updated to the current line (see the arm table above; re-armed here as M1).
- **A9 (running total).** `place.vue`: `runningTotalKnown` is false while any quantity, unit price or discount holds a refused text; the total then shows `—` (title: "A box above holds text that is not a valid number, so there is no total yet"), never a catalogue-price fallback or a 0. Test: `the running total is unknown while a box holds a refused text` (2 x 19.99 shows 39.98, then `—` for a refused unit price, a refused discount and a refused quantity, and the number comes back when the text is fixed). Arm A9: `runningTotalKnown = computed(() => true)`; failure `AssertionError: expected '€0.00' to be '—'`.

### Re-probe of the production build (reviewer's probe, every row)

`nuxt build` exit 0 (`build_r2.log`); stub Gateway 3018 and server 3017 started and stopped by PID with `.arm/web7f/probe/run.sh` (copy of the reviewer's script, paths changed to `web7f`); `ss -ltnp` free afterwards, `.output` removed. Reviewer's `probe.mjs` and `stub-gateway.mjs` unchanged. Output `.arm/web7f/probe/probe.out` / `probe.json`: **89 rows, the same 89 as the reviewer's `probe.out`.** Findings across all of them: every malformed text (`+5 1,5 1e3 0x10 ١٢ -5 1-2 12e 19.99- 5- 19.999`, BHD `1.0005`, JPY `19.5`) shows `Line N ... must be ...`, `Amount must be ...` or `Units to add must be ...` with the text quoted, `sent=0`, and the box keeps the typed text; `type=text` everywhere; `inputmode` numeric for quantity, units and JPY, decimal for EUR and BHD; controls send quantity 3 (and `" 3 "` 3), unit price 1999 / 29 / BHD 1005 / JPY 1999, discount 1999 / 29 / BHD 1005 / JPY 1999, payment 1999 / 29 / JPY 1999, units 7 / `" 3 "` 3, `9007199254740991` units, `90071992547409.91` money (9007199254740991); `9007199254740993`, `90071992547409.92` now read "is too large" (Round 2); the empty payment amount and empty units now read "is required" with the button enabled (`dis=false`); empty quantity reads "required"; empty unit price and discount send no `unitPrice` / `lineDiscount`.

### Gates (apps/web, `setsid --wait timeout -k 10`)

| gate | result |
|---|---|
| web tests | 24 files, **284** passed (was 255) |
| `typecheck` (`nuxi typecheck`) | exit 0 |
| `lint` (`eslint apps/web`, from root) | exit 0, no warnings (two `vue/attributes-order` warnings in `place.vue` were fixed first) |
| `nuxt build` | exit 0 |
| root `pnpm run quality` | exit 0 (`quality.log`); web 24 files / 284, orders 544, billing 164, gateway 141, projector 186, seed 149, all green |

Count reconciliation 255 to 284 = +29: per-file counts (run per file this session) `number-input.spec.ts` 37 (was 32, +5: whole-number list −1 (`99999999999999999999` moved to the too-large test) +2 (`1e3`, `1e-2`) = +1, amount list +2, two new too-large tests +2), `place.number-inputs.spec.ts` 15 (was 11, +4), `place.amount-inputs.spec.ts` 37 (was 26, +11), `payment-amount.spec.ts` 15 (was 11, +4), `replenish-units.spec.ts` 14 (was 10, +4), `number-inputs.population.spec.ts` 18 (was 17, +1); 5 + 4 + 11 + 4 + 4 + 1 = 29. `currency-exponent.spec.ts` unchanged this round. Files unchanged at 24.

Not run: the Playwright e2e (needs the `otc` stack, which must not run beside #9). `e2e/happy-path.spec.ts` fills `quantity-input` with `fill('2')`, which works on a text box. Nothing committed, no packages added. Effort for Round 2: about 110 minutes.

## Round 3 — after the second review (light)

Maintainer's choice after the second rejection: a light, test-only round, verified by the leader. Items R2-B1, R2-A1, R2-A2 of `progress/review_web_number_inputs.md` "Re-review (round 2)". **No product code changed**: only `app/number-inputs.population.spec.ts` (edited) and `app/number-inputs.source.spec.ts` (new) are touched; nothing else in `app/`. Evidence and backups: `../order-to-cash-python/.arm/web7f3/` (`arm/`, `arm_log.txt`, `mut/`, `arm.sh`, `*.log`). No browser probe (no product change). Packages installed: none.

### R2-B1: the page glob covers every extension Nuxt routes

`app/number-inputs.population.spec.ts`: `import.meta.glob(['./pages/**/*.{vue,ts,tsx,js,jsx}', '!./pages/**/*.{spec,test}.{js,cts,mts,ts,jsx,tsx}'])`. Spec and test files are excluded at the glob, with Nuxt's own default-ignore pattern, never by filtering the result. Arm: the reviewer's `app/pages/ghost.ts` (a `defineComponent` render page with `<input type="number">`), created and removed (`ls app/pages/ghost*` finds nothing afterwards):

```
cd apps/web
cat > app/pages/ghost.ts <<'EOF2'
import { defineComponent, h } from 'vue';
export default defineComponent({ render: () => h('div', [h('h1', 'Ghost'), h('input', { type: 'number' })]) });
EOF2
pnpm exec vitest run app/number-inputs.population.spec.ts -t 'P1:'
rm app/pages/ghost.ts
```

Verbatim failure: `P1: every page file under app/pages is classified here, and every classified page still exists` : `AssertionError: page files with no mounter or driver: expected './pages/ghost.ts' to be '' // Object.is equality`. Counter-check (the exclusion works): a lone `app/pages/ghost.spec.ts` leaves the same test green (`Tests 1 passed`).

### R2-A1: source pre-check beside the render guard

New `app/number-inputs.source.spec.ts` (`@vitest-environment node`, 13 tests). It scans **every `.vue` under `app/`** (pages, layouts, `app.vue`, components; a first test asserts that `app.vue`, `layouts/default.vue`, `pages/orders/place.vue` and a `components/` file are in the scanned list, so the scan cannot silently shrink) with a quote-aware tag scan. The markup is the file minus `<script>`, `<style>` and HTML comments, not located by a line anchor (round 1 located `<template>` at line start). Number-like: `type` number quoted with either quote **or unquoted**, `:type` / `v-bind:type`, an attribute spread, `inputmode`, `<component is="input">` / `<component :is=...>`, number-field-like tag names. The found set must equal the literal five (`file#testid`), each `type="text"` with `inputmode`. Six sentinel tests prove the scanner catches each form and ignores comments, script strings, a password input and `<component is="div">`.

What it adds over the render guard: a literal number box in any state or layout, including states the drivers never reach. What the render guard still adds over it: boxes built by a render function, a dynamic component or a spread. Neither is claimed alone.

Arms (backup into `.arm/web7f3/arm/` with sha256, mutation, the one named test, restore by `cp`, `cmp identical`, green re-run; runner `.arm/web7f3/arm.sh`; every restore printed `restored: cmp identical` and re-ran green). Re-run from `.arm/web7f3` (the mutation scripts are in `mut/`):

```
M=$PWD/mut; SRC=app/number-inputs.source.spec.ts; POP=app/number-inputs.population.spec.ts
./arm.sh O3S  app/pages/stock/index.vue $M/o3.sh  $SRC 'the found set equals'   # unquoted <input type=number>
./arm.sh O2AS app/pages/stock/index.vue $M/o2a.sh $SRC 'the found set equals'   # <component is="input" type="number">
./arm.sh N1   app/layouts/default.vue   $M/o3.sh  $SRC 'the found set equals'   # a box in the layout
./arm.sh N1R  app/layouts/default.vue   $M/o3.sh  $POP 'renders no number box'  # same box, render guard: stays green (limit)
./arm.sh N2S  app/pages/stock/index.vue $M/n2.sh  $SRC 'the found set equals'   # box behind a v-if the drivers never open
./arm.sh N2R  app/pages/stock/index.vue $M/n2.sh  $POP 'renders no number box'  # same, render guard: stays green (limit P5)
```

| arm | mutation | guard | result (verbatim) | backup sha256 (= restored) |
|---|---|---|---|---|
| O3S | `<input type=number data-testid="ghost" />` in stock | source | `number-like boxes with no listed refusal: expected 'pages/stock/index.vue#ghost' to be ''` | `ff2c7287e379b984c196904925c56aeaa19fd13257c6df2ada53adc913024881` |
| O2AS | `<component is="input" type="number" data-testid="ghost" />` in stock | source | same, naming `pages/stock/index.vue#ghost` | same |
| N1 | `<input type=number data-testid="ghost" />` in `layouts/default.vue` | source | `... expected 'layouts/default.vue#ghost' to be ''` | `5bfb54d495954e0d151f11b3c7871238e1a80b85d5b8876570fb85618e38e5c5` |
| N1R | same layout mutation | render guard | **green** (`Tests 7 passed`): layouts are not mounted by it; this is the uncovered area, now covered by the source pre-check | same |
| N2S | a button and `<input v-if="ghostOpen" type="number">` on stock (`ghostOpen` starts false; no driver clicks the button) | source | `... expected 'pages/stock/index.vue#ghost' to be ''` | `ff2c7287...1` as above |
| N2R | same | render guard | **green** (`Tests 7 passed`) | same |

### R2-A2: N2 under P5

N2R is the armed demonstration of premise P5 ("only states the drivers reach are seen"): a number box behind an interaction the drivers do not perform is invisible to the render guard (green) and is caught by the source pre-check (N2S, red). The record's P5 row and the spec header (`number-inputs.population.spec.ts`) now say so, and the header names the layouts and `app.vue` as not mounted by the render guard.

Not covered by either instrument (stated): a number box built in a render function or a dynamic component inside a state the drivers do not reach, or inside a layout or component that no driven page mounts.

### Gates (apps/web unless noted; `setsid --wait timeout -k 10`)

| gate | result |
|---|---|
| web tests | 25 files, **297** passed (was 284 / 24: +13 = the 13 tests of `number-inputs.source.spec.ts`; the population spec is unchanged at 18) |
| `typecheck` | exit 0 |
| `pnpm run lint` (root, `eslint .`) | exit 0 |
| root `pnpm run quality` | exit 0 on the second run (`quality2.log`): web 297, orders 544, billing 164, gateway 141, projector 186, seed 149, notifications 121, fulfillment 92, shared-kernel 89, contracts 22. **The first run failed once in `apps/orders`**: `idempotent-consumer.parity.spec.ts > OI12` raised `ENOENT ... apps/notifications/src/__pr20-fixture-mongodb.ts` (a temporary fixture that one test creates and another reads; `ls apps/notifications/src | grep -i fixture` is empty afterwards and `git status` shows nothing under `apps/orders` or `apps/notifications`). I did not touch either; the re-run is green. I report it rather than hide it: it looks like a race between that suite's own fixture writer and reader, unrelated to this change, and I did not investigate further |

Effort for Round 3: about 35 minutes.
