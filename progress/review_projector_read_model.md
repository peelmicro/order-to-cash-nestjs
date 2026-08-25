# `projector_read_model` (id 24, phase 12, `sdd: true`) — review record

**Verdict: REJECTED.**

**Two blocking defects, both in the spec/evidence bookkeeping. Zero code defects were found.** Every functional, architectural and behavioural probe in this pass — including four hostile mutations I armed myself, a harder concurrency attack than the implementer's, a restart-replay attack, an independent D7 subversion, an independent R54 non-vacuity probe and an independent R55 signal probe — passed. The implementation is, on the evidence, the strongest submitted in this project so far. It is rejected on `specs/projector_read_model/tasks.md` sitting at **0 of 63 tasks ticked** — the exact `N1` finding that rejected `billing_invoicing` (id 21) and, before it, the phase-8 checklist drift — and on task `B7`'s own mandated deletion probe being absent from the implementation record. Both are fixable without touching a line of source; the re-review can be narrow, and every functional finding below carries over as verified.

---

## 1. `CHECKPOINTS.md` — the walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (plus `suite_runner`).
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 — re-run in this pass, exit code 0.

### C2 — State is coherent
- [x] At most one feature `in_progress` — 23 `done`, 24 the only non-`pending` remainder; set to `in_progress` by this rejection.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] **`progress/current.md` describes the active session** — **EMPTY. See defect N2.** The file is dated `2026-08-24 09:56` and still describes **`billing_remittance_intake` (id 22)** as the active feature, with a "Goal" section about **phase 9**. It is leftovers from two features ago; neither `notifications_service` (23) nor `projector_read_model` (24) appears.
- [x] Every `blocked` feature records why — none blocked.

### C3 — Architecture is respected
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder. Verified two ways: the root ESLint `no-restricted-imports` rule covers `apps/*/src/domain/**` (`eslint.config.mjs:130`), and I grepped every non-spec file under `apps/projector/src/domain/` — the only cross-file imports are `@otc/contracts` **types** and sibling domain modules.
- [x] No cross-service database access. The projector opens exactly one MongoDB connection and no MySQL client; `apps/projector/package.json` declares no Drizzle dependency (asserted by `projector-consumes-only.spec.ts` › *PR21 › declares no Drizzle dependency in package.json*).
- [x] No shared runtime code beyond `packages/shared-kernel` and `packages/contracts`. `git status` shows no file under `packages/` touched. The PR12 rank table is **duplicated by hand** into `apps/seed/src/writers/mongo.writer.ts` rather than imported across apps — correct under this rule, and the duplication is stated in that file's own header.
- [x] `packages/shared-kernel` still has zero runtime dependencies — untouched.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC. Three `@EventPattern(TOPIC, Transport.KAFKA)` consumers; **zero** `@MessagePattern`; one publish-only NATS connection. `readmodel.order.updated.<orderId>` / `readmodel.timeline.appended.<orderId>` are a **deliberate, gate-approved extension** (open point 2) of the NATS column from *request-reply* to *"…and publish-only read-model signals"*: no reply subject, no responder, nothing awaited. I confirmed independently that **no Kafka topic was created for it** — `kafka-topics.sh --list` against the live broker returns exactly the six fact/DLQ topics plus `__consumer_offsets`, and a repo-wide grep finds no `readmodel` topic constant anywhere.
- [x] No stray debug logging, no context-free TODOs. The only `console.log` calls are the two boot lines in `main.ts`, matching `apps/billing/src/main.ts` and `apps/notifications/src/main.ts` verbatim in shape.

### C4 — Verification is real
- [x] `pnpm quality` passes. **Not re-run in full** (per the brief — the implementer ran it green across 11 packages). Independently re-run instead, after all four of my mutations were restored: `apps/projector` **111/111 in 13 files**, `apps/seed` **119/119 in 8 files**, `apps/orders` `idempotent-consumer.parity` **11/11** — all three claims corroborated exactly.
- [x] Domain tests are pure. `apps/projector/src/domain/*.spec.ts` import only `vitest`, `node:fs`/`node:path` (for the structural scan) and the modules under test.
- [x] Integration tests use Testcontainers against real MongoDB / Kafka / NATS. Verified by reading every fixture: `mongo:8.3.8`, `apache/kafka:4.3.1`, `nats:2.14.5-alpine` — the same pinned tags `docker-compose.infra.yml` uses. No mocked broker anywhere. The G-group harness boots the **real** `AppModule` and overrides only `NATS_CONNECTION` (a broker the R50–R53 specs are not about); the signal itself is proven against real NATS in its own file.
- [x] Coverage thresholds met — domain 97.59%, overall 93.93% statements / 83.15% branches (implementer's figures; not re-run, no reason to doubt them and no claim in this pass rests on them).
- [x] No Jest anywhere. Grepped `apps/` and `packages/` — zero non-`vitest` matches.

### C5 — The session closed cleanly
- [x] No suspicious untracked files. My three probe specs were deleted; `git status --porcelain` now lists exactly the declared scope and nothing else.
- [ ] **`progress/history.md` has an entry for the feature, including its effort record** — **EMPTY, correctly.** The reviewer writes this on approval; it is empty *because* this is a rejection. Not a defect. The derived effort record is parked in §6 below so it is not lost.
- [x] `feature_list.json` reflects true state — set to `in_progress` by this rejection.
- [ ] The human has been told what was done and how to test it manually — pending the fix pass.
- [x] Claude did not commit. No `git commit`, no `git push` in this pass.

### C6 — Spec-Driven Development
- [x] `specs/projector_read_model/` has all three of `requirements.md`, `design.md`, `tasks.md`.
- [x] `requirements.md` uses strict EARS notation, every requirement carrying a `PR<n>` id; shared acceptance is `R50`–`R55` verbatim.
- [ ] **Every `done` sdd feature has all its tasks ticked `[x]` in `tasks.md`** — **EMPTY. BLOCKING. See defect N1.** `specs/projector_read_model/tasks.md`: **0 of 63 ticked.** Every other sdd feature in this repository is at 100%: `orders_aggregate` 44/44, `outbox_and_idempotency` 57/57, `order_saga_orchestrator` 35/35, `fulfillment_stock` 49/49, `billing_credit` 56/56, `billing_invoicing` 60/60.
- [x] Every `R<n>` covered by at least one concrete named test, recorded in `specs/shared/test-matrix.md` — see §3.
- [x] The spec commit precedes the implementation commit — the spec pass is a separate, earlier pass (`progress/spec_projector_read_model.md`, `2026-08-24 17:24`), and the implementation artefacts all post-date it. The commit itself is the human's.

### C7 — Trilogy reusability
- [x] `specs/shared/` contains no NestJS/Drizzle/Nuxt/MySQL specifics that were not already there. Only `test-matrix.md` was touched, and only in the Status column, which already carries per-assessment evidence paths in every `DONE` row (`R45`–`R49` are the immediate precedent). `requirements.md`, `domain-model.md`, `saga.md`, `asyncapi.yaml`, `openapi.yaml` are byte-unmodified — confirmed by `git status`.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records are complete and honest for every closed feature. See defect **N5** for a *forward*-looking gap in `test-matrix.md`'s rule 3, not a gap in the records.

---

## 2. Findings

### N1 — BLOCKING — `specs/projector_read_model/tasks.md` is 0/63 ticked
**File:** `specs/projector_read_model/tasks.md` (whole file — every one of 63 items is `- [ ]`)
**Owner:** implementer
**Why it matters.** `CHECKPOINTS.md` C6 makes "every task ticked" a close criterion, and this repository has already rejected a feature for precisely this: `progress/review_billing_invoicing.md`'s **N1** — *"`tasks.md` sat at 0/60 ticked (now 60/60, five items reworded to match what was built) — the same checklist drift caught in Phase 8."* Applying a different standard to feature 24 would make the earlier rejection arbitrary. The substantive cost is real, not clerical: `tasks.md` is the only artefact that records *task-by-task* what was built against what was planned, it is the artefact assessments #8 and #9 replay, and a file that says "nothing was done" next to an implementation record that says "every task group (A–J) has real, run, green evidence" is a contradiction a reader must resolve by re-deriving 63 facts by hand. I verified enough of them to be confident the work *is* done — the tick marks are missing, not the work.
**Required before re-review:** tick all 63, rewording any item whose delivered shape differs from the planned one (the `billing_invoicing` precedent reworded five). Two items I know need a reworded tick rather than a bare one: **A2** was routed to no separate agent, and **I3** was substituted (see N4).

### N2 — BLOCKING — `progress/current.md` is two features stale
**File:** `progress/current.md` (mtime `2026-08-24 09:56`)
**Owner:** leader
**Why it matters.** `CHECKPOINTS.md` C2 states the file must describe the **active** session or hold only the template — *"never leftovers from a previous session."* It currently opens with `**Feature:** billing_remittance_intake (id 22, phase 10)` and a "Goal" paragraph about **phase 9**, and its decision log ends at feature 21/22. Neither feature 23 nor feature 24 is mentioned. This is the working-memory file a resumed session reads first; in its present state it would point a fresh session at a feature closed two commits ago. It is the leader's file, not the implementer's, so it does not reflect on the implementation — but C2 cannot be marked while it stands, and this reviewer's role is to refuse the close while an applicable box is empty.
**Required before re-review:** reset it to the template, or rewrite it for feature 24.

### N3 — MAJOR (evidence gap, no code change) — task `B7`'s mandated deletion probe is not recorded
**File:** `progress/impl_projector_read_model.md` §"The four armed deletions (task group H)" and §"The E11000 and backfill behaviours, as observed"
**Owner:** implementer
**Why it matters.** `specs/projector_read_model/tasks.md` **B7** says, verbatim: *"**Then delete the backfill call and confirm this test fails** — record the message."* The implementation record documents four armed deletions (H1–H4) and none of them is the backfill. What it records instead is the *live* observation that a second boot backfilled `0 document(s)` — which proves idempotency, a different property, and proves nothing about whether any test would notice the backfill's disappearance. This is the single task the spec's own gate notes flagged as the one *"not in the brief"* and *"that must not be dropped as 'just a migration'"* (open point 9), so an unrecorded probe here is exactly the wrong omission.
**I performed both halves of the probe myself, and both bite** — so this is an evidence gap, not a defect:
- Deleting the **call** from `main.ts` fails `apps/projector/src/main-kafka-options.spec.ts` › *runs ensureReadModelIndexes and backfillLegacyDocuments BEFORE startAllMicroservices (design.md §11)* with `AssertionError: expected -1 to be greater than -1` (a **fast-suite** guard, inside `pnpm quality`).
- Neutering the **body** (`return 0;` ahead of the `updateMany`) fails **both** cases of `legacy-document-backfill.integration.spec.ts` with `AssertionError: expected +0 to be 1`.
Both files were restored and are md5-identical to the submitted versions (`afd79ce8…` and `bea52fda…`).
**Required before re-review:** record these two (or the implementer's own equivalents) in the implementation record, per B7's literal instruction.

### N4 — LOW — task `I3`'s substitution is sound, but leaves one seam unwalked; declare the seam
**File:** `progress/impl_projector_read_model.md` §"What was not done, and why"
**Owner:** implementer (a sentence), leader (the seam itself, at feature 25)
**Judgement.** The substitution — publishing one genuinely new `order.placed.v1` directly to `otc.orders.facts.v1` instead of placing an order through a running `orders` service — **does prove the property the task exists to prove**, and the honesty of the declaration is worth more than a clean run. I verified the artefact end-to-end on the live stack: the fact is on the topic (`CreateTime:1787593299042`, `eventId 6bff4852-…`, `correlationId 58251443-…`), and the resulting document `_id: 58251443-9f6d-47ad-8d04-74c3a194973d` / `ORD-LIVEBOOT-1787593298996` exists with `events: 1`, `status: placed`, `statusRank: 1`, `headerComplete: true`. Combined with the replay evidence — 29 of the 36 live documents were built from **genuinely real producer output** across 147 historical offsets on all three topics — the "can the projector consume what the real services emit" question is answered by the replay, not by this one fact.
**The residual seam:** nothing in this pass walked *gateway → orders → outbox relay → Kafka → projector → NATS* in one continuous run. That seam belongs to feature 25 (`R55`'s consumer half is explicitly owed there, `requirements.md` §4), so it is correctly out of scope — but it should be named as an owed walkthrough rather than left implied by a substitution note.

### N5 — LOW (trilogy) — matrix rule 3's relaxation is recorded only in a `#7`-local file
**File:** `specs/shared/test-matrix.md` (the traceability-rule block, rule 3) vs `progress/spec_projector_read_model.md` open point 3
**Owner:** leader / spec, at feature 25's close
**Why it matters.** Open point 3 was approved at the gate: `R54` and `R55` stay `TODO` while their projector halves are green, because their gateway/web halves belong to features 25 and 26. That relaxation of rule 3 (*"A feature cannot be marked `done` until every one of its rows is green"*) is argued in `progress/spec_projector_read_model.md`, which is a **#7-local** file that #8 and #9 do not inherit. `specs/shared/test-matrix.md` — which they *do* inherit verbatim — still carries rule 3 unamended. An #8 reviewer reading only `specs/shared/` sees a feature closed with two `TODO` rows and no rule permitting it. Partially mitigated: both Status cells now spell out *"the row goes `DONE` only when **both** halves are green"* and name the owning features, so the ownership does travel. Only the rule itself does not.
**Suggested (not required for this feature):** add a fourth sentence to rule 3 permitting a row split across features when the Status cell names each half's owner.

### N6 — LOW — one test case name overstates what it asserts (`PR11`)
**File:** `apps/projector/src/out-of-order-facts.integration.spec.ts:104`
**Owner:** test_maintainer (a rename; no source change)
**Why it matters.** The case is named *"PR11 — a reference is written only while null: a later `invoice.issued.v1` never overwrites an already-set `despatchReference`"*, but `invoice.issued.v1` **never writes `despatchReference` at all** — `fact-projection.ts:150/159/168` show each of the three reference-carrying facts fills only its own field. The case asserts `despatchReference === 'DES-000001'` and `invoiceReference === 'INV-000001'`, which is true whether or not the `$ifNull` guard exists. I proved this: with `$ifNull` deleted from `references.despatchReference` in `delta-to-pipeline.ts`, this file still reports `Tests 2 passed (2)`.
**Not a coverage hole.** The guard *is* armed, one level down: the same mutation fails `apps/projector/src/infrastructure/persistence/delta-to-pipeline.spec.ts` › *a reference-carrying fact applies `$ifNull` ONLY to that reference*. So `R52`'s "never overwrite newer references" clause is proven **structurally** (the emitted stage tree) and not **behaviourally** (two competing writers) — which is defensible, because no two facts in the thirteen-row catalogue ever write the same reference field, so the behavioural case is unreachable by construction. The defect is only that the name promises a behavioural proof the case does not perform. Rename it to what it does prove (*"each fact fills only its own reference; an earlier-set reference survives a later fact on a different field"*), or add the missing sentence to the file header. `delta-to-pipeline.ts` was restored md5-identical (`fac43b89…`).

### N7 — INFORMATIONAL — the dev read model now permanently carries three synthetic-probe artefacts, and `fromBeginning: true` makes that permanent
**Files:** live `otc_read_model.order_timeline`; live `otc.orders.facts.v1` / `otc.billing.facts.v1`
**Owner:** leader (dev-stack hygiene), with a note for feature 25
**Observation.** Of the 36 live documents, three are not real orders and not seed fixtures:
- `_id: 'live-order-1'`, `orderReference: 'ORD-LIVE-0001'` — from `eventId: live-verify-1787567317265` on `otc.orders.facts.v1`, `CreateTime 1787567317286` (**2026-08-24 10:28:37Z**), which **pre-dates this feature's first boot** and is therefore a carry-over from an earlier feature's live probe, not this pass's doing. Note its `aggregateId`/`correlationId` is the literal string `live-order-1` — **not a UUID**, against the `UUID primary keys` convention.
- `_id: '11111111-1111-4111-8111-111111111111'` — a `credit.approved.v1` probe fact, same class, same provenance.
- `_id: '58251443-…'` / `ORD-LIVEBOOT-…` — this feature's declared `I3` fact.
**Why it is worth recording.** This feature is what makes the residue *visible and permanent*: `fromBeginning: true` (`PR5`, correctly chosen) means every synthetic fact ever injected into a dev fact topic is re-materialised into the read model on every fresh consumer group, forever. Feature 25's `GET /orders` will therefore list `ORD-LIVE-0001` alongside real orders, plus **five header-less placeholders** (`orderReference: null`, `headerComplete: false`) whose `order.placed.v1` is not on any topic. That is `R53` behaving exactly as specified — but feature 25 should expect it in its list-query fixtures rather than be surprised by it. Not attributable to feature 24 and not a defect.

### N8 — INFORMATIONAL — a Phase-2 `E11000` on `uq_order_reference` would be a poison pill
**File:** `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts:107-135`
**Owner:** none today; noted for feature 27 (`observability_reliability`)
**Observation.** The retry-exactly-once for `E11000` is scoped to Phase 1's `_id` upsert, and every other error propagates so Kafka redelivers (`PR7`, design §5.4 — deliberate). But `uq_order_reference` is a **unique** index, so if two distinct order ids ever carried the same `orderReference`, the Phase-2 `findOneAndUpdate` would throw `E11000` on **every** delivery, block the partition, and never recover — redelivery cannot fix a uniqueness violation. I hit this shape accidentally while building my own concurrency fixture (`MongoServerError: Plan executor error during findAndModify :: caused by :: E11000 … index: uq_order_reference dup key: { orderReference: "ORD-000001" }` raised at `idempotent-consumer.ts:60`) and confirmed it was my fixture's fault, not the code's — the producer-side invariant that `ORD-######` is unique is what makes this unreachable. Recorded because the DLQ/retry work of feature 27 is where a non-retryable write error should be classified, and this is a concrete instance to classify.

---

## 3. Traceability

### `R50` – `R55` → `specs/shared/test-matrix.md` §7

| `R<n>` | Row status | Verified how |
|---|---|---|
| **R50** | `DONE` | `apps/projector/src/timeline-projection.integration.spec.ts` › *R50 — appends an entry carrying eventId, eventType, occurredAt and a summary, and presents the timeline ordered by occurredAt rather than by arrival*. Case exists and boots the real `AppModule` over real Kafka + real MongoDB. `PR10`'s "sorted in the document" is `$sortArray` on `{occurredAt: 1, eventId: 1}` in `delta-to-pipeline.ts:36-41`; I re-proved it independently (probe **B**: ten facts delivered concurrently, stored order equals sorted `occurredAt` order). |
| **R51** | `DONE` | `timeline-projection.integration.spec.ts` › *R51 — leaves the read-model document unchanged when a fact with an already-present eventId is redelivered*, plus `projection-concurrency.integration.spec.ts` and `replay-determinism.integration.spec.ts`. Re-proved independently and harder — see §4. |
| **R52** | `DONE` | `out-of-order-facts.integration.spec.ts` › *R52 — order.despatched.v1 delivered BEFORE order.placed.v1 …*. Read the body: genuinely publishes `order.despatched.v1` first to an order with no document, asserts `status: 'despatched'` survives the later rank-1 `order.placed.v1`, and asserts `headerComplete` flips to `true` regardless of arrival order. Re-proved independently — see §4. |
| **R53** | `DONE` | `placeholder-document.integration.spec.ts` › *R53 — creates a placeholder document keyed by correlationId …* and *two DIFFERENT orders' placeholders coexist, both with `orderReference: null`*. Corroborated **live**: the running read model holds **five** coexisting placeholders with `orderReference: null` / `headerComplete: false` under the now-partial index. |
| **R54** | `TODO` (projector half evidenced) | Per gate-approved open point 3. Projector half: `read-model-sole-writer.spec.ts` + `projector-consumes-only.spec.ts` › *PR21 › declares no Drizzle dependency*. Non-vacuity re-proved independently — see §4. Gateway half owed to feature 25. |
| **R55** | `TODO` (projector half evidenced) | Per gate-approved open point 3. Projector half: `infrastructure/signal/update-signal.integration.spec.ts` (real NATS + real MongoDB). Re-proved independently — see §4. Gateway and web halves owed to features 25 and 26. |

Matrix arithmetic checked: `projector_read_model` row `0 → 4`, total `38 → 42`. Consistent. `R54`/`R55` left `TODO` exactly per row 3, and **no other row in the file was touched** — the diff is 8 lines, all inside §7 and the coverage-summary table.

### `PR1` – `PR29` → named tests

All 29 rows in `specs/projector_read_model/requirements.md` §3 name a real file and a real case. I enumerated every `describe`/`it` title across all 20 cited spec files and cross-checked. Every cited name exists. Notes:

- **All present and non-vacuous by inspection:** PR1, PR2 (both directions, plus a *non-vacuity of the text-scan itself* case), PR3, PR4, PR5, PR6, PR7, PR8, PR9, PR10, PR11 (but see **N6**), PR13, PR15, PR17, PR18, PR19, PR20, PR21, PR22 (including a *bites* case that proves the non-partial index genuinely rejects the second placeholder), PR23, PR25, PR26, PR27, PR28, PR29.
- **PR12, PR14, PR16** cite a `describe` **block** title rather than an `it` title. Each block contains real, table-driven `it.each` cases with real assertions (`order-status-rank.spec.ts` drives all thirteen rows through `impliedStatusOf`/`rankOf`; the PR14 block drives all thirteen envelope builders with an `occurredAt` deliberately far from "now"). Acceptable — the name is a genuine, addressable test name — but slightly looser than rule 4's "the test name in this table is the contract".
- **PR24** correctly delegates to the existing `apps/orders` parity spec and is **not** re-implemented. `apps/orders` is byte-unmodified: `git diff --stat apps/orders` and `git status --porcelain apps/orders` both empty, checked before, during and after my own mutation of the projector's variant.

---

## 4. The probes — what I ran and what I observed

Full `pnpm quality` and the full integration suite were **not** re-run (the implementer ran both; the claims under test here are specific, not suite-wide). What I ran instead: 5 targeted spec files, 4 hostile mutations of my own, 3 bespoke probe specs (10 cases) against real MongoDB / real NATS via Testcontainers, and 6 read-only query batches against the live compose stack. All three probe specs were deleted; `git status` carries no trace.

### Probe 1 — the atomic write (`PR7`). **PASS, under a harder attack than the submitted one.**

**(a) The filter is literally the check.** `idempotent-consumer.ts:60-64` is one `findOneAndUpdate` whose filter is `{ _id: scopeId, processedEventKeys: { $ne: dedupKey } }`. Nothing reads before it. The only preceding operation is `mongo-read-model-writer.ts:117`'s `updateOne(..., { $setOnInsert: … }, { upsert: true })` — a **write**, a no-op by construction on an existing document. There is no `findOne`, no `.includes()` in TypeScript, no compare-and-set loop anywhere in the service.

**(b) Proved by the driver's own command stream, not by reading.** My probe **D** attached `monitorCommands: true` to a real client and recorded the exact command names issued per `apply`:
```
first delivery : ['update', 'findAndModify']
redelivery     : ['update', 'findAndModify']
```
No `find`. No `aggregate`. Two operations, both writes, on both branches.

**(c) Genuinely concurrent, same `eventId` — 16 parallel deliveries (probe A).** `Promise.all` over 16 `apply` calls for one `eventId` against real MongoDB: **1 `processed`, 15 `duplicate`, `afterApplied` invoked exactly once, `events.length === 1`, `processedEventKeys.length === 1`, one document.**

**(d) The harder shape the submitted spec does not attempt — N separate connection pools (probe G).** The implementer's spec drives concurrency through **one** `MongoClient`, whose pool the driver serialises in ways a single process controls. I opened **12 separate `MongoClient`s**, each with its own pool and its own `MongoReadModelWriter`, fired all 12 at the **same `eventId`** on an **absent** document (so Phase 1's upsert races *and* Phase 2's apply races), with the production partial unique index in place, and repeated it **8 times**:
```
round 0..7 → { processed: 1, callbacks: 1, entries: 1, keys: 1 }   (every round)
final document count: 8
```
**(e) Two different `eventId`s interleaved across the 12 pools on an absent document (probe H), 8 rounds:** exactly 2 `processed`, exactly 2 entries, `status: 'stock_reserved'`, `statusRank: 2`, every round. No `E11000` ever escaped to a caller — the Phase-1 retry-exactly-once absorbed every insert race.

**(f) Restart mid-stream (probe C).** Applied 5 of an 8-fact stream, then simulated a process restart — **brand-new `MongoClient`, brand-new writer** — and replayed the **whole stream from offset 0**, twice:
```
replay #1 : duplicate ×5, processed ×3
replay #2 : duplicate ×8
final     : events.length 8, distinct eventIds 8, processedEventKeys 8, status 'completed'
```
Exactly one timeline entry survived per `eventId`. **This is the property feature 23 was rejected for failing** (`N1`: idempotency that looked right under test and evaporated across a restart). It holds here for the structural reason the design claims: the mark and the effect are the same bytes in the same write, so there is no window for a restart to land in.

**(g) Corroborated live.** The running read model: 36 documents, **zero** documents with a duplicate `eventId` inside `events[]`, and **zero** documents where `events.length !== processedEventKeys.length`.

### Probe 2 — `R52`, no status regression. **PASS.**

- The submitted `R52` case genuinely delivers `order.despatched.v1` (rank 5) **before** `order.placed.v1` (rank 1) through **real Kafka** to an order with no document, and asserts `status` stays `despatched` while both entries are appended and the header is filled. Read and confirmed.
- **The `statusRank` question the brief asked about — can `stock.*` / `credit.*` accidentally rank as 0 or null and regress something?** They cannot, for two independent reasons, and I verified both. In `order-status-rank.ts:45-48` the four status-less facts carry `{ status: null, rank: 0 }`; `delta-to-pipeline.ts:43-50` then emits `statusRank: { $max: [ { $ifNull: ['$statusRank', 0] }, 0 ] }` (a no-op) and, because `delta.impliedStatus` is `null`, `status: '$status'` — the field is written back to itself, so it is not merely "not lowered", it is **structurally incapable** of changing. My probe **E** confirms behaviourally: `order.completed.v1` (98), then `stock.released.v1`, then `credit.released.v1` → `status: 'completed'`, `statusRank: 98`, `events: 3`.
- **The `null` hazard is real and is closed in two places.** A missing `$statusRank` compares as `null`, which BSON orders **below every number**, so an unguarded `$gt: [1, '$statusRank']` is `true` and regresses a `completed` order to `placed`. `delta-to-pipeline.ts` `$ifNull`-guards **every** array and rank operand, making the pipeline total over any document shape; the backfill closes the same hazard at the data level. See probe 3 for the demonstration.
- **The reference clause of `R52`** is proven structurally, not behaviourally — see **N6**. Not a hole (no two facts write the same reference field), but the test name overstates it.

### Probe 3 — the backfill (`PR29`, `B7`). **PASS — and I confirmed the hazard is real, not theoretical.**

- **Runs before any consumption:** `main.ts:29` calls `backfillLegacyDocuments(db)` after `ensureReadModelIndexes(db)` and **before** `app.startAllMicroservices()` at line 58, against the **same** DI-managed connection (`app.get(MONGO_DB)`), not a second client. Guarded in the **fast** suite by `main-kafka-options.spec.ts` › *runs ensureReadModelIndexes and backfillLegacyDocuments BEFORE startAllMicroservices*.
- **Idempotent by construction:** filtered on `{ statusRank: { $exists: false } }`, and every document the projector itself writes carries `statusRank` from its very first apply. The second case of the B7 spec asserts a second run returns `0` **and** that a projector-written document is untouched.
- **Deleting its call makes a named test fail — I armed both halves myself** (verbatim failures in **N3**). The implementer did not record this; that is defect N3.
- **The fixture is seeded-shape, not clean-database.** `legacy-document-backfill.integration.spec.ts:28` builds `seededCompletedDocument(...)` by hand: nine timeline entries, `status: 'completed'`, `headerComplete: true`, `references` populated, and the type is literally `Omit<OrderTimelineDocument, 'statusRank' | 'processedEventKeys'>` — the pre-feature shape. It then replays **all nine facts using the seeded document's own nine `eventId`s**. A clean-database test cannot reach this bug; this one does.
- **I proved the hazard behaviourally myself (probe F), side by side in one test.** Two identical seeded-shape documents, one backfilled and one not, then `credit.released.v1` (rank 0) followed by the already-present `order.placed.v1`:
```
WITHOUT backfill -> { status: 'placed',    statusRank: 1,  events: 3 }   <- REGRESSED and DUPLICATED
WITH    backfill -> { status: 'completed', statusRank: 98, events: 2, outcome: 'duplicate' }
```
The status-less fact is what sets the null rank to `0`; the next real fact then outranks it and regresses a terminal order. Exactly the mechanism open point 9 predicted. The backfill is load-bearing.
- **Corroborated live, at the strongest level available.** I ran `apps/seed`'s **current** `toTimelineDocument` over `SAGAS` and diffed all six seeded documents field-by-field against the live, backfilled, replayed documents:
```
ORD-000001..ORD-000006 : client-visible diffs = NONE (all six)
statusRank  live == what apps/seed would now write (98,98,98,98,98,99)
processedEventKeys live == what apps/seed would now write, set-equal (9,9,9,9,9,5)
```
Every client-visible field is byte-identical to the fixture, and the backfill's derivation is **provably equivalent** to the seed writer's own. The live database confirms `missing statusRank = 0`, `missing processedEventKeys = 0` across all 36 documents.

### Probe 4 — `D7`, OI12's first real subject. **INDEPENDENTLY CONFIRMED. This is the headline result.**

I re-armed the `N5` mutation myself rather than accepting the report. Dropped `processedEventKeys: { $ne: dedupKey }` from the `findOneAndUpdate` filter in `apps/projector/src/infrastructure/messaging/idempotent-consumer.ts` — **banner untouched**, the exact "dedup nothing" shape the reviewer of feature 23 used to defeat the text-only guard.

**The text guard is blind to it, as designed:**
```
apps/orders  idempotent-consumer.parity.spec   →  Tests 11 passed (11)
```
**The behavioural guard catches it:**
```
apps/projector  idempotent-consumer.parity.integration.spec  →  Tests 4 failed | 3 passed (7)

× a second call for the same (eventId, consumer) pair does NOT run the work and reports duplicate
× a consumer constructed fresh over the SAME backing store still returns duplicate — a purely in-memory
  implementation must fail this
× the same eventId under a DIFFERENT consumer name runs — the key is the pair, not the id alone (R17)
× the post-apply callback runs exactly once on processed and NOT AT ALL on duplicate

AssertionError: expected 'processed' to be 'duplicate' // Object.is equality
  Expected: "duplicate"
  Received: "processed"          (all four, same signature)
```
**Matches the implementer's report exactly — 4 of 7, same four case names, same message.** The guard rebuilt after `N5` is genuinely armed on its first real subject; it no longer reads only a comment. `apps/orders` was byte-unmodified throughout (`git status --porcelain apps/orders` empty before, during and after), and the projector file was restored md5-identical (`feaba442…`).

Two structural points I confirmed while there. First, the conformance suite in `apps/projector` is a **genuine copy**: stripping every `//` line from both, `apps/orders/.../test-support/idempotent-consumer-conformance.ts` and `apps/projector/.../test-support/idempotent-consumer-conformance.ts` are **identical**. Second, the projector's banner satisfies case 4 non-trivially — it cites the canonical path, carries a `Divergence:` line explaining *why* `work` became a post-apply callback, and names a `Behavioural conformance:` file **that exists and is the file that just failed**.

### Probe 5 — `R54`, the only-writer guard (row 4). **PASS, non-vacuity proved independently.**

The guard's own non-vacuity case plants a fixture in `apps/notifications`. To avoid grading a guard against the app it grades itself with, I planted a **fourth** writer in a **different** app — `apps/gateway/src/__reviewer-fourth-writer.ts` with `import { MongoClient } from 'mongodb'` — and ran the guard:
```
× permits a mongodb import in apps/projector and apps/seed only
AssertionError: unexpected mongodb importer(s): gateway — R54 makes the projector the sole runtime writer:
  expected [ 'gateway' ] to deeply equal []
```
It fires. The fixture was removed; `git status --porcelain apps/gateway` is clean. The allow-list is two entries, `['projector', 'seed']`, with `apps/seed`'s reason stated **inside** the guard file's header (an offline fixture loader, never deployed, run before the system runs) exactly as row 4 required — and the guard additionally asserts, in the same case, that both allow-listed apps genuinely *do* import `mongodb`, so it cannot pass by matching nothing.

### Probe 6 — `R55`, the NATS signal. **PASS, verified independently of H1/H2.**

I wrote my own probe (**I**) driving the **real** `ProjectionApplyService` + `MongoReadModelWriter` + `NatsUpdateSignalPublisher` against **real NATS + real MongoDB**, with a `readmodel.>` wildcard subscriber counting frames:
- 3 applied facts → `readmodel.order.updated.<orderId>` ×3 and `readmodel.timeline.appended.<orderId>` ×3. **One pair per applied change, both subjects, every time.**
- 3 redeliveries of already-applied facts → **0 frames**.
- 8 concurrent deliveries of one new fact → 1 `processed`, 7 `duplicate` → **exactly 1 pair, not 8**.
- Total observed: `{ updated: 3, appended: 3, total: 6 }`, on exactly the two expected subjects and no others.
Suppression is **structural**, not a second `if`: `runOnce` returns `'duplicate'` before `afterApplied` is ever reached (`idempotent-consumer.ts:66-70`), and the signal publication *is* `afterApplied`. **No Kafka topic was created for it** — the live broker lists only `otc.{orders,fulfillment,billing}.facts.v1` and their `.dlq` siblings; a repo-wide grep for a `readmodel` topic constant returns nothing. The gate's NATS choice (open point 2) is what shipped.

### Probe 7 — row 1, the seed index. **PASS.**

- **The live dev index was actually replaced.** `db.order_timeline.getIndexes()` on the running stack:
```
uq_order_reference : { orderReference: 1 }, unique: true,
                     partialFilterExpression: { orderReference: { $type: 'string' } }
ix_status_updatedAt: { status: 1, updatedAt: -1 }
```
It is partial. And it is working: **five** documents currently coexist with `orderReference: null` — impossible under the old plain unique index.
- **`toTimelineDocument` writes both new fields**, `statusRank` from a **local, non-imported** copy of the PR12 table (`mongo.writer.ts:74-93`, header stating why it is not imported) and `processedEventKeys` from the fixture's own `events[].eventId` with the `projector:` prefix.
- **No placeholder was given a fake `orderReference`.** `placeholderSkeleton` (`mongo-read-model-writer.ts:38-58`) sets `orderReference: null`, and `delta-to-pipeline.ts:80-91` writes it only from a real `order.placed.v1` header. The gate's explicit "if declined, do **not** work around it by giving placeholders a fake `orderReference`" was not needed — and was not taken anyway.
- **Nothing else in `apps/seed` changed.** `git status --porcelain` lists exactly one `apps/seed` file. `apps/seed` remains green at 119/119, re-run in this pass.
- `ensureReadModelIndexes` fails **loudly** on `IndexOptionsConflict` (code 85), re-throwing a message that names the offending index *and* the `dropIndex` one-liner — not a silent continue.

### Probe 8 — task `I3`'s substitution. **Sound; one seam declared.** See finding **N4**.

### Probe 9 — scope. **PASS, exactly as declared.**

`git status --porcelain` after removing my probe files lists **precisely** the declared set and nothing more:
```
M .env.example                                M feature_list.json
M apps/projector/package.json                 M pnpm-lock.yaml
M apps/projector/src/app.module.ts            M specs/shared/test-matrix.md
M apps/projector/src/main.ts                  ?? progress/impl_projector_read_model.md
M apps/projector/vitest.config.mts            ?? progress/spec_projector_read_model.md
M apps/seed/src/writers/mongo.writer.ts       ?? specs/projector_read_model/
                                              ?? apps/projector/src/** (new files)
```
- **`pnpm-lock.yaml` carries no version bump.** `git diff --numstat` → **36 insertions, 0 deletions**. A purely additive diff cannot change a version; and reading it, every added line is an `apps/projector` importer entry resolving to a version already present elsewhere in the lockfile (`@nestjs/cqrs@11.0.3`, `mongodb@7.5.0`, `nats@2.29.3`, `kafkajs@2.2.4`, the three `@testcontainers/*@12.1.0`). No new catalog entry, matching open point 20.
- **`specs/shared/test-matrix.md` flipped only this feature's rows.** 8 changed lines: the four `R50`–`R53` rows to `DONE`, the `R54`/`R55` rows rewritten to the two-half form with `TODO` retained per row 3, and the two coverage-summary arithmetic lines (`0 → 4`, `38 → 42`). No other requirement group touched. Every other file in `specs/shared/` byte-unmodified.
- `.env.example` adds exactly the two declared variables in the `NOTIFICATIONS_*` shape.
- `feature_list.json`'s one-line diff is the earlier `pending → spec_ready`, as the implementer stated — not an implementation-pass edit.
- **`apps/orders` byte-unmodified**, confirmed repeatedly including while my own mutation of the projector's variant was live.
- No file under `packages/`, `apps/fulfillment`, `apps/billing`, `apps/notifications`, `apps/web` or `apps/gateway` was touched.

### Live end state — queried directly

```
otc_read_model.order_timeline
  documents ............................... 36
  missing statusRank ....................... 0
  missing processedEventKeys ............... 0
  documents with an intra-document
    duplicate eventId ...................... 0
  documents where
    events.length != processedEventKeys.length  0
  placeholders (orderReference: null) ....... 5   (headerComplete: false, all five)
  seeded ORD-000001..6 client-visible diffs
    vs apps/seed's own toTimelineDocument .. NONE
  indexes ................................. _id_, uq_order_reference (PARTIAL), ix_status_updatedAt
```
Matches the implementer's claims (36 documents, seeded documents backfilled, client-visible fields unchanged) on every point, and on the client-visible-fields point by a stronger method than the implementer used.

### Restore integrity

Four files mutated by me, all restored and hash-verified before the fast suites were re-run:

| File | md5 after restore |
|---|---|
| `apps/projector/src/infrastructure/messaging/idempotent-consumer.ts` | `feaba442d7c91257825264d6d576efca` |
| `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts` | `fac43b89b8fa109a7535aa390b24ebfa` |
| `apps/projector/src/main.ts` | `afd79ce8f256c4b24d0a0aebe75870a3` |
| `apps/projector/src/infrastructure/persistence/legacy-document-backfill.ts` | `bea52fdaa7609f3f047c57fa8f9afe4a` |

Each is byte-identical to the pre-mutation backup. `apps/projector` 111/111 and `apps/seed` 119/119 green afterwards. Their mtimes (`19:58`–`20:00`) are review activity, not implementation activity. Three temporary probe specs and one temporary `apps/gateway` fixture were deleted, leaving no trace in `git status`.

---

## 5. What must change before re-review

**No source change is required.** Both blocking items are artefacts.

1. **N1 (implementer)** — tick all 63 items in `specs/projector_read_model/tasks.md`, rewording any item whose delivered shape differs from the plan (the `billing_invoicing` precedent reworded five). At minimum **A2** (not routed to a separate agent) and **I3** (substituted — see N4) need reworded ticks rather than bare ones.
2. **N2 (leader)** — reset `progress/current.md` to its template or rewrite it for feature 24. It currently describes feature 22.
3. **N3 (implementer)** — add the `B7` deletion probe to `progress/impl_projector_read_model.md`, with the verbatim failure message, alongside H1–H4. The two mutations and their exact failures are recorded in N3 above if the implementer prefers to cite mine; running its own is better.
4. **N4 (implementer, one sentence)** — name the unwalked `gateway → orders → Kafka → projector → NATS` seam as owed to feature 25, rather than leaving it implied by the I3 substitution note.
5. **N6 (test_maintainer, a rename)** — rename `out-of-order-facts.integration.spec.ts:104` to what it proves, or add the clarifying sentence to the file header. No source change.

**N5, N7 and N8 are carried forward, not required for this feature.** N5 is a `specs/shared/` amendment best made at feature 25's close, when `R54`/`R55` actually flip. N7 is dev-stack hygiene with a note for feature 25's list-query fixtures. N8 is a retry-classification input for feature 27.

**Everything verified in §4 carries over.** The re-review needs only to confirm the five artefacts above and that no source file changed (a hash comparison against the four md5s in §4 plus `git status` is sufficient). It does not need to re-run any probe.

---

## 6. Effort record (parked — to be appended to `progress/history.md` on approval)

Not written to `progress/history.md`, because that file records **closed** features and this one is not closed. Parked here so the assessment-#7 baseline is not lost, and so the fix pass and the second review can be added to it.

Derived from artefact mtimes (local CEST, 2026-08-24), bracketed at the start by feature 23's commit `64a2a77` (`notifications_service`) at **15:29**:

- **Spec pass ≈ 17:16 → 17:24 (≈ 8 min of visible artefact activity; true start not recoverable, bounded below by the 15:29 commit).** `specs/projector_read_model/` created 17:16, `design.md` 17:20 (40 KB), `tasks.md` 17:22 (63 tasks), gate record `progress/spec_projector_read_model.md` 17:24 (21 open points, 4 taken to the gate as rows 1, 2, 3, 4 — all approved).
- **Human approval gate** — between 17:24 and the implementation pass.
- **Implementation ≈ 17:24 → 19:49, ≈ 2 h 25 min.** Intermediate artefacts: the live `I3` fact published to the real broker at `CreateTime 1787593299042` = **19:41:39** local, `specs/projector_read_model/requirements.md` (the `PR1`–`PR29` flip) 19:35, `progress/impl_projector_read_model.md` 19:49 closing the pass. Includes the four armed deletions (H1–H4), the D7 subversion probe, `pnpm quality` across 11 packages, the integration suite run twice, and the live boot that took the read model from 6 documents to 36.
- **Review pass 1 ≈ 19:49 → 20:12, ≈ 23 min**, of which ≈ 1 min 10 s was Testcontainers wall-clock (probe 1 at 15.9 s, probe 2 at 24.0 s, probe 3 at 9.8 s, plus three mutated integration runs) and ≈ 5 s the four targeted fast-suite runs. The balance was code reading, six read-only live-stack query batches, the `apps/seed` fixture-vs-live document diff, and writing this record. **Verdict: REJECTED, 2 blocking defects, 6 further findings.**
- **Scale for context.** `apps/projector/src` grew from a 4-file scaffold to **62 files / 4 666 lines**, with 111 fast tests in 13 files and 28 integration tests in 10 files. `specs/projector_read_model/` is 94 KB across three files — the largest spec set in the project after `billing_credit`.
- **The observation worth keeping for the trilogy.** Feature 23 was rejected for idempotency that passed under test and failed under restart. Feature 24's design answered that structurally — the dedup key lives in the `findOneAndUpdate` **filter**, so the mark and the effect are the same bytes in the same write — and it survived every attack I could build: 12 independent connection pools racing one `eventId` eight times over, a simulated process restart replaying the whole stream twice, and a driver-level command trace proving no read precedes the write. **The rejection here is entirely bookkeeping.** That distinction is the thing to record: the two blocking defects cost minutes to fix, and the property that took a whole feature to get right in feature 23 was right on the first submission here, because the spec pass made "the filter is the check" a requirement (`PR6`) rather than a style note.

---

*Reviewer: no source file was modified. No `git commit`, no `git push`. `feature_list.json` id 24 set `spec_ready` → `in_progress`.*

---

# Round 2 — 2026-08-24

**Verdict: APPROVED.** `feature_list.json` id 24 flipped `in_progress` → `done`; entry appended to `progress/history.md` with its effort record.

Bounded to N1, N2, N3 as instructed. N4–N8 carried, not re-raised. Nothing from Round 2 disturbs any Round 1 result: the concurrency attack, the D7 subversion and the live-stack queries were **not** repeated, and the four md5s recorded in Round 1 §4 still hold, so the source those probes ran against is provably the source being approved.

## Probe 1 — the rewordings. **All honest. Every checkable claim verified against disk.**

First, a count correction that matters for the record. The brief said *"eleven boxes were reworded"* and named **ten** (A2, A6, B7, C8, D4, E2, E8, G3, I3, J1). On disk, **eight** boxes carry a `**Reworded to reality:**` / `**Substitution recorded honestly:**` marker: **A2, A6, C8, D4, E2, G3, I3, J1**. The two on the brief's list that are not reworded are **B7**, whose text is **byte-identical to the original** (I have it verbatim from Round 1 — it was ticked *as written*, which is the correct outcome now that the deed behind it was performed), and **E8**, which was **extended** with results rather than reworded. Neither is a problem; the count was approximate and the substance is what I checked.

| Box | Claim | Verified how | Verdict |
|---|---|---|---|
| **E2** | `delta-to-pipeline` is called from `mongo-read-model-writer.ts`, **not** from `projection-apply.service.ts` | Repo-wide grep for `deltaToPipeline`: exactly one value import, `mongo-read-model-writer.ts:13`, used at `:102`. `projection-apply.service.ts`'s five imports are `@otc/contracts`, `../domain/fact-projection`, and three own-layer ports — **no** infrastructure import, no `mongodb`. | **TRUE**, and the reword's editorial claim (a *stricter* reading of the port boundary than the task's wording) is correct: the application layer never sees the pipeline shape. |
| **D4** | six cases, not four — the original four plus a `$sortArray`-guard case and the `PR13` case added after Round 1's predecessor pass | `grep -c '^\s*it('` on `delta-to-pipeline.spec.ts` → **6**. The two extra cases are *processedEventKeys and events are always $sortArray-wrapped and $ifNull-guarded on their input* and *PR13 — order.cancelled.v1 applies $ifNull ONLY to cancellationReason*. | **TRUE** |
| **G3** | `PR13` is **not** proven in `out-of-order-facts.integration.spec.ts`; its proof lives at unit level in `delta-to-pipeline.spec.ts` | `out-of-order-facts.integration.spec.ts` has exactly **2** `it` cases (R52, PR11) and asserts nothing about `cancellationReason`. `delta-to-pipeline.spec.ts:60` carries the PR13 case. `requirements.md` §3's PR13 row already pointed at `delta-to-pipeline.spec.ts` (verified Round 1). | **TRUE** — but see N10 below for two residues the reword left behind. |
| **I3** | the substitution is recorded on the box itself | Box now carries the full substitution note (no live `orders`/`gateway` service; direct Kafka publish of one genuinely new `order.placed.v1`; `saga_commands` 80 → 80). Consistent with the impl record and with the fact I read off the live topic in Round 1 (`CreateTime:1787593299042`). | **TRUE** |
| **C8** | domain ≥ 80 %; measured at end of pass; `test:coverage` never starts a container | Ran it: `domain 97.59% stmts / 88.46% branch`, 111/111, 13 files. The no-container claim is structural — `vitest.config.mts` excludes `src/**/*.integration.spec.ts`. | **TRUE** (figure matches to the second decimal) |
| **A6** | build + typecheck exit 0 today | `pnpm --filter @otc/projector typecheck` → **0**; `build` → **0**. | **TRUE** |
| **E8** | lint green; **and both ESLint guards were confirmed firing on this service** | **Re-armed both myself** rather than accepting the claim — see below. | **TRUE** |
| **J1** | `pnpm quality` green, 0 lint / 0 typecheck errors | `pnpm exec eslint apps/projector/src --max-warnings=0` → **0**; typecheck → **0**. Full `pnpm quality` not re-run (Round 1 corroborated it by package). | **TRUE** |
| **A2** | config built directly, **not** routed to `test_maintainer` | Process deviation, self-declared on the box. | **Adequate** — see judgement below. |

**E8 re-armed independently.** This is the class of claim this project has been bitten by twice (feature 23's `N5`: a guard that read only a comment), so I broke both guards myself rather than take the box's word:
```
# stray `mongodb` import prepended to apps/projector/src/domain/order-status-rank.ts
1:1  error  'mongodb' import is restricted from being used. Domain layer must stay
            framework/infrastructure free (see CLAUDE.md § Non-negotiables)   no-restricted-imports

# @Inject(...) stripped from ProjectFactCommandHandler's constructor
13:15  error  Bare-type constructor injection on a Nest-decorated class is forbidden here —
              add an explicit @Inject(TOKEN). …                              no-restricted-syntax
```
Both fire on **this** service. Both files restored and hash-verified (`order-status-rank.ts` `43daf0b7…`, `project-fact.command-handler.ts` `8442f1e0…`, each identical to its pre-mutation backup).

**Judgement on A2 and J1 (the process deviation).** Both boxes instructed routing to a cheaper agent tier — `test_maintainer` for the two vitest configs, `suite_runner` for `pnpm quality` — and both were done directly, with the reason stated on the box (*"this invocation had no agent-launching capability of its own to route to"*). **Recording it on the box is adequate, and is the right call.** The deviation is one of *cost*, not of *substance*: A2 is config-only with no source consequence and its output is inspectable in one diff (6 added lines to `vitest.config.mts`, one new file), and J1 is a command whose exit code and counts are the deliverable either way. Nothing about the delivered artefact would differ had the tier been used. The alternative — ticking the box over "Route to `test_maintainer`" while not having done so — is precisely the drift N1 exists to stop, so declaring it is the behaviour the rule wants. Noted for the effort record as a cost observation, not a defect.

## Probe 2 — 63/63, nothing stale. **CONFIRMED.**

```
total boxes : 63
ticked      : 63
unticked    :  0
```
Beyond the count, I checked for the failure mode the brief named — a tick over a description that no longer matches:
- **Every `.ts` file named anywhere in the 63 boxes exists on disk.** I extracted all backticked `*.ts` paths and resolved each against `apps/projector/src`, `apps/seed/src` and `apps/orders/src`: **zero missing**. No box is ticked over a file that was never created.
- **Every `R<n>`/`PR<n>` the boxes claim to prove is traced to a real, existing named case** — established in Round 1 by enumerating every `describe`/`it` title across all 20 cited spec files; nothing in the source tree has changed since (four md5s + `git status` confirm).
- The `H1`–`H5` and `I1`–`I4` boxes are ticked over deeds recorded verbatim in `progress/impl_projector_read_model.md`, and I independently reproduced the substance of `D7`, `H1`/`H2`'s property and `B7`'s in Round 1 and this round.

Two residues survive, folded into one non-blocking finding:

### N10 — LOW — `G3`'s reword corrected the task box but not two things downstream of it
**Owner:** test_maintainer (comments only; no assertion, no source, no traceability change)
1. `apps/projector/src/out-of-order-facts.integration.spec.ts:2` — the file's own header still reads `// … or overwriting newer references. PR11; PR12 integration half; PR13.` The `PR13` there is now contradicted by the very reword that fixed the box. This is the *inverse* of N1's drift: the checklist was corrected and the artefact's description was not. Harmless to traceability — `requirements.md` §3 routes PR13 to `delta-to-pipeline.spec.ts`, and I confirmed the file asserts nothing about `cancellationReason` — but it is a stale claim in the one place a reader looks first.
2. `G3` and `G2` both still say a case name is quoted **"(verbatim)"** from the matrix sketch column. Neither is: the real names are prefixed `R52 — …` / `R50 — …` and reworded. No traceability breaks, because `specs/shared/test-matrix.md`'s Status cells carry the **actual** names (verified Round 1) and that is what matrix rule 4 makes the contract. Drop the word, or say "name adapted; the matrix Status cell carries the real one".

Also recorded, since I checked it and it is not quite right: **G3's justification prose** argues `order.cancelled.v1` fires at most once *"by construction (the dedup filter stops a second delivery)"*. The dedup filter stops a redelivery of the **same `eventId`**; two *distinct* cancellation facts would both apply. The real reason the case is unreachable is that `cancelled` is **terminal** in the order state machine, so a second cancellation is never emitted. Right conclusion, loose reason. Worth one word if the file is touched anyway.

## Probe 3 — N3's failures and the restoration. **CONFIRMED.**

**Restoration is genuine — this was the main thing asked, and it is the strongest check available.** All four files I mutated in Round 1, plus the two the implementer mutated for B7, hash **identically to my Round 1 post-restore hashes**:
```
idempotent-consumer.ts        feaba442d7c91257825264d6d576efca   (unchanged since Round 1)
delta-to-pipeline.ts          fac43b89b8fa109a7535aa390b24ebfa   (unchanged since Round 1)
main.ts                       afd79ce8f256c4b24d0a0aebe75870a3   (B7a mutated and restored — unchanged)
legacy-document-backfill.ts   bea52fdaa7609f3f047c57fa8f9afe4a   (B7b mutated and restored — unchanged)
```
Because these match Round 1 exactly, **every probe in Round 1 §4 ran against the identical bytes now being approved** — the concurrency attack, the restart replay, the command-stream trace and the D7 subversion all carry over without re-running any of them.

**The recorded failures are the ones I produced myself.** `progress/impl_projector_read_model.md` now carries **B7a** (delete the call) and **B7b** (neuter the body) with verbatim messages, source excerpts and line numbers:
```
B7a: AssertionError: expected -1 to be greater than -1
     ❯ src/main-kafka-options.spec.ts:27:26
B7b: AssertionError: expected +0 to be 1 // Object.is equality
     ❯ …/legacy-document-backfill.integration.spec.ts:96:24   (case 1)
     ❯ …/legacy-document-backfill.integration.spec.ts:145:22  (case 2)
```
These match, message for message and line for line, what I obtained independently in Round 1 before the implementer had run them. The record also states plainly that H1–H4 *"are not `B7`'s own deletion, which the reviewer correctly flagged as missing (N3)"* — an honest attribution rather than a quiet backfill of the omission.

**Targeted re-runs (per the brief, not the world):**
```
main-kafka-options.spec.ts                          3 passed (3)
legacy-document-backfill.integration.spec.ts        2 passed (2)   [Testcontainers MongoDB]
apps/projector full unit suite                    111 passed (111) in 13 files
apps/projector typecheck / build / eslint          exit 0 / 0 / 0
git status --porcelain apps/orders                 empty
git diff --numstat  .env.example 8/0  mongo.writer.ts 53/1  test-matrix.md 8/8   (all identical to Round 1)
```

## Probe 4 — `progress/current.md`, the whole file. **C2 satisfied; two residues recorded.**

The diff is **3 lines changed / 3 added**, confined to the header block and the Goal paragraph:
- `**Feature:**` now `projector_read_model` (id 24, phase 12, `sdd: true` — gate passed, 21 open points, 4 flagged and all approved).
- `**Status:**` now `in_progress`, and states the rejection accurately: *"rejected at review on **bookkeeping only** (N1 `tasks.md` 0/63 ticked, N2 this file stale). **Zero code defects found.**"*
- `## Goal` rewritten to Phase 12 and the Projector. **No occurrence of "Phase 9" survives anywhere in the file** (grepped case-insensitively across all 137 lines), and the Fulfillment goal text is gone.

That is the defect N1-round-1 named — *"it would point a fresh session at a feature closed two commits ago"* — and it is fixed: a resumed session now reads the right feature, the right phase and the right status. **C2 marked `[x]`.**

Two residues I record rather than block on, because blocking would be inconsistent with my own Round 1 wording (which asked for the *pointer* to be corrected) and with every prior close in this project:

### N11 — LOW — `current.md`'s log sections are cumulative and now contain no feature-24 entry
**Owner:** leader, to fold into the wrap-up
`## Decisions taken this session` still opens with **`billing_remittance_intake` (22) done — Phase 10 closes** and runs ~24 lines of feature 19/21/22 material; `## Notes` carries advisories back to feature 12. That is how the file has been operated since phase 7 — an append-only working log under a live header — and features 17–23 all closed with the same shape, so it is convention rather than regression. But two consequences are worth naming. **(a)** Nothing about feature 24 appears in the log at all: not the 21 open points, not the four gate approvals, not the rejection. The Status line carries it in one sentence and nothing else does. **(b)** Line 73 now asserts something false: *"the first Mongo client config in the repo (**apps/projector is still a scaffold**)"* — it has not been a scaffold since this feature landed. The file's own template says to move the summary to `history.md` and reset on close; that has never happened, and this feature's close is the natural moment. The leader's own note at line 110 — *"the reviewer has now failed C2 on this three times"* — is the standing acknowledgement.

## Findings surviving Round 2

- **N4 – N8** (Round 1, carried, not re-raised as instructed): N4 the unwalked gateway→orders→Kafka→projector→NATS seam, owed to 25; N5 matrix rule 3's relaxation recorded only in a #7-local file; N6 `out-of-order-facts.integration.spec.ts:104`'s name overstates its assertion; N7 the three synthetic-probe documents that `fromBeginning: true` makes permanent; N8 the Phase-2 `E11000` poison-pill class, for feature 27.
- **N10** (new, LOW) — G3's reword left `out-of-order-facts.integration.spec.ts:2`'s header still claiming PR13, and left two "(verbatim)" claims that are not; plus one loose justification (dedup filter vs terminal state).
- **N11** (new, LOW) — `current.md`'s cumulative log has no feature-24 entry and carries one now-false claim at line 73.

**None blocking.** All six are comment, prose or scheduling items with named owners; not one touches an assertion, a requirement mapping or a line of source.

## Revised checkpoint boxes

- **C2** — `[x]`. `progress/current.md` names the active feature, phase and status. Residues in N11.
- **C5** — `[x]`. `progress/history.md` entry with effort record appended on this approval. No stray files: my two temporary mutations were restored hash-identical and no probe file was created this round.
- **C6** — `[x]`. `specs/projector_read_model/tasks.md` **63/63**, eight boxes honestly reworded, every named file present on disk, no tick over a stale description beyond N10's two comment-level residues.

All other boxes stand as walked in Round 1 §1.

## Round 2 cost

**≈14 min.** Two ESLint mutation probes (~20 s), one coverage run, typecheck + build + eslint, three targeted vitest runs (~1 min including one Testcontainers MongoDB start), six greps over `tasks.md` and the source tree, one file-existence sweep across all 63 boxes, and a full read of `progress/current.md`. No live-stack query, no container beyond the one integration file, no repetition of Round 1's probes.

---

*Reviewer: no source file was modified — two files were mutated for the E8 re-arm and restored hash-identical. No `git commit`, no `git push`. `feature_list.json` id 24 set `in_progress` → `done`.*
