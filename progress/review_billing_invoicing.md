# `billing_invoicing` (id 21, phase 10) — review record

**Verdict: REJECTED.** 2 blocking findings, 5 non-blocking, 2 informational. No functional defect was found in the shipped behaviour; both blockers are one edit each and neither requires touching a source file's logic.

> This review deliberately did **not** re-run `pnpm quality` or the full billing integration suite — the implementer ran both minutes before submission and re-running them is duplicated cost. What was re-run: the two domain spec files (3 armed-deletion runs), `invoice.repository.integration.spec.ts` under a re-armed H10 (Testcontainers, 15.7 s), `billing-consumes-no-facts.spec.ts` under an injected `@EventPattern`, `invoice-issue.handler.spec.ts` under an inverted lock order, `saga-command-payloads.spec.ts` under a reverted `discount`, the whole billing **unit** suite after restore (25 files / 110 tests, green), and eleven read-only queries against the live `otc_billing`/`otc_orders` databases. Everything else below is code reading, traceability walking and live-state querying — not assumption.

---

## Probes run (10 of 10) — what was run, what was observed

### Probe 1 — the three armed deletions, re-armed independently

| Guard | What I armed | Result | Verdict |
|---|---|---|---|
| **H8** | `invoice.appendFact(event);` → `void event;` in `Invoice.issue` (`domain/invoice.ts:150`) | **3 failed / 16 passed.** `invoice-events.spec.ts:37` *expected undefined to be defined*; `invoice-events.spec.ts:52` and `invoice.spec.ts:71` *expected [] to have a length of 1 but got +0* | Genuine. Every failure is a **fact-count/fact-identity** assertion on `pullDomainEvents()` — not a snapshot, not an incidental count |
| **H9** | `this.appendFact(event);` → `void event;` in `Invoice.markPaid` (`domain/invoice.ts:295`) | **2 failed / 15 passed.** `invoice.spec.ts:110` (R46) and `invoice.spec.ts:232` (BI14), both *expected [] to have a length of 1 but got +0* | Genuine, and it is the double-force case: `markPaid` has no live caller, so this domain unit test is the only guard that exists — and it fires |
| **H10** | The **inverted** one. Re-armed `DrizzleBuyerCreditRepository.save` to insert one spurious `credit.consumed.v1` outbox row whenever the appended rows contain a `consume` — i.e. simulating R40's suppression regressing into an emission | **1 failed / 1 passed** against real MySQL. `invoice.repository.integration.spec.ts:128` — `AssertionError: expected 2 to be 1`, on `outboxCountAfterIssue - outboxCountBeforeIssue` | **Not vacuous.** The killing assertion is a whole-table, before/after **delta**, unfiltered by `aggregateId` or `eventType`. The two `aggregateId`-scoped assertions above it (l.119-121) both still passed under the regression — exactly as the implementer's record admits. The delta is what does the work, and it is real |

All three restored byte-exact (`md5sum` against pre-edit backups; `git diff` clean for the tracked file). Billing unit suite re-run after restore: **25 files / 110 tests green**.

**A structural mitigation the record does not claim, and should:** there is **no `credit.consumed.v1` builder at all** in `domain/credit-events.ts` — only `creditApprovedEvent`, `creditRejectedEvent`, `creditReleasedEvent`. R40's suppression is therefore protected twice: by BI7's delta *and* by the absence of anything to call. That strengthens the position rather than weakening it.

### Probe 2 — the `H4` caveat: honest limitation, or gap?

**Ruled: honest limitation.** The implementer's statement is exactly true. `H4/BI6` (`invoice-issue.integration.spec.ts:212-264`) drives four refusals — BI3 (no credit line), BI4 (currency), BI5 (no active hold), BI2 (malformed) — and refusal and consumption are mutually exclusive branches of the same handler (`invoice-issue.handler.ts:83-108` all `throw` before line 135's `consumeHold`). No arrangement of those four scenarios can reach the consume path. The task brief's wording ("confirm `BI7`/`H4` fail") was not realisable as written, and saying so plainly — rather than adding a decorative assertion to `H4` — is the correct call.

The compensating guard is real and I verified it fires (probe 1, H10). Residual, recorded as **N7** below, not as a gap: `H1`'s happy-path outbox assertion is `correlationId`-scoped, so the *responder-level* success path would not see a spurious consume fact either — only `BI7`'s repository-level delta would.

### Probe 3 — the two-aggregate transaction and the fixed lock order

Design §5.4/§5.6 is implemented as written. `invoice-issue.handler.ts`: step 0 fast path outside any transaction (l.74-77); then inside one `unitOfWork.execute` — `credits.lockForOrder` (l.82, first), `invoices.lockByOrderReference` (l.91, second), currency (l.99), `activeHold` (l.105), `invoiceNumbers.next(tx)` (l.111, last), domain, then both `save`s (l.138-139). `clock.now()` read once (l.113) and shared by invoice date, fact and ledger entry.

Rollback leaves neither: `invoice.repository.integration.spec.ts:141-163` forces a rollback after both `save` calls and asserts `invoices` = 0, `credit_items` of type `consume` = 0, and `invoice.issued.v1` outbox rows unchanged at 1 (the earlier order's).

**Would the race spec catch a lock-order inversion? No — and it cannot.** `invoice-issue-race.integration.spec.ts` runs ten rounds of two concurrent `invoice.issue` requests. Two instances of the *same* transaction taking locks in a *consistently* inverted order still deadlock-free; a cycle needs two transaction types. I confirmed empirically what does catch it: I moved `lockByOrderReference` above `lockForOrder` in the handler and ran the unit spec —

```
FAIL src/application/invoice-issue.handler.spec.ts:176
- "lockForOrder"
  "lockByOrderReference"
+ "lockForOrder"
```

So the ordered-call-log unit test at `invoice-issue.handler.spec.ts:175-176` is the sole guard, and it is a real one. What the race spec *does* prove is different and also valuable: `createdFlags` sorted equals `[false, true]` (l.78) and both replies name the same reference (l.80) — a genuine double-invoice would fail this, not merely pass silently. Recorded as **N5** so the claim is not overread, and as **N4** because the log covers only two of BI8's three declared locks.

### Probe 4 — responder idempotency, and whether a constraint (not just a read) enforces it

Three layers, all present:

1. **Fast path** — `findByOrderReference` outside any transaction (`invoice-issue.handler.ts:74`).
2. **Authority** — `lockByOrderReference` (`FOR UPDATE`) taken *after* the `credits` lock has serialised every competitor (l.91), so the read-then-write window a concurrent retry could straddle is closed by the `credits` lock, not by luck.
3. **Constraint** — `uq_invoices_order_reference`. Verified in three places: the migration SQL (`drizzle/0002_…sql`, `ALTER TABLE invoices ADD CONSTRAINT uq_invoices_order_reference UNIQUE(order_reference)`), a fresh-container assertion (`migrations.integration.spec.ts`, `non_unique = 0` on `order_reference`), and **the live database**, which I queried directly:

```
index_name                        non_unique  columns
uq_invoices_order_reference       0           order_reference
idx_invoices_status_invoice_date  1           status,invoice_date
```

Behaviour: `invoice-issue.integration.spec.ts:266-330` (H5/BI9) asserts the repeat returns `created: false` with the **existing** reference, `invoicesOf` = 1, `ledgerOf` = **2** (hold + consume — no second consume), and `outboxRowsFor(repeatCorrelationId)` = **0**. The `paid` variant is covered separately (l.300-329). Under concurrency the race spec adds `rowsA.length + rowsB.length === 1`.

Independently confirmed on live data: `SELECT order_reference, COUNT(*) … HAVING COUNT(*) > 1` on `otc_billing.invoices` returns **no rows**, and every one of the eight invoiced orders has exactly **one `hold` and one `consume`**.

### Probe 5 — row 2, `NO_ACTIVE_HOLD`

Emits no fact and returns the right code: `invoice-issue.integration.spec.ts:179-181` asserts `{ code: 'PRECONDITION_FAILED', details: { code: 'NO_ACTIVE_HOLD' } }`, `invoicesOf` = 0 and `outboxRowsFor(correlationId)` = 0. The outbox assertion is the one that fails if the branch starts emitting; it is repeated a second time inside `H4/BI6` (l.261). The branch itself throws at `invoice-issue.handler.ts:107`, before `consumeHold`, `Invoice.issue` and both `save`s.

**But "SHALL append no ledger entry" — the third clause of BI5 — is not asserted anywhere.** See **N3**. BI3 (l.127) and BI4 (l.153) both assert `ledgerOf(...)` is empty; BI5's order has two pre-seeded rows and the test never re-reads them, and the unit half (`invoice-issue.handler.spec.ts:125`) asserts `saveCalls` on the *invoice* repository only.

### Probe 6 — does `billing-consumes-no-facts.spec.ts` actually bind?

**Yes.** I injected `@EventPattern('order.despatched.v1', Transport.KAFKA)` into `InvoiceController` and ran it:

```
FAIL src/billing-consumes-no-facts.spec.ts:61
… invoice.controller.ts must not use @EventPattern(...) (BI1)
```

It is a **text scan** (regex over `apps/billing/src/**/*.ts`), and I am saying so because the brief asked. It is a well-built one — it matches the decorator's *invocation* shape so prose naming the decorator is not a false positive; it proves its own matcher non-vacuously against a fixture string (l.68-69); it pins `main.ts` to exactly one `connectMicroservice` naming `Transport.NATS` and forbids `Transport.KAFKA`; and it bans `from 'kafkajs'` everywhere except the one named producer file plus any `.consumer(` call. Its blind spots are `test-support/` and `*.spec.ts` (both deliberately excluded) — recorded as **N8**, informational.

### Probe 7 — group G, the `.99` fixture guard on **computed** totals

It asserts on the computed value, not on literals. Two independent places:

- `cents-rule-fixture-guard.spec.ts:13-17` — *the computed half bites*: `const computedTotal = 3 * 8_333; expect(computedTotal).toBe(24_999); expect(() => assertNotCentsRuleAmount(computedTotal, …)).toThrow(/cents rule/)`.
- The load-bearing binding, `billing-integration-harness.ts:293-295` — `issueRequest` reduces `Σ unitPrice × units`, subtracts the discount and calls `assertNotCentsRuleAmount(gross - discount, …)`. So a three-line invoicing fixture totalling `24_999` throws at fixture-build time regardless of what any literal says.

The text backstop is a genuine second half rather than the whole story: it is money-position-keyed (`<moneyKey>: <digits>`), comment-stripped before matching, scoped to `*.integration.spec.ts`, and it proves itself against a real temporary fixture directory (`__fixtures__/cents-rule-guard-non-vacuity`, asserted to report exactly one hit at `24_999`) rather than asserting emptiness vacuously. The one deliberate `.99` fixture in `credit-rejection-parity.integration.spec.ts` carries the inline `// cents-rule-intentional` opt-in on both lines.

### Probe 8 — group I / row 5: does BI21 tie gross − discount to the `credit.hold` amount?

**Yes, genuinely, and not by asserting `discount` is merely non-zero.** `saga-command-payloads.spec.ts` drives the real `PlaceOrderHandler` (l.89-96) with faked ports only, then at l.126-130:

```ts
const grossFromInvoiceLines = invoicePayload.lines.reduce((sum, line) => sum + line.unitPrice * line.units, 0);
const totalAmountFromInvoice = grossFromInvoiceLines - (invoicePayload.discount ?? 0);
expect(totalAmountFromInvoice).toBe(holdPayload.amount.amount);
expect(totalAmountFromInvoice).toBe(order.totalAmount.amount);
```

Both payloads are built from the **same** `Order` instance, so the comparison is meaningful. I reverted `discount: order.initialDiscount.amount` from `saga-command-payloads.ts` and both cases died (`expected undefined to be 300`, `expected undefined to be +0`). Restored byte-exact.

### Probe 9 — group A findings N1, N3, N5: fixed, or merely commented?

- **N3 — fixed in code.** `simulator-credit-decision.ts` now tests `/^(?:\d+|\d*\.\d+)$/` against the `trim()`ed value **before** `Number()` is called, throwing with the offending value quoted. `'0x1'`, `'1e0'`, `'+0.5'`, `'NaN'` and whitespace-only all fail the shape; `undefined` and `''` short-circuit to `0` *above* the check, so R43's default is preserved. This is a behaviour change, not a comment.
- **N1 — fixed in code.** `credit-rejection-parity.integration.spec.ts` replaces the hard-coded eight-element literal with `simulatedRejectionKeys`, assigned from `Object.keys(simulatedPayload).sort()` in the R42 case and read in the R44 case, guarded by `expect(simulatedRejectionKeys).toBeDefined()`. A key added on one path only now fails the test. It introduces inter-test state coupling — recorded as **N9**, informational.
- **N5 — comment-only, and correctly so.** The header no longer claims "for any harness that wants approve-everything behaviour"; it claims to be the port's reference implementation and the provider a future harness may bind, and cites §11.2's record that *this* feature considered being that harness and declined. The class, its binding and its spec are untouched — which is exactly what N5 asked for. `git diff` confirms no non-comment line changed in that file.

### Probe 10 — scope

Every file outside the brief's core is justified by a named task:

| File | Justified by |
|---|---|
| `test-support/credit-integration-harness.ts` → `billing-integration-harness.ts` (+ four consuming specs) | task **G3**, open point **12** — extend rather than fork, since the harness already boots the real `AppModule` which now contains the invoice providers |
| `simulator-credit-decision.ts` (+ spec) | task **A1/A2** (N3) |
| `always-approve-credit-decision.ts` | task **A3** (N5) |
| `credit-rejection-parity.integration.spec.ts` | task **A4** (N1) |
| `credit.controller.ts` (hoist `parseRpcMeta`/`missingHeadersRpcError` → `rpc-meta.ts`) | task **F1**, explicitly named, behaviour-neutral |
| `rpc-error-mapper.ts` (+ spec) | task **F4** — the four added cases of design §4.3 |
| `app.module.ts`, `domain/index.ts`, `schema/index.ts`, `invoices.schema.ts`, `migrations.integration.spec.ts` | tasks **F6**, **B2/B3/B4** |

**No scope creep.** `git status` confirms: `packages/` **untouched** (no `contracts` regeneration), `docs/` **untouched**, `specs/shared/` limited to `test-matrix.md`, `feature_list.json` limited to the one status flip. `apps/orders` is confined to exactly the two files §12 names.

One item worth naming so it is not mistaken for implementer creep: the `test-matrix.md` diff also carries the `R42`/`R43` **sketch-column** change (`billing/domain/…` → `billing/infrastructure/…`). That is the **spec pass's** edit — open point **9**, flagged for and given conscious approval at the gate — and it sits in the same uncommitted diff only because the spec pass post-dates `HEAD`. Correctly attributed and correctly approved.

---

## Traceability

### `BI1` – `BI22` → named tests

Walked all 22 rows of `requirements.md` §3 against the files on disk. **20 map to a named test that genuinely exercises the requirement.** `BI20` is `n/a — comment-only` by its own construction and verified by reading (correct). `BI22` maps to the live-boot section, verified independently below.

Two rows are **partially** discharged:

- **`BI2`** — the header half and the empty-`lines` half are tested (`invoice.controller.spec.ts`, `invoice-issue.integration.spec.ts:184-210`). The clause *"a discount that exceeds the computed amount"* is neither implemented as specified nor tested → **N2, blocking**.
- **`BI5`** — the reply, the no-invoice and the no-fact clauses are tested; *"SHALL append no ledger entry"* is not → **N3**.

### `R45` / `R46` in `specs/shared/test-matrix.md`

Both flipped `TODO` → `DONE`, names verbatim, each carrying the honest qualifier its spec required (`R45`'s repeat half is credited to the integration test; `R46` states `markPaid` ships uncalled). `R47`–`R49` correctly left `TODO`. Coverage summary updated to `billing_invoicing 5 rows, 2 green` and total `38`. **No other feature's row was touched** apart from the gate-approved `R42`/`R43` sketch-column edit belonging to the spec pass.

### Live-boot claim (`BI22`) — verified against the running databases, not read

| Claim in the record | My query result |
|---|---|
| Seven parked `invoice.issue` rows unparked | `otc_orders.saga_commands` where `command='invoice.issue'`: **8 rows, all `sent`** (the seven + the control order) |
| Those orders reach `invoiced` | `otc_orders.orders`: **8 `invoiced`**, 5 `completed`, 11 `cancelled` |
| One invoice per order | 13 invoice rows, `INV-000001`–`INV-000013`; duplicate-`order_reference` query returns **no rows**; `invoice_number_sequences.next_value = 14` |
| One `hold` + one `consume` per order, nothing else | Exactly `hold=1, consume=1` for each of the eight; **zero** rows of any other combination |
| `availableCredit` numerically unchanged (R40) | `CR-000124` (AldiDe/ALBIONFOODS): **350 606** — identical to J1. `CR-000001` (CarrefourEs/IBERFOODS): **200 012** — identical to the record's post-control-order figure |
| Negative half: no order past `invoiced`, no new saga row, no new payment/release fact | `saga_commands` = exactly **4 rows per order**, no fifth. `payment.received.v1` = **5**, `credit.released.v1` = **5** — both unchanged from the seed |
| `invoice.issued.v1` count | **13**, all with `published_at` set — five seeded + seven unparked + one control |

The live evidence is accurate and the R40-neutrality claim holds in production data. One numeric slip in the record: see **N6**.

---

## `CHECKPOINTS.md` — walked

**C1 — the harness is complete**
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist
- [x] `progress/current.md` and `progress/history.md` exist
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer
- [x] Every agent definition declares its model
- [x] `./init.sh` exits 0 (implementer's J8; not re-run — no diff reaches it)

**C2 — state is coherent**
- [x] At most one feature `in_progress` — currently `{done: 20, in_review: 1, pending: 18}`
- [x] Every status is in `rules.valid_status`
- [x] Every `done` feature has passing tests associated with it
- [x] `progress/current.md` describes the active session
- [x] No `blocked` features

**C3 — architecture is respected**
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside `apps/billing/src/domain/` — grepped, clean; `Invoice`/`InvoiceLine` import only `@otc/shared-kernel` and `@otc/contracts` types
- [x] No cross-service DB access — Billing references `orderReference`/`retailerCode`/`companyCode` as business identifiers; `invoices.schema.ts`'s header says so explicitly and no FK crosses a boundary
- [x] No shared runtime code beyond `shared-kernel` and `contracts`; `packages/` untouched this feature
- [x] `packages/shared-kernel` has zero runtime dependencies (`dependencies: {}`)
- [x] Every interaction classifiable — `billing.invoice.issue`/`billing.invoice.list` are **NATS-RPC** (`@MessagePattern(subject, Transport.NATS)`, both named), `invoice.issued.v1` is a **Kafka fact** via the outbox. `BI1`'s guard makes the absence of a Billing-side fact consumer structural, and probe 6 proves the guard binds
- [x] No stray debug logging; no context-free TODOs

**C4 — verification is real**
- [x] `pnpm quality` passes (implementer, 789 tests; not re-run wholesale by design — billing unit re-run after my mutations: 25 files / 110 tests green)
- [x] Domain tests are pure — `invoice.spec.ts` and `invoice-events.spec.ts` import only `vitest`, `@otc/shared-kernel` and the domain files
- [x] Integration tests use Testcontainers against real MySQL/Kafka/NATS — I ran one myself against `mysql:8.4.11` (15.7 s, real container)
- [x] Coverage thresholds met (domain 94.75 %, overall 97.16 % per the implementer's record; the diff is overwhelmingly new code with new tests and the unit suite is green)
- [x] No Jest anywhere — grepped, clean

**C5 — the session closed cleanly**
- [x] No suspicious untracked files — every untracked path is a named deliverable of this feature
- [ ] `progress/history.md` entry with effort record — **not applicable while rejected**; it is written at approval
- [x] `feature_list.json` reflects the true state (set back to `in_progress` by this review)
- [x] The human has been told what was done and how to test it manually (`impl_billing_invoicing.md` § Manual verification script)
- [x] Claude did not commit — `git log` head is still `dc11466`

**C6 — spec-driven development**
- [x] `specs/billing_invoicing/` has all three of `requirements.md`, `design.md`, `tasks.md`
- [x] `requirements.md` uses strict EARS, every requirement carrying a `BI<n>` id and deferring to the shared `R<n>`s
- [ ] **Every `done` sdd feature has all its tasks ticked `[x]` in `tasks.md` — FAILS. 0 of 60 boxes ticked → N1, blocking**
- [x] Every `R<n>` covered by a named test recorded in `specs/shared/test-matrix.md` (with the two partial rows at N2/N3)
- [x] The spec commit precedes the implementation commit — both are still uncommitted in one working tree, but the spec pass demonstrably preceded the implementation pass (`progress/spec_billing_invoicing.md`, `current.md`'s two ordered entries); the human's commit discipline is one commit per feature and the git history to date shows spec-first

**C7 — trilogy reusability**
- [x] `specs/shared/` contains no stack specifics — the only edit is `test-matrix.md`, and the `R42`/`R43` sketch-column change actively *improves* portability by not pointing #8/#9 at a domain-layer location for an infrastructure adapter's test
- [x] `n8n/workflows/` untouched
- [ ] `progress/history.md` effort records complete — **pending this feature's entry**, written at approval

---

## Findings

### N1 — BLOCKING — `tasks.md` has 0 of 60 boxes ticked
**Severity:** medium (process, but an explicit close criterion). **Owner:** implementer.
**File:** `specs/billing_invoicing/tasks.md` — every task line is `- [ ]`.
**Why it matters.** `CHECKPOINTS.md` C6 requires *"Every `done` sdd feature has all its tasks ticked `[x]` in `tasks.md`"*, and the reviewer refuses to close while an applicable box is empty. Approving id 21 would create that violation at the moment of the flip. It is not a formality either: all five prior sdd features are ticked 100 % (`billing_credit` 56/56, `fulfillment_stock` 49/49, `order_saga_orchestrator` 35/35, `orders_aggregate` 44/44, `outbox_and_idempotency` 57/57), so `tasks.md` is this project's per-task evidence trail and the only artefact that records *which* task a deviation attaches to. The record's prose claim — *"None of the tasks in groups A–J were skipped"* — is a summary and cannot be walked task by task.
**Note:** task **H10**'s literal wording ("confirm `BI7`/`H4` fail") was **not** fully satisfiable, and that must be recorded on the box itself rather than only in the prose, since it is the one place a future reader looks.

### N2 — BLOCKING — `BI2`'s "discount exceeds the computed amount" is neither implemented as specified nor tested
**Severity:** medium. **Owner:** implementer.
**Files:** `apps/billing/src/presentation/dto/invoice.dto.ts:47-50`; `apps/billing/src/application/invoice-issue.handler.ts:111-134`; `apps/billing/src/domain/invoice.ts:116-119`; `apps/billing/src/invoice-issue.integration.spec.ts:184-210`.

`BI2` requires a `VALIDATION_FAILED` reply **"before opening any transaction"** for a payload that fails schema validation, and names *"a discount that exceeds the computed amount"* in its own list of such payloads. `InvoiceIssueRequestDto.discount` carries only `@IsOptional() @IsInt() @Min(0)` — there is no cross-field check against `Σ unitPrice × units`, and no such check exists in `invoice.controller.ts` either.

What happens instead: the request passes validation, the handler opens the `UnitOfWork`, takes the **`credits` row lock** (l.82), performs the locking invoice read (l.91), and — critically — calls `invoiceNumbers.next(tx)` (l.111), which locks `invoice_number_sequences`, the **global counter row every invoice in the service contends on**. Only then does `Invoice.issue` throw `NegativeInvoiceTotalError` (`invoice.ts:117`) and the transaction roll back.

**Why it matters.** The observable outcome is correct — `rpc-error-mapper.ts` maps `NegativeInvoiceTotalError` to `VALIDATION_FAILED` and the rollback leaves nothing behind — which is exactly why this survived a green suite. But design §5.4's own argument for taking the allocator last is that *"the counter row is a global hot spot… taking it last minimises the time it is held"*. A malformed request now reaches that hot spot and holds two locks while doing so. Since the saga sweeper retries a malformed command on a backoff schedule, a single bad payload can contend repeatedly with legitimate invoicing traffic on the service's hottest row — the precise failure mode `BI2`'s "before opening any transaction" clause exists to prevent.

**Required:** either add the cross-field check to the DTO (or the controller) so the refusal happens before `unitOfWork.execute`, **or** amend `BI2` to strike the clause and record why the in-transaction refusal is acceptable. Either way a named test must cover a `discount > Σ(unitPrice × units)` payload — no test exercises this input today at any level.

### N3 — non-blocking — `BI5`'s "appends no ledger entry" clause is unasserted
**Severity:** low-medium. **Owner:** `test_maintainer` (assertion-only).
**File:** `apps/billing/src/invoice-issue.integration.spec.ts:157-182`.
The BI5 case asserts the reply, `invoicesOf(orderReference)` = 0 and `outboxRowsFor(correlationId)` = 0, but never re-reads `ledgerOf(orderReference)` — which holds two pre-seeded rows (hold + release). Its siblings both do: BI3 at l.127 and BI4 at l.153 assert `ledgerOf(...)` is empty. The unit half (`invoice-issue.handler.spec.ts:125`) asserts `saveCalls` on the **invoice** repository only, not the credit repository. So the requirement's third clause has no guard at any level.
Risk is mitigated — the branch throws before `consumeHold` and the rollback is proven by BI7 — which is why this is not blocking. **Fix:** one line, `expect(await harness.ledgerOf(orderReference)).toHaveLength(2)`.

### N4 — non-blocking — `BI8`'s lock-order log covers two of three declared locks
**Severity:** low. **Owner:** `test_maintainer`.
**File:** `apps/billing/src/application/invoice-issue.handler.spec.ts:175-176`.
`BI8` declares a service-wide three-lock order: `credits` → `invoices` → `invoice_number_sequences`. The ordered call log filters to `lockForOrder` and `lockByOrderReference` only, so the allocator's "always last" position — the half design §5.4 argues hardest for, and the half feature 22 must inherit — is unguarded. Moving `invoiceNumbers.next(tx)` above `lockByOrderReference` would leave every test green. **Fix:** record `next` in the same call log and assert the three-element sequence.

### N5 — non-blocking — the race spec cannot detect a lock-order inversion
**Severity:** low (recorded so the claim is not overread). **Owner:** none; documentation.
`invoice-issue-race.integration.spec.ts` runs one transaction *type* concurrently with itself, so a consistently inverted order produces no cycle and no deadlock. Verified empirically (probe 3): inverting the handler's two locks kept the race spec's premise intact and was killed only by the unit test. What the race spec genuinely proves — one invoice, one consume, one fact, `[false, true]` — is real and worth keeping; it is just not evidence about lock ordering, and design §5.4's deadlock-freedom argument rests on N4's unit log alone.

### N6 — non-blocking — the live-boot record overstates the `attempts` values
**Severity:** low (accuracy of the process record). **Owner:** implementer.
**File:** `progress/impl_billing_invoicing.md` § J2 — the table reads `attempts 63 → 64` (×5), `24 → 25`, `18 → 19`.
The live database shows **63, 63, 63, 63, 63, 24, 18** — the dispatcher does not increment `attempts` on a successful send. Every other figure in J1–J4 that I re-queried matched exactly (availableCredit 350 606 / 200 012, 13 published `invoice.issued.v1`, `payment.received.v1` and `credit.released.v1` both still 5, four saga rows per order, one hold + one consume per order). This is a small slip in an otherwise unusually accurate record, and it is worth correcting precisely because the rest is trustworthy.

### N7 — non-blocking — `H1`'s outbox assertion is `correlationId`-scoped
**Severity:** low. **Owner:** `test_maintainer`.
**File:** `apps/billing/src/invoice-issue.integration.spec.ts:94-100`.
The happy path asserts `outboxRowsFor(correlationId)` has length 1. A consume-side fact carrying a different `correlationId` would be invisible there, so at **responder** level nothing guards R40's suppression — only `BI7`'s repository-level whole-table delta does. Structurally mitigated (no `credit.consumed.v1` builder exists in `credit-events.ts`), which is why this is low. **Optional fix:** mirror BI7's before/after whole-table delta in H1, giving the suppression a guard at both layers.

### N8 — informational — `BI1`'s guard is a text scan
`billing-consumes-no-facts.spec.ts` greps source text rather than introspecting the compiled Nest container. It binds (probe 6 confirmed) and it is carefully built — invocation-shape matching, self-proving matcher, `main.ts` transport pinning, `kafkajs` import ban with one named exception. Its blind spots are `test-support/` and `*.spec.ts`, both excluded deliberately. Named so no assessment reads it as a container-level guarantee.

### N9 — informational — inter-test state coupling in the parity spec
`credit-rejection-parity.integration.spec.ts` now shares `simulatedRejectionKeys` between two `it`s in declaration order. This is what makes N1's fix work and the coupling is documented in-file, but the second case can no longer be run in isolation (`-t`), and `expect(simulatedRejectionKeys).toBeDefined()` will read as a confusing failure if the first case ever breaks first.

---

## What must change before re-review

1. **N1** — tick `specs/billing_invoicing/tasks.md`, all groups A–J. Mark **H10** with its recorded deviation (the `H4` half was not realisable as written) rather than ticking it silently.
2. **N2** — either move the `discount > Σ(unitPrice × units)` refusal ahead of `unitOfWork.execute`, or amend `BI2` to strike the clause with a written justification. **Either way, add a named test for that payload** — currently no test exercises it at any level.
3. **N3** — add the missing `ledgerOf` assertion to the BI5 integration case (`test_maintainer`, one line).
4. **N4** — extend `BI8`'s ordered call log to include `invoiceNumbers.next` and assert the three-element order (`test_maintainer`).
5. **N6** — correct the `attempts` figures in `impl_billing_invoicing.md` § J2 to 63/24/18.

N5, N7, N8 and N9 need no action; they are recorded so the next reader — and assessments #8 and #9 — inherit the reasoning rather than the conclusion.

**N7 is optional but cheap**, and it is the one that would close the last hole in R40's suppression guard.

---

## What is genuinely strong here, for the record

The three armed deletions are the real thing, not a ritual — I re-armed all three independently and every one died on a **fact-count** assertion, including the inverted H10, which is the guard most likely to have been vacuous and was not. The implementer's caveat on `H4` is *correct*, volunteered, and correctly reasoned; it names a limitation the task brief did not anticipate rather than papering over it, and it names the assertion that actually does the work. The live-boot evidence is accurate to the unit against a database I queried independently, including the negative half — no new saga row, no order past `invoiced`, `payment.received.v1` and `credit.released.v1` both unmoved. And the `.99` guard's computed half is load-bearing exactly where the spec said it needed to be. This feature is one DTO check and a handful of assertions away from approval, not a rework.

---

# Round 2 — re-review, bounded to N1 / N2 / N3 / N7

**Verdict: APPROVED.** All four findings are genuinely closed. One new non-blocking finding (**N10**) is raised and, like N4–N6 / N8–N9, carried forward rather than blocking. `pnpm quality`, the billing integration suite and `./init.sh` are reported green by the implementer and were **not** re-run wholesale, per the bounded brief.

Scope honoured: I did not re-walk traceability, did not re-query the live databases, and did not re-run any suite wholesale. What I ran: `invoice.controller.spec.ts` twice (armed and restored), `invoice-issue.integration.spec.ts` three times against real Testcontainers (once under a purpose-built placement experiment, once under a re-armed H10, once clean), and read the four changed files plus `app.module.ts`.

All armed edits restored byte-exact — `invoice.dto.ts`, `invoice-issue.integration.spec.ts` and `buyer-credit.repository.ts` all `md5sum`-identical to their pre-edit backups, and `git diff` clean for the tracked one. Final clean re-run of `invoice-issue.integration.spec.ts`: **7/7 green**; `invoice.controller.spec.ts`: **8/8 green**.

---

## N7 — CLOSED. The last gap in R40's suppression guard is shut

**What I armed.** Re-applied H10's regression to `DrizzleBuyerCreditRepository.save` — one spurious `credit.consumed.v1` outbox row inserted whenever the appended ledger rows contain a `consume`, carrying the **credit line's own** id as `aggregateId` and a *different* `correlationId`, which is precisely the shape the old `correlationId`-scoped assertion could not see.

**What I observed.** `invoice-issue.integration.spec.ts`, 1 failed / 6 passed:

```
FAIL … > H1/R45 — one invoices row, its invoice_items, one consume entry of exactly the hold amount,
         one invoice.issued.v1 outbox record … and a reply with created: true
AssertionError: expected 2 to be 1 // Object.is equality
 ❯ src/invoice-issue.integration.spec.ts:115:50
    114|     const outboxCountAfter = (await harness.db.select().from(outbox))…
    115|     expect(outboxCountAfter - outboxCountBefore).toBe(1);
```

Exactly as reported. The three `correlationId`-scoped assertions immediately above it (l.106-110) **all still passed** under the same regression — so the new whole-table delta is doing real, non-redundant work, not duplicating an existing check. R40's deliberate silence is now guarded at **both** layers that can observe it: `BI7` at the repository, `H1` at the responder. This was the finding I called the last hole, and it is properly shut.

## N3 — CLOSED. The assertion is real

`invoice-issue.integration.spec.ts`, the `BI5` case now ends with `expect(await harness.ledgerOf(orderReference)).toHaveLength(2);` — the order's two pre-seeded rows (hold + release) re-read after the refusal, so an appended `consume` would make it 3 and fail. Exactly the one-line fix requested, in the existing `it` rather than a new one, and it discharges `BI5`'s previously-unasserted third clause. It passed in the clean run and passed in both armed runs.

## N2 — CLOSED behaviourally. The property holds, and it is proven — but not by the assertion the record credits

### The armed deletion: confirmed independently

Removed `@DiscountWithinComputedAmount()` from `InvoiceIssueRequestDto.discount` and ran `invoice.controller.spec.ts`:

```
FAIL … > refuses a discount that exceeds the computed amount before dispatching to the command bus
AssertionError: expected undefined to match object { code: 'VALIDATION_FAILED' }
+ Received: undefined
 ❯ src/presentation/invoice.controller.spec.ts:133:20
```

Character-for-character what was reported. And the `undefined` is itself the evidence: with the decorator gone, `validate()` passes, the controller *does* call `commands.execute`, and the mock returns `undefined`. The test therefore dies on the dispatch having happened, one line before `expect(commandExecute).not.toHaveBeenCalled()` even runs. Restored; 8/8 green.

### The property is genuinely "before any transaction", and structurally so

`DiscountWithinComputedAmountConstraint` is a `class-validator` custom constraint registered on the DTO field, so it runs inside the **same** `validate(dto, { whitelist: true })` call `invoice.controller.ts` already performs at line 43 — before `parseRpcMeta`, and before `this.commands.execute(new IssueInvoiceCommand(...))` at line 55. `IssueInvoiceCommand`'s only handler delegates straight into `InvoiceIssueHandler.issue`, the sole caller of `unitOfWork.execute`. So the unit assertion `expect(commandExecute).not.toHaveBeenCalled()` is direct, sufficient proof that no transaction was opened, no `credits` row lock taken and no `invoiceNumbers.next(tx)` reached. **This is the load-bearing guard, the implementer's own comment correctly identifies it as such, and it is the right shape** — it tests the property, not the error code, which is exactly what I asked for.

The constraint itself is defensively written: it defers to `@IsOptional` for null/undefined, to `@IsInt` for wrong types, and to the array checks for a malformed `lines`, returning `true` in each case so it produces no duplicate or misleading violation. `discount: 2_001` against `2 × 1_000` is a boundary+1 fixture.

### But the integration counter-proof does **not** distinguish the two placements — and three artefacts claim it does

This is the specific thing I was asked to check, and the answer is the uncomfortable one.

**The experiment.** I removed the decorator (putting the check back *inside* the transaction, where only `Invoice.issue`'s `NegativeInvoiceTotalError` catches it) **and** seeded a real `credit.hold` of `2_000` for the discount order, so the request would sail past step 4's `activeHold` gate and genuinely reach `invoiceNumbers.next(tx)`. That is the only configuration in which the counter assertion can be observed at all — without the hold, the in-transaction placement is refused at `NO_ACTIVE_HOLD` and the test dies on the error code long before the counter is read.

**The result: `Test Files 1 passed (1) / Tests 7 passed (7)`.** Every assertion passed with the check sitting inside the transaction — including `expect(counterAfter).toEqual(counterBefore)`, and including `expect(discountReply).toMatchObject({ code: 'VALIDATION_FAILED' })`, because `rpc-error-mapper.ts` maps `NegativeInvoiceTotalError` to `VALIDATION_FAILED` too.

**Why it cannot work, mechanically.** `DrizzleInvoiceNumberAllocator.next(tx)` runs every one of its four statements — the `MAX(...)` probe, the `ON DUPLICATE KEY UPDATE` ensure-insert, the `SELECT ... FOR UPDATE` and the `UPDATE ... SET next_value = next_value + 1` — on `asDrizzleTx(tx)`, the transaction's own connection. A counter **table** row is not `AUTO_INCREMENT`: when the transaction rolls back, the increment rolls back with it. So `invoice_number_sequences` is byte-identical after a refusal *whether the refusal happened in the DTO or inside the transaction*. The observable is insensitive to the variable under test.

**What the three artefacts claim.** All three assert the inference that my experiment falsifies:

- `apps/billing/src/invoice-issue.integration.spec.ts`, the BI2 comment — *"its counter is read before and after and must be byte-identical, which is only possible if `invoiceNumbers.next(tx)` was never called, which is only possible if `unitOfWork.execute` was never opened."* Both "only possible if"s are false.
- `specs/billing_invoicing/tasks.md`, task **H3** — *"proving the refusal happens before `unitOfWork.execute` is ever called (the `invoice_number_sequences` counter is read before/after and is byte-identical)."*
- `progress/impl_billing_invoicing.md`, the N2 addendum — *"the concrete proof that the service's hottest lock was never touched, which is the actual hazard N2 raised."*

This is **N10**, non-blocking. It does not weaken the fix — the property is real and the unit test proves it. The integration assertions retain genuine independent value (no invoice, no ledger entry, no fact, no counter leak on a refusal, all worth having). What is wrong is only the *justification*: a reader who trusts these three comments would believe the placement is guarded at integration level when it is guarded only at unit level, and would not notice if a future refactor moved the check inward. Assessments #8 and #9 inherit `tasks.md`, which makes the claim portable.

## N1 — CLOSED. 60/60, and the five rewordings are honest

`specs/billing_invoicing/tasks.md`: **60 ticked, 0 unticked** — verified by count, matching the five prior sdd features (`billing_credit` 56/56, `fulfillment_stock` 49/49, `order_saga_orchestrator` 35/35, `orders_aggregate` 44/44, `outbox_and_idempotency` 57/57).

I checked each reworded box against what is actually on disk rather than against its own prose, because stale-tick drift is the repeat offence:

| Box | Reworded claim | Verdict |
|---|---|---|
| **B4** | The migration was **hand-trimmed** after `drizzle-kit generate` because `meta/0001_snapshot.json` was stale, copying the `apps/fulfillment/drizzle/0002_…` precedent; committed SQL holds exactly one `CREATE TABLE` + two indexes | **Honest.** Independently corroborated in round 1: the migration file's own header documents the trimming and names the same precedent, and I read the SQL — one `CREATE TABLE`, one `ADD CONSTRAINT … UNIQUE`, one `CREATE INDEX`. The rewording also quietly drops the original's wrong command name (`migrate`; the real script is `db:migrate`) |
| **F6** | **Four** new `useFactory` providers, not five — the "read port's clock wiring" needed no factory because `ListInvoicesHandler` binds the `CLOCK` token `app.module.ts` already provides | **Honest, and verified in the diff.** Exactly four new factories (`INVOICE_REPOSITORY`, `INVOICE_READ`, `INVOICE_NUMBER_ALLOCATOR`, `InvoiceIssueHandler`), plus `InvoiceController` in `controllers` and both handler sets in `providers`. `{ provide: CLOCK, useClass: SystemClock }` pre-exists at `app.module.ts:67`, and `invoice.query-handlers.ts:15` is `@Inject(CLOCK)`. This is a correction of the spec's original guess, not a tick over stale text — the honest direction |
| **H1** | Records the N7 amendment and that re-arming H10 now fails this file too | **Honest — I reproduced it myself this round**, `expected 2 to be 1` |
| **H3** | Records the N3 and N2 amendments | **Honest on substance** (both amendments exist and work), **overclaims in its parenthetical** — the counter clause. This is N10 |
| **H10** | Records **on the box itself** that `H4` did not and could not fail, that refusal and consumption are mutually exclusive branches, and that `H1`'s new guard closes the responder-level half instead | **Honest, and precisely what round 1 asked for.** It matches what I independently established rather than softening it, and it now names the guard that replaced the unrealisable one. This is the best of the five |

No box was ticked over text describing something that was not built. Where the spec's original wording was wrong, it was corrected and the correction argued — which is the behaviour this checkpoint exists to produce.

---

## `CHECKPOINTS.md` — the boxes that were empty in round 1

- [x] **C6** — *"Every `done` sdd feature has all its tasks ticked `[x]` in `tasks.md`"* — 60/60, rewordings verified honest
- [x] **C5** — *"`progress/history.md` has an entry for the feature just finished, including its effort record"* — appended at this approval
- [x] **C7** — *"`progress/history.md` effort records are complete and honest"* — appended, with the mtime-pollution caveat stated

All other C1–C7 boxes stand as marked in round 1; nothing in this round's diff can reach them.

---

## Findings after round 2

**Closed:** N1, N2, N3, N7.
**Carried forward by the coordinator, untouched:** N4 (BI8's lock log covers two of three locks), N5 (the race spec cannot see a lock-order inversion), N6 (the `attempts` figures in the live-boot record), N8 (BI1's guard is a text scan), N9 (inter-test coupling in the parity spec).

### N10 — non-blocking — the integration counter-proof cannot distinguish the two placements it claims to prove
**Severity:** low (documentation; the guarded property itself is sound and proven elsewhere). **Owner:** `test_maintainer` — comment/prose only, no code change.
**Files:** `apps/billing/src/invoice-issue.integration.spec.ts` (the BI2 comment); `specs/billing_invoicing/tasks.md` task **H3**; `progress/impl_billing_invoicing.md` § N2 addendum.
Proven by experiment this round: with the check moved inside the transaction and the request reaching `invoiceNumbers.next(tx)`, **all 7 tests passed**, counter assertion included. `next(tx)` runs on the transaction's connection and its increment is rolled back with everything else, so the counter is unchanged under both placements.
**Fix:** reword all three to claim what the assertion actually establishes — *"a refusal leaks no sequence value"* — and point the placement claim at the unit case (`commandExecute` never called), which is where it genuinely lives. Worth doing before the human's commit, since `tasks.md` is inherited verbatim by #8 and #9.
**For #8 and #9:** the general lesson is sharper than this instance. *An assertion that a rolled-back side effect did not happen proves nothing about whether it was attempted.* Transaction-scoped counters, sequence tables and any `FOR UPDATE`-guarded row all look identical after a rollback whether the code reached them or not. To prove a code path was never entered, observe the **entry** (a bus that was never called, a lock that was never requested), never the **residue**.

---

## Verdict

**APPROVED.** Both blocking findings are genuinely fixed, both cheap non-blockers are closed, and every claim in the addendum that I probed reproduced exactly — the N2 armed deletion character-for-character, the N7 re-arming character-for-character. The one new finding is a false justification attached to a correct fix, not a defect in the fix.

The work is good, and two things deserve saying. The `H10` box now records its own unrealisable instruction on the box itself rather than burying it in prose — that is the harder, better choice. And the N2 unit test was written to assert the *property* (the bus was never called) rather than the *symptom* (the error code), which is the distinction round 1 asked for and the reason N10 is a comment defect rather than a hole in the guard.

`billing_invoicing` (id 21) set to `done`. Effort record appended to `progress/history.md`. Not committed — that is the human's.
