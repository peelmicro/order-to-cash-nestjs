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
| `feature_list.json` | "What is happening right now?" — the backlog state machine | 38 features, 8 `sdd: true`. Max one `in_progress`, enforced by `init.sh`. Only the reviewer sets `done` | Phase 2 | every feature transition |
| `init.sh` | "Is the world sane?" — the session circuit breaker | Exit ≠ 0 ⇒ do not advance. Checks env, harness files, agent model declarations, backlog coherence, SDD coherence. Adversarially verified | Phase 2 | Phase 2 |
| `CHECKPOINTS.md` | "Am I actually done?" — objective close criteria | C1–C7; the reviewer walks them; C7 covers trilogy reusability | Phase 2 | Phase 2 |
| `.claude/agents/*.md` (×5) | Role separation with different powers and cost tiers | Each declares model + tools; reviewer deliberately read-only; test_maintainer deliberately bash-less | Phase 2 | Phase 2 |
| `progress/current.md` | Working memory of the active session | Updated at every status transition, in lockstep with the backlog — the reviewer checks this (C2) | Phase 2 | every session |
| `progress/history.md` | Append-only log + **per-feature effort records** | The baseline for the trilogy benchmark (#8/#9 are measured against these numbers) | Phase 2 | every feature close |
| `progress/impl_*.md` | The implementer's own report per feature | What was built, evidence, deviations, what the review later caught | Phase 4 | every feature |
| `progress/review_*.md` | The reviewer's verdict per feature | Probes with real output, defects with file/line/why, CHECKPOINTS walk. Includes two full rejection→fix→approve cycles | Phase 4 | every feature |
| `progress/spec_*.md` | The spec author's record per spec pass | Contains the **ambiguity-resolution tables** — what the human gate actually reviews | Phase 3 | Phase 3 |
| `specs/shared/` (7 files) | The system's definition, before the code | Stack-agnostic; reused verbatim by assessments #8 and #9. AsyncAPI drives real topic creation; both API docs drive type generation | Phase 3 | Phase 3 (amendments via the human gate) |
| `specs/shared/test-matrix.md` | Requirement → test traceability | 61 rows; flipped from `TODO` to green as features land | Phase 3 | Phase 5 |
| `specs/<feature>/` | Per-feature triple-doc for the 8 large features | requirements (EARS) + design + tasks; human gate between spec and code | Phase 8 (planned) | — |
| `docs/PROCESS.md` | This document | Updated at the end of every phase — registry + status | Phase 6 | Phase 6 |
| `README.md` | Honest front door at every commit | Grows incrementally each phase; never describes software that does not exist yet | Phase 1 | every phase |
| `docker-compose.infra.yml` + `infra/` | The runnable infrastructure | 10 pinned services + SonarQube behind a profile; `kafka-init` derives topics from the AsyncAPI spec | Phase 4 | Phase 4 |
| `.env.example` | Every credential, port and flag, documented | Extended whenever a feature adds configuration | Phase 4 | Phase 7 |
| `package.json` (root) | Workspace scripts + exact `packageManager` pin | The exact pin matters: corepack rejects ranged pins outright | Phase 4 | Phase 7 |

---

## 10. Where the project is right now

> Maintained at the end of every phase. History of *how* each phase went lives in `progress/history.md`; this is only the current position.

**Position: Phase 7 of 25 complete — 12 of 38 features done.**

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
| 8–15 | Services, saga, reliability, observability — the `sdd: true` heart of the build | pending |
| 16–19 | Web app + all test layers | pending |
| 20–25 | n8n workflows, quality gates, dashboards, full compose, documentation, final checkpoint | pending |

Notable so far: the review of the seed feature ran on an explicitly overridden model after the default was twice blocked by an API-side flag — recorded as a one-off process deviation, agent definitions unchanged. Earlier:  TypeScript 7 was evaluated and rejected on reproducible evidence (vue-tsc cannot load it) — the monorepo is on 5.9.3; the reviewer has rejected 2 features on first pass with real defects behind confident reports; every Kafka topic and every API type in the codebase is derived from `specs/shared/`, never hand-maintained.
