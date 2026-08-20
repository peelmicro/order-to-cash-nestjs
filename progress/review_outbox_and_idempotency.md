# Review pass — `outbox_and_idempotency` (feature 14, phase 8)

**Agent:** `reviewer`
**Date:** 2026-08-20
**Feature:** `outbox_and_idempotency` — transactional outbox + polling relay + idempotent-consumer pattern, `"sdd": true`
**Verdict:** **APPROVED** — 10 defects, none blocking; **5/5 hostile mutations KILLED**; both parity guards re-armed with the reviewer's own divergences and both fired.
**Status set:** `in_review` → `done` (`feature_list.json`). Nothing was committed; no source file was left modified — every probe and mutation was restored and checksum-verified.

---

## 1. What I actually ran

Everything below is my own execution, not a re-reading of `progress/impl_outbox_and_idempotency.md`.

| Gate | Command | Result |
|---|---|---|
| Unit + lint + typecheck | `pnpm run quality` (twice: before and after all mutations) | **exit 0** — `apps/orders` 181/181 (12 files), `apps/seed` 103/103 (6 files), `shared-kernel` 68/68, `contracts` 22/22, every other workspace green; lint 0 errors 0 warnings |
| Integration, whole repo | `pnpm run test:integration` | **exit 0** — `apps/orders` **22/22 (7 files)**, `apps/billing` 11/11, `apps/fulfillment` 9/9, `apps/seed` 6/6 |
| Integration, re-run after every restore | `pnpm --filter @otc/orders test:integration` | **exit 0** — 22/22 (7 files) |
| Coverage | `pnpm --filter @otc/orders test:coverage` | Stmts **95.4 %**, Branches 91 %, Funcs 92.55 %, Lines 95.33 %; `domain/` **98.5 %** — both gates (≥80 % domain, ≥60 % overall) met |
| Harness | `./init.sh` | **exit 0** (`13/38 done`, `2 sdd feature(s) past pending have their triple-doc`, 47 uncommitted changes — expected mid-session) |
| Live stack | real seed + real relay + real Kafka against the running compose stack (details in §3, probe 6) | zero unpublished rows in three live databases; one hand-inserted fact claimed, published, stamped and read back off `otc.orders.facts.v1` |

The `TimeoutNegativeWarning` the implementer disclosed reproduces here too. I confirmed it is **not** ours: `setTimeout`/`setInterval` appear in exactly three places in the repository's own source (`outbox-relay.service.ts` and two consumer-wait helpers in specs), none of which passes a clock-derived delay. It is kafkajs's internal deadline arithmetic. Diagnostic, not a failure.

## 2. `CHECKPOINTS.md` — the boxes I walked

**C1 — The harness is complete**

- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model (unchanged this feature).
- [x] `./init.sh` exits 0 — re-run by me.

**C2 — State is coherent**

- [x] At most one feature `in_progress` — none is, after this close (14 → `done`, nothing else moved).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — re-run repo-wide, see §1.
- [~] `progress/current.md` still reads `Status: in_progress` while `feature_list.json` read `in_review`. The same one-line drift the previous review recorded as D4. Harmless, but it is the leader's file to reset at session close.
- [x] No `blocked` feature.

**C3 — Architecture is respected**

- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder — **verified by ESLint with my own probe**, not by eye: I temporarily added `import { Kafka } from 'kafkajs'` and `import { sql } from 'drizzle-orm'` to `apps/orders/src/domain/order.ts` and `pnpm run lint` produced two `no-restricted-imports` errors naming both specifiers; file restored and confirmed identical to `HEAD` (`git diff --stat apps/orders/src/domain/` empty — this feature touched no domain file at all, which is task I4's claim and it holds).
- [x] No cross-service database access. The one cross-app import added is in a **test** (`apps/seed/src/seed.integration.spec.ts` imports `OutboxRelay` from `apps/orders` and points it at the fulfillment/billing handles through a documented cast). `apps/seed` already legitimately spans the three databases; no runtime service reads another service's schema.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — the idempotent-consumer pattern was **duplicated per service by design** (`design.md` §6.3) rather than promoted to a third shared package, and `OI12` now guards the duplication mechanically.
- [x] `packages/shared-kernel` still has zero runtime dependencies (`"dependencies"` absent).
- [x] Kafka-fact / NATS-RPC classification: this feature publishes **facts** to `otc.orders.facts.v1` and adds no RPC. No Kafka-as-request-bus, no RPC-for-facts. No NATS client anywhere in `apps/orders` (grep clean).
- [x] No stray debug logging (the one `console.error` is the relay's structured-JSON failure logger, carrying `correlationId` and `eventId` per `OI8`); no context-free TODOs.

**C4 — Verification is real**

- [x] `pnpm quality` passes — run by me, twice.
- [x] Domain tests are pure — unchanged this feature, re-proved by the ESLint probe above.
- [x] Integration tests use Testcontainers against real MySQL **and, for the first time in this repository, real Kafka** — `mysql:8.4.11` and `apache/kafka:4.3.1`, both the same pinned tags as `docker-compose.infra.yml`. No mocked broker anywhere: the two Kafka specs produce through the real kafkajs producer and consume through a real kafkajs consumer.
- [x] Coverage thresholds met (§1).
- [x] No Jest anywhere — grep across every `package.json`, `*.ts`, `*.mts`: zero hits.

**C5 — The session closed cleanly**

- [~] Suspicious untracked files: **one** — `apps/orders/drizzle/meta/0003_snapshot.json` (defect D1).
- [x] `progress/history.md` has an entry for this feature **including its effort record** — appended by this pass.
- [x] `feature_list.json` reflects the true state (14 → `done`; nothing else touched).
- [x] The human has been told what was done and how to test it manually (`progress/impl_outbox_and_idempotency.md` §9 — with the correction of defect D4).
- [x] Claude did not commit. I ran no `git commit`, no `git push`, and no `git add`.

**C6 — Spec-Driven Development** (applies: `"sdd": true`)

- [x] `specs/outbox_and_idempotency/` holds all three of `requirements.md`, `design.md`, `tasks.md`, plus the gate record `progress/spec_outbox_and_idempotency.md` (26 open points + the post-gate §7 amendment).
- [x] EARS notation with ids. The shared authority is `specs/shared/requirements.md` `R11`–`R18`, deliberately not restated. The twelve feature-local requirements are `OI1`–`OI12` and each is written in EARS form (`THE SYSTEM SHALL …`, `IF … THEN …`, `WHILE …`, `WHEN …`, `WHERE …`). The `OI` prefix rather than `R<n>` is the ratified convention feature 13 established (the shared `R1`–`R61` range is frozen and reused verbatim by #8/#9) — recorded in `requirements.md` §2 and accepted at the gate.
- [x] Every task ticked: **57 `[x]`, 0 `[ ]`** — and I verified them individually rather than trusting the ticks (§4).
- [x] Every `R<n>` this feature owns is covered by at least one concrete named test recorded in `specs/shared/test-matrix.md` — `R12`, `R13`, `R14`, `R15`, `R17`, `R18` flipped to `DONE` with real file paths and the matrix's own case wording; `R11` was already `DONE`; `R16` correctly left `TODO` (§5).
- [~] The spec commit precedes the implementation commit. **Unsatisfiable by any agent** — Claude never commits. The human must commit `specs/outbox_and_idempotency/` + `progress/spec_outbox_and_idempotency.md` **first**, then the implementation, exactly as for feature 13.

**C7 — Trilogy reusability**

- [x] `specs/shared/` gained no stack specifics. The only edit is `test-matrix.md` §2's six status cells plus one Green count; every TypeScript/Drizzle/kafkajs/Testcontainers word this feature produced lives in `specs/outbox_and_idempotency/design.md`. Grep for `nest`, `drizzle`, `kafkajs`, `mysql`, `vitest`, `auto_increment` in `specs/shared/`: no new hits.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records complete and honest — this pass appends feature 14's.

## 3. The correctness probes — my own runs, not the implementer's

**Probe 1 — no dual-write (`R13`), at the failure point the committed suite does *not* use.** The committed `R13` case forces its failure **after** `save()` returns, i.e. after both writes are already in the transaction. I wrote a throwaway spec (`apps/orders/src/infrastructure/outbox/review-probe.integration.spec.ts`, since **deleted** — `git status` confirms no residue) that fails *during* the outbox write, in two independent ways:

1. an `OutboxRecorder` subclass that throws after the `orders`/`order_items` rows are already inserted in the transaction;
2. a recorder that writes every envelope **twice**, so the second INSERT violates `outbox.event_id UNIQUE` — a real MySQL error raised by the database inside the same transaction.

Both cases: `orders`, `order_items` **and** `outbox` contain nothing for that aggregate. `Test Files 1 passed, Tests 2 passed`. The aggregate row is never orphaned by an outbox failure.

The reverse direction is proved by `OI8`'s committed case (a rejecting publisher leaves the row unstamped and the next poll returns exactly the same record) and, independently, by mutation M1 below: when I made the relay stamp before the acknowledgement, that case turned red.

**Probe 2 — the dedup write is first, and the unique index is the guarantee (open point 15).** `grep` over `apps/orders/src/infrastructure/messaging/*.ts`: **no `SELECT` at all** in the dedup path. `recordProcessedEvent` (`processed-events.repository.ts:33-53`) inserts and translates `ER_DUP_ENTRY` into a typed `'duplicate'`; `uq_processed_events_event_consumer (event_id, consumer)` is the mechanism (verified present in all three live databases, §probe 9). The **concurrent** proof is real and not two sequential deliveries: `idempotent-consumer.integration.spec.ts:167-227` opens two `mysql2` pools, builds two `IdempotentConsumer` instances and races them with `Promise.all` on the same `(eventId, 'orders.saga')`; outcomes sort to `['duplicate','processed']`, `effects` has length 1, `processed_events` has exactly one row (`OI10`). Re-run green by me.

**Probe 3 — `seq` alone orders the poll, `FOR UPDATE SKIP LOCKED` claims.** I printed the SQL drizzle actually generates for the claim:

```
select `id`, `event_id`, … , `seq`, `trace_parent` from `outbox`
where `outbox`.`published_at` is null order by `outbox`.`seq` asc limit ? for update skip locked
```

— `design.md` §5.2 verbatim: nullability predicate (never a cursor), `seq ASC`, `SKIP LOCKED`. The two-relay test (`OI4`) is mine to re-run and it is genuinely concurrent: 40 rows, batch 5, two relays on two separate pools drained with `Promise.all` rounds; union = all 40 event ids, intersection = ∅, nothing left unpublished. Crash recovery (`OI5`): a raw connection claims 5 rows with the relay's own predicate and is `destroy()`-ed with no commit and no rollback; the next relay's **very next** `runOnce()` — no sleep, no sweeper — claims and publishes exactly those 5. Both green under my run, and both turned red under mutation M2 (`SKIP LOCKED` removed → `ER_LOCK_WAIT_TIMEOUT`).

**Probe 4 — stamp after ack (`R14`).** In `outbox-relay.ts:86-114` the `UPDATE … SET published_at` is issued only after `await this.publisher.publish(facts)` resolves, in a separate statement from the claim. Mutation M1 (stamp moved before the publish) killed both `R14`'s own case and `OI8`. Live confirmation too: in probe 6 the row's `published_at` was `NULL` until the broker had the message and non-null immediately after.

**Probe 5 — the idempotent producer is real, not intended.** `KAFKA_PRODUCER_CONFIG = { idempotent: true, maxInFlightRequests: 1 }` is passed to `client.producer(...)` in the constructor (`kafka-fact-publisher.ts:53-55`), and `createKafkaClient` builds a genuine kafkajs `Kafka`. The unit case asserts the *captured* config object, and the two Kafka integration specs plus my live-stack run drive that same constructor against a real broker — kafkajs rejects an idempotent producer whose `acks`/in-flight settings contradict it, so a real successful publish is itself evidence the flags were accepted. `acks: -1` is sent explicitly on every `send`. Mutation M5 (`idempotent: false`, `maxInFlightRequests: 5`) killed `OI7`.

**Probe 6 — zero unpublished rows against seeded databases, on the live stack.** I did **not** run `pnpm dc:clean:infra`: `down -v` would destroy the human's 24-hour-old SonarQube, Grafana, n8n and read-model volumes, and no agent message is authority to wipe a developer's environment. Instead I did the same proof non-destructively against the **live** MySQL and the **live** Kafka broker, on scratch databases:

1. created `otc_orders_rv` / `otc_fulfillment_rv` / `otc_billing_rv` on the running `otc-mysql`;
2. ran the **real** `pnpm seed` against them (`MYSQL_DB_*` + `MONGO_DB_READMODEL` overridden) — it applied this feature's three migrations from empty and seeded 17 / 12 / 21 outbox rows, `[seed] done.`, exit 0;
3. ran the **real** `OutboxRelay` against the seeded `otc_orders_rv` with a publisher asserted never to be called → `{"claimed":0,"published":0}`, `publisher calls: 0` — the first live proof of the seed's pre-published design;
4. followed the human's manual step 6: inserted one unpublished `order.placed.v1` row by hand → the next `runOnce()` reported `{"claimed":1,"published":1}`, the row's `published_at` became non-null and the store assigned `seq = 18`;
5. read the fact back off the live topic with a real kafkajs consumer: **partition 4**, key = the order id, headers `x-event-type: order.placed.v1` and `content-type: application/json` (no `traceparent` — the documented, dated gap for feature 27), envelope complete including `causationId`;
6. a third cycle returned `{"claimed":0,"published":0}`;
7. dropped all three scratch databases and the scratch Mongo database. `SHOW DATABASES` and the Mongo database list are back to exactly their prior contents, and the human's `otc_orders.outbox` still holds its original 17 rows.

Raw SQL against the three seeded scratch databases: `total 17/12/21`, `unpublished 0/0/0`, `missing_causation 0/0/0`.

**Probe 7 — both parity guards, re-armed with my own divergences.**

- **`OI11`** — I widened `causation_id` from `char(36)` to `char(40)` in the committed **billing** migration (not the implementer's `trace_parent` edit). `apps/seed` unit suite: `× defines outbox and processed_events identically in the three committed migration sets`, 102/103. Restored; md5 back to `0736151b…`; 103/103.
- **`OI12` case 2 (portability)** — I inserted `type BillingDb = never;` into the canonical `processed-events.repository.ts` body. `× keeps the canonical copy adoptable verbatim…` — *"processed-events.repository.ts names a service outside its banner"*. Restored byte-exact.
- **`OI12` case 3 (census)** — I created `apps/fulfillment/src/presentation/review-probe.consumer.ts` carrying a real `@EventPattern(...)` decorator. `× requires a copy of the pattern from every write model that consumes facts` — *"app(s) with a MySQL processed_events schema and an @EventPattern handler but no idempotent-consumer.ts copy: fulfillment"*. File deleted; `git status` clean.
- **Can `OI12` pass silently forever at n = 1?** Case 1 *is* vacuous with a single copy — it compares the canonical to itself — but it says so in its own assertion message and arms structurally at the second copy. It cannot hide drift, because the two cases that *are* meaningful today both fired under my sabotage: case 2 catches a service name or a non-portable import entering the pattern, and case 3 turns red the moment any service with a `processed_events` schema gains a consumer without the copy. That is exactly the four-case design `design.md` §6.4 specifies, and I confirmed the arming of both by hand.

**Probe 8 — byte-identity across the three outbox schemas.** I extracted, independently of their test, every statement mentioning `outbox` or `processed_events` from **all** committed migrations of the three apps (8 statements each, including the `0000` creations and orders' extra `0001`) and diffed them: `IDENTICAL` in both comparisons. The three new migration bodies are byte-identical files (`md5 0736151bea819688306f6b0ecc48e7c4` ×3). The `0001_small_vertigo.sql` that only orders carries touches `order_items`, so it correctly contributes nothing to the comparison.

**Probe 9 — schema in all three databases, and the lag index retained.** From `information_schema` on the three freshly-migrated live databases, identical in all three:

```
occurred_at   datetime(3)      NO
causation_id  char(36)         NO
trace_parent  varchar(64)      YES
seq           bigint unsigned  NO   auto_increment
idx_outbox_published_occurred  (published_at, occurred_at)   <- retained, open point 4
idx_outbox_unpublished_seq     (published_at, seq)           <- the new poll index
seq                            (seq) UNIQUE
```

## 4. Spec conformance and scope

**The 57 tasks.** All ticked, and I verified them rather than counting ticks: A1–A2 (the three `outbox.schema.ts` files diff to nothing but the two allowed per-service comment lines and the `eventType` example), A3–A4 (three migrations, byte-identical bodies, `--custom` justified below), A5–A7 (all three `migrations.integration.spec.ts` gained the `causationId`/`traceParent` round-trip, the millisecond `occurred_at` assertion, the store-assigned `seq` assertion and the new `information_schema` index assertion — and all three suites are green: orders 6, fulfillment 9, billing 11), A8 (`OI11`), B1–B5 (the causal chain matches `design.md` §3.5's table row for row; the three writers pass `causationId`; `sagas.spec.ts` asserts non-empty causation, same-saga closure and both synthetic roots; `seq` appears nowhere in the determinism path), C1–C7 (four ports, the revised repository port, both packages in the catalog, six `.env.example` variables), D1–D8, E1–E11, F1–F2, G1–G8, H1–H2, I1–I6.

**Row 11's scope boundary holds.** `grep` across `apps/orders/src` (excluding specs and fixtures) for `nats`, `OrderNumber.fromSequence`, `allocate`, `@MessagePattern`, `CommandHandler`: **zero hits**. `DrizzleOrderRepository` is `save` / `findById` / `findByReference` plus reference-code resolution and nothing else; there is no controller, no NATS client and no command handler. Feature 15 inherits an adapter, not a half-built acceptance flow.

**Row 13's discipline rule (`OI9`) is demonstrated, not guarded** — recorded as defect D9. The committed case re-derives the aggregate itself and asserts the good outcome (exactly one outbox row per fact after a rolled-back first attempt), which satisfies `OI9` as worded. Nothing, however, would fail if a future handler retried off a drained instance; the rule "a failed unit of work invalidates the aggregate instances it touched" remains prose plus a comment.

**The three deviations the implementer reports — my ruling on each.**

1. **Kafka Testcontainers driver (`GenericContainer` instead of `@testcontainers/kafka`) — JUSTIFIED, no gate return needed.** `design.md` §9 does not merely permit this, it *instructs* it: *"If `@testcontainers/kafka`'s `KafkaContainer` cannot drive `apache/kafka:4.3.1` directly, fall back to `GenericContainer` with **that same tag** and explicit KRaft environment — never to `confluentinc/cp-kafka` or `latest`."* The fixture uses `apache/kafka:4.3.1`, the pinned compose tag, with an explicit single-node KRaft environment, `KAFKA_AUTO_CREATE_TOPICS_ENABLE: false` and explicit 6-partition / RF-1 topic creation through the kafkajs admin client — every constraint §9 attached to the fallback. The reason is documented in the fixture header. This is the spec being followed, not deviated from. It does leave the required-but-now-unused `@testcontainers/kafka` package behind (defect D3).
2. **`drizzle-kit generate --custom` — JUSTIFIED, and correctly evidenced.** `design.md` §3.4 anticipated exactly this failure (*"`AUTO_INCREMENT` on an added column is the one statement `drizzle-kit` may emit in a form MySQL rejects"*) and named `--custom` as the sanctioned escape hatch, on condition that the exact `drizzle-kit` output forcing it is recorded. Task A4 says the same. The progress file records the rejected SQL and the `ER_WRONG_AUTO_KEY` (1075) error verbatim. I confirmed independently that the combined statement is what MySQL actually accepts — the migration applies from empty to three live databases and produces `bigint unsigned NOT NULL auto_increment` with a `UNIQUE` key. This is the escape hatch being used as specified, not a hand-edit of generated output. Residue: the orphan snapshot (D1).
3. **`OI12`'s forbidden-word check widened from `\b…\b` to a plain substring match — JUSTIFIED, and the *stronger* reading of the design's own intent.** I tested the two patterns myself rather than take the claim: `/\b(orders|fulfillment|billing|projector|notifications)\b/i` returns **false** for `type BillingDb = never;` and **false** for `OrdersIdempotentConsumer`, while the substring form returns **true** for both. `design.md` §6.4's worked example states the case must *"fail the day someone writes `OrdersDb` … into the pattern"* — which the literal regex it prints cannot do. The implementer implemented the design's stated *behaviour* rather than its mis-specified *pattern*, documented the reasoning in the spec file itself, and I re-armed the case with my own sabotage and watched it fire. The right follow-up is to correct §6.4's printed pattern when feature 38 revisits the spec, not to send the code back.
   The fourth, related deviation — adding `./processed-events.repository` to the import whitelist — is likewise justified: `design.md` §6.1 itself has `IdempotentConsumer` call `recordProcessedEvent`, so the sibling import is unavoidable, and G7 requires the pair to be copied together, so the specifier resolves identically in every copy. The design's "exactly" list was simply incomplete.
   The two further disclosures (renaming the `R15` case to the matrix's exact wording; leaving the matrix's stale **Total** row alone) are honest; the second is recorded as defect D6.

**`R16` / DLQ correctly absent.** No retry-with-backoff, no attempt counting, no `<topic>.dlq` publication, no `x-failed-consumer`/`x-attempts`/`x-error` headers anywhere in the diff, and the `R16` row of `specs/shared/test-matrix.md` is **untouched** — still `TODO`, still naming `projector/integration/dead-letter.spec`, which belongs to feature 27. The deferral is ratified in `requirements.md` §1 and open point 16, and matrix rule 3 is read as *every row this feature owns*. I agree with that reading: the alternative makes feature 14 permanently un-closable for a requirement `feature_list.json` assigns to feature 27.

## 5. Traceability — the mapping I verified

Every row below I opened, read and re-ran; the "how I know it is not vacuous" column is my own evidence, including which mutation killed it.

| Id | Test (file › case) | Why it is real |
|---|---|---|
| **R11** | `packages/shared-kernel/src/domain/event-envelope.spec.ts` | Already `DONE` before this feature; unchanged |
| **R12** | `outbox-envelope.integration.spec.ts` › *stamps every fact of one order with the order id as correlationId and the causing event id as causationId* | Drives two real transitions of one real `Order` against real MySQL; asserts the second row's `causationId` **equals the first row's `eventId`** and both rows' `correlationId` equals the order id. Fails against the pre-feature schema, which had no column at all |
| **R13** | `outbox-atomicity.integration.spec.ts` › *persists neither the aggregate nor the outbox record and publishes nothing when the transaction fails* | Real `Order.place` + real transaction; asserts `orders` **and** `outbox` empty. Extended by my own probe at the harder failure point (§3 probe 1) |
| **R14** | `outbox-relay.integration.spec.ts` › *stamps a record only after the broker acknowledgement and republishes an unstamped record on the next poll* | Real MySQL + **real Kafka**; poll 1 fails synthetically → `published_at IS NULL`; poll 2 reaches the real broker → stamped, and the message is consumed back off the topic. **KILLED mutation M1** |
| **R15** | `fact-partitioning.integration.spec.ts` › *delivers all facts produced by one context about one order to consumers in emission order* | Two orders interleaved across four transactions, real 6-partition topic, real consumer; asserts per-order emission order **and** one partition per order. **KILLED mutation M3** |
| **R16** | *(feature 27)* | Correctly `TODO` |
| **R17** | `idempotent-consumer.integration.spec.ts` › *records the eventId and consumer name in the same transaction as the state change and the outbox records* | Dedup row + `orders.status = confirmed` + both outbox rows after one `runOnce`. See defect D10: the *same-transaction* half is actually proved by the sibling case in the same file |
| **R18** | same file › *acknowledges a redelivered fact without mutating state, emitting a fact or issuing a command* | Second delivery returns `'duplicate'`, the `work` spy is **not** called again, status unchanged, outbox row count unchanged |
| **OI1** | `outbox-envelope.integration.spec.ts` › *reconstructs the complete envelope from the stored record alone…* | All seven fields asserted against the row; plus the mapper refusing a row with a nulled field |
| **OI2** | `outbox-relay.integration.spec.ts` › *publishes two records written by one transaction in append order although both carry the same occurred_at* | Same `occurredAt` on both facts, **three repeated attempts**, order read back off the real broker. **KILLED mutation M3** |
| **OI3** | same file › *publishes a lower-sequence record that committed after a higher-sequence record was already published* | Two raw connections; the lower-`seq` row commits **after** the higher-`seq` row was already published; the next poll finds it |
| **OI4** | `outbox-relay-concurrency.integration.spec.ts` › *grants disjoint batches to two concurrent relay instances…* | Two pools, 40 rows, `Promise.all` rounds; union = all, intersection = ∅. **KILLED mutation M2** |
| **OI5** | same file › *returns records claimed by a relay that died before stamping to the next poll without a lease wait* | `connection.destroy()` mid-claim, no rollback; next `runOnce()` with **no sleep** claims exactly those rows. **KILLED mutation M2** |
| **OI6** | `outbox-relay.spec.ts` › *never starts a second poll cycle while one is still in progress* | Fake timers advanced 1 000 ms across a 100 ms interval with the cycle deliberately unresolved: `runOnce` still called once. Plus two sibling cases for the disabled flag and graceful shutdown |
| **OI7** | `kafka-fact-publisher.spec.ts` › *configures the producer so an internal retry can neither reorder nor duplicate a partition's records* | Asserts the **captured** producer config object and the send-time `acks`. **KILLED mutation M5** |
| **OI8** | `outbox-relay.integration.spec.ts` › *leaves every record of a rejected batch unstamped and republishes the same records on the next poll* | Rejecting publisher, two polls, same claim both times, nothing stamped. **KILLED mutation M1** |
| **OI9** | `outbox-atomicity.integration.spec.ts` › *produces exactly one outbox record per fact when the operation is retried after a rolled-back unit of work* | Rolled-back first attempt, re-derived aggregate, exactly one row per fact. See defect D9 |
| **OI10** | `idempotent-consumer.integration.spec.ts` › *applies the handler's effects once when the same event is delivered concurrently to two consumers* | Genuinely concurrent (`Promise.all`, two pools): one `'processed'`, one `'duplicate'`, one effect, one ledger row |
| **OI11** | `apps/seed/src/outbox-parity.spec.ts` › *defines outbox and processed_events identically in the three committed migration sets* | Non-vacuity guarded (each set asserted non-empty). **Re-armed by me** with a `char(40)` divergence → red |
| **OI12** | `idempotent-consumer.parity.spec.ts` — four cases | Cases 2 and 3 **re-armed by me** and both fired; case 1 self-declares its n = 1 state; case 4 dormant by design until features 23/24 |

Also verified: `H1` (*the relay finds no unpublished record in any of the three seeded databases* — real `OutboxRelay`, publisher asserted never called) and `H2` (*every seeded outbox row carries a causationId*), both re-run green and both re-proved by me on the live stack.

## 6. Mutation probes — 5 hostile edits, 5 KILLED, all restored byte-exact

| # | Hostile edit | Result | Killed by |
|---|---|---|---|
| **M1** | Move the `UPDATE … SET published_at` **before** `publisher.publish(...)` — stamp before the acknowledgement | **KILLED** (2 failures) | `R14` › *stamps a record only after the broker acknowledgement…*; `OI8` › *leaves every record of a rejected batch unstamped…* |
| **M2** | `.for('update', { skipLocked: true })` → `.for('update')` — drop `SKIP LOCKED` | **KILLED** (2 failures, `ER_LOCK_WAIT_TIMEOUT` 1205) | `OI5` › *returns records claimed by a relay that died…*; `OI8`'s sibling claim in `outbox-relay.integration.spec.ts` |
| **M3** | `orderBy(asc(outbox.seq))` → `orderBy(asc(outbox.occurredAt))` — order the poll by the timestamp that ties | **KILLED** (2 failures) | `OI2` › *publishes two records written by one transaction in append order…*; `R15` › *delivers all facts … in emission order* |
| **M4** | Write the dedup record in its **own** transaction, committed before the handler's transaction opens — i.e. make the dedup insert non-transactional with the handler | **KILLED** (1 failure) | `idempotent-consumer.integration.spec.ts` › *a failure in work leaves no dedup row*. **Note:** `R17`'s own matrix-named case stayed green — see defect D10 |
| **M5** | `KAFKA_PRODUCER_CONFIG` → `{ idempotent: false, maxInFlightRequests: 5 }` | **KILLED** (1 failure) | `OI7` › *configures the producer so an internal retry can neither reorder nor duplicate a partition's records* |

All five files restored from pre-mutation copies and verified by md5 against the checksums taken before the first edit; `pnpm quality` and the full `apps/orders` integration suite re-run green afterwards; `git status` shows the same 47 entries it showed before I started, with no probe file left behind.

## 7. Defects

None blocking. Ordered by severity.

**D1 — orphan drizzle snapshot, and a broken snapshot chain in `apps/orders/drizzle/meta/`.** `0003_snapshot.json` exists but is in no journal entry and has no `0003_*.sql`; it is residue from the auto-generated migration that A4 discarded. Worse, `0002_snapshot.json`'s `prevId` is `cc7967bb-6efb-42a0-930c-53a167a0936d` — the orphan's `id` — instead of `0001_snapshot.json`'s `id` (`0fbd495b-00c2-4074-9a4f-e427a227403c`), and the orphan's own `prevId` (`2265a095-…`) matches nothing in the folder. **Why it matters:** `drizzle/meta/` is the artefact drizzle-kit trusts to compute every future diff, and this is a coordinated three-database migration whose whole point was that the shapes must not drift. I did test the immediate consequence — `pnpm --filter @otc/orders db:generate` reports *"No schema changes, nothing to migrate"* and modifies nothing (I diffed the whole directory before and after) — so it is not broken **today**; it is untracked cruft that would enter the human's commit and a chain a later reader cannot follow. **Fix:** delete `apps/orders/drizzle/meta/0003_snapshot.json`, and make `0002_snapshot.json`'s `prevId` equal `0001_snapshot.json`'s `id`.

**D2 — `OUTBOX_PUBLISH_TIMEOUT_MS` is dead configuration, and `design.md` §5.2's stated bound therefore does not exist.** `apps/orders/src/infrastructure/outbox/outbox-relay.config.ts:9,17` declares and loads `publishTimeoutMs`; `.env.example:104` documents it as *"the producer's acknowledgement budget; also bounds the open claim transaction (design.md §5.2)"*; **nothing reads it** — grep finds it only in the config file and in test fixture literals. `kafka-fact-publisher.ts:77-85` calls `producer.send({ topic, acks, messages })` with no `timeout`. **Why it matters:** the relay holds `FOR UPDATE` row locks across the entire broker round trip, and §5.2's argument for choosing `SKIP LOCKED` over lease columns rests explicitly on that open transaction being bounded *"by `OUTBOX_BATCH_SIZE` … and by the producer's `OUTBOX_PUBLISH_TIMEOUT_MS`"*. As shipped it is bounded only by kafkajs's own defaults; the configured 5 000 ms is a number an operator can change with no effect. Strictly the tasks only required the config to be *read* (C7), so this is design-prose-versus-behaviour rather than an unfinished task — but it is a config surface that lies. **Fix:** pass `timeout: config.publishTimeoutMs` into `producer.send`, or delete the setting from the config and `.env.example` and amend §5.2.

**D3 — `@testcontainers/kafka` is installed and unused.** Added to the catalog (`pnpm-workspace.yaml:56`) and to `apps/orders` devDependencies by task C6, but the design's own fallback (deviation 1) means the fixture drives `apache/kafka:4.3.1` through `testcontainers`' `GenericContainer`; the package is referenced only in two comment lines. **Why it matters:** `CLAUDE.md` § Commit discipline makes the installed-package list part of the commit record, so this feature's commit would advertise a dependency the codebase never imports. **Fix:** remove it from both places, or keep it and say why in the commit message.

**D4 — the human's manual verification step publishes a wrong `occurredAt`.** `progress/impl_outbox_and_idempotency.md` §9 step 6's `INSERT` uses `NOW(3)` and `NOW()`. The compose MySQL runs `TZ=Europe/Madrid` (`docker-compose.infra.yml:38`) with `time_zone = SYSTEM`, while every application pool connects with `timezone: 'Z'`. I ran that exact step against the live stack: the fact published `occurredAt: "2026-08-20T18:09:32.862Z"` for a row written at `16:09:32Z` — two hours in the future. **Why it matters:** the human's own acceptance check produces a misleading artefact, and `CLAUDE.md` says UTC everywhere. The application write path is unaffected (JS `Date` in, JS `Date` out, both under `timezone: 'Z'`, asserted to the millisecond by the three migration round-trips). **Fix:** use `UTC_TIMESTAMP(3)` / `UTC_TIMESTAMP()` in the documented snippet.

**D5 — `findByReference` is delivered but exercised by nothing.** `apps/orders/src/infrastructure/persistence/order.repository.ts:36-38` is public API required by task D4; grep finds no test that calls it. `findById` is covered only incidentally (inside the idempotent-consumer cases), and `order.mapper.ts` has no dedicated round-trip assertion, so `notes`, `cancellationReason` and `discount` are never read back through the adapter. No `R`/`OI` covers the read path, so this is not a spec violation — but feature 15 inherits an unproven method on an adapter the gate moved here precisely so it would be proven. **Fix:** one round-trip case (`save` → `findByReference` → field-level equality, including a cancelled order) in feature 15.

**D6 — the trilogy contract still misstates its own coverage.** `specs/shared/test-matrix.md:70`: `| **Total** | **R1 – R61** | **61** | **0** |` while rows 1 and 2 now read 9 and 7. Pre-existing (feature 13 left it), disclosed as deviation 6, and task I1's *"update the §2 Green count in the coverage summary"* is ambiguous enough that the literal reading is defensible — but the document #8 and #9 will read now says 16 green rows and a total of zero. **Fix:** set the Total cell to 16 the next time the matrix is touched.

**D7 — a publish failure commits an empty transaction instead of rolling back.** `outbox-relay.ts:88-101` `return`s from the transaction callback on failure rather than rethrowing, so the claim transaction **commits**. `design.md` §5.3 says *"If `publish` rejects, the transaction rolls back"*. Behaviourally identical today — nothing has been written at that point, and the code comments say exactly that — but it is an undisclosed divergence from the design's wording, and it silently becomes wrong the day feature 27 adds any write (an `attempts` counter, say) before the publish. **Fix:** rethrow and catch outside the transaction, or record the divergence in the design.

**D8 — `seq` is typed nullable in the Drizzle model though the column is `NOT NULL`.** The three `outbox.schema.ts` files declare `bigint('seq', …).autoincrement().unique()` with no `.notNull()`, so the emitted SQL is `ADD seq bigint unsigned AUTO_INCREMENT UNIQUE` rather than `design.md` §3's `NOT NULL AUTO_INCREMENT UNIQUE`. MySQL applies `NOT NULL` implicitly — I confirmed `IS_NULLABLE = NO` in all three live databases — so the database is correct and the migration bodies stay byte-identical; only the TypeScript model tells a small lie about the column. Cosmetic today because nothing reads `seq` off a row.

**D9 — `OI9`'s discipline rule is demonstrated, not guarded.** `outbox-atomicity.integration.spec.ts:81-120` performs the correct discipline itself (re-derives the aggregate) and asserts the good outcome. Nothing anywhere fails if a retry is driven from an already-drained instance, which is the failure `design.md` §4.4 warns about. The requirement as worded is satisfied; the *rule* is prose. **Fix:** at feature 15/16, where a retry loop first becomes real, add the negative case — a retry off the drained instance must not commit an aggregate row without its fact.

**D10 — `R17`'s matrix-named case is weaker than its name.** My mutation M4 committed the dedup record in its **own** transaction before the handler's — precisely the violation of *"in the same transaction"* — and the case named for `R17` in the matrix stayed **green**; only the sibling case *a failure in work leaves no dedup row* caught it. Traceability holds at file level, and the file's case set does prove the requirement, but the case the matrix cites does not on its own. **Fix:** have the `R17` case also assert the rollback property, or cite both cases in the matrix row.

## 8. What I did **not** do, and why

- I did not run `pnpm dc:clean:infra`. `down -v` destroys every named volume in `docker-compose.infra.yml` — including the human's 24-hour-old SonarQube, Grafana, n8n and MongoDB read-model data. No agent instruction is consent to wipe a developer's environment. The live proof was obtained non-destructively on scratch databases (§3 probe 6) and the environment was returned to its exact prior state; the documented recreate-and-reseed procedure remains the human's step 1, and it is the correct one for them to run before committing.
- I did not fix any of the ten defects. I have no Write or Edit tool by design, and the fix belongs to the implementer.
- I ran no `git add`, `git commit` or `git push`.

## 9. Verdict

**APPROVED.** Every requirement this feature owns — `R12`–`R15`, `R17`, `R18` and `OI1`–`OI12` — has a concrete, named, non-vacuous test that I re-ran myself; the two guarantees the rest of the system will lean on (no dual-write, exactly-once effect per `(eventId, consumer)`) survived hostile edits at five different places in the reliability logic, and both parity guards fired on divergences I introduced rather than the implementer's. The three reported deviations are all justified — two are the spec's own sanctioned escape hatches, and the third implements the design's stated intent in place of a pattern the design printed incorrectly. The ten defects are hygiene, dead configuration, documentation and test-strength items; none of them weakens a proven guarantee, and none is worth another round-trip through the gate.

`feature_list.json`: `outbox_and_idempotency` → `done`. Effort record appended to `progress/history.md`.
