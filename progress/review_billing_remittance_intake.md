# `billing_remittance_intake` (feature 22, phase 10, `sdd: false`) — adversarial review

**Verdict: APPROVED.** 0 blocking defects. 1 non-blocking finding of substance (**N11**), 2 informational (**N12**, **N13**). Eight probes run; the ordering guard was re-armed from scratch and killed; one unarmed behaviour path was found by an independent probe. Per the bounded brief, `pnpm quality`, the billing unit suite and the billing integration suite were **not** re-run wholesale — what I ran instead is listed under every probe below.

This closes Phase 10 and the order-to-cash cycle.

---

## What I ran, in full

| Command | Purpose | Result |
|---|---|---|
| `vitest run src/application/payment-register.handler.spec.ts` under a **re-armed order swap** | probe 1 | **1 failed** — the guard is real |
| `vitest run src/application/payment-register.handler.spec.ts` (restored) | restore check | 10/10 green, file md5-identical to submitted |
| `vitest run …handler.spec.ts …rpc-error-mapper.spec.ts …invoice.controller.spec.ts` | targeted claim check | **38/38 green** |
| `vitest run src/__reviewer_probe.spec.ts` (my own temporary probe, deleted after) | probe 2 | exposed **N11** |
| `eslint` on the 5 new/changed source files | conventions | exit 0 |
| 6 read-only MySQL query batches against `otc-mysql` | probes 5, 7, 8 | see below |
| `grep` for `setInterval` / `setTimeout` / `@Cron` / `ScheduleModule` across `apps/billing/src` | probe 6 | see below |
| `git status --porcelain`, `git diff` on 4 files | probe 8, scope | see below |

---

## Probe 1 — R47's fact ordering: does the guard actually guard *ordering*?

**Yes, genuinely, and I re-armed it rather than trusting the record.**

The concern was that `expected 3 to be greater than 4` might merely prove "two rows exist with different sequence numbers". It does not. The assertion is `payment-register.handler.spec.ts:248`:

```ts
const markPaidIdx = callLog.indexOf('markPaid');
const creditsSaveIdx = callLog.indexOf('creditsSave');
expect(creditsSaveIdx).toBeGreaterThan(markPaidIdx);
```

`callLog` is **one shared array** into which *both* repository fakes append (`invoiceRepositoryOf` and `creditRepositoryOf` are wired to the same array, `spec.ts:212-227`). It records synchronous append order inside a single awaited chain in a single-threaded fake — there is no timing under which a reversed order yields a passing comparison. This is a call-order assertion across two aggregates, not a row-existence assertion.

I applied the swap myself (`credits.save` moved above `invoices.markPaid` in `payment-register.handler.ts`) and ran the file:

```
FAIL  src/application/payment-register.handler.spec.ts > PaymentRegisterHandler — R47, the happy path > locks the credit line before the invoice row (BI8)…
AssertionError: expected 3 to be greater than 4
 ❯ src/application/payment-register.handler.spec.ts:248:28
```

Restored; `md5sum -c` OK; 10/10 green.

**The call order → `seq` order chain is structural, not incidental**, and I verified each link:

1. `invoice.repository.ts:155-156` — `markPaid` drains `invoice.pullDomainEvents()` (`payment.received.v1`) into the outbox **inside `markPaid` itself**, after its `UPDATE`/`INSERT`.
2. `buyer-credit.repository.ts` — `save` drains `credit.released.v1` into the outbox inside `save`.
3. `outbox-recorder.ts:19-23` — assigns no sequence; MySQL `AUTO_INCREMENT` does, in statement order.

Two separate `INSERT` statements in one transaction therefore receive strictly increasing `seq` in call order. The unit test guards the call order; the integration test (`payment-register.integration.spec.ts:132-134`) independently asserts the resulting `seq` order in real MySQL. Two guards, different layers, and the swap kills both.

**Live confirmation** (`otc_billing.outbox`, correlation `3e1bb362-…`): `seq 249 payment.received.v1`, `seq 250 credit.released.v1`, both `published_at` stamped. Ordering holds in production data.

## Probe 2 — R48 under a genuine concurrent duplicate

**The concurrent same-invoice duplicate returns the original outcome, not a raw constraint violation — and the mechanism is a lock, not luck.** But an adjacent, *untested* path is wrong-ish: see **N11**.

Path analysis, verified against the code rather than inferred from the passing test:

- Both requests miss the step-0 fast path (`handler.ts:76-83`, no payment row yet).
- Both enter `unitOfWork.execute`. The **first statement** in the transaction is `credits.lockForOrder` → `SELECT … FROM credits … FOR UPDATE` (`buyer-credit.repository.ts:41-46`). Both requests name the same invoice, hence the same credit line, hence **the same row**: B blocks until A commits. This serialises the pair before either can reach `payments`.
- A completes, commits, releases. B acquires, then `lockById` (`invoice.repository.ts:104`, `FOR UPDATE`) — a locking read, which always reads the latest committed version → sees `paid`.
- B's `findPaymentByInvoiceId` (`invoice.repository.ts:121`) is a *plain* SELECT. Under REPEATABLE READ this matters, and it is safe here: **every** read in `lockForOrder` and the invoice row read are locking reads (`.for('update')`), so the transaction's consistent-read snapshot is not established until the first plain SELECT — which is `lockById`'s `invoiceItems` read, executed strictly *after* the credit-row lock unblocked, i.e. after A committed. B therefore sees A's `payments` row and returns `duplicate` (`handler.ts:129-134`).

So the read-then-write check is performed **under a row lock that provably serialises the contenders**, and `payments_payment_reference_unique` is a true backstop on this path, never the primary mechanism. The armed deletion #4 result (`InvoiceAlreadyPaidError … (invariant B8)`) is consistent with this: removing the short-circuit does not produce a raw `ER_DUP_ENTRY`, because the aggregate's B8 guard fires first — a second line of defence behind the suppression, exactly as the implementer described.

The integration test asserts the strong form — `outcomes.sort()` equals `['accepted','duplicate']` (`payment-register.integration.spec.ts:190`) — so a `CONFLICT` on this path would fail the suite rather than pass silently. That is the right assertion.

## Probe 3 — R49's three refusal paths, and the **credit-ledger** clause specifically

**The ledger clause is asserted, non-vacuously, in all three cases.**

| Case | Invoice unchanged | **Ledger unchanged** | No fact |
|---|---|---|---|
| Amount mismatch | `:219` `{status:'issued', paidAt:null}` | **`:221` `expect(await harness.ledgerOf(…)).toEqual(ledgerBefore)`** | `:222` outbox length 0 |
| Currency mismatch | `:238` | **`:240` same** | `:241` |
| Different ref vs `paid` | `:264` `toEqual(paidRowBefore)` (whole row) | **`:266` same** | `:267` |

Non-vacuity checked: `ledgerOf` (`billing-integration-harness.ts:272-274`) is a real `SELECT … FROM credit_items WHERE order_reference = ?`, and in every fixture `ledgerBefore` is **non-empty** — `issuedFixture` runs a real `billing.credit.hold` then `billing.invoice.issue`, leaving a `hold` row and a `consume` row. `toEqual` on a two-element row array is a genuine deep comparison, not `[] === []`.

At unit level the stronger property is proven: `markPaidCalls` and `saveCalls` are both length 0 in all three cases (`spec.ts:358-359, 370-371, 382-383`) — the *repository methods are never called*, so nothing was even attempted.

## Probe 4 — the N10 repeat: is any property proved by reading the DB after a rollback?

**No. The lesson was internalised, not re-broken.** This is the finding I most expected to make and could not.

`payment-register.integration.spec.ts:5-8` states the rule on the file itself:

> *A ROLLED-BACK side effect proves nothing about whether it was attempted (the N10 rule) — this file proves "nothing was written" at the DB level, which is exactly what an integration test CAN observe; the "nothing was even attempted" half of R49 is proven at the unit level.*

And the split is real, not decorative:

- The integration tests claim only `unchanged` / `length 0` — properties a post-rollback read *can* establish. Their test names match (`leaving the invoice and the credit ledger unchanged`), so no name overclaims.
- The "nothing attempted" claim lives at `payment-register.handler.spec.ts:331-336`, asserted on **fake call counters**, which observe the *entry*, not the residue — precisely what feature 21's N10 asked for.
- No ordering property anywhere is inferred from a rolled-back state; R47's ordering is asserted only on a committed transaction.

I also confirmed the inverse risk is absent: there is no test asserting that a lock or a sequence row "looks untouched" after a rollback.

## Probe 5 — the release arithmetic, on live data

**Verified from the ledger identity, and the identity cannot drift, because there is no stored scalar to drift.**

`DESCRIBE otc_billing.credits` has **no `committed_exposure` column**. It is recomputed on every load by SQL (`buyer-credit.repository.ts:53`):

```
COALESCE(SUM(CASE type WHEN 'hold' THEN amount WHEN 'release' THEN -amount ELSE 0 END), 0)
```

which is exactly `credit-exposure.ts`'s `committedExposure = Σhold − Σrelease` (`consume` numerically neutral). Store and domain compute the same expression; divergence is not representable.

The claimed figures, recomputed by me directly:

```
CR-000001  credit_limit 500000  committed 399384  available 100616   ← claimed 100616 ✓ (and 100616 − 49998 = 50618, the claimed "before") ✓
CR-000124  credit_limit 500000  committed  99396  available 400604
```

Live entries for `ORD-000018`: `hold 49998`, `consume 49998`, `release 49998` — release exactly equals hold.

**Is this exact for *every* fully paid order, or only this one?** Exact for every one, **by construction**. `BuyerCredit.releaseHold` (`buyer-credit.ts:249-251`) computes:

```ts
const outstanding = summary.byOrder.find(o => o.orderReference === input.orderReference.value)?.exposure ?? 0;
```

and releases `Money.of(outstanding, currency)`. The released amount is derived from **the ledger** (`Σhold − Σrelease` for that order), and the payment amount is **never an input to it** — `releaseHold`'s input carries only `orderReference`, `reason`, `correlationId`. A full release therefore drives that order's exposure to exactly 0 and returns the line to precisely its pre-hold value, for any order, always.

Cross-checked repo-wide against the live database: **no order has negative exposure** (B5 holds), and **no order has `Σrelease > 0` with `Σrelease ≠ Σhold`** — both queries returned empty.

### The `INV-000009` / `INV-000011` residue question — answered from the arithmetic, nothing paid

The live ledger for those two:

```
CR-000124  ORD-000008  hold 49698   consume 49698     (INV-000009 total = 49998)
CR-000124  ORD-000009  hold 49698   consume 49698     (INV-000011 total = 49998)
```

**There would be no 300 residue in the credit line.** If either invoice were paid — and under R49 it is payable only at its stated total of 49998 — `releaseHold` would release `outstanding = 49698`, the hold amount, **not** the 49998 that was paid. The credit line would return to exactly its starting value, to the cent, and `committedExposure` would go to 0 for that order.

The 300 does not vanish and it does not leak: it is a **pre-existing data defect in the invoice total**, and paying the invoice would relocate it into a different and more visible place — *money recorded as received (49998) exceeding the credit exposure the order ever held (49698)*, an inconsistency the credit ledger by design does not model and would not flag. Note the contrast with `ORD-000007`, whose hold was 49998 and whose release was 49998: the pre-fix payload divergence affected the *holds* of `ORD-000008`/`ORD-000009` only, while their invoices carry the other figure. Not this feature's defect, and correctly left alone rather than "fixed" — but see **N13**.

## Probe 6 — "no internal payment timer anywhere"

**Confirmed.** `grep` for `setInterval|setTimeout|@Cron|ScheduleModule|@Interval|cron|sweep|Sweeper` across `apps/billing/src` returns, in non-spec source, only:

- `infrastructure/outbox/outbox-relay.service.ts` — the **pre-existing** self-scheduling outbox relay (untouched: not in `git status`).
- `infrastructure/outbox/outbox-relay.ts`, `create-kafka-client.ts` — pre-existing publish-timeout / backoff timers.
- Two occurrences of the *word* "sweeper" in prose comments in this feature's new files, referring to Orders' pre-existing saga sweeper as a source of retries.

No scheduler, interval, cron or sweeper was added. The only trigger for `issued → paid` is the inbound `billing.payment.register` request — stated on the responder itself (`invoice.controller.ts`: *"NO internal timer anywhere: this responder is the sole trigger"*) and true. Orders' saga sweeper is pre-existing and legitimate; `apps/orders` is byte-untouched.

## Probe 7 — the self-reported verification mistake: honest?

**Honest, and corroborated by evidence the implementer did not cite.** I queried `otc_orders.saga_ignored_facts` myself:

```
payment.received.v1   unknown_order   order_id NULL   correlation 4dc9d60f-830c-48cd-9a75-83b662f62297   2026-08-24 04:26:43
credit.released.v1    unknown_order   order_id NULL   correlation 4dc9d60f-830c-48cd-9a75-83b662f62297   2026-08-24 04:26:43
```

and the matching outbox rows `seq 247 payment.received.v1` / `seq 248 credit.released.v1` under that same correlation id — **in the correct order**, both published. So Billing's write was fully correct on the first attempt too; the only fault was a random UUID in the correlation header of the test script, and Orders' defensive layer marked both facts `unknown_order` and ignored them without crashing. The characterisation "my own script, not a product defect" is accurate on every checkable point. Disclosing it at all, when the successful retry alone would have satisfied the brief, is to the implementer's credit. The consequence it discloses is real and I confirmed it — see **N13**.

## Probe 8 — scope

**`apps/orders` is genuinely untouched.** `git status --porcelain` lists 14 modified + 7 untracked paths, every one under `apps/billing/**`, `specs/shared/test-matrix.md`, `feature_list.json` or `progress/`. Not one `apps/orders` file, and no file outside the declared list — the "Files touched" section of the impl record is complete and accurate.

**The transition is driven by pre-existing code.** `ORD-000018` is `completed` in `otc_orders.orders`, reached from `invoiced` via `paid`, with no Orders diff in this feature. The saga-step wiring for `payment.received.v1` and `credit.released.v1` shipped earlier as part of the saga foundation.

Live end state, queried by me:

```
INV-000012 / ORD-000018   status=paid   paid_at=2026-08-24 04:28:44   total 49998 EUR   → ORD-000018 completed
payments: PAY-LIVE-1787545723823 → INV-000012, 49998 EUR, source=test
```

---

## Traceability — R47/R48/R49 → named tests

| Req | Test(s) I verified exist, are named as claimed, and are non-vacuous | Status |
|---|---|---|
| **R47** | `payment-register.handler.spec.ts` › `PaymentRegisterHandler — R47, the happy path` › *locks the credit line before the invoice row (BI8), calls Invoice.markPaid and BuyerCredit.releaseHold, persists the invoice BEFORE the credit line, and replies accepted* — **re-armed by me, dies on the swap**. Integration: `payment-register.integration.spec.ts:92` › *H1/R47 — …emits payment.received.v1 THEN credit.released.v1 in that order in the outbox…* — asserts real `seq` order in MySQL | **PASS** |
| **R48** | `…handler.spec.ts:279` › *the fast path answers duplicate WITHOUT opening a transaction at all* (`executeCalls === 0`); `:303` › *the authority re-read under the invoice lock answers duplicate and writes NOTHING new* (call counters, not residue). Integration `:139` sequential, `:177` **concurrent** (`Promise.all`, asserts `['accepted','duplicate']` exactly), `:300` UNIQUE-constraint backstop | **PASS** |
| **R49** | `…handler.spec.ts:341, 362, 374` — all three refusals, each asserting `markPaidCalls`/`saveCalls` empty (nothing *attempted*). Integration `:206, 225, 244` — each asserting invoice unchanged, **ledger deep-equal unchanged**, outbox empty. Wire mapping: `rpc-error-mapper.spec.ts` | **PASS** |

`specs/shared/test-matrix.md` diff: **only** the R47, R48 and R49 rows changed, plus the coverage-summary cell `billing_invoicing 2 → 5`. Nothing else touched — confirmed by `git diff`. The R48/R49 rows honestly record that coverage sits one layer below the sketch's `API` level because the Gateway endpoint (features 25/29) does not exist yet, rather than claiming API coverage that does not exist.

---

## CHECKPOINTS.md — boxes walked

### C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` exist
- [x] `progress/current.md`, `progress/history.md` exist
- [x] `.claude/agents/` holds the five agents
- [x] every agent declares its model
- [ ] `./init.sh` exits 0 — **not re-run this pass**; no environment change in this feature's footprint (no package, no migration, no `.env.example` edit), per the bounded brief

### C2 — state is coherent
- [x] at most one feature `in_progress` — zero, this one is `in_review` → `done`
- [x] every status in `rules.valid_status`
- [x] every `done` feature has passing tests
- [x] `progress/current.md` describes the active session
- [x] no `blocked` feature lacks a reason

### C3 — architecture is respected
- [x] no framework import in any `domain/` folder — **no `domain/` file was modified at all** in this feature (`git status`), and `eslint` on the changed files exits 0
- [x] no cross-service DB access — the handler touches `otc_billing` only; `retailerCode`/`companyCode`/`orderReference` are carried as business identifiers, no FK crosses a boundary
- [x] no shared runtime code beyond `shared-kernel` + `contracts` — no new package, no contracts regeneration needed
- [x] `shared-kernel` still dependency-free — untouched
- [x] every interaction classifiable: `billing.payment.register` is a **NATS RPC** (a request expecting a reply, correctly not a fact); `payment.received.v1` / `credit.released.v1` are **Kafka facts** via the outbox. No Kafka-as-request-bus, no RPC-for-facts
- [x] `@MessagePattern(PAYMENT_REGISTER_SUBJECT, Transport.NATS)` names its transport
- [x] explicit DI: `app.module.ts` uses `useFactory` + `inject: [UNIT_OF_WORK, BUYER_CREDIT_REPOSITORY, INVOICE_REPOSITORY, CLOCK]` — no bare-type inference
- [x] money in integer minor units throughout; `snake_case` DB / `camelCase` TS boundary respected in `invoice.mapper.ts`
- [x] no stray debug logging, no context-free TODOs in the diff

### C4 — verification is real
- [x] domain tests pure — `payment-register.handler.spec.ts` imports no framework, no DB, no broker; hand-built fakes only
- [x] integration tests use Testcontainers against real MySQL/NATS/Kafka — not mocked brokers
- [x] no Jest anywhere — Vitest 4.1.11 is the runner
- [x] `pnpm quality` passes — **reported green repo-wide by the implementer minutes before this review and deliberately not re-run**; I ran `eslint` on the changed files (exit 0) and 38 targeted tests (all green) instead
- [ ] coverage ≥80% domain / ≥60% overall — enforced inside `pnpm quality`, **not independently re-measured this pass**

### C5 — the session closed cleanly
- [x] no suspicious untracked files — the 7 untracked paths are this feature's 6 source/test files plus its impl record; my own temporary probe file was deleted and `git status` confirms it is gone
- [x] `progress/history.md` has the entry **including the effort record** — appended by me at approval
- [x] `feature_list.json` reflects true state — id 22 flipped to `done` by me
- [x] the human has been told what was done and how to test it — the impl record carries the live-cycle reproduction
- [x] **Claude did not commit** — no `git commit`, no `git push`, in this review or the implementation

### C6 — Spec-Driven Development
- n/a — `sdd: false`. No `specs/22/` is required or expected; the specification is `specs/shared/requirements.md` R47–R49 plus `feature_list.json` id 22's acceptance list, and all six clauses are traced above.

### C7 — trilogy reusability
- [x] `specs/shared/` still stack-agnostic — the three flipped rows name concrete NestJS test paths in the **evidence** column only; the stack-agnostic *sketch* column is unchanged
- [x] `n8n/workflows/*.json` untouched
- [x] `progress/history.md` effort records complete and honest

### `feature_list.json` id 22 acceptance
- [x] **idempotent by `paymentReference`** — probe 2; fast path, locked authority re-read, and a UNIQUE constraint backstop, with sequential *and* concurrent tests
- [x] **no internal payment timer anywhere** — probe 6
- [x] **emits PaymentReceived and CreditReleased** — probe 1; both armed, both observed live in the outbox in the required order

---

## Findings

### N11 — non-blocking, medium — sequential cross-invoice reuse of a `paymentReference` returns a success-shaped `duplicate` naming a **different** invoice, while the concurrent form returns `CONFLICT`

**File:** `apps/billing/src/application/payment-register.handler.ts:76-83` (the step-0 fast path).

The fast path looks up the payment **by reference alone** and never compares the resolved invoice against the invoice the caller actually named:

```ts
const existingPayment = await this.invoices.findPaymentByReference(request.paymentReference);
if (existingPayment) {
  const paidInvoice = await this.invoices.findById(existingPayment.invoiceId);
  …
  return replyFromDuplicate(paidInvoice, existingPayment);   // ← the caller's invoiceReference is never consulted
}
```

I proved the consequence with a temporary unit probe (deleted after running; `git status` clean). Registering `PAY-X` against **INV-000002**, when `PAY-X` is already recorded against **INV-000001**:

```
PROBE RESULT >>> {"outcome":"duplicate","paymentReference":"PAY-X","invoiceReference":"INV-000001",
                  "orderReference":"ORD-000001","invoiceStatus":"paid","paidAt":"…"}
requestedInvoice= INV-000002   markPaidCalls= 0
```

The caller asked about INV-000002 and is told, in a success-shaped reply, that its payment is already recorded — against an invoice and an order it never mentioned. INV-000002 stays unpaid, and the caller has no signal that anything was refused.

**Why it matters, and why it is not blocking.** It writes nothing and emits nothing, so no data is corrupted, and R48's literal text (*"WHILE a `paymentReference` has already been recorded… respond with the original outcome"*) does arguably permit it. But the **concurrent** form of the identical situation returns a `CONFLICT` `RpcError` (`PaymentReferenceConflictError`, exercised by the integration test at `:300`). The same logical condition therefore produces two different answers depending purely on which request wins a race — and the sequential answer is the misleading one. The sequential cross-invoice case has no test at all; the suite only covers the concurrent form.

**Fix when the Gateway endpoint lands (features 25/29):** in the fast path, compare the resolved invoice's identity against `request.invoiceId`/`request.invoiceReference` and raise `PaymentReferenceConflictError` when they differ — making the sequential path agree with the concurrent one — plus a named test for the sequential case. **Owner: implementer**, as a follow-up, not a re-review condition.

### N12 — informational — the impl record's pre-state count is off by one

**File:** `progress/impl_billing_remittance_intake.md:138`. Says *"ten orders `invoiced`"* and then lists **eleven** references (`-007, -008, -009, -010, -011, -018, -022, -024, -025, -026, -027`). The list is right and the prose count is wrong; nothing downstream depends on it. Same class as feature 21's N6. **Owner: implementer** (one word), or leave.

### N13 — informational — `ORD-000007` is permanently stranded, and it is now visible in demo data

**Evidence:** `otc_billing.invoices` INV-000010 = `paid` (2026-08-24 04:26:43), `payments` carries `PAY-LIVE-1787545602655` for 49998 EUR, `credit_items` for ORD-000007 shows `hold/consume/release` all 49998 — Billing's side is complete and correct — while `otc_orders.orders` ORD-000007 is still `invoiced`, because both facts were ignored as `unknown_order`.

Honestly disclosed by the implementer, correctly **not** "fixed" (repairing it would mean re-emitting a fact under a fabricated correlation id, which Billing must never do), and not a code defect. It is recorded here because it is now a property of the **shared dev database**: the read model and any Phase 11+ demo will show an order whose invoice is paid, whose credit is released, and which never completed — with no in-system explanation. Whoever prepares the demo should decide deliberately whether to reset the dev data or narrate this row. **Owner: leader**, as a data/demo decision.

### Carried forward from `billing_invoicing`, untouched and deliberately not re-raised
**N4** (BI8's lock log covers two of three locks), **N5** (the race spec cannot see a lock-order inversion), **N6** (the `attempts` figures), **N8** (BI1's guard is a text scan), **N9** (inter-test coupling in the parity spec).

**N10 is not repeated here** — probe 4. This feature split the two claims correctly and said so on the file itself. That is the single best thing about this submission.

---

## Notes on the review's own footprint

My ordering mutation rewrote the mtime of `apps/billing/src/application/payment-register.handler.ts` (06:45). The file was restored from a scratchpad copy and verified **md5-identical** to the submitted version (`8c045cacbf43719c3691c9d243ef7824`); that timestamp is not implementation activity. My temporary probe spec `apps/billing/src/__reviewer_probe.spec.ts` was deleted; `git status` confirms no trace. No source file was edited to fix anything, and nothing was committed.
