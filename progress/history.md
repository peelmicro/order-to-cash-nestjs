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
