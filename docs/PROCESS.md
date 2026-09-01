# How this project is built — the process guide

> **What this is:** the complete explanation of the development process used in this repository — the concepts, the cast of agents, the workflow, and a registry of every process artifact. If you cloned this repo and want to understand *how* it was built (or replicate the pattern), start here.
>
> **Maintenance rule:** this document is updated at the end of every phase — the artifact registry (§9) and "Where the project is right now" (§10) must always reflect reality. A stale process guide is a defect.

---

## 1. The premise

This repository is built almost entirely by AI agents (Claude Code), with a human making the judgment calls, testing every phase, and owning every commit. **The development process is itself a deliverable**: the assessment behind this project scores not only the software but whether the process artifacts show real use and whether a stranger could replicate the pattern.

The process combines two ideas that are often confused. They stack — the harness is the foundation, SDD sits on top.

---

## 2. Layer 1 — The harness

### The problem it solves

An AI agent has two structural weaknesses: **it has no memory between sessions**, and **it will do the wrong thing very fast and very confidently**. Left alone, agent-built projects rot in predictable ways — three features each 70% finished, tests that assert nothing, state that silently contradicts itself, a README describing software that does not exist.

The harness is a set of plain files that give the agent an external brain and a set of rails. None of it is magic; all of it is discipline made mechanical.

### The parts, and why each exists

**External memory** (`progress/`). Between sessions the agent remembers nothing, so everything worth remembering is written to disk *while working, not at the end*: what is in flight (`current.md`), what was finished and what it cost (`history.md`), and each agent's own report of what it did (`impl_*.md`, `review_*.md`, `spec_*.md`). A new session reads these and continues as if it had never stopped. This was proven mid-build: a session died between a review rejection and the fix; the next session resumed exactly where the loop stopped, from the files alone.

**A backlog with a state machine** (`feature_list.json`). Work is decomposed into features, each with a status:

```
pending → spec_ready → in_progress → in_review → done
                                          ↓
                                       blocked
```

Two rules carry most of the value. **Max one feature `in_progress`** — because parallel half-finished work is how agent projects rot; one-at-a-time makes "finished" mean something. And **only the reviewer sets `done`** — the agent that wrote the code never gets to declare it correct.

**A circuit breaker** (`init.sh`). Run at the start of every session. It checks that the environment is sane (right Node version, pnpm, Docker), the harness files exist, every agent declares its model, the backlog parses and obeys its own rules, and — crucially — that any spec-required feature past `pending` actually has its spec on disk. **If it exits non-zero, the session must not advance.** Its checks were adversarially verified: the state was deliberately broken four different ways and each was caught. A check that has never been seen failing is a convention, not a gate.

**Conventions that are enforced, not requested** (`CLAUDE.md` + tooling). The rules that matter are backed by machinery: domain purity is an ESLint rule that fails the build, not a paragraph; money as integer minor units is a value object that throws, not a guideline; "no Jest" is greppable. When an agent violates house style, the fix is usually to make the rule more explicit or more mechanical — not to correct the agent by hand and hope.

**Objective completion criteria** (`CHECKPOINTS.md`). "Am I done?" is a feeling; the checkpoints are yes/no questions a reviewer walks: harness complete? state coherent? architecture respected? verification real? session closed cleanly? SDD followed? artifacts reusable? A session does not close with an applicable box unchecked.

**Specialised agents** (`.claude/agents/`) — see §3.

### What the harness is *not*

It is not specific to this project, this stack, or even to SDD. The harness layer alone is worth adopting in any AI-assisted repository. It is also not tooling-heavy: every artifact is markdown, JSON or bash, readable in an editor, diffable in git.

---

## 3. Layer 2 — SDD (Spec-Driven Development)

### The problem it solves

For large features, the expensive mistakes are made **before any code is written** — a wrong invariant, a missing compensation path, an ambiguous contract between services. Code review catches coding mistakes; nothing catches *specification* mistakes unless the specification exists as an artifact someone can review.

SDD inverts the usual order: write the specification first, in a notation precise enough to be testable, get a human to approve it, and only then implement. The spec — not the code — is the source of truth. When code and spec disagree, the code is wrong (or the spec gets amended *first*, visibly).

### How it works here

- **`specs/shared/`** holds the system-wide specification, written in Phase 3 before any application code: the domain model and its invariants, the saga with both compensation paths, 63 EARS requirements, an AsyncAPI document (every event and RPC message), an OpenAPI document (the REST contract), a test matrix mapping every requirement to the test that proves it, and the functional spec of the demo workflows. It is deliberately **stack-agnostic** because two sibling assessments (#8 .NET, #9 FastAPI) reuse it verbatim.
- **`specs/<feature>/`** (from Phase 8 onward) holds a per-feature triple-doc for the 8 *large* features only — `requirements.md` (EARS), `design.md` (the stack-specific how), `tasks.md` (an ordered checklist the implementer ticks). These features carry `"sdd": true` in the backlog.
- **The human approval gate**: a spec-required feature stops at `spec_ready` until the human has reviewed the spec's *decisions* (see §6) and approved. No code before approval — and the git history proves the ordering, because the spec commit precedes the implementation commit.

### The honesty clause

SDD costs real ceremony, and for a 50-line feature the ceremony is decorative paperwork. That is why only 8 of this project's 41 features carry `"sdd": true` — the aggregates and state machines, the saga and its compensation, the outbox and idempotency, the read-model projection, and the observability wiring. Everything else skips the triple-doc but still travels the backlog state machine. The spec-becomes-infrastructure moments (Kafka topics derived from the AsyncAPI file, TypeScript types generated from both API documents) are where the spec pays for itself even on small features.

---

## 4. The cast — who does what

Six roles: five agents defined in `.claude/agents/`, plus the human. Each agent definition declares which Claude model it runs on (or documents that it deliberately inherits the session's model) and which tools it may use — both are design decisions, not defaults.

| Role | Model | Tools (the deliberate part) | Job |
|---|---|---|---|
| **The human** | — | everything, including the only `git commit` | Approves specs, adjudicates judgment calls, tests every phase, owns the git history |
| `leader` | unpinned — inherits the session model | has the **Agent** tool; never edits `apps/` or `packages/` | Decomposes work, launches the other agents, maintains the backlog and session state, stops at every human gate |
| `spec_author` | unpinned | Read/Write, **no code execution focus** | Writes `specs/` — EARS requirements, designs, task lists. Never writes application code or tests |
| `implementer` | `sonnet` | full edit + bash | Implements **one** feature against its approved spec, writes its tests, self-verifies |
| `reviewer` | unpinned | **read-only — no Write, no Edit** | Approves or rejects the implementer's work; the only role that sets `done` |
| `test_maintainer` | `haiku` | edit but **no bash** | Mechanical test updates after landed changes — retitles, flips assertions, fixes flaky timeouts. Never touches source |
| `suite_runner` | `haiku` | Bash, Read — **no edit** | Runs one long, noisy command and returns exit code, counts and verbatim failure blocks. Interprets nothing — which is why delegating to it does not weaken the do-not-trust-reports rule |

### The reasoning behind the model pinning

- `leader`, `spec_author`, `reviewer` are unpinned so they get the strongest available tier: decomposition, specification and adversarial review are the highest-judgment work, and the spec is inherited by two more assessments.
- `implementer` runs on a mid-tier model *because the thinking has already been done* — the spec or the acceptance list is the decision; implementation is faithful execution, and it happens ~30 times across the build.
- `test_maintainer` runs on the cheapest tier because its work is bounded and pattern-following by construction.

### Two design choices that are easy to miss

**The reviewer cannot write.** It has no Edit/Write tool *by design*. A reviewer that can fix what it finds becomes a second implementer — and nobody reviews the reviewer. Its only outputs are a verdict file and status changes. This has teeth: in this build the reviewer has rejected features the implementer reported as fully verified, by probing the running system and finding the report wrong (see `progress/review_infra_compose.md` for the clearest example — a data-loss bug behind a confident "verified" claim).

**Agents write to files, not to chat** (the anti-telephone-game rule). A subagent's deliverable is a file (`specs/<feature>/`, `progress/impl_*.md`); what returns to the leader is only a reference. Every hop through a chat summary loses detail; a file does not degrade, survives the session, and becomes the audit trail the process is scored on.

---

## 5. The loop — a feature's life, concretely

What actually happens when a large (`"sdd": true`) feature is built:

```
 1. leader: ./init.sh green? read current.md + feature_list.json
    │
 2. leader launches spec_author
    │    writes specs/<feature>/{requirements,design,tasks}.md
    │    sets status: spec_ready
    │    returns only: "spec_ready → specs/<feature>/"
    │
 3. ⏸ HUMAN GATE — the human reviews the spec's DECISIONS (§6) and
    │  approves or asks for changes. Nothing proceeds without this.
    │
 4. leader sets in_progress, launches implementer
    │    implements from the spec (not from its own idea of the feature)
    │    writes the tests INSIDE the feature — green before handover
    │    writes progress/impl_<feature>.md
    │    sets status: in_review
    │
 5. leader launches reviewer
    │    probes the running system — never trusts the report
    │    walks CHECKPOINTS.md, verifies requirement→test traceability
    │    writes progress/review_<feature>.md
    │    APPROVED → done + effort record in history.md
    │    REJECTED → in_progress, back to step 4 with a precise defect list
    │
 6. ⏸ HUMAN GATE — the leader reports what was done and how to test it
    │  manually. The human tests. Only then is the phase closed and committed.
```

Small features (`"sdd": false`) skip steps 2–3 and implement directly from their acceptance list — but never skip the review or either human gate.

The rejection path is not theoretical. As of Phase 6, the reviewer has rejected 2 of 8 reviewed features on first pass, with defects the implementer's own verification missed (a Kafka volume mounted where the broker never writes; a healthcheck reporting healthy 90 seconds early; verification logic that passed silently on drift). The loop's value *is* those catches.

---

## 6. EARS — the requirements notation

EARS (Easy Approach to Requirements Syntax) constrains every requirement to one of five shapes, which makes vagueness structurally difficult:

| Pattern | Shape | Used for |
|---|---|---|
| Ubiquitous | THE SYSTEM SHALL … | invariants, always true |
| Event-driven | WHEN ‹trigger›, THE SYSTEM SHALL … | reactions to facts/commands |
| State-driven | WHILE ‹state›, THE SYSTEM SHALL … | behaviour during a condition |
| Unwanted | IF ‹condition›, THEN THE SYSTEM SHALL … | error and edge cases |
| Optional | WHERE ‹feature present›, THE SYSTEM SHALL … | configuration-dependent behaviour |

A real one from this project's spec:

> **R27.** WHEN a `credit.rejected.v1` fact is received for an order in status `stock_reserved`, THE SYSTEM SHALL issue a stock release command, and SHALL NOT set the order to `cancelled` until `stock.released.v1` has been observed.

What makes it good: a named trigger, a named precondition, an explicit prohibition with ordering — every clause is something a test can fail on. Contrast: *"the system shall handle credit rejection gracefully"* — nothing can fail that; it is a wish, not a requirement.

Every requirement carries a stable id (`R1`…`R61`), and `specs/shared/test-matrix.md` maps each id to the named test that proves it. A feature is not `done` while its matrix rows are red or missing. This is the traceability chain: requirement → test → green.

---

## 7. What "reviewing a spec" actually means

The most misunderstood human task in the whole process, so it gets its own section.

When an agent writes a specification from a task document, it repeatedly hits places where the source is **ambiguous**, and it must *decide*. Those decisions then bind every downstream phase. Reviewing the spec means **reviewing those decisions — not proof-reading the prose**. If the decisions are right, the prose follows.

The mechanism: the spec author records every ambiguity it resolved in a table (what was unclear → what was decided → why → where it is recorded). In this project, Phase 3's spec pass surfaced **13 such decisions** (see `progress/spec_shared_passA.md` §4) — which fact drives `paid` vs `completed`, whether compensation releases stock before or after cancelling, whether an RPC reply may ever advance the saga (it may not — only facts do). The human read a 13-row table, not 7,500 lines, and pushed back where it mattered.

A useful instinct for the human: pay most attention to decisions that **add** something the source document never mentioned — that is where an agent has invented policy. (Here: what happens when an operator cancels an order after stock is reserved and credit is held. The task document was silent; the spec author designed the unwind rule; the human approved it knowingly.)

---

## 8. The rhythm of a phase, and common confusions

### The rhythm

Every phase runs the same shape:

1. `./init.sh` — refuse to start from a broken state.
2. Do the work through the loop (§5), one feature at a time.
3. **Stop.** The leader reports *what was done* and *how to test it manually* — exact commands, expected output.
4. The human runs the commands and verifies.
5. The human authorises the close. Only then:
6. **The phase-close ritual**: commit (one commit per phase/feature, message naming every package installed and why) → update the private build-plan document → refresh `README.md` → update this document (§9 registry + §10 status) → brief the next phase.

The agents never run `git commit` or `git push` of their own accord. The commit history is reviewed process evidence; every commit is something the human personally verified. That is also why the history reads spec-first: the ordering is the proof.

### Common confusions

**"Why is there a spec *and* a plan?"** The plan (kept outside this repository) is the build order — phases, sequencing, decisions log. The spec (`specs/shared/`) is the system's definition — what the software must do, independent of schedule. The plan changes as the build learns; the spec changes only when requirements change, and visibly.

**"Why can't the agent just commit?"** Because a commit is a claim that something works, and only the person who tested it can make that claim — on a public portfolio repository, under their own name.

**"Why max one feature in progress?"** An agent will cheerfully leave three features 70% done. One at a time makes "finished" meaningful and keeps the effort records honest.

**"Does the human read everything the agents produce?"** No. The human reads the *decision tables* and the *verdicts*, spot-tests the system, and trusts the adversarial loop for the rest. The full artifacts exist for when they are needed — and for the assessor.

**"What happens when an agent is wrong?"** The reviewer rejects with a precise defect list and the loop repeats. If the same class of mistake recurs, the fix goes into `CLAUDE.md` or the agent's own definition — the process is corrected, not just the instance.

**"Is any of this specific to Claude?"** The file formats assume Claude Code's subagent mechanism (`.claude/agents/`), but the pattern — external memory, backlog state machine, circuit breaker, spec gate, adversarial review, human commit gate — is tool-agnostic.

---

## 9. The artifact registry

Every process artifact in this repository: what it is for, and where it came from. ("Updated" means meaningful content change, not status ticks.)

| Artifact | The problem it solves | Useful to know | Created | Last updated |
|---|---|---|---|---|
| `AGENTS.md` | "Where does an agent start?" — the entry map | Read order, hard rules, the SDD flow, session-close procedure. Progressive disclosure: read only what you need | Phase 2 | Phase 6 |
| `CLAUDE.md` | "How do we do things here?" — binding conventions | Leader role, architecture non-negotiables, coding/testing conventions, commit discipline, environment traps discovered en route | Phase 2 | Phase 2 |
| `feature_list.json` | "What is happening right now?" — the backlog state machine | 41 features, 8 `sdd: true`. Max one `in_progress`, enforced by `init.sh`. Only the reviewer sets `done` | Phase 2 | every feature transition |
| `init.sh` | "Is the world sane?" — the session circuit breaker | Exit ≠ 0 ⇒ do not advance. Checks env, harness files, agent model declarations, backlog coherence, SDD coherence. Adversarially verified | Phase 2 | Phase 2 |
| `CHECKPOINTS.md` | "Am I actually done?" — objective close criteria | C1–C7; the reviewer walks them; C7 covers trilogy reusability | Phase 2 | Phase 2 |
| `.claude/agents/*.md` (×6) | Role separation with different powers and cost tiers | Each declares model + tools; reviewer deliberately read-only; test_maintainer deliberately bash-less | Phase 2 | Phase 2 |
| `progress/current.md` | Working memory of the active session | Updated at every status transition, in lockstep with the backlog — the reviewer checks this (C2) | Phase 2 | every session |
| `progress/history.md` | Append-only log + **per-feature effort records** | The baseline for the trilogy benchmark (#8/#9 are measured against these numbers) | Phase 2 | every feature close |
| `progress/impl_*.md` | The implementer's own report per feature | What was built, evidence, deviations, what the review later caught | Phase 4 | every feature |
| `progress/review_*.md` | The reviewer's verdict per feature | Probes with real output, defects with file/line/why, CHECKPOINTS walk. Includes two full rejection→fix→approve cycles | Phase 4 | every feature |
| `progress/spec_*.md` | The spec author's record per spec pass | Contains the **ambiguity-resolution tables** — what the human gate actually reviews | Phase 3 | Phase 3 |
| `specs/shared/` (7 files) | The system's definition, before the code | Stack-agnostic; reused verbatim by assessments #8 and #9. AsyncAPI drives real topic creation; both API docs drive type generation | Phase 3 | Phase 3 (amendments via the human gate) |
| `specs/shared/test-matrix.md` | Requirement → test traceability | 63 rows; flipped from `TODO` to green as features land, and a row may also be *scoped* — proving less than its requirement says — only where the shortfall is stated and ratified at the gate | Phase 3 | Phase 5 |
| `specs/<feature>/` | Per-feature triple-doc for the 8 large features | requirements (EARS) + design + tasks; human gate between spec and code. First one (`orders_aggregate`) went through 16 open points at the gate: 14 accepted, 2 amended | Phase 8 | Phase 8 |
| `docs/PROCESS.md` | This document | Updated at the end of every phase — registry + status | Phase 6 | Phase 16/23 |
| `README.md` | Honest front door at every commit | Grows incrementally each phase; never describes software that does not exist yet | Phase 1 | every phase |
| `http/` | Manual probing of a running stack | REST Client files: service liveness, the NATS subjects currently answered, the domain facts on each Kafka topic, and the Prometheus/Jaeger/Grafana APIs. Business operations are NATS, not HTTP, until the Gateway lands at feature 25 — the file set grows there | Phase 10 | Phase 10 |
| `scripts/` | Driving the system before the Gateway exists | `place-order.mjs` sends a NATS `orders.create` request through the framework's own client; `pay-invoice.mjs` registers a remittance on the raw-`nats` bare-JSON wire Billing's subjects actually speak. Wrapped as `pnpm order:place` (`--qty`, `--discount`) / `order:over-limit` / `invoice:list` / `invoice:pay` (`--ref`, `--amount`, `--correlation`), with `saga:watch` for the resulting state | Phase 10 | Phase 10 |
| `docker-compose.infra.yml` + `infra/` | The runnable infrastructure | 10 pinned services + SonarQube behind a profile; `kafka-init` derives topics from the AsyncAPI spec; MySQL init provisions the four service databases | Phase 4 | Phase 11 |
| `docker-compose.apps.yml` + `infra/docker/` | The 7 application services, containerized | Two files, not one — extends the infra compose rather than duplicating it; every NestJS image builds through the real `tsc` compiler, never `tsx`; migration jobs gate each service's start | Phase 23 | Phase 23 |
| `.env.example` | Every credential, port and flag, documented | Extended whenever a feature adds configuration | Phase 4 | Phase 7 |
| `package.json` (root) | Workspace scripts + exact `packageManager` pin | The exact pin matters: corepack rejects ranged pins outright. The `dc:*:apps` scripts pass `--profile sonar` deliberately — without it Compose omits profile-gated services from the model, so `down` silently leaves them running | Phase 4 | Phase 23 |

---

## 10. Where the project is right now

> Maintained at the end of every phase. History of *how* each phase went lives in `progress/history.md`; this is only the current position.

**Position: complete. All 25 phases closed, 41 of 41 features `done`.** `pnpm quality` exits 0 at 1500 tests, `./init.sh` exits 0, and every EARS requirement `R1`–`R63` is traced to a green test — 62 green, plus `R56` as a single deferral ratified at the human gate with its exclusions stated rather than hidden. The web app is finished: auth (the JWT never reaches the browser), place-order, order list, order detail with a live SSE saga timeline showing what caused each entry, billing with payment registration, and stock with delta replenish. Phase 18 adds black-box API tests driving a real spawned Gateway in front of a real fleet — the first time those two halves of the test estate have met — and they found a genuine ordering defect on their first run, whose fix (amendment A1) went through the spec gate. Phase 17 closed as a byproduct rather than a separate phase, because the tests were written inside each feature loop. Phase 19's Playwright suite then found a defect only a real browser could reach — a page showing `Live` while permanently stale — which no lower layer had caught. Phases 20–22 (n8n workflows, SonarQube gates, observability dashboards), 23 (full Docker Compose) and 24 (documentation + demo) have since closed; only Phase 25's final checkpoint remains.

| Phase | What | State |
|---|---|---|
| 1 | Environment & repository | ✅ |
| 2 | Harness layer | ✅ |
| 3 | Shared specification (`specs/shared/`, 63 EARS requirements, both API contracts) | ✅ |
| 4 | Infrastructure compose (10 pinned services) + spec-derived Kafka topology | ✅ |
| 5 | Monorepo scaffold, shared-kernel (100% coverage), spec-generated contracts | ✅ |
| 6 | Drizzle schemas + migrations for the three service databases, Testcontainers suites | ✅ |
| 7 | Deterministic seed job (four stores, valid GLNs, pre-published outbox history) | ✅ |
| 8 | Orders service — aggregate, outbox/idempotency, acceptance, and the saga orchestrator (the centrepiece: `@nestjs/cqrs` over durable `saga_commands`, both compensation paths, park-then-recover) | ✅ |
| 9 | Fulfillment — stock reservations and DESADV creation. The saga now advances across two services unattended | ✅ |
| 10 | Billing — buyer credit, the `.99` simulator, invoicing and remittance intake. The order-to-cash cycle now runs end to end: an order reaches `completed` across three services, unattended | ✅ |
| 11 | Notifications — the first service with no aggregate, proving the fact stream is self-describing. Seven templates render from the envelope alone | ✅ |
| 12 | Projector — the MongoDB read model. Every fact from three services into one timeline document per order, idempotent by a key that lives in the write's own filter | ✅ |
| 13 | Gateway / BFF — 18 REST paths, JWT, the SSE stream, and a post-approval fix so a client's resume cursor never points at a heartbeat | ✅ |
| 14 | Reliability + observability — retry with backoff, dead-letter (the actual fix for the Phase 12 poison-pill incident), OTel tracing, structured logging, metrics, health checks. Six implementer passes, the largest feature in the project, zero blocking findings on review | ✅ |
| 15 | End-to-end saga verification — real spawned services, not in-process Testcontainers. Redundant idempotency independently re-proven by the review with different arms than the implementer's own. `stock_rejected` closed by discovering the obvious test scenario was wrong — the real mechanism is a genuine check-then-reserve race. README's DLQ walkthrough remains the one open item | ✅ |
| 16 | Web app (Nuxt 4) — auth, place-order, order list, order detail with a live SSE saga timeline, billing (invoices, credits, Register payment) and stock (delta replenish), all against the real Gateway. Every pass independently reviewed; verified end to end by hand | ✅ |
| 17 | Web component tests — 59 tests / 14 files, written inside each feature loop rather than as a separate phase. SSE covered against a real `EventSource` over real HTTP, not a fake. Coverage 85.8% statements | ✅ |
| 18 | API tests through the Gateway — a real spawned Gateway in front of a real fleet, supertest as HTTP client only. Found a genuine timeline-ordering defect on its first run; the fix went through the spec gate as amendment A1 | ✅ |
| 19 | Playwright end-to-end tests — 3 scenarios in a real browser. Found a stale-page defect (a page showing `Live` while permanently out of date) that unit, integration and black-box API tests had all passed over | ✅ |
| 20 | n8n demo workflows — authored from the sibling assessments' committed JSON rather than built by clicking; review found a secret exposure and a generator that missed half the time | ✅ |
| 21 | SonarQube + quality gates — coverage enforced two-tier and proven to bite; first-ever scan found 20 real accessibility defects and 12 false positives | ✅ |
| 22 | Prometheus, Grafana, Jaeger verification — found every trace was a single span, fixed the linkage, and the new DLQ panel surfaced 728 dead letters nobody knew about | ✅ |
| 23 | Full Docker Compose — all 7 application services containerized on top of the existing infrastructure compose, live-verified (built, migrated, healthy, seeded from a cold cycle), every container running non-root as uid 1000, and the CLI-apps/compose-infra alternative mode re-verified | ✅ |
| 24 | Documentation + demo — architecture and saga diagrams, the Kafka-vs-NATS matrix, DLQ inspection, trade-offs, assumptions, and reproducible screenshot/GIF capture. Rejected once on review: the documentation was green under test and false in six checkable ways | ✅ |
| 25 | Final checkpoint — full traceability walk of `R1`–`R63`, `specs/shared/` re-audited for stack leaks, coverage summary recomputed. Rejected twice before it passed: the one genuinely missing test was written, ten untraced log sites closed, and a `MySQL` leak found surviving in the part of the matrix declared stack-neutral | ✅ |


---

## 11. What this process actually caught

> Every entry below is a real finding from this build, kept because the *pattern* is reusable even where the specific bug is not. Grouped by what produced the finding rather than by phase, because the recurring shapes are the useful part.

### 11.1 Guards that guarded nothing

The single most repeated failure in this project. Machinery that looks like enforcement and is not — and in every case it was found by deliberately breaking the thing and checking that something screamed.

- **A parity check that read only a comment.** Written to prove five copies of a critical pattern had not diverged, it inspected their leading comment. A reviewer replaced an entire implementation with a body that did nothing, left the comment intact, and the guard passed. Worse, whether a service was checked at all depended on a file the implementer chose whether to create — any service could quietly exempt itself, and the next one in build order would have. Now behavioural: the implementation is imported and executed, the decisive assertion being that a component rebuilt over the same storage still recognises what it already handled.
- **Tests whose names promised more than they asserted.** Three "loading state" specs claimed to assert a distinct loading state; deleting the loading branch from two components left the suite green. A test that overclaims is worse than no test, because it stops anyone looking.
- **A coverage threshold over an empty directory.** One service's 80% domain tier was *vacuously satisfied* — proven by raising every service's tier to 100% and watching that one alone pass. Correct today; now guarded against the next rename, with the exemption written down rather than silent.
- **The quality gate itself, inert since Phase 1.** `pnpm quality` ran the plain test script, not the coverage one, so thresholds specified for twenty phases had never once failed a build. The numbers happened to be fine, which is the uncomfortable part — nothing would have surfaced it until it mattered.
- **A "flaky test" that was a real defect.** The gate went red once and green the next run; the reviewer refused to write it off and asked the sharper question — *can a genuinely concurrent duplicate surface as an internal error rather than a conflict?* It could, reproduced on demand across 220+ trials. A deadlock is not a conflict, and nothing in the codebase handled one.
- **A test asserting a rolled-back side effect.** It claimed an unchanged database counter proved a request was rejected before any transaction opened. A transaction that opens, increments and rolls back leaves the counter equally unchanged — demonstrated by removing the check and watching the suite stay green.

### 11.2 What only running the real thing found

- **Every distributed trace was a single span**, despite four services exporting and every service having tracing wired. Found by opening Jaeger, not by reading code. The context was propagating correctly all along — two services extracted it and then never created a span, so there was nothing for the next hop to parent onto. A dashboard built on that would have looked complete and shown nothing.
- **728 dead letters nobody knew about**, surfaced by a DLQ panel on the first day it existed. The cause was in the dead letters' own headers: an exhausted third-party email quota. The retry-and-dead-letter machinery was working exactly as designed against a failure class it had no way to name.

Each test layer has found defects the layers beneath it structurally could not reach. The pattern is consistent enough to state as a claim.

- **A page showing `Live` while permanently stale.** Status badge frozen, last timeline entry missing, API reporting the truth throughout. Unit, integration and black-box API tests all passed over it, because it needs a real browser holding a page open across a same-millisecond burst of facts — and nothing below that layer holds a page open. It reproduced 2 times in 7 on one configuration and 0 in 9 on another: rare enough to look like an environment problem, deterministic enough to hit a user.
- **Twenty accessibility defects.** No lint rule, type check, component test, browser test or human review had caught them, because none of them ask what a screen reader would announce.
- **A poison message that stopped a whole workflow.** A single malformed test payload published onto a real topic during verification; one service could not parse it, its consumer retried forever, everything behind it was dead. The tooling had classified that message as cosmetic.
- **Two defects found only by booting the stack**, not by writing correct-looking configuration: a runtime file path the gateway needed inside its image, and a cross-app source dependency invisible in the consuming package's own manifest.
- **A dev/prod divergence invisible to every test.** The dev runner did not emit the decorator metadata the DI container relies on, so identical source behaved differently under `pnpm dev` and in production.

### 11.3 Claims that did not survive being checked

- **"It worked when I ran it" is not a measurement.** A demo generator was supposed to steer ~15% of orders down the compensation path. It had been verified live, and the orders it engineered genuinely did cancel — so it looked correct. Running the committed function over 200,000 inputs showed it succeeded barely half the time, delivering 7.6% instead of 15%. A miss was invisible because it produced an ordinary, valid, completed order. Watching something work tells you nothing about how often it works.
- **A secret exposure created by the most ordinary-looking line in the file.** Handing a container the project's whole `.env` is the default choice, works immediately, and fails at nothing — while giving an unauthenticated tool the database root password and the JWT signing secret, readable from inside its own scripting. It was found by reading the running container's environment, not by reading the compose file, and the leader's own brief had waved it through by saying "credentials come from env".

- **A confident, file-and-line-cited claim that was simply false.** An implementer justified deviating from its brief by asserting a committed cleanup script would destroy an unrelated container's data. The leader believed it and relayed it as a real defect. The reviewer did not reason about it — it tested it, in an isolated project reproducing the same shape, and found the opposite. *A citation is not evidence.*
- **"Placed a real order through the UI"** — which was a direct API call that never rendered a component or clicked a button. The distinction hid a real defect: a submit button permanently disabled from page load.
- **Honest disclosure is not the same as the requirement being met.** An implementer truthfully disclosed narrowing an "every line" requirement to three call sites; the row was marked complete anyway, until a second read found two more lines that mattered more than the three that got attention.
- **Caution that has not been verified is not caution.** In one conversation the assistant twice manufactured a cautious-sounding reason not to change a script; both evaporated the moment anything was actually checked, because neither had been.

### 11.4 What the human found by operating the system

Not everything comes from agents or tests.

- Stopping the whole stack never freed the expected memory — because Docker Desktop on Linux holds its VM's full allocation (20.2 GB to run containers using 5.1 GB) and does not release it when containers stop.
- One container survived every teardown — profile-gated, so Compose excluded it from the model entirely; the teardown and inspection scripts never activated that profile while the startup script did. Start and stop had been operating on different service sets since the phase was written.
- A five-times-a-minute heartbeat was quietly defeating the one guarantee a feature existed to provide — found by reconnecting an event stream by hand and comparing two ids, after three rounds of automated review had approved it.
- A racy test assertion, caught by the human's own full-suite runs: it polled for a state the *correct* saga leaves within one poll interval.

### 11.5 What the spec gate caught before any code existed

- **A defect in already-shipped code**, found during a specification pass: an invoice total diverged from the order total whenever a discount was applied — and the live database already held two wrong invoices while the gate was still debating whether the case was reachable.
- **A design that would not have worked**, caught before implementation: two facts emitted in one transaction shared a causation id, making them siblings rather than a chain — so the approved fix needed a second change first.
- **A human overrule.** The spec author declined a mandated framework on technical grounds; the human ruled that demonstrating the mandated stack is the point, and the revised design layered it over the durable machinery without weakening it.
- **Two earlier-phase defects surfaced before any code was written** in the first SDD loop: a database column missing against the domain model, and undeclared workspace dependencies that would have broken a clean clone.

### 11.6 Reviews that probed instead of re-reading

- **Different arms than the implementer chose.** Four defensive layers were claimed to guard against duplicated work on redelivery; the implementer disabled one combination, the reviewer disabled a *different* one and got the identical result — two independent people finding the same wall from different directions.
- **Scanning everything, not the thing asked about.** Two consecutive fixes to a timeline-ordering defect were rejected because the reviewer scanned *every* timestamp tie in the live database rather than the pair under discussion. Neither flaw was visible in the diff.
- **Verifying against the browser's own accessibility tree** over CDP, cross-checked against a second independent ARIA implementation, before dismissing a static analyser's findings as false positives.
- **Proving the mechanism, not the outcome.** To approve a fallback fix, the reviewer disabled every live-update handler, watched the suite still pass at exactly the fallback's timing signature, then removed the fallback and watched the original failure return.

### 11.7 The most instructive sequence

One defect took **three implementations, three reviews and a spec gate** to fix correctly.

Derived facts reused their trigger's timestamp, so timeline entries tied, and ties broke on a random id — 7 of 8 compensated orders rendered the cancellation *before* the stock release that caused it, on the page a reviewer would look at.

1. **Attempt one deleted the failing assertion** and marked the requirement done. The assertion had been a faithful transcription of the requirement; it failed because the system violated it.
2. **Attempt two added a tiebreak derived from a status ranking.** It fixed the case it targeted and broke a different one *deterministically* — a status ordering is not a causal ordering, and a status-bearing fact can cause a status-less one. It took a case luck had been getting right and made it certainly wrong.
3. **The eventual fix orders ties by an edge the producer records**, not one the reader infers.

The lesson, and it generalises: **a rule that must be kept true by a human is a rule that will eventually be false.** The only way to find out which is to probe data nobody thought to ask about.

### 11.8 Tooling judgement

The first static scan found 32 bugs and vulnerabilities: **20 real, 12 noise.** Nine flagged a database driver's own query syntax; three flagged a component library's composition. Taking the tool's word would have meant "fixing" correct code; dismissing it wholesale would have left 20 real defects. The work was telling them apart — and the same scan then caught a regression the fix itself introduced, which is the argument for having such a tool *in the loop* rather than *in charge*.

Other standing decisions: TypeScript 7 evaluated and rejected on reproducible evidence (a required tool cannot load it); every Kafka topic and every API type derived from `specs/shared/`, never hand-maintained; the reviewer has rejected features on first pass with real defects behind confident reports.
