# Pass B — `specs/shared/` (contracts, traceability, demo automation)

**Agent:** `spec_author`
**Date:** 2026-08-18
**Feature:** `shared_spec` (Phase 3, Step 4)
**Scope:** Pass B only — the four artefacts left open by Pass A. The three Pass A
prose files were **read as input and not modified** (verified: unchanged
mtimes).

---

## 1. Files created

| File | Lines | Contents |
|---|---:|---|
| `specs/shared/asyncapi.yaml` | 3 549 | AsyncAPI **3.0.0** messaging contract — both transports, 3 fact topics + 3 DLQ companions, all 13 facts, the shared envelope, the DLQ record with its diagnostic headers, and all 14 request-reply subjects with request **and** reply schemas |
| `specs/shared/openapi.yaml` | 1 895 | OpenAPI **3.1.0** Gateway REST contract — every endpoint of the plan's table, JWT bearer security, the SSE endpoint documented honestly, payment idempotency by `paymentReference`, money as integer minor units throughout |
| `specs/shared/test-matrix.md` | 195 | 60 rows, `R1`–`R60`, grouped by the eight features, every row naming a test file **and** a case name, all `TODO` |
| `specs/shared/n8n-workflows.md` | 398 | Functional spec of the four demo workflows, the Gateway-only rule, ~30 environment switches, the disable/remove contract, the porting contract |
| `progress/spec_shared_passB.md` | this file | The record |

Nothing else was created or modified. No application code, no tests, no
`feature_list.json` edit, no commit, no push.

## 2. `asyncapi.yaml` — counts

| Item | Count | Detail |
|---|---:|---|
| Servers | 2 | `factStream` (kafka protocol), `rpcTransport` (nats protocol) |
| **Channels** | **34** | 3 fact topics + 3 `.dlq` companions + 14 RPC request channels + 14 RPC reply channels |
| **Operations** | **32** | 3 fact `send` (outbox relay per context) + 9 fact `receive` (3 topics × `orders.saga`, `projector`, `notifications`) + 3 DLQ `send` + 3 DLQ `receive` + **14 RPC `send` with a `reply` object** |
| **Messages** | **43** | **13 facts** + 1 `DeadLetterRecord` + 14 requests + 14 success replies + 1 shared `RpcErrorReply` |
| Schemas | 95 | Incl. 13 payload schemas, 13 event schemas composing the envelope, 21 reusable primitives/value objects, 8 shared read views |
| `correlationId` components | 2 | `orderCorrelationId` (`$message.payload#/correlationId`), `rpcCorrelationId` (header) |

**Fact topics and their consumers** (verbatim from the plan's "Messaging
design"): `otc.orders.facts.v1`, `otc.fulfillment.facts.v1`,
`otc.billing.facts.v1`, each with `.dlq`. Producer, consumer set and the reason
for each consumer's subset are documented on every operation.

**All 14 RPC subjects** are present, each with request schema, success reply
schema, the shared error reply, and an explicit `RpcTimeout` contract schema
documenting that a timeout is the *absence* of a reply and how R29 handles it:
`orders.create`, `orders.cancel`, `fulfillment.stock.check`,
`fulfillment.stock.reserve`, `fulfillment.stock.release`,
`fulfillment.stock.list`, `fulfillment.stock.replenish`,
`fulfillment.despatch.create`, `billing.credit.hold`, `billing.credit.list`,
`billing.invoice.issue`, `billing.invoice.list`, `billing.payment.register`,
`catalog.reference.list`.

**DLQ record shape:** payload is the **unmodified original envelope** (so a
redrive is a byte-for-byte republish); the failure lives entirely in headers —
`x-failed-consumer`, `x-attempts`, `x-error` (all required) plus
`x-original-topic`, `x-first-failed-at`, `x-failed-at`, `traceparent`.

**Reuse:** `Money`, `MinorUnits`, `OrderLine`, `Gln`, `PartyRef`, `Party`,
`ReservationRef`, `Shortage`, `DespatchLine`, `InvoiceLine`, `PageInfo`,
`Envelope`, `FactHeaders`, `RpcHeaders` are defined once and referenced. No
field list is copy-pasted; every fact schema is `allOf: [Envelope, {const
eventType, payload}]`.

**Validation:** official `@asyncapi/parser` → **valid document, 0 errors,
0 warnings**. (The `@asyncapi/cli` package could not be installed — an upstream
`@asyncapi/studio-ui@0.5.0` 404 — so the parser it wraps was used directly.)
A separate script also verified that all 632 local `$ref`s resolve and that every
`operations.*.messages` entry points at a message **of its own channel**, which
is the AsyncAPI 3.0 rule most easily got wrong.

## 3. `openapi.yaml` — counts

| Item | Count |
|---|---:|
| Paths | **17** |
| Operations | **18** (`/orders` carries both `POST` and `GET`) |
| Schemas | 57 |
| Reusable responses | 7 |
| Reusable parameters / headers | 5 / 1 |

Endpoints, in the plan's order: `POST /auth/login`, `GET /auth/me`,
`POST /orders`, `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`,
`GET /orders/stream`, `GET /stock`, `GET /invoices`,
`POST /invoices/{id}/payments`, `GET /credits`, `POST /stock/replenish`,
`GET /catalog/products`, `GET /catalog/retailers`, `GET /catalog/companies`,
`GET /health/live`, `GET /health/ready`, `GET /docs`.

- **Security:** `bearerAuth` (http/bearer/JWT) applied globally; `security: []`
  on `POST /auth/login`, both health probes and `/docs`. Every other operation
  documents `401`.
- **SSE:** `GET /orders/stream` produces `text/event-stream`, documents the
  frame format, the four event names (`order.updated`, `timeline.appended`,
  `stream.ready`, `ping`) with a `data` schema each, the `Last-Event-ID`
  reconnect **and its two honest limits** (bounded replay buffer →
  `resumed: false` and re-fetch; at-least-once → deduplicate on `eventId`).
- **Payment idempotency:** a five-row table on the operation fixes
  `201` accepted / `200 duplicate` (original outcome, no second payment, no
  second fact) / `409 PAYMENT_REFERENCE_REUSED` / `409 INVOICE_ALREADY_PAID` /
  `422 PAYMENT_MISMATCH`, tied to R48 and R49.
- **Money:** `Money` object where an amount travels alone, `MinorUnits` integer
  where the enclosing object declares `currency`. Grep confirms **no**
  `type: number`, `format: float` or `format: double` anywhere in either YAML.
- **Consistency with AsyncAPI:** 23 schema names appear in both files; a script
  compared `type`/`enum`/`pattern`/`format`/`required`/`const` for each — **zero
  differences**. (One collision was found and fixed during the pass: AsyncAPI had
  `Party` meaning the short reference; it is now `PartyRef`, with `Party` and
  `Product` meaning the same full shapes as in OpenAPI.)
- **Validation:** `redocly lint` → *"Your API description is valid"*, 9 style
  warnings, all deliberate: 1 × missing license URL (no URL exists), 1 × server
  URL is `localhost` (that is the composed stack), 3 × health/docs operations
  have no `4xx` response (they legitimately have none), 4 × the SSE `data`
  schemas are "unused" because they are referenced from `x-sse-events`, which
  the linter does not traverse.

## 4. `test-matrix.md` — all 60 requirements present

**Verified by script:** 60 rows, ids `R1`–`R60`, **contiguous, unique, none
missing, none duplicated**, cross-checked against the 60 ids in
`requirements.md`.

| Group | Ids | Rows |
|---|---|---:|
| 1. `orders_aggregate` | R1 – R10 | 10 |
| 2. `outbox_and_idempotency` | R11 – R18 | 8 |
| 3. `order_saga_orchestrator` | R19 – R29 | 11 |
| 4. `fulfillment_stock` | R30 – R36 | 7 |
| 5. `billing_credit` | R37 – R44 | 8 |
| 6. `billing_invoicing` | R45 – R49 | 5 |
| 7. `projector_read_model` | R50 – R55 | 6 |
| 8. `observability_reliability` | R56 – R60 | 5 |
| **Total** | | **60** |

- Every row is `TODO`; the preamble states the gate — **a feature cannot be
  marked `done` until every one of its rows is green**, and a renamed test means
  an edited row.
- Levels used: domain unit (26 rows), integration (30), API (6), e2e (2), web
  component (1); 5 rows name a second test at a second level where one level
  genuinely cannot prove the requirement.
- Paths are stack-neutral (`orders/domain/order-state-machine.spec`,
  `api/payment-idempotency.spec`), with a mapping table so #8 and #9 apply their
  own file conventions without touching the ids or the case names.

## 5. `n8n-workflows.md`

Four workflows — order generator (cron ~45 s, `ORDER_GENERATOR_COMPENSATION_RATIO`
default `0.15` engineered to total `.99`), payment robot (cron ~120 s, pays
`issued` invoices older than `PAYMENT_AGE_MINUTES`), stock replenishment (cron
~300 s, tops up items the Gateway reports below threshold), burst (manual
webhook, `BURST_ORDER_COUNT` default 20).

Each has: trigger, schedule, the exact Gateway endpoints, inputs, expected
effects, and its environment switches (~30 variables in total, all defaulted).
The document states **in §1, as its opening rule**, that the workflows call only
the Gateway public REST API — never a database, never a broker — and that this
is exactly why porting to #8/#9 is a change of **one value**, `OTC_GATEWAY_URL`.
§7 specifies the three levels of "off" (per-workflow flag,
`N8N_WORKFLOWS_ENABLED`, compose profile), why removing the engine entirely
cannot break the stack, and the verification step that proves it.

The `.99` engineering is specified as integer arithmetic on minor units with a
local assertion before sending, and is explicitly labelled as exploiting the
**simulator affordance** of `requirements.md` §5.1 — not a credit policy.

## 6. Stack-agnosticism check

Grepped all four new files for `nest`, `drizzle`, `nuxt`, `mysql`, `typescript`,
`pnpm`, `kafkajs`, `npm`, `vue`, `playwright`, `vitest`, `mongo`, `postgres`,
`redpanda`, `swagger`, `terminus`, `supertest`, `jest`, `node.js`, `dotnet`,
`fastapi`.

- **Zero real hits.** The only `nest` matches are the substrings inside
  *honest / honestly / honesty* (6) and inside `TimelineStreamEntry`
  (`…li**neSt**reamEntry`, 3) — false positives, left alone.
- `Kafka` appears 23 times and `NATS` 4 times, **only in `asyncapi.yaml`**, and
  almost all of them are the protocol identifier and the mandatory `kafka:`
  binding keys. Permitted: all three assessments use both brokers. The other
  three files name neither.
- No storage types, no ORM concepts, no language types. Test paths carry no
  extension and no build-tool directory.

## 7. Inconsistencies and tensions found — flagged, not silently fixed

Pass A files were **not** edited. Four items for the leader:

1. **`fulfillment.stock.replenish` has no requirement behind it.** The plan's
   REST table has `POST /stock/replenish` backed by that subject, but the
   subject is missing from the plan's own NATS subject table, and **no `R<n>` in
   Pass A covers replenishment**. Pass B specifies both (endpoint and subject,
   documented as emitting no fact and touching `units` only, so invariant F1
   cannot break). Consequence: `POST /stock/replenish` is the one write endpoint
   with **no row in the test matrix**, because the matrix is requirement-indexed.
   Options: accept it as a demo affordance, or add a requirement in a later pass.
2. **Real-time transport: shared or per-assessment?** `requirements.md` §10 says
   "the real-time transport choice" is "specified per assessment", but the
   plan's Gateway table fixes SSE and `openapi.yaml` is reused **verbatim** by
   #8 and #9 — so publishing `GET /orders/stream` as `text/event-stream` in the
   shared contract effectively fixes it for the trilogy. Pass B followed the
   plan (SSE, with `Last-Event-ID`). If the leader prefers §10's reading, the
   endpoint should move to a per-assessment overlay.
3. **Payment `source` vocabulary.** The plan's `payments` table says
   `operator | n8n | test`; Pass A's `domain-model.md` §5.2 says
   `operator | robot | test`. **Pass A was followed** (`robot`) — it is the
   vendor-neutral term and naming the workflow engine inside a domain enum would
   leak a demo tool into the shared contract. `n8n-workflows.md` therefore
   specifies `source: robot`.
4. **Three Pass B decisions that Pass A left open** (recorded so #8/#9 do not
   re-litigate them): R55's "projection pending" is realised as **HTTP 202** with
   a `ProjectionPending` body and a `Retry-After` header (not a 404, not a 200
   with a stub); `POST /orders` answers **409** when the acceptance-time
   availability check fails, per the plan; and the money representation rule is
   stated once and applied identically in both YAML files (`Money` object when an
   amount travels alone, bare `MinorUnits` integer when the enclosing object
   already declares `currency`).

No contradiction *internal to* the three Pass A files was found: the 13 facts,
the envelope, both state machines, the consumption map and the compensation
ordering are mutually consistent, and every payload essential listed in
`domain-model.md` §7.2 is present in the AsyncAPI schemas with the same field
names.

## 8. Deliberately deferred

- **Broker tuning** — partition counts, retention, consumer-group names, acks,
  replication. Named nowhere in `asyncapi.yaml` beyond the binding stubs;
  belongs in each assessment's `design.md`.
- **Concrete tunables** already deferred by Pass A and still deferred: consumer
  retry count and backoff schedule, outbox poll interval, RPC timeout, business
  reference sequence width. Only their existence and observable consequences are
  contractual (R16, R29, R59).
- **Rate limits, pagination maxima beyond 200, and auth token lifetime** are
  documented as fields but not fixed to values.
- **The 9 Redocly style warnings** were left as-is with the rationale in §3
  rather than papered over with a fake license URL or an invented `4xx` on a
  health probe.
- **Per-feature `specs/<feature>/` triplets** (`requirements.md`, `design.md`,
  `tasks.md`) for the eight `"sdd": true` features — the next spec task, not
  this one.

## 9. Notes for the leader

- `feature_list.json` was **not** touched — status is the leader's call.
- Nothing was committed or pushed.
- `specs/shared/` is now complete: 7 files, ~7 500 lines, the trilogy contract
  #8 and #9 inherit unchanged.

---

## 10. Post-review amendments (accepted 2026-08-18)

The three items flagged in §7 were taken through the **human approval gate** and
approved ("accept all"). Applied surgically to `specs/shared/`; `R1`–`R60` were
left byte-identical, `domain-model.md` and `saga.md` untouched, and the payment
`source` value `robot` (§7.3) confirmed as correct and left alone.

| # | Flagged in §7 | Decision | Edit |
|---|---|---|---|
| 1 | `fulfillment.stock.replenish` had no requirement behind it | **Add a requirement** — it mutates stock, so it needs one | New **R61** at the end of `requirements.md` §4 `fulfillment_stock` (id 61 keeps numbering contiguous; a note records why the section reads R30 – R36, R61). It fixes: on-hand `units` increase only, `reservedUnits` and every reservation untouched, invariant **F1** still held, **no fact emitted**, **no order advanced**, operator / demo-workflow driven. Index table: `fulfillment_stock` 7 → 8, total **60 → 61** |
| 2 | §10 said the real-time transport is "per assessment" while `openapi.yaml` fixes SSE | **SSE is the trilogy's chosen realisation and belongs in the shared contract** | §10 bullet split: auth/seeding/endpoints stay per-assessment; a new one-line bullet states SSE is fixed in `openapi.yaml` for #7, #8 and #9 so the contract has no hole, with WebSocket kept as the documented alternative and any substitution being that assessment's deviation, not an open option |
| 3 | `redocly lint` warned that `info.license` had neither `url` nor `identifier` | Use the SPDX custom-reference form | `openapi.yaml` `info.license` gains `identifier: LicenseRef-Proprietary` |

Consequential edits (citations only, no content change): the `R1`–`R60` range
citations in `openapi.yaml` `info.description` and `asyncapi.yaml`
`info.description` now read `R1`–`R61`; `requirements.md` §9 now says "these 61
requirements" and gains a coverage row for stock master-data maintenance.

`test-matrix.md`: one new row in group 4, `R61`, status `TODO`, at **domain unit
+ API** level — `fulfillment/domain/stock-replenishment.spec` and
`api/stock-replenishment.spec`. Header, coverage summary and the Verification
section updated to 61.

**Verified after the amendments:** `requirements.md` holds `R1`–`R61`,
contiguous and unique; `test-matrix.md` holds the same 61 ids, contiguous and
unique, with no id missing on either side; both YAML files still parse.
Added lines were grepped for `nest`, `drizzle`, `nuxt`, `mysql`, `typescript`,
`pnpm`, `vitest`, `jest`, `kafkajs`, `mongo` — zero hits.

`feature_list.json` was not touched. Nothing was committed or pushed.
