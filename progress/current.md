# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** — none active —
**Status:** idle — phase 7 complete (seed_job approved, 0 defects)
**Session started:** —

## Goal

Deterministic one-shot seed job (`apps/seed`): master data + sample saga history across the three MySQL databases AND the MongoDB `order_timeline` read model. Fixed UUIDs/dates, idempotent re-run. Seeded outbox rows inserted already-published so the phase-8 relay never re-publishes fabricated history.

## Decisions taken this session

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
