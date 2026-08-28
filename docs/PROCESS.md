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

- **`specs/shared/`** holds the system-wide specification, written in Phase 3 before any application code: the domain model and its invariants, the saga with both compensation paths, 61 EARS requirements, an AsyncAPI document (every event and RPC message), an OpenAPI document (the REST contract), a test matrix mapping every requirement to the test that proves it, and the functional spec of the demo workflows. It is deliberately **stack-agnostic** because two sibling assessments (#8 .NET, #9 FastAPI) reuse it verbatim.
- **`specs/<feature>/`** (from Phase 8 onward) holds a per-feature triple-doc for the 8 *large* features only — `requirements.md` (EARS), `design.md` (the stack-specific how), `tasks.md` (an ordered checklist the implementer ticks). These features carry `"sdd": true` in the backlog.
- **The human approval gate**: a spec-required feature stops at `spec_ready` until the human has reviewed the spec's *decisions* (see §6) and approved. No code before approval — and the git history proves the ordering, because the spec commit precedes the implementation commit.

### The honesty clause

SDD costs real ceremony, and for a 50-line feature the ceremony is decorative paperwork. That is why only 8 of this project's 38 features carry `"sdd": true` — the aggregates and state machines, the saga and its compensation, the outbox and idempotency, the read-model projection, and the observability wiring. Everything else skips the triple-doc but still travels the backlog state machine. The spec-becomes-infrastructure moments (Kafka topics derived from the AsyncAPI file, TypeScript types generated from both API documents) are where the spec pays for itself even on small features.

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
| `specs/shared/test-matrix.md` | Requirement → test traceability | 61 rows; flipped from `TODO` to green as features land | Phase 3 | Phase 5 |
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

**Position: Phase 15 of 25 complete, Phase 16 in progress, Phase 23 mostly complete — 31 of 41 features done** (the web app now has auth, place-order, order-list and order-detail/SSE working and independently reviewed; stock view, billing view and the error-handling sweep remain. Every web-app pass since the first has gone through the same adversarial review the backend has had since feature 27 — see the note below).

| Phase | What | State |
|---|---|---|
| 1 | Environment & repository | ✅ |
| 2 | Harness layer | ✅ |
| 3 | Shared specification (`specs/shared/`, 61 EARS requirements, both API contracts) | ✅ |
| 4 | Infrastructure compose (10 pinned services) + spec-derived Kafka topology | ✅ |
| 5 | Monorepo scaffold, shared-kernel (100% coverage), spec-generated contracts | ✅ |
| 6 | Drizzle schemas + migrations for the three service databases, Testcontainers suites | ✅ |
| 7 | Deterministic seed job (four stores, valid GLNs, pre-published outbox history) | ✅ |
| 8 | Orders service + saga orchestrator — first `sdd: true` features through the full spec loop | next |
| 8 | Orders service — aggregate, outbox/idempotency, acceptance, and the saga orchestrator (the centrepiece: `@nestjs/cqrs` over durable `saga_commands`, both compensation paths, park-then-recover) | ✅ |
| 9 | Fulfillment — stock reservations and DESADV creation. The saga now advances across two services unattended | ✅ |
| 10 | Billing — buyer credit, the `.99` simulator, invoicing and remittance intake. The order-to-cash cycle now runs end to end: an order reaches `completed` across three services, unattended | ✅ |
| 11 | Notifications — the first service with no aggregate, proving the fact stream is self-describing. Seven templates render from the envelope alone | ✅ |
| 12 | Projector — the MongoDB read model. Every fact from three services into one timeline document per order, idempotent by a key that lives in the write's own filter | ✅ |
| 13 | Gateway / BFF — 18 REST paths, JWT, the SSE stream, and a post-approval fix so a client's resume cursor never points at a heartbeat | ✅ |
| 14 | Reliability + observability — retry with backoff, dead-letter (the actual fix for the Phase 12 poison-pill incident), OTel tracing, structured logging, metrics, health checks. Six implementer passes, the largest feature in the project, zero blocking findings on review | ✅ |
| 15 | End-to-end saga verification — real spawned services, not in-process Testcontainers. Redundant idempotency independently re-proven by the review with different arms than the implementer's own. `stock_rejected` closed by discovering the obvious test scenario was wrong — the real mechanism is a genuine check-then-reserve race. README's DLQ walkthrough remains the one open item | ✅ |
| 16 | Web app (Nuxt 4) — auth (JWT never reaches the browser), place-order, order-list, and order-detail with a live SSE saga timeline, all live against the real Gateway and independently reviewed. Stock view, billing view and the error-handling sweep still open | 🚧 |
| 17–19 | Web component tests, API tests through the Gateway, Playwright end-to-end tests | pending |
| 20–22 | n8n workflows, quality gates, dashboards | pending |
| 23 | Full Docker Compose — all 7 application services containerized on top of the existing infrastructure compose, live-verified (built, migrated, healthy, seeded from a cold cycle), every container running non-root as uid 1000, and the CLI-apps/compose-infra alternative mode re-verified | ✅ |
| 24–25 | Documentation, final checkpoint | pending |

Notable so far: two of this phase's findings came from the human operating the system, not from any agent or test. He noticed that stopping the whole stack never freed the memory he expected, and that one container survived every teardown. Both had precise, checkable causes. The survivor was profile-gated, so Compose excluded it from the model entirely rather than skipping it — and the teardown and inspection scripts, unlike the startup script, never activated that profile, so `down` genuinely could not see it and `ps` genuinely could not report it. Start and stop had been operating on different sets of services since the phase was written. The memory was a separate cause: Docker Desktop on Linux runs everything in a VM, and that VM held 20.2 GB of host RAM to run containers actually using 5.1 GB — and kept holding it after the containers stopped, which is exactly why his habit of tearing the stack down had stopped helping. Switching the CLI to the native Engine reclaimed 20 GB and, incidentally, dissolved a documented confusion this repository had carried for phases (integration tests and the compose stack running against different daemons). The pattern worth naming is on the assistant's side: in the same conversation it twice manufactured a cautious-sounding tradeoff — reasons not to change a script — and both evaporated the moment anything was actually checked, because neither had been. Caution that has not been verified is not caution, it is just a guess wearing its clothes. Earlier: the most instructive finding of the container-hardening pass was about a *claim*, not about code. An implementer deviated from its brief's literal command and justified it with a specific, confident, file-and-line-cited assertion — that a committed cleanup script would destroy an unrelated long-running container and its data as collateral. The leader believed it and relayed it to the human as a real defect in a script committed hours earlier. It was false. The reviewer did not reason about it; it tested it, on the merged model and then in an isolated throwaway project reproducing the same shape, and found the opposite. The underlying verification still stood — only the reason given for deviating was wrong. The correction was left visible in the progress file rather than silently edited, because that file is copied verbatim by two sibling assessments, and a confident unverified claim propagating into both is exactly what review exists to stop. A citation is not evidence: the reviewer's advantage here was not being more careful, it was running the command. Earlier: the web app's second and third passes closed the review gap the first one had, and both found real bugs precisely because of it. The order-detail/SSE page's first review pass rejected it over a defect the implementer's own live testing had surfaced but not diagnosed — an intermittent stuck timeline in 1 of 3 manual runs. The cause: the projector stamps the *same* event id on a fact's paired `order.updated` and `timeline.appended` frames by design, but the client's redelivery-dedup used one shared set across both frame types, so whichever frame a NATS-subject race delivered second was silently dropped as an already-seen duplicate — fixed by scoping dedup per frame type, re-armed both directions, re-reviewed and approved. The following pass found that Nuxt's own SSR/hydration timing meant the login and place-order forms could be submitted natively before the client had hydrated, and because the form has no `action` attribute, that meant a bare page-load click could `GET`-submit the password into the URL query string — not merely look stuck, as it first appeared. A later pass found the same shallow display bug in two different fields at once (a currency amount shown and accepted as raw integer minor units instead of a decimal), because both had been copy-built from the same wrong pattern; the fix's correctness hinged on one specific round-trip value (a `.99` amount converting to exactly the integer a separate feature's demo depends on), which the review re-verified with its own independent arithmetic rather than trusting the implementer's tests to have covered it. Separately, a live-reproduced saga defect — a terminal business rejection retried 80+ times before parking permanently, because the wire already distinguished terminal from transient failure and the adapter simply never checked which — was found not by a planned test but by operating the web app, and its fix was reviewed twice (rejected once on an unrelated dependency-scope finding). And a full application-container Docker Compose deliverable, the first of its kind in this repository, found two of its own defects only by actually booting the stack rather than by writing correct-looking configuration: a runtime file path the gateway needed copied into its image, and a cross-app source dependency the seed job needed that wasn't obvious from its own `package.json`. A late investigation into why a freshly reset order list looked dominated by cancelled orders is its own small lesson in not trusting the first plausible explanation: the actual cause, confirmed against the literal event payloads rather than inferred, was the system's own documented `.99` demo-compensation rule working exactly as specified, plus a separate and genuine credit-limit exhaustion from months of shared test usage — neither one a bug, both requiring the data to actually be queried before being believed. Earlier: the project's one unreviewed feature was also its first bug. Every backend feature in this project has gone through an adversarial reviewer before being reported done; the web app's first pass did not, and its own verification claimed to have "placed a real order through the UI" when what actually ran was a direct API call that never rendered a component or clicked a button. The gap that distinction hid was real: the submit button was permanently disabled from the moment the page loaded, before anyone had clicked anything, because a template read a reactive value without unwrapping it — a mistake neither of the project's two static checks was capable of catching, since one has a documented blind spot for exactly this pattern and the other doesn't check this file type at all. Only a person clicking the real button found it. The fix took one line per file; the lesson is that the discipline this project has run on the backend since feature 27 has to apply to the frontend too, not that the frontend is somehow exempt because it looks simpler. Earlier: closing two small, long-tracked contract gaps needed a third gap closed first — an RPC subject that had simply never been built, discovered live when a correctly-structured cancellation branch had nothing to call. Adding it surfaced that the domain-layer logic to handle it had already existed for phases, unused, waiting for exactly this wire to be connected. Fixing it also meant touching the shared dispatch machinery every saga-driven feature in the project depends on, which is precisely the kind of change this project no longer accepts on a single implementer's word — an independent review re-ran every pre-existing saga suite unmodified before approving, and in doing so reproduced, live and twice, a materially worse consequence of a race nobody had prioritised fixing. It still isn't fixed; it's tracked, named, and traceable to the exact two lines of the exact file responsible, which is the more honest position of the two. Earlier: a review that re-proved this project's strongest claim using arms the implementer never chose. Four independent defensive layers were claimed to guard against duplicated work on message redelivery; the implementer disabled them in one combination and confirmed the failure, and the review disabled a *different* combination and got the identical result. That is a stronger form of confirmation than re-running the same test twice — it is two independent people finding the same wall from different directions. The same wrap-up also found what three implementer passes and one review did not: the plan document's own older checklist asked for a compensation path the newer, narrower acceptance criteria never named, and it went untested the whole way through. A widened scope can still miss what a more detailed one already asked for, and the only way to catch that is to read the original document again at the end, not just the criteria that replaced it. Earlier: a review that ran real mutations against six independently-authored implementer passes and found every single injected failure reproduced exactly what had already been claimed — the first review at this scale to clear that bar without finding one vacuous guard. The same phase also produced the opposite lesson in miniature: an implementer disclosed, honestly, that it had narrowed a "every line" requirement to three call sites out of several — and the disclosure was true but the row still got marked complete anyway, until a second read of the actual remaining code found two more lines that mattered more than the three that got attention, including the exact diagnostic line a dead-letter mechanism exists to make debuggable. Honest disclosure of a narrowed scope is not the same thing as the requirement being met, and both need checking separately. Earlier: two rejections in the same phase, from the same root cause stated twice. Both times a test claimed, in its own header comment, to exercise something it did not — the real wire protocol once, the real compiler the second time — and both times that false claim was precisely why nobody looked closer. And after the phase's own review had approved everything, a plain manual test — reconnect an event stream, copy one id, copy another — found that a five-times-a-minute heartbeat was quietly defeating the one guarantee the feature existed to provide, in a way three rounds of automated review never touched, because nothing in the suite ever asked what a real browser actually remembers. Earlier: the worst defect found in this project was invisible to a full test suite because two halves of one conversation were each tested only against the dialect they preferred. A service accepted requests in two formats; the caller spoke one, the responder had been configured for the other, and the result was that a request **succeeded** — the work was done, the record written — and then returned a failure to the caller, who would reasonably retry and do it all again. Every test passed throughout. The test that should have caught it carried a comment asserting it exercised the real protocol, and that comment was the reason nobody looked. It was found by an independent reviewer speaking the production format to a running service rather than reading anyone's report, and it was fixed by making the test import the real configuration instead of restating it — so the two can no longer drift apart. Earlier: the strongest and the weakest results in the project arrived together. A read model's deduplication was attacked with twelve independent database connections racing the same event against a document that did not yet exist, eight rounds, and produced exactly one entry every time — then proved the *negative*, tracing the commands actually issued to show the vulnerable read-then-write is not merely well-behaved but absent. The same week, running the system by hand turned up a single malformed test message someone had published onto a real topic during verification, which one service could not parse; its consumer retried forever and the whole workflow was dead behind it. The tooling had classified that message as cosmetic. The lesson is not about either result alone: adversarial probing catches what it is pointed at, and only running the thing catches what nobody thought to point at. Earlier: a test that had been guarding nothing for six phases was found and fixed. A parity check written to prove five copies of a critical pattern had not diverged turned out to read only their leading comment — a reviewer replaced an entire implementation with a body that did nothing at all, left the comment intact, and the guard passed every case. Its own service's tests caught the sabotage; the guard built for exactly that saw none of it. Worse, whether a service was checked at all depended on a file the implementer chose whether to create, so any service could quietly exempt itself, and the next one in the build order would have. It is now behavioural — the implementation is imported and executed against five assertions, the decisive one being that a component rebuilt from scratch over the same storage still recognises what it already handled. That is the case that would have caught the defect that exposed it, on day one. Earlier: the order-to-cash cycle now runs end to end — placed, stock reserved, credit approved, confirmed, despatched, invoiced, paid, completed — across three services with no human in the loop after the first request. Closing it exposed something the earlier phases could not: payment is the first trigger that originates **outside** the saga, and the system identifies an order by an internal id that an external payer has no way to know. A payment registered without it is accepted, the invoice is marked paid, and the order silently never advances — a success-shaped reply hiding a stalled workflow. The gap is recorded against the phase that will have to close it rather than patched where it was found. Earlier: a specification pass found a defect in code that had already shipped — an invoice's total diverged from the order total whenever an order carried a discount — and the live database turned out to contain two wrong invoices while the gate was still debating whether the case was reachable. The fix also proved to be inherently non-retroactive: saga command payloads are frozen when enqueued, so already-parked commands replay the old shape, and no test could see it because every test exercises the payload builder rather than the stored payload. The same feature produced a rule about evidence: a test asserted that a database counter was unchanged and claimed this proved a request had been rejected before any transaction opened — but a transaction that opens, increments and rolls back leaves the counter equally unchanged, as the reviewer demonstrated by removing the check and watching the suite stay green. **An assertion that a rolled-back side effect did not happen proves nothing about whether it was attempted.** Earlier: the process produced its first fully unattended cross-service result — orders parked since the orchestrator was built unparked by themselves once the responder existed, advanced through real facts, and parked again at the next missing service. The same feature's mutation probe found a defect only integration could see (a despatch header persisted without its lines passed all 75 unit tests), and a reviewer rollback probe demonstrated the dual-write the outbox pattern prevents by producing an orphan fact for an order that did not exist. Briefing conventions adopted mid-phase cut the implementer's cost by roughly a third on comparable scope. Earlier: the first service outside Orders was rejected at review over a defect found by an *unplanned fifth* mutation probe — a correctly-implemented rule ("a re-reserve after compensation must not double-book") that no test guarded, so nothing would have caught its removal. Correct code with no guard is still a defect. Its spec pass also produced two findings rather than design choices, both from reading the installed framework instead of assuming it behaved as expected: the NATS wire would have silently treated requests as events and never replied, and the order id was not on the wire at all. Earlier: the saga orchestrator went through a human overrule at its spec gate — the spec author declined the mandated CQRS package on technical grounds; the human ruled that demonstrating the mandated stack is the point, and the revised design layers it over the durable machinery so nothing was weakened. The same feature was reopened once after approval, when the human's own full-suite runs caught a racy test assertion (polling a state the correct saga leaves within one poll interval); the fix synchronises on durable records, was verified with five isolation runs, two full-suite runs and two independent regression probes, and produced a binding pattern ruling for the remaining service features. Earlier: order acceptance was rejected on first review over a surviving mutation — swapping the reply's `totalAmount` for `initialAmount` passed every test because none used a non-zero discount, a hole that would have silently broken the `.99` compensation demo downstream. The same review surfaced a dev/prod divergence: the dev runner (`tsx`) does not emit the decorator metadata NestJS DI relies on, so identical source behaved differently under `pnpm dev` and production, invisible to every test; all six services' dev scripts moved to `tsc-watch`, a convention landed in `CLAUDE.md`, and both an ESLint rule and a config-guard test now hold the fix in place. Earlier: a verification lesson worth recording — the integration suites' disposable containers were invisible to `docker ps` on a machine running two Docker daemons (the CLI follows its active *context*; Testcontainers falls back to `/var/run/docker.sock`). Three rounds of "watch it happen" failed before the cause was found by instrumenting the container start directly. The tests were real all along, but "I could not see it" is the right response to an unverifiable claim, and chasing it was cheaper than trusting it. Also: the first full SDD loop (spec → human gate → implement → review) ran in Phase 8 and surfaced two genuine earlier-phase defects before any code was written — a database column missing against the domain model, and undeclared workspace dependencies that would have broken a clean clone. A third was found during implementation: a `.gitignore` pattern intended for Docker bind mounts also matched a source directory, silently keeping 11 files out of version control across two commits. All three are fixed; the last is the clearest argument in this repository for why review probes the system rather than reading reports. Earlier: the review of the seed feature ran on an explicitly overridden model after the default was twice blocked by an API-side flag — recorded as a one-off process deviation, agent definitions unchanged. Earlier:  TypeScript 7 was evaluated and rejected on reproducible evidence (vue-tsc cannot load it) — the monorepo is on 5.9.3; the reviewer has rejected 2 features on first pass with real defects behind confident reports; every Kafka topic and every API type in the codebase is derived from `specs/shared/`, never hand-maintained.
