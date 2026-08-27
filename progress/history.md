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

## infra_compose (id 4, phase 4) — 2026-08-19

**Effort:** 1 session, ~4h wall-clock — implementation ~1.5h, then **two review
passes** (~1h reviewing + ~1.5h fixing and re-proving). The first pass was
**REJECTED with 7 defects, 2 of them blocking**: **D1** — `kafka_data` mounted at
`/tmp/kraft-combined-logs` (the Confluent `cp-kafka` convention) while
`apache/kafka:4.3.1` writes to `/tmp/kafka-logs`, so the named volume was empty,
all broker state lived in the container layer and every `down`/`up` silently
destroyed the cluster id, topics and offsets; **D2** — the SonarQube healthcheck
was `curl -f /api/system/status`, which returns HTTP 200 with
`{"status":"STARTING"}`, giving a measured ~90 s window of false "healthy".
Both were found by probing the running system, not by reading the file; both are
fixed and re-proved.
**Spec:** n/a (sdd: false)
**Tests:** no test suite exists at phase 4. Verification is the reviewer's
independent probing of the running stack — recorded in full in
`progress/review_infra_compose.md`.

**What was built:**

`docker-compose.infra.yml` — ten infrastructure services on one bridge network,
every image pinned to an exact tag, every service healthchecked with a genuine
*readiness* probe: MySQL 8.4.11 (four databases via a `.sh` init script),
MongoDB 8.3.8, Kafka 4.3.1 (KRaft, no ZooKeeper, dual listener
`kafka:29092` internal / `localhost:9092` external), Redpanda Console v3.10.0,
NATS 2.14.5 core-only (**JetStream deliberately off** — durability is Kafka's
job), OTel Collector 0.159.0, Jaeger v2 2.20.0, Prometheus v3.14.0, Grafana
13.2.0 (datasources provisioned, no dashboards), n8n 2.36.2. SonarQube
26.8-community sits behind an opt-in `sonar` profile. Plus
`infra/{mysql,prometheus,grafana,otel-collector}/`, `.env.example`, and the
`dc:*` scripts in the root `package.json`.

**Deviations from the spec/plan:**

- **`infra/otel-collector/Dockerfile`** — a two-line image over
  `otel/opentelemetry-collector-contrib:0.159.0` that copies in a static
  `busybox` purely so Docker's exec healthcheck has something to run. The
  upstream image is distroless: no shell, no `wget`/`curl`, no upstream
  `HEALTHCHECK`, and `/otelcol-contrib` has no health subcommand — all verified
  by the reviewer before accepting. Both `FROM` tags are exact, so the build is
  as reproducible as a pull. `pull_policy: build` prevents the local tag going
  stale.
- **MySQL init is a `.sh`, not a `.sql`** — `docker-entrypoint-initdb.d` pipes
  `.sql` files through the client with no variable expansion, which would force
  the app username to be hardcoded and drift from `MYSQL_USER`. It also executes
  `.sh` files with the full environment, so the username and the four database
  names come from `.env` and cannot drift.
- Versions chosen deliberately over the plan's: MySQL **8.4 LTS** (not
  Innovation), **MongoDB 8.3.8** (plan said 7), **Jaeger v2** (plan named the v1
  `all-in-one` legacy image), Grafana on host port **3030** to avoid clashing
  with dev servers on 3000.

**Notes for #8 and #9:**

- **This compose file is reuse payload** — only the application services in
  phase 23 differ. Copy it, and copy the two hard-won fixes with it.
- **`apache/kafka` is not `confluentinc/cp-kafka`.** Its default `log.dirs` is
  `/tmp/kafka-logs`, not `/tmp/kraft-combined-logs`. Always set `KAFKA_LOG_DIRS`
  explicitly and mount the volume at exactly that path — the failure is silent,
  the volume shows up in `docker volume ls`, and nothing complains until a
  `down`/`up` eats the topics.
- **A healthcheck that only checks HTTP 200 is not a readiness check.** SonarQube
  answers 200 with `{"status":"STARTING"}` for ~90 s; Prometheus `/-/healthy` and
  n8n `/healthz` are liveness, `/-/ready` and `/healthz/readiness` are readiness.
  Assert the *body*, and use the readiness endpoint when one exists.
- **The test that catches persistence bugs is `down` + `up -d` + read back your
  own data from offset 0** — not "the container is healthy and I can create a
  topic". That single test is what separated the two review passes here.
- Docker `pull_policy: build` makes a bare `up -d` rebuild a locally-tagged
  image; without it, a fixed `image:` tag next to a `build:` block silently
  reuses a stale image forever.
- Carry-over for the Orders schema feature: `MYSQL_DATABASE` makes the entrypoint
  create `otc_orders` with the server default collation (`utf8mb4_0900_ai_ci`)
  before the init script runs, so it differs from the other three
  (`utf8mb4_unicode_ci`). Harmless now, worth aligning before any schema lands.

---

## messaging_topology (id 5, phase 4) — 2026-08-19

**Effort:** 1 session, ~3h wall-clock — implementation ~1h, then **two review
passes** (~1h first review, ~0.5h fixing, ~0.5h re-review), plus **one session
interruption** mid-feature. First pass **REJECTED** on 4 defects (2 required
minor, 2 advisory — all four fixed): **D1** the new `KAFKA_TOPIC_PARTITIONS` /
`KAFKA_TOPIC_REPLICATION_FACTOR` compose vars were missing from `.env.example`
(regressing feature 4's closed acceptance criterion); **D2** stale
`progress/current.md` (leader's file, second consecutive occurrence); **D3**
the verify step compared an `^otc\.`-filtered actual against an unfiltered
expected; **D4** `OK: verified` over-claimed — a topic hand-recreated with the
wrong partition count passed silently. All re-proved by the reviewer against
the running broker, including a live drift-injection probe (1-partition topic →
`FATAL` exit 1, no auto-alter → restored to 6 partitions).
**Spec:** n/a (sdd: false). The feature's contract is the 3-item acceptance
list in `feature_list.json` plus `specs/shared/asyncapi.yaml` as the sole topic
source of truth.
**Tests:** no test suite exists at phase 4. Verification is two rounds of
independent behavioural probing recorded in
`progress/review_messaging_topology.md` (first pass + "Second pass").

**What was built:**

`infra/kafka/create-topics.sh` — a single ~136-line script that **derives** the
Kafka topic list from `specs/shared/asyncapi.yaml` at run time (yq selector:
`.channels[] | select(.bindings.kafka.topic != null)` — structural, no
name-matching, no hardcoded fallback anywhere), creates each topic idempotently
(`--create --if-not-exists`, 6 partitions / RF 1, both env-overridable), then
verifies **exact** set equality against the spec (broker side filtered only by
Kafka's own `__` internal-topic convention) **and** per-topic shape
(partition count + replication factor via `--describe`), failing loudly and
refusing to auto-alter on any drift. Packaged as `otc-kafka-init:4.3.1`
(`infra/kafka/Dockerfile`: `apache/kafka:4.3.1` + pinned `mikefarah/yq:4.47.2`
binary), wired as the one-shot `kafka-init` compose service
(`depends_on: kafka: service_healthy`, spec mounted read-only), and exposed as
`pnpm kafka:topics` running the **same** container — one implementation, two
callers. Result: `otc.{orders,fulfillment,billing}.facts.v1` + their `.dlq`
companions, 6 partitions, RF 1, exact-matching the spec from the host on 9092,
idempotent across re-runs and `down`/`up`.

**Deviations from the spec/plan:**

- **No NATS provisioning**, although the feature title names "the NATS subject
  registry": NATS core has no server-side topology to create, and
  `specs/shared/asyncapi.yaml` (14 request + 14 reply channels under
  `servers.rpcTransport`) *is* the registry. Accepted by the reviewer on both
  passes — the kafka-binding selector excludes RPC channels structurally.
- **Partition count 6** is a judgment call (spare headroom over today's 3
  consumer groups); safe because every fact is keyed by `correlationId`, so
  per-order ordering never depends on the count. Reasoned inline in the script
  and in `.env.example`.

**Notes for #8 and #9:**

- `infra/kafka/create-topics.sh` is **reuse payload** — plain bash + yq, zero
  Node/NestJS coupling; copy it byte-for-byte.
- **Never verify only existence.** `--create --if-not-exists` is a silent no-op
  against a topic with the wrong shape; verify name-set equality *and*
  partition/replication per topic, and never auto-alter (repartitioning
  reorders keyed in-flight facts).
- **Never filter the broker's topic list by your application namespace** when
  comparing against a spec — filter only Kafka's `__` internal topics, or a
  spec topic under a new prefix will fail (or pass) for the wrong reason.
- Every compose `${VAR}` must land in `.env.example` in the same change that
  introduces it — this regressed once here and cost a review pass.
- Leader carry-over: when Vitest lands (feature 6), add one
  Testcontainers-Kafka integration test proving the spec→topology derivation,
  so the property is defended by CI rather than by manual review probes.

## monorepo_scaffold (id 6, phase 5) — 2026-08-19

**Effort:** 1 session, ~3.5h wall-clock — TS7 validation spike ~1h (inside its
timebox), scaffold ~1.5h, review ~1h. **APPROVED on the first pass** — the
first feature in this repo to clear review without a rejection.
**Spec:** n/a (sdd: false). Contract = 4-item acceptance list in
`feature_list.json` + CLAUDE.md conventions.
**Tests:** 6 Vitest suites (one real-assertion controller spec per NestJS app)
+ 2 `passWithNoTests` stub runs; `pnpm quality` (lint + typecheck + test)
green end-to-end from a clean install. Full independent probe log in
`progress/review_monorepo_scaffold.md`.

**What was built:**

pnpm-workspaces monorepo: `pnpm-workspace.yaml` (apps/* + packages/*, pnpm 11
`catalog:` pinning every shared dep once), `tsconfig.base.json` (strict,
NodeNext, decorator metadata), flat `eslint.config.mjs` with the
**domain-purity `no-restricted-imports` rule** (scoped to
`apps/*/src/domain/**`; blocks `@nestjs/*`, drizzle-orm, kafkajs, nats,
mongodb — deep subpaths and type-only imports included, gitignore-style
globs — plus relative imports into `infrastructure/`/`presentation/`),
Prettier, root `quality` script. Six NestJS 11 app skeletons
(gateway 3001 … projector 3006, `<SERVICE>_PORT` env with fallbacks, clean
four-layer folders) + Nuxt 4 `apps/web` (WEB_PORT/3000) + two genuinely empty
package stubs (`shared-kernel`, `contracts` — zero runtime deps). Coverage
thresholds wired (60 apps / 80 packages) but deliberately inert until
phase 21. `.env.example` gained all seven port vars.

**TS7 spike outcome (the decision of this phase):** typescript@7.0.2 —
NestJS 11 DI + `emitDecoratorMetadata` **PASS** (real boot, real
`design:paramtypes`), Vitest **PASS**, Nuxt typecheck **FAIL**
(`vue-tsc@3.3.10` crashes with `ERR_PACKAGE_PATH_NOT_EXPORTED` on
`typescript/lib/tsc` — TS7's exports map removed the subpath vue-tsc
requires). One FAIL of three → the pre-agreed fallback rule fired →
**typescript@5.9.3 everywhere** (single lockfile entry, verified resolved in
all 10 workspaces). The reviewer reproduced the vue-tsc failure independently
from scratch — identical error, identical frame. Revisit TS7 when vue-tsc (or
Nuxt's Golar path) ships TS7 support; nothing else blocks it.

**Notes for #8 and #9:**

- The spike protocol worked: timebox + explicit fallback rule + evidence
  captured before deletion. Reuse it for any "bleeding edge vs. LTS" choice.
- Enforce layer purity with a **linter rule probed in both directions**
  (violation fails, removal passes) before trusting it — and test deep
  subpath + type-only evasions, not just the bare specifier.
- Advisory carried forward: add `**/application/**` to the domain-purity
  pattern group before the first aggregate feature; land the
  Testcontainers-Kafka topology test with the first Testcontainers feature
  (id 9); wire `eslint-plugin-vue` no later than the web feature.

---

## shared_kernel (id 7, phase 5) — 2026-08-19

**Effort:** 1 session, ~1.5h wall-clock — implementation ~1h, review ~0.5h.
**APPROVED on the first pass**, zero defects; mutation-probed 4/4 killed.
**Spec:** n/a (sdd: false). Contract = 4-item acceptance list in
`feature_list.json` + `specs/shared/domain-model.md` §2 (value objects) and
§7.1 (fact envelope), which the reviewer used as the authority.
**Tests:** 10 Vitest suites, 68 tests, **100% coverage on every metric**
(167/167 statements, 87/87 branches, 76/76 functions, 166/166 lines) —
and the coverage is not theatre: the reviewer's four hostile mutations
(GLN weights swapped, `Money.add` currency check removed, `Quantity`
accepting zero, `pullDomainEvents` not clearing) were each killed by at
least one failing test. Full probe log in `progress/review_shared_kernel.md`.

**What was built:**

`packages/shared-kernel` — the dependency-free domain kernel (only
non-relative import: `node:crypto`). Value objects per domain-model.md §2:
`Money` (integer minor units + ISO 4217 alpha-3, M1–M4 invariants,
cross-currency add/subtract/compare all throw, `mod100()` for the `.99`
simulator, safe for negative amounts), `Quantity` (strictly positive
integer), `GLN` (13 digits, real GS1 mod-10 check digit — verified by the
reviewer against GS1's published examples `0614141000005` and
`4012345000009`, plus an exhaustive 117-case single-digit-mutation test),
`UniqueId` (UUID v4 in the domain via `crypto.randomUUID()`),
`OrderNumber`/`DespatchReference`/`InvoiceReference`/`CreditLineReference`
(nominally distinct `<PREFIX>-######` types). Base classes: `DomainError`
(stable `code`), `Entity<T>` (identity equality, phantom-typed),
`AggregateRoot<T>` (`addDomainEvent`/`pullDomainEvents`, returns-and-clears
in order), and the §7.1 fact envelope (`DomainEventEnvelope`,
`createDomainEvent` — `eventId` generated in the domain —
`assertValidDomainEventEnvelope` enforcing R11 field completeness and the
`<aggregate>.<fact>.v<n>` pattern). Deliberate barrel in `src/index.ts`
with an exact-export-list test. ESLint domain-purity glob extended to
`packages/shared-kernel/src/**` and probed in both directions.

**Test-matrix flips:** R2, R3, R4, R11 → DONE; R1 → honestly **partial**
(domain-unit half DONE, API half stays TODO for the Gateway feature).

**Carry-forward for the Orders context:** `Money` validates ISO 4217
*shape* only; membership in the seeded currency catalogue must be enforced
by the Orders reference data when it lands (documented in `money.ts`).

**Notes for #8 and #9:**

- The GLN independent-oracle pattern (hand-derive check digits in a comment,
  then an exhaustive single-digit-mutation sweep justified by gcd(3,10)=1)
  is cheap and portable — reuse it verbatim in .NET and FastAPI.
- Reviewer mutation probes (3–4 hostile edits, confirm each is killed,
  restore) caught nothing here but cost ~10 minutes; keep them as the
  standard counterweight to 100%-coverage claims.

---

## contracts_package (id 8, phase 5) — 2026-08-19

**Effort:** 1 session (third feature of the 2026-08-19 phase-5 session, shared
with monorepo_scaffold and shared_kernel), ~2.5h wall-clock — implementation
~2h (including two generator-tooling surprises: the single-line `{}`
root-interface regex bug and `title`-beats-key naming), review ~0.5h
(approved first pass).

**Status:** APPROVED first pass — `progress/review_contracts_package.md`.

**What was built:**

`packages/contracts` — types generated from the two shared specs, never
hand-transcribed. OpenAPI 3.1 → `openapi-typescript@7`
(`paths`/`components`/`operations`); AsyncAPI 3.0 → extract
`components.schemas` (95 plain JSON-Schema definitions covering all 43
messages) + `json-schema-to-typescript@15`, with exactly two documented,
regression-tested transforms: `#/components/schemas/X` → `#/definitions/X`
ref rewriting, and stripping the three `title` keywords so exported names
stay 1:1 with schema keys (naming only — reviewer diffed all three shapes
against the spec field-by-field). Deterministic `pnpm contracts:generate`
(sorted definitions, banner without timestamp/absolute path), drift check
`pnpm contracts:check` (regenerates to a temp dir, diffs, exit 1 on drift —
also re-asserted inside `pnpm test`), deliberate barrel (`src/index.ts`:
kernel primitives, Envelope + both header shapes, 13 fact Payload/Event
pairs, 14 RPC request/reply pairs, RpcError/RpcTimeout, Gateway
paths/components/operations + 10 convenience aliases). 22 tests, incl. a
YAML-parsing completeness oracle (95 schema keys ↔ 95 exports). Generated
dir lint/prettier-ignored, generators devDependencies-only.

**Reviewer probes (all passed):** determinism (two runs, identical md5);
corrupt → check exits 1 with diff → regenerate → green; spec-copy mutation
(`heldAmount` rename in a scratch copy) surfaces in the generated diff while
the real specs stayed byte-clean; grep of all apps found no hand-written
contract shapes (only the scaffold `HealthPayload` stub, shape-distinct from
the spec's `HealthResponse` — to be retired at the gateway feature);
`pnpm quality`, `pnpm -r build`, `./init.sh` all exit 0.

**Notes for #8 and #9:**

- AsyncAPI 3.0 codegen tooling is thin in every stack; "extract
  `components.schemas`, feed a plain JSON-Schema-to-types generator" is the
  portable recipe (NJsonSchema for .NET, datamodel-code-generator for
  Python). Budget for the same two transforms: ref-base rewriting and
  `title`-vs-key naming.
- The completeness oracle (parse the YAML, assert one exported type per
  schema key, and assert the counts match) is the single test that catches
  silent type-dropping — port it verbatim.

**Phase 5 complete** — monorepo_scaffold, shared_kernel, contracts_package
all done.

---

## db_orders (id 9, phase 6) — 2026-08-20

**Effort:** 1 session, ~1.5h wall-clock — implementation ~1h (schema files,
migrator, committed `0000_*` SQL, 5 integration tests; file timestamps
06:17–06:30, drizzle journal stamped 06:26 local), review ~0.5h.
**APPROVED on the first pass**, zero blocking defects; 2 advisory notes
recorded for `outbox_and_idempotency` (id 14).
**Spec:** n/a (sdd: false). Contract = 2-item acceptance list in
`feature_list.json` + the task prompt's authoritative table shapes +
`specs/shared/domain-model.md` §3 / CLAUDE.md conventions, which the
reviewer used as the authority.
**Tests:** `migrations.integration.spec.ts` — 5/5 via Testcontainers
`mysql:8.4.11` (same pin as compose), re-run independently by the reviewer
(11.09s): migrations from empty (exact 9-table assert), per-table field-level
round-trip incl. outbox JSON payload and UTC datetime, `outbox.event_id`
UNIQUE proven by live ER_DUP_ENTRY, `(event_id, consumer)` composite UNIQUE
proven both ways (dup pair rejected, same event different consumer accepted),
`(published_at, occurred_at)` index asserted via information_schema.
**Gates:** `pnpm quality` green, `./init.sh` exit 0, ESLint domain-purity
untouched and clean; no Jest; `drizzle-kit push` never used — committed SQL +
own migrator (`runOrdersMigrations`) is the single path for CLI and test.
**Conventions locked for db_fulfillment/db_billing:** same two-config Vitest
split (`test:integration` outside `pnpm quality`), same script names, catalog
pins for drizzle-orm/mysql2/drizzle-kit/testcontainers already in
`pnpm-workspace.yaml`, `<APP>_DB_HOST` env pattern.
**Carried forward to feature 14 (binding, see `progress/review_db_orders.md`):**
(1) `outbox` lacks `causation_id` — R11/R12 need it stored (new `0001_*`
column or payload-as-full-envelope, decide there); (2) `occurred_at` is
DATETIME(0) — relay poll needs a deterministic tiebreak (sequence column or
`datetime(3)` + id); projector R50 ordering should use the envelope's
ISO-8601 `occurredAt`, not this column.
**Process note:** `progress/current.md` was stale ("idle — phase 5 complete")
throughout the feature — D2 lesson, third occurrence; leader to reset it at
session close.

---

## db_fulfillment (id 10, phase 6) — 2026-08-20

**Effort:** 1 session, ~1.25h wall-clock — implementation ~0.75h (schema +
plumbing file timestamps 06:39–06:41 local, one-pass `drizzle-kit generate`
thanks to full pattern reuse from db_orders), review ~0.5h.
**APPROVED on the first pass**, zero blocking defects; 1 advisory recorded for
`fulfillment_aggregate` (see below).
**Spec:** n/a (sdd: false). Contract = 2-item acceptance list in
`feature_list.json` + the task prompt's table shapes +
`specs/shared/domain-model.md` §4 / CLAUDE.md conventions, which the reviewer
used as the authority.
**Tests:** `migrations.integration.spec.ts` — 8/8 via Testcontainers
`mysql:8.4.11` (same pin as compose), re-run independently by the reviewer
(12.82s): migrations from empty (exact 6-table assert), per-table field-level
round-trip incl. outbox JSON payload and UTC datetimes, three live
ER_DUP_ENTRY probes (`stock (company_code, product_code)` proven composite
both ways, `outbox.event_id`, `processed_events (event_id, consumer)` proven
composite both ways), both index-existence asserts
(`idx_outbox_published_occurred`, `idx_reservations_order_status` with exact
column order), and a genuine cascade-delete assert for `despatch_items`.
**Headline check — cross-service purity:** the committed SQL
(`0000_nappy_mad_thinker.sql`) carries exactly two FKs, both internal
(`reservations.stock_id` → `stock.id` no-action; `despatch_items.despatch_id`
→ `despatches.id` cascade). `company_code`/`retailer_code`/`product_code`/
`order_reference` are plain varchars whose lengths match the orders schema
byte-for-byte (20/20/30/20).
**Outbox parity:** `outbox` + `processed_events` byte-identical to db_orders'
migration (columns, constraints, index) — diffed block-by-block. No
`causation_id`, correctly parked at feature 14 for all three DBs together.
**F1 (`reservedUnits <= units`) deliberately NOT a DB CHECK** — recorded in
`stock.schema.ts` with the aggregate-owns-invariants rationale plus the
intermediate-states argument. `reservations.status` is varchar + TS union
(`reserved|released|consumed`), not ENUM, per the orders precedent.
**Gates:** `pnpm quality` exit 0, `./init.sh` exit 0, domain-purity grep +
ESLint clean, no Jest, no `drizzle-kit push`; plumbing/scripts/deps diffed
against apps/orders — zero pattern drift (comment wording only).
**Advisory for `fulfillment_aggregate` (binding decision there, see
`progress/review_db_fulfillment.md`):** F8 ("at most one DespatchAdvice per
orderReference") has no DB unique on `despatches.order_reference` — either add
it in a `0001_*` migration and catch ER_DUP_ENTRY to keep the
idempotent-success semantics, or document why the race is impossible.

**Notes for #8 and #9:**

- The second database feature cost half the first (~1.25h vs ~1.5h with zero
  rejections) purely from pattern reuse — budget the first db feature as the
  expensive one and copy its plumbing file-for-file.
- Keep business-identifier column lengths in a single place (or at least
  cross-assert them): matching `company_code`/`product_code`/`order_reference`
  widths across service databases is what makes message-carried identifiers
  safe without FKs.

---

## db_billing (id 11, phase 6) — 2026-08-20

**Effort:** 1 session, ~0.75h wall-clock — implementation ~0.5h (schema file
timestamps 06:52–06:54 local, one-pass `drizzle-kit generate`, full pattern
reuse from db_orders/db_fulfillment; impl report 07:00), review ~0.25h.
**APPROVED on the first pass**, zero blocking defects; 1 REQUIRED follow-up
(pre-existing, not this feature) + 1 advisory (see below). **Phase 6 complete**
— all three service databases (otc_orders, otc_fulfillment, otc_billing) done.
**Spec:** n/a (sdd: false). Contract = 2-item acceptance list in
`feature_list.json` + the task prompt's table shapes +
`specs/shared/domain-model.md` §5 / CLAUDE.md conventions.
**Tests:** `migrations.integration.spec.ts` — 10/10 via Testcontainers
`mysql:8.4.11` (same pin as compose), re-run independently by the reviewer
(15.66s): migrations from empty (exact 7-table assert), per-table field-level
round-trip incl. outbox JSON payload and UTC datetimes, **five** live
ER_DUP_ENTRY probes (`credits (retailer_code, company_code)` proven composite
both ways, `invoices.invoice_reference`, `payments.payment_reference` — the
B10 remittance idempotency key, `outbox.event_id`,
`processed_events (event_id, consumer)` proven composite both ways), both
index-existence asserts (`idx_outbox_published_occurred`,
`idx_credit_items_credit_order` with exact column order), and a genuine
cascade-delete assert for `invoice_items`.
**Headline check — cross-service purity:** the committed SQL
(`0000_brown_hammerhead.sql`) carries exactly three FKs, all internal
(`credit_items.credit_id` no-action, `invoice_items.invoice_id` cascade,
`payments.invoice_id` no-action). `retailer_code`/`company_code`/
`order_reference`/`product_code` plain varchars, widths match the orders
schema byte-for-byte (20/20/20/30). Money int minor units throughout; the
only nullable business column is `invoices.paid_at` (B9).
**Outbox parity:** `outbox` + `processed_events` byte-identical to BOTH
db_orders and db_fulfillment (columns, constraints, index — six diffs, all
empty). No `causation_id`, correctly parked at feature 14.
**B1 deliberately NOT a DB CHECK** — recorded in `credits.schema.ts` with the
derived-sum-over-the-ledger rationale (stronger than F1's: inexpressible as a
single-table CHECK even in principle). `credit_items.type` / `invoices.status`
/ `payments.source` varchar + TS unions (`hold|release|consume`,
`issued|paid`, `operator|robot|test` — **`robot`, not `n8n`**, the approved
spec decision, verified in the TS union and exercised live in the round-trip).
`payments` has no `updated_at` (record-once remittance).
**Gates:** lint + typecheck + all suites green except the pre-existing
`packages/contracts` spawnSync timeout flake (see below); `./init.sh` exit 0;
domain-purity grep + ESLint clean; no Jest; no `drizzle-kit push`; zero
pattern drift vs siblings (comment wording only; package.json identical
modulo name).
**REQUIRED follow-up (owner: leader → test_maintainer, before the next
feature closes, see `progress/review_db_billing.md`):**
`packages/contracts` `scripts/check.spec.ts:71` and
`scripts/generate.spec.ts:38` (spawnSync of cold `tsx`) exceed the 5000ms
default under a full parallel workspace run — reviewer reproduced it (2
tests, worse than the implementer's 1) and confirmed 22/22 in isolation and
with `--testTimeout 30000`, and that `git diff` shows contracts untouched.
Pre-existing, unrelated — but a flaky `pnpm quality` is a gate people learn
to ignore. Fix = one/two-line timeout bump.
**Advisory for the invoice aggregate feature (binding decision there):** B7
("exactly one invoice per orderReference") has no DB unique on
`invoices.order_reference` — same shape as db_fulfillment's F8 advisory;
decide both together (add `UNIQUE` in a `0001_*` + catch ER_DUP_ENTRY, or
document why the race is impossible).

**Notes for #8 and #9:**

- The third database feature cost half the second (~0.75h vs ~1.25h vs ~1.5h,
  zero rejections throughout) — pattern reuse compounds; in the .NET and
  FastAPI runs, budget phase 6 as first-db-expensive and the rest near-free.
- The two "invariant not in the DB" flavours are worth distinguishing up
  front: same-row checks a CHECK could express but shouldn't (F1), vs
  ledger-derived sums no CHECK can express (B1). Static per-column uniqueness
  (F8/B7 order_reference) is the one class where a DB backstop is genuinely
  on the table — carry that decision into the aggregate features explicitly.

---

## seed_job (id 12, phase 7) — 2026-08-20

**Effort:** 1 session, ~0.5h wall-clock — implementation ~22min (file
timestamps 10:39–11:01 local: package/tsconfig scaffolding at 10:39, data
modules through 10:40–10:54, writers/integration spec through 10:59,
`feature_list.json`/`progress/current.md`/impl report by 11:01), review
~1h (full test re-run, live `pnpm seed` ×2 against compose, two full
cross-store order traces, independent GLN arithmetic, dependency/coverage
sweep).
**APPROVED on the first pass**, zero defects. **Phase 7 complete** — the
seed job is the last feature before the aggregate-implementation phases
(8–10) begin.
**Spec:** n/a (`sdd: false`). Contract = the 3-item acceptance list in
`feature_list.json` #12 + `specs/shared/domain-model.md` (read-model shape,
GLN check digit, money-as-minor-units) + `specs/shared/saga.md` (exact fact
sequence and compensation ordering).
**Tests:** 94 unit tests (pure — `src/data/*.spec.ts`,
`src/deterministic.spec.ts`, `src/writers/mongo.writer.spec.ts`, no
framework/DB imports) + 4 integration tests via real
`@testcontainers/mysql` + `@testcontainers/mongodb` (three logical MySQL
databases on one container, real migrations, no mocked brokers) — all
re-run independently by the reviewer, all green.
**Live verification (reviewer, against the running compose stack, not
relayed from the implementer):** ran `pnpm seed` twice; identical summaries
both times; independently recomputed
`MD5(GROUP_CONCAT(orders.id ORDER BY id))` = `23c7f093e43aac39f5318393be207070`
both runs, matching the implementer's reported value exactly.
`SELECT COUNT(*) FROM outbox WHERE published_at IS NULL` = **0** and
`published_at < occurred_at` count = **0** in all three live DBs.
**Traced `ORD-000001` (completed) end to end**: order total 17492 = Σ
line totals (hand re-added); reservations `consumed`; despatch
`DES-000001` matching reservation lines; credit ledger `hold → consume →
release`, each 17492, in the right causal order; invoice `INV-000001`
`paid`, payment `PAY-SEED-000001` 17492; all nine outbox facts across the
three DBs in exact `saga.md` §3.1 order with matching `correlationId` /
fact-appropriate `aggregateId` / spec-shaped payloads; MongoDB
`order_timeline` document matches field-by-field, same nine `eventId`s as
the outbox rows, ordered by `occurredAt`.
**Traced `ORD-000006` (cancelled) end to end**: `.99` total
(`24999 mod 100 = 99`), reservation `released`, no despatch/invoice/credit
rows, five-fact compensation sequence
(`order.placed → stock.reserved → credit.rejected → stock.released →
order.cancelled`) in both MySQL outbox and the MongoDB timeline, exactly
matching `saga.md` §4.2/§4.4's release-then-cancel ordering.
**GLN check digits — hand-computed independently** (own arithmetic per
`domain-model.md` §2.4's mod-10 algorithm, not a re-run of the library):
`CarrefourEs 5400000000010` (sum 20 → check 0), `AldiDe 5400000000065`
(sum 35 → check 5), `ALBIONFOODS 5400000000331` (sum 29 → check 1),
`BAUWERK 5400000000294` (sum 46 → check 4) — all four correct.
**Idempotency semantics** — read every writer: all use
`INSERT … ON DUPLICATE KEY UPDATE` on the deterministic key, never
delete-and-recreate — safe to re-run mid-demo without breaking references.
**Determinism** — grepped for `Math.random`/`Date.now()`/bare
`new Date()`/stray `randomUUID`: none found outside `deterministic.ts`'s
SHA-256 derivation and `clock.ts`'s fixed-epoch helpers.
**Stock arithmetic** — IBERFOODS: PRD-0001 stays at the 500-unit baseline
(released reservation, units correctly unchanged per domain-model.md §4.2),
PRD-0002 495 (500 − 5 consumed), PRD-0003 497 (500 − 3 consumed) — all
consistent, hand-recomputed.
**Credit limits** — 500000 minor units (5000.00) for every one of the 7
retailers; over-limit rejection genuinely constructible against product
prices up to 24999 without an absurd order size.
**`causationId` omission** — verified directly against all three committed
`outbox.schema.ts` files: none has the column yet (feature 14's decision),
so the seed's omission is faithful, not a shortcut.
**Data/writer separation** — `src/data/*.data.ts` import no
Drizzle/mysql2/mongodb/service-schema; only `src/writers/*.writer.ts` do —
genuinely portable fixture shapes for #8/#9.
**Gates:** `pnpm run quality` (lint + typecheck + test, whole monorepo) —
all green, including `apps/seed` (94/94); `./init.sh` exit 0; `git status`
scope clean (only `apps/seed/` + expected config diffs).
**Notes for #8 and #9:** the data/writer split (`src/data/` fixture
modules with zero infrastructure imports, `src/writers/` the only layer
touching a driver) is the reusable idea, not the code — a .NET or FastAPI
seed job can mirror the same fixture *shapes* (7 retailers, 22 companies,
12 products, one credit line per retailer, the 5-completed +
1-`.99`-cancelled saga set) without porting any TypeScript.

---

## orders_aggregate (id 13, phase 8) — 2026-08-20

**Effort:** 1 session, ~1.5h wall-clock — spec pass ~0.5h (`specs/orders_aggregate/design.md` written 14:56, gate record 14:58 local, then the human approval gate with 2 amendments + 1 addition, which grew `tasks.md` from 38 to 44 tasks), implementation ~32min (file timestamps 15:01–15:33 local: closed types and errors 15:01–15:03, port and barrel 15:07, event builders 15:10, the `description` migration and seed fix 15:16–15:17, the six spec files 15:25–15:28, `requirements.md`/`tasks.md` traceability flips 15:29–15:30, impl report 15:33), review ~25min (independent re-run of unit + coverage + both Testcontainers suites + root `pnpm quality` + `init.sh`, six mutation probes, an ESLint purity probe of my own, a live read-only MySQL inspection and a throwaway spec to test a suspected currency hole).
**APPROVED on the first pass**, **6 defects, all minor, none blocking**; **4/4 tasked hostile edits KILLED**. Full record: `progress/review_orders_aggregate.md`.
**First `"sdd": true` feature — C6 walked in full for the first time.** All three spec documents present, all 44 tasks verified one by one (not just read as ticked), `R5`–`R10` and `OA1`–`OA5` each traced to a named non-vacuous case. C6's last box (spec commit precedes implementation commit) is `[~]` — unsatisfiable by any agent since Claude never commits; the human must commit `specs/orders_aggregate/` + `progress/spec_orders_aggregate.md` **first**, then the implementation.
**Spec:** `specs/orders_aggregate/{requirements,design,tasks}.md` + gate record `progress/spec_orders_aggregate.md` (16 open points, 2 post-gate amendments, 1 addition). Notable resolutions, all verified in code: T-1 governs O8 so five internal edges emit nothing (OA2); `OrderSnapshot` carries **no totals fields at all**, so stored/derived drift is unrepresentable rather than detected (OA3, open point 12); time enters as a `TransitionContext` argument, **no `Clock` added to `shared-kernel`** (open point 6); the domain owns `OrderStatus`/`CancellationReason` with two parity tests, one per boundary (open point 7); reason↔status pairing enforced (OA4, open point 9); the repository **adapter deliberately not built** — port interface only, adapter deferred to feature 15 (open point 5).
**Both post-gate amendments landed in full:** (1) `order_items.description` — schema + generated migration `0001_small_vertigo.sql` + the existing Testcontainers round-trip updated + `apps/seed` fixture and writer fixed, seed still green end to end; (2) `@otc/shared-kernel` and `@otc/contracts` declared in **all three** service apps (orders, billing, fulfillment), not just orders.
**Tests:** 166 pure domain unit tests, 8 files, zero framework imports (ESLint-proved in both restricted directions by the reviewer's own probe, not by re-reading the implementer's) + the 5-test Testcontainers migration suite and the 4-test seed integration suite, all re-run independently, all green. **Domain coverage 98.5 % stmts / 91.25 % br / 100 % funcs**, overall 95.81 % — reproduced byte-identically by the reviewer; every uncovered branch inspected and found to be an optional-`orderId` message ternary or an unreachable defensive throw.
**The decisive test is real:** the 9 × 9 = 81 `(from, to)` product is checked directly against `findTransition` (11 legal / 70 illegal, asserted numerically), and the 61 illegal pairs a public command method can attempt are driven through the real aggregate asserting the error, unchanged status/totals/lines and an empty `pullDomainEvents()`. The remaining 9 (`to: 'placed'`) have no public method at all — unrepresentable rather than rejected, disclosed by the implementer rather than papered over.
**Mutation results (reviewer, each restored byte-exact afterwards):** illegal edge `placed → paid` added to the table → KILLED by `Order — R9`; `reconstitute` made to emit an event → KILLED by `Order.reconstitute — OA3`; both reason↔status guards deleted → KILLED by `Order.cancel — OA4` (5 failures); `'confirmed'` added to `LINES_MUTABLE_IN` → KILLED by `Order — R7` (4 failures). Two extra probes: relaxing the funnel's emission condition is an *equivalent* mutant (survives, correctly), and blanking Table T-1 **row 1**'s `emits` cell survives all 166 tests — the one genuine assertion gap found (defect D1: `CREATION_TRANSITION` is dead code and `Order.place` never consults the table).
**Two implementer disclosures, both checked against the live system and both honest:** (a) the pre-existing bare `data/` in `.gitignore` had hidden `apps/seed/src/data/` from git since phase 7 — correctly flagged and correctly *not* fixed by the implementer (root config is the leader's); the leader's `/data/` anchoring verified correct in both directions (root and `infra/**` bind mounts still ignored, the 11 seed sources now visible, and `find` confirms no other `data/` directory could have been exposed). (b) Task J5's live-database recreation was blocked by a destructive-action guard; the Testcontainers substitution was **ruled adequate** — `runOrdersMigrations` is the same function `db:migrate` calls, run against a container that has never seen a `CREATE TABLE`, so `0000`+`0001` really are exercised from empty, and the seed integration spec runs the full migrate → seed → verify chain. Reviewer confirmed independently that the live `otc_orders` still lacks the column (11 rows, 1 migration row): an environment residue for the human, not a code defect.
**Defects (all minor, none blocking):** D1 dead `CREATION_TRANSITION` + inert row-1 `emits` cell; D2 the funnel's jointly-gated emission vs design §5's "the table drives it"; D3 `Order.reconstitute` lets the kernel's `CurrencyMismatchError` escape instead of the aggregate's own (outside OA1's literal scope, but a real O2 hole on the path feature 15's adapter will use — proved with a throwaway spec, since deleted); D4 `progress/current.md` out of lockstep with `feature_list.json`; D5 the spec is not yet committed, so C6's spec-first box stays `[~]`; D6 nothing asserts the *content* of `order_items.description`, only that it round-trips.
**For #8 and #9:** the reusable artefact is `requirements.md` §5 — `OA4` (reason↔status pairing) and `OA1` (single-currency invariant raised at the aggregate boundary) are recorded as **promotion candidates** for `specs/shared/` at feature 38, with the reason spelled out: #8 and #9 read only the shared spec, so left local these two would produce three implementations that genuinely differ in behaviour — the one outcome the trilogy exists to rule out. `OA2`/`OA3`/`OA5` are recorded as deliberately *not* promotable, so feature 38 need not re-derive the judgement. Also portable, and independent of TypeScript: Table T-1 as a data table rather than a switch cascade, and the 9 × 9 exhaustive proof it makes possible.

---

## outbox_and_idempotency (id 14, phase 8) — 2026-08-20

**Effort:** 1 session, ~2.4h wall-clock — spec pass ~30min (`specs/outbox_and_idempotency/` written 16:23–16:50 local, gate record 16:52, then the human approval gate: all 26 open points accepted as written, 2 of them consciously — the speculative `trace_parent` column and the reversal of feature 13's deferral of the repository adapter — plus 1 amendment that added `OI12` and grew `tasks.md` from 55 to 57 tasks), implementation ~60min (file timestamps 16:56–17:52: the three-database schema edit and its migration 16:56–17:00, the four ports 17:07–17:08, unit of work + recorder + mapper + repository 17:09–17:13, the atomicity spec 17:14, the relay and its Kafka adapter 17:15–17:24, the real-Kafka fixture and the relay integration specs 17:23–17:28, the idempotent-consumer pair and its specs 17:38–17:47, traceability flips and impl report 17:46–17:52), review ~50min (independent `pnpm quality` ×2, repo-wide `pnpm test:integration` ×1 plus five targeted `apps/orders` integration re-runs for the mutations, coverage, `init.sh`, an ESLint purity probe, a throwaway R13 probe spec, 5 hostile mutations, both parity guards re-armed with my own divergences, and a live-stack run of the real seed + real relay + real Kafka on scratch databases).
**Spec:** `specs/outbox_and_idempotency/{requirements,design,tasks}.md` + gate record `progress/spec_outbox_and_idempotency.md` (26 open points, §7 post-gate amendment).
**Tests:** `apps/orders` 181 unit (12 files) + **22 integration across 7 files** — the first real Kafka in this repository (`apache/kafka:4.3.1`, the pinned compose tag, driven through `GenericContainer` per `design.md` §9's own fallback clause, 6 partitions / RF 1, no auto-creation); `apps/seed` 103 unit + 6 integration. Proves shared `R12`, `R13`, `R14`, `R15`, `R17`, `R18` (flipped to `DONE` in `specs/shared/test-matrix.md`; `R11` already green; **`R16` deliberately left `TODO` for feature 27**, a deferral ratified at the gate) and local `OI1`–`OI12`.
**APPROVED on the first pass**, **10 defects, none blocking**; **5/5 hostile mutations KILLED**. Full record: `progress/review_outbox_and_idempotency.md`.

**What was built:** the coordinated three-database migration (`causation_id char(36) NOT NULL`, `seq bigint unsigned AUTO_INCREMENT UNIQUE`, `trace_parent varchar(64)` NULL, `occurred_at` widened to `datetime(3)`, `idx_outbox_unpublished_seq (published_at, seq)` added alongside the retained lag index) with **byte-identical bodies** in `orders/0002`, `fulfillment/0001` and `billing/0001`; the outbox writer (`UnitOfWork` port with an opaque branded `TransactionContext`, `save(order, tx)` with `tx` required, `DrizzleOrderRepository` draining `pullDomainEvents()` into `OutboxRecorder` inside the caller's transaction); the polling relay (`claim FOR UPDATE SKIP LOCKED ORDER BY seq → publish → stamp`, a plain class with a thin self-scheduling `@Injectable()` wrapper); the kafkajs producer adapter with the idempotent producer enabled; and the canonical idempotent-consumer pair, insert-first against the `(event_id, consumer)` unique index with no `SELECT` anywhere in the dedup path. Both Phase-6 advisories closed: causation is durable, and publication order is a tie-free store-assigned sequence.

**Deviations from the spec/plan (all disclosed by the implementer, all ruled justified by the reviewer):** (1) real Kafka driven through `GenericContainer` rather than `@testcontainers/kafka` — `design.md` §9 instructs exactly this fallback, with the same pinned tag, and every condition it attached was met; (2) `drizzle-kit generate --custom` for the coordinated migration — the sanctioned escape hatch of §3.4, forced by MySQL's `ER_WRONG_AUTO_KEY` (1075) on `ADD seq bigint unsigned AUTO_INCREMENT`, with the exact rejected SQL recorded; (3) `OI12`'s forbidden-word check widened from `\b…\b` to a substring match — the reviewer verified independently that the `\b`-bounded pattern `design.md` §6.4 prints returns **false** for `BillingDb` and `OrdersIdempotentConsumer`, i.e. it cannot do what §6.4's own worked example demands, so the substring form is the design's intent implemented rather than drift (§6.4's printed pattern should be corrected at feature 38). Plus the whitelist gaining the pair's own sibling import, and the `R15` case renamed to the matrix's exact wording.

**Reviewer's independent evidence, beyond re-running the suites:** a throwaway spec forced failure *during* the outbox write — both by throwing after the aggregate rows were in the transaction and by making the database itself reject a duplicate `event_id` — and neither left an aggregate row behind; the claim SQL was printed and matches §5.2 verbatim (`… where published_at is null order by seq asc limit ? for update skip locked`); byte-identity of the `outbox`/`processed_events` statements across all three migration sets was re-derived independently of `OI11`; and the **first live proof** of the whole chain was taken on the running compose stack without destroying it — scratch databases seeded by the real `pnpm seed`, the real `OutboxRelay` reporting `{claimed:0, published:0}` with its publisher never called, then one hand-inserted row claimed, published, stamped (`seq = 18`) and read back off the live `otc.orders.facts.v1` on partition 4, keyed by the order id, with `x-event-type` and `content-type` headers and no `traceparent` (the documented, dated gap for feature 27). Scratch databases dropped; the human's data untouched.

**Mutation results (reviewer, each restored byte-exact and md5-verified):** stamp `published_at` before the acknowledgement → KILLED by `R14` and `OI8`; drop `SKIP LOCKED` → KILLED by `OI5` and `OI8` (`ER_LOCK_WAIT_TIMEOUT`); order the poll by `occurred_at` instead of `seq` → KILLED by `OI2` and `R15`; commit the dedup record in its own transaction ahead of the handler's → KILLED by *a failure in work leaves no dedup row*; disable the idempotent producer → KILLED by `OI7`. Both parity guards re-armed with the reviewer's own divergences (`char(40)` in billing's migration; `BillingDb` written into the canonical body; a real `@EventPattern` planted in `apps/fulfillment`) and all three fired.

**Defects (none blocking):** D1 orphan `apps/orders/drizzle/meta/0003_snapshot.json` with a broken `prevId` chain (harmless today — `db:generate` still reports no changes — but committed cruft); D2 `OUTBOX_PUBLISH_TIMEOUT_MS` is dead configuration, so `design.md` §5.2's claim that the open claim transaction is bounded by it is false as shipped; D3 `@testcontainers/kafka` installed and never imported; D4 the manual-verification `INSERT` in the impl report uses `NOW(3)` against a `TZ=Europe/Madrid` MySQL, publishing an `occurredAt` two hours in the future (reproduced live) — should be `UTC_TIMESTAMP(3)`; D5 `findByReference` delivered but exercised by no test; D6 the matrix's **Total** Green cell still reads 0 against 16 green rows; D7 a publish failure commits an empty transaction rather than rolling back, contrary to §5.3's wording; D8 `seq` typed nullable in the Drizzle model though MySQL makes it `NOT NULL`; D9 `OI9`'s discipline rule is demonstrated, not guarded; D10 `R17`'s matrix-named case survived the "same transaction" mutation — only its sibling case caught it.

**Notes for #8 and #9:** the portable ideas are the two **instruments**, not the code. First, a pure-text parity test over *committed artefacts* — applied twice here, once to three migration bodies (`OI11`) and once to the hand-copied consumer pattern (`OI12`) — which converts a rule reviewers had been enforcing by hand into a check, and, in `OI12`'s case, converts a property of the test into a constraint on the code (byte-identity is only satisfiable if the pattern names no service). Second, the four-case shape that lets a parity guard exist honestly before the set it guards is populated: two cases meaningful at n = 1, two that arm structurally, and a copy/variant discriminator read from the filesystem rather than from a hand-maintained list. `requirements.md` §5 also records the four **promotion candidates** for `specs/shared/` at feature 38 — `OI1` (the envelope must survive storage), `OI2` (deterministic publication order), `OI4`+`OI5` (exclusive claim and crash recovery), `OI10` (concurrent duplicate delivery) — each of which, left local, would let three conforming implementations behave genuinely differently; `OI12` is explicitly **not** a candidate, because #8 can share one project and #9 one module and would have nothing to keep in parity.

---

## orders_acceptance (id 15, phase 8) — 2026-08-21

**Effort:** 2 implementation sessions + **2 review passes** — the first feature in this project to be **REJECTED and re-submitted**. Wall-clock derivable from artefacts, ~4h on 2026-08-21 local (CEST): implementation session ending ~06:40 (its live check wrote `ORD-000007` at `04:38:56Z`), **review pass 1** ~07:00–07:54 (`progress/review_orders_acceptance.md` written 07:54), **fix pass** 07:54–08:09 (live re-checks `ORD-000008`/`ORD-000009` at `06:06:25Z`/`06:07:18Z`, impl report rewritten 08:09), **review pass 2** 08:10–08:55 (this record). Precise per-phase timings for the *first* implementation pass are **not recoverable**: every working-tree mtime was bulk-rewritten to `08-21 07:54`, so the usual file-timestamp method fails here — the timings above are derived instead from the live-check rows still in `otc_orders.orders` (`created_at` is UTC, the container's `NOW()` is local) and from the two progress files' own mtimes. Feature 14 was committed 08-20 18:51, which brackets the start.
**REJECTED on pass 1** (1 blocking defect, 7 non-blocking; **3 of 4 hostile mutations killed**), **APPROVED on pass 2** (blocking defect closed, 6 non-blocking defects open, **none blocking**; **M3 and 4 further mutations of the reviewer's killed**). Full record: `progress/review_orders_acceptance.md` (pass 1 §§1–14, pass 2 appended as *Second pass*).

**The blocking defect, named:** **D1 — the reply's money mapping was vacuously covered.** `orders-create.controller.ts`'s mapping was *correct*; what failed was the test suite. Every fixture in the repository used `initialDiscount: 0`, so `initialAmount`, `initialDiscount` and `totalAmount` all collapsed to the same number and nothing could tell them apart. Replacing `totalAmount: result.totalAmount` with `totalAmount: result.initialAmount` — a plausible, silent, money-affecting bug — left **206/206 unit and 3/3 acceptance integration tests green**. The consequence was not merely a wrong number on the wire: `asyncapi.yaml:1811` makes `totalAmount mod 100 = 99` the credit-simulator predicate (R42), so a wrong `totalAmount` would change which orders the saga rejects in feature 22. **Lesson for #8 and #9, and the most portable thing this feature produced: a happy-path fixture with a zero discount makes money assertions *look* complete while proving nothing. Pick pairwise-distinct values (here 2000 / 300 / 1700) for every field that can stand in for another.**

**Fix pass, verified by the reviewer's own probes rather than the report:** D1 closed — M3 now fails at **unit and integration level**, and two further mutations of the reviewer's on a *different* layer (`place-order.handler.ts`'s `toResult`, `initialDiscount ← totalAmount` and `initialAmount ← totalAmount`) are killed too. D2 closed — `app.enableShutdownHooks()` added to `main.ts`, proved against the **real `AppModule`** with a genuine `kill -TERM` (`RELAY_DRAIN_STARTED:SIGTERM` → `RELAY_DRAIN_COMPLETED`, and nothing at all with the one line removed), which re-arms **feature 14's `OutboxRelayService` graceful drain** — the silent casualty of the missing line. D5 closed — `tsconfig.build.json` now excludes `src/**/test-support/**`; a clean rebuild emits 59 `.js` files and no stub. D6 closed — numeric `MAX(CAST(SUBSTRING(...)))`, proved discriminating by reverting it and watching the new test fail. D7 recorded as a dated design note. D8 root-caused to `kafkajs@2.2.4`'s `RequestQueue.scheduleCheckPendingRequests()`, where the clamp sits inside `if (this.pending.length > 0)` so `scheduleAt` stays `-Date.now()` — the reviewer read the upstream source and confirmed the observed `-1787293684517` is current epoch ms to the digit; cosmetic, left unpatched, dated comment added.

**The reviewer was wrong once, and the implementer caught it.** Pass 1's D6 claimed `OrderNumber.fromSequence` *widens* past six digits. It does not: `BusinessReference.format()` throws when the padded string is not exactly six characters, and `parse()` rejects `ORD-1000000` too — verified directly in pass 2. So the lexical-vs-numeric `MAX` trap is **unreachable through the domain** and the fix is defence-in-depth, not a live bug closed. The correction stands; pass 1's severity framing was overstated. It also surfaced an unowned fact: **the domain has a hard ceiling of 999 999 orders per reference type, enforced by a throw.**

**`requestId` idempotent replay scoped out honestly** and opened as `feature_list.json` id **39** `orders_idempotent_replay` (`sdd: true`, three acceptance criteria including the concurrent-duplicate race). `asyncapi.yaml`'s normative sentence is deliberately **left standing** as the target contract for #8 and #9; the code says plainly that a repeated `requestId` places a second order today and points at feature 39. Contract states the target, state machine tracks the gap, code overclaims nothing.

**A cross-cutting, leader-directed fix landed in the same pass: the DI-metadata divergence.** `tsconfig.base.json` sets `emitDecoratorMetadata: true`, so `tsc` emits `design:paramtypes` — but all six services' `dev` script was `tsx watch`, and esbuild does not implement that option, so **the same source behaved differently under `pnpm dev:*` and `pnpm start`**: a bare-typed constructor parameter resolved to `undefined` with the container still building cleanly, failing only at first use. Closed at source — all six services now run `tsc-watch -p tsconfig.build.json --onSuccess "node dist/main.js"` — plus a `CLAUDE.md` non-negotiable ("Explicit DI tokens, always") and an ESLint `no-restricted-syntax` guard. The reviewer verified it on **real code** (stripping `@Inject` from `OrdersCreateController`: `tsc` → `design:paramtypes = ['PlaceOrderHandler']`, `tsx` → `undefined`), **started all six services** under the new script, and armed the guard with **two violations of its own** including the feature-16 `@CommandHandler` shape. This had to close before feature 16, the first `@nestjs/cqrs` graph in the repository, where bare-type injection is the idiom.

**`tsc-watch` vs SWC, measured and ruled sound:** cold `dev` start 7.0 s vs `tsx`'s 2.0 s (**+5 s once per session**), edit→restart **1.8 s vs 2.1 s** (the number developers actually feel is unchanged, marginally better, because `tsc --watch` keeps the program in memory), and a type error now blocks the restart and keeps the last good build running instead of shipping the error into the process. SWC would buy back the 5 s by adding a third compiler whose `decoratorMetadata` is a re-implementation of `tsc`'s — a parity approximation, i.e. the exact class of divergence just closed. **Keep `tsc-watch`; do not revisit for SWC.** If the cold start ever grates: `"incremental": true` + a `tsBuildInfoFile`.

**What was built (feature proper):** the NATS hybrid app (`connectMicroservice`, core NATS, no JetStream) serving `orders.create` as an RPC responder that **never throws** — success and `RpcError` are two payload shapes on one reply address; the synchronous `fulfillment.stock.check` RPC client with an explicit per-call timeout budget, typed distinctly from a business rejection (`StockCheckTimeoutError` vs `StockCheckTransportError`) and mapped to `RpcError.code = 'TIMEOUT'`; `PlaceOrderHandler`, which resolves reference data and checks stock **before opening any transaction**, then allocates the order number, places the aggregate and saves it — with the `order.placed.v1` outbox row — inside **one** `UnitOfWork`; and a self-initialising `ORD-######` allocator (`SELECT … FOR UPDATE` inside the placing transaction, seeded from `MAX` over the existing `orders` table).

**Reviewer's independent evidence across both passes:** 24 allocators racing in 24 separate real-MySQL transactions produced a gap-free, duplicate-free `1..24`; a forced outbox failure *after* the aggregate rows were provably visible inside the transaction left no order, no outbox row, no item and no burned sequence number; a subscriber that accepts and never replies bounded the RPC at its 800 ms budget (`808 ms`) rather than hanging; a virgin counter over a table already holding `ORD-900000` continued at `ORD-900001`; the shutdown drain was proved on the real `AppModule` with a real signal; and the M3 mutant was killed over the real NATS wire against real MySQL.

**Ruling recorded for later features: gap-free order references are the correct contract, and the price is explicit.** Allocation inside the placing transaction means a rollback *returns* the number instead of burning it — but the exclusive lock on the single counter row is held until commit, so **every concurrent `orders.create` serialises behind the slowest one**. That is the throughput ceiling of order acceptance. Now a dated design note in `place-order.handler.ts`, so feature 16 and any load-testing feature inherit it as known rather than rediscovering it as a mystery.

**Defects open at approval (6, none blocking):** N1 the new `main-shutdown-hooks.spec.ts` is timing-fragile — its two child-process probes failed on 1 of 8 full unit runs (the session's first cold-cache run), fixable by one constant or by moving them to the integration config; N2 the DI guard proves the two compilers differ but nothing guards `emitDecoratorMetadata` or the six `dev` scripts themselves, so reverting either would leave the whole suite green; N3 the ESLint selector matches only `TSParameterProperty`, so a manually-assigned bare-typed constructor parameter evades it (demonstrated); N4 the `test-support` build exclude landed in `apps/orders` only, and the other five services each create their first such directory in features 17/21/23/25/26; N5 (pre-existing, another package) `packages/contracts` `check.spec.ts:22` still on Vitest's default 5 s against a 683 ms baseline — a *different* test from the two the phase-6 `test_maintainer` pass fixed at lines 72–82; plus the carry-over **D4**, `progress/current.md` out of lockstep with `feature_list.json` for the **third** time across features 13 and 15.

**For #8 and #9:** three portable artefacts, none of them TypeScript. (1) The **distinct-money-fixture rule** above — the defect that rejected this feature is a test-design defect any stack reproduces verbatim. (2) The **two-shapes-on-one-reply-address** RPC contract: an error is a payload, not a transport exception, which keeps the responder's failure modes in the schema instead of in a framework's exception mapper. (3) The **gap-free-vs-serialised** trade as an explicit, dated decision rather than an accident of where the allocation call happens to sit — #8 and #9 will each face the same choice at the same line. The DI-metadata story is stack-specific (it is a TypeScript-decorator-metadata problem) but its *shape* is not: **whenever the dev runner and the build compiler are different programs, assume they disagree, and make the disagreement fail a test rather than a production request.**

---

## order_saga_orchestrator (id 16, phase 8) — 2026-08-21

**Effort:** 1 spec session + 1 human gate revision + **1 implementation session** + **1 review pass**, approved first time. Wall-clock from artefact mtimes (local CEST, 2026-08-21): spec `design.md` 10:50 and the post-gate revision in `progress/spec_order_saga_orchestrator.md` 10:51 (the spec itself was committed earlier as `e5641b3`'s sibling in the gate cycle; feature 15 committed 09:47 brackets the start); implementation **≈10:52 → 12:38** (`0004_melodic_microbe.sql` 11:01, `saga-steps.ts` 11:01, `saga-consumption.integration.spec.ts` 12:14, `requirements.md` flips 12:21, impl report + `tasks.md` 12:37) — **≈1 h 45 min**, including the G1 live-stack walkthrough that found and fixed the transport-binding crash; review **12:40 → 13:15, ≈35 min**, of which ~15 min was Testcontainers wall-clock (baseline 376 s + three probe files + three integration mutation runs). Cheapest `sdd: true` feature of phase 8 by a wide margin, on the most complex surface — the spec (35 tasks, a step table the implementer could transcribe) is what bought that.
**APPROVED** (7 defects, none blocking; **5/5 hostile mutations killed**; **0 step-table divergences** against `specs/shared/saga.md`). Full record: `progress/review_order_saga_orchestrator.md`.

**What was built:** the orchestrator inside Orders — three `@EventPattern` Kafka consumers (group `orders.saga`, `fromBeginning`) → `CommandBus` (ten `Handle<Fact>FactCommand`s whose handlers are the whole transactional unit over the unmodified `IdempotentConsumer`: dedup-insert-first, strict-equality precondition with a durable `saga_ignored_facts` record on mismatch, aggregate transition, durable `saga_commands` enqueue, all in one transaction awaited before the offset commits) → post-commit `EventBus` → `@Saga` `OrderSagas` → five `Issue…Command`s → `SagaCommandDispatcher` (3 attempts × 5 s, 500/1 000 ms backoff, business rejections marked `sent` and never retried, exhaustion parks the row) with `SagaCommandSweeperService` re-issuing `pending`/`parked` rows on a capped 30 s → 15 min schedule, calling the dispatcher directly and never the bus. The 13-fact step table is data (`saga-steps.ts`), unit-tested fact × status (108 cases). `@nestjs/cqrs` is the one package installed, per the human's row-3 overrule at the gate.

**Reviewer's independent evidence, beyond re-running 384 unit + 51 integration tests:** (1) **the cqrs hop physically removed** (`OrderSagas` mocked to an empty class) and the **real** sweeper service alone drove an order from a `pending` row through park (`attempts` 3 → 6, order still `placed`) to `invoiced` with all four command rows `sent` the moment stub responders appeared — the durable table is the guarantee, demonstrated rather than argued; (2) a business-rejected `stock.reserve` → `sent`, one request, zero releases, only one row; (3) `credit.rejected.v1` redelivered with the same id mid-compensation (release parked, order `stock_reserved`) → dedup hit, one row, no change; then `stock.released.v1` → `cancelled`/`credit_rejected` with the one `stock_released` step carrying that fact's id, and its own redelivery → `precondition_unmet`, still one `order.cancelled.v1`; (4) a clean boot against the live compose stack and the three parked `ORD-000007/8/9` rows re-attempted unattended on the capped schedule (3 → 6 → 9).

**Mutations (all restored byte-exact, md5-verified):** precondition check disabled → KILLED (R25 unit); `stock.rejected.v1` made to owe `stock.release` → KILLED (5 unit cases; the wire-level integration R26 case survived — defect D3); dedup skipped for one fact → KILLED (unit duplicate case + integration R18 same-eventId redelivery); business rejection retried → KILLED (SO6 unit); dispatch-owed event published before commit → KILLED (2 unit cases + the happy path stalling at `placed`).

**The defect that matters (D1, not blocking):** a **distinct-eventId** duplicate of a fact whose precondition is still met (e.g. a second `credit.rejected.v1` while `stock.release` is parked) hits `uq_saga_commands_order_command`, the transactional unit rejects, and kafkajs loops crash/restart on that offset — a poison partition with no DLQ until feature 27. No producer does this by invariant, which is why it does not block; the fix is an idempotent `enqueue` on `(order_id, command)` plus one integration case, to land before R16 is claimed. Also: the dispatcher stamps `next_attempt_at` with `Date.now()` rather than the `Clock` port (D2), which is the real reason no integration test runs the sweeper *service* (the fixed `FakeClock` can never make a parked row due); `0002_snapshot.json.prevId` is still the feature-14 orphan id (D4, second review to say so); the broker group is actually `orders.saga-server` — Nest appends `-server` — so the "same string as the dedup ledger" claim in `main.ts`/design §3.1 is false (D5).

**Ruling recorded for features 17–25 — the transport-binding convention.** The implementer's live walkthrough found that a `@MessagePattern`/`@EventPattern` with no explicit `Transport` binds to **every** connected microservice server; the NATS-only `orders.create` was registered on the new Kafka server and crashed the boot with `UNKNOWN_TOPIC_OR_PARTITION`, 100 % reproducible, invisible to every single-transport `TestingModule`. Every remaining service is hybrid and will reproduce it. **Promote now:** a CLAUDE.md non-negotiable (every pattern decorator names its transport) plus an ESLint `no-restricted-syntax` guard on bare `MessagePattern`/`EventPattern` decorators, next to the DI-tokens rule. Leader action before feature 17.

**For #8 and #9:** four portable things. (1) **The step table as data, tested fact × status exhaustively** — the spec's §3.1/§4/§5/§6 tables transcribe to one structure per stack, and a 13 × 9 sweep is the cheapest proof that the orchestrator's preconditions are exactly the state machine's legal-edge sources. (2) **Commit-before-issue with a durable owed-command row** — the only design under which an in-process bus (MediatR in #8, a plain dispatcher in #9) is safe in a distributed saga: it must be an optimisation over a queue that would deliver the same command anyway, and the review must *remove the bus* to prove it. (3) **Business rejection is a resolved reply, not an error** — the retry policy must key on transport failure, and the test that proves it is "exactly one request, row `sent`", not "no exception". (4) **Idempotent enqueue on the command's natural key** is not optional (D1): a unique index that answers a duplicate with an exception converts a harmless redelivery into a poison pill in any stack.

**Reopened note (2026-08-21, third review pass):** reopened after the human's full-suite runs surfaced a racy synchronisation barrier in `saga-compensation-credit-rejected.integration.spec.ts` — the first test polled the transient `orders.status === 'stock_reserved'` at a 200ms interval while the correct saga passes through that window in ~268ms, so a fast run could miss it and hang to timeout; a race in the test, not in the saga. Fix (implementer): poll the durable `saga_commands` row for `(order_id, 'credit.hold')` reaching the terminal `sent` status instead (impl §9 addendum). Re-review (narrow scope): 3× isolation runs green (28.45s/41.13s/56.34s), reviewer's independent probe (a duplicated `credit.hold` send after a successful reply, distinct from the implementer's parked-row probe) caught at the `toHaveLength(1)` assertion in 2.1s, dispatcher restored md5-exact, other five saga specs and `vitest.integration.config.mts` unchanged, `pnpm quality` + `./init.sh` exit 0. **RE-APPROVED**; feature closed `done`. Effort delta: implementer defect-fix pass ≈1 session (5× isolation + 2× full-suite runs, ~10 min wall-clock each), reviewer third pass ≈25 min incl. ~4 min Testcontainers wall-clock. Pattern ruling recorded for features 17–22 in `progress/review_order_saga_orchestrator.md` (third pass): synchronise saga integration tests on durable terminal/monotonic evidence, never on transient live columns.

---

## fulfillment_stock (id 17, phase 9) — 2026-08-22

**Effort:** 1 spec session + 1 human gate + **1 implementation session** + **1 defect-fix pass** + **2 review passes** — the second feature in this project to be **REJECTED and re-submitted** (after `orders_acceptance`, id 15). Wall-clock from artefact mtimes (local CEST): spec 2026-08-21 **≈17:30 → 17:38** (`design.md` 17:35, `tasks.md`/`requirements.md` 17:35, gate record `progress/spec_fulfillment_stock.md` 17:38); implementation 2026-08-21 **≈17:40 → 19:17** (domain files from 18:27, application 18:29–18:34, infrastructure copies 18:36–18:40, presentation 18:42–18:46, wiring 18:47, integration specs 18:49–19:05, live boot against compose ~17:08Z–19:0x, impl report + `tasks.md` 19:17) — **≈1 h 35 min**, including the Orders-side D1 carry-over from feature 16 and the live cross-service saga walkthrough; **review pass 1** 2026-08-22 **≈04:40 → 05:56**, **≈75 min** of which ~14 min Testcontainers (fulfillment integration 163s + full Orders integration 352s + repeated unit runs); **defect-fix pass** **05:57 → 06:08**, **≈11 min** (two tests + one traceability row + the M5 re-probe); **review pass 2** **06:09 → 06:45**, **≈35 min** of which ~8.5 min Testcontainers (mutated integration 178s + restored full integration 333s). An earlier review attempt on 2026-08-21 was cut off by an API session limit after confirming the four planned mutations and restoring files; no verdict was written and pass 1 did not reuse its results.
**REJECTED on pass 1** (exactly **1 defect**, everything else green: 4/4 planned hostile mutations killed, **1 unplanned fifth mutation survived**), **APPROVED on pass 2** (M5 killed at unit *and* integration level by the reviewer's own re-probe; 2 non-blocking nits, neither owed). Full record: `progress/review_fulfillment_stock.md` (pass 1 §§1–6, pass 2 appended as *Second pass*).

**The rejection, and why it is the process working.** The four planned mutations came from the design's hot spots and all died. The defect was found by a **fifth, unplanned mutation invented while re-reading the requirement sentence**: `FS5` says a `stock.reserve` for an order that already has reservation rows **"(in any status)"** must answer `already_reserved` — a human-gate ruling on spec open point 7, whose stated rationale is that *a re-reserve after a release would double-reserve an order the saga already unwound*. The clause was implemented correctly (the short-circuit filter deliberately carries no status condition, with a comment saying so) but **nothing tested it**: adding `&& reservation.status === 'reserved'` to that filter left **57/57 unit and 36/36 integration tests green**. A silent, saga-corrupting regression, guarded by a comment. **Portable rule for #8 and #9: mutate the sub-clauses of the requirement, not only the branches of the design — and look first at any normative clause that survived implementation as a code comment.**

**The fix, and the re-review that verified it rather than reading about it.** Tests only, no production code: an `it.each(['released','consumed'])` handler unit case (fixture deliberately *satisfiable*, so a status-filtering handler would happily reserve) and one integration case seeding a `released` reservation and re-issuing `stock.reserve` over the real NATS/MySQL/Kafka graph, asserting `already_reserved` with the exact existing ref, `reserved_units` still 0, the row still `released`, and **zero outbox rows** for the request's correlationId. The reviewer **re-ran M5 personally**: killed by exactly the three new cases and nothing else (unit `2 failed | 57 passed`, integration `1 failed | 36 passed`), restored byte-exact (`sha256 1ecd7003…e2e7fb17`, `cmp` clean), green again at **59 unit / 37 integration**. The handler's byte-identity to the pass-1-approved version was proved **without trusting the implementer's checksum**, by recompiling the current source and diffing against the `dist/` artefact `tsc` emitted *during pass 1, after the reviewer's own M5 restore and before the verdict was written* — identical `.js`, identical source-map `mappings` (same line *and column* for every token), the only differing field the outDir-relative `sources` path. **A compiler artefact left behind by an earlier verified run is a usable, tamper-evident baseline for "did this file change?" when the file is still untracked by git.**

**What was built:** Fulfillment's whole answering surface. The `StockItem` aggregate (invariant `reservedUnits ≤ units`, all-or-nothing multi-line reservation, `Reservation` lifecycle `reserved → released|consumed`, replenishment that emits no fact per R61) and the pure `reserveOrderStock`/`releaseOrderStock` order-level functions; the CQRS application layer (queries `stock.check`/`stock.list` on the `QueryBus`, commands `stock.reserve`/`stock.release`/`stock.replenish` on the `CommandBus`) over a `UnitOfWork`; five NATS `@MessagePattern(…, Transport.NATS)` responders behind a **bare-JSON serializer/deserializer pair** (the Nest envelope is not on the wire — the deserializer assigns a synthetic id only when `replyTo` is present, which is what makes an id-less bare request still get a reply); a `FOR UPDATE … ORDER BY (company_code, product_code)` single-statement lock that makes the check-then-reserve race safe and deadlock-free; and the per-service outbox + relay + idempotent-consumer copies with parity guards.

**Reviewer's independent evidence across both passes:** the acceptance-criterion race run for real (two concurrent raw-NATS reserves for the last 5 units → sorted outcomes `['accepted','rejected']`, final `reserved_units` exactly the winner's, one `stock.reserved.v1` + one `stock.rejected.v1`); the deadlock shape A`[P1,P2]` vs B`[P2,P1]` 10× both accepted; the bare-wire premise confirmed **in the installed `@nestjs/microservices@11.2.1` source** (`ServerNats.handleMessage`: `if (isUndefined(message.id)) return this.handleEvent(…)`) and then against the **real `AppModule`** with a raw `nats` client; and the `correlationId = orderId` / `causationId = saga-row-id` chain verified **live across the service boundary in the compose databases** (`otc_fulfillment.outbox` rows matched digit-for-digit against `otc_orders.orders.id` and `otc_orders.saga_commands.id` for ORD-000010/11). This is the feature where the first **cross-service saga execution** actually happened: two orders parked since feature 16 reached `stock_reserved` unattended the moment the responder booted.

**Nits open at approval (2, neither owed):** N1 the FS5 unit-row citation is the *rendered* `it.each` template (`released/consumed`) rather than either literal title, so a strict verbatim-title grep does not match — harmless here, but **a traceability matrix that cites test names must state how it cites parameterised cases**, and #8/#9 name them differently again (`[Theory]`/`InlineData`, `@pytest.mark.parametrize`). N2 one line of the fix-pass transcript claims a post-restore full integration re-run that the file timeline cannot accommodate; the mutated run *is* corroborated to the digit, and the reviewer re-ran the restored suite himself, so nothing is owed — but report only runs actually performed.

**Carried forward, still owed to the leader:** the **`apps/seed` data incoherence** ruled on in pass 1 §4 — `otc_orders.companies` holds 22 companies, `otc_fulfillment.stock` covers 5, and the seed places demo orders ORD-000007/8/9 against `ALBIONFOODS`, which has no stock row, so those orders' sagas can never progress past `stock.reserve`. Feature 12's written acceptance is literally satisfied; the seed is nonetheless internally incoherent. Feature 17's behaviour on that input (`NOT_FOUND` → orchestrator parks, loud and safe) is the designed negative path, observed working live, so this is **not** feature 17's defect. **Due no later than feature 28 (`saga_e2e_verification`)**, which cannot demonstrate an end-to-end saga while three seed orders are permanently parked; folding it into feature 18's live-boot pass is the natural slot.

**For #8 and #9:** three portable artefacts. (1) **The sub-clause mutation rule** above — the cheapest defect-finder this project has produced, and entirely stack-independent. (2) **"Responder idempotency is keyed on the order, not on the reservation's status"** — worth one sentence in `saga.md` §6, which today says a repeat `stock.reserve` "returns the existing reservation without double-reserving" but never defines *existing* once those rows are terminal; without the promotion, #8 and #9 will each independently re-reserve after a compensation, and their suites will be just as green about it. (3) **All-or-nothing multi-line reservation as a pure function over the loaded aggregates**, with the lock ordering pushed into a single index-ordered `FOR UPDATE` statement: the concurrency correctness then lives in one SQL statement a reviewer can read, not in a lock-acquisition sequence spread across the application layer — a shape every stack can copy.

---

## fulfillment_despatch (id 18, phase 9) — 2026-08-22

**Effort:** **1 implementation session + 1 review pass, approved first time** — no spec phase (`sdd: false`, no human gate), the cheapest feature of phase 9 by a wide margin. Wall-clock from artefact mtimes (local CEST, 2026-08-22): implementation **≈06:48 → 07:29** — bracketed at the start by feature 17's commit `3e29ab7`… (`fulfillment_stock`) at **06:47:47** and at the end by `progress/impl_fulfillment_despatch.md` at **07:29**; intermediate artefacts `0002_…sql` 07:20, `test-matrix.md` 07:21, domain + integration specs + `stock.data.ts` 07:22 — **≈41 min**, including the schema change, the seed fix and the live cross-service boot. Review **07:30 → 07:52, ≈22 min**, of which ≈9 min was Testcontainers wall-clock (full fulfillment integration 210 s + one mutated single-spec run + two rollback-probe runs + one restored two-spec run) and ≈2 min two `pnpm seed` runs against the live stack. **Total ≈1 h 03 min from first file to verdict** — for comparison, `fulfillment_stock` (the `sdd: true` sibling that established every pattern this feature copied) cost ≈1 h 35 min of implementation plus two review passes. *Note: the reviewer's mutation restores rewrote the mtimes of `order-despatch.ts`, `despatch.controller.ts` and `despatch-creation.handler.ts` (07:38–07:40); their content is sha256-identical to the submitted version and those three timestamps are not implementation activity.*
**APPROVED** first pass (**0 blocking defects**, 3 non-blocking findings; **5/5 hostile mutations killed**; transactional atomicity proved by injected fault rather than argued). Full record: `progress/review_fulfillment_despatch.md`. **Phase 9 complete.**

**What was built:** the DESADV half of Fulfillment. The `DespatchAdvice` aggregate (created once, never mutated; `create()` refuses an empty line list per F6 and appends its single `order.despatched.v1` before returning, so no caller can observe an aggregate whose fact was not recorded) plus the pure order-scoped `createDespatchForOrder` that consumes every `reserved` reservation of the order across its stock items and builds one line per consumed reservation (F7). One NATS responder `@MessagePattern('fulfillment.despatch.create', Transport.NATS)` → `CommandBus` → a plain transactional handler that **reuses feature 17's lock protocol unchanged** (`stockIdsOfOrder` pre-read, then the same stock-rows-first `FOR UPDATE` that `stock.release` takes), so despatch cannot deadlock against a concurrent reserve/release. Three F8 layers: a fast path that returns the existing despatch **without opening a transaction**, an in-lock `anyConsumed` re-read for the racing caller, and a new DB constraint `uq_despatches_order_reference`. A `DES-######` allocator copying Orders' InnoDB counter-table recipe verbatim. No new npm package.

**Reviewer's independent evidence, beyond re-running 75 unit + 44 integration + 108 seed tests:** (1) **the atomicity claim tested by fault injection** — a `throw` planted immediately after `despatches.save` inside the transaction left *nothing*: no despatch, no `despatch_items`, reservation still `reserved`, stock counters still 10/4, **zero outbox rows**; re-running the identical probe with the outbox write moved outside the transaction produced an orphan `order.despatched.v1` for an order with no despatch, proving the probe discriminates rather than passes by default. (2) **The seed fix proved additive computationally**, by materialising `STOCK` from `git show HEAD:` beside the new one: `{oldRows:11, newRows:215, added:204, changedOrRemovedExistingRows:0, companies 5→22}`, with `sha256(STOCK)` identical across two separate processes and `CHECKSUM TABLE` identical across two `pnpm seed` runs for all nine tables in all three databases. (3) **The live saga confirmed by direct query, not by report**: ORD-000007/8/9 `stock_reserved`, `stock.reserve` rows `sent`, three published `stock.reserved.v1` whose `correlation_id`s equal the three `orders.id` digit for digit, `credit.hold` parked on "no responder is subscribed" — the first unattended cross-service advance on data the **seed itself** provides, which closes the item `review_fulfillment_stock.md` left owed.

**Mutations (all restored byte-exact, sha256-verified):** leave reservations `reserved` after despatch → KILLED (3 unit); emit the fact outside the transaction → KILLED (reviewer's rollback probe); delete the F8 fast path → KILLED (2 unit); skip the FS3 header validation → KILLED (1 unit); persist the despatch header but not its lines → **KILLED at integration only, with all 75 unit tests green** — chosen deliberately to test the container suite's power rather than the unit suite's.

**The hand-trimmed migration — ruled correct.** `apps/fulfillment/drizzle/meta/0001_snapshot.json` was confirmed **genuinely stale**: byte-equivalent to `0000_snapshot.json` apart from key order and its own `id`/`prevId`, listing `outbox` with 9 columns and 1 index — i.e. it never recorded the `causation_id`/`trace_parent`/`seq`/`idx_outbox_unpublished_seq` that migration 0001 actually applies. A raw `drizzle-kit generate` therefore re-emitted already-applied ALTERs, which would have failed `pnpm db:migrate` on every real environment. The committed `0002` is exactly the two statements this feature needs (`grep` for `outbox|processed_events` → 0 hits), `0002_snapshot.json` is a full and truthful snapshot, the `prevId → id` chain is intact, and because drizzle diffs against the **latest** snapshot the drift **cannot re-bite**. From-empty correctness is proved by the Testcontainers migration spec, which now covers 0002 concretely (the 7-table list, the `uq_despatches_order_reference` index, an `ER_DUP_ENTRY` on a duplicate `order_reference`, a sequence-table round trip) **while still asserting everything 0001 provides** — which is what proves the trim removed duplicates and not content. Nothing remains owed; only the historical `0001_snapshot.json` stays wrong as an audit artefact, and regenerating it retroactively would buy nothing.

**Findings open at approval (3, none blocking):** N1 — `apps/seed/src/outbox-parity.spec.ts` matches its `outbox|processed_events` regex against migration **comments** as well as statements, which is why `0002`'s header had to call the outbox "the fact-relay table"; a comment shaped to dodge a regex is a coupling waiting to break, fix is one line in `normalise()`. N2 — `despatch-creation.handler.ts:99-100` sources `companyCode` from `items[0]` but `retailerCode` from the reserved reservation; both correct today, asymmetric to read. N3 — `apps/seed/src/verify.ts`'s `orders.orders === SAGAS.length` still exits 1 on any long-lived dev database (`expected 6, got 11`), **due no later than feature 28**, which cannot present a clean end-to-end run while `pnpm seed` fails on the demo machine.

**For #8 and #9:** three portable artefacts. (1) **Prove atomicity by injecting a failure at the worst moment, then prove the probe discriminates by re-running it against a deliberately non-atomic variant.** A rollback test that passes is worthless until you have seen it fail; the two runs together cost one container boot each and replace an entire paragraph of reasoning about transaction scopes. Every stack can do this (a `throw` inside the transactional lambda). (2) **Idempotency needs three layers, and they are not redundant**: a pre-transaction fast path (cheap, no lock), an in-lock re-read for the caller that lost the race (correct), and a DB unique constraint (durable). The middle layer is the one a reviewer must look for — deleting the *fast path* left all 44 integration tests green here, so an integration suite alone cannot tell you which layer is carrying the invariant. (3) **A stale migration snapshot is a silent, cross-stack hazard**: EF Core (#8) and Alembic (#9) both keep a comparable model-state artefact that regenerates only when a human remembers. The rule worth porting is *the from-empty migration test must assert what the previous migration added, not only what this one adds* — that single assertion is what turns a hand-edited migration from a leap of faith into a checked change.

---

## billing_credit (id 19, phase 10) — 2026-08-22

**Effort:** 1 spec session + 1 human gate + **1 implementation session** + **1 defect-fix pass** (`test_maintainer`, test files only) + **2 review passes** — the third feature in this project to be **REJECTED and re-submitted** (after `orders_acceptance` id 15 and `fulfillment_stock` id 17). Wall-clock from artefact mtimes (local CEST, 2026-08-22): spec **≈11:0x → 12:00** (`design.md` 11:57 — 68 KB, the largest design in the project so far; gate record `progress/spec_billing_credit.md` 12:00, 22 open points ruled, including the `R39` amendment that moved the currency clause to `BC4` and added the port-refusal sub-clause); implementation **≈12:00 → 13:25** (`messaging/` 12:38–12:39, persistence 12:40–12:41, presentation 12:43–12:46, wiring 12:44–12:45, the four integration specs 12:55–12:56, impl report + `tasks.md` 13:25) — **≈1 h 25 min**, including the live three-service boot and the end-to-end compensation walkthrough; **review pass 1** **≈13:2x → 13:45:59** (verdict artefact mtime; the pass's own effort line says "13:26 → 13:55", which its own report file contradicts at the end — the ~10 min of Testcontainers it correctly itemises cannot fit the 20 min the mtimes allow, so the *start* is the figure to distrust, not the work); **defect-fix pass** **13:47 → 13:49, ≈3 min** (one `describe` block + one traceability row, no source touched); **review pass 2** **13:51 → 13:58, ≈7 min** (5 mutations + `pnpm quality` + `init.sh`, no containers — the claim under test was a unit-level guard, and re-running the world would have been duplicated cost).
**REJECTED on pass 1** (exactly **1 blocking defect**; **9/10 hostile mutations killed**, the tenth *was* the defect), **APPROVED on pass 2** (M5 re-armed by the reviewer and killed by the new case alone; 3 further mutations of the same branch also killed; 1 non-blocking documentation item and 1 nit owed, neither blocking). Full record: `progress/review_billing_credit.md` (pass 1 §§1–9, pass 2 appended as *Second pass*).

**The rejection, and why it was the same shape as feature 17's.** `R39` was **amended at the human gate** to read "…exceeds the retailer's available credit, **or which the credit port rejects**". The over-limit half was tested at four levels; the port-refusal half was implemented correctly and tested **nowhere** — deleting `credit.refuseHold(holdRequest, decision.reason, ctx)` from `credit-hold.handler.ts:94` left the RPC reply saying `rejected` while **no `credit.rejected.v1` was ever emitted**, and that passed `tsc` and all 56 unit tests. The integration suite was structurally incapable of catching it: every harness binds `AlwaysApproveCreditDecision`, so no test in the repository had ever driven the handler with a refusing port. Downstream that is worse than the bug the feature exists to prevent — the order is told "rejected" over RPC, the saga waits for a fact that never comes, and no compensation runs.

**The fix, and the re-review that re-proved it rather than reading about it.** Test files only: one `describe('CreditHoldHandler.hold — R39, port refusal')` injecting a refusing `CreditDecisionPort` for a hold that *fits*, asserting the reply **and** — the load-bearing part — `saveCalls[0].pullDomainEvents()`: exactly one event, `credit.rejected.v1`, `payload.reason` equal to the adapter's. The reviewer re-armed `M5` personally (`tsc` exit 0, `1 failed | 56 passed`, `AssertionError: expected [] to have a length of 1`) — it dies on the **fact**, not on the reply shape — then probed three *weaker* mutations of the same branch: wrong reason in the fact **KILLED**, reply/fact `reason` divergence **KILLED**, `save` omitted **KILLED**. One survived (`W3`: the fact recorded with a corrupted `requestedAmount`, 57/57 green), ruled a nit rather than a defect and recorded as **N5** — the reason is the field the saga branches on and it is now pinned at three levels, while the payload arithmetic is asserted at unit, integration and live level through the shared `holdRequest`. Handler restored byte-exact (`sha256 87e6678e…1de06708`, `sha256sum -c` clean).

**What was built:** Billing's answering surface. The `BuyerCredit` aggregate with an **append-only** ledger (`hold`/`release`/`consume`) and the pure `summariseLedger` two-term identity `exposure = Σhold − Σrelease`, `openExposure = min(Σconsume, exposure)` — `consume` deliberately does **not** enter the availability formula, which is what makes `R40` ("invoice issue leaves available credit numerically unchanged") an arithmetic property rather than a promise. Two NATS `@MessagePattern(…, Transport.NATS)` responders (`billing.credit.hold`, `billing.credit.list`) behind the bare-JSON serializer pair, a `FOR UPDATE` row lock per credit line, the per-service outbox + relay copies under the parity guard extended to three services, and the **credit-decision port** — feature 20's whole seam, fixed now, with `AdapterRejectionReason = Exclude<CreditRejectionReason,'over_limit'>` making an adapter structurally *incapable* of claiming the aggregate's own word (`R44`, `BC14`). No new npm package.

**Reviewer's independent evidence (pass 1), beyond re-running 390 + 75 + 119 + 56 unit and 28 integration tests:** (1) **the end-to-end credit compensation reproduced from scratch** with a deliberately different basket (`ORD-000014`, total `354984`, `mod 100 = 84` — chosen so it could not be the `.99` simulator affordance): order `cancelled`/`credit_rejected`, `credit.rejected.v1` carrying `availableCredit: 350006` matching a hand computation to the unit, **zero** ledger rows, stock released, and the `stock_released` compensation step inside `order.cancelled.v1`; (2) **the `R39` fact/no-fact split probed live on all four reachable paths** over raw NATS — only a *credit decision* produces a fact, while `NOT_FOUND`, `VALIDATION_FAILED` (currency) and the missing-header `BC1` violation produce none, so no malformed message can cancel an order; (3) the ledger's append-only property mutated **in the domain and in persistence separately** (`save()` made to `DELETE` before insert → killed only against real MySQL); (4) `BC7`'s FS5-shaped clause — `already_held` while net exposure is still positive — killed at unit **and** integration level, i.e. the lesson from feature 17 was applied to the clause everyone expected to be at risk, and the defect turned up in the one nobody had looked at.

**Findings open at approval (2, neither blocking):** **D2-doc** — `specs/shared/test-matrix.md`'s `R39` row was never extended with the new handler case (pass 1 asked for both records; only `requirements.md`'s `BC14` row was updated). Non-blocking here because the row's declared `Level` is *domain unit* and the domain case does assert both reasons, but **owed before the human's commit**: `specs/shared/` is what #8 and #9 build from, and a row naming only a domain-level test will let both of them reproduce exactly the gap this feature was rejected for. **N5** — the `W3` residual above, one assertion wide. Pass 1's four non-blocking findings (N1 `already_held` vs `currency_mismatch` precedence unpinned; N2 `pnpm quality` does not actually compute the coverage gates `CLAUDE.md` says it enforces; N3 `releaseHold`/`consumeHold` ship caller-less by gate ruling, `billing.credit.release` owed by features 22/25; N4 the bare-JSON NATS pair is now a third unguarded copy) all stand.

**Standing rule adopted at this approval — the fact-emission mutation.** Two of the last three features were rejected for the *same* shape: correct code, on a branch with no live caller, whose fact-emission is guarded by structure and a comment rather than by a test that fails when the emission is deleted; both times the whole suite stayed green under deletion, both times the fix was one unit test, both times a reviewer's mutation found it rather than the suite. **Rule for features 20–39, to be added to `CLAUDE.md` § Testing conventions and to the preamble of `specs/shared/test-matrix.md`:** *for every branch that emits, or deliberately suppresses, a domain fact, the implementer arms the deletion of that emission themselves before submitting, and records in `progress/impl_<feature>.md` which named test failed and with what message; a branch whose fact-emission survives its own deletion with a green suite is not done — with double force where the branch has no caller yet, because "feature N will be its first caller" is precisely the condition under which no test exists.* It is cheap, self-reporting (the reviewer verifies a named killing test instead of discovering its absence), and it mechanises the rule feature 17's entry already records in prose.

**For #8 and #9:** three portable artefacts. (1) **The fact-emission mutation rule** above — stack-independent, and the single cheapest defect-finder this project has produced twice over. (2) **Keep `consume` out of the availability formula.** Modelling invoice issue as a *third* ledger entry type that is numerically neutral (`openExposure = min(Σconsume, exposure)`) turns "issuing an invoice must not change available credit" from a rule someone must remember into an identity the arithmetic cannot violate; every stack can express it, and it is the reason `R40` needed no branch. (3) **Give the simulator's seam a type that cannot lie.** `AdapterRejectionReason = Exclude<CreditRejectionReason,'over_limit'>` (a discriminated union minus one member; in #8 a separate enum or a private constructor, in #9 a `Literal[...]` narrower than the fact's) makes `R44`'s "the simulator SHALL NOT bypass `R37`" a compile-time property of the port rather than a discipline of the adapter — but note that this feature proved the *converse* lesson too: the type system guaranteed the adapter could not say the wrong thing, and nothing at all guaranteed the handler would say anything.

---

## billing_credit_simulator (id 20, phase 10) — 2026-08-22

**Effort:** **1 implementation session + 1 review pass, approved first time** — no spec phase (`sdd: false`, no human gate), the smallest feature of phase 10 and the smallest of the last five by every measure. Wall-clock from artefact mtimes (local CEST, 2026-08-22): implementation **≈18:41 → 19:01** — bracketed at the start by feature 19's commit `c3f8e85` (`billing_credit`) at **18:41** and at the end by `progress/impl_billing_credit_simulator.md` at **19:01**; intermediate artefacts `current.md` 18:46, `simulator-credit-decision.spec.ts` 18:49, `credit-rejection-parity.integration.spec.ts` 18:51, `test-matrix.md` 18:59, `feature_list.json` 19:00 — **≈20 min**, including the live three-service re-boot, the `.99` order, the over-limit control order and the happy-path control order. Review **19:02 → 19:20, ≈18 min**, of which ≈6 min was Testcontainers wall-clock (full billing integration 160 s + one single-file run under the reverted binding) and ≈2 min the 200 000-draw proportion probe and the coverage run. **Total ≈39 min from first file to verdict** — against `billing_credit`'s ≈3 h 15 min across a spec session, a gate, an implementation, a defect-fix pass and two reviews. The seam was designed one feature early, and that is the whole reason for the difference. *Note: the reviewer's mutation restores rewrote the mtimes of `simulator-credit-decision.ts` (19:05), `app.module.ts` (19:09), `buyer-credit.ts` and `credit-hold.handler.spec.ts` (19:09); all four are sha256-identical to the submitted versions and those timestamps are not implementation activity.*
**APPROVED** first pass (**0 blocking defects**, 6 non-blocking findings; **7/7 hostile mutations killed**, one at compile time and one against the *binding* rather than the adapter). Full record: `progress/review_billing_credit_simulator.md`.

**What was built:** the credit-check simulator — §5.1's demo-determinism device, and the smallest possible proof that feature 19's port was cut in the right place. `SimulatorCreditDecision` is one file: the `.99` predicate (`amountMinorUnits % 100 === 99` → `simulated_cents_rule`, checked **first** so a `.99` amount can never surface as the other reason depending on a pseudo-random draw), the `CREDIT_FAILURE_RATE` draw with randomness **injected** rather than `Math.random()` called, and `loadCreditSimulatorConfig`, which throws synchronously — inside `app.module.ts`'s `useFactory`, unguarded, so Nest's container construction fails and `main.ts` never reaches `listen()` — on any value outside the closed interval `[0, 1]`, reporting the offending value. Bound **unconditionally**; `AlwaysApproveCreditDecision` stays in the tree, unbound. No domain, application, presentation, port, DTO or fact-builder file changed; no new npm package. The one edit outside the feature was closing feature 19's owed nit (**N5**) — `credit-hold.handler.spec.ts` now asserts `requestedAmount`/`availableCredit`, not only `reason`.

**Reviewer's independent evidence, beyond re-running 64 billing unit + 30 billing integration tests (and *not* re-running orders/fulfillment/seed integration, because the diff cannot reach them):** (1) **the failure rate measured, not assumed** — a deterministic LCG injected as `random`, 200 000 draws per rate: `0 → 0.0000`, `0.1 → 0.1024`, `0.3 → 0.3059`, `0.75 → 0.7525`, `1 → 1.0000`, every refusal carrying `simulated_failure_rate`, zero refusals in 200 000 draws at the default. The shipped tests pin the *boundary*; this pins the *proportion*, and the two together are what make R43 a measured property. (2) **R42's "regardless" clause widened** to five credit levels including `Number.MAX_SAFE_INTEGER` and four `random()` draws — twelve precedence combinations, all `simulated_cents_rule`; and the predicate confirmed neither wider nor narrower than `mod 100 = 99` across ten amounts. (3) **R44 compared field by field** across eleven attributes of two live `credit.rejected.v1` facts — `reason` is the sole difference, and it is a *parameter* of a single builder with a single call site, so the property is structural rather than fixture-deep. (4) **The binding mutated at integration level**: reverting `app.module.ts` to `AlwaysApproveCreditDecision`, adapter file untouched, killed the parity spec (`expected { outcome: 'approved' } to match object { outcome: 'rejected' }`) — a correct-but-unbound simulator is the failure mode this feature could most plausibly have shipped, and no unit test can see it.

**Mutations (7 armed, 7 killed, all restored byte-exact, sha256-verified):** delete the `.99` branch → KILLED (2 unit); invert the rate comparison → KILLED (3 unit); loosen it by one boundary (`<` → `<=`) → KILLED (2 unit — the suite is boundary-tight); clamp instead of throw → KILLED (`expected [Function] to throw an error`); return `over_limit` from the adapter → **KILLED by `tsc`**, `TS2322: Type '"over_limit"' is not assignable to type 'AdapterRejectionReason'`; corrupt `requestedAmount` in the single `refuseHold` fact builder → KILLED by the newly strengthened handler spec **and demonstrably survived by the old one** (4 passed), which is what closed feature 19's N5; revert the binding → KILLED at integration.

**The binding ruled on, both halves.** *Unconditional binding, no env flag:* **correct, and a toggle would be a regression.* R42/R43's `WHERE the simulator is the adapter bound…` is EARS's variant precondition, not a mandate for a runtime switch; §5.1 calls the removal mechanism "swapping the adapter", and a one-line `useFactory` change is a swap; and §5.1's trilogy obligation requires the demo, the API tests and the end-to-end tests of all three assessments to place a `.99` order and see it cancelled — a flag defaulting *off* breaks all three, a flag defaulting *on* is decorative while adding a configuration axis R43's validation does not police. *`AlwaysApproveCreditDecision`, unbound:* **a retained reference adapter and latent test double — keep it, do not make it env-selectable.** `grep` finds exactly one non-comment consumer (its own spec), so it is unbound; but unbound is not dead — five lines, the port's minimal reference implementation documented by `design.md` §6.3 and asserted by `BC15`, the `overrideProvider` a future harness will reach for, and part of what #8 and #9 read as the shape of the seam. It is *not* a deployment option: an adapter that approves everything is not a credit policy, and promoting it to env-selectable would recreate the "which adapter is live?" ambiguity that the first half of this ruling rejects. Its header's claim to serve "any harness that wants approve-everything behaviour" is speculative — no harness does — and is finding **N5**.

**Findings open at approval (6, none blocking):** **N1** — the R44 parity test compares the over-limit payload's key set against a *hard-coded literal array* rather than against the simulated payload the sibling test observed (which is asserted with subset semantics), so a ninth key appearing on the simulated path only would pass; safe here because a single eight-key builder with a single call site guarantees the shape, but #8/#9 will copy the spec into stacks where it is not a tautology. **N2** — with the simulator bound and the harness compiling the real `AppModule` without overrides, every future billing integration fixture is silently subject to the `.99` rule, guarded only by a prose list of four filenames in `app.module.ts`'s header. **N3** — `Number(raw)` coercion means `CREDIT_FAILURE_RATE='   '` silently yields `0` and `'0x1'` silently yields **`1`** (reject everything); not an R43 violation under JS semantics, but exactly the invisible-non-reproducibility shape R43's last clause exists to prevent. **N4** — the standing fact-emission mutation rule adopted at feature 19's approval is still absent from `CLAUDE.md` and from `specs/shared/test-matrix.md`'s preamble, surviving only as history prose; owed by the **leader**. **N5** — the always-approve adapter's header justifies its retention with a consumer that does not exist. **N6** — the matrix's *stack-agnostic* sketch column still says `billing/domain/credit-simulator.spec` for R42/R43, which will lead #8 and #9 to put an adapter's test in the domain layer, where a purity rule will then fight it; one-word fix. Feature 19's N1–N4 all still stand; its **N5 is closed** by this feature and its **D2-doc** was closed earlier.

**For #8 and #9:** three portable artefacts. (1) **Mutate the *binding*, not only the class.** Every unit test here passed with the simulator correct and unbound; only reverting `app.module.ts`'s provider and re-running one integration spec proved the wiring. Wherever a feature's entire footprint is "swap one provider", the provider swap *is* the feature, and the only test that can fail when it regresses is one that compiles the real container — #8's `IServiceCollection` and #9's dependency-overrides have the same property and the same blind spot. (2) **Measure a probabilistic rule's proportion, do not only pin its boundary.** Injecting the randomness source turns `CREDIT_FAILURE_RATE` from a rule you assert about into a rule you *count* — 200 000 draws costs milliseconds and catches an inverted or mis-scaled comparison that a two-point boundary test can miss; conversely the boundary test catches the off-by-one (`<` vs `<=`) that a proportion test never will. Both, cheaply, in every stack. (3) **Fail fast on a bad knob, and put the offending value in the message.** A clamped `CREDIT_FAILURE_RATE` makes a demo non-reproducible for reasons invisible in the logs, which is why R43 words it as a start-up failure; the mutation "clamp instead of throw" is one line and must be killed by a named test in all three assessments. Note the residual this review found even so: language-level numeric coercion (`Number` in JS, `double.Parse` in C#, `float()` in Python) will each silently accept some string a human meant as nonsense — validate the *text* before you convert it.

---

## billing_invoicing (id 21, phase 10) — 2026-08-23

**Effort:** **1 spec session + 1 human gate + 1 implementation session + 2 review passes + 1 fix pass — approved on the second review.** Wall-clock from artefact mtimes (local CEST, 2026-08-23), bracketed at the start by feature 20's commit `dc11466` the previous evening (2026-08-22 19:33): spec **≈06:21 → 06:24** (`design.md` 06:21 is the earliest surviving spec artefact; `spec_billing_invoicing.md` 06:24 closes it) — 20 open points, 6 taken to the gate. Implementation **≈06:24 → 07:31** (`specs/billing_invoicing/requirements.md` 07:31 is task J6, the `BI1`–`BI22` flip, the last act of the pass) — **≈1 h 07 min**, including the migration against the live database, the three armed fact-deletions and the unattended live boot of all three services. Review pass 1 **≈07:44 → 07:54, ≈10 min**, of which ≈30 s was one Testcontainers run (`invoice.repository.integration.spec.ts` under a re-armed H10) and the rest code reading, five mutation probes and eleven live-database queries. Fix pass **≈07:55 → 08:04, ≈9 min**. Review pass 2 **≈08:05 → 08:12, ≈7 min**, of which ≈42 s was three Testcontainers runs of `invoice-issue.integration.spec.ts`. **Total ≈1 h 51 min of observable artefact activity from the first spec file to the final verdict**, across four agent passes and one human gate. *Note: the reviewer's mutation restores rewrote the mtimes of `apps/billing/src/domain/invoice.ts` (07:46), `presentation/invoice.controller.ts`, `application/invoice-issue.handler.ts`, `presentation/dto/invoice.dto.ts` and `invoice-issue.integration.spec.ts` (08:09); all five are md5-identical to the submitted versions and those timestamps are not implementation activity.*
**APPROVED** on the second review (**2 blocking defects found and fixed in round 1**, 8 non-blocking findings of which 5 are carried forward; **8 hostile mutations armed across both rounds, 8 killed** — plus one deliberately *non*-killing placement experiment that exposed a false proof). Full record: `progress/review_billing_invoicing.md`.

**What was built:** the `Invoice` aggregate with `B9` made unrepresentable — `status` and `paidAt` are one discriminated-union `state` field, not two fields a mapper could desynchronise — its `InvoiceLine` children, the `invoice.issued.v1` / `payment.received.v1` builders, the `INV-######` allocator, the two NATS responders, the migration adding `invoice_number_sequences` + `uq_invoices_order_reference`, and **the two-aggregate issue transaction**: one `UnitOfWork` mutating an `Invoice` and a `BuyerCredit` together under a fixed lock order (`credits` → `invoices` → `invoice_number_sequences`). `markPaid` and `payment.received.v1` ship with no live caller for feature 22, per the feature-19 precedent. Four inherited findings from feature 20 closed (N1, N2, N3, N5) and the gated `apps/orders` discount fix landed. No new npm package.

**The deviation that defines this feature, and why it was allowed.** `domain-model.md` §8 rule 6 says one transaction mutates one aggregate. This one mutates two — the second such deviation after `F3` in feature 17 — and the justification is structural rather than convenient: **`R40`'s `consume` deliberately emits no fact**, so the saga can observe nothing and compensate nothing. Every split alternative (invoice first, consume first) leaves a crash window that *nothing in the system can detect*; the only fact-based repair would be a fourteenth fact in a thirteen-fact catalogue plus a Billing-side consumer `saga.md` §5 forbids — a trilogy-wide contract change to remove a window one transaction removes for free. The resulting invariant, *an invoice exists iff its hold was consumed*, is checkable by a single SQL query, which is what `BI7` does. The test any future deviation must pass: **justified by an invariant no single aggregate owns, never by convenience.**

**Reviewer's independent evidence (both rounds), beyond re-running the billing unit suite (25 files / 110 tests):** (1) **all three armed fact-deletions re-armed from scratch**, not read about — H8 (`invoice.issued.v1`, 3 tests dead), H9 (`payment.received.v1`, the double-force no-caller case, 2 tests dead), and the inverted H10 (a spurious `credit.consumed.v1` on the consume path, `expected 2 to be 1` against real MySQL), every failure landing on a **fact-count** assertion rather than a snapshot or an incidental count. (2) **The live boot re-queried, not trusted** — eleven read-only queries confirming eight orders `invoiced`, thirteen invoices with no duplicate `order_reference`, exactly one `hold` + one `consume` per order, `uq_invoices_order_reference` present with `non_unique = 0`, and `availableCredit` at **350 606** / **200 012** — numerically unchanged, R40's neutrality visible in production data. (3) **A lock-order inversion armed**: killed by the handler's ordered call log, and *not* by the race spec — which cannot see it, because one transaction type racing itself forms no cycle. (4) **`@EventPattern` injected into a Billing controller** to prove `BI1`'s guard binds rather than assuming it.

**The two blocking defects, both found by probing rather than by the suite.** **N1** — `tasks.md` at 0/60 ticked while every prior sdd feature stood at 100%; not a formality, because the per-task record is the only artefact that can carry *which* task a deviation attaches to, and `H10`'s instruction had turned out to be unrealisable. **N2** — `BI2`'s clause *"a discount that exceeds the computed amount … before opening any transaction"* was neither implemented nor tested: the DTO validated only `@Min(0)`, so such a payload opened the transaction, took the `credits` lock and reached `invoiceNumbers.next(tx)` — the global counter row design §5.4 argues must be taken last and held briefly — before the domain threw and rolled back. The *outcome* was correct, which is exactly why a green suite never saw it; the hazard was a malformed command, retried on the sweeper's backoff, contending repeatedly with live traffic on the service's hottest lock.

**The round-2 experiment worth remembering.** The fix for N2 was correct — a `class-validator` cross-field constraint running inside the controller's existing `validate()` call, proven by a unit assertion that `CommandBus.execute` was **never called**. But the accompanying integration "proof" — reading `invoice_number_sequences` before and after and asserting it byte-identical — was tested by *moving the check back inside the transaction and seeding a hold so the request genuinely reached the allocator*: **all 7 tests passed anyway.** The allocator runs on the transaction's connection, so its increment rolls back with everything else; the counter looks identical under both placements. Recorded as **N10** (comment-only, carried forward): three artefacts assert an inference the evidence cannot support.

**Findings open at approval (6, none blocking):** **N4** — `BI8` declares a three-lock order but the ordered call log covers only two, so moving the allocator earlier would pass every test. **N5** — the race spec proves one-invoice/one-consume/one-fact but cannot detect a lock-order inversion; the unit log is the sole guard. **N6** — the live-boot record's `attempts` figures say "63 → 64" where the database says 63 (the dispatcher does not increment on success); every other figure verified exact. **N8** — `BI1`'s guard is a text scan, well-built and self-proving but not container introspection. **N9** — the parity spec now carries inter-test state, so its second case cannot run alone. **N10** — the counter-proof overclaim above.

**For #8 and #9:** three portable artefacts. (1) **Prove a path was never entered by observing the entry, never the residue.** A rolled-back side effect is indistinguishable from one that never happened — counter tables, sequence rows and `FOR UPDATE` locks all look untouched after a rollback whether the code reached them or not. Assert on the bus that was never called, the lock never requested; this cost a whole review round to establish and every stack has the identical trap. (2) **Make the state machine's coupled fields one value.** `status` and `paidAt` as a discriminated union (`{status:'issued'} | {status:'paid', paidAt: Date}`) makes **B9** unrepresentable rather than merely tested — a sum type in #8, a tagged union or frozen dataclass pair in #9 — and it moves the only place the two vocabularies meet into the mapper, where one reconstitution guard closes the store-side half. (3) **When a fact is deliberately suppressed, guard the suppression by arming an *emission*, at every layer that could observe one.** A missing fact cannot be deleted, so the mutation must be inverted — and this feature needed the guard at *two* layers, because the repository-level delta and the responder-level delta catch different regressions: a stray fact under a foreign `correlationId` is invisible to any correlation-scoped assertion.

---

## billing_remittance_intake (id 22, phase 10) — 2026-08-24

**Effort:** **1 implementation session + 1 review pass, approved first time** — no spec phase (`sdd: false`, no human gate), the specification being `specs/shared/requirements.md` R47–R49 plus `feature_list.json` id 22's three acceptance bullets. Wall-clock from artefact mtimes (local CEST, 2026-08-24), bracketed at the start by feature 21's commit `8baa22e` the previous afternoon (2026-08-23 13:29): implementation **≈05:53 → 06:41** — `progress/current.md` 05:53 opens the pass with the implementer brief; intermediate artefacts `payment.commands.ts` and `invoice.repository.ts` 06:05, `payment.dto.ts` 06:06, `payment-register.handler.spec.ts` 06:11, `payment-register.integration.spec.ts` 06:20, `test-matrix.md` 06:21; `impl_billing_remittance_intake.md` and the `feature_list.json` flip at 06:41 close it — **≈48 min**, including the four armed deletions, the full billing integration suite, a repo-wide `pnpm quality`, and the live three-service boot that carried `ORD-000018` from `invoiced` to `completed` (plus the correlation-id misfire against `ORD-000007` and its honest write-up). Review **≈06:42 → 06:55, ≈13 min**, of which ≈2 s was one re-armed mutation run, ≈3 s three targeted unit files (38 tests), ≈4 s one bespoke probe spec, and the balance code reading, six read-only MySQL query batches and the REPEATABLE-READ isolation analysis. **Total ≈1 h 01 min from first file to verdict** — the fastest feature of phase 10 after the simulator, and the only phase-10 feature approved on the first review pass with zero blocking defects. *Note: the reviewer's mutation restore rewrote the mtime of `apps/billing/src/application/payment-register.handler.ts` (06:45); it is md5-identical to the submitted version (`8c045cac…`) and that timestamp is not implementation activity. The reviewer's temporary probe spec was deleted, leaving no trace in `git status`.*
**APPROVED** first pass (**0 blocking defects**, 1 non-blocking finding of substance, 2 informational). Full record: `progress/review_billing_remittance_intake.md`.

**What was built:** the `billing.payment.register` NATS responder — the sole live caller of `Invoice.markPaid` (delivered uncalled by feature 21) and `BuyerCredit.releaseHold` (delivered uncalled by feature 19), and the act that closes the order-to-cash cycle end to end for the first time in this repository. `PaymentRegisterHandler` is a plain transactional class on `InvoiceIssueHandler`'s exact shape: an R48 fast path **outside any transaction**, then inside one `UnitOfWork.execute` — the credit line locked first (`BI8`, extended to this subject), the invoice's own row locked second, an R48 authority re-read under that lock, `Invoice.markPaid` (which raises all three of R49's refusals itself), `BuyerCredit.releaseHold(reason: 'invoice_paid')`, then `invoices.markPaid` persisted **before** `credits.save`. No new domain code, **no migration** (`payments.payment_reference`'s UNIQUE constraint has existed since `0000_brown_hammerhead.sql`), no contracts regeneration, no npm package, and `apps/orders` byte-untouched — the `invoiced → paid → completed` transition runs on pre-existing saga-step wiring.

**The design decision worth recording: R47's ordering is structural, not asserted.** The requirement says `payment.received.v1` **followed by** `credit.released.v1`, in that order and in the same transaction. Rather than sort or stamp anything, the handler makes the order a consequence of call order, through a three-link chain the reviewer verified link by link: each repository drains its own aggregate's events into the outbox *inside* its own write method; `OutboxRecorder` assigns no sequence, MySQL `AUTO_INCREMENT` does, in statement order; so two `INSERT`s in one transaction take strictly increasing `seq` in call order. Persisting the invoice before the credit line is therefore the whole mechanism. Guarded at two layers — a unit call-order assertion across a **shared** call log both repository fakes append to, and an integration assertion on real `seq` values in MySQL — and killed at both by the swap.

**Reviewer's independent evidence, having deliberately re-run neither `pnpm quality` nor either billing suite (both green minutes earlier):** (1) **the ordering guard re-armed from scratch**, not read about — swapping `credits.save` above `invoices.markPaid` killed the named R47 test at `spec.ts:248` (`expected 3 to be greater than 4`), and the guard was confirmed to be a genuine cross-aggregate call-order assertion on one shared array, not a row-existence check that a plausible timing could satisfy in reverse. (2) **The R48 concurrent duplicate traced to its mechanism rather than its passing test** — the credit row's `FOR UPDATE` is the transaction's *first* statement, so contenders on the same invoice serialise before either reaches `payments`; and because every read in `lockForOrder` and the invoice row read are *locking* reads, the REPEATABLE READ snapshot is not established until after the winner commits, so the loser's plain `findPaymentByInvoiceId` sees the winner's row and answers `duplicate`. The UNIQUE constraint is a true backstop on this path, never the primary mechanism. (3) **R49's ledger clause checked for vacuity** — `ledgerOf` is a real `SELECT`, and `ledgerBefore` is non-empty in every fixture (a `hold` and a `consume` row), so `toEqual` is a genuine deep comparison in all three refusal cases. (4) **The N10 rule checked for a repeat and found honoured** — the integration file states the rule on itself, claims only what a post-rollback read can establish, and defers "nothing was attempted" to unit-level call counters. (5) **Nine read-only live queries**, including the ledger identity recomputed independently across the whole database.

**The arithmetic result worth keeping: a full payment always returns the credit line to exactly its pre-hold value, and it cannot drift.** `otc_billing.credits` has **no `committed_exposure` column** — the scalar is recomputed on every load by the same `Σhold − Σrelease` expression the domain uses, so store and domain cannot disagree. And `BuyerCredit.releaseHold` derives the released amount from the *ledger* (`outstanding = Σhold − Σrelease` for that order), never from the payment amount, which is not even an input to it. Verified live: `CR-000001` available credit `50618 → 100616`, exactly `+49998`; repo-wide, no order has negative exposure and no order has a release unequal to its hold. The corollary answers the question this feature was asked not to test by paying: `INV-000009`/`INV-000011` carry totals of 49998 against holds of 49698, and paying one at its stated total would release **49698**, the hold — returning the line to precisely its start with **no 300 residue**. The 300 neither vanishes nor leaks into the ledger; it relocates into a more visible inconsistency, *money recorded as received exceeding the exposure the order ever held*, which the credit ledger by design does not model and would not flag. A pre-existing invoice-total defect, correctly left alone.

**Findings open at approval (3, none blocking):** **N11** — the step-0 fast path resolves an existing payment **by reference alone** and never compares it against the invoice the caller named, so registering `PAY-X` against INV-B when `PAY-X` is recorded against INV-A returns a success-shaped `duplicate` naming INV-A and ORD-A, leaving INV-B unpaid with no signal to the caller; the **concurrent** form of the identical situation returns `CONFLICT`, so the same condition yields two answers depending on a race, and the sequential case has no test. Proven by a bespoke reviewer probe, not by the suite. **N12** — the impl record says "ten orders `invoiced`" above a list of eleven. **N13** — `ORD-000007` is permanently stranded at `invoiced` while its invoice is paid and its credit released, the disclosed consequence of the correlation-id misfire; not a code defect, but now a property of the shared dev database that the Phase 11+ demo will surface. Feature 21's N4, N5, N6, N8 and N9 all still stand.

**The honesty note.** The implementer's first live attempt used a random UUID as `x-correlation-id` instead of the order's own id, and it reported this unprompted even though the successful retry alone would have satisfied the brief. The reviewer corroborated every checkable claim in that account against `otc_orders.saga_ignored_facts` and the outbox: Billing wrote correctly and emitted both facts **in the right order** on the failed attempt too; Orders' dedup layer marked both `unknown_order` and ignored them without crashing. A voluntary disclosure that survived independent verification intact is worth more to the trilogy's effort record than a clean run would have been.

**For #8 and #9:** three portable artefacts. (1) **Make an ordering requirement a consequence of structure, then guard the structure.** "Emit A then B" invites a sort key, a timestamp or a comment; none of those survive a refactor. Deriving the order from *call order* → *statement order* → *store-assigned sequence* means the only way to break it is to swap two adjacent lines, which one call-order assertion kills — but the chain must be verified link by link, because it silently breaks if a repository ever records its events outside its own write method. `IDENTITY` in #8 and a serial/sequence in #9 have the identical property. (2) **Trace a concurrency claim to its lock, never to its passing test.** The R48 race test passes; what makes it *reliably* pass is that the credit row's `FOR UPDATE` is the transaction's first statement and that every earlier read is a locking read, so the isolation snapshot postdates the winner's commit. Reorder those reads — or make one of them non-locking — and the same test becomes timing-dependent while still passing most runs. Whatever the stack, write down which lock serialises the contenders and at which statement the read view is established; `READ COMMITTED` defaults in #8 and #9 shift this analysis, and the answer will not be the same. (3) **Idempotency keyed on a reference must still check the subject.** A reference-keyed lookup that answers "already done" without confirming the caller meant *the same subject* will cheerfully report success for work it never did — N11 in miniature, and a shape that recurs in every payment, webhook and message-dedup layer in all three assessments.

---

## notifications_service (id 23, phase 11) — 2026-08-24

**Effort:** **2 implementation sessions + 2 review passes, REJECTED once then approved** — no spec phase (`sdd: false`, no human gate), the specification being `feature_list.json` id 23's three acceptance bullets, the phase-11 checklist, `specs/shared/domain-model.md` §6 and §7.3, and R17/R18. Wall-clock from artefact mtimes (local CEST, 2026-08-24), bracketed at the start by feature 22's commit `50ae502` at 10:41: **round-1 implementation ≈10:41 → 12:20 (≈1 h 39 min)** — the port and its two adapters, seven templates, seven `@CommandHandler`s, the Kafka consumer, the NS9 guard, the Testcontainers Kafka suite, three armed deletions, a live boot against the real stack and a live Mailtrap send. **Round-1 review ≈12:20 → 12:49 (≈29 min)** — four mutation probes and one bespoke real-Kafka probe, verdict **REJECTED, 5 blocking findings**. **Round-2 implementation ≈12:49 → 13:17 (≈28 min)** — the fourth MySQL database, the canonical pair adopted byte-identically, insert-first + delete-on-throw, `fromBeginning: false`, HTML escaping, `messageId`, the cross-restart test, the infra changes, seven live sends and one armed deletion producing two verbatim failures. **Round-2 review ≈13:18 → 13:42 (≈24 min)** — three bespoke Testcontainers probes (four-app restart, N6 ordering, fresh-volume MySQL init), one OI12 re-subversion, two armed guards, a credential sweep and a live binding resolution. **Total ≈3 h 01 min from first file to final verdict**, of which ≈53 min was review across two passes. The only phase-11 feature so far to be rejected and re-submitted, and the only feature in the project whose rejection turned out to be **two** defects — one in the code and one in the harness that was supposed to catch it. *Note: the reviewer's round-2 mutation restores rewrote the mtimes of `notification-dispatch.service.ts`, `notification-format.ts` (both 13:26) and `idempotent-consumer.ts` (13:20); all three are md5-identical to the submitted versions (`318e0278…`, `1bd48ae0…`, `9a90fcd0…`) and those timestamps are not implementation activity. Both temporary probe specs and one temporary MySQL container were deleted, leaving no trace in `git status`.*

**What was built:** the Notifications service — a `NotificationSender` port with a console adapter and a real Mailtrap/nodemailer SMTP adapter, bound by one `useFactory` that fails fast on a partial credential pair; three `@EventPattern` Kafka consumers (one per fact topic) routing through `@nestjs/cqrs` to seven thin `@CommandHandler`s, one per notified fact (`domain-model.md` §7.3's exact seven — `stock.*` and `credit.*` deliberately excluded); seven templates with plain-text and escaped-HTML bodies and the correlation id in every subject; and a durable `processed_events` ledger in a fourth MySQL database, `otc_notifications`. The service answers no RPC, emits no fact and has no outbox, guarded by `notifications-consumes-only.spec.ts`. Packages added: `nodemailer ^9.0.5`, `@types/nodemailer ^8.0.1`.

**The rejection, and why it mattered more than a normal one.** Round 1 shipped an **in-memory** dedup ledger — a `Set` on the heap — justified by `domain-model.md` §34's "Notifications: nothing durable" and by the bounded scope, which did not include the compose files a fourth database would require. The reviewer's probe against a real Kafka broker produced **three emails for one `eventId`**: one from the initial delivery, one after a process restart with the same consumer group, one after an offset reset with `fromBeginning: true`. The implementer had in fact already triggered this live, hitting Mailtrap's `550 5.7.0 Too many emails per second` — and had recorded it in the progress file as "a genuine, useful confirmation" of correct retry behaviour. It was the defect firing.

**Two readings of the same spec, and the one that wins.** §34's "nothing durable" sits in the **Owns** column of an aggregate-ownership table, opposite "Does not own: any aggregate" — it is about business state, and the dedup ledger is infrastructure in all three other services, not an aggregate. §6, five lines long, then names the obligation explicitly: *"Its only domain-relevant obligation is idempotency: one delivery per `(eventId, consumer)` regardless of redelivery (R17, R18)"*. And `saga.md` §6 settles it: three layers of defence exist, and Notifications has neither layer 2 (no state machine to guard a precondition) nor layer 3 (it issues no commands). **Layer 1 is its only defence** — so it needs durability more than the orchestrator does, not less, which is the exact inverse of the argument the implementation made.

**The finding that outlived the feature: the guard was broken too, and that was worse.** `apps/orders`' `idempotent-consumer.parity.spec.ts` (OI12) exists to stop the per-service copies of the dedup pattern from diverging. Its "variant" branch — dormant since it was written, and armed for the very first time by this feature — reads only the file's leading `//` banner and asserts two substrings: that it cites the canonical path and carries a `Divergence:` line. The reviewer replaced the entire body of the notifications `runOnce` with a version doing **no deduplication at all**, left the banner untouched, and OI12 reported **4 passed**. Compounding it, the copy-vs-variant discriminator is `hasMySqlProcessedEventsSchema(app)` — the existence of a file the implementer chooses whether to create — which also gates the "every fact-consuming write model must own a copy" case. A service could opt out of the real comparison by simply not having a schema. The implementer's claim that the divergence was "exactly what OI12 was built to require" was literally true and materially misleading: requiring a banner is all that branch has ever done.

**The fix, and the leader's better call.** The leader granted the scope widening and chose **a fourth MySQL database** over the reviewer's suggested MongoDB option — correctly, and for a reason the reviewer had not weighted heavily enough: `CLAUDE.md` makes database-per-service non-negotiable and R54 makes the projector the sole writer of the read model, so putting a dedup ledger on the Mongo server immediately before feature 24 builds that projector would have blurred exactly the boundary feature 24 must establish. `otc_notifications` now holds one table; `idempotent-consumer.ts` and `processed-events.repository.ts` are **byte-identical** to the canonical (all three services hash to `43dec27b…` and `39242c2c…` banner-stripped); the migration DDL is byte-identical to Fulfillment's `processed_events`. Because the service now owns a `processed-events.schema.ts`, it moved off OI12's text branch onto its **byte-identity** branch — and the identical gutting probe that passed 4/4 in round 1 now **fails**, naming the file.

**The ordering divergence that remains, deliberately.** An SMTP send cannot enrol in the MySQL transaction that records the dedup row, so the canonical's "record + effect in one transaction" is unavailable. The leader's instruction was **insert-first, then send, then delete the row if the send throws** — `runOnce` is called with a no-op `work` so the INSERT commits as its own short transaction, the send happens outside any transaction (an SMTP round-trip must not hold a row lock open), and a thrown send triggers a compensating DELETE before the rethrow. The reviewer proved the ordering by observation rather than inference: the fake sender queried `processed_events` **from an independent connection pool at the moment `send()` was invoked** and saw the committed row already there. This converts "duplicate an email" into "possibly lose one" — the direction §6's "one delivery" points when a choice must be made.

**Reviewer's independent evidence, round 2, having re-run neither `pnpm quality` nor either suite:** (1) **the restart probe re-run** — four apps over one broker, `TOTAL = 1` where round 1 gave 3, covering restart, crash-before-commit (simulated with `admin.resetOffsets` to earliest, so the broker redelivers the *original* messages rather than a republished copy) and a new consumer group; run 4 forced `fromBeginning: true` deliberately, proving the ledger alone is sufficient and the two fixes are independent. (2) **OI12 re-subverted and confirmed to bite.** (3) **N6's ordering and delete-on-throw proven against real MySQL**, including the failed-then-retried path ending at exactly one send and one row. (4) **The MySQL init script proven on a genuinely fresh volume** — a disposable `mysql:8.4.11` started from empty with `infra/mysql/init` mounted, confirming `otc_notifications` is created, granted and writable by `otc_app`, since the live container's initialised volume never re-runs init scripts and therefore proves nothing about the clean clone that #8 and #9 will start from. (5) **Two guards armed** — deleting the compensation call and making `escapeHtml` a passthrough each killed named tests. (6) **The live binding resolved through the built `dist/`** to a real `MailtrapNotificationSender`, confirming the seven live sends used the real adapter and not a stub, without printing a credential.

**Findings open at approval (4, none blocking):** **N12** — acceptance criterion 1 ("real email verified in the Mailtrap inbox for each notified fact") is deliberately left **unmet**: all seven were sent and SMTP-accepted through a provably real adapter, but no Mailtrap API token and no browser is reachable from this environment, so inbox arrival needs a human. The seven subjects and `messageId`s are listed in the impl record as search keys; **this must be checked before the wrap-up commit**. **N13** — if the compensating DELETE itself throws, it propagates *instead of* the SMTP error that triggered it, so the email is lost permanently and the operator sees a MySQL error where the cause was SMTP. **N14** — the notifications `processed-events.schema.ts` banner still calls the ledger "append-only", which the compensating DELETE contradicts. **N15** — with the unit spec for `IdempotentConsumer` correctly deleted, OI12 is now load-bearing for three services, which strengthens the case for the N5 briefing. **N5** (OI12's variant branch is text-only) and **N11** (`progress/current.md` still describes feature 22) remain the leader's.

**For #8 and #9:** three portable artefacts. (1) **A documented divergence is not a guarded one, and a guard you can opt out of will be opted out of.** The variant branch here asked for a banner and got a correct banner over incorrect code; the discriminator was a file the implementer chose whether to create. The fix was not a better comment — it was making the service *structurally eligible* for the byte comparison that already existed. Whatever the stack, when a pattern is copied across services, compare the copies mechanically and make the "this one is different" escape hatch require more evidence than prose. (2) **Prove ordering by observation, not by reading the source.** "Insert-first" and "check-then-mark" are one line apart and both pass a happy-path test. Having the side-effecting collaborator query the durable store *from an independent connection at the moment it is invoked* turns an ordering claim into an observation — `IDENTITY`/`SERIAL` and any RDBMS support the same trick. (3) **Test the init path on a fresh volume, not the running one.** A database created by hand against a live container makes every test pass and every clean clone fail; the init script is the artefact #8 and #9 inherit, and it is only ever exercised on an empty volume. Start a disposable container from empty and assert the grant, every time infra changes.

---

## projector_read_model (id 24, phase 12) — 2026-08-24

**Effort:** **1 spec session + 1 human gate + 1 implementation session + 1 bookkeeping-fix pass + 2 review passes — REJECTED once, on bookkeeping only, then approved.** The fourth feature in this project to be rejected and re-submitted (after `orders_acceptance` 15, `fulfillment_stock` 17, `billing_credit` 19, `billing_invoicing` 21, `notifications_service` 23) — and the **first whose rejection contained zero code defects**. Wall-clock from artefact mtimes (local CEST, 2026-08-24), bracketed at the start by feature 23's commit `64a2a77` at **15:29**: **spec ≈17:16 → 17:24** (`specs/projector_read_model/` created 17:16, `design.md` 17:20 — 40 KB, `tasks.md` 17:22 — 63 tasks, gate record `progress/spec_projector_read_model.md` 17:24 with 21 open points, 4 flagged); **human approval gate** (all four flagged rows — the `apps/seed` index edit, NATS-core-publish for the update signal, the `R54`/`R55` row split, and the `apps/seed` allow-list exception — approved as written); **implementation ≈17:24 → 19:49, ≈2 h 25 min**, including four armed fact-emission deletions, the D7 OI12 subversion probe, `pnpm quality` across 11 packages, the integration suite run twice, and the live boot that took the read model from 6 documents to 36 (the `I3` fact is on the real broker at `CreateTime 1787593299042` = 19:41:39); **review pass 1 ≈19:49 → 20:12, ≈23 min** — three bespoke Testcontainers probe specs (10 cases), four hostile mutations, six read-only live-stack query batches and a fixture-vs-live document diff, verdict **REJECTED, 2 blocking defects**; **bookkeeping-fix pass ≈20:1x → ≈20:5x, ≈25 min** (63 task ticks with eight honest rewordings, B7's own two-part armed deletion, `current.md`'s header and Goal); **review pass 2 ≈20:5x → ≈21:0x, ≈14 min** — two ESLint guard re-arms, one coverage run, three targeted vitest runs, a file-existence sweep across all 63 boxes. **Total ≈3 h 41 min from the first spec file to the final verdict**, of which ≈37 min was review across two passes. *Note: the reviewer's Round 1 mutation restores rewrote the mtimes of `idempotent-consumer.ts`, `delta-to-pipeline.ts`, `main.ts` and `legacy-document-backfill.ts` (19:58–20:00), and Round 2's of `order-status-rank.ts` and `project-fact.command-handler.ts`; all six are md5-identical to the submitted versions (`feaba442…`, `fac43b89…`, `afd79ce8…`, `bea52fda…`, `43daf0b7…`, `8442f1e0…`) and those timestamps are not implementation activity. Three temporary probe specs and one temporary `apps/gateway` fixture were deleted, leaving no trace in `git status`.*

**What was built:** `apps/projector` went from a four-file scaffold to **62 files / 4 666 lines** — the third fact consumer and the sole runtime writer of the `order_timeline` read model. A pure domain (`order-status-rank.ts`'s thirteen-row rank table, `money-format.ts`, thirteen summary builders, `projectFact(envelope): ProjectionDelta` with no silent default); a two-operation persistence layer (`$setOnInsert` upsert, then one `findOneAndUpdate` whose **filter is the idempotency check**); three `@EventPattern(TOPIC, Transport.KAFKA)` consumers routed through one `ProjectFactCommand`; a publish-only NATS update signal on `readmodel.order.updated.<orderId>` / `readmodel.timeline.appended.<orderId>`; a partial unique index; and a one-shot boot backfill for every document `apps/seed` has ever written. 111 unit tests in 13 files, 28 integration tests in 10 files (real Kafka, MongoDB and NATS via Testcontainers). Two consciously-scoped edits outside the service: one file in `apps/seed` (the index made partial, plus `statusRank`/`processedEventKeys`) and two rows in `specs/shared/test-matrix.md`. **No new npm package and no new catalog entry** — everything it needed was already there. `apps/orders` byte-unmodified throughout.

**The hazard the previous feature shipped, and why it was absent here.** Feature 23 was rejected for idempotency that passed every test and evaporated across a restart — an in-memory `Set` that produced three emails for one `eventId`. Feature 24 faced the same hazard in its other guise and answered it **structurally**, at spec time: `PR6` forbids the read-then-write shape outright, and the dedup key lives in the `findOneAndUpdate` **filter** — `{ _id, processedEventKeys: { $ne: key } }` — so the mark and the effect are the same bytes in the same write, with no window for a crash or a race to land in. The reviewer attacked it harder than the submission did and it did not move: **twelve independent `MongoClient` connection pools** firing the same `eventId` at an **absent** document, eight rounds, gave `{ processed: 1, callbacks: 1, entries: 1, keys: 1 }` every round; a simulated process restart (brand-new client, brand-new writer) replaying the whole stream twice from offset 0 gave `duplicate×5, processed×3` then `duplicate×8`, ending with 8 entries and 8 distinct `eventId`s; and `monitorCommands: true` proved the negative that no amount of reading can — the driver issues exactly `['update', 'findAndModify']` per apply, on both the first delivery and the redelivery. No `find`. **The property that cost feature 23 a rejection and a second implementation session was right on first submission here, because the spec pass made it a requirement rather than a style note.**

**The find that was not in the brief: replaying against a seeded database is a live `R51`+`R52` violation.** The spec author found it while reconciling the projector's document shape against `apps/seed`'s, and it is the single most valuable thing this feature produced. Every seeded document has its nine timeline entries but an **empty** dedup ledger and **no** `statusRank`. Two consequences, both silent: replay appends every seeded fact a second time; and a missing `statusRank` compares as `null`, which BSON orders **below every number**, so a status-less fact sets it to `0` and the next real fact then outranks it — regressing a `completed` order to `placed`. The reviewer proved it side by side in one test, two identical seeded-shape documents:
```
WITHOUT backfill -> { status: 'placed',    statusRank: 1,  events: 3 }   REGRESSED and DUPLICATED
WITH    backfill -> { status: 'completed', statusRank: 98, events: 2 }   outcome: 'duplicate'
```
The fix is a one-shot, idempotent boot backfill filtered on `{ statusRank: { $exists: false } }`, run **before** `startAllMicroservices()`, deriving each document's rank from its own `status` and its ledger from its own `events[].eventId`. **No unit test and no clean-database integration test can reach this bug** — which is exactly why the task file requires the fixture to be seeded-shape and requires the implementer to delete the backfill and watch a named test fail. Verified live at the strongest level available: running `apps/seed`'s **current** `toTimelineDocument` over `SAGAS` and diffing all six seeded documents field-by-field against the live, backfilled, replayed database gave **client-visible diffs: NONE** on all six, with the backfilled `statusRank`/`processedEventKeys` matching the seed writer's own derivation exactly.

**OI12's variant branch had its first real subject, and this time the guard was armed.** Feature 23's review found that branch reading only a comment: the reviewer gutted a `runOnce` to do no deduplication at all, left the banner untouched, and OI12 reported 4 passed. The branch was rebuilt to require a `Behavioural conformance:` line naming a file that exists and runs the copied conformance suite against the real variant over its real store. Feature 24 is the first `documented-variant` that owns an `idempotent-consumer.ts`, and the reviewer re-armed the identical N5 mutation independently rather than accept the implementer's report: `apps/orders`' text guard still reported **11 passed** — blind, as designed — while the projector's behavioural suite reported **4 failed of 7**, every one `expected 'processed' to be 'duplicate'`, naming the four cases that matter (second call reports duplicate; a consumer constructed fresh over the same store still reports duplicate; the same `eventId` under a different consumer name runs; the post-apply callback runs once on processed and not at all on duplicate). The guard rebuilt after a rejection worked on its first genuine subject.

**The rejection, and why it was still the right call.** Round 1 found **zero code defects** and two blocking artefacts: `specs/projector_read_model/tasks.md` at **0 of 63 ticked**, and `progress/current.md` still describing `billing_remittance_intake` (id 22) with a Phase 9 goal. The first is the same checklist drift that rejected `billing_invoicing` (`N1`, 0/60) and was caught before that in Phase 8; applying a softer standard to the best-engineered feature in the project would have made the earlier rejections arbitrary. The fix pass ticked all 63 with **eight honest rewordings** — including `E2`'s (the pipeline conversion is called from the writer, not the application service, a *stricter* reading of the port boundary than the task's wording), `D4`'s (six cases, not four), `G3`'s (PR13's proof lives at unit level, not in that file) and `I3`'s (the end-to-end order placement substituted with a direct Kafka publish, recorded on the box) — plus `A2`/`J1` declaring that work briefed to the `test_maintainer` and `suite_runner` tiers was done directly, a cost deviation rather than a substance one. Round 2 verified every checkable reword against disk, confirmed all 63 named `.ts` files exist, and re-armed both ESLint guards itself. **Total cost of the rejection: ≈25 min of bookkeeping and ≈14 min of re-review — against a spec pass that prevented the class of defect that cost feature 23 a whole second implementation session.**

**Findings open at approval (6, none blocking):** **N4** — the `gateway → orders → Kafka → projector → NATS` seam was never walked in one run (the `I3` substitution proves the projector's half; the rest is feature 25's, and `R55`'s consumer half is explicitly owed there). **N5** — matrix rule 3's gate-approved relaxation (a row split across features when the Status cell names each half's owner) is argued only in `progress/spec_projector_read_model.md`, a **#7-local** file; `specs/shared/test-matrix.md`, which #8 and #9 inherit verbatim, still carries rule 3 unamended. Fold into feature 25's close, when `R54`/`R55` actually flip. **N6** — `out-of-order-facts.integration.spec.ts:104` is named *"a later `invoice.issued.v1` never overwrites an already-set `despatchReference`"*, but that fact never writes that field; deleting the `$ifNull` guard leaves the file green. Not a coverage hole — the same mutation kills `delta-to-pipeline.spec.ts` — but the name promises a behavioural proof the case does not perform. **N7** — three synthetic probe facts (one with the non-UUID aggregate id `live-order-1`) sit permanently in the dev fact log; `fromBeginning: true` re-materialises them into the read model on every fresh consumer group, so feature 25's `GET /orders` will list them alongside five header-less placeholders. Dev-stack hygiene, and a note for 25's list-query fixtures. **N8** — the `E11000` retry-exactly-once is scoped to Phase 1's `_id` upsert; a Phase-2 duplicate on `uq_order_reference` would block the partition forever, since redelivery cannot fix a uniqueness violation. Unreachable while `ORD-######` is unique, but a concrete instance for feature 27's retry classification. **N10** — `G3`'s reword corrected the task box but not the spec file's own header (`out-of-order-facts.integration.spec.ts:2` still lists `PR13`) nor two `"(verbatim)"` claims that are not verbatim. **N11** — `progress/current.md`'s cumulative log has no feature-24 entry at all and asserts at line 73 that *"apps/projector is still a scaffold"*; the file's own template says to reset on close, which has not happened since phase 7.

**For #8 and #9:** three portable artefacts. (1) **Make idempotency a property of the query, not of the code around it.** "Check whether we have seen this, then write" is two operations and therefore a window, no matter how carefully it is written — and it passes every sequential test. Putting the dedup key **inside the filter** of the single write that applies the effect removes the window by construction: there is nothing to serialise because there is only one operation, and the store's own concurrency control is the serialisation point. Whatever the stack — a conditional `UPDATE … WHERE NOT EXISTS`, an `INSERT … ON CONFLICT DO NOTHING` whose row count is the answer, a Mongo `findOneAndUpdate` filter — write down which single statement carries both the mark and the effect, and prove the absence of the preceding read by **recording the driver's actual commands**, which is the only way to prove that negative. (2) **A derived store's first boot against pre-existing rows is a migration, and it is the case no test reaches by default.** Any read model built by replay will one day start against documents some earlier tool wrote in an almost-identical shape. The almost is what bites: a missing numeric field that compares below every number, an empty dedup ledger that suppresses nothing. Neither a unit test nor a clean-database integration test can see it, because both start from empty. Build the fixture in the **legacy shape**, run the backfill, replay the real history, and assert the document is *unchanged*; then delete the backfill and confirm the test fails. (3) **When a checklist and an implementation report disagree, the checklist is the artefact that must be repaired — and rewording a box beats ticking it.** Eight of this feature's 63 boxes were reworded rather than ticked as written, each stating what actually happened and why it differed. That is worth more to #8 and #9 than 63 clean ticks would have been: a tick over a stale description reads as done and is not, and it is the single most-repeated defect in this project's history — phase 8, feature 21 and feature 24, three times, always caught at review and never by a test.

---

## gateway_rest_auth (id 25, phase 13) — 2026-08-25

**Effort:** **1 implementation session + 3 review passes + 2 fix passes — REJECTED twice, then approved.** The sixth feature in this project to be rejected and re-submitted (after `orders_acceptance` 15, `fulfillment_stock` 17, `billing_credit` 19, `billing_invoicing` 21, `notifications_service` 23, `projector_read_model` 24) and the **first rejected on a defect that no test in the repository could have caught, because both sides of the seam were tested only against the wire each preferred**. No spec session: `sdd: false`, the specification of record is `specs/shared/openapi.yaml` (17 path keys, 18 operations) plus `feature_list.json` id 25's three acceptance criteria and `R54`/`R55`. Wall-clock from artefact mtimes (local CEST, 2026-08-25), bracketed at the start by feature 24's commit `f86c157` at **12:40**: **implementation ≈13:23 → 14:20, ≈57 min** (`apps/gateway/src/domain/auth/operator-credentials.ts` created 13:23, `progress/impl_gateway_rest_auth.md` written 14:20); **review pass 1 ≈14:20 → 14:42, ≈22 min** — verdict **REJECTED, 1 blocking defect (F1) + 5 material + 8 minor**; **fix pass 1 ≈14:42 → 15:23, ≈41 min**, run by **three agents concurrently on disjoint directories** (`apps/gateway` 14:51–14:52, `apps/projector` 15:08, `apps/orders` 15:23); **review pass 2 ≈15:20 → 15:31, ≈11 min** — every code defect confirmed closed by independent execution, verdict **REJECTED on close-out artefacts only, 1 blocking (G0) + 2 material + 6 minor**; **fix pass 2 ≈15:31 → 15:49, ≈18 min** (a fourth agent's work folded in: `apps/notifications`' `tsconfig.build.json`); **review pass 3 ≈15:50 → 16:05, ≈15 min** — verdict **APPROVED**. **Total ≈2 h 45 min from the first source file to the final verdict**, of which ≈48 min was review across three passes and ≈59 min was fixing what review found — i.e. **review and rework together cost slightly more than the original implementation**, the highest such ratio in this project so far, and the feature where that was most obviously worth it. *Note: the reviewer's mutation restores rewrote the mtimes of `apps/gateway/src/infrastructure/persistence/mongo-client.ts`, `apps/gateway/src/presentation/{orders,health,stock}.controller.ts`, `apps/gateway/src/app.module.ts`, `apps/orders/src/orders-create-wire.integration.spec.ts` and `apps/orders/src/infrastructure/messaging/bare-json-nats.deserializer.ts`; all are byte-identical to the submitted versions (the last one proven by the parity guard itself returning 5/5 green afterwards). Two stub packages under `apps/gateway/node_modules/`, one probe file in `apps/fulfillment/src/`, one probe controller and one probe spec in `apps/gateway/src/`, and a temporary `apps/__reviewer-newapp/` were created and deleted, leaving no trace in `git status`.*

**What was built:** `apps/gateway` went from a four-file scaffold to **106 files / 5 692 lines** — the first HTTP surface in a system that had spoken only NATS and Kafka. All 18 of `openapi.yaml`'s operations, implemented against the contract rather than regenerated from it (`GET /docs` serves the YAML file verbatim through `swagger-ui-express`, so the documentation cannot drift from the contract by construction). A pure domain (`rpc-error-mapping.ts`'s two-level RPC→HTTP classification, `operator-credentials.ts`, `replay-buffer.ts`, `cursor.ts`, `issued-order-window.ts`); `@nestjs/cqrs` command and query handlers for every endpoint; a `NatsRpcClientAdapter` with a typed error taxonomy (`RpcTimeoutError`/`RpcTransportError`/`RpcBusinessError`) that never collapses a business refusal into a transport failure; a global RFC 9457 `ProblemJsonExceptionFilter`; a global `JwtAuthGuard` with exactly four `@Public()` exemptions; a read-only MongoDB connection onto the projector's own `order_timeline` (`R54`); and `GET /orders/stream` as raw SSE — deliberately not Nest's `@Sse()`, whose `Cache-Control` header does not match the contract's `const: no-cache`. 114 unit tests in 28 files, 32 integration tests in 6 files (real NATS + real MongoDB via Testcontainers). Two consciously-scoped repairs outside the service, both routed by the leader after review: `apps/orders` gained the bare-JSON NATS wire pair plus its own parity guard (**701 lines**), and `apps/projector`'s `PR20` guard was rewritten and its requirement amended.

**F1 — the defect, and why nothing could have caught it.** `apps/orders/src/main.ts` connected its `orders.create` NATS microservice with `@nestjs/microservices`' default (de)serializers, while `apps/fulfillment` and `apps/billing` had both installed `BareJsonNatsDeserializer`/`BareJsonNatsSerializer` back in phase 9. The gateway sends bare JSON. Nest's default deserializer sees no `id`, `ServerNats.handleMessage` branches to `handleEvent`, and **the handler runs to completion — order persisted, outbox row written — while the reply subject is never answered.** The caller times out at 5 s, receives `503 UPSTREAM_UNAVAILABLE` for an order that exists, and retries, placing a second one. The reviewer proved it against a disposable NATS container with a Nest microservice configured byte-identically to `apps/orders/src/main.ts`:
```
HANDLER INVOKED, side effect would happen
BARE-JSON ERROR: TIMEOUT TIMEOUT
NEST-ENVELOPE REPLY: {"response":{…},"isDisposed":true,"id":"1"}
```
**Why no test saw it:** `apps/gateway`'s integration suite answered `orders.create` with a bare-JSON stub its own author wrote; `apps/orders`' `orders-acceptance.integration.spec.ts` drove the responder through a Nest `ClientProxy` envelope. Each side was tested only against the wire it preferred, and nothing in the repository ever put the two together. The fix installs the pair and adds `orders-create-wire.integration.spec.ts`, which drives **both** callers against **one** responder. At the final review the reviewer closed the seam empirically rather than by test: real `otc-nats`, real `otc-mysql`, `apps/gateway` and `apps/orders` and `apps/fulfillment` each started from their own built `dist/main.js`, and `POST /orders` answered `201 Created` with `Location`, `X-Correlation-Id` and a **bare** `PlaceOrderResponse` carrying `ORD-000031` — no framework envelope anywhere.

**F2 — the third text-guard hole this project has found, and the first one whose author caught themselves.** `no-write-database-client.spec.ts` enforced `R54` with `text.includes("'mysql2'")`. `import mysql from 'mysql2/promise'` and `import { drizzle } from 'drizzle-orm/mysql2'` — the exact forms `apps/billing`'s own persistence layer uses — contain neither string, so the guard passed green against the reviewer's armed mutation while the implementer's own mutation (`import 'mysql2'`) was the one form it caught. The replacement does not read text at all: it spawns a real `node` child process and asks **it** to `require.resolve()` each of four specifiers, bare and subpath. Building it, the implementer discovered the first attempt was itself broken — vitest injects a `NODE_PATH` pointing at a hoisted directory where both packages genuinely *do* resolve, so an in-process check or an environment-inheriting child reported a false green. Stripping `NODE_PATH` is what makes the child representative of `node dist/main.js`. The reviewer confirmed both halves by hand (`MODULE_NOT_FOUND` for all four without `NODE_PATH`, `RESOLVED` for two of them with it), made the property genuinely false by planting stub packages under `apps/gateway/node_modules/`, and watched the guard name all four specifiers with their resolved paths.

**F3 — "the caller has just been given" is a claim the gateway can actually check.** `GET /orders/{id}` answered `202 projection pending` for *every* id absent from the read model, including garbage, making `openapi.yaml`'s own documented `404` unreachable. The submission argued the gateway "has no way to ask Orders 'does this id exist at all'" — true of the RPC surface, and false of the gateway, which is the component that hands the caller the id. `IssuedOrderWindow` (bounded, TTL'd, insertion-ordered eviction, 10 000 × 5 min) records every id `POST /orders` issues; a miss inside the window is `202`, a miss outside it is `404`. All three branches were confirmed live at the final review, against a running stack with the projector deliberately not started: a real just-issued id → `202`, a random id at the same instant → `404`. **Carried as G3:** the window is process-local, so two replicas would answer `404` for an order the other just accepted — recorded rather than fixed, since feature 24 had already ruled multi-replica gateways in scope.

**The three-agent fix pass, and the one thing that leaked.** Round 1's fixes were run concurrently across `apps/gateway`, `apps/orders` and `apps/projector`. One genuine cross-dependency existed and was handled correctly: the gateway's new (and `R54`-mandated) `mongodb` import made `apps/projector`'s `PR20` guard report the gateway as an offender, so that guard was rewritten from *who imports* to *who writes*, and `PR20` itself was amended inline rather than silently. What leaked was the index: the projector agent renamed the guard's `describe` and its cases while the gateway agent, writing `specs/shared/test-matrix.md`'s `R54` cell at the same time, still cited the old titles — neither could see the other. **That was the fifth correction to `test-matrix.md` in three rounds, and every one was found by a human or an agent reading it, never by a check.** The file is the only artefact in this repository that indexes tests and has no guard of its own.

**Findings open at approval (4, none blocking):** **G3** — the recency window is process-local (above). **G6** — nothing ties any service's `main.ts` to its bare-JSON pair; ruled **owed, not built**, and the reviewer agreed that the obvious implementation (a grep of `main.ts` for the class names) would repeat the exact anti-pattern the new parity guard exists to close, while naming `saga_e2e_verification` (28) as the right home for the trustworthy version and a shared exported options object as the cheap intermediate. **H1** — `orders-acceptance.integration.spec.ts:11-13` still describes its `ClientProxy` as *"the same client a future Gateway feature would use"* and its own test as exercising *"the REAL wire protocol"*; both became false with F1, and the new G7 comment lower in that same file cites the stale header as its justification. **H2** — the `test-matrix.md` notation question above.

**For #8 and #9:** three portable artefacts. (1) **A stub is a claim about someone else's code, and an untested claim is a guess.** Every wire in this system was exercised, and one was still wrong, because the two sides were tested separately against stubs each author wrote to agree with themselves. The discriminator is not "is there an integration test" but "does any single test contain both the real caller's encoder and the real responder's decoder". Whatever the stack, when service A calls service B, write one test that boots B's **production** transport configuration and drives it with A's **production** client — and if the harness hand-mirrors that configuration rather than importing it, say so out loud, because the mirror is where the drift will live. (2) **A guard that reads text will eventually be defeated by the codebase's own idioms, not by an adversary.** `'mysql2'` missed `'mysql2/promise'`; the fix was not a better regular expression but a different question — *can this package be resolved at all?* — asked of a real process. Prefer guards that make the offending state impossible to construct over guards that look for it, and when a guard must read text, arm it with the form the rest of the repository actually writes rather than the form you imagined. (3) **When a requirement and a guard disagree, check which one is wrong before fixing either.** `PR20` said "may import `mongodb`" and meant "may write to the read model"; obeying `R54`'s second half made the guard fire. The repair was to amend the requirement, record the amendment inline with its reasoning, and rewrite the guard around the property that was actually meant. A guard rewritten to accommodate a violation is a retreat; a requirement rewritten because it said the wrong thing is a correction — and the difference is worth writing down at the time, because nobody can reconstruct it later.

## gateway_sse_push (id 26, phase 13) — 2026-08-26

**This closes Phase 13.** The Gateway/BFF phase is done: `gateway_rest_auth` (25) built the REST/auth/read surface, `gateway_sse_push` (26) closes the two acceptance criteria feature 25 left open and walks the `projector → NATS → gateway` seam feature 24's review recorded as owed (finding N4).

**Effort:** **2 implementation passes (round 1 build + round 2 fix) + 2 review passes (round 1 REJECTED, round 2 APPROVED) — plus one round 2 review attempt that was interrupted mid-run by a session limit and produced no artifact, not counted below.** No spec session: `sdd: false`, the specification of record is `feature_list.json` id 26's two acceptance criteria plus `specs/shared/openapi.yaml`'s `/orders/stream` reconnection section and `R55`. Wall-clock from artefact mtimes (local CEST, 2026-08-26), bracketed at the start by feature 25's commit `4f52c8e` at **19:00 (2026-08-25)**: **round 1 implementation ≈06:34 → 06:44, ≈10 min** (`kafka-test-fixture.ts` created 06:34:36; the implementation record's original version complete ≈06:44, per Round 1 review's own citation of both timestamps); **round 1 review ≈06:44 → 07:01, ≈17 min** (`progress/review_gateway_sse_push.md` mtime 07:01:31) — verdict **REJECTED, 1 blocking (F1: the E2E booted the real, unmodified `apps/projector` under `tsx`, the compiler this project abandoned everywhere for silently mis-resolving bare-typed DI, behind a header comment that falsely claimed equivalence to `pnpm dev:projector`) + F3/F4/F5 minor**; **round 2 fix pass ≈07:01 → 07:37, ≈36 min** (`sse-test-client.ts` F4 rewrite 07:05:24, `spawn-real-projector.ts` F1 rewrite 07:06:35, `stream.integration.spec.ts` F3 fix 07:07:15, `stream-projector-e2e.integration.spec.ts`'s `afterAll` F5 rewrite, implementation record's round 2 section finalized 07:37:02); **an interrupted round 2 review attempt, unknown duration, no output, not resumed and not counted**; **this completing round 2 review, independently conducted from scratch (not a resumption), ≈10:05 → 10:24, ≈19 min** — verdict **APPROVED**. **Traceable total ≈1 h 22 min** across the two implementation passes and two completed review passes, excluding the interrupted attempt.

**What was built, round 1:** the projector→NATS→gateway seam proof (`stream-projector-e2e.integration.spec.ts`, group E) — the only spec in the repository that boots a real, unmodified sibling service as a genuine OS child process against real Kafka/MongoDB/NATS, plus a bespoke auth-free NATS Testcontainers fixture (`open-nats-test-fixture.ts`, justified by reading `@testcontainers/nats`'s forced `--user`/`--pass` and `nats@2.29.3`'s inability to parse credentials out of a bare `NATS_URL`) and the replay-boundary exclusivity test for acceptance criterion 1. Acceptance criterion 2 ("heartbeat keeps the connection alive") was judged honestly untestable in this harness beyond emission-on-schedule (already proven by feature 25's F7 fix) and left unproven rather than faked — accepted by both review rounds, with Round 1 naming one alternative (a small idle-timeout TCP relay) the record should have weighed and rejected explicitly rather than omitted.

**F1 — the defect, and why it mattered beyond this feature.** `spawn-real-projector.ts` originally spawned `apps/projector`'s local `tsx` against its unmodified `src/main.ts`, with a header claiming this was "exactly as `pnpm dev:projector` would launch it, minus `tsc-watch`" — false: that script runs `node dist/main.js`, and `tsc-watch` is the compiler, not a wrapper. `tsx` is esbuild-based and does not implement `emitDecoratorMetadata` (`CLAUDE.md`'s DI-tokens rule), so a bare-typed constructor parameter resolves to `undefined` **silently** under it. The test passed only because every Nest-instantiated class in `apps/projector` happens to use `@Inject`/`useFactory` already — an invariant the round 1 reviewer verified by enumerating every constructor rather than assuming, and found only partly machine-enforced (`eslint.config.mjs`'s selector matches `TSParameterProperty`, not a bare non-property parameter). The risk: `saga_e2e_verification` (28) is the obvious next consumer of this fixture pattern for every service, and the failure mode of getting it wrong is a **green** E2E against a boot path production never uses — the exact false assurance `apps/orders/src/di-metadata-divergence.spec.ts` exists to make impossible. **The fix:** the fixture now runs `tsc -p tsconfig.build.json` (`apps/projector`'s own `build` script, ≈2.5s) via `spawnSync`, inspects `result.status`, and only then spawns `node dist/main.js` — the identical artefact `tsc-watch --onSuccess` restarts and `pnpm start` runs directly. The round 2 reviewer verified this was not merely inspected in prose but actually guarded: injecting a real TS syntax error into `apps/projector/src/main.ts` made the E2E die in 16s naming the compiler error, not proceed against a stale/absent `dist/`, and re-arming the original seam mutation (the wildcard NATS subject) on the new boot path reproduced Round 1's exact failure signature.

**F3/F4 — closed cleanly, both independently re-verified in round 2 by re-arming the same mutations Round 1 used.** F3: a bare 100ms sleep before a reconnect assertion (allowing the off-by-one replay-boundary mutation to survive silently via the live-push path) replaced with a retry loop that synchronizes on `stream.ready`'s own `resumed` flag and asserts it explicitly before the exclusivity check runs — round 2 confirmed the mutation now dies strictly *after* that assertion passes, which is what makes the fix real rather than cosmetic. F4: `collectUntil` no longer drops buffered frames between sequential calls on the same connection (WeakMap-keyed shared per-connection state, verified for leaks by running the affected suite twice with no growth or hang).

**F5 — improved, one residual gap surfaced independently in round 2, not blocking.** Round 1's finding: a teardown failure inside `afterAll` competed with and could bury the real test failure. The fix (five teardown steps, each independently try/caught and logged rather than thrown) closes the case the implementer armed (a forced synchronous throw). The round 2 reviewer's own probe — re-arming F1's seam mutation, a *genuine* 90s `collectUntil` timeout rather than a forced throw — found a gap the implementer's arming didn't reach: the `it` body's `req.destroy()` sits after the now-unreached `collectUntil` await, so a timed-out test leaves the SSE connection open, and `testApp.close()`'s underlying `http.Server.close()` then hangs (Node does not force-close existing keep-alive connections) past the 60s `afterAll` timeout, producing a second, competing `Hook timed out` report alongside the real one. Ruled non-blocking: the real message is still fully legible (not buried, merely duplicated), no container or process leaked in any probe (`docker ps`/`ps aux` clean throughout, including immediately after the failing run), and it matches Round 1's own Minor severity for this defect class. Recorded as an owed follow-up — wrap the `it`'s SSE lifecycle in `try/finally`, or race each `afterAll` step against its own timeout — natural home is whichever feature next touches this spec (28, `saga_e2e_verification`, which will spawn more child-process services and hit the identical shape).

**Findings open at approval (3, none blocking this feature):** **F2** (six copies of `kafka-test-fixture.ts`; three of six predate a known Kafka-race fix and were never back-ported) — leader's to route, untouched this round. **F5's residual gap** (above) — recorded as a follow-up, not re-opened as a blocker. **F6/F7** were already closed by the leader before this round (`specs/shared/test-matrix.md`'s `R55` row corrected to attribute the web half to feature 29, not 26; `progress/current.md` now describes feature 26 rather than the stale feature 25 entry) — confirmed, not re-litigated.

**For #8 and #9:** two portable artefacts. (1) **A test fixture that spawns a sibling service as a real process must boot it on the exact path production boots it, and say so precisely enough to be checked** — "minus `tsc-watch`" sounds like a small simplification and was actually the removal of the one thing that mattered; the discriminator for whether a shortcut is safe is not "does it pass today" but "is the invariant that makes it safe today enumerated, and is it machine-enforced or merely observed." (2) **Arming a teardown fix with a forced synchronous throw is not the same claim as arming it with a genuine failure** — the two produce different failure shapes (a throw is caught by a `try`/`catch`; a hang is not), and a reviewer who only re-runs the implementer's own arming will miss the gap between them. The cheaper habit is to prefer whatever mutation the *feature's own* seam already offers (here, F1's wildcard-subject break, which produces a real 90s timeout) over inventing a new one, because it is closer to what will actually happen in production and it is already independently justified.

## observability_reliability (id 27, phase 14) — 2026-08-27

**Effort:** **1 spec session + 1 human gate + 6 implementer passes + 1 review pass, approved first time** — the largest feature in the project by every measure (implementer passes, files touched, `pnpm quality` growth from ~1,150 to 1,246 tests). Widened before speccing to fold in a dormant feature (`orders_idempotent_replay`, formerly id 39) at the human's request, per `feature_list.json` id 27's own `notes` provenance. Wall-clock from artefact mtimes (local CEST), bracketed at the start by feature 26's commit `4f52c8e` at 19:00 (2026-08-25): **spec ≈13:15 → 13:17 (2026-08-26)** (`design.md` 13:15, gate record `progress/spec_observability_reliability.md` 13:17 — 7 open points, all flagged, the largest-blast-radius one being the `order.saga_failed.v1` 14th-fact decision, resolved Option 1 before implementation began). **Pass 1 (Group B + A0/A1/A3/A4-orders-only + A6b/A6d + A9) ≈13:17 → 14:57, ≈1 h 40 min** — the RI3 concurrency mechanism (including the empirically-discovered second `FOR UPDATE` lock), the 14th fact, the `saga_commands` park hook, the retry-then-DLQ dispatcher for Orders, the Gateway correlationId defect fix, Prometheus cleanup. **Pass 2 (A4b/A4c/A4f/A4g continuation) ≈14:57 → 15:29, ≈32 min** — the dead-letter mechanism extended to Projector/Notifications with each service's own incident reproduction, OI12 widened (surfacing and fixing a real false-positive in the guard's own `.spec.ts`-scanning). **Pass 3 (A5, trace propagation) ≈17:12 → ≈18:13** (a real gap before it, likely OTel package research/installation) **≈1 h** — HTTP/NATS RPC/Kafka-facts injection+extraction across four in-scope services, a real structural conflict found and resolved (OB1's parity guard vs. the new tracing divergence, closed with a narrow positive-marker exception), bounded scope explicitly excluding Fulfillment/Billing. **Pass 4 (A6, structured-logging traceId) ≈18:13 → 18:20, ≈7 min visible** (the three named call sites design.md itself confirmed) — flagged `DONE` by this pass but under-scoped; **the leader's own correction found two more untouched JSON-shaped loggers**, sending R58 back to `PARTIAL`. **Pass 5 (R58 closeout + A7 metrics) ≈18:20 → 19:20, ≈1 h** — the genuine full-repo grep this time (not assumed complete), four more call sites fixed, two legitimate documented exceptions; all five metric instruments, two of them (`otc_outbox_lag_ms`, `otc_dlq_depth`) proven against real Testcontainers infrastructure with exact expected values, not merely "a value was recorded." **Pass 6 (A8, health checks) ≈19:20 → 20:16, ≈56 min** — five services' `HealthController`s, five real-Testcontainers container-pause proofs, a real architectural gap closed (Fulfillment/Billing had no outbound NATS connection at all before this pass), a real bug found in the reference NATS check (no `rtt()` timeout — left unfixed in the Gateway per bounded scope, fixed in all three new copies), a real "two-Docker-daemons" environment quirk hit and worked around. **Total implementation ≈13:17 → 20:16, ≈7 h across six passes on 2026-08-26**, plus a same-day-adjacent bookkeeping correction (the leader ticking `tasks.md`'s A6a/A6c boxes and re-flipping `test-matrix.md`'s R58 row, `progress/impl_observability_reliability.md` mtime 2026-08-27 05:49 — not implementation activity). **Review ≈06:00 → 06:10 (2026-08-27, this pass), reading six report sections + the spec gate + `tasks.md` + `feature_list.json`, plus ten targeted probes, six of them genuine, independently-authored mutations against real Testcontainers infrastructure** (RI3's second `FOR UPDATE` lock removed and reproduced; a service's own DLQ-publish call disabled and reproduced; the saga-facts trace-continuity wrap removed and reproduced; a health check hard-coded `up` and reproduced; an unrelated one-line divergence introduced inside an OB1-exception file and caught) — **≈35 min of Testcontainers wall-clock across the probes**, the rest code reading and independent grepping (R58's call-site sweep re-derived from scratch, not trusted from the report). **Total ≈7 h 45 min from the first spec file to the final verdict**, across one spec session, six implementer passes and one review pass — by a wide margin the most expensive feature in the trilogy benchmark so far, commensurate with folding two features' scope into one and genuinely realising all five observability/reliability mechanisms (R56–R60) plus the requestId idempotency mechanism (R62) across six services. *Note: the reviewer's mutation restores rewrote the mtimes of `apps/orders/src/infrastructure/persistence/order.repository.ts`, `apps/orders/src/presentation/saga-facts.controller.ts`, `apps/orders/src/infrastructure/health/mysql-health-check.ts`, `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts` and `apps/billing/src/infrastructure/outbox/outbox-relay.ts`; all five are byte-identical to the submitted versions (`diff` confirmed after each restore) and those timestamps are not implementation activity.*

## saga_e2e_verification (id 28, phase 15) — 2026-08-27

**Effort:** **3 implementer passes + 1 review pass, approved first time.** No spec session: `sdd: false`; the specification of record is `feature_list.json` id 28's five acceptance criteria (widened by the leader on 2026-08-26 to fold in `R56`'s composed-stack trace observation, per that entry's own `notes` field) plus `specs/shared/test-matrix.md`'s `R56`/`R57` rows. Wall-clock from artefact mtimes (local CEST, 2026-08-27), bracketed at the start by the prior checkpoint commit `95e883a` at **06:22:55**: **Pass 1 (R57 prerequisites + the generalized `spawn-real-service` helper) ≈06:23 → 07:17, ≈54 min** — Gateway's missing NATS `rtt()` timeout wrapper; a full trace-only OTel bootstrap stood up from scratch for Fulfillment **and** Billing (neither had any OTel plumbing at all — larger than the brief's own phrasing implied, disclosed as such); all 11 real `@MessagePattern` responders across both services wrapped with `extractNatsTraceContext`/`otelContext.with(...)`; a third hop found and fixed that neither prior pass had named (both services' `outbox-recorder.ts` always wrote `traceParent: null`); `spawn-real-service.ts` generalized from `spawn-real-projector.ts`. **Pass 2 (the four core saga criteria against a real spawned four-process fleet) ≈07:17 → ≈10:50, ≈3 h 33 min — the longest single implementer pass in this project.** Built the one-fleet-four-criteria suite (3 disposable MySQL + Kafka + NATS + MongoDB, Fulfillment/Billing/Projector spawned concurrently then Orders last); hit and fixed a real architectural violation live (`mysql2` as a Gateway devDependency broke `no-write-database-client.spec.ts`'s own guard — not a false positive — fixed by `mysql-worker-client.ts`'s node-child-process-with-absolute-path-require technique); found and fixed a real flake (polling for an *exact* intermediate order status raced past it inside one 300ms tick against this fleet's real speed); and, building criterion 3, discovered **four independent, cooperating redundant guards** protecting the same redelivery scenario rather than the one the brief anticipated, each individually armed-deleted and confirmed non-blocking before all four were disabled together to reproduce the corruption. **Pass 3 (R56's composed-stack trace observation) ≈10:50 → 11:26, ≈36 min** — re-audited `test-matrix.md`'s own R58 premise from scratch rather than trusting it, found it true only for Orders (not "every service" as the Pass-3 brief's premise implied), and built criterion 5 from the best real evidence that actually exists (Orders' structured log lines + Fulfillment's/Billing's own durably-recorded `trace_parent` columns) rather than fabricating logging or silently narrowing the claim — with Projector and Gateway both honestly excluded and the reasons stated precisely. **Total implementation ≈06:23 → 11:26, ≈5 h 3 min across three passes on 2026-08-27.** **Review ≈11:26 → 11:44, working from the leader's already-confirmed green `pnpm quality`/`./init.sh` (not re-run in full) — five independent real-fleet re-arm probes performed instead** (criterion 3: two individual layers disabled independently and confirmed still green, then all four disabled together and the exact `expected 2 to be 1` corruption reproduced; criterion 5: Fulfillment's `activeTraceParent()` nulled and the exact per-source-labelled failure reproduced; criterion 4: `fact-retry-dispatcher.ts` made to rethrow after its DLQ publish, reproducing the Phase-12 offset-blocking shape precisely, at the *second* `waitFor` rather than the first), each against the real six-container/four-process fleet, every restoration confirmed byte-clean by `git diff`/`git status --porcelain` and a clean `tsc --noEmit` on every touched service, the full 5-criterion suite re-run green three times across the session. Also independently re-derived R57's decorator count from source (11, matching the leader's own correction) and read all 11 wrapped handler bodies rather than sampling. **Total ≈5 h 21 min from the first source file to the final verdict**, of which implementation was ≈5 h 3 min (dominated by Pass 2's 3 h 33 min) and review was ≈18 min of wall-clock spent almost entirely on five real Testcontainers fleet spin-ups rather than reading. One informational, non-blocking finding recorded for the leader to route as a follow-up: the `mysql-worker-client.ts` absolute-path-`require()` technique that preserves Gateway's `no-write-database-client.spec.ts` guard today is safe only because it lives outside `tsconfig.build.json`'s `dist/` graph and no production file currently reuses the pattern — the guard itself cannot detect the same technique if a future feature ever moved it into production `src/`.

**What was built:** the first — and, per this feature's own design intent, only — suite in this repository that drives the **actually-running, composed, multi-process system**: real, separately-built, separately-spawned `apps/orders`/`apps/fulfillment`/`apps/billing`/`apps/projector` `dist/main.js` processes talking to each other over a real Kafka broker and a real NATS broker, each backed by its own disposable MySQL database, writing into a real MongoDB read model — never an in-process `TestingModule` standing in for any of them, and deliberately different in kind from every other integration spec in the repo (which each prove one service's own `AppModule` graph). Five criteria, one shared fleet, no test depending on another's leftover state: a happy-path order reaching `completed`; a `.99` order compensating visibly (precisely — Orders' domain-level `cancellation_reason`, Billing's own more granular internal refusal reason read from its outbox, **and** Fulfillment's real released reservation, not inferred from any one field); redelivery of an already-processed fact causing zero duplication anywhere in the system, defended in depth by four independent guards across two services; a poisoned message reaching the DLQ **and** the partition's offset still committing behind it (the specific property that failed live in Phase 12); and R56's composed-stack trace identity, composed honestly from the best real evidence that exists rather than the technique the brief assumed would still work once built.

**For #8 and #9:** two portable artefacts. (1) **A claim of "N independent redundant layers" is only as strong as the layers you actually turn off one at a time.** This feature's own implementer had already done the honest version of this work — arming all four together and also arming subsets — but the reviewer re-doing it independently, picking its own two layers rather than trusting the implementer's choice of which subsets to report, is what turns "the report says this is redundant" into "the reviewer independently confirmed genuine redundancy on both sides of the process boundary." (2) **A guard built to make one specific violation impossible (`no-write-database-client.spec.ts`'s specifier-resolution check) can be satisfied by a *different* technique that achieves the same forbidden outcome by a path the guard was never built to see** — `mysql-worker-client.ts`'s absolute-path `require()` is safe today only because of where it lives (excluded from the production build graph) and because nothing else uses it yet, not because the guard itself would catch a production file doing the identical thing. Recording that gap explicitly, the moment a pattern like this is introduced, is cheaper than rediscovering it after a future feature reuses the pattern somewhere the exclusion no longer holds.
