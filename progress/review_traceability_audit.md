# Traceability audit — `specs/shared/test-matrix.md` (Phase 25, feature 38 `final_checkpoint`)

**This is an audit, not a feature review.** No APPROVE/REJECT, no `feature_list.json` change; feature 38 stays `pending`. Nothing was patched.

**Bottom line.** The matrix is in far better shape than its own summary table says (60 rows fully green, not 47), every one of its 147 unmarked verbatim citations resolves character-exact against a real file, and the substance of the rows I opened is genuine. But the repository **cannot yet honestly claim "every `R1`–`R63` is traced to a green test"**: one row (`R1`'s API half) has no test anywhere, two rows (`R55` web half, `R56`) have real green tests that are simply not cited, six rows name no case at all, and the C7 stack-agnosticism box is currently false because `test-matrix.md`'s Status column is saturated with `#7` specifics.

---

## Method — what I actually ran, and what I did not

I derived every number below myself; I trusted no figure in the brief and no figure in the matrix.

- Parsed all 63 rows mechanically (row count, id uniqueness/contiguity, column count, status text) rather than reading the summary table.
- Re-implemented the citation checker independently in Python (not by calling the repo's own guard) and ran it over every `›`-anchored citation: **147 unmarked verbatim citations, 0 mismatches; 9 `~`-marked précis, all 9 read by hand and judged fair.**
- Checked all **101** distinct `apps/**` / `packages/**` backtick paths in the document for existence on disk: **0 missing.** (The "144 missing test files" of the earlier hand-rolled pass was a matcher artefact; nothing is missing.)
- Cross-checked `specs/shared/requirements.md`: **63 EARS statements `R1`–`R63`, no gaps, no duplicates**, exactly matching the 63 rows. Traceability rule 1 holds — no requirement lacks a row.
- Ran, targeted (I did **not** run `pnpm quality`, and did **not** re-run the container-backed suites the implementers already ran):
  - `apps/orders/src/test-matrix-guard.spec.ts` — **6 passed**, including its own armed self-tests.
  - `packages/shared-kernel` `money`/`quantity`/`gln`/`event-envelope` specs — **43 passed** (`R1` domain half, `R2`, `R3`, `R4`, `R11`).
  - `apps/orders` `order`/`order-totals`/`order-state-machine`/`order-cancellation`/`saga-steps` specs — **245 passed** (`R5`–`R10`, `R21`, `R23`, `R25`, `R26`–`R28` unit halves).
- For container-backed rows I read the test bodies and, where greenness was the claim under test, the prior reviewer's own armed-mutation record (e.g. `progress/review_saga_e2e_verification.md` Probe 2). Greenness of the integration/e2e estate is therefore **inherited evidence, not re-observed today** — stated so it is not mistaken for verification.
- `apps/web`'s suite was deliberately not run (the brief's environmental note: it times out with the container stack up). The `R55` web-half test named below is therefore **verified to exist and to assert the right thing by reading, not by running**.

---

## 1. The real coverage state — 60 / 2 / 1, not 60 / 3

Counting a row "green" only when **every half** of it is `DONE` (which is how the summary table's own per-group numbers behave):

| Class | Count | Rows |
|---|---:|---|
| Fully green | **60** | everything not listed below |
| Partly green (one half `DONE`, one half `TODO`) | **2** | `R1` (domain unit **DONE**, API `TODO`), `R55` (projector + gateway halves **DONE**, web half `TODO`) |
| Wholly `TODO` | **1** | `R56` |

So the brief's "60 covered / 3 TODO" is right in totals and slightly wrong in kind: only `R56` is a bare `TODO`. `R1` and `R55` are **split rows with a green half already banked**, which matters because it changes what Phase 25 owes on each.

---

## 2. Does every covered row's citation resolve?

Two different columns carry citations, and they behave differently — this is the single most important thing to understand before counting.

- **Column 4 ("Test file › case")** is the **stack-neutral sketch** written at spec time: logical paths like `orders/integration/saga-happy-path.spec` that deliberately do not exist on disk, with case names that were *predicted*, not observed. Of its 78 quoted case names, **38 were realised verbatim somewhere in the repo and 40 were not**. That is by design and is not, by itself, rot.
- **Column 5 (Status)** is `#7`'s realisation: real repo-relative paths and real case names. This is the column that must resolve, and the column the repo's own guard checks.

**Result: 53 rows RESOLVE cleanly. 6 are AMBIGUOUS. 4 are split/`TODO` cases handled in §5. 0 are UNRESOLVABLE in the sense of "nothing corresponds".** Every row not listed in the table below resolves: its Status column names a real file **and** at least one case name found byte-exact inside it.

| Row | Resolution | Detail |
|---|---|---|
| `R20` | **AMBIGUOUS** | Status is only "DONE — same test as R19". The row's own quoted case (*moves placed to stock_reserved and issues credit.hold for the order total*) exists nowhere. Substance is genuinely covered — by `R19`'s single combined case, and by an **uncited** unit proof, `apps/orders/src/application/saga-steps.spec.ts:165` › `stock.reserved.v1 — advances to stock_reserved, owes credit.hold`. Traceability defect, not a coverage defect. |
| `R22` | **AMBIGUOUS** | Same shape. Uncited unit proof at `apps/orders/src/application/saga-steps.spec.ts:311` › `order.despatched.v1 — advances to despatched, owes invoice.issue`. |
| `R57` | **AMBIGUOUS** | Status names 3 real files but **no case at all**. The only quoted case name is the sketch's, which exists nowhere. The real cases are substantive — `apps/orders/src/infrastructure/messaging/trace-context-propagation.integration.spec.ts:85/122/199`. |
| `R58` | **AMBIGUOUS** | Status names 7 real files, **no case citation anywhere in the row** (a ~4 500-character prose cell). Real cases: `apps/orders/src/infrastructure/observability/log-correlation.integration.spec.ts:109/206` plus four `*-log-trace-id.spec.ts` files. See also the substance finding in §3. |
| `R59` | **AMBIGUOUS** | Status names 2 real files, no case citation. Real cases: `apps/orders/src/infrastructure/observability/metrics-exposure.integration.spec.ts:74/118/174/203`. |
| `R60` | **AMBIGUOUS** | Status names 5 real files, no case citation. Real cases: the per-service `health-probes.integration.spec.ts` files. |

Three further rows resolve but with a caveat worth recording:

- `R23` — **RESOLVES**, but via `` `saga-steps.spec.ts` `` written as a bare filename rather than a repo-relative path. The describe exists (`apps/orders/src/application/saga-steps.spec.ts:323` › `invoice.issued.v1 — R23: advances to invoiced, owes nothing (waits for the outside world)`), but the guard's path anchor cannot see it, so this citation is unprotected.
- `R63` — **RESOLVES**, and unusually well: all three quoted case names are character-exact `it()` titles in `apps/gateway/src/auth-rate-limit.integration.spec.ts` (lines 63, 83, 138). But the file is named in a **paragraph below the table**, not in the row's Status cell, so the row itself carries zero path anchors and the guard checks nothing for `R63`.
- `R54` — **RESOLVES** on substituted evidence. The row states plainly that its own sketched gateway-half test ("disconnect the write model and prove queries still answer") *never existed*, and cites structural substitutes instead. Honest, and the substitutes verify; but the sketch column still advertises a case name that corresponds to nothing.

**Guard blind spots, measured.** `apps/orders/src/test-matrix-guard.spec.ts` is green and non-vacuous (its own armed self-tests fire), but it protects only citations shaped `` `real/path.spec.ts` › quote ``. **Nine rows** — `R20`, `R22`, `R23`, `R56`, `R57`, `R58`, `R59`, `R60`, `R63` — have **zero** guarded citations. That is exactly the population where drift is now possible without a red build, and it is exactly the population §2 found problems in.

---

## 3. Is any "covered" row covered in name only?

Eight rows spot-checked across seven feature groups by opening the cited test and reading the assertions.

| Row | Group | Verdict |
|---|---|---|
| `R6` | `orders_aggregate` | **Genuine.** `apps/orders/src/domain/order-totals.spec.ts:63` computes totals from the bare function, then drives `addLine`/`changeLineQuantity`/`removeLine` on the real aggregate asserting recomputation at each step, then proves a negative-total mutation throws **and leaves total and line count unchanged**. Pure domain, no framework. |
| `R25` | `order_saga_orchestrator` | **Genuine, with one clause uncited.** `apps/orders/src/saga-preconditions.integration.spec.ts:92` redelivers all ten consumed fact types against a completed order over real Kafka/MySQL and asserts status unchanged, outbox row count unchanged, zero release commands, ten `precondition_unmet` rows. It does **not** assert the *recorded observed and expected status* values that `R25`'s own wording names — that clause is proven, uncited, at `apps/orders/src/application/saga-fact-handler.spec.ts:214`. |
| `R34` | `fulfillment_stock` | **Genuine.** `apps/fulfillment/src/stock-release-idempotency.integration.spec.ts:75` reserves, releases (asserting exactly one published fact), releases again over real NATS, and asserts `already_released` with an empty list **and zero outbox rows for the second correlationId**. |
| `R44` | `billing_credit` | **Genuine and unusually strong.** `apps/billing/src/credit-rejection-parity.integration.spec.ts:97` compares the over-limit rejection's payload key set against the **observed** key set of the simulated rejection (not a hard-coded array), so a shape divergence fails. |
| `R52` | `projector_read_model` | **Genuine.** `apps/projector/src/out-of-order-facts.integration.spec.ts` delivers `order.despatched.v1` before `order.placed.v1` over real Kafka into real MongoDB and asserts the status does not regress and the header still fills. |
| `R59` | `observability_reliability` | **Genuine.** `metrics-exposure.integration.spec.ts` asserts **exact** values, not "greater than zero": outbox lag exactly `300000` then exactly `0`; DLQ depth exactly `0` then exactly `3` from a real broker admin query; saga completion exactly `closingOccurredAt − orderDate`. (`otc_fact_processing_latency_ms` is the one instrument asserted only as `count ≥ 1` with a bounded sum — weaker, but matching the row's own narrower claim.) |
| `R63` | gateway edge protection | **Genuine.** `auth-rate-limit.integration.spec.ts:83` asserts every `Problem` field including `title`/`detail`/`type`, asserts `Retry-After` matches `/^\d+$/` (so the HTTP-date form the contract excludes fails), and asserts no token. The credentials-independence case then submits the **correct** password after tripping and requires the same 429. |
| `R58` | `observability_reliability` | **COVERED IN NAME ONLY, partially — the one real substance finding of this audit.** The row is flipped **DONE** for a requirement worded "**every** log line carries `correlationId` and the trace identifier", but the guarantee holds only for `apps/orders` and `apps/gateway`. Production JSON-shaped log call sites that carry **no `traceId` at all** exist and are untested: `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts:138`, `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts:133` (carries `orderId` only), `apps/notifications/src/presentation/notification-facts.controller.ts:146` (carries `topic` + `error` only — neither `correlationId` nor `traceId`), and `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts`. Neither service owns an `activeTraceId()` helper (grep: it exists only under `apps/orders` and `apps/gateway`). The row discloses **one** of these (the `fact-retry-dispatcher` parity exception); the other three call sites are disclosed nowhere. `apps/fulfillment`/`apps/billing`'s relay loggers **do** carry both ids, so this is not a four-service hole — it is a two-service hole plus an over-broad `DONE`. Why it matters: `R58` is one of the five rows the matrix's own "One trace and honest health across both brokers" demonstration rests on. |

No row was found where the cited test merely touches the area without exercising the requirement.

---

## 4. The summary table disagrees with its own rows — confirmed, four groups wrong

The per-group table at lines 81–92 is stale. Correct figures, derived by classifying all 63 row statuses:

| Feature | Rows | Table claims | **Correct** | Delta |
|---|---:|---:|---:|---:|
| 1. `orders_aggregate` (R1–R10) | 10 | 9 | **9** | ✓ |
| 2. `outbox_and_idempotency` (R11–R18) | 8 | 7 | **8** | **+1** |
| 3. `order_saga_orchestrator` (R19–R29) | 11 | 9 | **11** | **+2** |
| 4. `fulfillment_stock` (R30–R36, R61) | 8 | 8 | **8** | ✓ |
| 5. `billing_credit` (R37–R44) | 8 | 5 | **8** | **+3** |
| 6. `billing_invoicing` (R45–R49) | 5 | 5 | **5** | ✓ |
| 7. `projector_read_model` (R50–R55) | 6 | 5 | **5** | ✓ |
| 8. `observability_reliability` (R56–R60, R62) | 6 | 1 | **5** | **+4** |
| 8.1 gateway edge protection (R63) | 1 | 1 | **1** | ✓ |
| **Total** | **63** | **47** | **60** | **+13** |

Four groups are wrong, `observability_reliability` worst (1 → 5) — the brief's expectation is confirmed exactly. The table under-reports the repository's own work by 13 rows.

---

## 5. The three `TODO` rows — MISSING TEST vs UNFILLED ROW

### `R1` API half — **MISSING TEST**

The sketch cites `api/money-representation.spec` › *every monetary field of every response is an integer accompanied by a currency code*. Nothing in the repo makes that claim. There is no schema-validating harness at all (no `ajv`, no response-against-`openapi.yaml` validator anywhere in `apps/` or `packages/`). The nearest evidence is incidental and per-field: `apps/gateway/src/black-box-api.integration.spec.ts:489/497` (`expect(placed.totalAmount).toBe(49_998)`), `apps/gateway/src/domain/projection/order-read-model-mapper.spec.ts:59`. Those prove *these* amounts are integer minor units in *these* responses; they do not make `R1`'s universal claim. **This is the only one of the three that needs new test code.** It is cheap: one black-box sweep over the Gateway's money-bearing responses (`/orders`, `/orders/{id}`, `/invoices`, `/credits`) asserting `Number.isInteger(amount)` and a present ISO-4217 `currency` for every monetary field found.

### `R55` web half — **UNFILLED ROW**

The test exists, is named for the requirement, and asserts the right thing: `apps/web/app/pages/orders/[id].spec.ts:104` › `R55 — renders the honest "waiting for projection" state for a 202/ProjectionPending answer, not a spinner or a 404`. The "fills in from the update stream" clause is carried by sibling cases in the same file (`a live order.updated frame updates the rendered status badge`, `resumed:false re-fetches the order detail instead of silently keeping stale data on screen`, and the `R51` live-frame case). **Caveat to state when the row is filled:** no single case walks *pending → filled by an update frame*; the two halves of the sketch's sentence are proven by two different cases. Greenness read, not run (see Method).

### `R56` — **UNFILLED ROW** (with a genuinely narrower scope than `R56`'s own wording)

An automated test exists, is explicitly labelled `R56`, and was independently armed by the previous reviewer: `apps/gateway/src/saga-e2e-verification.integration.spec.ts:890` › `criterion 5 (R56) — one trace identifier spans a real order across the composed stack: every Orders saga-command dispatch AND the real trace_parent Fulfillment and Billing each independently recorded on their OWN write-model transaction, all identical, across three real separate processes`. It spawns real Orders/Fulfillment/Billing/Projector processes against Testcontainers Kafka/NATS/MySQL/MongoDB, reads Orders' own structured stdout and Fulfillment's and Billing's own `outbox.trace_parent` columns over raw SQL, and asserts the **set of distinct trace ids has exactly one member**. `progress/review_saga_e2e_verification.md` §"Probe 2" records the reviewer re-arming it (`traceParent = null` in Fulfillment's `outbox-recorder.ts` → `AssertionError: fulfillment (stock.reserved.v1 outbox): expected a real 32-hex traceId, got null`) and restoring it. So: **automated, armed, and green as of feature 28 — not manual observation.** The 22-span six-service trace observed live today is corroboration, not the evidence.

What the existing test does **not** cover, per the spec file's own header and the previous reviewer's independent confirmation: **no Gateway process is in the fleet** (orders are placed by a raw NATS call, so the "inbound request" leg of `R56` is out of scope by construction), **the Projector is excluded** (it owns no outbox and logs nothing on a healthy consume), and nothing asserts a span on **fact consumption** specifically. Filling the row honestly therefore means citing this case **with those three exclusions stated in the cell** — or doing new work to close them. Citing it as a clean `R56` would be the same over-broad flip §3 found in `R58`.

---

## 6. Stack-agnosticism of `specs/shared/` — C7's first box is currently **`[ ]`**

`CHECKPOINTS.md` C7: *"`specs/shared/` contains no NestJS, Drizzle, Nuxt or MySQL specifics — assessment #8 can start from it unchanged."*

**Six of the seven files are clean.** `requirements.md`, `domain-model.md`, `saga.md`, `n8n-workflows.md`, `openapi.yaml` and `asyncapi.yaml` contain **zero** occurrences of NestJS, Nest, Drizzle, Nuxt, Vue, MySQL, MongoDB, TypeScript, pnpm, npm, Vitest, Jest, Testcontainers, supertest, Playwright, kafkajs or `.ts`. (The only apparent hits are false positives on the substring "nest" inside "hon**est**ly", plus two `docker compose` mentions in `n8n-workflows.md:87` and `openapi.yaml:72` — deployment vocabulary shared by all three assessments, not a stack leak. `requirements.md:540` mentions `#7` by name, but only to narrate why `R63` exists, with the requirement itself stack-neutral. Legitimate mentions, not leaks.)

**All the leakage is in `test-matrix.md`,** and it is heavy. Token counts in that one file: `MongoDB` 16, `MySQL` 14, `mysql` 13, `apache/kafka` 8, `nats:` 7, `mysql2` 6, `drizzle-orm` 4, `mongodb` 3, `pnpm` 2, `package.json` 2, `Drizzle` 2, `vitest` 1, `supertest` 1, `NestJS` 1, `kafkajs` 1 — plus **101 distinct `apps/**`/`packages/**` `.spec.ts` paths** and **30** `Testcontainers` mentions. `Nuxt` is the one C7-named term with zero hits.

Two distinct kinds, and they need different fixes:

1. **Status column (lines 116–214) — expected, but undeclared.** Every C7-forbidden term sits inside a row's Status cell, i.e. inside `#7`'s own realisation record. Per the document's own rule 2 each assessment fills its own Status, so this is arguably *not* a leak in the reusable part — **but the document never says so**, and its Scope paragraph claims it is "reused **verbatim** by assessments **#7**, **#8** and **#9**", which is now false: `#8` cannot take this file verbatim, it must gut column 5 first. Either the Scope wording or the file's structure has to change.
2. **Normative prose — a genuine leak.** Lines 61–77 (the verbatim/précis convention, which is a *rule* binding all three assessments) hard-code `` `apps/**.spec.ts` ``, name the TypeScript artefact `` `apps/orders/src/test-matrix-guard.spec.ts` `` as the mechanism, and specify a normalisation rule in terms of **"adjacent `'...' + '...'`-style JS string-literal concatenation"** — a JavaScript source-syntax detail meaningless to `#8` (.NET) and `#9` (FastAPI). Line 200 (`R56`'s ratified-deferral note, also normative-shared) says "Testcontainers". Line 226 is `#7`-specific but is explicitly labelled "**#7 evidence**", which is the honest pattern the rest of the file should follow.

---

## 7. Further defects found while auditing (none blocking, all real)

- **Stale prose in `R40`, `R41`, `R46`.** All three carry a parenthetical that is no longer true: `R40` — "`consumeHold` has no caller until feature 21"; `R41` — "`releaseHold` has no caller until features 22/25"; `R46` — "`markPaid` ships uncalled by any live path". Features 21 and 22 are `done`, and the callers exist: `apps/billing/src/application/invoice-issue.handler.ts:135`, `apps/billing/src/application/credit-release.handler.ts:52`, `apps/billing/src/application/payment-register.handler.ts:173` and `:199`. Worse, the rows therefore miss **stronger evidence that now exists** — e.g. `R40`'s live consume path is proven at integration level by `apps/billing/src/invoice-issue.integration.spec.ts:53` (asserts exactly one `consume` ledger entry of exactly the hold amount), which `R40` does not cite. Citation rot of exactly the kind rule 4 exists to prevent, on rows currently marked green.
- **The entire `apps/web` test estate is untraced.** `grep -c "apps/web" specs/shared/test-matrix.md` → **0**, yet 17 web spec files exist (15 component/composable, 2 Playwright e2e). Three rows sketch web/e2e levels. Concretely, `R28`'s sketched `e2e/compensation-path.spec` › *a .99 order reaches cancelled with the stock release and the cancellation shown separately in causal order* has a near-exact real realisation nobody cited: `apps/web/e2e/compensation.spec.ts:26` › `a .99 order is cancelled with credit_rejected, and the timeline shows both compensation steps in order with the causal link rendered`. `R24`'s happy path likewise has `apps/web/e2e/happy-path.spec.ts:17`.
- **Cosmetic:** the `R57` row (line 210) omits its closing `|`. GFM tolerates it and all 63 rows parse to exactly 5 columns, so this is not a rendering defect — noted only so it is not rediscovered.

---

## 8. What Phase 25 must still do before the checkpoint claim is honest

**Blocking — the claim "every `R<n>` is traced to a green test" (C6, line 51) is false until these land:**

1. **Write the one missing test:** `R1`'s API half — a black-box money-representation sweep through the Gateway. This is the only new test Phase 25 genuinely owes.
2. **Fill `R55`'s web half** by citing `apps/web/app/pages/orders/[id].spec.ts:104` and its sibling live-frame cases, noting that no single case walks pending → stream-filled.
3. **Fill `R56`** by citing `apps/gateway/src/saga-e2e-verification.integration.spec.ts:890` › `criterion 5 (R56) — …`, **with its three exclusions stated in the cell** (no Gateway/inbound-request leg, no Projector, no fact-consumption span). Do not flip it to a clean `DONE`.
4. **Correct `R58`** from an unqualified `DONE` to a scoped one naming the four uncovered production log call sites in `apps/projector` and `apps/notifications` — or close them. As written the row over-claims against its own requirement's word "every".

**Blocking for C7 (line 57):**

5. **Remove the stack leak from `test-matrix.md`'s normative prose** (lines 61–77 and 200): state the verbatim/précis convention without `apps/**.spec.ts`, without naming a `.spec.ts` guard file, and without JS string-literal syntax; move the mechanism note into a `#7`-labelled aside like line 226's.
6. **Reconcile the Scope claim with the Status column** — either declare column 5 per-assessment (and drop "verbatim" for it), or move `#7`'s realisation into a `#7`-only companion file. As it stands, "reused verbatim by #8 and #9" is not true of this file.

**Non-blocking but should land in the same pass, since they are pure edits:**

7. **Give the six AMBIGUOUS rows a case citation** (`R20`, `R22`, `R57`, `R58`, `R59`, `R60`) in the guarded `` `real/path.spec.ts` › `describe` › *case* `` form; make `R23`'s bare `saga-steps.spec.ts` repo-relative; move `R63`'s file+cases from the paragraph into the row. This takes the guard's blind-spot population from 9 rows to 1 (`R56`, which §8.3 fixes).
8. **Correct the five wrong summary-table numbers** (groups 2, 3, 5, 8 and the total: 8, 11, 8, 5, **60**).
9. **Refresh the stale prose in `R40`, `R41`, `R46`** and cite the live-path integration evidence that now exists.
10. **Consider tightening the guard** to require at least one guarded citation per non-`TODO` row. That single assertion would have caught every §2 finding, and it is the cheapest permanent fix available.
