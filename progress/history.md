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
