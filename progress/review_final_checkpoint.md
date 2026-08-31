# Review — `final_checkpoint` (id 38, phase 25)

**Verdict: REJECTED.**

**Feature status left at `pending`** (per the reviewing brief's explicit instruction for a rejection; `feature_list.json` was not edited in any way).

**Date:** 2026-08-31. **Reviewed:** the working tree, not `HEAD` — 18 modified and 14 untracked paths, including the README rewrite, the `CHECKPOINTS.md` C7 rewording, the `specs/shared/test-matrix.md` rework, the `R58` closeout across `apps/projector`/`apps/notifications`, and the new `R1` money-representation sweep.

---

## Scope of verification — what I ran, and what I did not

`pnpm quality` was **not** re-run in full: the brief records it green a few minutes before this review (exit 0, 1493 tests) and re-running a suite somebody just ran is duplicated cost rather than verification. What I ran myself, and what it establishes:

| Probe | Result |
|---|---|
| `pnpm --filter @otc/orders exec vitest run src/test-matrix-guard.spec.ts` | **6 passed** — including its own assertion that the matrix holds exactly 63 rows |
| `pnpm --filter @otc/projector exec vitest run` × the 4 new `*-log-trace-id.spec.ts` | **4 files / 9 tests passed** |
| `pnpm --filter @otc/notifications exec vitest run` × the 4 new `*-log-trace-id.spec.ts` | **4 files / 8 tests passed** |
| **Mutation probe A** — `activeTraceId()` in `apps/notifications/.../trace-context.ts` forced to `return undefined` | **all 8 notifications guards failed**, e.g. `AssertionError: expected undefined to be '290b69f81c0df40b628fb6afa57139b7'`, plus the negative-case call-count failure. File restored, diff against my pre-probe copy byte-identical, re-run green |
| `pnpm --filter @otc/gateway exec vitest run --config vitest.integration.config.mts src/money-representation.integration.spec.ts` | **1 passed** (real NATS + real MongoDB Testcontainers, 6.6 s) |
| **Mutation probe B** — `sweepForMoneyFields` forced to `return []` | named case failed with `expected at least one monetary field discovered in POST /orders's response — found none, which would make this sweep vacuous rather than proving R1`. Restored, byte-identical |
| **Mutation probe C** — `unitPrice: 43_490` → `43_490.5` in the seeded read-model document (a field **no assertion enumerates**) | failed with `GET /orders/{id} $.items[0].unitPrice: R1 requires an integer count of minor units, got 43490.5`. Restored, byte-identical |
| `./init.sh` | **exit 0** |
| Hand tally of all 63 Status cells; column-by-column parse of every table row; `progress/history.md` entry parse; `git log` on `progress/current.md`; 7 README source citations opened at their cited lines; all README links, images and `package.json` scripts resolved; live probe of every advertised URL | see findings |

All three mutation probes were restored and verified identical (`diff` against pre-probe copies) before the review continued. The working tree is exactly as I found it.

---

## Findings

Numbered, with severity, each with my own evidence.

### BLOCKING

#### B1 — `specs/shared/` is **not** clean for #8: a `MySQL` leak survives in the reusable part of the matrix (criterion 3, C7)

`specs/shared/test-matrix.md:212`, `R62`, **column 4** — the *stack-neutral* `Test file › case` sketch that the Scope paragraph and the reworded C7 both name as reusable-verbatim — reads:

> `orders/integration/orders-create-idempotent-replay.spec` › *two concurrent first-time orders.create requests carrying the same requestId create exactly one order, and the loser's reply matches the winner's, **over the real NATS wire and real MySQL***

`MySQL` is one of the four technologies C7 names by name. I parsed every table row cell-by-cell and confirmed this one by hand: the row's five fields are id / requirement / `unit + integration` / sketch / Status, and `MySQL` is in field 4, not field 5. Every other `MySQL`/`MongoDB`/`Drizzle`/`Testcontainers`/`apps/**` token in the file is inside a Status cell, which is legitimate. This is the **only** leak — and the file's own Scope paragraph states the remedy: *"Any stack term found outside those three places is a defect, and the fix is to move it into the Status cell it belongs to."*

Why it matters beyond tidiness: `progress/review_traceability_audit.md` §6 asserted that "**Every** C7-forbidden term sits inside a row's Status cell". That statement was already false when written, and the rework was aimed at the places the audit named. #8 inheriting this file would be told, in the shared contract's own voice, to test against MySQL.

**C7's first box cannot be ticked, and acceptance criterion 3 is not met.**

#### B2 — a `done` sdd feature has five unticked tasks, under a heading that says the work was not done (C6)

`specs/observability_reliability/tasks.md:51-57`:

```
### A5. Trace propagation (R57, OR4) — **NOT DONE THIS PASS**

- [ ] A5a. Install and bootstrap `@opentelemetry/sdk-node` ...
- [ ] A5b. NATS: inject `traceparent`/`tracestate` ...
- [ ] A5c. Kafka: populate `outbox.trace_parent` ...
- [ ] A5d. Integration: `apps/orders/src/infrastructure/messaging/trace-context-propagation.integration.spec.ts` ...
- [ ] A5e. **Deletion-arm**: stop injecting `traceparent` on the Kafka publish path ...
```

Feature 27 (`observability_reliability`, `sdd: true`) is `done`. It is the only sdd feature with any unticked task (I checked all eight: 0 unticked everywhere else). And the work **did** land — `apps/orders/src/infrastructure/messaging/trace-context-propagation.integration.spec.ts` exists (11,900 bytes, 26 Aug), and `R57`'s own matrix row rests on it: *"feature 27's A5 pass proved the mechanism for Orders (`apps/orders/src/infrastructure/messaging/trace-context-propagation.integration.spec.ts`, `InMemorySpanExporter` …)"*.

So the SDD ledger for the largest feature in the project asserts, in bold, that the trace-propagation work was not done, while the traceability spine cites that same work as the evidence for a green row. Both cannot be true. C6's third box fails, and this has survived every review since feature 27 closed — including the Phase 25 traceability audit, which read the matrix and not the tasks file.

#### B3 — `progress/current.md` is stale, for the fifth recorded time (C2, C5)

`progress/current.md` still reads:

> **Feature:** `documentation_demo` (id 37, phase 24, `sdd: false`)
> **Status:** `in_review` — REJECTED once … defects being closed.
> 39 of 41 features `done`. Only 37 (`documentation_demo`) and 38 (`final_checkpoint`) remain.

Feature 37 is `done` and APPROVED (`progress/history.md`, "Verdict: APPROVED — second review, 2026-08-31"); 40 features are `done`; the active session is Phase 25. C2's fourth box is explicit — *"describes the active session or holds only the template — never leftovers from a previous session"* — and this is a leftover describing a *closed* feature by the wrong status. `progress/review_documentation_demo.md`'s D10 already recorded this as the **fourth** occurrence. A final checkpoint whose second acceptance criterion is about the `progress/` snapshots cannot close with the snapshot of the current session describing the previous one.

#### B4 — the repository's own status documents are materially false about where the project is

`docs/PROCESS.md` §10, the section the README signposts as carrying "the current status" (`README.md:538`), headed *"Maintained at the end of every phase"*:

- **`docs/PROCESS.md:239`** — *"**Position: Phases 1–23 complete — 39 of 41 features done.** Only Phase 24 … and Phase 25 … remain. … Remaining: 20–22 (n8n, SonarQube, dashboards) and 24–25"*. The paragraph contradicts itself inside one sentence pair, and contradicts its own table six lines below, where phases 20, 21, 22 and 23 all read ✅. Phases 20, 21, 22 and 24 are all complete; 40 of 41 features are `done`.
- **`docs/PROCESS.md:248`** — a **duplicate Phase 8 row** left in the table, marked `next`: `| 8 | Orders service + saga orchestrator — first sdd: true features through the full spec loop | next |`, immediately followed by the real Phase 8 row marked ✅.
- **`docs/PROCESS.md:63` and `:245`** — *"61 EARS requirements"*. There are 63 (`R1`–`R63`; I counted the `**R<n>.**` headings and the ids are contiguous and unique). This is the identical stale-count defect the last review raised as D4 against the README; the README was corrected to 63 and this document was not.
- **`README.md:623`** — the Build progress table still shows `| 24 | Documentation + demo recording | ⬜ |`, although `documentation_demo` is `done` with an APPROVED history entry.
- **`README.md:563`** — *"Implementation and review ran through the agent harness for **39** of the 41 features"*. That number was correct when `documentation_demo` was in review; it is 40 now.
- **`README.md:312`** — *"The application services arrive in later phases; the infrastructure stack runs now"*, and **`:319`** — *"Business operations travel over NATS rather than HTTP **until the Gateway lands**, so use `pnpm order:place` … **in the meantime**"*. Both speak in the future tense about services and a Gateway that shipped in phases 5–13.

Individually these are small. Collectively they are the exact failure mode this repository's last review rejected on — *documentation false in checkable ways* — and they are the first thing a reader (or assessment #8) opens. The README's own honesty section says *"A number is only true if you re-derive it, not compare it"*; four of the six items above are numbers nobody re-derived.

#### B5 — `R58` is counted **green** on a narrowing that is not forced by the absence of a value, and the narrowing is unratified (criterion 1, C6)

The leader asked specifically whether the malformed-envelope exclusion is a legitimate narrowing or a hole. **The malformed-envelope exclusion is legitimate and the precedent claim is true**: `apps/orders/src/presentation/saga-facts.controller.ts:55` carries its own comment — *"a malformed value has no trustworthy `eventId`/`correlationId`"* — and its logger reads `traceId` from the inbound Kafka headers via `extractKafkaTraceContext` before parsing, exactly as the cell describes. No trustworthy `correlationId` exists there, so omitting it is principled, disclosed, and itself under test.

**A different exclusion in the same paragraph is not of that class.** `apps/notifications/src/infrastructure/notification/console-notification-sender.ts:18-26`:

```ts
async send(message: NotificationMessage): Promise<void> {
  this.sent.push(message);
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'notifications: console adapter — would have sent an email',
      to: message.to,
      subject: message.subject,
    }),
  );
}
```

That is a structured JSON record with `level` and `message`, emitted while handling a fact, carrying neither `correlationId` nor `traceId`. The matrix excludes it as *"not a diagnostic log at all but the dev sender's rendered output"*. Three things falsify that rationale:

1. **The file's own header says the opposite** — *"Logs one structured JSON line per message (CLAUDE.md § Logging)"*.
2. **The `correlationId` is on the object it was handed.** `NotificationMessage.correlationId` was added to that port *by this very pass* (`apps/notifications/src/application/ports/notification-sender.port.ts`, doc comment: *"R58 closeout … the fact's own `correlationId`"*) and is populated at `apps/notifications/src/application/notification-dispatch.service.ts:130`. The premise the malformed-envelope exclusion rests on — no trustworthy value exists — simply does not apply here.
3. **This is not only the dev sender.** `apps/notifications/src/app.module.ts:118` binds it as the **production degradation fallback**: `new DegradingNotificationSender(new SmtpNotificationSender(binding.config), new ConsoleNotificationSender())`. On the degraded path this line is the only record that a notification went out, and it is untraceable.

Separately, the cell's fleet-wide sentence — *"every log line that has one now carries it, **on all six services**"* — is falsified by `apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.ts:55`: `console.error('[gateway] nats-stream-signal: failed to decode a signal frame', error)`, not JSON-shaped at all, carrying neither id, named in none of the cell's exclusions. (A signal frame is arguably not one of R58's three categories, so I do not press this as an R58 violation — but it is a `CLAUDE.md` § Logging violation and it makes the "all six services" claim untrue as written.)

Consequence under this document's own rules. The Green class requires *"no stated shortfall against the requirement's own wording"*; the cell itself states one (*"That is a real narrowing of the word every"*) and pre-emptively tells a stricter reader to *"reclassify this row as scoped and ratified"*. But **there is no ratification available**: `progress/spec_traceability_closure.md`'s Round 3 record shows the green flip was the row author's own call, describing the console sender as one of the *"long-standing carve-outs"* — a characterisation I could not corroborate. I grepped the prior R58 record (the superseded `PARTIAL` note kept in the same cell) and `progress/impl_observability_reliability.md`'s carve-out list: they name `main.ts`, `migrate-cli.ts`, `test-support/di-metadata-probe.ts`, `saga-command-sweeper.service.ts`'s claim-cycle log and `order.sagas.ts`'s `resilient()` branch. `console-notification-sender.ts` appears in none of them; the exclusion is new in this pass. Rule 3 is unambiguous about that case: *"A shortfall disclosed only by whoever wrote the row is **not** ratified — that is the author marking their own homework — and such a row blocks this gate exactly as a `TODO` does, however well it reads."*

So the headline **62 green / 1 scoped / 0 not-yet-green** is over-claimed by one row: on the matrix's own definitions it is 61 green / 1 ratified-scoped / 1 unratified-scoped, and the unratified one blocks. The honest resolutions are the same two rule 3 always offers, and the first is roughly fifteen minutes' work: thread `message.correlationId` and `activeTraceId()` through that one `console.log` and guard it like the other eight sites — or put the exclusion to the gate and record the ratification.

Note also that the cell's own enumeration paragraph ("What *every* does and does not mean here") lists the two malformed-envelope logs, boot/CLI lines and the console sender, but omits the two Orders sites the same cell discloses further down (`saga-command-sweeper.service.ts`'s claim-cycle log and `order.sagas.ts`'s `resilient()` branch, the latter squarely inside R58's "while handling … a fact" clause). Both of those are honestly reasoned in code comments I read and verified; the defect is that the row's summary of its own narrowing is not complete.

### NON-BLOCKING

#### N1 — C7's aside exemption does not fit one of the two asides it was written for

The reworded C7 exempts *"any paragraph **explicitly labelled as one assessment's own aside** … acceptable **only** where **the label** makes clear the other two may delete it wholesale."* Checked against both asides:

- `test-matrix.md:62` — *"**#7 mechanism (per-assessment aside — #8 and #9 write their own equivalent and may delete this paragraph outright).**"* — satisfies the clause exactly.
- `test-matrix.md:224` — *"**#7 evidence (flipped after the gate, on the three cited cases and nothing else).**"* — the label says nothing about deletion. The permission exists only in the Scope paragraph 162 lines earlier.

The leader's rewording correctly fixed the *mechanism-vs-evidence* problem it got wrong the first time. This is the remaining half-inch: either add the deletion clause to the §8.1 label, or soften C7 from "the label" to "the label, or the document's Scope paragraph naming it".

#### N2 — the matrix's own reuse recipe is not accurate

Scope says starting #8 from this file is *"three mechanical steps and no judgement"* — reset Status, reset the counts, delete the two labelled asides — and *"Everything else stays byte-for-byte."* It does not. Two paragraphs of #7-specific narrative sit outside all three exemptions and cannot be kept: `:85` (*"The single **scoped** row is `R56`, and it is **ratified** … The other scoped row, `R58`, was **closed rather than ratified**…"*) and `:87` (*"This table previously claimed **47** green … **Round 3** moved them once more…"*). The `R56` amendment notes at `:189-203` likewise reason from #7's own backlog (*"No feature before `saga_e2e_verification` (id 28, phase 15)"*, *"feature 27 is the first to instrument"*). None of these are *stack* leaks, so C7's letter survives — but the recipe is a normative instruction #8 will follow, and it is wrong.

#### N3 — three shared-contract items are recorded as still wanting the human gate's word

`progress/spec_traceability_closure.md`, "Open points after Round 3": **R2-1** (the shared-contract change that added the `composed-stack integration` level to the Test levels table and gave `R56` a second sketch — a change to columns 3 and 4, i.e. the part #8 and #9 inherit) is *"unchanged and still want[s] the gate's word"*; Round 1's open point **6** (eight rows whose citations the mechanical guard cannot anchor on, including bracketed filenames; no assertion that every non-`TODO` row carries a guarded citation) and open point **7** (mixed hard-wrapping) *"remain open and untouched"*. Declaring `specs/shared/` finished for #8 while an unratified change sits in its shared columns is premature.

#### N4 — `test-matrix.md` violates `CLAUDE.md`'s markdown rule, in the file the trilogy inherits

`CLAUDE.md`: *"**No hard line-wraps in prose** — one line per paragraph/list item/quote."* Rules 1, 2, 4 and 5 (`:17-27`), the path-convention paragraph (`:42-45`), the `R56` amendment note (`:189-201`) and the Verification section (`:230-238`) are all hard-wrapped, while rule 3 and the Scope paragraph are not. Disclosed as open point 7 and untouched.

#### N5 — a duplicated sentence with broken emphasis inside `R58`'s Status cell

`test-matrix.md:209` contains, verbatim:

```
… **The record of what WAS proven, for Orders and the Gateway, follows unchanged — R58 closeout pass.****The record of what WAS proven, for Orders and the Gateway, follows unchanged — R58 closeout pass.**
```

The sentence appears twice, back to back, with `.****` between them. Editing residue in the shared spec.

#### N6 — `R1`'s cell describes its evidence as stronger than it is

The cell says *"a black-box sweep over the money-bearing Gateway responses"*. The spec's own header (`apps/gateway/src/money-representation.integration.spec.ts:22-30`) records that *"Orders/Billing are NOT spawned — their RPC responders are TEST-ONLY stubs"* and the read-model document is seeded by the test itself. So it proves the Gateway does not mangle representation on the way out, not that upstream services produce minor units. `R61`'s cell discloses exactly this class of caveat in its own words ("Tested against (review finding F6)…"); `R1`'s does not. **Everything else about `R1` checks out and is stronger than the cell claims**: the sweep is shape-based rather than name-based, and my probe C proved it genuinely general — it caught a decimal at `$.items[0].unitPrice`, a nested-in-an-array field no assertion enumerates. It cannot pass while inspecting nothing (probe B). The row is legitimately green; only its wording is loose.

#### N7 — an observation for the trilogy, not a defect: C6's fifth box is not literally checkable for one feature

`specs/billing_invoicing/{requirements,design,tasks}.md` were all first added in commit `8baa22e`, *the same commit* as the implementation, because the human's discipline is one commit per feature. The prior reviewer noted this and marked the box `[x]` on the working-tree evidence (`progress/review_billing_invoicing.md:203`), which I accept. But "the spec commit **precedes** the implementation commit in git history" is then unverifiable from git for that feature, and #8/#9 inherit the box. Worth either rewording the box or splitting the spec commit going forward.

#### N8 — the README's "What the process produced" section: true, and thin at one point

The human asked for less failure detail, and the section delivers that honestly: three concrete, well-chosen lessons (arm the deletion, re-derive the number, open the citation), each drawn from a real incident, plus a signpost at `docs/PROCESS.md` §11 explicitly named as *"a ledger of what this process actually caught … and roughly thirty more"* — which is what the previous review's D7 asked for. I judge it **true and sufficient**, with one defect: `README.md:572` still reads *"those were green while **the defects below** were live"*, pointing at an enumerated defect list the rewrite removed. The bullets below it are lessons, not defects. One dangling reference, one sentence to fix.

For the record on the thinness: the README no longer names the single worst incident in the repository's own ledger (an implementer that deleted a failing assertion — a faithful transcription of the requirement — and marked the requirement done). Reaching it now costs one click. That is a defensible editorial choice given the brief, and I am not treating it as a defect; I record it so the choice is visible rather than accidental.

---

## What I verified and found sound

Recorded because a rejection that lists only defects misrepresents the state of the work.

**Traceability (criterion 1).** `specs/shared/requirements.md` holds exactly **63** requirements, ids `R1`–`R63`, contiguous and unique. `test-matrix.md` holds exactly 63 rows for the same ids — asserted mechanically by `apps/orders/src/test-matrix-guard.spec.ts` (`expect(rows.length).toBe(63)`), which I ran green. I hand-tallied every Status cell rather than grepping: group totals are 10/8/11/8/8/5/6 green, group 8 is 5 green + 1 scoped, §8.1 is 1 green — **62 / 1 / 0**, matching every sub-total and the Total row exactly. Subject to B5, the arithmetic in that table is correct and the "why the numbers moved" narrative matches the rows.

**`R56` is genuinely ratified.** The cell names the ratifier and the record; `progress/spec_traceability_closure.md:47` confirms it — *"open points 1, 3, 4 and 5, **all four approved at the human gate**"* — with open point 3 being `R56`. Rule 3's two conditions are both met: the cell states which leg is unproven in the requirement's own words (the inbound-request leg, the Projector, no span on fact consumption) **and** what closing each would take, and it names who accepted the deferral and where. This is the correct use of the class.

**No other row is quietly relying on the unratified-scoped class.** I read all 63 cells. The rows carrying disclosed limitations — `R24`, `R28`, `R54`, `R55`, `R61` — each state a limitation of a *particular piece of evidence* while the requirement itself is covered by the combination named in the cell, and each says plainly what its evidence does not do. `R58` is the only row whose own cell concedes it could be reclassified.

**The `R58` guards are real.** Eight new spec files, 17 tests across the two services, all green. Mutation probe A — a single-line change to `activeTraceId()` — turned **all eight** notifications tests red with real trace-id equality failures, not field-presence failures, and the negative "no key, never the string `undefined`" cases failed too. These are armed guards, not ceremony.

**`R1`'s API half is genuinely general and non-vacuous** — probes B and C above.

**`progress/` (criterion 2).** The 41-vs-40 discrepancy is resolved: `progress/history.md` line 11 is the **template placeholder** heading, `## <feature_name> (id <n>, phase <n>) — <date>`, kept at the top of the file. There are **40** real entries, mapping one-to-one onto the 40 `done` features (ids 1–28, 40, 41, 42, then 29, 30, 36, 31, 32, 34, 35, 33, 37), and **every one carries an effort record** — I parsed for the `Effort` marker per entry; zero missing. Not an extra entry, not a duplicate, not a miscount. Snapshots are genuinely versioned across different states: `progress/current.md` has **23 commits and 23 distinct contents** (md5 of every historical blob), so the criterion "versioned in different states" is met by the history even though the current content is stale (B3).

**Architecture (C3).** Zero forbidden imports under any `domain/` folder (grepped `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats`, `mongodb` across `apps/*/src/domain` and `packages/*/src/domain`). `packages/shared-kernel` declares no `dependencies` and no `peerDependencies`. The only cross-workspace imports are `@otc/shared-kernel` and `@otc/contracts`, plus `apps/seed`'s direct reads of the three services' persistence schemas — a one-off CLI, not a service, ratified at feature 12's review. No context-free TODOs. No Jest anywhere.

**README.** All **12** referenced images exist; all **33** relative links resolve; all **15** referenced `pnpm` scripts exist in `package.json`; no Mermaid remains and **both diagrams are ASCII**; no machine-specific paths; the topology is accurate — there is **no** Gateway→Projector RPC edge, the Gateway's direct read-only MongoDB query is drawn and named as the one deliberate boundary break, and the corrected `credit.approved.v1` two-state hop and `credit.released.v1` closing edge are both explained in prose. **All 7 source citations open at their cited lines** (`outbox-relay.ts#L128` / `#L159`, billing and fulfillment `#L104`, `drizzle-saga-command-store.ts#L100`, `order-number-allocator.ts#L84`, `nats-stream-signal.adapter.ts#L33-L34`) — 7/7 correct, so D5's class is not repeated. `R<n>` numbers survive only at `:411` and `:588`, both describing `specs/shared/requirements.md` itself rather than making a claim; I do not read those as violations. F1 (the `otc_notifications` omission), F2 (the self-referential progress count) and F3 (the unlabelled `proj` node) from the previous review are all closed.

**Quick Start works as written.** `.env.example` carries `WEB_PORT=3000`, so `cp .env.example .env` → `http://localhost:3000` is correct for a fresh clone; this machine's `.env` overrides it to 3010 and the app answers there (302 to login). Every other advertised URL answered live: Gateway `/docs` 301, Mailpit 200, Redpanda Console 200, Jaeger 200, Grafana 302, n8n 200, Prometheus 302. The "19 containers" and "12 containers" counts both match `docker ps`; "all 10 workspaces" matches `apps/* + packages/*`. The only Quick Start claim I did not verify is *"a cold start reaches a demoable, seeded state in 35–42 seconds"* — verifying it means destroying the live stack, which I judged a worse trade than leaving one timing claim unchecked.

**n8n (C7 box 2).** All four workflows use only `$env.OTC_GATEWAY_URL || 'http://gateway:3001'`; node types are `code`, `scheduleTrigger` and `webhook` only; zero occurrences of `mysql`, `mongo`, `kafka`, `nats`, `jdbc`, `3306`, `27017`, `9092` or `4222`. They port to #8 and #9 with a base-URL change, exactly as claimed.

---

## `CHECKPOINTS.md` C1–C7 walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist — confirmed by `./init.sh`.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (plus `suite_runner`).
- [x] Every agent definition declares its model — 3 pinned (`implementer: sonnet`, `suite_runner: haiku`, `test_maintainer: haiku`), 3 documented as deliberately inheriting the session model.
- [x] `./init.sh` exits 0 — run by me.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — on the matrix's row-level evidence plus the gate's green run; not re-derived in full by me.
- [ ] **`progress/current.md` describes the active session** — **FAILS (B3)**: it describes feature 37 as `in_review`/REJECTED and "39 of 41 done".
- [x] Every `blocked` feature records why — none blocked.

### C3 — Architecture is respected
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` — grepped clean, and enforced by the ESLint rule that `pnpm lint` runs.
- [x] No cross-service database access — the `apps/seed` CLI is the one documented, previously ratified exception; the Gateway's read-only MongoDB query is a read model, named in the README and the trade-off table.
- [x] No shared runtime code beyond `packages/shared-kernel` and `packages/contracts`.
- [x] `packages/shared-kernel` has zero runtime dependencies.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — the one documented exception is not messaging.
- [x] No stray debug logging, no context-free TODOs — every log call site I read carries a purpose comment. (`nats-stream-signal.adapter.ts:55` is deliberate log-and-continue, commented; its missing ids are recorded under B5, not here.)

### C4 — Verification is real
- [x] `pnpm quality` passes — **not re-run by me**; taken from the gate's run (exit 0, 1493 tests) and corroborated by the seven targeted suites I did run, all green.
- [x] Domain tests are pure.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS / MongoDB — I ran one (`money-representation.integration.spec.ts`) against real NATS + real MongoDB.
- [x] Coverage thresholds met — enforced per-workspace in `vitest.config.mts` `coverage.thresholds`, which `test:coverage` runs; green at the gate.
- [x] No Jest anywhere — grepped clean.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the 14 untracked paths are 8 new guard specs, the `R1` sweep and its helper, and 4 `progress/` records.
- [ ] **`progress/history.md` has an entry for the feature just finished, including its effort record** — feature 38 has none, and cannot until it closes. Recorded here so that any future approval is conditioned on it: `rules.require_effort_record_to_close` is `true`, and the brief's "change only the status field" instruction would have closed feature 38 without one. (All **40** already-`done` features do have entries with effort records.)
- [x] `feature_list.json` reflects the true state of every feature touched — 40 `done`, 38 `pending`; untouched by me.
- [ ] The human has been told what was done and how to test it manually — not established at review time; it is the leader's report after this verdict.
- [x] Claude did not commit — `HEAD` is `1a998a9`, authored by the human; the working tree is uncommitted, and I ran no `git commit`/`git push`.

### C6 — Spec-Driven Development
- [x] Every `sdd: true` feature past `pending` has `specs/<name>/` with all three documents — 8 of 8, confirmed by `./init.sh` and by listing each directory.
- [x] `requirements.md` uses strict EARS notation, every requirement carrying an `R<n>` id — 63 ids, contiguous and unique.
- [ ] **Every `done` sdd feature has all its tasks ticked** — **FAILS (B2)**: `specs/observability_reliability/tasks.md` has 5 unticked under a "NOT DONE THIS PASS" heading, for work that shipped.
- [x] Every `R<n>` is covered by at least one concrete named test recorded in the matrix — all 63 rows name a file and a case; the mechanical guard confirms every anchorable citation resolves. (The *classification* of `R58`'s row is B5; its named tests exist and are green.)
- [x] The spec commit precedes the implementation commit — verified for `fulfillment_stock` (`792176e` → `8a35d4e`) and inherited from prior reviews elsewhere; see N7 for the one feature where the two collapse into a single commit.

### C7 — Trilogy reusability
- [ ] **The reusable part of `specs/shared/` contains no stack specifics** — **FAILS (B1)**: `MySQL` in `R62`'s column 4 (`test-matrix.md:212`). See also N1 (the §8.1 aside's label does not satisfy C7's own "may delete it wholesale" clause) and N2.
- [x] `n8n/workflows/*.json` reference only the Gateway REST API — verified token by token.
- [x] `progress/history.md` effort records are complete and honest — 40 entries, 40 effort records, several with timing brackets independently cross-checked against `git log` by previous reviewers.

**Applicable boxes empty: 5** (C2×1, C5×2, C6×1, C7×1). Under this file's own rule the close is refused.

---

## Can this repository honestly be called finished?

**Not yet — but it is close, and the gap is in the bookkeeping rather than in the system.**

The software is finished in every sense that matters. Six services, two brokers used correctly, an orchestrated saga with both compensation paths proven against real infrastructure, a read model with causally-ordered timelines, a black-box API suite driving a real spawned fleet, browser end-to-end tests, real observability, and a traceability spine that maps 63 EARS requirements onto named, existing, green tests — with a mechanical guard that fails when a citation drifts, and armed-deletion probes behind the claims. I probed the two most recently-moved rows independently and both hold up: `R1`'s sweep is genuinely general and cannot pass vacuously, and `R58`'s nine-site closeout is guarded one deletion at a time by tests that all go red on a single-line mutation. The one deferral in the matrix is correctly classified, correctly ratified, and correctly says what closing it would cost. That is a better state than most projects that call themselves finished ever reach.

What it cannot yet claim is the *specific* set of things this feature exists to certify.

Criterion 3 is false: `specs/shared/` is not clean for #8, by one word in one reusable cell (B1). Criterion 1 is over-claimed by one row: `R58` is counted green while carrying a self-authored exclusion that the row's own rules classify as unratified-scoped, and unratified-scoped blocks (B5). Criterion 2 is met by the versioned history, but the snapshot describing the current session describes the previous one instead (B3). And a reader arriving at the two documents that state where the project stands is told that four completed phases are outstanding and that the specification has 61 requirements (B4).

Every one of those is small. That is precisely why they matter here: this repository's whole argument is that a disciplined process catches claims that are *nearly* true, and the four blocking findings are all claims that are nearly true. The last review rejected on six documentation claims being false in checkable ways and the fix pass introduced three new defects in text it had just touched; the lesson recorded then — *re-read the neighbourhood of every edit* — applies to the `R58` closeout paragraph and to the status sections nobody re-read. A final checkpoint that waved these through would be the harness failing at the one gate that exists to prevent exactly this.

The remediation is small and mechanical, and I would expect it to take well under an hour: move `real MySQL` out of `R62`'s sketch into its Status cell; thread `message.correlationId` + `activeTraceId()` through `console-notification-sender.ts` and guard it like the other eight sites (or take the exclusion to the gate and record the ratification); tick `specs/observability_reliability/tasks.md`'s A5 block and fix its heading; reset `progress/current.md`; and correct `docs/PROCESS.md` §10 and its two "61 EARS requirements", the duplicate Phase 8 row, and the README's Phase 24 row, "39 of the 41", the two future-tense paragraphs and the dangling "the defects below". Then this repository can say it is finished, and every word of that claim will be checkable — which is the only version of the claim worth making.

## What must change before re-review

1. **B1** — remove `real MySQL` from `test-matrix.md:212`'s column 4 (move it into `R62`'s Status cell, per the file's own rule). Then re-verify that no stack term remains outside Status cells and the two labelled asides.
2. **B2** — tick A5a–A5e in `specs/observability_reliability/tasks.md` and correct the "**NOT DONE THIS PASS**" heading, after confirming each task's artefact exists.
3. **B3** — reset `progress/current.md` to describe the Phase 25 session, or to its own template.
4. **B4** — correct `docs/PROCESS.md` §10 (position, remaining phases, the duplicate Phase 8 row) and its two "61 EARS requirements"; correct `README.md:623` (Phase 24), `:563` ("39 of the 41"), `:312` and `:319` (future tense), and `:572` (the dangling "the defects below").
5. **B5** — either close the `console-notification-sender.ts` gap in code with an armed guard, or put the exclusion to the human gate and record the ratification in the cell per rule 3(b); either way, correct the "on all six services" sentence for `nats-stream-signal.adapter.ts:55`, and complete the cell's own enumeration of its exclusions.
6. **N1** — add the deletion clause to the `#7 evidence` aside's label at `test-matrix.md:224`, or soften C7's "the label" wording.

Non-blocking, recommended in the same pass: **N2** (correct the reuse recipe), **N3** (take R2-1 to the gate, or record it as knowingly deferred), **N5** (delete the duplicated sentence at `:209`), **N6** (add `R1`'s stub caveat to its cell, in `R61`'s style).

**Feature 38 remains `pending`.**

---

# Second review — `final_checkpoint` (id 38, phase 25), 2026-08-31

**Verdict: REJECTED.**

**Feature status left at `pending`** (per this pass's explicit instruction for a rejection; `feature_list.json` was not edited in any way).

**Reviewed:** the working tree, uncommitted — 24 modified and 20 untracked paths at the time of review. Nothing was staged, committed or pushed by me. Two source files were mutated as probes and restored byte-identical (md5 re-checked, evidence below).

**Four of the six findings are genuinely closed, verified first-hand and not on report. One is not, and one cannot be until the feature closes.** Both remaining items are blocking, and each is independently sufficient to refuse the close.

---

## Scope of verification — what I ran, and what I did not

`pnpm quality` was **not** re-run in full: the brief records it green minutes before this review (exit 0, 1500 tests). What I ran and probed myself:

| Probe | Result |
|---|---|
| Structural re-parse of `specs/shared/test-matrix.md` — every `\| **R<n>**` line split on `\|`, columns 1–4 isolated | **63 rows, every one exactly 5 fields**, ids `R1`–`R63` contiguous and unique, zero misaligned cells |
| ~50-term stack scan of **columns 1–4 only**, plus every non-table line | **4 raw hits, zero leaks**: two are the substring `.net` inside *monetary*; two are `NATS`/`Kafka` in `R57`'s sketch. **`MySQL`: zero hits in columns 1–4.** B1's literal defect is gone |
| Independent re-derivation of the coverage tally from the Status cells | **62 green / 1 scoped (`R56`) / 0 not-yet-green** — group totals 10/8/11/8/8/5/6/(5+1)/1, sum 63. Matches the published Total row exactly |
| `pnpm --filter @otc/orders exec vitest run src/test-matrix-guard.spec.ts` | **6 passed** |
| Hand recount of `@MessagePattern` decorators in `apps/fulfillment` + `apps/billing` | **12** real (5+1, 3+3), **12** wrapped in `otelContext.with(extractNatsTraceContext(...))` — `R57`'s corrected cell is accurate |
| **Mutation probe D** — deleted the `correlationId` spread from `console-notification-sender.ts` | the **degraded-path** case failed: `AssertionError: expected undefined to be 'order-1'`. Restored |
| **Mutation probe E** — deleted the `traceId` spread from the same file | the **degraded-path** case failed: `AssertionError: expected undefined to be '2e4e4563dbafc5d705bb47e012a0dc97'` (real span equality, not field presence). Restored; md5 `7cd0a09eca1eb3b186ce48ac4d146c8e` identical to pre-probe |
| **Mutation probe F** — deleted the `correlationId` spread from `nats-stream-signal.adapter.ts` | named case failed: `AssertionError: expected undefined to be 'order-42'`. Restored; md5 `ea19225cc50b31536980fdede1d1367e` identical; both gateway spec files re-run green **7/7** |
| `pnpm --filter @otc/notifications exec vitest run` | **28 files / 117 tests passed** |
| `pnpm --filter @otc/projector exec vitest run` | **19 files / 172 tests passed** |
| `pnpm --filter @otc/gateway exec vitest run` | **32 files / 139 tests passed** |
| `eslint` on both touched source files and their specs | clean |
| `./init.sh` | **exit 0** — 41 features, 40 done, 0 `in_progress`, 8 sdd triple-docs present |
| Re-derived from source: features, statuses, phases, EARS ids, sdd count, history entries | 41 / 40 done / 1 pending (id 38, phase 25) / phases 1–24 all-done / **63** `R<n>` / 8 sdd / 40 real history entries |

---

## The six findings, one at a time

### B1 — `MySQL` in `R62`'s column 4 — **CLOSED**

My own pass, not the closure record's. Splitting every row on the pipe and scanning columns 1–4 in isolation: **zero** occurrences of `MySQL`, `MongoDB`, `Drizzle`, `Testcontainers`, `Vitest`, `NestJS`, `apps/`, `packages/` or `.spec.ts`. The clause now lives in `R62`'s Status cell, quoted verbatim with a sentence recording why it moved — no evidence lost.

Two judgement calls I checked rather than inherited:

- **`NATS`/`Kafka` in `R57`'s sketch (`:208`, column 4) is not a leak.** I verified the justification against the sibling documents rather than accepting it: `specs/shared/requirements.md:41-42` defines *fact stream* as "(Kafka)" and *RPC transport* as "(NATS core)" in its own glossary, echoed by `saga.md:29`, `domain-model.md:15-16` and `asyncapi.yaml:19`. A technology the shared contract mandates for all three assessments is not "particular to one assessment", which is what C7 forbids. `MySQL` and `MongoDB` appear nowhere in `specs/shared/` outside Status cells and the two asides — which is exactly why `R62`'s clause had to move and this one does not.
- **Both per-assessment asides now carry the deletion clause** (this is **N1**, closed): `:62` — *"per-assessment aside — #8 and #9 write their own equivalent and **may delete this paragraph outright**"*; `:224` — *"per-assessment aside — #8 and #9 record their own evidence for this row and **may delete this paragraph outright**; flipped after the gate…"*. C7's exemption now fits both on the strength of the label alone, with no dependence on the Scope paragraph. These are the only two normative-prose hits in the whole file.

**The four re-edited sketches, checked against the tests they describe — all four accurate.**

- **`R16`**'s reworded second sketch (*"a fact that fails for a reason the envelope guard cannot catch — a malformed `correlationId` — is retried, dead-lettered, and the consumer offset commits so the next, distinct fact on the same partition still processes"*) matches `apps/orders/src/saga-dead-letter.integration.spec.ts:139` case for case; the Phase-12 provenance is now in the Status cell.
- **`R54`**'s sketch ends at *"…proving no write-model read and no cross-context join"*; the F6 note opens its Status cell and still says plainly that the operational sketch was never built and that the verdict rests on the structural proof. Nothing was softened in the move.
- **`R59`**: `OTel` removed from the sketch, instrument names retained (the requirement's "documented names" clause binds them), the library recorded in the Status cell. Correct trade.
- **`R57`**: count corrected to **12** with a per-file breakdown. I recounted decorator by decorator — 12 real decorators, 12 wrapped. The cell is now true and the breakdown makes it checkable without recounting.

C7's first box can now be ticked.

### B2 — `specs/observability_reliability/tasks.md` A5a–A5e — **CLOSED**

`grep -c "^- \[ \]" specs/*/tasks.md` → **zero unticked tasks across all eight sdd features**. I opened the two artefacts the brief singled out rather than accepting the ticks:

- **A5d** — `apps/orders/src/infrastructure/messaging/trace-context-propagation.integration.spec.ts` exists and holds exactly the three cases claimed (NATS-RPC continuation at `:85`, traced-write → outbox → relay → consumed-headers at `:122`, negative no-active-span at `:199`), against a real `InMemorySpanExporter` (4 references) under Testcontainers. The two sibling files in `apps/fulfillment` and `apps/billing` exist.
- **A5e** — the cited deletion-arm names `trace-context-propagation.integration.spec.ts:181` failing with `expected undefined to be defined`. I opened that line: it is `expect(extractedSpanContext).toBeDefined();`, inside the Kafka-continuation case, immediately before the same-trace-id assertion. The recorded failure is the one that line would actually produce.

The heading now names the pass that closed it instead of asserting the work was not done.

### B3 — `progress/current.md` — **CLOSED**

Now reads `final_checkpoint` (id 38, phase 25, `sdd: false`), `in_review`, session started 2026-08-31, *"40 of 41 features `done`. Only 38 (`final_checkpoint`) remains."* — all four re-derived by me from `feature_list.json` and correct. It describes the active session, with this session's decisions and its own honest note about the half-checked sentence. C2's fourth box passes.

### B4 — the status documents — **NOT CLOSED. Blocking.**

The numbers were fixed. **The sentence beside them was not** — which is the identical failure shape as the original B5 (checking half of a sentence and passing it).

`docs/PROCESS.md:239`, the *"Where the project is right now"* paragraph the README signposts as the current status, headed *"Maintained at the end of every phase"*, now reads:

> **Position: Phases 1–24 complete — 40 of 41 features done.** Only Phase 25 (final checkpoint) remains. … **Remaining: 20–22 (n8n, SonarQube, dashboards) and 24–25 (documentation, final checkpoint).**

The first sentence is now correct. The last sentence of the **same paragraph** is still false and still contradicts it: phases 20, 21, 22 and 24 are complete — their features are `done` in `feature_list.json` (I re-derived: every phase 1–24 has all its features `done`), and the table **six lines below** marks all four ✅. This is not a new defect; it is the *unchanged second half* of the exact sentence pair the first review quoted, in the document whose entire purpose is to state where the project is. The original finding said explicitly *"The paragraph contradicts itself inside one sentence pair, and contradicts its own table six lines below"* — the pair still contradicts itself and still contradicts the table.

Re-derived and **confirmed closed** in the same document and in the README:

- `docs/PROCESS.md` phase table — rows 1–25, **each exactly once**; the duplicate Phase 8 row is gone.
- *"61 EARS requirements"* — **zero** occurrences anywhere in `docs/` or `README.md`; both sites now read **63**, which is the true count (`grep -cE "^\*\*R[0-9]+\.\*\*" specs/shared/requirements.md` → 63, ids contiguous and unique).
- `README.md:623` — Phase 24 row now ✅ with its deliverables named.
- `README.md:563` — now *"40 of the 41 features"*, matching `feature_list.json`. *"8 large enough to earn the triple-doc ceremony"* also re-derived: 8 `sdd: true`, 8 spec directories.
- `README.md:312`/`:319` — both rewritten; no future tense about services or a Gateway that shipped in phases 5–13.
- `README.md:572` — the dangling *"the defects below"* is gone; the sentence now introduces the three lessons that actually follow.

Five of the six B4 items are closed. The sixth is one clause, and it is the one the finding was actually about.

### B5 — the console notification sender and the gateway signal adapter — **CLOSED, and closed in the stronger of the two ways rule 3 allows**

Verified in code and by my own arming, not from `progress/impl_r58_console_sender.md`:

- **The line carries both ids.** `console-notification-sender.ts:30-40` reads `message.correlationId` (already on the port, populated at `notification-dispatch.service.ts`) and `activeTraceId()`, each spread conditionally so a missing value omits the key rather than writing the literal `"undefined"`.
- **The guard exercises the degraded fallback path, not a direct call.** `console-notification-sender-log-trace-id.spec.ts:90-138` composes `new DegradingNotificationSender(inner, new ConsoleNotificationSender())` — byte-for-byte the composition `apps/notifications/src/app.module.ts:118` builds in production — with the inner sender rejecting on the quota-exhausted shape that classifies **permanent**, so the fallback branch is the one taken. It asserts the degradation warning fired, `fallback.callCount === 1`, and that the fallback's own line carries the real `correlationId` and the exporter-observed `traceId`. **My probes D and E each turned *that* case red**, with real-value equality failures, not field-presence failures.
- **The `R58` cell no longer characterises this as a long-standing carve-out.** The single surviving occurrence of that phrase is the cell's own retraction: it states that the exclusion was new in the pass that wrote it, that the file's header calls it a structured log, that `app.module.ts` binds it as the production degradation fallback, and that *"both halves of that were wrong"*. That is the correction the finding asked for, in the row's own voice.
- **The gateway mechanism is real, not asserted.** `nats-stream-signal.adapter.ts:76-89` reads `message.headers?.get('x-correlation-id')` and never re-touches `message.data`. I verified the other end rather than the claim: `apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts:50-51` builds `natsHeaders()`, sets `x-correlation-id`, and passes it as `{ headers: h }` on **both** publishes — set before and independently of the JSON body, so it genuinely survives a body decode failure. The guard uses the **real** `headers()` from the `nats` package with a genuinely malformed payload (`'not json'`), and probe F proved the read is load-bearing.
- The cell's fleet-wide *"all six services"* sentence now states plainly that it was untrue when first written and names the line that falsified it, recording the fix as supporting evidence rather than as an R58 site. Its enumeration of narrowings now also names the two Orders sites (`saga-command-sweeper.service.ts`, `order.sagas.ts`'s `resilient()` branch). The invitation to reclassify by prose is gone.

`R58` is green on evidence. My independent tally confirms the headline **62 / 1 / 0**, and the one scoped row is `R56`, ratified.

### N1 — the `#7 evidence` aside's deletion clause — **CLOSED** (see B1 above).

---

## What the fix pass broke

One regression found, non-blocking, plus the B4 residue already recorded above.

#### S3 — `specs/observability_reliability/tasks.md:56` now asserts something false about `test-matrix.md` (non-blocking)

A5b's tick records: *"…slightly stronger than `specs/shared/test-matrix.md`'s `R57` cell states, which says "all **11** real `@MessagePattern` decorators"; … that cell's number is one short and is recorded as an open point … **rather than edited here**."* Round 5 then edited that cell to **12**. So a `done` feature's task ledger now quotes a sentence that no longer exists and defers a fix that has already been made. Round 4 wrote it correctly for its moment; Round 5 changed the neighbourhood and did not re-read it — the same lesson the last review recorded. One clause to delete or reword.

**Checked and found clean:** the four re-edited sketches all still describe their real tests accurately (evidence under B1); the README reads coherently after its edits — Quick Start, the ASCII topology, the process section and the Build progress table are internally consistent, and I found **no count anywhere contradicting another** (41 features, 40 done, 8 sdd, 63 requirements, 63 matrix rows, 62/1/0, phases 1–24 ✅ — every one re-derived from source and agreeing across `README.md`, `docs/PROCESS.md`, `feature_list.json`, `specs/shared/requirements.md` and `test-matrix.md`, with the single exception of `PROCESS.md:239`'s *Remaining* clause); the coverage table's group sub-totals sum to its own Total; `n8n/` and `.claude/` are untouched by this pass; the three services' full suites are green (428 tests across notifications, projector and gateway); domain purity re-grepped clean; `packages/shared-kernel` still declares no runtime dependencies; no Jest.

---

## The second blocking item

#### S2 — feature 38 still has no entry in `progress/history.md`, and therefore no effort record (C5, C7)

`progress/history.md` holds **41** `##` headings: the template placeholder plus **40** real entries, one per `done` feature, every one carrying an effort record. There is none for `final_checkpoint`. `feature_list.json`'s `rules.require_effort_record_to_close` is `true`; `CHECKPOINTS.md` C5 requires *"an entry for the feature just finished, including its effort record"*; and the reviewer's own charter forbids approving a feature without one. The first review recorded this explicitly as a condition of any future approval, precisely because a status-field-only close would skip it.

This is mechanical, not a judgement: the entry (sessions and wall-clock for phase 25, including the two rejection cycles) must exist before the box can be ticked. It is the assessment #7 baseline the trilogy is measured against, so it is the one record that cannot be filled in retrospectively without losing its value.

---

## `CHECKPOINTS.md` C1–C7 walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist — confirmed by `./init.sh`.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (plus `suite_runner`) — untouched this pass (`git status .claude` empty).
- [x] Every agent definition declares its model — 3 pinned, 3 documented as inheriting.
- [x] `./init.sh` exits 0 — run by me.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero, confirmed by `init.sh` and by parsing `feature_list.json`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — matrix row-level evidence plus 428 tests I ran across three services and the matrix guard; the full suite is the gate's run, not re-derived by me.
- [x] **`progress/current.md` describes the active session** — **now passes (B3 closed)**.
- [x] Every `blocked` feature records why — none blocked.

### C3 — Architecture is respected
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` — re-grepped clean after this pass's edits.
- [x] No cross-service database access — `apps/seed` remains the one documented, ratified exception; the Gateway's read-only MongoDB query is the named read model.
- [x] No shared runtime code beyond `packages/shared-kernel` and `packages/contracts`.
- [x] `packages/shared-kernel` has zero runtime dependencies — re-derived from its `package.json`.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — the read-model signal remains a NATS publish carrying its own `x-correlation-id` header, now read at the Gateway end.
- [x] No stray debug logging, no context-free TODOs — the two lines this pass touched are the opposite of stray: both are now structured, id-carrying and guarded.

### C4 — Verification is real
- [x] `pnpm quality` passes — **not re-run by me**; taken from the gate's run (exit 0, 1500 tests) and corroborated by four suites and one lint run of my own, all green.
- [x] Domain tests are pure.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS / MongoDB — not re-run this pass; established by the first review's live run of `money-representation.integration.spec.ts` against real NATS + MongoDB, and by opening `trace-context-propagation.integration.spec.ts` under B2.
- [x] Coverage thresholds met — enforced per-workspace, green at the gate.
- [x] No Jest anywhere — re-grepped clean.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the 20 untracked paths are guard specs, the `R1` sweep and its helper, and `progress/` records.
- [ ] **`progress/history.md` has an entry for the feature just finished, including its effort record** — **FAILS (S2)**: 40 entries for 40 `done` features, none for feature 38.
- [x] `feature_list.json` reflects the true state of every feature touched — 40 `done`, 38 `pending`; untouched by me.
- [ ] The human has been told what was done and how to test it manually — not establishable at review time; the leader's report follows this verdict.
- [x] Claude did not commit — the working tree is uncommitted and I ran no `git commit`/`git push`. My three mutation probes were restored and md5-verified identical.

### C6 — Spec-Driven Development
- [x] Every `sdd: true` feature past `pending` has `specs/<name>/` with all three documents — 8 of 8, confirmed by `init.sh`.
- [x] `requirements.md` uses strict EARS notation with an `R<n>` id each — 63, contiguous and unique.
- [x] **Every `done` sdd feature has all its tasks ticked** — **now passes (B2 closed)**: zero unticked across all eight.
- [x] Every `R<n>` is covered by at least one concrete named test recorded in the matrix — 63 rows, every one naming a file and a case; the mechanical guard resolves every anchorable citation (6 passed).
- [x] The spec commit precedes the implementation commit — inherited from prior reviews; see N7 above for the one feature where the two collapse into a single commit.

### C7 — Trilogy reusability
- [x] **The reusable part of `specs/shared/` contains no stack specifics** — **now passes (B1 + N1 closed)**, on my own column-isolated parse: zero stack terms in columns 1–4 or normative prose; both asides carry the deletion clause C7 requires.
- [x] `n8n/workflows/*.json` reference only the Gateway REST API — verified token by token last review; untouched since.
- [x] `progress/history.md` effort records are complete and honest — for the 40 `done` features. Feature 38's own is the missing one, counted under C5.

**Applicable boxes empty: 2** (C5 ×2). Under this file's own rule the close is refused.

---

## Can this repository honestly be called finished?

**The system can. The claim cannot — yet — by one clause and one missing record.**

Everything the first review said about the software stands, and this pass strengthened it. The traceability spine is now genuinely clean for #8: I isolated columns 1–4 of all 63 rows and found no technology particular to this assessment, both per-assessment asides are labelled as deletable, and the four sketches edited along the way still describe their real tests case for case. The one row I could not corroborate last time is closed the right way — in code, on the production degradation path, guarded by a test that goes red on either half of the fix, which I proved myself twice rather than reading. The gateway's decode-failure line now carries a real `correlationId` sourced from a channel that genuinely survives the failure it logs, and I checked the publisher at the other end rather than the sentence describing it. The largest feature's task ledger no longer says its own shipped work was not done. `62 green / 1 scoped / 0 not-yet-green` is now a number I derived independently from the rows and believe.

What is left is small, and that is exactly why it blocks. `docs/PROCESS.md:239` — the paragraph a reader opens to learn where the project is — still ends by listing four completed phases as remaining, in the same breath as a corrected sentence saying they are complete. The first review named that self-contradiction as the defect; the fix re-derived the number and left the contradiction standing beside it. A final checkpoint whose whole argument is *"a number is only true if you re-derive it"* — the README says so in its own voice — cannot close over a status paragraph that disagrees with itself and with the table six lines below it. And feature 38 cannot be marked `done` while the ledger that is the trilogy's effort baseline has no entry for it; the rule is `true` in `feature_list.json`, C5 states it, and the last review flagged it in advance precisely so it would not be skipped by a status-field-only close.

Both are minutes of work. Neither requires re-touching code, specs or tests, and nothing found in this pass casts doubt on anything else. On re-review I expect to approve.

## What must change before re-review

1. **B4 (residue)** — delete or correct the final clause of `docs/PROCESS.md:239`: *"Remaining: 20–22 (n8n, SonarQube, dashboards) and 24–25 (documentation, final checkpoint)."* It should say only Phase 25 remains, agreeing with the paragraph's own first sentence and with the table below it. Re-read the whole paragraph, not the clause.
2. **S2** — write the `final_checkpoint` entry in `progress/history.md`, **including its effort record** (sessions and wall-clock for phase 25, both rejection cycles included). Without it the close is refused by rule, not by judgement.

Recommended in the same pass, non-blocking: **S3** (`specs/observability_reliability/tasks.md:56` quotes an `R57` sentence that Round 5 replaced), and the items carried from the first review that remain open — **N2** is closed, **N5** and **N6** are closed; **N3** (R2-1 still wants the gate's word), **N4** / open point 7 (hard-wrapping in `test-matrix.md`), Round 1 open point 6 (citations the guard cannot anchor on) and **N7** are unchanged and were not required.

**Feature 38 remains `pending`.**

---

# Third review — `final_checkpoint` (id 38, phase 25), 2026-08-31

**Verdict: APPROVED.**

**Feature 38 set to `done` in `feature_list.json`** — that single field, nothing else.

**Reviewed:** the working tree, uncommitted — 43 paths, of which `docs/PROCESS.md` and `progress/history.md` are the two that changed since the second review. Nothing staged, committed or pushed. No file patched by me; the two source files I mutated as probes on the second pass are still byte-identical to their restored state (md5 `7cd0a09eca1eb3b186ce48ac4d146c8e` and `ea19225cc50b31536980fdede1d1367e`, both re-checked this pass).

---

## The two blocking items

### Item 1 — `docs/PROCESS.md:239`'s position paragraph — **CLOSED**

Verified against the table myself rather than against the account, because a half-fix is what the second review caught.

The paragraph now closes: *"Phases 20–22 (n8n workflows, SonarQube gates, observability dashboards), 23 (full Docker Compose) and 24 (documentation + demo) have since closed; only Phase 25's final checkpoint remains."* Its opening sentence reads *"Phases 1–24 complete — 40 of 41 features done. Only Phase 25 (final checkpoint) remains."* **The two agree**, and both agree with what I re-derived from `feature_list.json`: every feature in phases 1–24 is `done`, and the only non-`done` feature is 38 in phase 25.

Checked against the table six lines below, row by row: `20 ✅`, `21 ✅`, `22 ✅`, `23 ✅`, `24 ✅`, `25 in review`. **Paragraph and table now say the same thing.** Table rows are 1–25 with **zero duplicates** (the Phase 8 duplicate remains gone). `grep` for the old *"Remaining: 20–22"* clause → **0**; for *"61 EARS"* across `docs/` and `README.md` → **0** (both sites read 63, which is the true count).

The whole diff of this document against `HEAD` is four hunks and nothing else: the position paragraph, `61 → 63`, the removed duplicate Phase 8 row, and the `24–25 | pending` row split into a real Phase 24 ✅ row and a Phase 25 `in review` row. Nothing else in the file moved, so there is no neighbourhood left unread.

### Item 2 — the `final_checkpoint` entry and its effort record — **CLOSED**

The entry exists at the end of `progress/history.md` and carries a substantive **Effort** record: one continuous session, two rejections, six agent passes, wall-clock brackets per pass from artefact mtimes, the agent mix, and the test count over the phase.

**The C5 arithmetic, parsed independently rather than taken from the account.** I extracted `(id N, phase N)` from every `##` heading:

- **42** headings total; **41** carry a numeric id; the one that does not is line 11, `## <feature_name> (id <n>, phase <n>) — <date>` — the file's own **template placeholder**, exactly as claimed.
- **41 distinct feature ids, zero duplicates.**
- **Zero `done` features without an entry** (all 40 present).
- **Exactly one entry for a non-`done` feature: id 38 itself**, pending this flip. After the flip that set is empty.
- **Zero entries whose id is not in `feature_list.json`.**
- **Every entry carries an `Effort` marker** — I parsed per-block, not by a whole-file count; zero missing.

So the 41-vs-40 discrepancy raised in the first review was arithmetic, not a missing or spurious record, and the C5 claim now holds on my own parse. `rules.require_effort_record_to_close` is satisfied.

**Is the entry true and sufficient?** I checked its checkable claims against the repository's own records rather than reading it for tone:

| Claim in the entry | Verified against | Result |
|---|---|---|
| *"Test count over the phase: 1475 → 1500"* | `progress/spec_auth_rate_limit_contract.md:76` records `pnpm quality` green at **1475** before this phase; the `R58` cell and the gate record **1500** now | **true** |
| *"reported 16; the row statuses said 3"* | `review_traceability_audit.md:5` — the summary table claimed 47 green of 63 (→ 16), the rows gave 60 (→ 3) | **true** |
| *"a filename matcher that reported **144 missing test files**; all 144 existed"* | `review_traceability_audit.md:15` — *"The '144 missing test files' … was a matcher artefact; nothing is missing"* | **true** |
| *"60 green, all 147 verbatim citations and all 101 cited paths resolving"* | `review_traceability_audit.md:5` and `:14-15` — 147 citations / 0 mismatches, 101 paths / 0 missing | **true** |
| *"mis-parsed that one file **four times**"* | `progress/current.md:31` records the same four, in the leader's own voice | **true, and self-incriminating** |
| *"`R58` … nine untraced log sites … then a tenth in the console sender"* | the `R58` Status cell's own enumeration, which I read in full on the second pass | **true** |
| *"the guard … checks 55 rows and one that checks all 63"* (open point 6) | `spec_traceability_closure.md:40` — eight rows unguarded, 63 − 8 = 55 | **true** |
| *"`implementer` ×3"* | three new `progress/impl_*.md` this phase: money-representation, R58 log-correlation, R58 console-sender | **true** |
| *"The single ratified deferral is `R56`"* | my own tally of all 63 Status cells: 62 / 1 / 0 | **true** |

**And it does not flatter where the records are harsher.** It records, unprompted, that the leader was corrected twice before the audit found anything; that a rule written to stop authors marking their own homework caught its own author within the hour; that the `R58` exclusion was verified by checking one half of a sentence; that the second rejection was a half-fix of the identical shape, *"in a document about honesty"*; and that this very entry's absence was one of the two blocking findings. It also credits the implementer for declining a weaker answer the brief had sanctioned. That is the standard the Phase 24 README review asked for, applied to the project's closing record: it names the failures in the words the records use, and points at `progress/review_final_checkpoint.md` for the rest rather than summarising the verdict into something softer.

---

## Findings

Two, both non-blocking, both in the effort line's own arithmetic — recorded because this phase's stated lesson is that a number is only true if it is re-derived.

#### T1 — *"5 blocking + 1 blocking-nit + 6 non-blocking"* undercounts the first review's non-blocking findings

The first review carries `#### N1` through `#### N8` — **eight** non-blocking findings. With `N1` reclassified as the blocking-nit (which is what that phrase means), **seven** remain, not six. The miscount is by one and in the flattering direction. It changes nothing material: every finding is enumerated in the review file named two sentences later, and all of them were verified closed or carried forward on the second pass. Worth correcting when the human commits.

#### T2 — *"`reviewer` ×3"* is one short at close, by construction

The entry counts the audit, the first checkpoint review and the second. This third review makes four. Unlike T1 this could not have been re-derived when the entry was written — an entry cannot count the review that reads it — so I record it as a line to update at commit time, not as an error of method.

**Also observed, not a defect:** the entry summarises the first review's six blocking findings rather than enumerating them, and so does not name **B2** (a `done` sdd feature whose task ledger asserted in bold that its shipped work was not done, undetected since feature 27) among them. The entry does not claim to enumerate, and points at the full record. I record the omission only so the choice is visible rather than accidental — the same treatment the Phase 24 review gave the README's editorial cut.

**Sweep for what the latest fixes broke — nothing.** `docs/PROCESS.md`'s diff is the four hunks above and no more. `progress/history.md` gained one entry, appended, with no duplicate id and no disturbance to the 40 before it. Every second-review closure re-checked and still holding: **63 rows / 5 fields each / zero misaligned**; **zero** occurrences of `MySQL`, `MongoDB`, `Drizzle`, `Testcontainers`, `NestJS`, `Vitest`, `apps/` or `packages/` in columns 1–4; **zero** unticked tasks across all eight sdd features; `progress/current.md` still describes this session; matrix guard **6 passed**; `./init.sh` **exit 0**.

---

## `CHECKPOINTS.md` C1–C7 walk

Marked from my own evidence across all three passes; anything I took from the gate rather than ran is said so.

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist — confirmed by `./init.sh`, re-run this pass.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (plus `suite_runner`) — untouched all phase (`git status .claude` empty).
- [x] Every agent definition declares its model — 3 pinned, 3 documented as deliberately inheriting.
- [x] `./init.sh` exits 0 — run by me this pass.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero, by `init.sh` and by parsing `feature_list.json`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — the matrix's row-level evidence, 428 tests I ran across notifications/projector/gateway on the second pass, the matrix guard, and the gate's full run.
- [x] `progress/current.md` describes the active session — `final_checkpoint` (id 38, phase 25), `in_review`, 40 of 41 done; all re-derived and correct.
- [x] Every `blocked` feature records why — none blocked.

### C3 — Architecture is respected
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` — re-grepped clean after this phase's source edits.
- [x] No cross-service database access — `apps/seed` remains the one documented, previously ratified exception; the Gateway's read-only MongoDB query is the named, drawn read model.
- [x] No shared runtime code beyond `packages/shared-kernel` and `packages/contracts`.
- [x] `packages/shared-kernel` has zero runtime dependencies — re-derived from its `package.json`.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — including the read-model signal, whose `x-correlation-id` header I traced from publisher to consumer this phase.
- [x] No stray debug logging, no context-free TODOs — the two lines this phase touched are now structured, id-carrying and each guarded by an armed test.

### C4 — Verification is real
- [x] `pnpm quality` passes — **not re-run by me**; the gate's run (exit 0, 1500 tests), corroborated by four suites, one lint run and the matrix guard of my own, all green.
- [x] Domain tests are pure.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS / MongoDB — not re-run this pass; established by the first review's live run of `money-representation.integration.spec.ts` against real NATS + MongoDB, and by opening `trace-context-propagation.integration.spec.ts` case by case on the second.
- [x] Coverage thresholds met — enforced per-workspace in `vitest.config.mts`, run by `test:coverage`, green at the gate.
- [x] No Jest anywhere — re-grepped clean.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the untracked paths are guard specs, the `R1` sweep and its helper, and `progress/` records.
- [x] **`progress/history.md` has an entry for the feature just finished, including its effort record** — **now passes (item 2)**: 41 entries + template, 41 distinct ids, zero `done` features without one, every entry carrying an `Effort` marker.
- [x] `feature_list.json` reflects the true state of every feature touched — 40 `done` + 38, which this verdict flips to `done`; no other field touched by me.
- [x] The human has been told what was done and how to test it manually — evidenced rather than assumed: the human ruled at the gate repeatedly *inside* this phase (`R56`'s ratification, the six findings approved before the fix pass, the README rewrite and the B5 closeout, all recorded in `progress/spec_traceability_closure.md` and `progress/current.md`), and the manual-test route is the README's Quick Start, whose commands, URLs and scripts I resolved on the first pass. The leader's closing report follows this verdict, as it always does.
- [x] Claude did not commit — the tree is uncommitted; I ran no `git commit`/`git push`; my three mutation probes were restored and md5-verified identical.

### C6 — Spec-Driven Development
- [x] Every `sdd: true` feature past `pending` has `specs/<name>/` with all three documents — 8 of 8, by `init.sh`.
- [x] `requirements.md` uses strict EARS notation with an `R<n>` id each — 63, contiguous and unique, re-derived.
- [x] Every `done` sdd feature has all its tasks ticked — zero unticked across all eight, and I opened A5d's and A5e's artefacts before accepting the ticks.
- [x] Every `R<n>` is covered by at least one concrete named test recorded in the matrix — 63 rows, each naming a file and a case; the guard resolves every anchorable citation (6 passed), and the eight it cannot anchor on are disclosed in the file itself.
- [x] The spec commit precedes the implementation commit — verified for `fulfillment_stock` and inherited elsewhere; N7 records the one feature where the two collapse into a single commit.

### C7 — Trilogy reusability
- [x] The reusable part of `specs/shared/` contains no stack specifics — on my own column-isolated parse of all 63 rows plus every non-table line: zero leaks, and both per-assessment asides carry the *"may delete this paragraph outright"* clause C7 requires.
- [x] `n8n/workflows/*.json` reference only the Gateway REST API — verified token by token; untouched since.
- [x] `progress/history.md` effort records are complete and honest — 41 of 41, including this feature's own.

**Applicable boxes empty: 0.** The close is permitted.

---

## Can this repository honestly be called finished?

**Yes.** Not "finished" as a feeling about the code, but in the specific, checkable sense this feature exists to certify — and I have now checked each of its three acceptance criteria myself rather than reading a claim about it.

**Criterion 1, every EARS requirement traced to a green test.** 63 requirements, `R1`–`R63`, contiguous and unique. 63 matrix rows, one per id, every one naming a real file and a real case, with a mechanical guard that fails when a citation drifts — I armed nothing myself this pass but watched the guard's own non-vacuity evidence and re-ran it green. My independent tally of the Status cells gives **62 green, 1 scoped, 0 not-yet-green**, matching the published table exactly. The single scoped row is `R56`, and it is ratified in the way the file's own rule 3 demands: it says which leg is unproven, in the requirement's own words, what closing it would cost, and who accepted the deferral. The one row that was over-claimed when I first read it — `R58` — was closed the harder way, in production code on the degradation path, and I proved both halves of that fix load-bearing by deleting them one at a time and watching the named degraded-path case fail with real id equality, not field presence.

**Criterion 2, `progress/` snapshots versioned in different states.** 23 commits and 23 distinct contents for `current.md`; a history with one entry per feature, 41 of them, every one carrying an effort record — including, now, the record of the phase that closed the project, which is the artefact assessment #7 hands to #8 and #9 as the benchmark baseline.

**Criterion 3, `specs/shared/` clean for #8.** Parsed structurally rather than grepped: 63 rows, five fields each, zero misaligned, and zero technology particular to one assessment anywhere in columns 1–4 or in normative prose. The two exceptions are labelled asides that tell the other assessments they may delete them outright, and the two transports named in `R57`'s sketch are the shared contract's own glossary terms — which I confirmed in four sibling documents rather than accepting the argument.

What persuades me most is not that the claims are true now, but *how* they became true. Every one of the four defects that mattered this phase was a claim that was nearly right: a matrix cell whose summary was one row ahead of its evidence, a task ledger that denied its own shipped work, a status paragraph whose first sentence was corrected and whose last was not, an exclusion that read as settled because it had been described as long-standing. None of them would have been caught by running the tests — the suite was green through all of them. They were caught by parsing a table as a table instead of as text, by opening the artefact behind the tick, by re-deriving the number instead of comparing it, and by reading the second half of the sentence. The repository's closing record says exactly that, in harsher words than I would have used about it, and includes its own absence in the list.

Two off-by-one counts remain in that record's effort line (T1, T2). I do not hold the close on them: they are about the process's own bookkeeping, not about the system, the linked review file is complete and correct, and one of the two is unknowable until this review exists. Everything the feature was asked to certify is true and independently checked.

**Feature 38 is `done`. The backlog is complete: 41 of 41.**
