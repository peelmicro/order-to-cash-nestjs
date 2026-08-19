# History — append-only log

> One entry per completed feature. **The effort record is mandatory**: this file
> is the assessment #7 baseline for the trilogy benchmark, and the empirical
> comparison that assessments #8 and #9 are measured against. Without honest
> effort numbers here, the benchmark the SDD adoption plan asked for does not exist.

Entry format:

```markdown
## <feature_name> (id <n>, phase <n>) — <date>

**Effort:** <n> session(s), ~<n>h wall-clock
**Spec:** specs/<name>/ | n/a (sdd: false)
**Tests:** <what was added, and the R<n> requirements they prove>

**What was built:**

**Deviations from the spec/plan:**

**Notes for #8 and #9:**
```

---

## repo_bootstrap (id 1, phase 1) — 2026-08-18

**Effort:** 1 session, ~0.5h wall-clock
**Spec:** n/a (sdd: false)
**Tests:** n/a — toolchain phase, no application code yet

**What was built:**

Node.js upgraded 24.15.0 → 24.19.0 (latest LTS Krypton) via nvm with global
packages carried over; pnpm 8.8.0 → 11.22.0 via corepack; repo-local git identity
set to `peelmicro`; `.gitignore`, `.editorconfig`, `.nvmrc` created; placeholder
README replaced with a minimal honest one carrying a 25-phase status table.

**Deviations from the spec/plan:**

- Added `.nvmrc` (not in the plan) for a reproducible Node version per repo.
- Added a minimal README at phase 1 instead of waiting for phase 24, adopting an
  incremental-README rule so a clone at any commit finds an honest document.

**Notes for #8 and #9:**

- Two GitHub accounts are authenticated on this machine; the first push failed
  with 403 because the active `gh` account was the wrong one. Fix repo-locally
  with `git remote set-url origin https://<user>@github.com/...` rather than
  `gh auth switch`, which would change the default for every other repo.
- `pnpm init` (pnpm 11) writes `devEngines.packageManager: "^x.y.z"`, which
  corepack rejects outright — every command fails until an **exact** top-level
  `"packageManager": "pnpm@x.y.z"` is added.
- `typescript@latest` now resolves to 7.x (the native compiler rewrite), not 5.x.
  Decide deliberately; NestJS depends on decorators + `emitDecoratorMetadata`.

## harness_layer (id 2, phase 2) — 2026-08-18

**Effort:** 1 session, ~1.5h wall-clock
**Spec:** n/a (sdd: false — the harness *is* the process scaffolding)
**Tests:** no unit tests (markdown/JSON/bash), but `init.sh` was adversarially
verified against four violation classes — see below

**What was built:**

The full harness layer, ahead of any application code, so the git history shows
process scaffolding first. Twelve files, ~890 lines:

- `AGENTS.md` — entry map: startup protocol, repository table, hard rules, SDD
  flow, session-close procedure.
- `CLAUDE.md` — leader role + binding conventions: Clean Architecture layering,
  domain purity, database-per-service, Kafka-facts vs NATS-RPC, integer minor
  units, snake_case↔camelCase boundary, Vitest-only, coverage gates, commit
  discipline (Claude never commits).
- `feature_list.json` — 38 features, 8 of them `sdd: true`. Six-state machine
  (`pending, spec_ready, in_progress, in_review, done, blocked`). Fine-grained
  for the service phases 8–13, one feature per phase elsewhere.
- `init.sh` — five sections: environment, harness files, backlog coherence
  (Node-parsed), repository state, tests.
- `progress/current.md` + `progress/history.md`.
- `CHECKPOINTS.md` — C1–C7, with C7 added for trilogy reusability.
- `.claude/agents/` — leader, spec_author, implementer, reviewer,
  test_maintainer. Model mapping: leader/spec_author/reviewer unpinned
  (inherit the session model), implementer `sonnet`, test_maintainer `haiku`.
  The reviewer deliberately has **no Write or Edit tool** — it reports, it
  never patches.

**Deviations from the spec/plan:**

- **No `docs/` folder.** The BettaTech reference keeps `architecture.md` /
  `conventions.md` / `specs.md` there; ours would duplicate `CLAUDE.md` and
  `.claude/agents/spec_author.md`, where the agent that needs the EARS process
  actually reads it. `specs/shared/` (phase 3) is the real specification.
- **A fifth agent** (`test_maintainer`) beyond the plan's four, following the
  `ediez-app-2024` pattern of a cheap mechanical test-maintenance tier.

**Verification of `init.sh` (adversarial, not just happy path):**

Deliberately broke the state four ways and confirmed each is caught with exit 1:
two features `in_progress`; an `sdd: true` feature at `spec_ready` with no
`specs/<name>/` triple-doc; an invalid status string; malformed JSON. Restored
and re-ran clean each time.

**Bugs `init.sh` found in itself:**

1. The `head()` helper shadowed `/usr/bin/head`, so `grep '^model:' | head -1`
   called the function and printed `-1` instead of the model name. Renamed to
   `section()`.
2. `leader.md` failed its own model check — its description said the model was
   "whatever the session is using", which is true but not the word the check
   greps for. Reworded to "inherits the session model".

**Notes for #8 and #9:**

- This harness is designed to port unchanged. Only `feature_list.json` (feature
  names/phases) and the stack-specific rows of `CLAUDE.md` need editing; the
  five agents, `init.sh`, `AGENTS.md` and `CHECKPOINTS.md` are reusable verbatim.
- Two `init.sh` checks are worth keeping in any harness: the max-one-`in_progress`
  guard and the SDD coherence check that a spec'd feature past `pending` really
  has its triple-doc on disk. Both catch the failure mode where an agent advances
  state without doing the work.
- Write the harness *before* the code. The ordering is visible in git and is
  itself the evidence the assessment asks for.

## shared_spec (id 3, phase 3) — 2026-08-18

**Effort:** 1 session, ~2.5h wall-clock (2 `spec_author` passes + 1 amendment pass)
**Spec:** this feature *is* the spec — `specs/shared/`
**Tests:** none yet by design; `test-matrix.md` holds 61 `TODO` rows that later
features flip green. Both API documents were machine-validated instead.

**What was built:**

`specs/shared/` — the stack-agnostic specification reused verbatim by #8 and #9.
Seven files, ~7,500 lines, written in two `spec_author` passes as agreed:

- **Pass A** — `domain-model.md` (aggregates, VOs, invariants, both state
  machines, the 13-fact catalogue, the envelope), `saga.md` (happy path, both
  compensation paths, Mermaid diagrams, idempotency rules), `requirements.md`
  (60 EARS requirements across the eight `sdd: true` features).
- **Pass B** — `asyncapi.yaml` (AsyncAPI 3.0.0: 34 channels, 32 operations, 43
  messages), `openapi.yaml` (OpenAPI 3.1.0: 17 paths, 18 operations),
  `test-matrix.md` (every `R<n>` → a named test, all `TODO`),
  `n8n-workflows.md`.
- **Amendment pass** — the three decisions from the human approval gate.

**Closed by the human approval gate, not by the `reviewer` agent** — for the
specification itself the human *is* the reviewer. From phase 8 onward the
`reviewer` agent closes features normally.

**Decisions taken at the approval gate:**

1. **R61 added** for `fulfillment.stock.replenish` — it was the only write
   endpoint with no requirement behind it, and it mutates stock. Specifies
   `units`-only increase, no fact emitted, no order advanced.
2. **SSE fixed in the shared contract.** §10 originally left the real-time
   transport per-assessment while `openapi.yaml` fixed SSE — a genuine
   contradiction. Resolved in favour of the shared contract having no holes;
   WebSocket documented as the alternative.
3. **Payment `source` enum uses `robot`, not `n8n`.** A demo tool name must not
   leak into a domain enum when #8/#9 may drive payments differently.

The other 13 ambiguity resolutions from Pass A (`progress/spec_shared_passA.md`
§4) were reviewed and accepted as a block.

**Deviations from the spec/plan:**

- Split into **two `spec_author` passes** rather than one — seven files including
  two full API documents is too much for a single invocation, and it gave the
  human two smaller things to review.
- The custom agent types were not yet registered in the session that ran passes A
  and B (`.claude/agents/` had been created mid-session), so those passes ran on
  `general-purpose` instructed to read and adopt `spec_author.md`. The amendment
  pass ran on the real `spec_author` type.

**Verification:**

- AsyncAPI 3.0.0 via the official `@asyncapi/parser`: **0 errors, 0 warnings**.
  Note: the `@asyncapi/cli` is currently uninstallable (`@asyncapi/studio-ui@0.5.0`
  404s), so validate with the parser library directly.
- OpenAPI 3.1.0 via `redocly lint`: valid, 8 warnings, each reviewed and
  deliberately accepted (localhost server, health probes with no 4XX, and four
  SSE frame schemas OpenAPI cannot reference from a path).
- R1–R61 contiguous and unique in `requirements.md`, all 61 present in
  `test-matrix.md`.
- Stack-agnostic sweep (`nestjs`, `drizzle`, `nuxt`, `mysql`, `postgres`,
  `kafkajs`, `typescript`, `pnpm`, `varchar`, `jsonb`, `mongoose`): **zero hits**.
- Money never floating-point: **zero hits** for `type: number` / `format: float`.

**Notes for #8 and #9:**

- **This folder is the reuse payload.** Copy it unchanged. The per-assessment work
  starts at `specs/<feature>/design.md`.
- Two defects in the #7 *plan document* were caught by the spec agents, not by a
  human: the NATS subject table omitted `fulfillment.stock.replenish` while the
  REST table referenced it, and the payment `source` enum carried the vendor name
  `n8n`. Writing the spec is what surfaced both — an argument for spec-first that
  is worth citing.
- Ask the spec author to record its **ambiguity resolutions** in a table. Pass A
  found 13; that table, not the prose, is what the human approval gate actually
  reviews, and it is what makes the gate a five-minute job instead of a
  1,500-line read.
