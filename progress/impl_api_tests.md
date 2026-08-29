# impl: api_tests (feature 31, phase 18)

## What was built

`apps/gateway/src/black-box-api.integration.spec.ts` — black-box API tests through the REAL, spawned Gateway, over real HTTP (`supertest` as an HTTP client only, no `TestingModule`, no stub responders), against a REAL fleet: Fulfillment, Billing, Projector, Orders and, for the first time in this repo, the Gateway itself — all five as genuine spawned OS child processes (`spawn-real-service.ts`/`spawn-real-projector.ts`, extended in place, not forked), backed by Testcontainers MySQL x3, Kafka, an auth-free NATS (`open-nats-test-fixture.ts`), and an authenticated MongoDB.

This closes the gap the brief named verbatim: `orders.integration.spec.ts` and siblings exercise an in-process Gateway against stubbed downstream RPC; `saga-e2e-verification.integration.spec.ts` spawns a real fleet but never the Gateway (its own header says so). This file is the first place both meet.

One shared fleet, built once in `beforeAll` (600s override), torn down once in `afterAll` (180s override) — mirrors `saga-e2e-verification`'s own fleet-reuse decision. Reference data is hand-seeded via raw SQL through `MySqlWorkerClient` (never `apps/seed`, which fabricates a much larger unrelated dataset), with the one deliberate difference from `saga-e2e-verification`'s own fixture: `PRD-0001` priced 24999 (matches `apps/seed/src/data/products.data.ts`'s real seed value) so `quantity=1` totals `.99` — the brief's own stated mechanism for R42.

## Scenarios (4 `it()`s, all in one `describe`)

1. **Full happy path** — `POST /orders` (qty 2, 49998 — not `.99`) → poll `GET /orders/{id}` to `invoiced` (a resting state, not a transient one — CLAUDE.md's binding "synchronise on terminal or monotonic evidence" ruling) → `GET /invoices?orderReference=...` to resolve the Billing-internal `invoiceId` (the same resolution path the Gateway's own `RegisterPaymentHandler` uses) → `POST /invoices/{id}/payments` → poll to `completed`. Proves R13/R24 end-to-end over HTTP for the first time.
2. **Full compensation path (R28)** — `POST /orders` (qty 1, 24999, `.99`) → poll to `cancelled` → `cancellationReason === 'credit_rejected'` → both compensation facts present as distinct timeline entries, `credit.rejected.v1` proven strictly before both `stock.released.v1` and `order.cancelled.v1` → Fulfillment's own `reservations` table (via `MySqlWorkerClient`, never inferred from the order's status field) shows `status: 'released'`.
3. **Idempotency (R48/B10)** — same `paymentReference` registered twice against the real Gateway: first `201`/`accepted`, second `200`/`duplicate` with `Idempotent-Replay: true`; Billing's own `payments` table (`MySqlWorkerClient`) shows exactly one row.
4. **Cheap extras** — no bearer token → `401`; malformed order id → `400`; a never-issued id → `404`.

## The honest finding (scenario 2) — armed, not assumed

First real run against the real fleet failed on `stock.released.v1` vs `order.cancelled.v1` relative array order (`stock.released.v1` at index 4, `order.cancelled.v1` at index 3 — the "wrong" way round). Root-caused by reading, not guessing:

- `apps/orders/src/application/saga-fact-handler.ts:161` — `order.cancel(reason, ctx, compensationSteps)` where `ctx = transitionContextFrom(envelope)`, i.e. the **incoming `stock.released.v1` envelope's own `occurredAt`, reused verbatim** ("never a newly-read clock value here", per that file's own comment on `recordSagaCompletionIfClosed`).
- `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts:36-39` — the read model's `events` array is `$sortArray`-ed by `{occurredAt: 1, eventId: 1}`, not by processor consumption order.

Consequence: `order.cancelled.v1.occurredAt` is **byte-identical** to `stock.released.v1.occurredAt` by design, every time this compensation path runs (not just this run) — so the tiebreak falls to a random UUID (`eventId`), and which of the two sorts first in `GET /orders/{id}`'s `events[]` is a coin flip. This is a genuine system property, reported plainly per the brief's own instruction rather than weakened into something that always passes.

Fix applied to the test (not to production code — out of this feature's scope): dropped the false claim (`stockReleasedIndex < orderCancelledIndex`), kept what's actually true and now asserted (`creditRejectedIndex` strictly before **both**), and added a positive assertion proving the tie itself (`orderCancelledOccurredAt === stockReleasedOccurredAt`) with an inline comment naming the exact call site. The real causal/precondition guarantee R28 names — Orders never cancels until it has itself consumed `stock.released.v1` — remains proven at the saga level by `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts` (test-controlled `occurredAt`, no tie possible there). Re-run against a fresh real fleet after the fix: green.

## Traceability (`specs/shared/test-matrix.md`)

- **R24** — API half flipped TODO → DONE (scenario 1).
- **R28** — e2e half flipped TODO → DONE, row rewritten to record the finding above rather than overclaim.
- **R48** — flipped from "RPC-level only, no Gateway yet" to DONE at the sketch's own `api/` level (scenario 3), RPC-level rows kept as the deeper race-focused proof.
- R42 already `DONE` (billing-level); not touched — this feature's own reliance on the `.99` rule is exercised, not separately re-proved.

## Real results

- `pnpm --filter @otc/gateway run typecheck` — clean.
- `npx eslint apps/gateway/src/black-box-api.integration.spec.ts` — clean, no output.
- `pnpm --filter @otc/gateway run test:integration -- black-box-api`:
  - First run (pre-fix): `Test Files 1 failed | 9 passed (10)`, `Tests 1 failed | 47 passed (48)`, exit 1 — the scenario-2 finding above.
  - Second run (post-fix): `Test Files 10 passed (10)`, `Tests 48 passed (48)`, exit 0. (All 10 `*.integration.spec.ts` files in the gateway app ran, not only mine — `black-box-api` filters by name substring but the config's `include` glob still collects the full integration suite; every file passed.)
- `pnpm --filter @otc/gateway run test` (fast suite, unaffected — new file lives outside its glob): `30 files, 121 tests`, all passed.
- `./init.sh`: exit 0.

## Scope discipline

Touched only `apps/gateway/src/black-box-api.integration.spec.ts` (new) and `specs/shared/test-matrix.md` (R24/R28/R48 rows), per the brief's stated boundary. `feature_list.json` untouched (reviewer's call). No production code touched — the scenario-2 finding is a read-model/behaviour observation, not a fix I was scoped to make.

## Docker stack — final state

Stopped `otc-orders otc-fulfillment otc-billing otc-projector otc-gateway` before the test run (per the brief, to free ports/avoid any conflict with the spawned fleet). One stray leftover Testcontainers set (from a redundant verbose-reporter re-run I killed early to save time) was cleaned up by hand (`docker stop`/`docker rm`) rather than left for Ryuk. Restarted the app containers with `WEB_PORT=3010 pnpm dc:up:apps`; all 16 `otc-*` containers, including the 5 stopped ones, are confirmed **healthy** as of the end of this session.

---

## R28 timeline-ordering fix

Follow-up pass, driven by `progress/review_api_tests.md` D1/D2/D3 (the reviewer's REJECTED verdict on this feature). Fixes the real system defect the original scenario 2 found and then locked in place instead of reporting.

### The fix, and why this one

**Applied the reviewer's Option A**, verified rather than trusted: `delta.statusRank` (`apps/projector/src/domain/projection-delta.ts`) is a pure function of `eventType` (`rankOf`, `order-status-rank.ts`), already computed for every fact but never carried onto the timeline entry itself. Now it is:

- `TimelineEntryDelta.statusRank` (`projection-delta.ts`) — new field, same value `ProjectionDelta.statusRank` already carries.
- `fact-projection.ts`'s `entryOf()` sets it via `rankOf(envelope.eventType)`.
- `delta-to-pipeline.ts`'s `entryDoc` carries it; `events`'s `$sortArray` key becomes `{occurredAt: 1, statusRank: 1, eventId: 1}` — was `{occurredAt: 1, eventId: 1}`.
- `order-timeline.document.ts`'s `events[]` item type gained `statusRank: number`.
- `apps/gateway/.../mongo-order-read-model.adapter.ts`'s `EXCLUDE_INTERNAL_FIELDS` gained `'events.statusRank': 0` — necessary because `order-read-model-mapper.ts:159` passes `doc.events` straight through (no field-by-field rebuild), so without this exclusion the internal rank would have reached the wire despite `OrderTimelineDocumentLike`'s type not declaring it (TypeScript's structural typing does not strip excess runtime properties). Confirmed live: the fresh `.99` order's `GET /orders/{id}` response below carries no `statusRank` anywhere in `events[]`.

**I verified the reviewer's determinism claim myself rather than taking it on trust**, per the brief: `statusRank` is `rankOf(eventType)`, a total, pure, side-effect-free function over a closed 14-entry table — identical on every replay of the same fact, exactly as deterministic as the `eventId` it now merely backs up in the sort key. PR15's byte-identical-replay guarantee holds.

**Did not take Option C** (a fresh clock read in `saga-fact-handler.ts`): confirmed by reading `apps/orders/src/application/saga-fact-handler.ts` that `ctx.occurredAt` (the same value `order.cancel()` uses) also feeds `recordSagaCompletionIfClosed`'s `otc_saga_completion_ms` metric; a fresh timestamp there would silently corrupt that measurement. `apps/orders/**` is untouched by this fix — Option A is entirely within `apps/projector/**` plus the one gateway projection-exclusion line, exactly as the reviewer's ~15-line estimate implied.

### Backfill — needed, and shipped

**Conclusion: yes, a backfill was needed**, and I did not treat this as optional. A terminal order (`cancelled`/`completed`) receives no further fact, so its `events[]` would never be re-sorted by the new key and would carry the wrong, randomly-tiebroken order **forever** — this is exactly the shape `legacy-document-backfill.ts` already exists to prevent for the *other* PR29 gap (top-level `statusRank`), so the precedent directly applies here too.

New file `apps/projector/src/infrastructure/persistence/timeline-entry-rank-backfill.ts` — `backfillTimelineEntryRanks(db)`, called from `main.ts` immediately after `backfillLegacyDocuments`, before Kafka consumption starts (same boot-ordering reasoning as the existing backfill). Filtered on `{'events.statusRank': {$exists: false}}` (matches a document if ANY element lacks the field — idempotent by construction, same technique the existing backfill uses for its own top-level field). Recomputes every entry's `statusRank` from its own `eventType` via a duplicated Mongo `$switch` (mirrors `RANK_TABLE`, same "duplicate rather than import across the domain/infra boundary into an aggregation expression" precedent `STATUS_RANK_SWITCH` already sets) and re-sorts `events[]` by the identical `{occurredAt, statusRank, eventId}` key.

Confirmed live: booting the projector against the running dev stack's pre-existing MongoDB backfilled **17 documents** in one shot (log: `[projector] timeline-entry-rank-backfill: 17 document(s) backfilled`), including all 8 of the reviewer's leftover `.99` orders — verified below.

### Guarding the fix — armed, verbatim

Per the fact-emission-guard rule, the sort-key change needed a test that fails when the guarantee is removed, and per the reviewer's own note nothing in the repo previously exercised `$sortArray`'s equal-`occurredAt` path at all. Two new tests, both arm-tested by literally reverting `delta-to-pipeline.ts`'s `sortBy` line back to `{occurredAt: 1, eventId: 1}`, running, then restoring it:

1. **Pure unit** (`delta-to-pipeline.spec.ts`, new `it`) — checks the JS shape of the emitted pipeline stage.
2. **Real MongoDB integration** (new file `timeline-entry-rank-tiebreak.integration.spec.ts`, Testcontainers) — the one the reviewer's note is actually about: publishes `stock.released.v1` (rank 0) and `order.cancelled.v1` (rank 99) for the SAME order with the SAME `occurredAt`, through the real `MongoReadModelWriter` → real `$sortArray` execution against a real server, with `eventId`s deliberately chosen adversarially (`order.cancelled.v1`'s eventId sorts lexicographically BEFORE `stock.released.v1`'s) so a naive eventId-only tiebreak reproduces the exact defect rather than passing by luck. A second `it` in the same file arms `backfillTimelineEntryRanks` against a hand-built pre-fix document.

Verbatim failure output with the guard reverted:

```
 FAIL  src/infrastructure/persistence/delta-to-pipeline.spec.ts > delta-to-pipeline — the emitted $set stage tree > processedEventKeys and events are always $sortArray-wrapped and $ifNull-guarded on their input
AssertionError: expected { '$sortArray': { …(2) } } to match object { '$sortArray': { sortBy: { …(3) } } }
- Expected
+ Received
  {
    "$sortArray": {
      "sortBy": {
        "eventId": 1,
        "occurredAt": 1,
-       "statusRank": 1,
      },
    },
  }
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

```
 FAIL  src/infrastructure/persistence/timeline-entry-rank-tiebreak.integration.spec.ts > timeline-entry-rank tiebreak — R28 (Testcontainers, real MongoDB) > a status-less compensation fact and the status-bearing fact it causes, sharing one occurredAt, sort by CAUSAL rank rather than by the random eventId — regardless of publish order
AssertionError: expected [ 'order.cancelled.v1', …(1) ] to deeply equal [ 'stock.released.v1', …(1) ]
- Expected
+ Received
  [
-   "stock.released.v1",
    "order.cancelled.v1",
+   "stock.released.v1",
  ]
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

Restored the fix; both files green afterward (`delta-to-pipeline.spec.ts`: 7/7; `timeline-entry-rank-tiebreak.integration.spec.ts`: 2/2). `legacy-document-backfill.integration.spec.ts` (the pre-existing sibling backfill test) also re-verified green, unaffected by the type change its own fixture needed (`events[]` items there now typed `Omit<..., 'statusRank'>[]` to keep representing the genuine pre-fix shape).

### D2 — the defect-locking assertion removed

`black-box-api.integration.spec.ts` scenario 2: removed `expect(orderCancelledOccurredAt).toBe(stockReleasedOccurredAt)` as the ONLY assertion, and the 30-line "HONEST FINDING" comment documenting the coin-flip. Retitled the `it()` to name the causal-order clause explicitly (`"...separately visible as distinct timeline entries IN CAUSAL ORDER..."`) and restored R28's own assertion: `expect(stockReleasedIndex).toBeLessThan(orderCancelledIndex)`. This now passes because the system is correct, not because the test stopped checking. Kept the tie assertion (both entries still genuinely share `occurredAt` by design — that has not changed and is not the bug) but reworded its message to state that plainly rather than as a "this is why the order is unreliable" excuse.

### D1 — `specs/shared/test-matrix.md` R28 row rewritten

Both halves now read `DONE`. Integration half's evidence text corrected to say only what it genuinely proves (the state-machine precondition, not the read-model clause — folding in N4's overstatement finding since I was already rewriting this exact text). e2e/API half cites the same test (describe/it text, matching R24/R48's own established convention in this file) now proving the FULL clause, with the finding narrative rewritten to describe behaviour rather than naming assessment-#7 production file paths (`saga-fact-handler.ts`, `delta-to-pipeline.ts` no longer appear in the row itself — C7), pointing instead to this document and to `progress/review_api_tests.md` §1 for detail.

### N3 (web sort) — checked, no change made, reasoning stated

`useOrderDetail.ts:92`'s SSE-append path re-sorts with `localeCompare` + `Array.prototype.sort` (stable), which ties on `occurredAt` and falls back to the entry's position in the pre-sort array. I concluded this does **not** need a change: the only tie that exists anywhere in this domain is a status-less trigger fact and the status-bearing fact it directly and immediately causes (`order.cancel()` always reuses its trigger's own `occurredAt` — not only the `stock.released.v1` case scenario 2 covers, but every direct-cancel path, e.g. R26's `stock.rejected.v1`), and the trigger fact is structurally guaranteed to be produced, and therefore to arrive over SSE, before the fact it causes (Orders cannot cancel until it has itself consumed the trigger). A stable sort preserves arrival order on a tie, so the client's own tiebreak already agrees with the server's new rank-based one for the one tie this system can produce. I did not change `apps/web` — this is a narrowly-scoped conclusion, not a web pass, and I'm flagging the reasoning here in case a future case (e.g. out-of-order stream replay on reconnect) proves it wrong.

### Real test counts and exit codes

- `pnpm --filter @otc/projector run typecheck` — exit 0.
- `pnpm --filter @otc/gateway run typecheck` — exit 0.
- `pnpm --filter @otc/projector run test` (fast suite) — `Test Files 15 passed (15)`, `Tests 134 passed (134)`, exit 0.
- `pnpm --filter @otc/gateway run test` (fast suite) — `Test Files 30 passed (30)`, `Tests 121 passed (121)`, exit 0 (unchanged from the reviewer's baseline).
- `npx eslint` on every touched/new file — exit 0, no output.
- `pnpm --filter @otc/gateway run test:integration` (full Testcontainers suite, real MySQL x3 + Kafka + NATS + MongoDB, app containers stopped) — `Test Files 10 passed (10)`, `Tests 48 passed (48)`, exit 0.

### Live `.99` confirmation against the running dev stack

Stopped `otc-orders otc-fulfillment otc-billing otc-projector otc-gateway`, ran the gateway integration suite, restarted with `WEB_PORT=3010 pnpm dc:up:apps`. The restarted projector's boot log: `[projector] timeline-entry-rank-backfill: 17 document(s) backfilled`.

- **Every pre-existing `.99` cancelled order in the dev read model** — `GET /orders?status=cancelled` found 10 with a `.99` total (`ORD-000006`, `ORD-000008`, `ORD-000010` through `ORD-000017`; the reviewer's own review names 8 orders it placed, so at least 8 of these 10 are theirs, possibly all 10), each re-fetched via `GET /orders/{id}` after the backfill: **10/10 now `release-first`** (`stock.released.v1` at index 3, `order.cancelled.v1` at index 4 in every one).
- **5 freshly-placed `.99` orders** through the live Gateway after the fix (`ORD-000018` plus 4 more, quantity 1 × `PRD-0001` @ 24999 each): **5/5 `release-first`**, each with `stock.released.v1.occurredAt === order.cancelled.v1.occurredAt` confirmed (the tie itself is unchanged and expected), and no `statusRank` field visible anywhere in `ORD-000018`'s full `events[]` response, inspected by hand (the gateway exclusion projection confirmed working, not merely assumed).
- Combined: **15/15 orders correct**, 0 inverted, live against the real dev stack — reproducing the reviewer's own probe methodology and reversing its finding.

### Docker stack — final state

All 17 `otc-*` containers confirmed **healthy** at the end of this session (`otc-orders`, `otc-fulfillment`, `otc-billing`, `otc-projector`, `otc-gateway` restarted via `WEB_PORT=3010 pnpm dc:up:apps` after the stop/integration-test/restart cycle; the other 12 were never stopped). The 13 orders placed during verification (8 pre-existing + 5 new) are left in the dev read model as ordinary cancelled orders, consistent with how the reviewer's own probe was left in place.

### Scope discipline

Touched only `apps/projector/**` (5 modified files, 2 new files), `apps/gateway/src/infrastructure/persistence/mongo-order-read-model.adapter.ts` + its spec (the one line the wire-exclusion genuinely required), `apps/gateway/src/black-box-api.integration.spec.ts` (D2), and `specs/shared/test-matrix.md` (D1). `apps/orders/**` untouched (Option A needed nothing there). `apps/web` untouched (N3 conclusion above). `feature_list.json` untouched — reviewer's call.


## A1 — causal timeline ordering

Amendment A1 to `projector_read_model` — gate approved open points 1, 2, 4, 5, 6 of `progress/spec_projector_timeline_ordering.md` as recommended. Read `progress/impl_api_tests.md` (this file, above) for context: A1 supersedes the "R28 timeline-ordering fix" section's `statusRank` tiebreak, which the reviewer found (`progress/review_api_tests.md` §2, D4) inverted the R24 completion triple 100% of the time.

### What changed, per app

- **`apps/projector`** — `domain/projection-delta.ts`/`fact-projection.ts`: `TimelineEntryDelta.statusRank` replaced by `causationId` (PR30), copied verbatim from the envelope, never derived. `infrastructure/persistence/delta-to-pipeline.ts`: new exported `causalTimelineOrder()` — one `$let`/`$reduce`/`$sortArray`/`$map` expression computing each tie group's causal depth by a bounded relaxation fixpoint (`|appended|` rounds), sorting `(occurredAt, __depth, eventId)`, then stripping `__depth` and the retired `statusRank` key generically via `$objectToArray`/`$filter`. New exported `TIMELINE_ORDER_VERSION = 2`. `infrastructure/persistence/order-timeline.document.ts`: `events[].statusRank` replaced by `events[].causationId`; new optional document-level `timelineOrderVersion`. New `infrastructure/persistence/timeline-order-migration.ts` (PR32/PR35) — version-stamped migration (`{ timelineOrderVersion: { $ne: CURRENT } }`, never presence), reusing `causalTimelineOrder` verbatim, reporting `{ migrated, stillEdgeless }`. Removed `timeline-entry-rank-backfill.ts` and its integration spec (the rejected attempt, K2). `main.ts` calls `migrateTimelineOrder` instead. `mongo-read-model-writer.ts`'s placeholder stamps `timelineOrderVersion` too. `application/ports/read-model-writer.port.ts` and `infrastructure/signal/nats-update-signal.publisher.ts`: `AppliedOrderTimeline.latestEntry`/`TimelineStreamEntry` gain `causationId` (PR33).
- **`apps/billing`** — `domain/invoice.ts`: `Invoice.markPaid` now returns the `payment.received.v1` fact's own `eventId` (was `void`). `application/payment-register.handler.ts`: `credit.releaseHold`'s `ctx.causationId` is now that returned `paymentEventId`, not `cmd.requestId` — the one-line-in-spirit change amendment A1 open point 2 asked for. Before this, `payment.received.v1` and `credit.released.v1` were siblings (same `causationId`); now `credit.released.v1` is caused BY `payment.received.v1`, matching R47's "in that order" wording.
- **`apps/gateway`** — `domain/projection/order-read-model-mapper.ts`: `OrderTimelineDocumentLike.events[]`/`OrderDetailLike.events[]` gain optional `causationId` (PR33, gate ruling: public), passed through unmapped (the existing `events: doc.events` passthrough needed no code change). `infrastructure/persistence/mongo-order-read-model.adapter.ts`: `EXCLUDE_INTERNAL_FIELDS` drops `'events.statusRank': 0` (the field no longer exists). `black-box-api.integration.spec.ts`: new `assertCausalOrder()` helper — the GENERAL invariant (for every entry whose `causationId` names another entry's `eventId` in the same timeline, the cause precedes the effect) — applied in scenario 1 (R24 completion triple) and scenario 2 (R28 compensation pair), replacing what would otherwise stay a status-only / hand-written-sequence assertion.
- **`apps/seed`** — `data/sagas.data.ts`: `TimelineEntryFixture` gains `causationId`, populated from each saga builder's own already-computed `*CausationId` chain (the SAME values each fact's `OutboxFixture` row carries). `writers/mongo.writer.ts`: writes each entry's `causationId` and stamps `timelineOrderVersion` (a local copy of the projector's constant, kept in sync by inspection per this file's own existing `STATUS_RANK` precedent).
- **`specs/shared/openapi.yaml`** — `TimelineEntry`/`TimelineStreamEntry` gain the optional `causationId` property, verbatim as written out in `requirements.md` §6.4 item 1; `TimelineEntry`'s description states the full ordering rule. Neither `required` list changed (backwards-compatible). `packages/contracts`'s generated types regenerated to match (`pnpm --filter @otc/contracts run generate`).
- **`specs/shared/test-matrix.md`** — R24's row tightened to name the general invariant (`assertCausalOrder`) instead of the old "reaches completed with the full timeline" overclaim the reviewer flagged. R28's row's trailing sentence corrected (it described the now-retired `statusRank` mechanism as if still current). All three `black_box_api` describe citations in this file (R24, R28, R48) marked `~` (précis, not verbatim) — the citation `` `black_box_api — ...` `` was never a literal quotation of the (much longer) real `describe` title, and `apps/orders/src/test-matrix-guard.spec.ts` (H2) correctly flags an unmarked citation that doesn't match byte-for-byte; this was a pre-existing gap in all three rows (present in R48, which this pass never otherwise touches, confirmed via `git show HEAD:specs/shared/test-matrix.md` — not in git history at all yet, an uncommitted prior pass), fixed here since `test-matrix.md` is in this pass's explicit file scope and leaving it broken would fail `pnpm run test` for a reason unrelated to A1.

### A domain bug found and fixed while implementing PR10's mechanism

`causalTimelineOrder`'s first draft used `{ $cond: [{ $eq: ['$$cause', null] }, 0, { $add: ['$$cause.__depth', 1] }] }` to give a cause-less entry depth 0. Live-verified via a raw `mongosh` aggregation probe that `$arrayElemAt` on an EMPTY `$filter` result yields BSON **missing**, not `null` — so `$eq: ['$$cause', null]` was **false** for a genuinely absent cause, falling through to `$add: ['$$cause.__depth', 1]`, which (missing + 1) evaluates to `null`, corrupting that entry's depth to `null` instead of `0`. Reproduced with a minimal two-entry aggregation against a live `mongo:8.3.8` (`otc-mongodb`) before touching any spec: `released` (no cause) got `__depth: null`; `cancelled` (real cause) got `__depth: 1` correctly. Fixed by replacing the whole `$cond` with `{ $ifNull: [{ $add: ['$$cause.__depth', 1] }, 0] }`, which catches missing and null uniformly — verified against the same probe (`released` now `__depth: 0`). This is why K5's/K7's integration guards below are load-bearing rather than redundant with the unit spec: `delta-to-pipeline.spec.ts`'s pure tests check emitted *shape*, never evaluate the pipeline, and would have stayed green with this bug live.

### Armed guards, verbatim

**K5 — R28 and R24, `timeline-causal-order.integration.spec.ts`.** Armed by removing the `__depth` sort key (`sortBy: { occurredAt: 1, eventId: 1 }`, simulating "the depth key was never added"):

```
 FAIL  ... > R28 — stock.released.v1 precedes the order.cancelled.v1 whose causationId names it, with adversarial eventIds chosen so the fallback alone would invert it
AssertionError: expected [ 'order.cancelled.v1', …(1) ] to deeply equal [ 'stock.released.v1', …(1) ]
- Expected: "stock.released.v1", "order.cancelled.v1"
+ Received: "order.cancelled.v1", "stock.released.v1"

 FAIL  ... > R24 — the completion triple stores order.completed.v1 last, behind the credit.released.v1 its causationId names, behind the payment.received.v1 THAT causationId names, with adversarial eventIds ...
AssertionError: expected [ 'order.completed.v1', …(2) ] to deeply equal [ 'payment.received.v1', …(2) ]
- Expected: "payment.received.v1", "credit.released.v1", "order.completed.v1"
+ Received: "order.completed.v1", "credit.released.v1", "payment.received.v1"
```

Restored (`causalTimelineOrder('$$appended')` back in place); re-ran, both green (6/6 in the file).

**K7 — `replay-determinism.integration.spec.ts`.** Armed by replacing the causal-order `$let`/`causalTimelineOrder` expression with a plain `$concatArrays` (no re-sort at all — "insert at arrival position"):

```
 FAIL  ... > PR15 (A1) — a fact delivered BEFORE the fact that caused it produces the IDENTICAL final array as the reverse arrival ...
AssertionError: expected [ { …(6) }, { …(6) } ] to deeply equal [ { …(6) }, { …(6) } ]
  docB (effect-first arrival):  order.cancelled.v1, stock.released.v1
  docA (cause-first arrival):   stock.released.v1, order.cancelled.v1
```

Restored; re-ran, green (2/2, including the pre-existing shuffled-replay case).

**K8 — `timeline-order-migration.integration.spec.ts`.** Armed by swapping the version filter for the rejected attempt's own presence filter (`{ 'events.causationId': { $exists: false } }`):

```
 FAIL  ... > PR32 — a document carrying a causal edge but stamped at CURRENT − 1 IS re-sorted ...
AssertionError: expected +0 to be 1 // migrated
 FAIL  ... > PR32 — is a no-op on a document already at the CURRENT version, and strips the RETIRED entry-level statusRank ...
AssertionError: expected +0 to be 1 // migrated
 FAIL  ... > PR35 — never invents a causationId ...
AssertionError: expected 1 to be 2 // migrated
```

3 of 4 cases failed — exactly the "silently skips a document it should re-sort because the field it checks is already present" defect the rejected attempt shipped (the one case that stayed green, the pure-presence-absence document, coincidentally still matched the presence filter). Restored; re-ran, 4/4 green.

**K6 — PR31 edge cases** (outside-tie-group edge, edge naming nothing, entry with no `causationId`, fabricated cycle, siblings) — all 5 green in `timeline-causal-order.integration.spec.ts` against the fixed pipeline; not separately armed against the depth key (K5's arming already proves the mechanism they depend on), but the cycle case was hand-verified analytically (two mutually-causing entries converge to equal depth 2 after 2 relaxation rounds over a 2-element array, so the `eventId` fallback decides — matches the test's asserted order) before being trusted.

### Live re-check against the running dev stack (post-rebuild)

Rebuilt `otc-projector:local` and `otc-billing:local` (`docker compose ... build projector billing`), confirmed by `docker run --rm ... grep` that the built images' `dist/` genuinely contain `causalTimelineOrder`/`TIMELINE_ORDER_VERSION` (projector) and `paymentEventId` (billing) — not a stale cache hit. Restarted both containers (`docker compose ... up -d --no-deps projector billing`); both `healthy`, new image SHAs confirmed via `docker inspect .Image`.

**Boot log:**
```
[projector] legacy-document-backfill: 0 document(s) backfilled
[projector] timeline-order-migration: 32 document(s) migrated, 32 of them still holding an entry with no causationId (PR35 — ordered by the eventId fallback, not causally repaired)
```

All 32 pre-existing documents (the ones the earlier `statusRank` backfill had already rewritten, plus everything else in the dev read model) were re-sorted and re-stamped `timelineOrderVersion: 2`. All 32 report edgeless — correct and expected: none of them ever had a `causationId` recorded (they predate PR30), so PR35 forbids inventing one; the migration honestly reports the fallback rather than claiming repair. Spot-checked `ORD-000007` (one of the two completed orders the review named as rewritten by the rejected backfill, D4's live example) directly against MongoDB: `timelineOrderVersion: 2`, every entry's `statusRank` key genuinely stripped (`Object.keys` per entry: exactly `["eventId","eventType","occurredAt","summary"]`), order still `[completed, released, payment]` by the `eventId` fallback (honestly unrepaired, not silently claimed fixed) — matching PR35's specified behaviour exactly.

**Fresh `.99` compensation order** (qty 1 × PRD-0001 = 24999, `ORD-000033`), polled to `cancelled`:
```
stock.released.v1   causationId: 6b9fabc5-...
order.cancelled.v1  causationId: ef97fd40-...  (= stock.released.v1's OWN eventId ef97fd40-4032-...)
```
`stock.released.v1` (eventId `ef97fd40-...`) stored strictly before `order.cancelled.v1`, whose `causationId` literally is that eventId. `causationId` visible on the wire (`GET /orders/{id}`), confirming PR33's public ruling live, not merely by mapper unit test.

**Fresh happy-path order** (qty 2 × PRD-0001 = 49998, `ORD-000034`), placed → invoiced → `POST /invoices/{id}/payments` → polled to `completed`:
```
payment.received.v1  eventId: 1294d209-...              causationId: db847911-... (command id, root)
credit.released.v1   eventId: 049b28dd-...  causationId: 1294d209-...  (= payment.received.v1's eventId)
order.completed.v1   eventId: 1a5ecd81-...  causationId: 049b28dd-...  (= credit.released.v1's eventId)
```
All three share `occurredAt: 2026-08-29T06:09:09.285Z` — a genuine tie group. Stored order is `payment → released → completed`, and `credit.released.v1.causationId` is literally `payment.received.v1`'s own `eventId` (not `cmd.requestId`), live proof the Billing edge (open point 2) is real in the data, not merely proved by a unit spec.

### Docker stack — final state

All 17 `otc-*` containers healthy at the end of this session: `otc-mysql`, `otc-mongodb`, `otc-kafka`, `otc-kafka-console`, `otc-nats`, `otc-otel-collector`, `otc-jaeger`, `otc-prometheus`, `otc-grafana`, `otc-n8n` (never stopped), plus `otc-orders`, `otc-fulfillment`, `otc-billing`, `otc-notifications`, `otc-projector`, `otc-gateway`, `otc-web` (the six app containers ports 3001–3006 were stopped for the gateway integration run and restarted via `WEB_PORT=3010 pnpm dc:up:apps`; `projector` and `billing` additionally rebuilt and force-restarted afterward to carry this pass's code). `ORD-000033`/`ORD-000034` (this pass's two live-verification orders) left in the dev read model, same convention the prior pass used.

### Real test counts and exit codes

- `pnpm --filter @otc/projector run typecheck` / `pnpm --filter @otc/billing run typecheck` / `pnpm --filter @otc/gateway run typecheck` / `pnpm --filter @otc/seed run typecheck` — exit 0 each; `pnpm run typecheck` (all 10 workspace projects) — exit 0.
- `npx eslint apps/projector apps/billing apps/gateway apps/seed` — exit 0, no output. `pnpm run lint` (whole repo) — exit 0.
- `pnpm --filter @otc/projector exec vitest run` (fast) — `Test Files 15 passed (15)`, `Tests 163 passed (163)`.
- `pnpm --filter @otc/projector exec vitest run --config vitest.integration.config.mts` (full, real Testcontainers) — `Test Files 14 passed (14)`, `Tests 42 passed (42)`, 269s.
- `pnpm --filter @otc/billing exec vitest run` — `Test Files 29 passed (29)`, `Tests 148 passed (148)`.
- `pnpm --filter @otc/billing exec vitest run --config vitest.integration.config.mts payment-register.integration.spec.ts` — `Test Files 1 passed (1)`, `Tests 10 passed (10)`.
- `pnpm --filter @otc/gateway exec vitest run` (fast) — `Test Files 30 passed (30)`, `Tests 123 passed (123)`.
- `pnpm --filter @otc/gateway exec vitest run --config vitest.integration.config.mts black-box-api.integration.spec.ts` (full fleet spawn, app containers stopped) — `Test Files 1 passed (1)`, `Tests 4 passed (4)`, 103s.
- `pnpm --filter @otc/seed exec vitest run` — `Test Files 8 passed (8)`, `Tests 122 passed (122)`; `--config vitest.integration.config.mts` — `Test Files 1 passed (1)`, `Tests 6 passed (6)`.
- `pnpm run test` (whole repo, 10 workspace projects) — every project green (`packages/contracts` 22, `packages/shared-kernel` 69, `apps/billing` 148, `apps/fulfillment` 83, `apps/gateway` 123, `apps/notifications` 82, `apps/orders` 512, `apps/projector` 163, `apps/seed` 122, `apps/web` 59 — 1383 tests total), exit 0.
- `./init.sh` — exit 0.

### Traceability (`specs/projector_read_model/requirements.md` §3)

`PR10`, `PR15`, `PR30`, `PR31`, `PR32`, `PR35`, `PR33`, `PR34` flipped `DONE (A1)` with real case names — see the requirements.md diff itself for the exact citations; not restated here to avoid the citation drifting from the file that is the source of truth.

### Scope discipline

Touched exactly the constraint list: `apps/projector/**`, `apps/billing/**` (the causation change plus its own test/spec fallout), `apps/gateway/**`, `apps/seed/**`, `specs/shared/openapi.yaml`, `specs/shared/test-matrix.md`, `specs/projector_read_model/{requirements,design already-authored,tasks}.md`. Did not touch `feature_list.json` (reviewer's call), did not commit, did not touch `apps/orders/**`/`apps/notifications/**`/`apps/web/**` source (only `apps/orders/src/test-matrix-guard.spec.ts`'s target file, `test-matrix.md`, for the pre-existing `~` marker gap — no `apps/orders` source edited).
