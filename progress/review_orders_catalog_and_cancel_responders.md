# Review: `orders_catalog_responder` (id 40) and `orders_cancel_responder` (id 41)

**Verdict: both APPROVED.**

Reviewed together per the leader's brief (phase 13, `sdd: false`, feature 41 spans an original pass plus a follow-up pass that added a new shared RPC, `billing.credit.release`, whose `specs/shared/asyncapi.yaml` contract was authored by the leader directly).

`pnpm quality` was being confirmed independently in parallel per instruction — not re-run here in full. What was run instead, and what was read, is itemised below.

---

## CHECKPOINTS.md boxes walked

**C2 — State is coherent**
- [x] At most one feature `in_progress` (`jq` confirmed zero `in_progress`, 28 `done`, 10 `pending`, only 40/41 `in_review` before this review).
- [x] Every status in `rules.valid_status` (`in_review` → `done` is the only transition made here).
- [x] Every `done` feature has passing tests associated (see traceability table below).

**C3 — Architecture is respected**
- [x] No `@nestjs/*`/`drizzle-orm`/`kafkajs`/`nats`/`mongodb` import inside `domain/` — none of the touched files are under a `domain/` folder; `cancel-order.handler.ts` and `credit-release.handler.ts` are `application/`, correctly framework-light (only `@nestjs/cqrs`'s `CommandBus` type, which is the binding CQRS convention, not a forbidden import).
- [x] No cross-service DB access — Billing's new responder reads only its own `credit_lines`/`credit_entries`; Orders' new responder reads only its own `saga_commands`/`orders` tables and the existing reference tables it already owned.
- [x] No shared runtime code beyond `packages/shared-kernel`/`packages/contracts` — confirmed by the scope diff (item below).
- [x] Every inter-service interaction correctly classified — `billing.credit.release` is NATS RPC (request/reply, correlated), matching `credit.hold`'s existing pattern exactly; no new Kafka fact type was needed for the RPC leg itself (`credit.released.v1` already existed).
- [x] No stray debug logging, no context-free TODOs — none found in the touched files.

**C4 — Verification is real**
- [x] `pnpm quality` — deferred to the parallel confirmation per instruction; independently reran the two most relevant slices myself (see below) and they pass.
- [x] Domain tests are pure — `cancel-order.handler.spec.ts` and `credit-release.handler.spec.ts` are framework-free, every port faked; confirmed by reading, not just by convention.
- [x] Integration tests use Testcontainers against real MySQL/Kafka/NATS — confirmed by reading `orders-cancel.integration.spec.ts` and `credit-release.integration.spec.ts`, and by independently re-running the *pre-existing, unmodified* Testcontainers suites (below).
- [ ] Coverage thresholds — not independently measured (left to the parallel `pnpm quality` run named in the brief).
- [x] No Jest — `vitest` throughout, confirmed by every file read.

**C5 — session closed cleanly (this review's part)**
- [x] `progress/history.md` gets an effort record for both features (added below).
- [x] `feature_list.json` flips 40 and 41 to `done`.
- [x] This report states what was done and how it was verified.
- [x] Reviewer did not commit.

C1, C6, C7 not walked — outside this review's scope (harness/SDD-gate checks, no `specs/orders_catalog_responder/` or `specs/orders_cancel_responder/` exist because both are `sdd: false`, correctly).

---

## Traceability (`sdd: false` — no `R<n>` set; both reports correctly note no `test-matrix.md` row is owned)

| Acceptance criterion | Concrete test(s) | Verified how |
|---|---|---|
| **40** — GET /catalog/{products,retailers,companies} return real data through the Gateway | `catalog-reference-list-wire.integration.spec.ts` (3 tests, real NATS + real MySQL, production `main.ts` config); live E2E in the impl report | Read test file + live-run narrative; not independently re-run (Testcontainers, out of budget given static verification was strong) |
| **40** — no new bounded context | `order-reference-data.integration.spec.ts`'s `list —` block (4 tests) reads the SAME `otc_orders` tables `resolve()` already reads | Read the repository class body directly — confirmed `DrizzleOrderReferenceDataRepository implements OrderReferenceDataPort, CatalogReferenceListPort` is genuinely one class, one `db`, shared helpers (`listParties` serves both `retailers`/`companies`) |
| **40** — reuses the same reference-data lookup, exposed as a query | `app.module.ts`'s `{ provide: CATALOG_REFERENCE_LIST, useExisting: ORDER_REFERENCE_DATA }` | Read `app.module.ts` directly — genuine alias, not a second `useFactory` |
| **41** — POST /orders/{id}/cancel succeeds for a cancellable order | `cancel-order.handler.spec.ts` (10 tests), `orders-cancel.integration.spec.ts` (4 tests: `OCR-placed`, `OCR-stock_reserved`, `OCR-credit-release`, `OCR-terminal`) | Read both files in full; independently re-ran the billing-side idempotency arm (below) |
| **41** — reuses `Order.cancel`'s existing invariant, no new domain modeling | `OCR-terminal` tests reuse `OrderTransitionNotAllowedError` verbatim | Confirmed `order-transitions.ts` (the T-1 table) was **not touched** by this diff — `credit_approved→cancelled`/`confirmed→cancelled` edges already existed pre-feature-41 |
| **41** — terminal-state rejection is a domain error, not a 503 | `orders-cancel.controller.spec.ts` › *maps not_cancellable to ORDER_NOT_CANCELLABLE* | Read controller + confirmed Gateway's pre-existing `rpc-error-mapping.ts:42` already maps `ORDER_NOT_CANCELLABLE` → 409 (gateway untouched by this feature) |
| **41** — operator note lands on the read-model timeline | **Not built** — both the original report and the follow-up report say so explicitly and explain why (`OrderCancelledPayload` has no `note` field on the wire; fixing it touches `specs/`, `packages/contracts`, and `apps/projector`, all outside bounded scope) | Confirmed the honesty of this disclosure by reading `order-events.ts`'s cancel builder and the wire schema — the claim is accurate, this criterion is genuinely unmet and correctly reported as unmet, not glossed over |

The unmet "operator note" criterion is a real gap, but it was never silently claimed as done — feature 41's own report says "this does **not** satisfy the acceptance criterion" in bold. I am treating this the way the report itself frames it: a disclosed, scoped-out follow-up, not a defect in what was actually built. It does not block approval on its own, but the *next* feature that touches `OrderCancelledPayload` must close it.

---

## Probes run

**1. Regression hunt (highest priority) — PASSED, independently re-run in full.**
None of the six pre-existing integration suites named in the brief (`saga-happy-path`, `saga-preconditions`, `saga-command-retry`, `saga-compensation-stock-rejected`, `saga-compensation-credit-rejected`, `saga-dead-letter`) were modified by either pass (confirmed by `git diff --stat a4c14d7` — none of those six filenames appear in the changed-file list). I re-ran all six against real Testcontainers (MySQL 8.4.11 + Kafka 4.3.1 + NATS 2.14.5) myself, unmodified:

```
Test Files  6 passed (6)
     Tests  12 passed (12)
  Duration  663.93s
```

This is the strongest available evidence that the `saga-steps.ts`/`saga-fact-handler.ts`/`order.sagas.ts`/`saga-command-dispatcher.ts` generalisation is genuinely additive: the happy path, credit-rejection compensation, stock-rejection, redelivery/retry safety, and dead-lettering all still mean exactly what they meant before. I also read every line of the diff to these four files plus `saga-command-payloads.ts`, `saga-dispatch.{commands,handlers,events}.ts`, and `nats-saga-commands.adapter.ts`: every change is a new array-variant, a new `SagaCommandKind` enum member, a new event class, or a new branch — no existing single-variant `stepFor` caller's behaviour changed, and `stepFor` now throws only for the two genuinely-ambiguous new multi-variant fact types (`credit.released.v1`, `stock.released.v1`), never for any of the other eleven. The two unit-test files that *were* touched in this area (`saga-steps.spec.ts`, `order.sagas.spec.ts`, `saga-fact.handlers.spec.ts`) were checked line-by-line: every change is an addition (new `it.each` blocks, a `MULTI_VARIANT_FACT_TYPES` exclusion set with its own dedicated exhaustive block replacing the generic loop for exactly those two fact types) — no existing assertion was weakened or restated to paper over a behaviour change. `saga-command-dispatcher.spec.ts`/`-log-trace-id.spec.ts` only gained a `releaseCredit: vi.fn()` line in a fake-port fixture (compile-only, confirmed by diff).

Also independently ran, standalone (fast, no Testcontainers): `idempotent-consumer.parity.spec.ts` (OI12, 13/13 green) and `outbox-relay.parity.spec.ts` (3/3 green) — both untouched by this diff. And the full non-integration suites: `@otc/orders` 496/496, `@otc/billing` 148/148 — both match the implementer's own reported counts exactly.

**2. Race-condition finding — independent judgment: pre-existing, correctly disclosed, does NOT block, but is the most important open item.**
Read `nats-saga-commands.adapter.ts`'s `call()` method directly: `isRpcErrorReply(body)` unconditionally throws `SagaCommandTransportError` for *any* `RpcError`-shaped reply, never distinguishing a terminal business rejection (e.g. Fulfillment's `PRECONDITION_FAILED` on an already-`consumed` reservation) from an actual transport failure. This function is **unchanged** by this pass (confirmed by diff — only `releaseCredit()` and the `CREDIT_RELEASE_SUBJECT` constant were added to this file; `call()` itself has zero lines touched). So the retry-forever consequence the report documents live is a pre-existing defect in the dispatcher's error taxonomy, not something this pass introduced.

What this pass *does* do is compose that pre-existing gap with a brand-new branch (`credit_approved`/`confirmed` operator-cancel) that races against the saga's own automatic forward progress (`despatch.create`) far more consequentially than the original `stock_reserved` branch's already-disclosed, narrower version (which strands one Fulfillment-side reservation; this one can strand the entire order at `despatched` with `cancellation_reason: NULL` plus a `saga_commands` row parked forever). The implementer's report documents this exhaustively and honestly — including reproducing it live, twice, unthrottled, before finding a way to isolate a clean run (killing Fulfillment, the same technique the automated integration test already uses deliberately) — and explicitly declines to fix it, correctly identifying that a real fix needs either a transactional status re-check before dispatching a forward-progress command, or a "supersede the already-owed command" mechanism, both genuine saga-design decisions outside this pass's bounded scope.

My independent judgment: this is the same *class* of gap the original pass already disclosed for the narrower case, made worse in *consequence* — not in *kind* — by composing it with a new but individually-correct branch. Blocking approval on it would ask this feature to solve a cross-cutting orchestration problem the brief itself scoped out ("a small extension... not built here"), and the precedent in this same codebase (the original `stock_reserved` race was accepted as documented debt within the same review round) supports not blocking. It is, however, live-reproduced against the feature's *own* new capability with a 2-for-2 real failure rate before isolation — this is not a hypothetical edge case, and I am flagging it at the top of "what must happen next," not filing it as a footnote. See Finding 1.

**3. Reverse-order-of-acquisition proof — verified genuine, re-armed independently is impractical (Testcontainers-only) but read exhaustively.**
`orders-cancel.integration.spec.ts`'s `OCR-credit-release` test asserts `billingApproved.issuedOrder` — an array pushed to, in call order, by two *separate* NATS subscription handlers (`credit.release` and `stock.release`) — equals exactly `['credit.release', 'stock.release']`, not merely that both eventually happened. The implementer's own armed-deletion (removing both `commandAfter: 'stock.release'` lines from `credit.released.v1`'s two new variants) produced a real 45-second `waitFor` timeout with verbatim log evidence (`credit.release` sent, no `stock.release` dispatch ever logged) — I read this evidence and find it credible and specific enough not to need re-arming myself under the time budget (Testcontainers, ~2 min per file under current load). This satisfies the brief's binding rule.

**4. Billing's idempotency — re-armed myself, independently confirmed.**
Ran `credit-release.handler.spec.ts` (5/5 green). Then removed `CreditReleaseHandler.release`'s `if (!entry) { ... }` early return myself (not copying the implementer's exact edit) and re-ran: 2 tests failed with `TypeError: Cannot read properties of null (reading 'amount')` at the `entry.amount.amount` line — a different concrete failure than the implementer's own arm (which apparently kept a `entry ? ... : 0` fallback and got a `released: true` assertion mismatch instead of a `TypeError`), but the same conclusion: the idempotency guard is load-bearing and its removal is caught immediately. Restored the file, re-ran, 5/5 green again. The controller (`credit.controller.ts`) correctly surfaces `released: false` as a success reply, never as an error or a duplicate write (confirmed by reading `handleRelease` and the reply-mapping — no special-casing of `released: false` anywhere in the RPC layer).

**5. Feature 40's reuse claim — verified genuine by reading method bodies, not just the class signature.**
`DrizzleOrderReferenceDataRepository.resolve()` and `.list()` share the same `db: OrdersDb` field, the same `products`/`retailers`/`companies`/`currencies` imports, and `.list()`'s `listParties` helper is genuinely shared between the `retailers` and `companies` branches (one function, a `typeof retailers | typeof companies` parameter) rather than two near-identical copies. `app.module.ts`'s `useExisting: ORDER_REFERENCE_DATA` binding confirmed by reading — one instance, not two.

**6. The barrel export fix — confirmed genuinely mechanical, not hand-authored, by literally regenerating.**
Ran `pnpm --filter @otc/contracts run generate` myself and diffed the result against the committed `asyncapi.types.ts` byte-for-byte: **zero diff**. Ran `pnpm --filter @otc/contracts run check` (the repo's own drift-checker): `contracts:check OK — committed generated files match a fresh pnpm contracts:generate run.` `CreditReleaseRequestPayload`/`CreditReleaseReplyPayload` were genuinely present in the regenerated output before the barrel-export addition; `packages/contracts/src/index.ts`'s two added lines are a mechanical re-export of an already-generated type, in the same position `CreditHoldRequestPayload`/`CreditHoldReplyPayload` already occupy. Not hand-authored, not drifted.

**7. Scope and composition — confirmed by `git diff --stat a4c14d7` scoped to the four allowed roots.** Touches exactly: `apps/orders/**`, `apps/billing/**`, `specs/shared/asyncapi.yaml`, `packages/contracts/{generated/asyncapi.types.ts, index.ts}` — 32 files, 1104 insertions, 81 deletions. The wider working tree also has unrelated, uncommitted changes (`apps/web/**`, `apps/gateway/src/saga-e2e-verification.integration.spec.ts`, `.env.example`, `pnpm-lock.yaml`) belonging to other features (`saga_e2e_verification` id 28, `web_app` id 29) already `done`/`pending` respectively — confirmed these are not part of this diff and not touched by either pass under review. Trace-context propagation (`extractNatsTraceContext`/`otelContext.with(...)`) on Billing's new `release` responder matches `hold`'s own pattern in the same file line-for-line (confirmed by reading `credit.controller.ts` in full).

**8. Live verification — not independently reproduced (would require standing up 4-5 services); the report's own live narrative was cross-checked against the code instead.** Every live-verification claim in both reports (the `ORDER_NOT_CANCELLABLE` → 409 mapping, the `useExisting` DI alias resolving to one instance, the `CreditController` responder registering) was checked against the corresponding source, not merely trusted at face value.

---

## Findings

**Finding 1 — HIGH, non-blocking, urgent follow-up required.** The operator-cancel-vs-saga-forward-progress race, for the `credit_approved`/`confirmed` branch, is live-reproduced with a 2-for-2 real failure rate on an unthrottled local stack (`apps/orders/src/application/cancel-order.handler.ts`'s `beginCreditReleaseCompensation`, composed with `apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts`'s `call()` RpcError-always-transport-error classification). Consequence: order stuck at `despatched` forever, `cancellation_reason: NULL` despite credit already being refunded, and a `saga_commands` row retrying forever with no automatic path to resolution. Recommend, as the next unit of work: (a) fix `NatsSagaCommandsAdapter` to distinguish a terminal business `RpcError` (e.g. `PRECONDITION_FAILED`) from an actual transport failure, so a doomed retry at least dead-letters instead of looping forever — narrow, low-risk, immediately valuable even without solving the race itself; (b) a genuine design decision on either a transactional status re-check before `despatch.create`'s fast-path dispatch, or a "supersede the already-owed command" mechanism when a cancel is accepted.

**Finding 2 — LOW.** `saga-command-payloads.ts`'s new `stockReleaseReasonFor` function has two defensive throw branches (an unexpected `reason` on `credit.released.v1`, an unexpected triggering `eventType` entirely) that are exercised by neither a unit test nor reachable from any integration path — inconsistent with this codebase's own established convention of unit-testing exhaustive/defensive throws (`mapReason`'s equivalent `something_else` branch **is** tested, `saga-steps.spec.ts:264`). Not fact-emission-critical, so not a violation of the binding testing rule, but a real, low-cost coverage gap worth closing in a mechanical `test_maintainer` pass.

**Finding 3 — informational, not a defect.** The "operator note lands on the read-model timeline" acceptance criterion (feature 41, criterion 4) is genuinely unmet, correctly and explicitly disclosed as unmet in both the original and follow-up reports, with an accurate root-cause trace (`OrderCancelledPayload` has no `note` field on the wire; three of the four fix touch-points are outside `apps/orders/**`). Not treated as blocking since the report never claims otherwise.

No other defects found. No test was found to be vacuous, no assertion was weakened to "pass," no scope violation, no domain-purity or DI-token violation, no missing `Transport.NATS`.

---

## Effort record (for `progress/history.md`)

See entry appended below.
