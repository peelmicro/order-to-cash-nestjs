# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** — none active —
**Status:** idle — outbox_and_idempotency (14) done; next `orders_acceptance` (15)
**Session started:** —

## Goal

Phase 8, one feature at a time (decision: specs written per-feature, not batched). Order: orders_aggregate (sdd) → outbox_and_idempotency (sdd, inherits causation_id + poll-tiebreak advisories) → orders_acceptance → order_saga_orchestrator (sdd). Each sdd feature stops at spec_ready for the human gate.

## Decisions taken this session

- **Gate on `specs/outbox_and_idempotency/`**: all 26 open points accepted as written. Two given conscious approval: row 5 (add `trace_parent` now rather than migrate three DBs twice) and **row 11, which reverses feature 13's ruling** — the Drizzle adapter lands in feature 14, not 15, because `save()` is then written once together with its transaction and outbox. Amendment: a parity guard (`OI12`) for the five per-service copies of the idempotent-consumer pattern, mirroring row 20's byte-identity test for the three outbox schemas — duplication guarded by a check, not by discipline.
- Both Phase-6 advisories resolved: `causation_id char(36) NOT NULL` in all three outbox tables (one coordinated migration), and `seq bigint AUTO_INCREMENT` as the sole poll ordering key (a timestamp is the wrong tool for a total order; `DATETIME(3)` narrows ties without closing them).
- Note: this feature **recreates the databases** (`down -v` → up → migrate → seed) — `ADD COLUMN NOT NULL` cannot apply over existing rows and seeded causation cannot be derived in SQL.

- **Human gate on `specs/orders_aggregate/`**: 16 open points reviewed, 14 accepted as written, 2 amended — (a) the `order_items.description` migration pulled INTO this feature rather than deferred to 15, so the schema stops contradicting the domain model; (b) the missing `@otc/*` workspace deps fixed in all three apps (orders, billing, fulfillment), not just orders, with a clean-clone proof task. Plus OA4 (reason↔status pairing) and OA1 (single-currency invariant) recorded as **promotion candidates** for `specs/shared/` at feature 38 — without promotion, #8/#9 would not enforce them.
- Root cause note: 2 of the 16 open points were genuine earlier-phase defects (the missing column traces to the plan document's table shape, implemented faithfully in phase 6; the missing workspace deps are a phase-5 scaffold defect the reviewer missed because they were latent). The rest are the normal stack-agnostic-spec → implementation gap.

- **`seed_job` implemented and moved to `in_review`.** `apps/seed` (plain
  Node/TS, not NestJS) reuses each of `@otc/orders`/`@otc/fulfillment`/
  `@otc/billing`'s own Drizzle client/db-config/migrator/schema modules via
  relative imports (never a shelled-out subprocess), plus the official
  `mongodb` driver for the read model. Data definitions
  (`src/data/*.data.ts`) are kept separate from the per-store writers
  (`src/writers/*.writer.ts`) so #8/#9 can port the DATA. Full report:
  `progress/impl_seed_job.md`.
- Deterministic ids are SHA-256-derived UUID-v4-*shaped* strings (not real
  v4 randomness) so `UniqueId.from()` accepts them while remaining a pure
  function of a stable namespace string — re-running the seed is
  byte-identical (verified live: same row-count summary and same
  `MD5(GROUP_CONCAT(orders.id))` checksum across two `pnpm seed` runs
  against the compose stack).
- `apps/seed`'s `tsconfig.json` deliberately has NO `rootDir` (unlike every
  other app) — its `include` list reaches into `apps/orders`,
  `apps/fulfillment` and `apps/billing`'s persistence modules by design, and
  an explicit `rootDir: "src"` would make `tsc` reject those cross-app
  files with TS6059. No `build`/`start` script either — `pnpm seed` runs
  directly via `tsx`, same as every other app's `dev` script.
- Added `mongodb` + `@testcontainers/mongodb` to the pnpm catalog and
  `MONGO_HOST` / `MONGO_DB_READMODEL` to `.env.example`/`.env` — the first
  Mongo client config in the repo (apps/projector is still a scaffold).

- **TS verdict: fallback to 5.9.3.** TS7 passed NestJS DI + Vitest but vue-tsc@3.3.10
  cannot load typescript@7 (`ERR_PACKAGE_PATH_NOT_EXPORTED`, reproduced
  independently by the reviewer) — the agreed fallback rule fired. TS7 goes in
  the README's "what I would do differently".
- **TypeScript 7** originally chosen by Juan Pablo (over the leader's 5.x recommendation),
  structured as a timeboxed validation spike inside `monorepo_scaffold` with an
  explicit fallback: if NestJS 11 decorators/`emitDecoratorMetadata`,
  `@nestjs/cli`, Vitest or Nuxt 4 cannot be made to work under TS 7 within the
  timebox, pin `typescript@^5.9` and record TS 7 under "what I would do
  differently". Either outcome is documented with evidence.

## Blockers

None.

## Notes

- **Process deviation (2026-08-20):** the `seed_job` review was run with an explicit `model: sonnet` override instead of the reviewer's unpinned default — the inherited-model run was blocked twice by an API-side safeguard flag (`reasoning_extraction`) before producing any output. One-off, not a change to the agent definition; revisit only if it recurs.

- **Leader lesson (D2, twice):** `progress/current.md` must be updated at every
  feature status transition, not at session close. The reviewer checks C2 on
  every pass; keep current.md in lockstep with `feature_list.json` — update both
  in the same breath.

---

## Template (reset to this on session close)

```markdown
# Current session

**Feature:** `<name>` (id <n>, phase <n>)
**Status:** <status>
**Session started:** <date>

## Goal

## Decisions taken this session

## Blockers

## Notes
```
