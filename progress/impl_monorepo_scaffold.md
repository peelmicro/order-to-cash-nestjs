# Implementation report — `monorepo_scaffold` (id 6, phase 5)

## PART 0 — TypeScript 7 validation spike

All spike work happened under `/tmp/claude-1000/.../scratchpad/ts7-spike/` and was
deleted afterwards. `typescript@latest` at spike time = **7.0.2**.

### 1. NestJS 11 + `emitDecoratorMetadata` + DI boot — PASS

- `tsc -p tsconfig.json` under TS 7.0.2 initially failed twice on **TS7-specific
  breaking changes**, both fixed inside the timebox:
  - `TS5108: Option 'moduleResolution=node10' has been removed` — TS7 dropped the
    classic `"moduleResolution": "node"` value entirely. Fixed by switching to
    `"moduleResolution": "bundler"`.
  - `TS5011: rootDir must be explicitly set` — fixed by adding `"rootDir": "src"`.
  - `TS2591: Cannot find name 'process'` — TS7 no longer auto-includes `@types/node`
    ambient types the way TS5 did; fixed with `@types/node` + `"types": ["node"]`.
- After those three fixes, `tsc` compiled cleanly and the emitted `controller.js`
  contained a correct `__metadata("design:paramtypes", [service_1.GreeterService])`
  — i.e. `emitDecoratorMetadata` genuinely works under TS7's native compiler.
- Booting the compiled output (`node dist/main.js`) started a real Nest app,
  resolved `GreeterService` into `AppController`'s constructor via DI, and the
  `GET /` handler returned `"hello from ts7"` — proving DI actually resolves at
  runtime, not just that the file compiles. Exit code 0.
- **Verdict: PASS.** No SWC fallback was even necessary — plain `tsc` under TS7
  works for NestJS 11 decorators once the tsconfig is adjusted for TS7's removed
  `moduleResolution` values.

### 2. Vitest + decorators + `reflect-metadata` — PASS

- One spec asserting `Reflect.getMetadata('design:paramtypes', Widget)` is
  defined and correct, run through Vitest 4.1.11's default esbuild transform
  (no SWC plugin needed).
- `pnpm exec vitest run` → 2/2 tests passed, no config changes needed beyond the
  same `tsconfig.json` shape as the NestJS spike.
- **Verdict: PASS.**

### 3. Nuxt 4 + TS7 typecheck — **FAIL**

- `nuxi init` (template `minimal`) → Nuxt 4.5.2 project. Installed
  `typescript@latest` (7.0.2) as a devDependency.
- `pnpm install` and `nuxt prepare` (postinstall) both succeeded under TS7.
- `nuxi dev` and a full `nuxi build` **succeeded** under TS7 — Vite/Nitro use
  esbuild/oxc for transforms, not `tsc`, so the dev/build pipeline itself is
  TS7-agnostic. `curl` against the dev server returned `HTTP_STATUS:200`.
- `nuxi typecheck` requires a standalone type-checker; Nuxt's own CLI offers
  `vue-tsc` or `Golar` (the spec explicitly names `nuxi typecheck` / `vue-tsc`
  as the criterion). Installed `vue-tsc@3.3.10` (latest, checked — no newer
  version exists as of the spike date) against `typescript@7.0.2`:

  ```
  Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './lib/tsc' is not
  defined by "exports" in .../node_modules/typescript/package.json
      at exportsNotFound (node:internal/modules/esm/resolve:314:10)
      ...
      at resolveTscPath (.../vue-tsc/index.js:73:43)
  Node.js v24.19.0
  ```

  This is TS7's new package `exports` map (it no longer exposes
  `typescript/lib/tsc` as a requireable subpath) breaking `vue-tsc`'s internal
  `require.resolve('typescript/lib/tsc')` bootstrap. `vue-tsc`'s own
  `peerDependencies` still declares `"typescript": ">=5.0.0"` with no upper
  bound, i.e. it advertises TS7 support it does not actually have yet. This is
  a genuine upstream incompatibility, not something fixable from our side
  within the timebox — it needs either a `vue-tsc` release that adapts to
  TS7's exports map, or Nuxt's newer `Golar` type-checker (not one of the two
  options the spec names, and out of scope to adopt unilaterally).
- **Verdict: FAIL**, reproducible, with real error output above.

### Overall verdict: **fallback to `typescript@^5.9`**

Per the stated rule ("all three PASS → TS7; any FAIL → fallback"), and because
criterion 3 is a hard, reproducible FAIL with no in-timebox fix, the monorepo is
scaffolded on **TypeScript 5.9.3** (`typescript-eslint` also caps its supported
range at `typescript: '>=4.8.4 <6.1.0'`, which independently corroborates that
the wider 2026 TS tooling ecosystem — ESLint's own type-aware plugin included —
has not caught up to TS7 yet). Total spike time: well under the ~1 hour timebox.
Throwaway spike directory deleted after capturing the evidence above.

**What I would do differently / revisit later:** re-run this exact spike when
`vue-tsc` (or Nuxt's Golar path) publishes TS7 support — nothing else in the
findings blocks TS7 adoption; it is purely this one upstream gap.

---

## PART 1 — Monorepo scaffold

### Created

- `pnpm-workspace.yaml` — `apps/*`, `packages/*`, plus a `catalog:` block
  (pnpm 11 catalogs) pinning every shared devDependency version once, and
  `allowBuilds: { esbuild: true }` (esbuild's postinstall just fetches its own
  platform binary; required transitively by Vitest and `tsx`).
- `tsconfig.base.json` — `strict: true`, `target: ES2023`,
  `module`/`moduleResolution: NodeNext`, `experimentalDecorators` +
  `emitDecoratorMetadata: true`. Every app/package `tsconfig.json` extends it.
- `eslint.config.mjs` — flat config (ESLint 10). Domain-purity rule via the
  built-in `no-restricted-imports` (rationale for choosing it over
  `import-x/no-restricted-paths` is documented as a comment in the file itself:
  zero extra dependency, and every violation is spellable in the import
  specifier text itself, so a resolved-path "zone" matcher buys nothing here).
  Scoped to `apps/*/src/domain/**/*.ts`, forbidding `@nestjs/*`, `drizzle-orm`
  (+ subpaths), `kafkajs`, `nats`, `mongodb`, and any relative import reaching
  into `infrastructure/` or `presentation/`.
- `.prettierrc.json`, `.prettierignore`.
- **Six NestJS 11 app skeletons**: `apps/{gateway,orders,fulfillment,billing,notifications,projector}`,
  each with:
  - `src/main.ts` (boots on `<SERVICE>_PORT` env var, falling back to its
    assigned port: gateway 3001, orders 3002, fulfillment 3003, billing 3004,
    notifications 3005, projector 3006).
  - `src/app.module.ts`, `src/presentation/app.controller.ts` (`GET /` →
    `{ service, status: 'ok' }`), `src/presentation/app.controller.spec.ts`.
  - `src/{presentation,application,domain,infrastructure}/.gitkeep` (all four,
    per the spec, even though `presentation/` also holds real files).
  - `tsconfig.json` (typecheck target, includes specs) + `tsconfig.build.json`
    (excludes specs — the standard Nest CLI split).
  - `vitest.config.mts` (`.mts`, not `.ts` — avoids Vite's "ESM syntax loaded
    as CommonJS" warning against a `"type": "commonjs"` package.json).
    Coverage thresholds (80/80/80/80 is not the number used here — see below)
    wired at 60/60/60/60 ("overall" tier) but **not enforced**: the `test`
    script is plain `vitest run` with no `--coverage`, so thresholds are
    inert until phase 21 turns on a `test:coverage` invocation for real.
  - `package.json` scripts: `dev` (`dotenv-cli` loads the root `.env`, then
    `tsx watch`), `build` (`tsc -p tsconfig.build.json`), `start`
    (`dotenv-cli` + `node dist/main.js`), `typecheck`, `test`, `test:watch`,
    `test:coverage`.
- **Nuxt 4 app skeleton**: `apps/web`, `nuxi init --template minimal`, renamed
  to `@otc/web`, `typescript` + `vue-tsc` added as devDependencies (both via
  the pnpm catalog, both pinned to the 5.9/3.3 line that PASSED the spike),
  `devServer.port` in `nuxt.config.ts` reads `WEB_PORT` and falls back to
  `3000`. `typecheck` script added (`nuxi typecheck`, verified green). No
  Tailwind/shadcn-vue — out of scope per instructions.
- **Two package stubs**: `packages/{shared-kernel,contracts}` — `package.json`
  (zero `dependencies`, only tooling `devDependencies`), `tsconfig.json`,
  `src/index.ts` (`export {};` plus a comment pointing at the feature that
  fills it in), `vitest.config.mts` with `passWithNoTests: true` (there is
  nothing to test yet) and 80/80/80/80 coverage thresholds wired (the domain
  tier — `shared-kernel` in particular is where the ≥80%-domain gate from
  CLAUDE.md will bite once feature 7 lands).
- Root `package.json`: added `engines.node`, `devDependencies` (`eslint`,
  `@eslint/js`, `eslint-config-prettier`, `prettier`, `typescript`,
  `typescript-eslint`), and scripts: `build`, `lint`, `lint:fix`, `format`,
  `format:fix`, `typecheck`, `test`, `test:coverage`, `quality` (=
  `lint && typecheck && test`), and one `dev:<app>` convenience script per
  app (`dev:gateway` … `dev:web`). All existing `dc:*`/`kafka:topics` scripts
  from `infra_compose`/`messaging_topology` untouched.
- `.env.example` and `.env`: added an "Application services" section —
  `GATEWAY_PORT=3001` … `PROJECTOR_PORT=3006`, `WEB_PORT=3000` — the values
  each app's `main.ts` / `nuxt.config.ts` fall back to when unset.

### Dependencies added (with purpose)

Root `devDependencies`:
| Package | Purpose |
|---|---|
| `typescript@5.9.3` | Compiler/type-checker for the whole monorepo (TS7 fallback — see spike) |
| `eslint@^10.8.1` | Flat-config lint engine |
| `@eslint/js@^10.0.1` | ESLint's own recommended rule set (flat-config form) |
| `typescript-eslint@^8.67.0` | TS parser + rules for ESLint flat config |
| `eslint-config-prettier@^10.1.8` | Turns off ESLint rules that conflict with Prettier formatting |
| `prettier@^3.9.6` | Code formatter |

Workspace `catalog:` (pnpm 11 catalogs — one version per package, referenced as
`"catalog:"` from every app/package `package.json`):
| Package | Purpose |
|---|---|
| `@types/node@^24.13.3` | Node ambient types (matches the pinned Node 24 LTS) |
| `vitest@^4.1.11` | The only test runner (no Jest anywhere) |
| `@vitest/coverage-v8@^4.1.11` | V8-based coverage provider for the thresholds wired now |
| `tsx@^4.23.12` | Runs NestJS `src/main.ts` directly in dev (esbuild-based, decorator-metadata-safe) |
| `dotenv-cli@^10.0.0` | Loads the root `.env` for `dev`/`start` scripts without an app-level env loader |
| `@nestjs/common@^11.2.1`, `@nestjs/core@^11.2.1`, `@nestjs/platform-express@^11.2.1` | NestJS 11 runtime for the six services |
| `reflect-metadata@^0.2.2` | Required by Nest's decorator-metadata-based DI |
| `rxjs@^7.8.2` | NestJS peer dependency |
| `vue-tsc@^3.3.10` | Nuxt's type-checker (works against TS 5.9.3 — the whole reason TS7 was rejected) |

`apps/web` additionally pulled Nuxt's own default template deps
(`nuxt@^4.5.2`, `vue@^3.5.41`, `vue-router@^5.2.0`) via `nuxi init` — unchanged
from what the CLI generates.

No Drizzle, Kafka, NATS, MongoDB, or Terminus packages were added — those
belong to later features per the instructions.

## Verification (real output)

1. **Clean install**: removed every `node_modules/` under the repo root and
   ran `pnpm install` from scratch → exit 0, 753 packages resolved.
2. **`pnpm -r build`**: all 9 workspaces with a `build` script (6 apps, 2
   packages, `apps/web`) built successfully, including a full Nuxt production
   build (`.output/` generated, "✨ Build complete!").
3. **All six NestJS apps boot and answer** on their assigned port
   (`node apps/<app>/dist/main.js`, then `curl`):
   ```
   gateway (3001):       {"service":"gateway","status":"ok"}
   orders (3002):        {"service":"orders","status":"ok"}
   fulfillment (3003):   {"service":"fulfillment","status":"ok"}
   billing (3004):       {"service":"billing","status":"ok"}
   notifications (3005): {"service":"notifications","status":"ok"}
   projector (3006):     {"service":"projector","status":"ok"}
   ```
   All six processes killed afterwards (`pgrep` confirms none survive).
4. **`apps/web` dev server**: `pnpm --filter @otc/web run dev` →
   `curl http://127.0.0.1:3000/` → `HTTP_STATUS:200`. Process killed
   afterwards (`pgrep` confirms no `nuxt`/`@nuxt/cli` process survives).
5. **`pnpm quality`** (`lint && typecheck && test`) passes end-to-end from a
   clean `node_modules` + fresh build: 0 lint errors/warnings, `tsc --noEmit`
   green on all 8 TS packages + `nuxi typecheck` green on `apps/web`, and
   6 Vitest suites (1 passing test each) + 2 `passWithNoTests` package runs,
   all green.
6. **Domain-purity rule proof** — added a temporary file
   `apps/orders/src/domain/_purity-violation.ts` importing `@nestjs/common`
   and reaching into `../presentation/app.controller`:
   ```
   apps/orders/src/domain/_purity-violation.ts
     3:1  error  '@nestjs/common' import is restricted from being used by a
                 pattern. Domain layer must stay framework/infrastructure
                 free (see CLAUDE.md § Non-negotiables)          no-restricted-imports
     4:1  error  '../presentation/app.controller' import is restricted from
                 being used by a pattern. Domain layer must not reach into
                 infrastructure/ or presentation/ (see CLAUDE.md §
                 Non-negotiables)                                 no-restricted-imports
   ✖ 2 problems (2 errors, 0 warnings)
   [ELIFECYCLE] Command failed with exit code 1.
   ```
   File removed, `pnpm run lint` re-run → 0 problems, exit 0.
7. **No Jest anywhere**: `grep -ril jest` across `apps/` and `packages/`
   (excluding `node_modules`) → no matches.
8. **`./init.sh`** exits 0 throughout (checked before, during, and after the
   scaffold).

## Deviations / notes

- **TS7 → TS 5.9 fallback**, fully justified above — the human's explicit
  fallback rule triggered on a real, reproducible upstream gap (`vue-tsc`
  vs. TS7's package `exports` map), not a workaround-able issue.
- `no-restricted-imports` chosen over `import-x/no-restricted-paths` for the
  domain-purity rule — reasoning inlined as a comment at the top of
  `eslint.config.mjs` (zero extra dependency; every violation is spellable in
  the import specifier itself, so path-resolution "zones" buy nothing here).
- Per-service `<SERVICE>_PORT` env vars (rather than one shared `PORT`) chosen
  so all six services can share the single root `.env` file consistently with
  the rest of the project's env-var naming style (`MYSQL_HOST_PORT`,
  `KAFKA_HOST_PORT`, etc. in `.env.example`).
- pnpm 11 auto-wrote a template `allowBuilds:` stanza into `pnpm-workspace.yaml`
  on first `install` (new pnpm-11 mechanism, replaces the older
  `onlyBuiltDependencies` I originally wrote) — filled it in
  (`esbuild: true`) rather than leaving the placeholder, since esbuild's
  postinstall only fetches its own platform binary (needed by Vitest/`tsx`).
- Coverage thresholds are wired (60/60/60/60 for the six apps, 80/80/80/80 for
  the two future-domain-heavy packages) but genuinely inert right now: the
  default `test` script never passes `--coverage`, so nothing fails on these
  near-empty skeletons. Phase 21 (`sonarqube_quality_gates`) is where these
  become load-bearing.
- `apps/web/README.md` (auto-generated boilerplate from `nuxi init`) was
  deleted — did not want a promotional Nuxt starter README sitting in the repo.

## Traceability to acceptance criteria (feature_list.json, id 6)

- "pnpm install works from root" → Verification §1.
- "exact packageManager pinned" → root `package.json`'s
  `"packageManager": "pnpm@11.22.0"` left untouched.
- "no-restricted-imports rule fails on a deliberate domain violation" →
  Verification §6.
- "pnpm quality runs lint + typecheck + test" → Verification §5.

## What I could not do / left for later

- Real ESLint enforcement of `.vue` files in `apps/web` (no `eslint-plugin-vue`
  wired) — out of scope for this phase; Tailwind/shadcn-vue and the real web
  app land in feature 29.
- Coverage gates are not yet enforced-failing (deliberately, per instructions —
  phase 21 turns them on).
