# AGENTS.md — Navigation map for AI agents

> This file is the **entry point** for any agent working in this repository. It is not a rulebook — it is a **map**. Read only what you need, when you need it (progressive disclosure).

---

## 1. Before you start (mandatory)

1. Run `./init.sh` and check it exits 0. If it fails, **stop** and fix the environment before touching anything.
2. Read `progress/current.md` to see where the last session left off.
3. Read `feature_list.json`. Any feature with `"sdd": true` goes through **Spec-Driven Development** — see §4.
4. Read `CLAUDE.md` for the project conventions before writing code.

## 2. Repository map

| File / folder | What it holds | When to read it |
|---|---|---|
| `feature_list.json` | Backlog with state machine (`pending` / `spec_ready` / `in_progress` / `in_review` / `done` / `blocked`) | Always, at the start |
| `progress/current.md` | State of the active session | Always, at the start |
| `progress/history.md` | Append-only log of finished features, **with effort records** | For historical context |
| `progress/impl_<feature>.md` | Implementer's report for one feature | When reviewing |
| `progress/review_<feature>.md` | Reviewer's verdict for one feature | When closing a feature |
| `specs/shared/` | Stack-agnostic spec reused verbatim by assessments #8 and #9 | Before designing anything |
| `specs/<feature>/` | Triple-doc (`requirements.md` EARS + `design.md` + `tasks.md`) | Before implementing any `"sdd": true` feature |
| `CLAUDE.md` | Leader role + project conventions (layering, naming, money, testing, commits) | Before writing code |
| `CHECKPOINTS.md` | Objective "is this session closeable" criteria | To self-assess before closing |
| `docs/PROCESS.md` | The full process guide: harness + SDD concepts, the cast, the loop, EARS, the artifact registry, current status | To understand or replicate the process; **updated at the end of every phase** |
| `.claude/agents/` | Subagent definitions (leader, spec_author, implementer, reviewer, test_maintainer) | When orchestrating work |
| `apps/` | The 6 services + the Nuxt web app | To implement |
| `packages/` | `shared-kernel` (dependency-free) and `contracts` (generated types) | To implement |
| `infra/`, `docker-compose*.yml` | Infrastructure | For environment work |

## 3. Hard rules (non-negotiable)

- **One feature at a time.** At most one `in_progress` in `feature_list.json`.
- **Never mark a feature `done` without green tests.** Tests are written *inside* the feature loop, not at the end of the project.
- **Never skip the spec phase.** Any feature with `"sdd": true` goes through `spec_author` and human approval before code is written.
- **Never skip the human approval gate** between `spec_ready` and `in_progress`.
- **Never run `git commit` or `git push`.** Report what was done and how to test it; the human commits. See `CLAUDE.md` § Commit discipline.
- **The domain layer imports nothing.** No NestJS, Drizzle, Kafka, NATS or MongoDB inside any `domain/` folder — enforced by ESLint, not by good manners.
- **Document as you go** in `progress/current.md`, not at the end.
- **If you do not know something, read `specs/` or `CLAUDE.md`** before inventing it.

## 4. Workflow (SDD)

```
pending → [spec_author] → spec_ready → ⏸ HUMAN APPROVES → in_progress
        → [implementer] → in_review → [reviewer] → done
                                          │
                                          └─ rejected → back to in_progress
```

1. The leader picks the first non-`done`, non-`blocked` feature.
2. If `"sdd": true` and status is `pending` → launch `spec_author`, which writes `specs/<name>/{requirements,design,tasks}.md` and sets `spec_ready`.
3. **Pause.** The human reads the spec and approves or requests changes.
4. On approval → status `in_progress`, launch `implementer`, which works from the spec (not from the original `acceptance` list).
5. Implementer finishes → status `in_review`, launch `reviewer`.
6. Reviewer verifies `R<n>` ↔ test traceability and that `tasks.md` is complete, then approves (→ `done`) or rejects (→ back to `in_progress`).
7. On `done`: append the summary **and the effort record** to `progress/history.md`.

Features with `"sdd": false` skip steps 2–3 but still traverse the state machine.

## 5. Closing a session

1. Run `./init.sh` — all green.
2. Update `feature_list.json` to the true status.
3. Move the `progress/current.md` summary to the end of `progress/history.md`, including the **effort record** (sessions, wall-clock).
4. Reset `progress/current.md` to the empty template.
5. No temp files, no debug logging, no context-free TODOs.
6. Meet every box in `CHECKPOINTS.md`.
7. Report to the human what was done and how to test it — **do not commit**.

## 6. If you get stuck

- Re-read the relevant part of `specs/` or `CLAUDE.md`.
- If a tool does not behave as expected, **do not invent a workaround**: record the blocker in `progress/current.md`, set the feature to `blocked` with a reason, and stop the session.
