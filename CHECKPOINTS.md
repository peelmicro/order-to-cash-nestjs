# CHECKPOINTS — session-close criteria

> In multi-agent systems you do not evaluate the path, you evaluate the destination. These are objective checkpoints a judge — human or AI — can walk to decide whether the project is healthy. The `reviewer` agent walks C1–C7 and refuses to close a session while any box in an applicable section is empty.

## C1 — The harness is complete

- [ ] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [ ] `progress/current.md` and `progress/history.md` exist.
- [ ] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [ ] **Every agent definition declares its model** — either `model:` in the frontmatter, or a description stating it deliberately inherits the session model.
- [ ] `./init.sh` exits 0.

## C2 — State is coherent

- [ ] At most **one** feature `in_progress` in `feature_list.json`.
- [ ] Every status is in `rules.valid_status`.
- [ ] Every `done` feature has passing tests associated with it.
- [ ] `progress/current.md` describes the active session or holds only the template — never leftovers from a previous session.
- [ ] Every `blocked` feature records *why* it is blocked.

## C3 — Architecture is respected

- [ ] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder — verified by ESLint, not by eye.
- [ ] No cross-service database access: no service reads another service's schema, and no foreign key crosses a service boundary.
- [ ] No shared runtime code beyond `packages/shared-kernel` and `packages/contracts`.
- [ ] `packages/shared-kernel` still has zero runtime dependencies.
- [ ] Every inter-service interaction is classifiable as Kafka-fact or NATS-RPC per the decision matrix — no Kafka-as-request-bus, no RPC-for-facts.
- [ ] No stray debug logging, no context-free TODOs.

## C4 — Verification is real

- [ ] `pnpm quality` (lint + typecheck + test) passes.
- [ ] Domain tests are pure — no framework imports, no DB, no broker.
- [ ] Integration tests use Testcontainers against real MySQL / Kafka / NATS / MongoDB — not mocked brokers.
- [ ] Coverage thresholds met: **≥80% domain layer, ≥60% overall**.
- [ ] **No Jest anywhere in the monorepo.** Vitest is the only runner.

## C5 — The session closed cleanly

- [ ] No suspicious untracked files (`*.tmp`, build output outside `.gitignore`).
- [ ] `progress/history.md` has an entry for the feature just finished, **including its effort record** (sessions, wall-clock).
- [ ] `feature_list.json` reflects the true state of every feature touched.
- [ ] The human has been told **what was done** and **how to test it manually**.
- [ ] **Claude did not commit.** The commit is the human's, after testing.

## C6 — Spec-Driven Development

- [ ] Every `"sdd": true` feature in `spec_ready`, `in_progress`, `in_review` or `done` has `specs/<name>/` with all three of `requirements.md`, `design.md`, `tasks.md`.
- [ ] `requirements.md` uses strict EARS notation, every requirement carrying an `R<n>` id.
- [ ] Every `done` sdd feature has all its tasks ticked `[x]` in `tasks.md`.
- [ ] Every `R<n>` is covered by at least one concrete named test, recorded in `specs/shared/test-matrix.md`.
- [ ] The spec commit **precedes** the implementation commit in git history.

## C7 — Trilogy reusability (assessment #7 only)

- [ ] `specs/shared/` contains no NestJS, Drizzle, Nuxt or MySQL specifics — assessment #8 can start from it unchanged.
- [ ] `n8n/workflows/*.json` reference only the Gateway REST API — no database, no broker — so they port to #8 and #9 with a base-URL change.
- [ ] `progress/history.md` effort records are complete and honest.

---

**How to use this file:** the `reviewer` agent walks each box, marks `[x]` or `[ ]`, and rejects the close if any applicable box is empty. Sections C3–C4 only apply once application code exists (phase 5 onwards); C6 only once a `sdd: true` feature has started (phase 8 onwards).
