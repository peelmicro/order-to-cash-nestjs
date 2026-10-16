# review_web_number_inputs: #7 number boxes, probe and fix (full group, money parsing)

**Verdict: REJECTED** (1 blocking finding, 9 advisories). This is rejection round 1.

Reviewer: read-only. Evidence, scripts and arm backups are in `../order-to-cash-python/.arm/web7r/` (`probe/`, `arm/`, `arm_log.txt`, `*.log`). I did not edit `#7`. The only things I created there were the production `.output/` (git-ignored, removed afterwards) and temporary arm mutations, each restored by `cp` and checked with `cmp`. At the end, all four mutated files matched the pre-review sha256 list (`sha_before.txt`, `sha256sum -c` OK).

Inputs read: `../order-to-cash-python/progress/brief_review_web7_number_inputs.md`, `brief_impl_web7_number_inputs.md`, `progress/impl_web_number_inputs.md` (including "Round 1"), the full diff of the 4 modified files, all 5 new spec files and `lib/number-input.ts`.

## What I ran (verification, not repetition)

| run | result |
|---|---|
| `vitest run` (apps/web, full: the claim under test is the count) | **24 files, 255 passed**, exit 0. JSON reporter per file: new = `number-input.spec` 32 + `number-inputs.population.spec` 17 + `payment-amount.spec` 11 + `place.amount-inputs.spec` 26 + `place.number-inputs.spec` 11 + `replenish-units.spec` 10 = 107. Pre-existing = 255 − 107 = **148 across 18 files**, which matches the record's "before" count |
| `pnpm run lint` (`eslint apps/web` from root) | exit 0 |
| `pnpm run typecheck` (`nuxi typecheck`) | exit 0 |
| `pnpm run build` (`nuxt build`) | exit 0 (`.output` removed afterwards) |
| root `pnpm run quality` (lint + typecheck -r + test:coverage -r, Docker-free by `vitest.config` exclusion of `*.integration.spec.ts`) | **exit 0**, 69 s. Every workspace green, with web at 24/255 |
| Chromium probe against the production build: web on 3017, stub Gateway on 3018 (my copy, with a second JPY invoice added), 93 rows | `probe/probe.out`, `probe/probe.json` (summary below) |
| native `type="number"` probe (Chromium, `page.setContent`) | `probe/native.mjs` (used for advisory A1) |
| 13 arms, of which 3 are my own non-arms (guard stayed green) | `arm_log.txt` (table below) |

Not run: the Playwright e2e suite, which needs the `otc` stack, and that stack must not run while #9 stage 3 is using `otcpy`. Assessed by reading instead: `e2e/happy-path.spec.ts:40` does `getByTestId('quantity-input').fill('2')`, which works on a text box. `e2e/compensation.spec.ts` and `scripts/capture-demo.mjs` use `Fill demo order`, whose `fillCompensationDemo()` now sets `quantityInput: '1'` and `unitPriceInput: '249.99'`, both of which pass the new parsers. `scripts/place-order.mjs` and `pay-invoice.mjs` are NATS clients that never touch the UI. No locator anywhere depends on `spinbutton` (`grep -rn "spinbutton\|quantity-input\|unit-price-input\|line-discount-input\|payment-amount-input\|replenish-units-input" e2e ../../scripts` finds one hit, `happy-path.spec.ts:40`). **Conclusion: no e2e spec is likely broken. This is inferred from reading the code, not from a run.**

`ss -ltnp` before and after: 3017 and 3018 free, 3000 and 3010 not listening, and my two PIDs were stopped by PID. `docker ps` before and after shows the same single container (`otcpy-n8n`, not mine). I never started the `otc` stack.

## Q1. The rule, box by box (Chromium, production build, bytes read at the stub Gateway)

| box | controls → bytes | malformed (brief + mine) | result |
|---|---|---|---|
| place quantity | `3` → `quantity:3`; `" 3 "` → 3; `9007199254740991` → that integer | `+5`, `1,5`, `1e3`, `0x10`, `١٢`, `9007199254740993`, `-5`, `0`, `1-2`, `12e` → "Line 1 quantity must be a whole number of 1 or more, but "<text>" is not."; empty → "Line 1 quantity is required…" | refused in words naming the field, **0 bytes sent**, typed text kept |
| place unit price (EUR, BHD, JPY) | `19.99` → 1999, `0.29` → 29, `" 19.99 "` → 1999, BHD `1.005` → 1005, JPY `1999` → 1999, `90071992547409.91` → 9007199254740991; empty → no `unitPrice` (catalogue) | `1-2 12e 19.99- 5- 19.999 +5 1,5 1e3 0x10 ١٢ -5`, `90071992547409.92` (> MAX_SAFE minor units), BHD `1.0005`, JPY `19.5` → "Line 1 unit price override must be …, but "<text>" is not." | refused, 0 sent |
| place line discount | `19.99` → 1999, `0.29` → 29, BHD `1.005` → 1005, JPY `1999` → 1999; empty and `0` → no `lineDiscount` (unchanged from HEAD's `lineDiscount ? …`) | same set, plus JPY `19.5` | refused, 0 sent |
| billing payment amount (EUR, JPY invoice) | `19.99` → 1999, `0.29` → 29, `" 19.99 "` → 1999, JPY `1999` → 1999 | same set, plus JPY `19.5` → "Amount must be a whole number (JPY has no decimals)…" | refused, 0 sent; empty → Submit disabled (A3) |
| stock replenish units | `7` → `units:7`, `" 3 "` → 3 | `+5 1,5 1e3 0x10 ١٢ 9007199254740993 -5 0 1-2 12e 1.5` → "Units to add must be a whole number of 1 or more…" | refused, 0 sent; empty → button disabled (A3) |

Malformed text was never sent, and no valid text was ever sent as a different number. Every box is `type="text"`. `inputmode` is `numeric` for quantity, units and JPY, and `decimal` for EUR and BHD. `\d` in the regexes has no `u` flag, so it matches ASCII digits only, which is why Arabic-Indic digits are refused. `decimalStringToMinorUnits` trims its input itself, so the gap I suspected (the check trims but the send does not) does not exist: `" 19.99 "` was sent as 1999.

**Regression against HEAD for valid input:** none for any value HEAD read correctly. These are deliberate tightenings (A8): `1e3` in quantity or units was sent as 1000 by HEAD (`Number(v)`, and in stock `Number.isFinite`) and is now refused in words. Zero is accepted and sent as 0 for unit price and payment amount, as it was at HEAD (`min="0"`); this is not a regression, and the backend owns that rule.

## Q2. Empty means "not typed"

Unit price empty → no `unitPrice` (the catalogue price, placeholder `catalogue`). Line discount empty → no `lineDiscount` (placeholder `0.00`). Probed, and identical to HEAD (`git show HEAD:…/place.vue:216-222`). Quantity empty → refused in words; HEAD dropped the line through `quantity > 0` or relied on the native bubble. Payment amount and units empty → nothing sent, but the only signal is a disabled button with no words, unchanged from HEAD (A3).

## Q3. Arms (protocol: `cp` to `.arm/web7r/arm/<id>.bak` with sha256, mutation, the ONE named test, restore by `cp`, `cmp`, clear `.vite` caches, green re-run)

| arm | spec file | mutation | result (verbatim) | backup sha256 = restored |
|---|---|---|---|---|
| X1 | place.number-inputs | drop `quantityProblems.value.length > 0 \|\|` from the early return (the record's A1 line no longer exists after Round 1) | `AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1` | `8c71ab5c…decb` |
| X2 | payment-amount | delete the `if (problem) {…}` block | `Unable to find an element by: [data-testid="payment-amount-problem"]` | `934b1c0a…a3` |
| X3 | replenish-units | delete the `if (problem) {…}` block | `Unable to find an element by: [data-testid="replenish-units-problem"]` | `2813400b…289d` |
| X4 | number-input.spec | drop `Number.isSafeInteger(…) &&` from `wholeNumberProblem` | `expected undefined to be 'Units must be a whole number of 1 or …'` (`99999999999999999999`) | `183cdce4…d565` |
| X5 | currency-exponent.spec | `currencyInputMode` → always `decimal` | `AssertionError: expected 'decimal' to be 'numeric'` (JPY invoice) | `183cdce4…d565` |
| R3 | place.amount-inputs | unit price parsed with `'EUR'` instead of `form.currency` | `expected [] to have a length of 1 but got +0` (BHD 1.005) | `8c71ab5c…decb` |
| R5 | population | unit price back to `type="number" min step` | `expected '\n :id="\`unit-price-…' to match /\btype="text"/` | `8c71ab5c…decb` |
| R6 | population | bare `<input type="number" />` in stock | `number-like boxes with no listed refusal: expected 'pages/stock/index.vue#(no data-testid…' to be ''` | `2813400b…289d` |
| O1 (mine, sibling) | place.amount-inputs | unit-price label → `Line N line discount` | `expected 'Line 1 line discount must be digits w…' to contain 'Line 1 unit price override'` | `8c71ab5c…decb` |
| O1b (mine, sibling) | payment-amount | label `'Amount'` → `'Payment reference'` | `expected 'Payment reference must be digits with…' to contain 'Amount'` | `934b1c0a…a3` |
| **O2a (mine)** | population | `<component is="input" type="number" data-testid="ghost" />` in stock | **green: `Tests 1 passed`** | `2813400b…289d` |
| **O2b (mine)** | population | `const GhostBox = () => h('input', { type: 'number', … })` + `<GhostBox />` in stock | **green: `Tests 1 passed`** | `2813400b…289d` |
| **O3 (mine)** | population | `<input type=number data-testid="ghost" />` (unquoted value) in stock | **green: `Tests 1 passed`**; also `eslint` on the mutated file exit 0 with no output | `2813400b…289d` |

Every restore printed `cmp identical` with the sha256 above, and every green re-run passed (`arm_log.txt`). What actually renders: `ssr.cjs` (Vue `renderToString` with #7's own `vue`) renders all three of O2a, O2b and O3 as `<input type="number" data-testid="ghost">`.

## Q4. Accessibility and step

`inputmode` is correct per currency: JPY `numeric`, EUR and BHD `decimal`, quantity and units `numeric` (probed, plus X5). `step` was #7's id 97 (commit `1823f11`: "each money input's step follows it (a fixed 0.01 step would block a BHD amount through native form validation)"). It existed only so that native validation would allow the currency's precision. With no native number validation, nothing that needed it remains. `grep -rn 'step=\|inputmode\|type="number"' specs/` finds no spec requirement. The exponent is still the only thing that drives parsing: `amountProblem` → `decimalStringToMinorUnits` → `currencyExponent`, probed with BHD `1.005` → 1005, BHD `1.0005` refused and JPY `19.5` refused, and armed by R3. `currencyInputStep` is now unused by any page; it is still exported and tested in `money.spec.ts`. That is harmless. A5 covers the accessibility advisory.

## Q5. Gates

All green, as listed above. The count reconciles: 148/18 before, plus 107/6, gives 255/24.

## Q6. Bounds

`git status --short`, run at the start and the end: the 4 modified files (`billing/index.vue`, `currency-exponent.spec.ts`, `orders/place.vue`, `stock/index.vue`), the 7 new files (`lib/number-input{,.spec}.ts`, `number-inputs.population.spec.ts`, `billing/payment-amount.spec.ts`, `orders/place.{number,amount}-inputs.spec.ts`, `stock/replenish-units.spec.ts`), and `progress/impl_web_number_inputs.md`. Nothing in `specs/`, `packages/`, the services, `feature_list.json` or `progress/history.md`. **Bounds held.**

## Blocking findings

**B1. The population guard does not fail when armed with three number boxes it claims to cover.** `apps/web/app/number-inputs.population.spec.ts:46-80`. The claim (implementer brief, guard 2): "every number-like input under `apps/web/app` is in a literal expected set". Record defeat row 11: "P5 … and the number-field-component sentinel are caught … the inner `<input>` would be found at its own definition".

Reproductions (each added to `pages/stock/index.vue`; `vitest run app/number-inputs.population.spec.ts -t 'the found set equals'` stays green; each renders `<input type="number">`, shown by `ssr.cjs`):
- **O3:** `<input type=number data-testid="ghost" />`. This is a plain `<input>` tag, inside the guard's declared unit. `isNumberLike` requires a quoted value (`/\btype\s*=\s*["']number["']/`, line 74), and `eslint` does not reject the unquoted form.
- **O2a:** `<component is="input" type="number" … />`. Tag candidates are only `input`, `Input` and number-ish names (line 66), so `component` is never examined.
- **O2b:** a render-function component (`h('input', { type: 'number' })`) in `<script setup>`. Only the `<template>` of `.vue` files is scanned, so row 11's "found at its own definition" holds only for SFC-template components. (Row 6 discloses "an input built in a script string", which arguably covers this form, but row 11's claim contradicts it.)

Under the stopping rule this is blocking ("a claimed guard that does not fail when armed").

## Advisories

- **A1 (record accuracy; fix in the same round).** The step-1 table classifies unit price and line discount as **SAFE**, and "Surprises" says the #9 failure mode "does not happen in #7". That is false for exponent text. In Chromium, `type="number" min=0 step=0.01` holds `"1e3"` (and `"1e-2"`) as `valid:true`, and the form submits (`probe/native.mjs`: `price "1e3" {"value":"1e3","valid":true,"badInput":false} form submitted: true`). HEAD then runs `decimalStringToMinorUnits("1e3")` → `undefined` → `unitPrice` or `lineDiscount` omitted (`git show HEAD:apps/web/app/pages/orders/place.vue` lines 216-222). The result was an order at the catalogue price, or with no discount, and no error shown. HEAD's billing returned silently on the same text. Round 1 closes it (probed: `1e3` is refused in all three money boxes), but the record and the history entry must say the inherited #9 finding **recurred in #7** (exponent form) and was fixed by Round 1. Do not report it as avoided.
- **A2.** The test fixtures lack the exact string that defeated HEAD. Add `1e3` (and `1e-2`) to `MALFORMED_AMOUNTS` in `place.amount-inputs.spec.ts` and `payment-amount.spec.ts`, and to `number-input.spec.ts`. `12e` is malformed even to the browser, so it does not represent this class.
- **A3.** Payment amount and units with an empty box: the button is disabled and no words are shown (`billing/index.vue:404`, `stock/index.vue:271`). This is unchanged from HEAD, and nothing is sent. The implemented "is required" sentence is unreachable through the UI. Recommendation: drop `!paymentForm.amountInput` / `!unitsInput` from `:disabled` so the refusal is said in words, or accept this as pre-existing.
- **A4.** `90071992547409.92` (above MAX_SAFE minor units) is refused with "must be digits with up to 2 decimals", but the real reason is its size. Recommendation: return a distinct "too large" sentence when the shape is valid but the value is not a safe integer.
- **A5.** `aria-invalid` is set on the billing and stock boxes but not on the three `place.vue` boxes, and no box is linked to its problem text through `aria-describedby`. Recommendation: make this uniform.
- **A6.** The test title overclaims: `place.amount-inputs.spec.ts`, the BHD test, says "refused in EUR (2), "19.5" is refused in JPY (0)" but asserts only BHD 1005 and `inputmode`. JPY is covered by the next test. Fix the title or add the EUR assertion.
- **A7.** The record's arm A1 names a line (`if (quantityProblems.value.length > 0) return;`) that Round 1 replaced. I re-armed it on the current line as X1 (it fails as claimed). Update the record so the arm can be re-run.
- **A8.** The behaviour change is not recorded: `1e3` in quantity or units was sent as 1000 at HEAD and is now refused in words. This is deliberate and correct, but the record should state it as a change.
- **A9.** The running total is inconsistent: a malformed unit price falls back to the catalogue price in the displayed estimate (`place.vue` `runningTotal`), while a malformed quantity counts as 0. This is display only, because the submit refuses. Recommendation: count a refused amount as unknown, or say "estimate" in the UI.

## What must change before re-review

1. B1: make the population guard see O2a and O3, each with a sentinel that must fail. For example, accept unquoted and single-quoted `type` values, and treat `<component …>` with a static or dynamic `is` as a candidate. Then either extend it to script-built inputs (`h('input'` / `createElementVNode`) or narrow the claim in the spec header and in record rows 6 and 11, naming render-function components as not covered. Better, add a behavioural complement: each of the 3 page specs asserts `container.querySelectorAll('input[type="number"]').length === 0` on the rendered page, which catches every form on rendered pages ("test the behaviour, or inspect what actually runs"). Re-arm O2a and O3 (and O2b if it is claimed), and record the verbatim failures.
2. A1, A2 and A7 in the same round. These are record and fixture changes and do not need a second review pass of their own.
3. Re-run the web tests and `lint`, and reconcile the count.

## Effort

Reviewer: about 15 minutes of wall-clock (16:20 to 16:35, from file mtimes and `date`), one session. Packages installed: none.

## Re-review (round 2)

**Verdict: REJECTED** (1 blocking finding, about one guard premise; the 9 advisories A1 to A9 are all met; 3 new advisories). This is the second rejection, so under the coordinator's brief it goes to the maintainer. **The product behaviour is correct:** across all 89 probe rows, no malformed text was sent and no valid text was sent as a different number. The blocking item is a premise of the new population guard, and it is a one-line fix (see "What must change").

Scope: B1 and A1 to A9 as recorded in `impl_web_number_inputs.md` "Round 2 — after the first review" and in `brief_impl_web7_number_inputs_round2.md`. Evidence is in `../order-to-cash-python/.arm/web7r/round2/` (`arm/`, `arm_log.txt`, `probe/`, `*.log`, `sha_before.txt`). My only writes in #7 were temporary: arm mutations restored by `cp` and checked with `cmp`, `app/pages/ghost.ts` created and then deleted, and `.output/` built and then removed. At the end, `sha256sum -c sha_before.txt` passed for all 6 files I mutated. `git status --short` is unchanged: the same 4 modified and 7 new files, plus the two progress records. `ss -ltnp` shows 3017 and 3018 free before and after, with my PIDs stopped by PID. `docker ps` shows only `otcpy-n8n`, as before. I never started the `otc` stack.

### The 93 vs 89 discrepancy: 89 is right, and 93 was my error

My round-1 review said the probe had "93 rows". That number was never counted. The round-1 artefacts hold **89**: `python3 -c "len(json.load(open('.arm/web7r/probe/probe.json')))"` gives 89, and `wc -l probe.out` gives 89. The script's own arithmetic gives the same: quantity 1+13, unit price 7+11 EUR plus 2 BHD plus 2 JPY, line discount 4+11 EUR plus 1 BHD plus 2 JPY, payment 7+11 EUR plus 2 JPY, units 1+13+1, so 14+22+18+20+15 = **89**. The implementer's figure is correct. They differ only because I wrote a number I had not counted. The implementer's `.arm/web7f/probe/probe.mjs` and `stub-gateway.mjs` are byte-identical to mine (`cmp`).

### Fresh probe (production build, Chromium, stub Gateway on 3018, web on 3017)

`nuxt build` exited 0 (`round2/build.log`). The probe script is unchanged; output is in `round2/probe/probe.{out,json}`, **89 rows**. I classified every row with a script against an independent expectation (Decimal arithmetic on the typed text, compared with the bytes received at the stub):
- **28 valid texts were sent, each with the exact value:** quantity 3, `" 3 "` → 3, 9007199254740991; unit price and discount 1999 / 29, BHD 1005, JPY 1999, `90071992547409.91` → 9007199254740991; discount `0` and empty omitted, as at HEAD; unit price empty omitted (catalogue price) and `0` → 0; payment 1999 / 29 / JPY 1999 / `0` → 0; units 7, `" 3 "` → 3, 9007199254740991.
- **61 refusals:** words naming the field, `sent=0`, and the box keeps the text. The first pass of my classifier counted 56 and flagged 5 Arabic-Indic rows as "valid but not sent", because Python's `\d` matches Unicode digits. Those 5 are correct refusals by the page, which uses JS `\d`, ASCII only. Corrected: 28 + 61 = 89, with 0 rows deviating.
- **Changed compared with my round-1 probe, 7 rows, all intended:** 5 "too large" sentences (A4), and the 2 empty-box rows for payment and units, which now read "… is required" with the button enabled (A3).

### Gates

| gate | result |
|---|---|
| web tests (`vitest run`, JSON per file) | **24 files, 284 passed**, 0 failed. Per file: number-input 37, population 18, payment-amount 15, place.amount-inputs 37, place.number-inputs 15, replenish-units 14, with the other 18 files unchanged from round 1 (148). 148 + 136 = 284, matching the record's +29 |
| `pnpm run lint` | exit 0, no warnings |
| `pnpm run typecheck` | exit 0 |
| `nuxt build` | exit 0 |
| root `pnpm run quality` | exit 0; web 284, orders 544, billing 164, gateway 141, projector 186, seed 149, notifications 121, fulfillment 92, shared-kernel 89, contracts 22 |

Not run: the e2e suite (needs the `otc` stack). The round-1 judgement stands: none of its locators depend on the old box type.

### B1: the round-1 reproductions now fail by name (backups in `round2/arm/`, protocol as in round 1)

| arm | mutation (in `pages/stock/index.vue`) | result | sha256 (backup = restored) |
|---|---|---|---|
| O3 | `<input type=number data-testid="ghost" />` | `AssertionError: type="number" or spinbutton boxes in the rendered DOM: expected 'ghost' to be ''` | `ff2c7287…4881` |
| O2a | `<component is="input" type="number" …>` | same, naming `ghost` | same |
| O2b | `h('input', { type: 'number' })` in a render-function component | same, naming `ghost` | same |

**B1 as filed in round 1 is closed.**

### New attempts against the render-based instrument

| arm | mutation | result | classification |
|---|---|---|---|
| **N3** (a page the glob misses) | new `app/pages/ghost.ts` (a `defineComponent` render page with `<input type="number">`) | **P1 green** (`-t 'P1'`: `Tests 1 passed`). `nuxt build` with the file present emitted a page chunk `.output/server/chunks/build/ghost-B1ZN2iv7.mjs`, so Nuxt routes it. File deleted; a rebuild has no ghost chunk | **blocking (R2-B1)**: premise P1 ("every page file under app/pages is classified") does not fail when armed |
| **N1** (a user-visible box outside any page) | `<input type="number" data-testid="ghost" />` in `app/layouts/default.vue`, which renders around every page | **green** (`14 passed`) | advisory R2-A1: the brief scoped the instrument to `app/pages/**`, so this is not a claim the guard makes. But the record's "What it gave up: an input in a component that no page mounts (never user-visible)" is false, because a layout box is user-visible on every page. The round-1 source scanner (every `.vue` under `app/`) caught this form |
| **N2** (a box behind an interaction the guard does not perform) | a button plus `<input v-if="ghostOpen" type="number">` on the stock page | **green** (`14 passed`) | advisory, inside stated limit P5 |

**Judgement on P5** ("only states the drivers reach are seen"): the spec header states it honestly, and no render-based guard can avoid some limit of this kind. Removing the source scanner, though, widened the uncovered area. A literal `type="number"` in any state the drivers do not reach (a dialog, a second line, the catalogue-loaded order page, a layout, an error state) was caught in round 1 and is not caught now. The record presents the trade-off as costing only components that no page mounts. That understates it (R2-A1).

### A1 to A9: each item met or not

| item | status | evidence |
|---|---|---|
| A1 | **met** | record lines 38, 41, 51 and 146: corrected to "RECURRED in #7, in its exponent form, closed by Round 1", quoting my `native.mjs` line |
| A2 | **met** | `1e3` and `1e-2` are in all 5 fixture lists (grep); my arm A2 (`wholeNumberProblem` accepts `\d+(e-?\d+)?`) fails with `refuses "1e3", naming the field…: expected undefined to be 'Units must be a whole number of 1 or …'` |
| A3 | **met** | `:disabled` no longer checks for empty text in either page; probe shows empty → "is required" with `dis=false`, `sent=0`. Arm A3B (condition re-added) fails with `expect(element).not.toBeDisabled()` |
| A4 | **met** | probe shows 5 "is too large" rows; arm A4 (branch deleted) fails with `expected undefined to be 'Amount is too large: "90071992547409.…'` |
| A5 | **met** | `aria-invalid` and `aria-describedby` on all 5 boxes, pointing at an element that exists whenever set. Arm A5 (billing `aria-describedby` removed) fails with `aria-describedby must name the problem element: expected null to be truthy` |
| A6 | **met** | the BHD title now claims only BHD; a separate EUR test asserts `up to 2 decimals` and no request. Its title also says "naming the field", but it does not assert the label; trivial, no action needed |
| A7 | **met** | record line 76 names the current line, and it is re-runnable (my round-1 X1 used the same mutation) |
| A8 | **met** | record line 238: "`1e3` as quantity or units used to be sent as 1000 … now refused in words" |
| A9 | **met** | `runningTotalKnown`; arm A9 (`computed(() => true)`) fails with `expected '€0.00' to be '—'` |

Every arm above printed `restored: cmp identical`, and its green re-run passed (`round2/arm_log.txt`).

### Blocking finding

**R2-B1. The population guard's premise P1 misses page files that are not `.vue`.** `app/number-inputs.population.spec.ts` defines `PAGE_MODULES = import.meta.glob('./pages/**/*.vue')`. Nuxt routes `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` page files too: its default `ignore` excludes only `**/*.{spec,test}.{js,cts,mts,ts,jsx,tsx}` (`@nuxt/schema` 4.5.2 `dist/index.mjs:507`), and the build above emitted a route chunk for `ghost.ts`. Reproduction: create `app/pages/ghost.ts` exporting `defineComponent({ render: () => h('div', [h('h1','Ghost'), h('input', { type: 'number' })]) })`, then run `vitest run app/number-inputs.population.spec.ts -t P1`. It stays green, and so does the whole file. Under the stopping rule this is blocking ("a claimed guard that does not fail when armed": the header and the record claim "every page file under `app/pages/**`").

### New advisories

- **R2-A1.** Correct the record's "What it gave up" to name what is really uncovered: layouts and `app.vue` (N1), and any state the drivers do not reach (N2 and P5). Recommendation: keep the round-1 source scanner as a cheap pre-check beside the render guard, over every `.vue` under `app/` with the quoted, unquoted and `<component is>` forms. It catches a literal number box in any state or layout, while the render guard catches the forms that defeat syntax. Alternatively, mount `layouts/default.vue` with a slot in the render guard.
- **R2-A2.** The trade-off table should list N2 as an armed example under P5, so the limit is shown by a demonstration and is not only asserted.
- **R2-A3 (my own record).** My round-1 "93 rows" was an uncounted number; this section corrects it to 89.

### What must change (if the maintainer chooses fix over accept)

1. R2-B1: widen the glob to Nuxt's page extensions, excluding spec and test files, for example `import.meta.glob(['./pages/**/*.{vue,ts,tsx,js,jsx,mjs}', '!./pages/**/*.{spec,test}.*'])`. Add a sentinel or arm showing that a new `pages/ghost.ts` fails P1 by name. Re-run the population file.
2. R2-A1: correct the record (and preferably restore the scanner as a pre-check, re-arming O3 and N1 on it).

If the maintainer prefers **accept with disposition**: the money and quantity behaviour is verified on all 89 rows and armed. R2-B1 can be accepted as "ACCEPTED, NOT FIXED" with this re-open trigger: any non-`.vue` file is added under `apps/web/app/pages/` (`find apps/web/app/pages -type f ! -name '*.vue' ! -name '*.spec.ts'` must stay empty; today it returns nothing).

Reviewer effort, round 2: about 25 minutes of wall-clock, one session. Packages installed: none.
