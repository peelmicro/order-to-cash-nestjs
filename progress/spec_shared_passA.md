# Pass A — `specs/shared/` (stack-agnostic trilogy core)

**Agent:** `spec_author`
**Date:** 2026-08-18
**Feature:** `shared_spec` (Phase 3, Step 4)
**Scope:** Pass A only — the three prose specifications. Pass B (`asyncapi.yaml`,
`openapi.yaml`, `test-matrix.md`, `n8n-workflows.md`) was explicitly out of scope
for this pass.

---

## 1. Files created

| File | Lines | Contents |
|---|---:|---|
| `specs/shared/domain-model.md` | 542 | 4 bounded contexts + 2 non-context components; 5 value objects with invariants (`Money`, `Quantity`, `OrderNumber`, `GLN`, `UniqueId`); 5 aggregate roots (`Order`, `StockItem`, `DespatchAdvice`, `BuyerCredit`, `Invoice`) with 3 child entities; 26 numbered invariants (M1–M4, O1–O8, F1–F8, B1–B10); the Order state machine (12-row transition table + Mermaid + explicit illegal-transition rule); the Invoice state machine (4-row table + Mermaid + illegal-transition rule); the stock reservation lifecycle (Mermaid + transition table); the envelope contract; the catalogue of all 13 facts with producing context and payload essentials; the consumption map; 6 cross-cutting model rules; explicit out-of-model list |
| `specs/shared/saga.md` | 392 | Saga shape and why both transports; the 7-command RPC vocabulary (commands, not facts); the happy path as an 8-row numbered table (trigger → precondition → orchestrator action → command → fact → resulting status); Mermaid sequence diagram for the happy path; both compensation paths as tables; a dedicated **compensation-ordering** section with 4 normative reasons plus a generalised reverse-order-of-acquisition table (5 failure points incl. operator cancellation); Mermaid sequence diagram for the `CreditRejected` compensation; the fact consumption map (orchestrator / projector / notifications); idempotency as 3 independent defence layers plus a 10-row per-fact redelivery table; ordering guarantees claimed and *not* claimed; a 6-row failure-handling table |
| `specs/shared/requirements.md` | 524 | 60 EARS requirements `R1`–`R60`, notation table, vocabulary, requirement index, per-feature sections, a coverage-notes table mapping every concern and every invariant to its requirement, and a "left to Pass B" section |
| `progress/spec_shared_passA.md` | this file | The record |

Nothing else was created or modified. No application code, no tests, no
`feature_list.json` edit, no commit.

## 2. Requirement count and distribution

**60 requirements**, ids `R1`–`R60`, contiguous and verified by script.

| # | Feature heading | Ids | Count |
|---|---|---|---:|
| 1 | `orders_aggregate` | R1 – R10 | 10 |
| 2 | `outbox_and_idempotency` | R11 – R18 | 8 |
| 3 | `order_saga_orchestrator` | R19 – R29 | 11 |
| 4 | `fulfillment_stock` | R30 – R36 | 7 |
| 5 | `billing_credit` (R37–R41) **+ simulator affordance (R42–R44)** | R37 – R44 | 8 |
| 6 | `billing_invoicing` | R45 – R49 | 5 |
| 7 | `projector_read_model` | R50 – R55 | 6 |
| 8 | `observability_reliability` | R56 – R60 | 5 |
|   | **Total** | | **60** |

EARS pattern spread: Ubiquitous, Event-driven (WHEN), State-driven (WHILE),
Unwanted (IF-THEN) and Optional (WHERE) are all used; the Optional pattern is
reserved for the two simulator-affordance requirements (R42, R43), which is
exactly what it is for — behaviour that exists only *where* a particular adapter
is bound.

### Mandated coverage — where each item landed

| Mandated coverage | Requirements |
|---|---|
| Every legal state transition | R8, R19–R24, R26, R28, R45, R46, R32–R36 |
| Every illegal state transition | R7, R9, R25, R35, R46 |
| Every aggregate invariant | full invariant→requirement map in `requirements.md` §9 |
| Both compensation paths | R26 (`StockRejected`), R27 + R28 (`CreditRejected`, ordering explicit) |
| Outbox atomicity, no dual-write | R13, R14 |
| Consumer idempotency under redelivery | R17, R18 (+ R25 state guard, R29 command idempotency) |
| DLQ after N attempts | R16 (consumers), R29 (saga commands) |
| Read-model projection idempotency | R51 |
| Out-of-order tolerance | R50, R52, R53 |
| Trace propagation across both brokers | R56, R57 |
| Money always integer minor units | R1, R2 |

## 3. Stack-agnosticism check

Grepped `specs/shared/` for `nest`, `drizzle`, `nuxt`, `mysql`, `typescript`,
`npm`, `pnpm`, and additionally for `mongo`, `kafkajs`, `vitest`, `playwright`,
`shadcn`, `vue`, `angular`, `fastapi`, `.net`, `postgres`, `node`, `redpanda`,
`jaeger`, `grafana`, `prometheus`, `varchar`, `.ts`.

- **Zero real hits.** The only matches were the substring `nest` inside
  *"honest" / "honestly"* (2 occurrences) — false positives, left as they are.
- `Kafka` and `NATS` appear **6 times total**, all inside the reading-conventions
  / vocabulary blocks that name the chosen brokers once and then hand over to the
  neutral terms **fact stream** and **RPC transport**, which is what the
  normative text uses throughout. Naming the two brokers is permitted: all three
  assessments use them.
- `n8n` appears once, as the filename `n8n-workflows.md` in the Pass B list.
- `JSON` appears once, as a schema-language name in the Pass B list.
- No storage types anywhere: fields are typed `Money`, `Quantity`, `GLN`,
  `UniqueId`, `Instant`, `Text` — never `int`, `varchar`, `datetime`, `number`.
- **No DDL.** The plan document's tables were read as the #7 *realisation* and
  deliberately re-expressed as a conceptual model. Where the plan has a
  `credit_items` table with a `type` column, this spec has a `CreditLedgerEntry`
  child entity with a closed `hold | consume | release` set and derived
  quantities.

## 4. Ambiguities found in the Task document, and how they were resolved

| # | Ambiguity | Resolution | Where recorded |
|---|---|---|---|
| 1 | **Which fact drives `paid` and which drives `completed`?** The Task says *"`PaymentReceived` → Billing marks the invoice `paid` and releases the credit hold (`CreditReleased`) → orchestrator marks order `paid` and closes the saga (`completed`)"* — one bullet, two facts, two order transitions, no explicit pairing. | Split cleanly: `payment.received.v1` → `paid`; `credit.released.v1` → `completed`. Billing writes both outbox records in **one transaction, in that order, on the same partition key**, so the orchestrator can rely on the sequence without a cross-context ordering assumption. | `requirements.md` R24; `saga.md` §3.1 steps 6–7 and §6 "Ordering guarantees" |
| 2 | **From which status does `CreditRejected` compensation cancel, and in what order?** The Task gives the sequence but not the intermediate order status, so "cancel then release" would also read as compliant. | Made **release-then-cancel** normative and argued it: the order stays `stock_reserved` until `stock.released.v1` arrives, because `cancelled` is terminal and cancelling first would strand a live reservation with no non-terminal state left to retry from. | `requirements.md` R27, R28; `saga.md` §4.3 (four numbered reasons) |
| 3 | **Does the RPC response or the fact advance the saga?** The Task's happy-path bullets mix "issues NATS RPC X → service does Y, emits Z", which can be read either way. | Made it a single hard rule: **a command response never advances the saga**; it is used only to decide whether to retry. Only facts move the state machine, because only facts are durable, replayable and observed by the projector and notifications. | `saga.md` §2 (boxed rule), R19 |
| 4 | **`credit_approved` vs `confirmed`** — the Task treats `CreditApproved` as producing both, with no statement about whether `credit_approved` is a real observable state. | Both are real, legal edges of the transition table, performed in one handler / one aggregate save, both recorded in the timeline. Rejected the alternative of collapsing them, which would have made the state machine in the Task's own diagram wrong. | `domain-model.md` Table T-1 rows 3–4; `saga.md` §3.1 note |
| 5 | **What does `CreditReleased` mean at invoice-issue time?** The plan's ledger has `hold`, `release` **and** `consume` with `consume` at invoice issue, but `credit.released.v1` is only listed as emitted at payment and at compensation. | `consume` converts a hold into open-invoice exposure and is **numerically neutral** on available credit, so it emits **no** fact. Only a genuine return of credit — invoice paid, or order cancelled while holding — emits `credit.released.v1`, with a `reason` field distinguishing them. | `domain-model.md` §5.1 derived quantities; R40, R41 |
| 6 | **Is a release needed on `StockRejected`?** The Task says "no release needed" without saying why, which invites an implementation that "releases defensively". | Grounded it in an invariant: reservation is **all-or-nothing** (F3), so `stock.rejected.v1` means nothing was reserved. R26 states the prohibition positively — the orchestrator **shall not** issue a release — so it is testable, not merely omitted. | R26, R33; `saga.md` §4.1 |
| 7 | **Operator cancellation** (`orders.cancel`, "pre-`despatched` only") has no compensation story in the Task, though it can fire *after* stock is reserved and credit is held. | Added the general rule: compensation unwinds acquisitions in **reverse order of acquisition**, and only those that actually succeeded — with a 5-row table covering each cancellation point. Cancelling from `credit_approved`/`confirmed` releases credit first, then stock. | `saga.md` §4.3 generalisation table; R41 |
| 8 | **`.99` rule status** — the Task states it inside the Billing domain paragraph, which reads as a domain rule. | Isolated it under its own subheading with a boxed warning: it is a **simulator affordance behind the credit port**, a demo determinism device, explicitly **not** a credit policy, and #8/#9 **must** reproduce it identically or compensation stops being demoable and the shared test matrix stops being portable. R44 additionally requires simulated and genuine rejections to be indistinguishable downstream. | `requirements.md` §5.1 (R42–R44) |
| 9 | **`CREDIT_FAILURE_RATE` out-of-range behaviour** unspecified. | **Fail fast at startup** and report the offending value, rather than clamping or silently defaulting — a silently clamped rate would make a demo non-reproducible for reasons invisible in the logs. | R43 |
| 10 | **Redelivery of `credit.rejected.v1` while compensation is in flight** — the dedup record may be missed if the consumer crashed between issuing the release and committing. | Layered defence: the release command is idempotent, and a release against an already-released order is a **success no-op with no second fact** (F5/R34), so a duplicate cannot double-decrement or produce a phantom timeline entry. | R34; `saga.md` §6 redelivery table |
| 11 | **What happens to a fact that arrives with the wrong precondition** — the Task only implies it via "the orchestrator is idempotent". | Made it an explicit, testable Unwanted requirement: no state change, no command, no fact, **and** a recorded "ignored" entry naming observed vs expected status — so it is observable in a test and in the timeline rather than a silent drop. | R25 |
| 12 | **Read-model behaviour before the first projection.** The Task asks for eventual consistency "handled honestly in the UI" without specifying the API contract. | The query side returns an explicit **"projection pending"** indication rather than a 404, so the honesty is in the contract and testable, not only in the UI copy. Also specified placeholder-document creation for facts that outrun `order.placed.v1`. | R53, R55 |
| 13 | **Notifications fact subset** overlaps the projector's; the Task lists 7 of 13 without a rationale. | Kept the Task's exact 7 and gave the rationale: `stock.*` and `credit.*` are internal saga mechanics, and their outcome reaches the counterparty as `order.cancelled.v1` with its reason. | `domain-model.md` §7.3; `saga.md` §5 |

## 5. Deliberately left for Pass B

- `specs/shared/asyncapi.yaml` — fact topic names, the three `.dlq` companions,
  every RPC subject, the envelope schema and all 13 payload schemas. The payload
  *essentials* are already fixed in `domain-model.md` §7.2 so Pass B is a
  formalisation, not a design decision.
- `specs/shared/openapi.yaml` — the gateway REST contract.
- `specs/shared/test-matrix.md` — the `R1`–`R60` → named-test mapping, all rows
  initially `TODO`. **Every one of the 60 ids must appear there at least once**;
  `requirements.md` §9 is the checklist to build it from.
- `specs/shared/n8n-workflows.md` — functional spec of the four demo workflows.
- Concrete tunables intentionally not fixed in Pass A, only their existence and
  observable consequences: consumer retry count and backoff schedule, outbox
  poll interval, RPC timeout, business-reference sequence width. Each assessment
  fixes them in a `design.md`.

## 6. Notes for the leader

- `feature_list.json` was **not** touched — status is the leader's call.
- Nothing was committed or pushed.
- The eight feature headings in `requirements.md` match the `"sdd": true`
  feature names in `feature_list.json` exactly, so each per-feature
  `specs/<feature>/requirements.md` can cite its own `R<n>` range verbatim
  instead of restating it.
