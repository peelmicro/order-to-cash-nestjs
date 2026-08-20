# Review — `monorepo_scaffold` (id 6, phase 5)

**Verdict: APPROVED** (first pass)
**Reviewer:** reviewer agent, 2026-08-19
**Standard applied:** probe, do not trust the transcript. Every claim below was
re-verified independently; the implementer's report was treated as a set of
claims to falsify, not as evidence.

---

## Independent probe results

### 1. TS7 spike verdict — REPRODUCED

Rebuilt the failing leg from scratch in an isolated scratch directory
(`npm install typescript@latest vue-tsc@latest` → `typescript@7.0.2`,
`vue-tsc@3.3.10`, i.e. the exact versions the spike named):

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './lib/tsc' is not
defined by "exports" in .../node_modules/typescript/package.json
    at resolveTscPath (.../vue-tsc/index.js:73:43)
```

Identical error, identical frame (`vue-tsc/index.js:73`). The FAIL is genuine
and upstream. The stated fallback rule ("any FAIL → typescript@^5.9") was
therefore correctly triggered. Scratch directory deleted after capture.

Monorepo TS consistency: `pnpm-lock.yaml` contains exactly **one** typescript
entry (`typescript@5.9.3`, lines 3745/8089); `require('typescript/package.json').version`
resolves to **5.9.3 in all 10 workspaces** (root + 7 apps + 2 packages).
`vue-tsc@3.3.10(typescript@5.9.3)` in the lockfile; `nuxi typecheck` re-run by
me → exit 0.

### 2. Domain-purity rule — probed, including evasion

**Probe 1** (`apps/orders/src/domain/_probe1.ts`): `import { Injectable } from
'@nestjs/common'` + `import { AppController } from '../presentation/app.controller'`
→ `pnpm run lint` fails, **2 errors**, both `no-restricted-imports`, both with
the CLAUDE.md-citing message. Exit 1.

**Probe 2 — evasion** (`apps/billing/src/domain/_probe2.ts`): deep subpath
imports `@nestjs/common/decorators` and a **type-only** import from
`drizzle-orm/mysql-core/table` → **both caught** (2 errors, exit 1). The
`patterns.group` matcher in `eslint.config.mjs:63-73` uses gitignore-style
globs, so `@nestjs/*` covers arbitrarily deep subpaths, and type-only imports
are not exempt. No evasion found.

Both probe files removed; `pnpm run lint` re-run → **exit 0, clean**. No probe
residue (`git status` verified).

### 3. Clean install / build / quality — all green, real output

- `rm -rf` of every `node_modules` (root + all workspaces) → `pnpm install`
  exit 0 (incl. `nuxt prepare` postinstall).
- `pnpm -r build` exit 0 — 6 NestJS apps, 2 packages, full Nuxt production
  build ("Build complete", `.output/` generated).
- `pnpm quality` exit 0 — lint clean, `tsc --noEmit` green on all TS
  workspaces + `nuxi typecheck` green, 6 Vitest suites passing (1 real
  assertion each — e.g. `apps/orders/src/presentation/app.controller.spec.ts`
  asserts the exact `{ service: 'orders', status: 'ok' }` payload; not
  vacuous, would fail on regression), 2 `passWithNoTests` stub runs.

### 4. Boot verification

- `node apps/billing/dist/main.js` → Nest boots, routes mapped, `curl
  127.0.0.1:3004/` → `{"service":"billing","status":"ok"}`. Killed; `ps`
  confirms no survivor, port closed.
- Other five apps: `dist/main.js` present and built green for all
  (gateway/orders/fulfillment/notifications/projector).
- `pnpm --filter @otc/web run dev` → HTTP 200 on `:3000` (WEB_PORT fallback in
  `nuxt.config.ts` verified in source). Killed; `ps` confirms no nuxt process
  survives.

### 5. No Jest

`grep -ril jest` across `apps/`, `packages/`, root `package.json`,
`pnpm-workspace.yaml` (node_modules/build output excluded) → **zero matches**.
Vitest 4.1.11 is the only runner, via `catalog:`.

### 6. Dependency footprint — clean

Root devDeps: eslint, @eslint/js, typescript-eslint, eslint-config-prettier,
prettier, typescript@5.9.3 — all lint/format/compile tooling. Catalog:
@types/node, vitest, @vitest/coverage-v8, tsx, dotenv-cli, @nestjs/{common,core,
platform-express}, reflect-metadata, rxjs, vue-tsc. `apps/web`: nuxt/vue/
vue-router (nuxi template defaults). **No Drizzle, kafkajs, nats, mongodb,
Terminus, Tailwind or shadcn anywhere** (grepped every workspace manifest; the
only "mongodb" hit is the pre-existing `dc:logs:mongodb` compose script).
Every addition has a recorded purpose in `progress/impl_monorepo_scaffold.md`.

### 7. Package stubs are genuine stubs

`packages/{shared-kernel,contracts}/src/index.ts` are both `export {};` plus a
pointer comment to features 7/8. **Zero `dependencies`** in both manifests
(C3: shared-kernel dependency-free holds). No Money/GLN/contract code smuggled in.

### 8. Root manifest / catalog / env

- `"packageManager": "pnpm@11.22.0"` — exact, unchanged.
- `catalog:` references coherent: every workspace uses `"catalog:"` for shared
  tooling; single version per package in `pnpm-workspace.yaml`.
- `.env.example` gained `GATEWAY_PORT=3001` … `PROJECTOR_PORT=3006`,
  `WEB_PORT=3000` (lines 124-130) — matching each `main.ts` fallback exactly
  (spot-checked orders `ORDERS_PORT ?? 3002`, billing boot on 3004, web 3000).
  The messaging_topology lesson ("every var lands in .env.example in the same
  change") did not regress.

### 9. Coverage config — wired, inert, correctly placed

Thresholds live in each workspace's `vitest.config.mts`
(60/60/60/60 for the six apps, 80/80/80/80 for the two packages — matching
CLAUDE.md's ≥60 overall / ≥80 domain tiers). The default `test` script is
plain `vitest run` (no `--coverage`), so thresholds cannot fail today's
near-empty skeletons; `test:coverage` exists for phase 21
(`sonarqube_quality_gates`) to make load-bearing. This is exactly the required
"present but not failing empty projects" shape.

### 10. Harness / infra untouched

`./init.sh` → exit 0. Compose stack: all 11 containers still healthy
(mysql, mongodb, kafka, kafka-console, nats, n8n, otel-collector, jaeger,
prometheus, grafana, sonarqube). `dist/`, `.nuxt/`, `.output/`, `.env` all
gitignored (verified with `git check-ignore`). No suspicious untracked files.

---

## Acceptance criteria → evidence

| Criterion | Verified by |
|---|---|
| `pnpm install` works from root | Probe 3 — clean reinstall from zero node_modules, exit 0 |
| exact `packageManager` pinned | Probe 8 — `pnpm@11.22.0`, no range |
| `no-restricted-imports` fails on a deliberate domain violation | Probe 2 — 2 probes, 4 errors, incl. deep-subpath and type-only evasion attempts; clean after removal |
| `pnpm quality` runs lint + typecheck + test | Probe 3 — `lint && typecheck && test`, exit 0 end-to-end |

## CHECKPOINTS walked

**C1 — harness complete**
- [x] AGENTS.md, CLAUDE.md, CHECKPOINTS.md, feature_list.json, init.sh exist
- [x] progress/current.md and history.md exist
- [x] .claude/agents/ holds all five agents
- [x] every agent declares its model
- [x] ./init.sh exits 0

**C2 — state coherent**
- [x] at most one feature in_progress (zero; id 6 was in_review, now done)
- [x] every status in rules.valid_status
- [x] every done feature has passing verification associated
- [x] progress/current.md describes the active session (monorepo_scaffold, this one)
- [x] no blocked features

**C3 — architecture respected** (first phase where it applies)
- [x] no forbidden import in any domain/ folder — verified **by ESLint**, rule
      probed live in both directions (violation fails, removal passes)
- [x] no cross-service DB access (no DB code exists yet; no workspace depends on another)
- [x] no shared runtime code beyond shared-kernel/contracts (both empty stubs)
- [x] shared-kernel has zero runtime dependencies
- [x] Kafka-fact / NATS-RPC classification — n/a, no inter-service code yet
- [x] no stray debug logging, no context-free TODOs (boot logs are deliberate startup lines)

**C4 — verification real** (partially applicable — skeleton phase)
- [x] pnpm quality passes
- [x] domain tests pure — n/a (no domain code yet); the 6 existing specs import only vitest + the controller
- [ ] integration tests via Testcontainers — **not applicable yet** (no DB/broker code); first lands with feature 9
- [ ] coverage thresholds met — **deliberately inert until phase 21** (wired, not enforced; per instructions)
- [x] no Jest anywhere

**C5 — session closed cleanly**
- [x] no suspicious untracked files
- [x] history.md entry with effort record appended (this review)
- [x] feature_list.json reflects true state (id 6 → done)
- [x] human told what was done and how to test manually (impl report §Verification + this file)
- [x] Claude did not commit

**C6** — n/a (`sdd: false`). **C7** — nothing in this feature touches
`specs/shared/` or `n8n/`; effort record complete.

## R\<n\> → test mapping

n/a for this feature: `sdd: false`, and no EARS requirement from
`specs/shared/requirements.md` is implementable at scaffold phase. The
feature's contract is the 4-item acceptance list, mapped above.

## Defects

**Blocking: none.**

**Advisory (do not block close; leader should schedule):**

- **A1 — domain may still import `application/`.** `eslint.config.mjs:74-84`
  blocks relative imports into `infrastructure/` and `presentation/` but not
  `application/`. CLAUDE.md's dependency rule (presentation → application →
  domain, inwards only) makes domain → application equally illegal. Not in this
  feature's acceptance and no domain code exists yet, but the pattern group
  should gain `"**/application/**", "**/application"` before feature 13
  (`orders_aggregate`) starts.
- **A2 — messaging_topology carry-over not yet landed.** history.md (feature 5
  entry) asked for a Testcontainers-Kafka test proving the spec→topology
  derivation "when Vitest lands (feature 6)". Vitest has now landed; the test
  has not. Realistically it belongs with the first Testcontainers feature
  (id 9, `db_orders`) — leader should pin it there explicitly so it does not
  drop a second time.
- **A3 — `.vue` files are unlinted** (`eslint-plugin-vue` absent). Noted by the
  implementer; acceptable until feature 29 (`web_app`), by which point it must
  be wired.

## Effort record (for history.md)

1 session, ~3.5h wall-clock: TS7 spike ~1h (inside its timebox; 2 PASS / 1
FAIL → fallback honoured), scaffold ~1.5h, review ~1h. **APPROVED on the first
pass** — first feature in this repo to clear review without a rejection.
