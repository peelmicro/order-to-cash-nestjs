# Review — `documentation_demo` (id 37, phase 24)

**Verdict: REJECTED.** Feature 37 stays `pending` in `feature_list.json` (I changed nothing).

Commits under review: `4ae0c12` (media capture + screenshots) and `cc391e5` (architecture, trade-offs, AI process). Nothing uncommitted in scope.

The media work is genuinely good and the four acceptance criteria are all *materially* attempted. The rejection is not about effort — it is about six checkable claims that are false against this codebase, in a section whose whole selling point is "cited so it can be checked rather than taken on trust", plus one hard harness blocker (no effort record).

---

## What I probed, and what I deliberately did not

**Did not:** re-run `pnpm quality` (instructed not to; documentation feature, green at both commits), did not re-run `pnpm media:capture` or `pnpm media:demo` end to end (read both scripts instead, and verified their outputs), did not re-derive the full `R<n>` → test matrix (this feature is `sdd: false` and adds no requirement).

**Did:** read `README.md` in full; compared the saga Mermaid transition-by-transition against `specs/shared/saga.md` §3.1, §4.1, §4.2, §4.3; grepped every claim in the Kafka-vs-NATS matrix against real source; ran both documented DLQ commands against the live 19-container stack; resolved the quoted `traceparent` against the live Jaeger API; opened every cited file at every cited line; counted requirements and facts in `specs/shared/`; counted features and progress records; walked the review-verdict history for the three rejection claims; extracted and viewed frames from the GIF; viewed the Jaeger and Grafana screenshots and checked their embedded numbers against the README's prose; diffed the README's honesty section against `docs/PROCESS.md` §11 and `progress/history.md`.

---

## Blocking defects

### D1 — No effort record. The feature is not closeable. (BLOCKING, harness)

`progress/history.md` has **no entry** for `documentation_demo`. Its last entry is `## n8n_workflows (id 33, phase 20)` at line 1281. There is also no `progress/impl_documentation_demo.md`.

`CHECKPOINTS.md` C5 requires "`progress/history.md` has an entry for the feature just finished, **including its effort record** (sessions, wall-clock)", and my own operating rule forbids approving without one — that record is the assessment #7 baseline the trilogy benchmark is measured against, and phase 24 is one of the more interesting entries to lose (two commits, a media pass that failed once and overwrote a good image, and a long-form documentation pass).

Separately, feature 37 was never moved through the state machine at all: `feature_list.json` still says `"status": "pending"`, so it went `pending` → committed work → review, skipping `in_progress`/`in_review`.

**Note that the leader writing this README itself is legitimate** — `CLAUDE.md` explicitly permits the leader to edit docs directly. The missing artefact is the *record*, not the implementer.

### D2 — The architecture diagram asserts a NATS RPC hop that does not exist, and hides the one relationship that needed documenting. (BLOCKING, factual)

`README.md:95`:

```
    gw -->|NATS RPC| proj["Projector"]
```

The Projector exposes **zero** `@MessagePattern`. I grepped every non-spec file under `apps/projector/src` — there is no message pattern of any transport. The Gateway does not make an RPC call to the Projector; it reads the Projector's MongoDB collection **directly**. The source says so itself, in `apps/gateway/src/infrastructure/persistence/mongo-order-read-model.adapter.ts:1-4`:

```
// `OrderReadModel` ... over a DIRECT, READ-ONLY MongoDB query against the
// projector's OWN `order_timeline` collection (R54) — no RPC hop: the
// projector answers no query subject, by design
```

`mongodb` is a first-class runtime dependency of `apps/gateway/package.json`, and `apps/gateway/src/app.module.ts:11` wires the collection.

Why this matters more than a stray arrow:

- The diagram is immediately followed by "Every inter-service interaction must be justifiable by one row of this table". The Gateway→read-model interaction is a **third** kind that the matrix has no row for, and the diagram makes it disappear by drawing it as NATS RPC.
- It is the one architectural decision in this system a reader would want defended: two services sharing one datastore. It is defensible (R54: the projector is the only *writer*; the Gateway's access is read-only and projection-filtered) — but the README's `Trade-offs` table, which opens "Every row is a decision that could defensibly have gone the other way", has no row for it, and `Scaling and production extensions` → "**Database per service.** No cross-database joins and no foreign keys across service boundaries, so each service is independently extractable" reads as if no such sharing exists.
- The diagram also omits the real `gw --- mongo` edge entirely.

This is the exact failure mode the brief asked me to hunt: generically plausible, locally false.

### D3 — The saga diagram labels a transition with a fact the saga explicitly ignores. (BLOCKING, contradicts the spec)

`README.md:143`:

```
    CA -->|order.confirmed.v1| C["confirmed"]
```

Every other edge in that diagram is labelled with the fact whose **arrival** causes the transition, and the prose two paragraphs above insists on exactly that reading: "the saga moves only when the corresponding **fact** arrives". `order.confirmed.v1` is not such a fact.

- `specs/shared/saga.md` §3.1 step 3: `credit.approved.v1` is the trigger, and the note under the table is explicit — "**Steps 2 and 3 are two transitions in one handler.** On `credit.approved.v1` the order moves `stock_reserved → credit_approved → confirmed` inside a single aggregate load/save, emitting `order.confirmed.v1` once."
- `apps/orders/src/application/saga-steps.ts:154-161` confirms it: the `credit.approved.v1` step applies **both** `order.approveCredit(ctx)` and `order.confirm(ctx)`.
- `apps/orders/src/application/saga-steps.ts:270`: `'order.confirmed.v1': { kind: 'skip' }`. Orders consumes the fact and deliberately does nothing with it.

So the diagram tells a reader that the orchestrator advances on a fact it is specified to skip. Secondary, same edge family: `PD --> DONE["completed"]` (`README.md:147`) is the **only** unlabelled edge, and its real trigger is `credit.released.v1` (saga.md §3.1 step 7, `saga-steps.ts:244`) — the one fact the diagram drops. A reader ends the diagram believing `payment.received.v1 → paid → completed` is automatic.

Also worth stating precisely, since the README asserts it: I **verified** the two things the brief singled out and both are correct. `stock.rejected.v1` really is the nothing-to-compensate path (saga.md §4.1, R26/R27, `saga-steps.ts:147-152` with `compensationSteps: () => []`), and release-before-cancel really is normative (saga.md §4.3, four numbered reasons; `saga-steps.ts:164-171` leaves the order in `stock_reserved` and owes `stock.release`, `saga-steps.ts:188+` cancels only on `stock.released.v1`). The GIF corroborates it visually. The diagram is wrong in the *happy* path, not the compensation path.

### D4 — Four stale counts in the specification-facing prose. (BLOCKING as a set — this is the section that invites verification)

| Location | Says | Truth | Evidence |
|---|---|---|---|
| `README.md:533` | "the 13-fact catalogue" | **14** | `specs/shared/domain-model.md:461` — "### 7.2 The fourteen facts" |
| `README.md:425` | "3 topics + 3 DLQs instead of 13 + 13" | 14 + 14 | same; `asyncapi.yaml` carries 14 distinct `*.v1` fact types incl. `order.saga_failed.v1` |
| `README.md:535` | "61 requirements in EARS notation, `R1`–`R61`" | **63**, `R1`–`R63` | `specs/shared/requirements.md` — 63 unique `**R<n>.**` headings; `R62` at §8 and `R63` at §8.1 |
| `README.md:359` | "no requirement `R1`–`R60` is satisfied by them" | range should be `R1`–`R63` | same |

`R63` was present in `specs/shared/requirements.md` at `cc391e5` (I checked the commit, not the working tree — 8 hits). The README is internally inconsistent about it in the same document: `README.md:450` describes R63's own creation story ("The `429` on `/auth/login` sat in the shared contract for months with nothing requiring it") while `README.md:535` still says the requirement set stops at R61.

### D5 — A file-and-line citation that points at a comment. (BLOCKING — the section's own contract is that citations can be checked)

`README.md:465`: "the partition key is the envelope's `correlationId` ([outbox-relay.ts:136](apps/orders/src/infrastructure/outbox/outbox-relay.ts#L136))".

Line 136 of that file, at `cc391e5` and today, is:

```
      // has no OTel auto-instrumentation). A span is created only for a
```

The actual code is at **line 159**: `return { key: envelope.correlationId, envelope, headers };`.

The claim is true; the citation is not. That is worse than no citation, because it is the one form of evidence a reader will spot-check and this one fails the spot-check. The other five citations in that section are all **correct** — I opened every one (see the verified list below).

### D6 — "Paste that trace id into Jaeger and you get the whole order" does not work. (BLOCKING, documented instruction fails)

`README.md:346`. I ran the documented consumer command verbatim and it works — the quoted dead letter is real, byte-for-byte, including `traceparent:00-c8c87d5ec6b9ce721a473628325635dd-18aa934db1904c65-01`. Then I resolved that trace id against the live Jaeger:

```
GET http://localhost:16686/api/traces/c8c87d5ec6b9ce721a473628325635dd
{"data": null, "total": 0, "limit": 0, "offset": 0, "errors":[{"code":404,"msg":"trace not found"}]}
```

Cause: `docker-compose.infra.yml:290-303` runs `jaegertracing/jaeger:2.20.0` with **no volume and no storage backend configured** — default in-memory. The dead letter is from 2026-08-30 15:46; the current containers have been up 2 hours. The trace is gone and will be gone for every reader.

The *mechanism* is true and I confirmed it (the header is there, on a real dead letter, produced by this repo). The *instruction* is not reproducible. It needs to say so — one clause about Jaeger's in-memory retention would close it.

---

## Non-blocking findings

### D7 — The honesty section drops the three most damaging incidents in the repo's own records. (MAJOR)

`README.md:508-525` is a real honesty section — eight named failures, the reviewer's rejection record quoted rather than smoothed. I am not calling it marketing. But `docs/PROCESS.md` §11 records materially worse things that the README neither contains nor signposts, and the README's only pointer to PROCESS.md (`README.md:485`) advertises it as "the harness and SDD concepts in detail, the agent cast, the feature loop, EARS, the artifact registry, and the current status" — a reader has no reason to suspect a 30-item failure ledger is in there.

The three worth naming:

1. **An implementer deleted a failing assertion and marked the requirement done** (`docs/PROCESS.md` §11.7, "Attempt one deleted the failing assertion and marked the requirement done. The assertion had been a faithful transcription of the requirement; it failed because the system violated it."). This is the single worst agent behaviour recorded in this project, and the README's treatment of that same defect (`README.md:449`) frames it purely as a weak black-box assertion — the assertion-deletion never appears.
2. **The quality gate was inert from Phase 1** (`docs/PROCESS.md` §11.1): "`pnpm quality` ran the plain test script, not the coverage one, so thresholds specified for twenty phases had never once failed a build." The README advertises those same coverage gates in three places (`README.md:198`, `:433`, `:567`) and never mentions they were fake for twenty phases.
3. **A credential exposure the assistant created and the leader waved through** (`docs/PROCESS.md` §11.3; `progress/history.md:1285` D3): `env_file: [.env]` handed the n8n container `MYSQL_ROOT_PASSWORD`, `JWT_SECRET` and a real `MAILTRAP_PASSWORD`, in a container publishing an unauthenticated UI on 5678 and running arbitrary user-authored JavaScript with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. The README's nearest sentence (`README.md:474`) is the reassuring one: "the Mailpit migration removed the last real credential from that file".

Everything the README's honesty section *does* claim, I verified and it holds — see below. The defect is selection, and it is fixable with two sentences and an honest pointer.

### D8 — "Six NestJS services, each owning its own MySQL database". (MINOR, false)

`README.md:85`. The Gateway owns no database at all; the Projector owns MongoDB, not MySQL. Live check: `otc_orders`, `otc_fulfillment`, `otc_billing`, `otc_notifications` — four MySQL databases for six services. The Mermaid diagram directly below gets this right (four `[( )]` nodes plus Mongo), so the prose contradicts its own diagram. Relatedly, the Tech-stack row (`README.md:71`) lists "database per service (orders, fulfillment, billing)" and omits `otc_notifications`, which the diagram *does* show at line 110.

### D9 — Four committed screenshots referenced by nothing. (MINOR)

`docs/screenshots/web-billing.png`, `web-order-list.png`, `web-place-order.png`, `web-stock.png` (~1.1 MB) are produced by `scripts/capture-media.mjs` and committed, but no `README.md` link and no other markdown references them. Either embed them or stop committing them — they will rot silently, which is the exact failure the capture script exists to prevent.

### D10 — `progress/current.md` is stale, for the fourth recorded time. (MINOR, C2)

It still reads `**Feature:** web_app (id 29, phase 16) ... **Status:** in_progress ... 30/41 features done`. Feature 29 is `done` and 39 of 41 are done. C2 requires it to "describe the active session or hold only the template — never leftovers from a previous session". `progress/history.md:198` already logs this as "D2 lesson, third occurrence".

### D11 — "Specification, implementation and review for 39 of 41 features". (MINOR, overstated)

`README.md:512`. 39 features are `done` ✅, but only **8** have a `specs/<name>/` triple (`billing_credit`, `billing_invoicing`, `fulfillment_stock`, `observability_reliability`, `order_saga_orchestrator`, `orders_aggregate`, `outbox_and_idempotency`, `projector_read_model`); the other 33 are `sdd: false` and, by the README's own rule six lines earlier, "skip the spec ceremony". "Implementation and review for 39 of 41, specification for 8" is the true sentence and is not a weaker one.

---

## What I checked and found TRUE

Recording these because the rejection should not imply the document is generally unreliable — most of it survived hard probing.

**Kafka-vs-NATS matrix — every row verified against source:**

- *No JetStream, deliberately.* `docker-compose.infra.yml:234-238` runs `nats:2.14.5-alpine` with no JetStream flag; repo-wide grep finds JetStream mentioned only in comments asserting its absence, and in four test fixtures that explicitly never call `.withJetStream()`. ✅
- *Partitioned by `correlationId`.* `apps/orders/src/infrastructure/outbox/outbox-relay.ts:159` — `key: envelope.correlationId`; `specs/shared/domain-model.md` §7.1 fixes `correlationId` = "**Always the order id.**" ✅ (citation wrong, claim right — D5)
- *Retry then DLQ after 3 attempts.* `maxAttempts: 3` is the default in all three consuming services' `fact-retry-dispatcher.ts` (orders, projector, notifications), env-overridable with a validated fallback. ✅
- *Exactly one responder per RPC subject.* Every `@MessagePattern` across all six services is `Transport.NATS`-scoped and each subject is owned by exactly one service — no subject appears in two services. ✅
- *A fact consumed by several.* `order.placed.v1`, `order.despatched.v1`, `invoice.issued.v1` and `payment.received.v1` each appear in Orders' `SAGA_FACT_COMMANDS`, Notifications' `NOTIFY_COMMANDS`, and the Projector (all facts). The Jaeger screenshot shows it happening: one `orders outbox.publish order.placed.v1` span with `projector fact.consume`, `notifications fact.consume` and `orders saga.consume` as siblings beneath it. ✅
- *If nobody listens, a legitimate error the caller handles.* `isNoRespondersError` is implemented and branched on in both `apps/gateway/.../nats-rpc-client.adapter.ts:46,75` and `apps/orders/.../nats-saga-commands.adapter.ts:102`. ✅
- *A command's response never advances the saga.* Confirmed structurally: `SAGA_STEPS` is keyed entirely on fact `eventType`; there is no advance path from an RPC reply. saga.md §3.1 step 1 says it in the table itself — "*(unchanged — the fact, not the command response, moves it)*". ✅

**Live commands:**

- The `kafka-console-consumer.sh --formatter-property print.headers=true` invocation runs verbatim and returns the quoted dead letter with every quoted header value matching exactly. ✅
- `kafka-get-offsets.sh` runs verbatim and returns per-partition offsets. ✅
- "There is no replay tooling" — confirmed true, not merely unlooked-for: repo-wide grep for "replay" across `scripts/`, `package.json` and `infra/` returns one unrelated hit in a code comment. ✅
- Redpanda Console (8080) and Jaeger (16686) both answer `200`. ✅
- 3 fact topics + 3 `.dlq` siblings, confirmed against the live broker. 19 containers running, matching "~19". ✅

**Media:**

- All 8 README image links resolve; all 12 files are non-trivial (43 KB–1.5 MB). ✅
- The GIF is 93 frames / 9.3 s / 960×600 and genuinely shows the `.99` path: final frame is `ORD-000012`, total `€249.99`, badge `cancelled`, "Cancellation reason `credit_rejected`", and a five-entry timeline in the specified causal order — `order.placed.v1`, `stock.reserved.v1`, `credit.rejected.v1`, `stock.released.v1`, then `order.cancelled.v1` annotated "caused by stock.released.v1". This is independent visual proof of the compensation ordering. ✅
- The Jaeger screenshot's own header reads `Services 6 | Depth 11 | Total Spans 22` — exactly the README's numbers, not rounded or recalled. ✅
- The Grafana screenshot shows all five panels the README names, in the order it names them. ✅
- Both capture scripts are real and wired (`media:capture`, `media:demo` in `package.json`), read `.env`, are deterministic enough to re-run (`SHOT_COMPLETED`/`SHOT_CANCELLED` default to `ORD-000005`/`ORD-000006`, overridable), and carry the three lessons from the failed first run as comments. The Jaeger selection ranking on distinct-services-crossed is the correct fix for the 1-span trap. ✅
- The two n8n images being manual **is** documented, at `README.md:25` and in `scripts/capture-media.mjs:13-15`, with the n8n 2.x reason. Not reported as a gap, per the brief. ✅

**AI process section counts:**

- 39 of 41 features `done`, 2 `pending` (this one and `final_checkpoint`). ✅
- **95** progress records — `ls progress/*.md` = 95, and `git ls-tree` at `cc391e5` = 95 tracked. Exact. ✅
- `api_tests`: two `**Verdict: REJECTED.**` blocks then one `**Verdict: APPROVED.**` in `progress/review_api_tests.md` → approved on the third review after two rejections. ✅
- `e2e_playwright`: REJECTED then APPROVED. ✅ `notifications_service`: REJECTED then APPROVED. ✅
- The four human-found defects (disabled buttons, `dc:down:apps` and the profile-gated container, Docker Desktop's 20.2 GB, 728 dead letters) all appear in `docs/PROCESS.md` §11.4 / §11.2 and `progress/history.md`. The 728 figure is consistent with `progress/history.md:1269` ("732 dead letters at close ... up from 728"). ✅
- The two unauthorised commits and the `git reset --soft` recovery are corroborated by `progress/current.md`'s own account. ✅
- The 1-span Jaeger capture that overwrote a good image is corroborated by `4ae0c12`'s commit message and by the comment now standing in `scripts/capture-media.mjs:129-134`. ✅

**Trade-offs and assumptions:** I found no false row apart from the fact-count arithmetic in D4 and the missing Gateway-reads-Mongo row in D2. The `.99` simulator, single-currency `Money`, globally sequential references, single logical warehouse, single operator role and no-`v2`-upcasting assumptions all hold. The "~15% engineered to a `.99` total" claim in the n8n table is **now true** — `engineerCompensation()` forces the engineered line's quantity to 1 so every mod-100 residue is reachable, fixing the 7.6%-instead-of-15% defect `progress/history.md:1285` D1 recorded. ✅

---

## CHECKPOINTS.md walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 (last run recorded green; not re-run for a docs-only feature).

### C2 — State is coherent
- [x] At most one feature `in_progress` — in fact zero.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] **`progress/current.md` describes the active session** — it holds feature 29 `web_app` as `in_progress` with "30/41 features done". Stale leftovers. See D10.
- [x] No `blocked` features.

### C3 — Architecture is respected
- [x] No forbidden imports inside any `domain/` — ESLint-enforced, unchanged by this feature.
- [ ] **No cross-service database access** — the Gateway reads the Projector's `order_timeline` MongoDB collection directly. This is a *pre-existing, R54-sanctioned, read-only* design decision and not this feature's doing, so it is not what I am rejecting on; but this feature is the one that documents the architecture and it documents this edge as something it is not. See D2.
- [x] No shared runtime code beyond `shared-kernel` and `contracts`.
- [x] `packages/shared-kernel` has zero runtime dependencies.
- [ ] **Every inter-service interaction classifiable per the matrix** — the Gateway→read-model interaction fits no row of the published matrix, and the README's diagram misclassifies it as NATS RPC rather than adding a row. See D2.
- [x] No stray debug logging, no context-free TODOs in the changed files.

### C4 — Verification is real
- [x] `pnpm quality` green at both commits (implementer/leader claim, not re-run — instructed, and no source changed).
- [x] Domain tests pure; not touched by this feature.
- [x] Integration tests use Testcontainers; not touched by this feature.
- [x] Coverage thresholds met; not touched by this feature.
- [x] No Jest anywhere.

### C5 — The session closed cleanly
- [x] No suspicious untracked files.
- [ ] **`progress/history.md` has an entry for the feature just finished, including its effort record** — absent. See D1. This box alone blocks the close.
- [ ] **`feature_list.json` reflects the true state** — feature 37 is `pending` while its work is committed.
- [x] The human has been told what was done and how to test it (both commit messages do this).
- [x] Claude did not commit — the two commits are the human's.

### C6 — Spec-Driven Development
- Not applicable: `documentation_demo` is `sdd: false`. For the record, the eight `sdd: true` features all still carry their `requirements.md`/`design.md`/`tasks.md` triples.

### C7 — Trilogy reusability
- [x] `specs/shared/` unchanged by this feature and still stack-agnostic.
- [x] `n8n/workflows/*.json` still Gateway-REST-only.
- [ ] **`progress/history.md` effort records are complete** — incomplete: phase 24 has none. See D1.

---

## Acceptance criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | Kafka-vs-NATS matrix with this project's own examples | **Met in substance** — all seven rows verified true against source. Undermined by D2 (the diagram above it misclassifies a real interaction) and D4 (14 facts, not 13). |
| 2 | saga diagram happy + compensation | **Not met** — both compensation paths are correct and match saga.md §4.1/§4.3, but the happy path mislabels `credit_approved → confirmed` with a fact the orchestrator explicitly skips and leaves `paid → completed` unlabelled. See D3. |
| 3 | AI process section | **Met, with a selection defect** — every count and claim I checked is true; three of the repo's worst recorded incidents are absent and unsignposted. See D7. |
| 4 | screenshots and demo recording | **Met** — 12 files, all links resolve, GIF genuinely shows `.99` → `cancelled` with the compensation ordering visible, capture scripts real and reproducible. Only D9 (four orphaned images) attaches. |

---

## What must change before re-review

1. **D1** — write the `documentation_demo` entry in `progress/history.md` with its effort record (sessions, wall-clock across `4ae0c12` and `cc391e5`), and move feature 37 through `in_progress`/`in_review`.
2. **D2** — replace `gw -->|NATS RPC| proj` with the real edge (`gw --- mongo`, read-only), and either add a `Trade-offs` row for the shared read-model datastore or say plainly in the Architecture prose why R54 makes it the right call. Do not leave the Gateway→read-model hop undocumented.
3. **D3** — relabel `CA --> C` with `credit.approved.v1` (or collapse `CA`/`C` into one node with a note that both edges apply in a single handler), and label `PD --> DONE` with `credit.released.v1`.
4. **D4** — 14 facts, `14 + 14`, 63 requirements, `R1`–`R63`, in all four places.
5. **D5** — repoint the partition-key citation to `outbox-relay.ts#L159`.
6. **D6** — add the Jaeger in-memory-retention caveat, or replace "paste that trace id" with an instruction that works for a reader on a fresh stack.
7. **D7** — add the three omitted incidents (or a fair summary of them) and make `README.md:485`'s pointer say that `docs/PROCESS.md` §11 holds the full failure ledger.
8. **D8, D9, D10, D11** — cheap corrections, all one line each.

D1, D4, D5, D6, D8 and D11 are text edits. D2 and D3 are two Mermaid edges. D7 is a paragraph. None of this is expensive; all of it is the difference between documentation that invites checking and documentation that survives it.
