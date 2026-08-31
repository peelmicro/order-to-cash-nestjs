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

---

# Second review — `documentation_demo` (id 37, phase 24)

**Verdict: APPROVED.** Feature 37 moved `in_review` → `done` in `feature_list.json` (that field only, nothing else in the repo).

Commit under review: `9672cf4`, on top of `cc391e5` and `423643e`. Working tree clean and byte-identical to `9672cf4`.

All six blocking defects (D1–D6) are genuinely closed — verified first-hand, not accepted on the leader's word. All five non-blocking (D7–D11) are closed except one tail of D8. Three new minor defects, two of them introduced by the fix pass itself, are recorded as open at approval; none is blocking, and per this repository's own precedent (`progress/history.md`, `n8n_workflows` second review — *"the second review held that line rather than moving the bar after the fact"*) a non-blocking residual does not become blocking at re-review.

## What I probed, and what I deliberately did not

**Did not:** re-run `pnpm quality` (instructed; the fix touches no source — `git show --stat 9672cf4` is `README.md`, `feature_list.json`, `progress/{current,history,review_documentation_demo}.md` and nothing else, so the 1475-test claim at `9672cf4` cannot have been affected by the diff), did not re-derive the full `R<n>` → test matrix (`sdd: false`, adds no requirement), did not re-verify the Kafka-vs-NATS matrix rows or the media artefacts (verified in full on pass 1, unchanged by the diff).

**Did:** open all seven citations at their cited lines; re-walk **every** edge of the saga diagram against `specs/shared/saga.md` §3.1 and §4.1–§4.3 *and* `apps/orders/src/application/saga-steps.ts`, not only the two flagged; count the fact catalogue and the requirement headings myself; grep `apps/projector/src` for message patterns; read `mongo-order-read-model.adapter.ts` for write operations; read `docker-compose.infra.yml`'s Jaeger service and `docker inspect otc-jaeger`; re-resolve the quoted trace id against the live Jaeger API; diff the three new honesty bullets against `docs/PROCESS.md` §11 line by line; count §11's items; check the claimed effort timings against `git log --date=format-local`; count `specs/<name>/` triples and cross-check against `sdd: true`; resolve every relative link and anchor in `README.md` programmatically; check code-fence balance and table-row raggedness across the whole file; cross-read the four places the fix pass added shared-datastore prose against each other; list every file in `docs/screenshots/` against its references.

## The eleven, verified

### D1 — effort record. CLOSED.

`progress/history.md:1309` now carries `## documentation_demo (id 37, phase 24) — 2026-08-30/31 (REJECTED on the first review)`.

It is a genuine record, not a summary wearing one's clothes. Its timings are traceable and I traced them — every claimed bracket matches `git log --date=format-local:'%Y-%m-%d %H:%M'` exactly:

| Entry claims | Commit | Actual |
|---|---|---|
| Mailpit migration ≈17:2x → 18:27 | `c5f65cc` | 18:27 (prior commit `7bf40c9` at 17:16, so the ≈17:2x start is right) |
| media capture ≈18:27 → 19:22 | `4ae0c12` | 19:22 |
| login rate limit ≈19:22 → 06:26 | `423643e` | 06:26 |
| documentation pass 06:26 → 06:32 | `cc391e5` | 06:32 |
| review 06:32 → 06:47 | — | my own pass; the file was committed at 06:53 |

It names what was built (both capture scripts, 12 images, the named README sections), names the agents used and their round counts, and records the rejection honestly — it reproduces all six blocking defects in their own words rather than paraphrasing them favourably, and adds a paragraph headed *"Leader errors this session, recorded because the pattern is identical across all three"* naming three of its own failures by name. That paragraph was not asked for. It is the strongest single piece of evidence that this is a record rather than a press release.

Feature 37 also now traverses the state machine: `pending → in_review` at `9672cf4`, `→ done` at this verdict.

### D2 — the invented NATS hop. CLOSED, and the three follow-on claims are true.

The Mermaid source itself (not the prose about it) now reads `gw -->|read-only query| mongo` and `proj -->|writes| mongo[("MongoDB read model")]`. `gw -->|NATS RPC| proj` is gone. Both edges I asked for are present.

Follow-on claims, each checked:

- **The prose paragraph exists** (`README.md:124`) and names the relationship in the open — *"It is the one place two services share a datastore, and the cost is real"*.
- **The Trade-offs row exists** (`README.md:445`), *"Gateway reads the read model directly, rather than through an RPC hop"*, with a real cost column naming the extraction consequence.
- **The scaling line is qualified** (`README.md:490`): *"**Database per service** for the four write models … The one documented exception is the read model"*.

The two substantive claims inside that new prose are **true**:

- *"the Projector answers no RPC subject at all"* — `grep -rn "MessagePattern" apps/projector/src` returns nothing outside specs. Zero, of any transport.
- *"R54 makes the Projector the only writer"* — `specs/shared/requirements.md:460`: *"THE SYSTEM SHALL make the projector the **only** writer of the read model, and SHALL serve every order list and order detail query from the read model only"*. The README's summary is faithful, and R54's second clause independently sanctions the Gateway's read.
- *Read-only* — verified against the adapter, not the comment: `mongo-order-read-model.adapter.ts` contains `findOne`, `find` and `countDocuments` and no insert/update/delete/replace of any kind, all three with `projection: EXCLUDE_INTERNAL_FIELDS`.

All four places now agree with each other. I read them side by side: Architecture intro (four MySQL + Mongo + Gateway owns nothing), post-diagram paragraph, trade-off row, scaling bullet. No contradiction between them.

*Informational, not a defect:* `apps/seed/src/writers/mongo.writer.ts` also writes `order_timeline` (`replaceOne … upsert`). It is a fixture loader, not one of the six services, and its own header cites the same "projector: sole writer" rule it is deliberately excepted from, so "the Projector is the only writer" stands as a statement about the running system. Worth knowing that the exception exists.

### D3 — the saga diagram. CLOSED, and no third edge was broken.

`CA -->|order.confirmed.v1| C` is gone; `CA --> C` carries a `%%` comment and the new prose paragraph explains the two-transitions-in-one-handler collapse. `PD -->|credit.released.v1| DONE` is labelled.

I re-checked **every** edge, which is the risk you named:

| Diagram edge | `saga.md` | `saga-steps.ts` | |
|---|---|---|---|
| `placed --stock.reserved.v1--> stock_reserved` | §3.1 step 2 | `:141` precondition `placed`, `markStockReserved` | ✅ |
| `stock_reserved --credit.approved.v1--> credit_approved` | §3.1 step 3 | `:154` precondition `stock_reserved`, `approveCredit` | ✅ |
| `credit_approved --(unlabelled)--> confirmed` | §3.1 note, *"two transitions in one handler"* | `:158-161` same `apply` also calls `order.confirm(ctx)` | ✅ |
| `confirmed --order.despatched.v1--> despatched` | §3.1 step 4 | `:208` precondition `confirmed`, `markDespatched` | ✅ |
| `despatched --invoice.issued.v1--> invoiced` | §3.1 step 5 | `:214` precondition `despatched`, `markInvoiced` | ✅ |
| `invoiced --payment.received.v1--> paid` | §3.1 step 6 | `:220` precondition `invoiced`, `markPaid` | ✅ |
| `paid --credit.released.v1--> completed` | §3.1 step 7 | `:244-249` first variant, precondition `paid`, `order.complete(ctx)` | ✅ |
| `placed --stock.rejected.v1--> cancelled (nothing to undo)` | §4.1 | `:147-152` `kind: 'cancel'`, `compensationSteps: () => []` | ✅ |
| `stock_reserved --credit.rejected.v1--> stock.release` | §4.2 B1 | `:164-171` no-op apply, order stays `stock_reserved` | ✅ |
| `stock.release --stock.released.v1--> cancelled (credit_rejected)` | §4.2 B2 | `:188` | ✅ |

Ten edges, ten correct. The two new prose claims also hold: `'order.confirmed.v1': { kind: 'skip' }` is at `saga-steps.ts:270`, and *"Billing emits `payment.received.v1` and `credit.released.v1` from one transaction"* is `saga.md` §3.1 step 6 verbatim (*"both Billing, same transaction, same partition"*).

### D4 — the four counts. The NEW numbers are right, not merely different.

- `specs/shared/domain-model.md:458` — `### 7.2 The fourteen facts`. I did not take the heading's word for it: I extracted every `<x>.<y>.v1` token in §7.2 and got exactly **14** distinct fact types. README's "14-fact catalogue" (`:555`) and "14 + 14" (`:440`) are both correct.
- `specs/shared/requirements.md` — **63** distinct `**R<n>.**` headings, contiguous `R1`–`R63`, max 63. README's "63 requirements in EARS notation, `R1`–`R63`" (`:557`) is correct.
- Both `R1`–`R60` occurrences are now `R1`–`R63` (`:374` and `:557`); a repo-wide grep for `13-fact`, `13 + 13`, `R61`, `R60` and `thirteen` in `README.md` returns nothing.

### D5 — the citations. All seven opened. **7 of 7 correct.**

| Cited | Line content |
|---|---|
| `apps/orders/.../outbox-relay.ts#L128` | `.for('update', { skipLocked: true });` ✅ |
| `apps/billing/.../outbox-relay.ts#L104` | `.for('update', { skipLocked: true });` ✅ |
| `apps/fulfillment/.../outbox-relay.ts#L104` | `.for('update', { skipLocked: true });` ✅ |
| `drizzle-saga-command-store.ts#L100` | `.for('update', { skipLocked: true });` ✅ |
| `order-number-allocator.ts#L84` | `.for('update');` ✅ (correctly *without* `skipLocked` — the prose says the second caller blocks, and it does) |
| `outbox-relay.ts#L159` | `return { key: envelope.correlationId, envelope, headers };` ✅ — the D5 repoint lands exactly |
| `nats-stream-signal.adapter.ts#L33-L34` | two `this.connection.subscribe(...)` calls, no queue-group argument ✅ — the "no queue group" claim is visible in the cited lines themselves |

### D6 — the Jaeger caveat. Accurate, and I reproduced the failure it now predicts.

`README.md:361` now says the trace is resolvable *"while the trace is still there"*, attributes it to *"its default in-memory storage and no volume"*, states the consequence (*"a dead letter therefore outlives its own trace"*) and the fix (*"configuring a storage backend"*).

The **why** is right: `docker-compose.infra.yml:290-303` runs `jaegertracing/jaeger:2.20.0` with no storage backend and no bind or named volume. `docker inspect otc-jaeger` shows only an anonymous `/tmp` volume inherited from the image — not trace storage. Live re-probe of the README's own quoted id:

```
GET http://localhost:16686/api/traces/c8c87d5ec6b9ce721a473628325635dd
{"data":null,"total":0,"limit":0,"offset":0,"errors":[{"code":404,"msg":"trace not found"}]}
```

Exactly the `trace not found` the new wording predicts, on a stack up 4 hours. It does not overclaim (it keeps "the header is not the problem", which is true — the `traceparent` really is on a real dead letter) and does not underclaim (it says outright that the documented instruction returns `trace not found` on a long-running demo stack). The one word I would not have written is *"old ones age out"* — restart, not eviction, is the mechanism a reader will hit — but Jaeger v2's in-memory store is bounded, so it is not false.

### D7 — the honesty section. All three present, accurately described, and I judge it a genuine disclosure.

**Accuracy, checked against the source records rather than the leader's account:**

1. *Deleted failing assertion* — `README.md:542` against `docs/PROCESS.md` §11.7 item 1. The README's added gloss — *"not a mistake, but the removal of the evidence of a mistake"* — is **harsher** than the source, not softer. Nothing is reframed.
2. *Quality gate inert from Phase 1* — `README.md:544` against §11.1 (*"thresholds specified for twenty phases had never once failed a build"*). The README reproduces "twenty phases" and adds the self-incriminating clause the source does not have: *"This README advertises those same gates in three places; they were decorative until Phase 21."* I checked "until Phase 21" rather than assuming it: `progress/history.md:1228-1230`, `sonarqube_quality_gates (id 34, phase 21)` is where `pnpm quality`'s third step became `test:coverage`, and `package.json:21` confirms the script today. The "three places" is fair — I count the `pnpm quality` line, the Coverage-gates section and the trade-off row.
3. *Credential exposure* — `README.md:546` against §11.3 and `progress/history.md:1285` D3. Every specific matches: `env_file: [.env]`, `MYSQL_ROOT_PASSWORD`, `JWT_SECRET`, a real SMTP password (`MAILTRAP_PASSWORD` in the source), unauthenticated UI, arbitrary user-authored JavaScript. *"caught by review, not by design"* matches history's record that it was a first-review rejection defect. The attribution — *"the assistant created and the leader waved through"* — matches §11.3's *"the leader's own brief had waved it through"*. Nothing softened.

**The pointer** (`README.md:500`) now reads *"**§11 is a ledger of what this process actually caught**, including the failures summarised below and roughly thirty more"*. §11 contains exactly **30** items by my count. The pointer is honest and the number is right.

**Is it genuine or token?** Genuine, and I say that having looked for the opposite. Three tests:

- *Placement.* The three sit in the honesty section itself under a heading that concedes the point of the original finding (*"The three worst, which an honesty section is worth nothing without"*), not in a footnote or an appendix.
- *Tone relative to source.* A token paragraph softens. This one sharpens on all three: "worst agent behaviour in the project's records", "decorative", "the assistant created and the leader waved through". Each names an actor. None hides behind the passive voice.
- *Coverage.* The section now names ~12 of §11's 30 items and points at the rest with an accurate count. It includes the two most damaging (deleted assertion, inert gate) and the only security incident. That is not a selection engineered to flatter.

**One residual selectivity, recorded rather than held against it (F4 below):** §11.3's *"Honest disclosure is not the same as the requirement being met"* — an implementer truthfully disclosed narrowing an "every line" requirement to three call sites and the row was marked complete anyway — is arguably in the same family as the deleted assertion, and is still not in the README. The §11 pointer now covers it honestly, which is why this is a note and not a defect.

### D8 — PARTIALLY closed. The main claim is fixed; the Tech-stack row is not, and is not declared open. See F1.

The Architecture prose (`README.md:94`) is corrected and **true**: *"Four of them own a MySQL database each (`otc_orders`, `otc_fulfillment`, `otc_billing`, `otc_notifications`); the Projector owns the MongoDB read model; the Gateway owns no store of its own."* Checked against the live server — `show databases` returns exactly those four `otc_*` schemas — and against the diagram, which draws exactly those four `[( )]` nodes plus Mongo. Prose, diagram and reality now agree. `ls -d apps/*/` confirms six NestJS services (`web` is Nuxt, `seed` a script).

The Tech-stack row I flagged is **unchanged and still wrong**. See F1.

### D9 — CLOSED.

Every one of the 12 files in `docs/screenshots/` is now referenced from `README.md`; I resolved each filename against the tree rather than counting links. The four former orphans (`web-place-order`, `web-order-list`, `web-billing`, `web-stock`) are embedded at `README.md:61-67`. All 12 relative paths resolve — my link walk over the whole file found **zero** broken file links and the one internal anchor (`#scaling-and-production-extensions`) resolves to a real heading.

**On the raw-HTML style:** the `<p align="center">` / `<img>` block is the **only** raw HTML in the README's prose — the other 8 images use markdown `![]()`, and the only other angle brackets in the file are `<br/>` inside Mermaid node labels. So the style genuinely is mixed. I do not think it is a problem worth blocking on, and I checked why rather than assuming: two images side by side at 45% width cannot be expressed in CommonMark, the block is correctly separated from surrounding prose by blank lines (required for GitHub to treat it as an HTML block), and `<p align>`, `<img>` and `<br>` all survive GitHub's sanitiser. Every image carries a real `alt`. The one place it would bite is a renderer with raw HTML disabled, where those four images vanish while the other eight render — worth knowing, not worth changing.

### D10 — CLOSED.

`progress/current.md` now opens `**Feature:** documentation_demo (id 37, phase 24, sdd: false)` / `**Status:** in_review — REJECTED once … defects being closed` / `39 of 41 features done`. That is the active session, its true state, and a correct count. C2 satisfied for the first time in four recorded sessions. The template block is intact below the fold.

### D11 — CLOSED, and the corrected sentence is accurate.

`README.md:528`: *"Implementation and review for 39 of 41 features across 95 progress records, and full specification for the 8 that carry a `specs/<name>/` triple — the other 33 are `sdd: false`"*.

I counted rather than trusted: `feature_list.json` holds 41 features, 39 `done`, 1 `in_review` (37), 1 `pending` (38); `specs/` holds exactly 8 non-`shared` directories, each with all three of `requirements.md`/`design.md`/`tasks.md`, and that set is byte-identical to the `sdd: true` set. 41 − 8 = 33. Every number checks. (The progress-record count is now off by one — F2.)

## Defects the fix pass introduced or left, none blocking

### F1 — The Tech-stack row still says three MySQL databases, now contradicting corrected prose 14 lines below it. (MINOR — named in D8, neither fixed nor declared open)

`README.md:80`: `| Write databases | MySQL 8 — database per service (orders, fulfillment, billing) |`.

`otc_notifications` is missing. This was called out explicitly in D8's second sentence and in "What must change before re-review" item 8. `9672cf4`'s commit message claims D8 closed and describes only the Architecture sentence, so the row was neither fixed nor consciously deferred — it was missed.

Why it matters now more than it did before the fix: the document previously said "each owning its own MySQL database" everywhere and was uniformly wrong. It now says **four** in two places (`:94` Architecture prose, `:490` scaling bullet) and draws four in the diagram, while this table says three. A reader counting databases gets different answers from the same file. Self-contradiction is a worse failure than a uniform error, because it tells the reader one of the two was not checked.

One-line fix: add `notifications` to the row, or retitle it — the notifications database holds only the `processed_events` idempotency ledger, so `MySQL 8 — database per service (orders, fulfillment, billing, notifications)` is the honest form.

### F2 — "95 progress records" is now 96, and it was the fix pass that made it so. (TRIVIAL)

`README.md:528`. `git ls-tree -r cc391e5 progress/` = 95 tracked `.md`; at `9672cf4` = 96, because `9672cf4` committed `progress/review_documentation_demo.md` — the rejection report — into `progress/`. The sentence was correct when written and was invalidated by the same commit that edited it. It will be 96 again after this verdict is appended to the existing file, and 97 when `progress/impl_*` records accumulate.

This count is structurally self-referential and will keep drifting. "~95" or "roughly a hundred" is the durable form.

### F3 — The architecture diagram's Projector node lost its label. (MINOR, introduced by the D2 fix)

`gw -->|NATS RPC| proj["Projector"]` was the **only** place `proj` was ever given a label. Deleting that line to close D2 removed the label with it. The current block contains only `K -.->|consume| proj` and `proj -->|writes| mongo[…]`, neither of which assigns text.

This is valid Mermaid — it parses and renders — but `proj` now displays as the bare identifier `proj` while every other node in the diagram carries a human name (`Gateway / BFF`, `Orders · saga orchestrator`, `Fulfillment`, `Billing`, `Notifications`, `MongoDB read model`, `Mailpit`). In the flagship diagram of a feature whose deliverable is the diagram, one unlabelled node is a visible blemish. Fix: `K -.->|consume| proj["Projector"]`.

I could not run a Mermaid parser (none is installed in this repo or reachable offline), so I verified both blocks by reading them against the flowchart grammar instead: 2 blocks, all fences balanced (34 delimiters / 17 blocks across the file), every edge well-formed, forward references (`mongo` used at `:105` before its shape at `:121`) legal and resolved by the later definition. I state this as a limitation rather than a clean bill: syntax read, not rendered.

### F4 — Small residuals, informational only

- `README.md:124` opens *"One relationship deliberately breaks the two-broker rule"*. What it actually breaks is database-per-service, not Kafka-vs-NATS; the rest of the sentence is precise, so the framing is loose rather than false.
- `README.md:130` still states *"Every inter-service interaction must be justifiable by one row of this table"* in absolute terms. The exception is now disclosed six lines **above** it, so a reader meets the exception before the rule. Acceptable; the C3 box below is marked accordingly.
- `progress/history.md:1311` says the phase built *"13 trade-offs"*. The D2 fix added a 14th row in the same session. Trivial, in a record the same commit wrote.
- §11.3's *"honest disclosure is not the same as the requirement being met"* remains unnamed in the README (see D7 above).
- `9672cf4` also re-serialised four unrelated `notes` fields in `feature_list.json` from `—` escapes to literal em dashes. Semantically identical, valid JSON, no status touched but 37's. Noted so it is not mistaken later for an undeclared edit.

## `CHECKPOINTS.md` walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all present.
- [x] `progress/current.md` and `progress/history.md` present.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (and suite_runner).
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 (not re-run for a docs-only change; `feature_list.json` parses and every status is valid — checked directly).

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero; one `in_review`, now `done`.
- [x] Every status in `rules.valid_status`: 39 `done`, 1 `in_review` → `done`, 1 `pending`.
- [x] Every `done` feature has passing tests associated with it.
- [x] **`progress/current.md` describes the active session** — closed. Was the standing failure at pass 1; now names feature 37, its true status and the true 39/41 count.
- [x] No `blocked` features.

### C3 — Architecture is respected
- [x] No forbidden imports inside any `domain/` — unchanged by this feature.
- [x] **No cross-service database access** — the Gateway→Mongo read still exists and is still a real exception, but it is R54-sanctioned, read-only (verified against the adapter's actual operations, not its comment), pre-existing, and — the point of D2 — now **documented as what it is** in four consistent places instead of disguised as an RPC hop. The box that was open at pass 1 was open because the documentation lied about it, and that is fixed.
- [x] No shared runtime code beyond `shared-kernel` and `contracts`.
- [x] `packages/shared-kernel` has zero runtime dependencies.
- [x] **Every inter-service interaction classifiable** — the one interaction the matrix has no row for now has a Trade-offs row of its own and a named paragraph above the matrix. The matrix's own "every interaction" sentence stays absolute (F4), which is why this is marked with the note rather than left open.
- [x] No stray debug logging, no context-free TODOs in the changed files (documentation only).

### C4 — Verification is real
- [x] `pnpm quality` green at `9672cf4` (leader claim, not re-run — instructed; the diff touches no file any test loads, which I verified from `git show --stat` rather than assuming).
- [x] Domain tests pure; untouched.
- [x] Integration tests use Testcontainers; untouched.
- [x] Coverage thresholds met; untouched.
- [x] No Jest anywhere.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — `git status --porcelain` empty.
- [x] **`progress/history.md` has an entry for the feature just finished, including its effort record** — closed; timings independently traced to commit timestamps.
- [x] **`feature_list.json` reflects the true state** — 37 traversed `pending → in_review` at `9672cf4` and `→ done` here.
- [x] The human has been told what was done and how to test it (`9672cf4`'s message enumerates all eleven).
- [x] Claude did not commit — `9672cf4` is the human's.

### C6 — Spec-Driven Development
- Not applicable: `documentation_demo` is `sdd: false`. For the record, all 8 `sdd: true` features still carry complete `requirements.md`/`design.md`/`tasks.md` triples — I re-counted, and the set matches `sdd: true` exactly.

### C7 — Trilogy reusability
- [x] `specs/shared/` unchanged by this feature and still stack-agnostic.
- [x] `n8n/workflows/*.json` still Gateway-REST-only.
- [x] **`progress/history.md` effort records are complete** — phase 24's is now present and is one of the more detailed in the file.

## Acceptance criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | Kafka-vs-NATS matrix with this project's own examples | **Met.** All seven rows verified true against source on pass 1 and unchanged; the diagram above it no longer misclassifies a real interaction, and the fact arithmetic is now right. |
| 2 | saga diagram happy + compensation | **Met.** All ten edges re-checked against `saga.md` §3.1/§4.1–4.3 and `saga-steps.ts`; both previously-wrong edges fixed, no third edge broken, and the collapsed two-state transition is explained rather than fudged. |
| 3 | AI process section | **Met.** Every count re-verified; the three worst incidents are now named, and named at least as harshly as their source records. |
| 4 | screenshots and demo recording | **Met.** All 12 images referenced and resolving; the four orphans embedded. |

## Findings open at approval (4)

**F1** (Tech-stack row omits `otc_notifications`, contradicting corrected prose 14 lines below — the one named defect not closed), **F2** ("95 progress records" is 96), **F3** (the architecture diagram's Projector node lost its label when the invented edge was deleted), **F4** (four informational residuals).

F1 and F3 are one line each and worth doing before the phase is written up; neither justifies a second rejection, and neither is a false claim of the kind the first verdict rested on — F1 is a stale omission the same document corrects twice elsewhere, F3 is cosmetic.

## Closing note

The first verdict rejected this feature because a section whose selling point is *"cited so it can be checked"* failed six spot-checks. This pass I ran the same kind of spot-checks again and harder — every citation, every saga edge rather than the two flagged, every count derived rather than compared, the trace id re-resolved against the live API, the honesty bullets diffed against their source records line by line. They hold. The one place the fix pass fell short (F1) and the one place it broke something adjacent (F3) are both visible, both minor, and neither is a claim asserted without a check — which was the actual disease.
