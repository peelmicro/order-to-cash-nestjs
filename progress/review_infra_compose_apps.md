# review_infra_compose_apps

**Deliverable:** `docker-compose.apps.yml` + `infra/docker/{service,web,seed}/Dockerfile` — README phase 23
("Full Docker Compose"). Not `feature_list.json`-tracked; no `specs/<feature>/` expected or checked.

**Verdict: APPROVED**

## What I re-derived independently (not just re-read from `progress/impl_infra_compose_apps.md`)

### 1. Scope discipline

`git status --porcelain` at review time shows a large amount of dirty/untracked state under `apps/`
(`apps/orders/src/application/...`, `apps/orders/src/infrastructure/saga/...`, `apps/fulfillment/src/infrastructure/outbox/create-kafka-client.ts`),
plus `feature_list.json`, `progress/history.md`, `specs/order_saga_orchestrator/design.md`, and new
`progress/impl_orders_saga_terminal_rejection.md` / `progress/review_orders_saga_terminal_rejection.md`.

**This is not the infra builder's doing.** I checked content and provenance:
- The changed `apps/orders`/`apps/fulfillment` files are all saga-command-store / NATS-saga-command-adapter code
  (`saga-command-dispatcher.ts`, `nats-saga-commands.adapter.ts`, `saga-commands.port.ts`, ...) — semantically
  unrelated to Docker/compose/build.
- `git log --oneline` shows the prior commit for that area is `feat(orders): saga end-to-end verification...`,
  and the new untracked `progress/impl_orders_saga_terminal_rejection.md` / `review_orders_saga_terminal_rejection.md`
  plus the `feature_list.json` diff (`git diff --stat` confirms exactly `feature_list.json | 2 +-`) are self-consistent
  with a **separate, concurrent `orders_saga_terminal_rejection` feature session**, not this infra deliverable.
- The infra deliverable's own footprint is exactly: `docker-compose.apps.yml` (new), `infra/docker/` (new, entirely),
  `progress/impl_infra_compose_apps.md` (new), plus `package.json` (`dc:*` script additions) and `README.md`
  (phase 23 row + new section) — both explicitly permitted (docs/compose territory, not `apps/`/`packages/`).
- **Zero lines changed under `apps/*/src` or `packages/*` attributable to this deliverable.** Confirmed by content
  review (no Dockerfile/compose-related string appears in any of the dirty `apps/orders`/`apps/fulfillment` files)
  and by the `apps/web` changes present in `git status` at the *start* of my session already (pre-existing `web_app`
  work, per the initial gitStatus snapshot handed to me) — none of it new since this deliverable's completion.

I'm flagging this concurrent-session noise explicitly rather than silently absorbing it into my verdict, since a
naive `git status --porcelain | grep apps/` check alone would have produced a false positive here.

### 2. DI-tokens / real-`tsc`-build property — verified precisely, this is the property that matters most

Read `infra/docker/service/Dockerfile`'s `build` stage directly: `RUN pnpm --filter "@otc/${SERVICE}..." run build`.
Independently checked each of the six services' own `package.json` (not trusting the Dockerfile's comment):

```
apps/gateway/package.json:        "build": "tsc -p tsconfig.build.json"
apps/orders/package.json:         "build": "tsc -p tsconfig.build.json"
apps/fulfillment/package.json:    "build": "tsc -p tsconfig.build.json"
apps/billing/package.json:        "build": "tsc -p tsconfig.build.json"
apps/notifications/package.json:  "build": "tsc -p tsconfig.build.json"
apps/projector/package.json:      "build": "tsc -p tsconfig.build.json"
```

`apps/orders/tsconfig.build.json` extends the app's own `tsconfig.json` (which in turn extends `tsconfig.base.json`,
which sets `emitDecoratorMetadata: true`) — confirmed the chain is real, not aliased away. The `runtime` stage's
`CMD` is `node ${APP_DIR}/dist/main.js` — plain Node against the compiled `dist/`, never `tsx`/esbuild, never
`ts-node`. `apps/seed`'s Dockerfile correctly diverges (`node_modules/.bin/tsx src/index.ts`) but this is
CLAUDE.md's own explicit, named carve-out for that one plain-script app with no DI container — not an oversight.
**This property holds exactly as documented and is the correct thing to have verified most carefully.**

### 3. Workspace build correctness

- `packages/shared-kernel` and `packages/contracts` are `COPY`'d and built (`RUN pnpm --filter "@otc/${SERVICE}..." run build`,
  where the trailing `...` pulls in workspace deps) in the `build` stage **before** the runtime stage copies their
  `dist/` output — stage order in the Dockerfile is `deps → build → prod-deps → runtime`/`migrate`, confirmed by
  reading top to bottom; the `runtime` stage's `COPY --from=build .../dist` lines only reference the already-built
  `build` stage.
- `context: .` (repo root) confirmed for every service block in `docker-compose.apps.yml` — none use a per-app
  subdirectory context. Re-ran `docker compose ... config` myself (see §7) and the rendered `build.context` for
  `orders` resolves to the repo root absolute path, not `apps/orders`.

### 4. The two "found by booting" fixes

- **Finding 1 (gateway openapi.yaml):** read `apps/gateway/src/presentation/setup-docs.ts` directly —
  `path.resolve(__dirname, '../../../../specs/shared/openapi.yaml')`. Compiled to
  `apps/gateway/dist/presentation/setup-docs.js`, `__dirname` = `/app/apps/gateway/dist/presentation` inside the
  image; four `../` levels resolves to `/app`, so the runtime reads `/app/specs/shared/openapi.yaml` — which is
  exactly the Dockerfile's `COPY specs/shared/openapi.yaml ./specs/shared/openapi.yaml` destination (relative to
  `WORKDIR /app`). Path match confirmed precisely, not just plausibly. Grep of other services for the same
  `__dirname`-into-`specs/` pattern confirms it's unique to gateway, so the unconditional (shared-Dockerfile) COPY
  is a reasonable, low-cost simplification rather than an unnecessary exposure.
- **Finding 2 (seed cross-app source import):** `infra/docker/seed/Dockerfile` copies and installs
  `apps/orders`, `apps/fulfillment`, `apps/billing` in full (source + their own filtered `node_modules`), not a
  narrower subset. This is structurally required — `apps/seed/src/writers/*.writer.ts` import those three apps'
  `src/infrastructure/persistence/{migrator,schema}` directly (a pre-existing repo shape, confirmed by the
  Dockerfile's own comment and independently plausible given `apps/seed`'s stated purpose). No secrets are baked
  into the image at build time (DB credentials, JWT secret, Mailtrap creds are all supplied via `env_file: [.env]`
  at **container start**, never as a build ARG or COPY'd `.env`), so copying those three apps' full source is a
  size/hygiene concern (786 MB image, already flagged by the builder) rather than a secret-leak concern.

### 5. Internal networking env overrides — verified against the *running* containers, not just the compose file

Rather than only reading YAML, I queried the actually-running containers (still up from the builder's session)
directly with `docker exec ... env`:

```
otc-orders:  KAFKA_BROKERS=kafka:29092   NATS_URL=nats://nats:4222   ORDERS_DB_HOST=mysql
otc-gateway: MONGO_HOST=mongodb          NATS_URL=nats://nats:4222  (no KAFKA_BROKERS override — correct, gateway has no Kafka consumer)
otc-web:     NUXT_GATEWAY_BASE_URL=http://gateway:3001   PORT=3010 (session override, see §6)
```

`kafka:29092` matches `docker-compose.infra.yml`'s `PLAINTEXT` (internal, container-to-container) listener exactly
— `KAFKA_LISTENERS: "PLAINTEXT://:${KAFKA_INTERNAL_PORT:-29092}, ... EXTERNAL://:9092"`. The apps file did **not**
swap internal/external ports; `9092` (external/host) never appears anywhere in `docker-compose.apps.yml`.
`docker exec otc-orders node -e "console.log(process.env.KAFKA_BROKERS)"` printed `kafka:29092`, confirming the
value is what the running Node process actually reads, not just what's declared.

### 6. Dependency ordering

Confirmed live, not just by reading YAML: `docker inspect otc-orders-migrate --format 'ExitCode={{.State.ExitCode}}'`
→ `0`; `otc-notifications-migrate` → `0` also. `grep -c condition: docker-compose.apps.yml` shows every app service
pairs a `service_completed_successfully` (its own `-migrate` job, and `kafka-init` for Kafka-consuming services) with
a `service_healthy` (its live infra deps) — `gateway` and `web` correctly have no `kafka-init`/`-migrate` dependency
(gateway owns no MySQL DB and no Kafka consumer; web talks only to gateway). `notifications` correctly omits a
`nats: condition: service_healthy` dependency, matching the confirmed absence of any NATS transport in
`apps/notifications/src/main.ts` (grepped directly, zero hits for `Nats`/`nats`).

### 7. Live re-verification — partial, and here is exactly what was live vs. static

The full stack was still running from the builder's own session (`docker ps -a` showed 7 app containers `Up ...
(healthy)` plus all migration jobs `Exited (0)`). I did **not** rebuild or bring anything up myself — everything
below queried the already-running system directly, which is a stronger check than re-reading a transcript:

- `docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml config` — ran it myself, exits clean,
  `orders` build context resolves to the repo root absolute path as expected.
- `docker compose ... --profile seed config --services | grep -w seed` → present; plain `config --services`
  (no `--profile`) → **absent**. Confirms the profile gate is real, not just a comment.
- Hit all six backend `/health/ready` endpoints myself: all `http=200`, all checks `up`
  (gateway: `readModel`/`rpcTransport`; orders: `writeModel`/`factStream`/`rpcTransport`; fulfillment/billing:
  `writeModel`/`rpcTransport`; notifications: `writeModel`/`factStream`; projector: `readModel`/`factStream`).
- Hit `web` on the session's overridden port 3010 (host port 3000 was occupied at build time, per the builder's
  documented caveat — I confirmed this independently: `docker port otc-web` shows `3010/tcp -> 0.0.0.0:3010`,
  and `docker exec otc-web env` shows `PORT=3010`, consistent with the claimed cause, not a hidden defect in the
  compose file's own `${WEB_PORT:-3000}` default).
- `docker exec` into `otc-orders`/`otc-gateway`/`otc-web` for real environment values (§5).
- Confirmed no stray `otc-seed*` container present (`docker ps -a --filter name=otc-seed` → empty).

**What I did not do:** a full rebuild-from-scratch or a `down -v && up -d` cold-start cycle, and I did not re-run
the seed job myself (it already ran to completion once, per the builder's report, and re-running it live risks
polluting the MySQL/Mongo volumes further for no additional signal beyond what `docker compose --profile seed
config` already proves about its gating). I consider this an acceptable trade — the live signal I *did* gather
(real running containers, real `docker exec` env values, real `/health/ready` bodies, real exit codes) is stronger
per-item than a rebuild would have been, at lower cost/risk than tearing down and reconstructing a stack I did not
start.

I did not bring anything up or down myself, so there is nothing for me to tear down under the task's own
"if you bring anything up, tear it down" instruction — I left the pre-existing state exactly as I found it.

### 8. `seed` job containment

Confirmed twice, independently: (a) static — `profiles: ["seed"]` on the `seed` service block in
`docker-compose.apps.yml`; (b) live — `docker compose config --services` (no profile flag) excludes `seed` from
the rendered service list; only `--profile seed config --services` includes it. `docker ps -a` shows no
`otc-seed*` container currently present. This satisfies the "no footgun" concern.

## Minor observations (not blocking)

- No root `.dockerignore`. Every `COPY` in all three Dockerfiles is an explicit path (never `COPY . .`), so nothing
  unintended lands *inside* an image — but the full repo tree (including `.git/`, `node_modules/`, `.env`) is still
  sent to the Docker build context on every build, which is a build-time performance cost, not a security or
  correctness defect (nothing from that context is copied into the final images beyond what's explicitly named,
  and no `.env`/secret is ever baked in — confirmed all credentials arrive via `env_file: [.env]` at container
  start). Worth a follow-up `.dockerignore` for build speed, not a review blocker.
- `apps/seed`'s runtime image (786 MB, full dev install) is explicitly flagged by the builder as unoptimized; agreed
  this is acceptable for a one-off CLI never left running.
- The stale local `.env` / `NUXT_SESSION_PASSWORD` fallback situation is a pre-existing environment gap (missing
  vars added in later phases), not something this deliverable should have fixed — the compose-level `${VAR:-default}`
  fallback the builder added is the correct mitigation and I confirmed live it actually degrades to the documented
  default rather than an empty string.

## Traceability / CHECKPOINTS

Not applicable — this deliverable is infra/compose-only, not a `feature_list.json`-tracked feature, and carries no
`specs/<feature>/requirements.md` with `R<n>` items to trace, per the task's own explicit framing. No
`CHECKPOINTS.md` boxes apply to a non-feature infra deliverable of this shape.

## feature_list.json / progress/history.md

Not touched, per instructions — this is not a tracked feature.

## Defects found

None. Every claim in `progress/impl_infra_compose_apps.md` that I attempted to independently re-derive (rather
than just re-read) checked out: the `tsc`-not-`tsx` build property, workspace build ordering, `context: .`,
internal vs. external Kafka listener, the two "found by booting" fixes' exact file/path correctness, dependency
gating, and seed-profile containment.
