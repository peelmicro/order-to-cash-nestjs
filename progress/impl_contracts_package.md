# impl_contracts_package

Feature 8 (`contracts_package`), phase 5. `sdd: false` — no `specs/contracts_package/`
directory; worked from the task brief and `specs/shared/asyncapi.yaml` /
`specs/shared/openapi.yaml` directly.

## What was built

`packages/contracts` is now a real package: two generators, a deterministic
`pnpm contracts:generate`, a drift check (`pnpm contracts:check`), the
generated types themselves (committed), and a deliberate hand-written barrel.

### Generator choices, with reasoning

**OpenAPI 3.1 → `openapi-typescript` (v7).** The natural fit the task called
for: types-only (nothing executable ships to a consumer), a native OpenAPI
3.1 parser (this spec's `oneOf [..., {type: 'null'}]` nullability style, RFC
9457 `application/problem+json` responses, `const` literals throughout — all
handled without post-processing), and it emits one deterministic module
(`paths`, `components`, `operations`, `webhooks`) straight from the parsed
document object, so generation never depends on the process's working
directory.

**AsyncAPI 3.0 → extract `components.schemas` + `json-schema-to-typescript`.**
AsyncAPI 3.0 tooling is thin, as the task anticipated. I evaluated
`@asyncapi/modelina`: it targets *models* derived by walking
`channels`/`messages` per message, with no first-class notion of "compile
every `components.schemas` entry, faithfully, as one cross-referencing
module" — it would have required re-deriving the schema graph anyway and
loses this spec's shared `Envelope` intersection style (`allOf: [Envelope,
{...}]` for all thirteen fact events). `components.schemas` in this document
*is* plain JSON Schema (draft-07-shaped, `$ref`-only, no AsyncAPI-specific
keywords) — so extracting it and feeding `json-schema-to-typescript` is the
"legitimate, honest" path the task named explicitly, and it turned out to be
the one that actually fits: all 95 schema definitions compile 1:1 with no
post-processing beyond the two documented, tested transforms in
`scripts/lib/generate-asyncapi.mts` (see below). "43 messages" in the task
brief is `components.messages` — the thirteen facts + `DeadLetterRecord` +
`RpcErrorReply` + fourteen RPC request/reply pairs (13+1+1+28=43); every one
of their `payload`/`headers` schemas is one of the 95 compiled types.

### The two documented, tested transforms on the extracted schema

Both were found empirically (see "What surprised me" below) and are now
guarded by regression tests, not just comments:

1. **`$ref` rewrite** — `#/components/schemas/X` → `#/definitions/X`, so
   `json-schema-to-typescript`'s internal `$RefParser` resolves every
   cross-reference as plain JSON Schema `definitions` with zero knowledge of
   AsyncAPI's document shape.
2. **`title` stripping** — three of the 95 schemas carry a human-readable
   `title` (`Envelope: title: Fact envelope`, `RpcError: title: RPC error
   reply`, `RpcTimeout: title: RPC timeout — the absence of a reply`).
   `json-schema-to-typescript` prefers `title` over the definition key when
   naming a type, which produced `FactEnvelope`, `RPCErrorReply` and the
   unusable `RPCTimeoutTheAbsenceOfAReply`. Stripping `title` (harmless —
   `description` is untouched and still lands in the doc comment) keeps
   every exported name identical to its `components.schemas` key: a 1:1,
   predictable mapping, which is what the deliberate barrel and its
   completeness test both rely on.

Root-wrapper stripping (`compile()` always emits an interface for the
synthetic root schema used to carry `definitions` + `unreachableDefinitions:
true`) is done with a brace-bounded regex, not a naive non-greedy one — see
"What surprised me."

### Files created

- `packages/contracts/scripts/lib/banner.mts` — the shared DO-NOT-EDIT
  banner text (no timestamp, no absolute path — both would break
  determinism).
- `packages/contracts/scripts/lib/generate-asyncapi.mts` — reads
  `specs/shared/asyncapi.yaml`, rewrites refs, strips `title`, sorts
  definitions alphabetically, compiles with `json-schema-to-typescript`,
  strips the synthetic root interface, prepends the banner. Exports
  `generateAsyncApiTypes(specPath)`.
- `packages/contracts/scripts/lib/generate-openapi.mts` — reads
  `specs/shared/openapi.yaml`, compiles with `openapi-typescript`, prepends
  the banner. Exports `generateOpenApiTypes(specPath)`.
- `packages/contracts/scripts/lib/generate-asyncapi.spec.ts`,
  `generate-openapi.spec.ts` — banner/determinism/shape tests for each
  generator, plus the AsyncAPI completeness regression test (below) and a
  `__fixtures__/empty-schemas.yaml` fixture for the "no schemas" error path.
- `packages/contracts/scripts/generate.mts` — orchestrator. Exports
  `generateAll(outputDir)` (used by tests and by `check.mts`, writes to any
  directory) and `main(outputDir = <real src/generated>)` (the CLI entry
  point's own logic, also exported so a test can exercise its
  printing/behaviour in-process). Runs `main()` only when executed directly
  (`import.meta.url === pathToFileURL(process.argv[1]).href`), so importing
  the module for its functions never has the side effect of overwriting the
  committed files.
- `packages/contracts/scripts/check.mts` — drift check. Exports
  `checkGenerated(committedDir)` (regenerates to a temp dir, diffs
  file-by-file, returns `{ ok, messages }`, never writes to `committedDir`)
  and `main(committedDir = <real src/generated>)` (prints and sets
  `process.exitCode`). Same `isMain` guard as `generate.mts`.
- `packages/contracts/scripts/generate.spec.ts`,
  `packages/contracts/scripts/check.spec.ts` — see "Tests" below.
- `packages/contracts/src/generated/asyncapi.types.ts`,
  `openapi.types.ts` — the committed generated output (DO-NOT-EDIT banner,
  `/* eslint-disable */`).
- `packages/contracts/src/index.ts` — the deliberate barrel: shared kernel
  primitives, `Envelope`/`FactHeaders`/`DeadLetterHeaders`, all thirteen
  `*Payload`/`*Event` fact pairs, `RpcHeaders`/`RpcError`/`RpcTimeout` plus
  all fourteen RPC `*RequestPayload`/`*ReplyPayload` pairs, and
  `GatewayPaths`/`GatewayComponents`/`GatewayOperations` from the OpenAPI
  side plus ten convenience aliases (`PlaceOrderRequest`, `OrderDetail`,
  `Problem`, etc.) for the schemas a client reaches for most. Every other
  OpenAPI schema is one property access away on `GatewayComponents['schemas']`
  — "narrow surface, full reach" by design, not an attempt to alias all
  ~60 REST schemas by hand.
- `packages/contracts/src/index.spec.ts` — the representative-usage test
  (below).
- `packages/contracts/tsconfig.json` (typecheck: `src/**` + `scripts/**`,
  `noEmit: true`) and `tsconfig.build.json` (build: `src/**` only, excludes
  `*.spec.ts`, emits `dist/`) — mirrors `packages/shared-kernel`'s
  json/build split.
- `packages/contracts/vitest.config.mts` — `include` widened to
  `scripts/**/*.spec.ts`; `fileParallelism: false` (several specs spawn the
  real CLI against the real `src/generated/*.ts` — see "What surprised
  me"); coverage `include` scoped to `scripts/**/*.mts` + `src/index.ts`
  (hand-written glue only, per the task's "do not chase coverage on
  generated code").
- `packages/contracts/package.json` — `generate`/`check` scripts, three new
  devDependencies (below).

### Files changed outside `packages/contracts`

- `package.json` (root) — `contracts:generate` and `contracts:check` scripts,
  delegating via `pnpm --filter @otc/contracts run <script>` (same pattern as
  `dev:gateway` etc.).
- `eslint.config.mjs` — `packages/contracts/src/generated/**` added to the
  global `ignores` array (generated code is never hand-patched to satisfy
  lint; excluding the directory is faster than parsing 2,900 lines of
  generated TS and avoids false positives on code this repo does not own the
  shape of).
- `.prettierignore` — same directory added, same reasoning.

### Dependencies installed (all devDependencies of `packages/contracts`)

- `openapi-typescript@^7.13.0` — OpenAPI 3.1 → TypeScript compiler.
- `json-schema-to-typescript@^15.0.4` — JSON Schema → TypeScript compiler,
  used on the extracted `components.schemas` of `asyncapi.yaml`.
- `js-yaml@^5.3.0` — YAML parser for both spec files (named exports only in
  v5; ships its own types, no `@types/js-yaml` needed).
- `tsx` — already a catalog devDependency elsewhere in the monorepo;
  added here (`catalog:`) to run the `.mts` generator scripts, matching the
  convention every app already uses for `dev`.

## Traceability

`contracts_package` is `sdd: false` with no `specs/contracts_package/`
directory and carries no `R<n>` — it operationalizes the two specs
(`asyncapi.yaml`, `openapi.yaml`) rather than adding domain behaviour, the
same posture `messaging_topology` took for the Kafka topic derivation. No
`specs/shared/test-matrix.md` row applies (confirmed: no existing row
references contracts/generation).

## Tests

19 tests in `packages/contracts` before this feature (68 in `shared-kernel`,
untouched) → 22 in `packages/contracts` after, all green:

- `scripts/lib/generate-asyncapi.spec.ts` (5 tests) — banner + no-absolute-path,
  byte-for-byte determinism across two runs, the **completeness regression
  test** (every one of the 95 `components.schemas` keys has exactly one
  exported type/interface of the same name — this is the test that would
  have caught the root-interface-stripping bug described below), no leaked
  `AsyncApiComponents` wrapper, and the "no schemas" error path against
  `__fixtures__/empty-schemas.yaml`.
- `scripts/lib/generate-openapi.spec.ts` (4 tests) — banner + no-absolute-path,
  determinism, the three root shapes (`paths`/`components`/`operations`)
  present, every one of the eleven REST paths present.
- `scripts/generate.spec.ts` (3 tests) — committed `src/generated/*.ts`
  byte-identical to a fresh `generateAll()` run into a temp dir (this is
  `contracts:check`'s own assertion, run inside `pnpm test` too, so a
  hand-edit or a forgotten regeneration fails the ordinary suite, not only
  the separate check script); the real CLI (`tsx scripts/generate.mts`)
  exits 0 and prints the confirmation line; `main()` called in-process
  against a temp dir, for coverage of the CLI wrapper's own logic.
- `scripts/check.spec.ts` (6 tests) — `checkGenerated()` against the real
  committed directory (ok), against a corrupted **copy** (drift, names the
  file, includes a diff), against an empty directory (missing files); the
  real CLI (`tsx scripts/check.mts`) exits 0 against the real files;
  `main()` called in-process for both the pass and fail paths, asserting
  `process.exitCode` and the log stream used (`console.log` vs
  `console.error`).
- `src/index.spec.ts` (4 tests) — the task's own list, literally: a
  well-formed `Envelope`; one fact payload per topic (`OrderPlacedEvent` /
  orders, `StockReservedEvent` / fulfillment, `CreditApprovedEvent` /
  billing); one RPC pair (`OrdersCreateRequestPayload` /
  `OrdersCreateReplyPayload`); one REST response set
  (`PlaceOrderResponse`, `OrderDetail`, `Problem`). The real assertion is
  that these literals type-check (`pnpm typecheck` fails first if a
  regeneration narrows/widens/renames a field); the `expect(...)` calls are
  the "couple of runtime-shape assertions" the task asked for.

Coverage (`pnpm --filter @otc/contracts run test:coverage`, gate scoped to
`scripts/**/*.mts` + `src/index.ts`): **91.6% statements, 87.5% branches,
84.6% functions, 91.5% lines** — all above the 80% gate. `src/generated/**`
is excluded from the gate per the task's own instruction ("do not chase
coverage numbers on generated code").

## Design notes worth recording

- **Why `checkGenerated`/`generateAll` are parameterized by directory,
  never hardcoded.** Every test that needs to prove drift-detection or
  regeneration behaviour operates on a **copy** (a `mkdtemp` directory) —
  never the real `src/generated/*.ts` in place. Two test files that both
  mutated the real committed files in place would race each other under
  Vitest's default parallel-file execution; parameterizing the functions
  removes the temptation entirely, and the package's
  `fileParallelism: false` setting is there only for the handful of tests
  that *do* deliberately exercise the literal `tsx scripts/*.mts` command
  against the real files (to prove the actual command works, not just the
  function it calls).
- **Why `additionalProperties: false` is passed to both compilers instead of
  leaving JSON Schema's implicit "additional properties allowed" default.**
  Both specs deliberately leave `additionalProperties` unset on payload/body
  schemas so a **future, non-breaking, additive field** doesn't require a
  contract version bump on the wire — that is a wire-compatibility
  statement, not a type-strictness one. Closing it in the generator config
  only affects what TypeScript's structural typing reports for values
  constructed *inline*; it does not, and was never going to, prevent a
  service from reading or forwarding an extra field it didn't know about.
  Left open (the JSON Schema default), every one of the 95 AsyncAPI types
  and the OpenAPI schemas would carry a `[k: string]: unknown` index
  signature — technically defensible, but it adds no safety and clutters
  every generated interface for no consumer benefit. I chose the common,
  pragmatic codegen convention (matches `openapi-typescript`'s own default
  behaviour) and recorded the reasoning here rather than silently deviating
  from the "faithful" instruction.

## What surprised me (worth flagging for reviewers of #8/#9 too)

1. **`json-schema-to-typescript` renders an *empty* interface body as `{}`
   on one line, not `{\n}\n`.** My first root-interface-stripping regex was
   `/export interface AsyncApiComponents \{[\s\S]*?\n\}\n\n?/` — non-greedy,
   looking for the first `\n}\n` after the opening brace. Against the real
   spec, the synthetic root schema (no `properties`, only `definitions`,
   `additionalProperties: false`) compiled to a single-line
   `export interface AsyncApiComponents {}` — no `\n` before the closing
   brace — so the regex engine kept scanning **past** it and matched
   through to the *next* interface's closing brace instead, silently
   deleting both the root wrapper **and** `CatalogReferenceListReplyPayload`
   (alphabetically first among the schemas placed right after the root in
   the compiled output). Caught only because I diffed the full list of
   `components.schemas` keys against the generated export names as a
   sanity check before writing the barrel — not by TypeScript, which had
   nothing to complain about (the barrel simply wouldn't have imported the
   missing type, and nothing downstream would have noticed until a service
   needed it). Fixed with a brace-bounded `[^{}]*` match (safe here because
   the root's body is guaranteed brace-free — no `properties` means no
   nested object literal can appear) and turned into the completeness
   regression test described above, so a future generator change that
   reintroduces this class of bug fails a test instead of silently dropping
   a type.
2. **`title` beats the definition key for naming, and this spec's three
   uses of `title` are all inside `components.schemas`, not just in the
   human-facing parts of the document** — easy to miss on a first read
   since the spec's prose explicitly frames `title` as documentation
   (`Envelope`'s `title: Fact envelope`). `RpcTimeout`'s title in particular
   ("RPC timeout — the absence of a reply") produced an unusable
   `RPCTimeoutTheAbsenceOfAReply`. Both `RpcError` and `RpcTimeout` were
   fine to build past `pnpm typecheck` under those names — I only noticed by
   deliberately diffing the schema-key set against the exported-name set,
   the same check that caught surprise 1. Stripping `title` before
   compilation and asserting the 1:1 name mapping as a test closes this for
   good, not just for this run.
3. **`js-yaml@5` has no default export** — it moved to named exports only
   (`import { load } from 'js-yaml'`); the catalog/typical convention from
   `js-yaml@4`-era code (`import yaml from 'js-yaml'; yaml.load(...)`) fails
   at runtime with `SyntaxError: The requested module 'js-yaml' does not
   provide an export named 'default'`. Caught immediately on first run,
   fixed by switching to the named import everywhere.
4. **Coverage-v8 cannot see into a spawned subprocess.** The most direct way
   to prove "the actual command `pnpm contracts:check` behaves correctly" is
   to `spawnSync` it and assert on `status`/`stdout`/`stderr` — which is
   exactly what the task's own verification section asks for. But V8's
   coverage instrumentation only tracks the process it's attached to, so
   those subprocess tests contribute zero coverage credit even though they
   genuinely exercise `main()`'s every line. Resolved by exporting `main()`
   from both `generate.mts` and `check.mts` with the target
   directory as a parameter (defaulting to the real one), so the same logic
   is exercised **twice** per script: once end-to-end via a real spawned CLI
   process (proving the actual command works), and once in-process via a
   direct call with a spied `console.log`/`console.error` and a
   saved/restored `process.exitCode` (for coverage and for asserting the
   exact log stream used on success vs. failure).

## Verification (real output)

**1. Determinism — `git diff --stat` empty between two runs, using real
`git`, not just string comparison:**
```
$ git add packages/contracts/src/generated
$ pnpm --filter @otc/contracts run generate
$ git diff --stat -- packages/contracts/src/generated
(no output — EXIT=0)
```

**2. `pnpm contracts:check` passing on the committed output:**
```
$ pnpm run contracts:check
$ pnpm --filter @otc/contracts run check
$ tsx scripts/check.mts
contracts:check OK — committed generated files match a fresh `pnpm contracts:generate` run.
EXIT=0
```

**3. Corrupt one generated file, show `contracts:check` FAILING:**
```
$ printf '\n// hand-edited drift — should be caught\n' >> packages/contracts/src/generated/openapi.types.ts
$ pnpm run contracts:check
DRIFT: .../openapi.types.ts does not match a fresh `pnpm contracts:generate` run.
--- .../openapi.types.ts
+++ /tmp/otc-contracts-check-XNrQZv/openapi.types.ts
@@ -1611,5 +1611,3 @@
         };
     };
 }
-
-// hand-edited drift — should be caught

contracts:check FAILED — committed generated files are stale. Run `pnpm --filter @otc/contracts run generate` and commit the result.
EXIT=1
```

**4. Restore via regenerate, show passing again:**
```
$ pnpm run contracts:generate
$ pnpm run contracts:check
contracts:check OK — committed generated files match a fresh `pnpm contracts:generate` run.
EXIT=0
```
(`git status --porcelain` on `src/generated` confirms both files back to
their previously-staged content, no diff.)

**5. Spec-drift proof, in a temp COPY of `openapi.yaml` — never the real
file:** copied the real `openapi.yaml` to a scratch path, renamed
`OrderSummary.orderId` → `OrderSummary.orderIdentifier` in the **copy only**,
ran `generateOpenApiTypes` against both the real spec and the copy, diffed
the two outputs:
```
             orderDate: components["schemas"]["Instant"];
-            orderId: components["schemas"]["UniqueId"];
+            orderIdentifier?: components["schemas"]["UniqueId"];
             orderReference: components["schemas"]["OrderReference"];
```
The generated diff picks up the rename immediately (the renamed property
also drops out of `required`, correctly rendering as optional — I renamed
the property but not the `required: [orderId, ...]` entry in the copy, so
the generator faithfully reports exactly what the copy says). Confirmed the
real spec was never touched:
```
$ git diff --stat -- specs/shared/openapi.yaml
(no output)
$ md5sum specs/shared/openapi.yaml
6f6c5809b75cfd8e97936d4b5e96d15e  specs/shared/openapi.yaml
```
Scratch files deleted afterward.

**6. `pnpm quality` green at root** (lint + typecheck + test across all 10
workspace projects, `packages/contracts` included: 22/22 tests). **7.
`pnpm -r build` green** (all 8 buildable packages/apps, including
`packages/contracts` → `dist/index.js` + `dist/generated/*.js`, and
`apps/web`'s full Nuxt production build). **8. `./init.sh` exits 0.**

## Deviations / what I could not do

- No `specs/contracts_package/` triple-doc exists (`sdd: false`), so there
  is no EARS `R<n>` list to trace against; traceability is recorded above
  against `asyncapi.yaml`/`openapi.yaml` directly instead, matching
  `messaging_topology`'s precedent.
- The barrel does not alias every one of the ~60 OpenAPI schemas by name —
  by design ("deliberate barrel", not exhaustive re-export). Ten convenience
  aliases are provided for the schemas a Gateway client reaches for most
  (`PlaceOrderRequest`, `OrderDetail`, `Problem`, etc.); every other schema
  is one property access away on the exported `GatewayComponents['schemas']`.
  Flagging this so a reviewer can decide whether a fuller alias list is
  wanted before `gateway_rest_auth` (feature 25) starts consuming this
  package in earnest.
