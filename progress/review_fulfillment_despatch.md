# Review — `fulfillment_despatch` (feature 18, phase 9)

**Verdict: APPROVED** — 0 blocking defects, 3 non-blocking findings (N1–N3), **5/5 hostile mutations KILLED**, transactional atomicity proved by fault injection rather than argued, and the hand-trimmed migration ruled **correct and safe** on all three questions asked of it.

`sdd: false` — reviewed against the acceptance list, `specs/shared/saga.md` §3.1 step 4 / §6, `specs/shared/asyncapi.yaml` (`despatchCreate`, `OrderDespatched`), `specs/shared/requirements.md` R36 + `domain-model.md` F6/F7/F8, and `CLAUDE.md`.

---

## 1. Scope discipline — what I ran, and what I deliberately did not

Re-running what the implementer already ran is duplicated cost. What follows is the split, so a reader can tell verification from assumption.

| Claim under test | What I did |
|---|---|
| Fulfillment unit 75/75 | **Re-ran in full** (claim is about the whole suite) — `16 files, 75 passed, 1.61s` |
| Fulfillment integration 44/44 | **Re-ran in full** (claim is about the whole suite) — `12 files, 44 passed, 210.14s` |
| `apps/seed` unit 108/108 | **Re-ran in full** — `7 files, 108 passed` |
| Orders 387 unit / 51 integration | **Not re-run.** Confirmed by diff instead: `git status --porcelain` lists **no file under `apps/orders/`**, and `pnpm-lock.yaml`/`pnpm-workspace.yaml` are untouched, so no Orders code or dependency can have moved. (Orders' 387 unit tests did run anyway, free, inside the monorepo-wide `pnpm test` below — green — but no Orders *integration* container run was spent.) |
| `pnpm quality` | **Ran all three legs**: `pnpm lint` exit 0, `pnpm typecheck` exit 0 (10 projects), `pnpm test` exit 0 (Orders 387, Fulfillment 75, seed 108, shared-kernel 68, contracts 22, billing 1, notifications/projector/gateway/web) |
| `./init.sh` | Ran — exit 0, "environment and state are coherent", 39 uncommitted changes (expected mid-session), no feature `in_progress` |
| Live saga state | **Queried the live compose databases directly** rather than taking the report's word (§8) |

Everything in §§3–8 below is my own probe, not a re-read of the implementer's transcript.

---

## 2. `CHECKPOINTS.md` — every applicable box walked

**C1 — harness complete**
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all present (init.sh §1–2)
- [x] `progress/current.md`, `progress/history.md` present
- [x] `.claude/agents/` holds 6 definitions incl. leader, spec_author, implementer, reviewer, test_maintainer
- [x] Every agent definition declares its model (init.sh: implementer `sonnet`, suite_runner/test_maintainer `haiku`, leader/reviewer/spec_author documented-unpinned)
- [x] `./init.sh` exits 0

**C2 — state coherent**
- [x] At most one feature `in_progress` — in fact zero; 18 was `in_review`
- [x] Every status in `rules.valid_status` (init.sh check)
- [x] Every `done` feature has passing tests — monorepo `pnpm test` exit 0
- [x] `progress/current.md` describes this active session (feature 18, started 2026-08-22), not leftovers
- [x] No `blocked` feature

**C3 — architecture respected**
- [x] Domain purity: `grep -rnE "from '(@nestjs|drizzle-orm|kafkajs|nats|mongodb)" apps/*/src/domain/` → **clean**; ESLint `no-restricted-imports` green over the whole repo. The five new domain files import only `@otc/shared-kernel` and `@otc/contracts` (`import type` only, in `despatch-events.ts`)
- [x] No cross-service DB access: `despatches` carries `order_reference`, `company_code`, `retailer_code` as plain `varchar` business identifiers; `SHOW CREATE TABLE otc_fulfillment.despatches` on the live DB shows **no foreign key at all**, in particular none into `otc_orders`
- [x] No shared runtime code beyond `shared-kernel` + `contracts` — no new cross-imports; `pnpm-lock.yaml` unchanged
- [x] `packages/shared-kernel` untouched, still dependency-free
- [x] Kafka-fact vs NATS-RPC correctly classified: `fulfillment.despatch.create` is a **NATS `@MessagePattern`** (asyncapi `despatchCreate`, `rpcTransport`), `order.despatched.v1` is a **Kafka fact via the outbox relay** to `otc.fulfillment.facts.v1` (asyncapi `fulfillmentFacts`). No Kafka-as-request-bus, no RPC-for-facts
- [x] Every pattern decorator names its `Transport` — `grep "@MessagePattern(\|@EventPattern(" apps/fulfillment/src | grep -v "Transport\."` returns only a *comment* line in `stock.controller.ts:1`, no decorator. `despatch.controller.ts:59` is `@MessagePattern(DESPATCH_CREATE_SUBJECT, Transport.NATS)`
- [x] Explicit `@Inject(TOKEN)` everywhere: `DespatchController` (`@Inject(CommandBus)`), `CreateDespatchHandler` (`@Inject(DespatchCreationHandler)`); every new module provider is `useFactory` + explicit `inject: [...]` (`app.module.ts`). ESLint DI guard green
- [x] No stray debug logging, no context-free TODOs in the new files

**C4 — verification real**
- [x] `pnpm quality` passes (lint + typecheck + test, each run separately, all exit 0)
- [x] Domain tests pure — `despatch-advice.spec.ts` / `order-despatch.spec.ts` import only `vitest`, `@otc/shared-kernel` and sibling domain modules; no DB, no broker, no mock of infrastructure
- [x] Integration tests use Testcontainers against **real** MySQL 8.4.11 + NATS 2.14.5 + Kafka 4.3.1, booting the **real `AppModule`**; the despatch spec talks over a raw `nats` client, not a `ClientProxy`
- [x] Coverage gates — unchanged gating config, `pnpm quality` green
- [x] No Jest anywhere — Vitest only (`vitest run` / `vitest run --config vitest.integration.config.mts`)

**C5 — session closes cleanly**
- [x] No suspicious untracked files: `git status --porcelain` = 39 entries, every one accounted for in the implementer's §7 file list; my own probe file and mutations are gone (`grep -iE "probe|zz-"` → none)
- [x] `progress/history.md` entry with the effort record — appended on approval (§10)
- [x] `feature_list.json` reflects true state — set `done` on approval
- [x] The human is told what was done + how to test manually — the leader relays; §9 lists the manual steps
- [x] **Claude did not commit.** No `git commit`, no `git push` was run in this review

**C6 — SDD**: not applicable (`sdd: false`, no `specs/fulfillment_despatch/` expected). The one SDD-adjacent obligation that *does* apply — R36 covered by a concrete named test recorded in `specs/shared/test-matrix.md` — is satisfied (§3).

**C7 — trilogy reusability**
- [x] `specs/shared/` gained no stack specifics: the only change is `test-matrix.md`'s R36 row flipping `TODO → DONE` plus the coverage-summary counters (6→7, 30→31). No NestJS/Drizzle/MySQL vocabulary entered `specs/shared/`
- [x] `n8n/workflows/*.json` untouched
- [x] `progress/history.md` effort records complete and honest — this feature's is appended with the mtime evidence it rests on

---

## 3. Traceability — R/F → test, verified by reading the assertions, not the names

| Id | Requirement text | Test that actually exercises it | Verified |
|---|---|---|---|
| **R36** (consume) | "SHALL set those reservations to `consumed`" | `domain/order-despatch.spec.ts` › *consumes every reserved reservation of the order across two items…* asserts `itemA.units 10→7`, `reservedUnits→0`, `reservations[0].status === 'consumed'` on **both** items | ✅ non-vacuous — mutation M1 killed it |
| **R36** (exactly one despatch, ≥1 line — **F6**) | "create exactly one despatch advice with at least one line" | `domain/despatch-advice.spec.ts` › *F6 — refuses an empty line list and creates no aggregate* (`toThrow(EmptyDespatchLinesError)`) | ✅ |
| **R36 / F7** (line traces the consumed reservation, exact units) | "each line tracing to a consumed reservation of the same order and despatching exactly the reserved units" | domain spec asserts `lines === [{PRD-0001,3},{PRD-0002,5}]` against the two consumed reservations; integration asserts the persisted `despatch_items` row `{productCode, units: 4}` equals the reserved 4 | ✅ — mutation M6 (drop the `despatch_items` insert) killed the integration case |
| **R36** (exactly one fact) | "SHALL emit exactly one `order.despatched.v1`" | domain: `pullDomainEvents()` length 1, second call length 0, and `StockItem.consume` emits nothing; integration: exactly **one** outbox row for the request's `correlationId`, `eventType: order.despatched.v1`, `causationId === x-request-id`, `published_at` non-null, payload matching `OrderDespatchedPayload` field-for-field | ✅ |
| **R36** (refusal) | "IF the order holds no reservation in status `reserved` THEN create no despatch advice and emit no fact" | unit: never-reserved (no transaction opened) and all-released (inside the transaction) both `rejects.toThrow(NoReservedStockForDespatchError)`; integration: both branches reply `PRECONDITION_FAILED` **and** assert `despatchOf(...) === undefined` **and** `outboxRows.length === 0` | ✅ probed myself, §5 |
| **F8** (at most one per order, repeat returns the existing) | `domain-model.md` F8 | integration › *F8 — a re-issued despatch.create…* asserts identical `despatchReference`, `created: false`, one despatch row, one line, **zero** outbox rows for the repeat's correlationId; unit covers both the fast path (no transaction) and the in-flight race (no second allocation) | ✅ probed myself, §5 |
| **F8** at DB level | — | `migrations.integration.spec.ts` › *rejects a duplicate order_reference in despatches* (`ER_DUP_ENTRY`) and *asserts the uq_despatches_order_reference unique constraint exists* | ✅ + live DB confirms (§7) |
| **FS3** header discipline | feature 17's convention | `despatch.controller.spec.ts` › FS3 refusal (absent / malformed / one-of-two) asserts `VALIDATION_FAILED` **and** `commandExecute` never called | ✅ — mutation M4 killed it |
| Subject name | asyncapi `despatchCreate.address` | `despatch.controller.spec.ts` reads `specs/shared/asyncapi.yaml` **as text** and compares — a real spec-conformance assertion, not a restated constant | ✅ |
| Error vocabulary | existing `rpc-error-mapper` codes | `rpc-error-mapper.spec.ts` › *NoReservedStockForDespatchError -> PRECONDITION_FAILED with details.orderReference* | ✅ §5.4 |

`specs/shared/test-matrix.md` R36 row now cites the real file paths and case titles, and the coverage summary (row 4: 6→7 Green; total 30→31) is arithmetically correct.

**Acceptance list** (`feature_list.json` id 18): *"reservations move to consumed"* ✅ and *"OrderDespatched emitted via outbox"* ✅ — both proved at domain, application and real-broker integration level.

---

## 4. Probe 2 — the transaction. Fault injected, nothing persisted.

The claim is that the `despatches` row, its `despatch_items`, the reservations' move to `consumed` and the `order.despatched.v1` outbox row commit **together** (R13). I did not take it on trust and I did not settle for reading `unitOfWork.execute`.

**Method.** A temporary reviewer probe spec (deleted afterwards) booted the real harness (real MySQL/NATS/Kafka, real `AppModule`), reserved 4 units over NATS, and then issued `fulfillment.despatch.create` with **one line injected into `despatch-creation.handler.ts` immediately after `await this.despatches.save(outcome.despatch, tx)`**:

```ts
throw new Error('REVIEWER PROBE: forced failure after despatches.save');
```

That is the worst possible moment: the despatch row, all its lines, the consumed reservations, the allocated `DES-######` and the outbox fact have all been written, and the transaction then dies.

**Result — unmutated code:**

```
PROBE state: {"despatch":"none","despatchItems":0,"reservationStatus":"reserved",
              "units":10,"reservedUnits":4,"outboxRows":0}
Test Files  1 passed (1)   Tests  1 passed (1)
```

Nothing persisted: no despatch, no lines, the reservation still `reserved`, the stock counters untouched (10/4 — i.e. the `consume` that had already subtracted units was rolled back too), **and no fact**. The sequence allocation rolled back with it.

**Was the probe discriminating, or would it pass regardless?** I proved it discriminates by re-running the *same* probe with mutation **M2** applied — the outbox write moved outside the transaction (`record(this.db …)` instead of `record(tx …)`), which is exactly the "emit the fact outside the transaction" failure mode:

```
PROBE state: {"despatch":"none","despatchItems":0,"reservationStatus":"reserved",
              "units":10,"reservedUnits":4,"outboxRows":1}
AssertionError: expected [ { …(12) } ] to have a length of +0 but got 1   ← at expect(outboxRows).toHaveLength(0)
```

An orphan `order.despatched.v1` for an order with **no despatch row** — which the relay would have published to `otc.fulfillment.facts.v1`, driving the saga to `despatched` and then to invoicing on a despatch that does not exist. **M2 KILLED.** Both source files restored byte-exact (sha256 verified, §6).

---

## 5. Probes 3–4 — idempotent re-issue and the precondition, probed personally

**Probe 3 — second `fulfillment.despatch.create` for an order that already has one.** Run over real NATS against the real module (integration case *F8 — a re-issued despatch.create…*, which I executed myself, twice: once as part of the 44/44 suite and once in the restored two-file run). Observed: the second call returns the **same** `despatchReference`, `created: false`, the same lines; `despatches` still holds exactly one row and `despatch_items` exactly one line for the order; and `outboxRowsFor(secondCorrelationId)` is **length 0** — no second fact. The reply's `despatchDate` is asserted to be within 1000 ms of the first, not string-equal, because `despatches.despatch_date` is a second-precision `datetime` and MySQL rounds — an honest, correctly-reasoned assertion rather than a loosened one.

I also confirmed the repeat is genuinely *free*: the unit spec asserts `unitOfWork.executeCalls === 0` on the fast path, so the common case opens no transaction and takes no lock.

**Probe 4 — an order with no `reserved` reservations must fail loudly.** Both shapes were exercised over the wire and both replied `PRECONDITION_FAILED`, with `despatchOf(orderReference) === undefined` and zero outbox rows:

- *never reserved* — `stockIdsOfOrder` is empty, refused **before** any transaction is opened;
- *already released* — a real `fulfillment.stock.release` (reason `credit_rejected`) ran first over NATS, then `despatch.create` was refused **inside** the lock.

**Is `PRECONDITION_FAILED` from the existing vocabulary?** Yes. `apps/fulfillment/src/presentation/rpc-error-mapper.ts` already emitted `PRECONDITION_FAILED` for `ReservationTerminalError` before this feature; the new `NoReservedStockForDespatchError` branch (lines 62–76) reuses that code with `details.orderReference`, matching `NoKnownStockItemError`'s `details` shape. No new code was invented, and the choice is right: the order and its reservations exist, they are simply in the wrong state — `NOT_FOUND` would have been a lie and `DOMAIN_ERROR` would have mis-filed an application-layer refusal. The empty-despatch alternative is structurally impossible: `DespatchAdvice.create` throws `EmptyDespatchLinesError` (F6) before an aggregate exists.

There is **no** silent-success path: every branch either returns an existing despatch or throws.

---

## 6. Probe 5 — mutations. 5/5 KILLED, all restored byte-exact.

| # | Mutation | File / line | Killed by | Result |
|---|---|---|---|---|
| **M1** | Leave reservations `reserved` after despatch — `item.consume(...)` replaced by a non-mutating filter of the order's `reserved` reservations | `domain/order-despatch.ts:56` | `order-despatch.spec` ×2 (consume + F4 propagation) and `despatch-creation.handler.spec` happy path | **KILLED** — `3 failed | 72 passed` |
| **M2** | Emit the fact **outside** the transaction — `outboxRecorder.record(this.db …)` instead of `record(tx …)` | `infrastructure/persistence/despatch.repository.ts:70` | the reviewer's own rollback probe (§4) — orphan outbox row survives the rollback | **KILLED** |
| **M3** | Allow a second despatch — the F8 fast-path short-circuit deleted | `application/despatch-creation.handler.ts:59-62` | `despatch-creation.handler.spec` ×2 (fast path *and* the in-flight race) | **KILLED** — `2 failed | 73 passed` |
| **M4** | Skip the FS3 header validation — `parseRpcMeta(ctx) ?? {generated ids}` | `presentation/despatch.controller.ts:70-73` | `despatch.controller.spec` FS3 refusal case | **KILLED** — `1 failed | 74 passed` |
| **M6** | Persist the despatch header but **not** its lines — `if (itemRows.length > 0)` → `> 99` | `infrastructure/persistence/despatch.repository.ts:66` | **integration only**: happy path (`expected [] to have a length of 1`) and the F8 repeat | **KILLED** — `2 failed | 3 passed`; **all 75 unit tests stayed green**, which is the point |

M6 was chosen deliberately to test the *integration* suite's power rather than the unit suite's, and it earns its 210 s: no unit test can see a missing INSERT behind a fake repository.

**Restoration, proved rather than asserted.** All four touched files were restored from checksummed copies and re-verified:

```
sha256sum -c backup/SHA256
apps/fulfillment/src/domain/order-despatch.ts: OK
apps/fulfillment/src/application/despatch-creation.handler.ts: OK
apps/fulfillment/src/presentation/despatch.controller.ts: OK
apps/fulfillment/src/infrastructure/persistence/despatch.repository.ts: OK
```

and the suites re-run green afterwards: `pnpm test` monorepo-wide exit 0, and the restored `despatch-create.integration.spec.ts` + `migrations.integration.spec.ts` → **16 passed**. The temporary probe spec was deleted; `git status --porcelain` is back to the same 39 entries `./init.sh` counted, with no `probe`/`zz-` leftovers.

> **Note for whoever reads mtimes later:** my restores rewrote the mtimes of `order-despatch.ts` (07:38), `despatch.controller.ts` (07:38) and `despatch-creation.handler.ts` (07:40). The **content** is sha256-identical to what the implementer submitted; only the timestamps moved. Do not read those three mtimes as implementation activity.

---

## 7. Probe 6 — the hand-trimmed migration. Ruling: **correct, safe, and the right call.**

The implementer reports a *pre-existing* stale `0001_snapshot.json` and a hand-trimmed `0002`. Hand-trimmed generated migrations deserve scrutiny, so all three questions were answered from artefacts, not from the report.

**(a) Does the committed SQL contain only what this feature needs?** Yes. `0002_despatch_number_sequence_and_order_reference_unique.sql` is exactly two statements — `CREATE TABLE despatch_number_sequences` and `ALTER TABLE despatches ADD CONSTRAINT uq_despatches_order_reference UNIQUE(order_reference)`. `grep -icE "\boutbox\b|\bprocessed_events\b"` on the file → **0**. Nothing that migration 0001 already applied is re-emitted.

**(b) Was the stale snapshot real, and does applying everything from empty still produce the intended schema?** The drift is **confirmed real and pre-existing**: `0001_snapshot.json` is byte-equivalent to `0000_snapshot.json` apart from key ordering and its own `id`/`prevId` — its `outbox` table lists **9 columns and 1 index**, i.e. it does *not* record `causation_id`, `trace_parent`, `seq` or `idx_outbox_unpublished_seq`, all of which migration `0001` actually applies. So a raw `drizzle-kit generate` would indeed have re-emitted those ALTERs, and `pnpm db:migrate` would have died with a duplicate-column error on every environment that had already run 0001. The implementer's diagnosis is accurate and the trim was necessary.

From-empty correctness is **proved by a Testcontainers test that really does apply all three migrations to a virgin MySQL** (`runFulfillmentMigrations` in the harness), and that test **does cover 0002 concretely**, not just by table count:
- the 7-table assertion now includes `despatch_number_sequences`;
- a new case asserts `uq_despatches_order_reference` exists on `order_reference` via `information_schema.statistics`;
- a new case asserts `ER_DUP_ENTRY` on a second row with the same `order_reference` and a *different* `despatch_reference` — so it tests the F8 constraint, not the pre-existing reference constraint;
- a round-trip inserts and reads back the `despatch_number_sequences` row.

Crucially, the **same from-empty run still asserts everything 0001 provides** — `idx_outbox_unpublished_seq` on `(published_at, seq)`, `causation_id`, `trace_parent`, `seq > 0`, and the `datetime(3)` `occurred_at` millisecond round trip. That is what proves the trim removed only *duplicates* and not *content*. I re-ran that spec: **11 passed**.

**(c) Is the snapshot/journal chain now coherent?** Yes, and it is self-healing:
- `_journal.json` entries are `0000 / 0001 / 0002`, `idx` contiguous, tags matching the three `.sql` files, and the file now ends with a newline;
- the `prevId → id` chain is intact: `0000 (a7467f48…, prev 000…0) → 0001 (d7128907…, prev a7467f48…) → 0002 (bdb9e3b9…, prev d7128907…)`;
- `0002_snapshot.json` is a **full** snapshot and is **correct**: 7 tables including `despatch_number_sequences`, `outbox` with all 12 columns and both indexes, `despatches` carrying `uq_despatches_order_reference`. It matches `schema/*.ts` and it matches the live database.

Because `drizzle-kit generate` diffs against the **latest** snapshot, and the latest snapshot is now right, the drift **cannot re-bite** a future migration. What remains wrong is only the historical `0001_snapshot.json` as an audit artefact — it is never used for diffing again. **Owner: nobody, and that is the right answer** — regenerating it retroactively would rewrite a committed artefact for no functional gain. This is the sibling of the Orders-side `0002_snapshot.json.prevId` advisory (D4, feature 16) and is recorded here so the pattern is visible: **snapshot regeneration is a manual step this workflow does not enforce.** If a third instance appears, the fix belongs in the `db:generate` script, not in another hand-trim.

**Verdict on the trim: approved.** The alternative — committing the raw generated SQL — would have broken `pnpm db:migrate` on every existing environment. The trimmed file is minimal, the snapshot is truthful, and the from-empty path is covered by a real container test.

---

## 8. Probes 7–9 — F8 live, OI11 parity, the seed fix, and the saga's first unattended cross-service advance

**F8 constraint, live** (`SHOW CREATE TABLE otc_fulfillment.despatches`):

```
UNIQUE KEY `despatches_despatch_reference_unique` (`despatch_reference`),
UNIQUE KEY `uq_despatches_order_reference` (`order_reference`)
```

`despatch_number_sequences` exists with the intended shape, `__drizzle_migrations` holds exactly 3 rows, and the live `outbox` still carries `causation_id`, `trace_parent`, `seq`, `occurred_at datetime(3)` — **the migration disturbed nothing**.

**OI11 byte-parity guard**: `apps/seed/src/outbox-parity.spec.ts` re-run in isolation → **1 passed**. The guard is genuinely untouched because `0002` mentions neither table.

**Probe 8 — the seed fix.** Three separate questions, three separate proofs.

*Additive only?* Proved computationally, not by eye: I materialised `STOCK` from `git show HEAD:apps/seed/src/data/stock.data.ts` alongside the new one and diffed row by row —

```
{"oldRows":11,"newRows":215,"added":204,"changedOrRemovedExistingRows":0,
 "oldCompanies":5,"newCompanies":22}
```

**Not one pre-existing row changed or disappeared**; 204 new rows, companies 5 → 22. `stock.data.ts` and `stock.spec.ts` are the *only* seed files touched — no other `*.data.ts` is in `git status`, so no existing seeded id or amount elsewhere can have moved.

*Deterministic?* `sha256(JSON.stringify(STOCK))` computed in two separate `tsx` processes → `b87a51ea5b8efabef0c3dc3e7e62c5b736658b2d7bcafda276c6ed4ba51a6524` both times. The new `BASELINE_STOCK` ids come from the same `stockRowId(company, product)` → `deterministicId(...)` derivation the saga-derived rows use, and the final `.sort()` key `(companyCode + productCode)` is total across both layers (baseline excludes every saga-covered company, so no key collides).

*`pnpm seed` twice → identical?* Ran it twice against the live stack and compared `CHECKSUM TABLE` for nine tables across all three databases. Run 1 → run 2: **every checksum identical** (`stock 495129116`, `reservations 341737302`, `despatches 2110029799`, `despatch_items 1282813129`, `companies 591378513`, `products 1115617931`, `orders 543553641`, `credits 1463020043`, `invoices 951022910`). The writes are idempotent. Both runs end in the **pre-existing** `SeedVerificationError: orders.orders: expected 6, got 11` — feature 12's `verifySeed` assumes a seed-only database and this dev DB carries 5 hand-placed live orders. Not caused by, and not aggravated by, this feature; the implementer flagged it honestly as owed. I confirm it is **not** blocking and record it in N3.

*Every company in a seeded order now has stock?* `SELECT COUNT(*) FROM companies c WHERE NOT EXISTS (SELECT 1 FROM stock s WHERE s.company_code = c.code)` → **0**, with 215 stock rows over 22 distinct companies. `ALBIONFOODS` — the concrete gap `review_fulfillment_stock.md` left owed — now holds 12 rows, `PRD-0001..0012`, 500 units each.

**Probe 9 — live, and confirmed rather than taken.** Queried `otc-mysql` directly:

```
otc_orders.orders                      ORD-000007  stock_reserved
                                       ORD-000008  stock_reserved
                                       ORD-000009  stock_reserved

otc_orders.saga_commands               ORD-000007  stock.reserve  sent
                                       ORD-000007  credit.hold    parked   (no responder is subscribed to "billing.credit.hold")
                                       …identically for ORD-000008 and ORD-000009

otc_fulfillment.reservations           ORD-000007  PRD-0001  2  reserved
                                       ORD-000008  PRD-0001  2  reserved
                                       ORD-000009  PRD-0001  2  reserved

otc_fulfillment.outbox (3 newest)      stock.reserved.v1  c6264b14-…  published_at 2026-08-22 05:26:45
                                       stock.reserved.v1  1a5f5dd7-…  published_at 2026-08-22 05:26:45
                                       stock.reserved.v1  c888ff0e-…  published_at 2026-08-22 05:26:45
```

And the correlation chain checks out digit for digit: those three `correlation_id`s are exactly `otc_orders.orders.id` for ORD-000007/8/9. Three orders that had been parked at `stock.reserve` since feature 16 (21 attempts each) reached `stock_reserved` unattended and are now parked at `credit.hold` **because Billing does not exist yet (feature 19)** — the designed, loud, safe negative path, not a Fulfillment defect. `ALBIONFOODS/PRD-0001` shows `units 500, reserved_units 6`, coherent with the three live 2-unit reservations, and a subsequent `pnpm seed` did **not** stomp it.

**This is the first time the saga advanced across a service boundary unattended on data the seed itself provides** — and it advanced because this feature fixed the seed, which is precisely what `review_fulfillment_stock.md` assigned to this live-boot pass. That owed item is now **closed**.

---

## 9. Findings (3, none blocking)

**N1 — the OI11 parity guard reads a migration's leading comment as part of its first statement.** `apps/seed/src/outbox-parity.spec.ts:47-56` splits on `--> statement-breakpoint` and matches `/\boutbox\b|\bprocessed_events\b/` against the whole chunk — comments included. That is why `0002_…sql:6-9` had to describe migration 0001's ALTERs as touching "the fact-relay table" and explicitly says it is avoiding "the literal word the guard's regex matches on". The guard passes and the workaround is documented in place, so nothing is broken — but *a comment shaped to dodge a regex is a coupling waiting to break*: the next author who writes "outbox" in a migration header will get a parity failure with no relation to any schema drift. **Fix (one line, whoever next touches OI11): strip SQL comments inside `normalise()` before matching.** Not owed by this feature.

**N2 — `companyCode` and `retailerCode` are sourced asymmetrically.** `application/despatch-creation.handler.ts:99-100` takes `companyCode` from `items[0]!.companyCode` but `retailerCode` from the first *reserved* reservation. Both are correct today (`stockIdsOfOrder` only returns items holding a reservation of this order, and an order belongs to exactly one company), so this is style, not a bug — but reading both from the same reserved reservation would make the invariant "the fact's parties come from the reservations being consumed" self-evident instead of requiring the reader to reconstruct it.

**N3 — `apps/seed/src/verify.ts`'s `orders.orders === SAGAS.length` assertion still fails on any long-lived dev database** (`expected 6, got 11`). Pre-existing, correctly declared by the implementer as out of scope, reconfirmed by me on two runs. It makes `pnpm seed` exit non-zero on the very machine the demo runs on, which will eventually be read as "the seed is broken". **Due no later than feature 28 (`saga_e2e_verification`)**, which cannot present a clean end-to-end run while `pnpm seed` exits 1.

**Observation, not a defect (for the test-suite's own record).** Mutation M3 — deleting the F8 fast path entirely — is killed by two unit cases but leaves **all 44 integration tests green**: the in-transaction `anyConsumed` branch catches the repeat and still answers `created: false`. The fast path is therefore an *optimisation* (no transaction, no lock on the common repeat), and its value is asserted only at unit level via `executeCalls === 0`. That is the correct place for it, and it is worth stating explicitly so nobody later "simplifies" the handler on the strength of a green integration suite.

---

## 10. Verdict

**APPROVED.** The feature does what R36 and F6/F7/F8 require, over the transport `asyncapi.yaml` specifies, with the payload it specifies; the transaction is atomic under injected failure; the idempotent repeat emits nothing; the precondition fails loudly in the existing error vocabulary; the hand-trimmed migration is minimal, honest and covered from empty by a real container test; and the seed fix is additive, deterministic and has already paid for itself live. Five hostile mutations, five kills, every file restored byte-exact.

`fulfillment_despatch` → `done`. **Phase 9 complete.**
