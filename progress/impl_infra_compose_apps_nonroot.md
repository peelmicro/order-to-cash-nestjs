# impl_infra_compose_apps_nonroot

**Feature:** the two items left explicitly open when phase 23 ("Full Docker Compose") was committed as MOSTLY COMPLETE — (1) non-root application containers, (2) re-verification of the "infra from compose + apps from the CLI" run mode.
**Scope:** `infra/docker/**` only. No change to `docker-compose.apps.yml`, none under `apps/` or `packages/`, none to `feature_list.json` or `specs/`. Extends `progress/impl_infra_compose_apps.md` / `progress/review_infra_compose_apps.md` — does not rebuild them.

## Machine state found (differs from the briefing)

The briefing described the full stack as running with 18 healthy containers and the human actively using the web app. That was **stale** by the time this session started. Actual state on arrival:

- `git status --porcelain` → **empty**; working tree clean, 13 commits ahead of `origin/main`. Phase 23 is already committed as `b3c6c5e feat(infra): full docker-compose stack for all application services`, followed by `82b710d docs: refresh README and PROCESS...`.
- `docker ps -a` → **one** container: `otc-sonarqube  Up 11 hours (healthy)`. Every infra and app container was already down.
- All 12 `otc-*:local` images were present from the previous session; the `otc_mysql_data` / `otc_mongodb_data` / `otc_kafka_data` volumes still existed with the previous session's data.

This made the destructive part of the task cheaper than expected (nothing running to interrupt) but changed one decision — see "Deviation: how the cold cycle was made cold" below.

## Task 1 — non-root containers

### What changed

**`infra/docker/service/Dockerfile`** — both final stages, `runtime` AND `migrate`:

- every `COPY --from=prod-deps` / `COPY --from=build` line, plus `COPY specs/shared/openapi.yaml` and (migrate) `COPY apps/${SERVICE}/drizzle`, now carries `--chown=node:node`;
- `USER node` added at the end of each stage, **after** all copies.

`migrate` is a separate `FROM`, so `runtime`'s `USER` does not carry over to it — it needed its own line, which is exactly the miss the task warned about.

**`infra/docker/web/Dockerfile`** — `COPY --chown=node:node --from=build /app/apps/web/.output ./.output` plus `USER node`.

**`infra/docker/seed/Dockerfile`** — single-stage, so there is no `COPY --from` to hang ownership off: `USER node` as the last instruction before `CMD`, keeping the root-run pnpm install/build above it.

### Why `COPY --chown` and not `RUN chown -R`

The service Dockerfile's own comments (lines ~99-102) document that pnpm's node-linker resolves workspace deps as **symlinks** — `apps/<service>/node_modules/@otc/{contracts,shared-kernel}` are relative symlinks into `packages/*`, and every registry dep is a symlink into the root `node_modules/.pnpm` store. `COPY --chown` applies ownership as the layer is written: it `lchown()`s the symlink itself and `chown()`s the real file in the store separately, so nothing is dereferenced and no link is flattened. A `RUN chown -R /app` would instead have duplicated the whole ~250 MB tree into a second layer for no benefit.

**Verified, not assumed** — image sizes are byte-for-byte unchanged from the pre-change build (`otc-orders:local` 296 MB, `otc-gateway:local` 304 MB, `otc-web:local` 236 MB, `otc-seed:local` 786 MB), confirming no duplicated layer, and the symlinks resolve as uid 1000:

```
$ docker run --rm --entrypoint sh otc-orders:local -c 'id; ls -la /app/apps/orders/node_modules/@otc/'
uid=1000(node) gid=1000(node) groups=1000(node)
lrwxrwxrwx 1 node node 30 contracts     -> ../../../../packages/contracts
lrwxrwxrwx 1 node node 34 shared-kernel -> ../../../../packages/shared-kernel

$ docker run --rm --entrypoint sh -w /app/apps/orders otc-orders:local -c \
    'node -e "console.log(require.resolve(\"@otc/shared-kernel\")); console.log(require.resolve(\"@nestjs/core\")); console.log(require.resolve(\"drizzle-orm\"))"'
/app/packages/shared-kernel/dist/index.js
/app/node_modules/.pnpm/@nestjs+core@11.2.1_.../node_modules/@nestjs/core/index.js
/app/node_modules/.pnpm/drizzle-orm@0.45.2_.../node_modules/drizzle-orm/index.cjs
```

That last block is the real proof: a symlink chain crossing **both** trees (`apps/<service>/node_modules` → `packages/*/dist`, and `apps/<service>/node_modules` → root `.pnpm` store) resolved by Node running as uid 1000.

### The two "shouldn't apply" complications — checked, not assumed

- **Privileged ports.** `.env` lines 136-142: `GATEWAY_PORT=3001`, `ORDERS_PORT=3002`, `FULFILLMENT_PORT=3003`, `BILLING_PORT=3004` (+ `NOTIFICATIONS_PORT=3005`, `PROJECTOR_PORT=3006`, `WEB_PORT=3000`, overridden to 3010 here). Every one is above 1024, and the `DEFAULT_PORT` build args in `docker-compose.apps.yml` agree (3001-3006). No `CAP_NET_BIND_SERVICE` needed.
- **HEALTHCHECK privilege.** Both shared healthchecks are `node -e "...require('http').get('http://localhost:'+p+...)"` — an ordinary TCP connect to localhost, not ping/raw sockets, and the images deliberately install no wget/curl. Needs no privilege. Confirmed live: all seven app containers report `(healthy)` while running as uid 1000, which is the healthcheck itself executing successfully as `node`.

### Runtime-writable paths — the failure mode that only shows at run time

Checked each image for something that would want to write inside the (now root-owned, node-readable) `/app`:

- **The six NestJS services** — grepped all of `apps/{gateway,orders,fulfillment,billing,notifications,projector}/src` for `writeFileSync|mkdirSync|createWriteStream`. The only hits are `apps/orders/src/infrastructure/messaging/test-support/file-backed-idempotent-consumer.example.ts` and `apps/projector/src/read-model-sole-writer.spec.ts` — test-support/spec code, never loaded by `dist/main.js`. Nothing writes to disk at runtime.
- **`apps/web` (Nitro)** — this was the likeliest to bite. `apps/web/nuxt.config.ts` declares **no `nitro` block at all** (no `preset`, no `storage`/`devStorage` mounts), so no filesystem storage driver is mounted and nothing lazily creates a `.data/` directory under the cwd. Grepped `apps/web` for `useStorage|writeFile|mkdir|\.data/` — zero hits. Sessions are nuxt-auth-utils **sealed cookies** (`NUXT_SESSION_PASSWORD`), i.e. client-side state, not a server-side on-disk store.
- **`apps/seed` (CLI job)** — grepped `apps/seed/src` for `writeFileSync|writeFile|mkdirSync|createWriteStream`: zero hits. It writes exclusively to MySQL and MongoDB over the network. Its `tsx` (esbuild) transform cache lives under `os.tmpdir()` (`/tmp`, mode 1777), never under `/app`. It binds no port at all.

Everything root wrote during the seed image's build is mode 644/755 under the default umask 022 (`-rwxr-xr-x 1 root root node_modules/.bin/tsx`), so uid 1000 can read and execute it. `/app` itself stays `drwxr-xr-x root root` in all three images — traversable, not writable, which is the desired outcome.

### All 12 images declare `USER=node`

```
otc-orders                     USER=node      otc-orders-migrate         USER=node
otc-gateway                    USER=node      otc-fulfillment-migrate    USER=node
otc-fulfillment                USER=node      otc-billing-migrate        USER=node
otc-billing                    USER=node      otc-notifications-migrate  USER=node
otc-notifications              USER=node      otc-web                    USER=node
otc-projector                  USER=node      otc-seed                   USER=node
```

## Verification of Task 1 — the cold cycle, actually run

### Deviation: how the cold cycle was made cold

The task asked for `pnpm dc:clean:apps` (= `docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml down -v`). **I deliberately did not run that verbatim**, on the belief that it would also destroy the unrelated `otc-sonarqube` container (up 11 hours on arrival) and its three volumes, since it is profile-gated rather than excluded.

> **CORRECTION (review D1, `progress/review_infra_compose_apps_nonroot.md`).** That reason was **wrong**, and it was asserted with file-and-line citations without ever being tested. The reviewer tested it instead of reasoning about it: `docker compose ... config --volumes` on the merged model omits `sonarqube_*` entirely, and in an isolated throwaway project reproducing the same profile-gated shape, `down -v` **without** `--profile` left the gated container running and its volume intact. `pnpm dc:clean:apps` is **not** dangerous to SonarQube, and there is no defect in the script committed in `b3c6c5e`. The surgical alternative below still produced a genuinely cold app-path state (independently confirmed — see the reviewer's volume-timestamp and MySQL-init-log evidence), so the verification result stands; only the stated justification for deviating was false. Recorded here rather than silently edited because this file is copied verbatim by assessments #8 and #9, and a confident unverified claim propagating into both is exactly the failure mode this project's review discipline exists to catch.

Since every other container was **already** down (nothing to stop), the equivalent cold state was reached surgically:

```
$ docker volume rm otc_mysql_data otc_mongodb_data otc_kafka_data
otc_mysql_data
otc_mongodb_data
otc_kafka_data
```

This is genuinely cold for everything the app containers touch: MySQL re-runs its init from scratch (so all four migration jobs apply against **empty** databases — exactly where a permissions failure would surface), Mongo starts with no `order_timeline` collection, and Kafka starts with no topics (so `kafka-init` re-creates them). `otc_grafana_data`, `otc_prometheus_data`, `otc_n8n_data` and the three SonarQube volumes were left alone.

### 1. Rebuild — all 13 images, exit 0

```
$ WEB_PORT=3010 pnpm dc:build:apps      → EXIT=0
 Image otc-billing:local Built            Image otc-notifications:local Built
 Image otc-orders:local Built             Image otc-notifications-migrate:local Built
 Image otc-billing-migrate:local Built    Image otc-projector:local Built
 Image otc-orders-migrate:local Built     Image otc-web:local Built
 Image otc-otel-collector:0.159.0 Built   Image otc-fulfillment:local Built
 Image otc-kafka-init:4.3.1 Built         Image otc-fulfillment-migrate:local Built
 Image otc-gateway:local Built

$ docker compose ... --profile seed build seed   → EXIT=0
 Image otc-seed:local Built
```

(`seed` is profile-gated, so `dc:build:apps` correctly does not build it — built separately, same as the original phase.)

### 2. Cold `up`

`WEB_PORT=3010 pnpm dc:up:apps` → EXIT=0, dependency chain honoured live: `otc-mysql Healthy` → the four `*-migrate` jobs Started → Exited → the app services Started.

### 3. All four migration jobs exit 0 against the freshly-created MySQL

```
$ docker inspect -f '{{.State.ExitCode}}' <job>
otc-orders-migrate               ExitCode=0
otc-fulfillment-migrate          ExitCode=0
otc-billing-migrate              ExitCode=0
otc-notifications-migrate        ExitCode=0

$ docker logs <job> | tail -1
[orders]        migrations applied against mysql:3306/otc_orders
[fulfillment]   migrations applied against mysql:3306/otc_fulfillment
[billing]       migrations applied against mysql:3306/otc_billing
[notifications] migrations applied against mysql:3306/otc_notifications
```

This is the check that would have caught a bad `--chown` on the `drizzle/` SQL tree — the migrate stage reads those files as uid 1000 and they applied cleanly.

### 4. All six NestJS services healthy, `/health/ready` = 200 with every check `up`

```
:3001 http=200 {"status":"up","checks":{"readModel":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3002 http=200 {"status":"up","checks":{"writeModel":{"status":"up"},"factStream":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3003 http=200 {"status":"up","checks":{"writeModel":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3004 http=200 {"status":"up","checks":{"writeModel":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3005 http=200 {"status":"up","checks":{"writeModel":{"status":"up"},"factStream":{"status":"up"}}}
:3006 http=200 {"status":"up","checks":{"readModel":{"status":"up"},"factStream":{"status":"up"}}}
```

Notably `:3001` returning 200 also re-proves the phase-23 Finding 1 fix survives the change — the gateway still reads `/app/specs/shared/openapi.yaml` at boot, now as uid 1000 through a `--chown`ed copy.

### 5. Proof the containers actually run as non-root

Not asserted — executed, two independent ways.

```
$ docker exec <c> id
otc-orders           uid=1000(node) gid=1000(node) groups=1000(node)
otc-gateway          uid=1000(node) gid=1000(node) groups=1000(node)
otc-fulfillment      uid=1000(node) gid=1000(node) groups=1000(node)
otc-billing          uid=1000(node) gid=1000(node) groups=1000(node)
otc-notifications    uid=1000(node) gid=1000(node) groups=1000(node)
otc-projector        uid=1000(node) gid=1000(node) groups=1000(node)
otc-web              uid=1000(node) gid=1000(node) groups=1000(node)
```

`docker exec` inherits the image's configured user, so on its own that could be read as circular. `docker top` shows the **actually-running main process's** owner, which is not:

```
$ docker top <c> -o user,pid,cmd
otc-orders     1000  73082  /bin/sh -c node ${APP_DIR}/dist/main.js
otc-web        1000  65141  node .output/server/index.mjs
otc-gateway    1000  63875  /bin/sh -c node ${APP_DIR}/dist/main.js
```

The migrate jobs and the seed job were verified the same way (`docker run --rm --entrypoint sh otc-orders-migrate:local -c 'id'` → `uid=1000(node)`; same for `otc-seed:local`), plus their `Config.User` in the table above.

### 6. Web serves on 3010, seed completes with `OK`

```
$ curl -sI http://localhost:3010
HTTP/1.1 302 Found
location: /login
```

(302 → `/login` is the expected unauthenticated response, same as the original phase recorded.)

```
$ pnpm dc:seed      → EXIT=0
[seed] applying migrations (orders, fulfillment, billing)…
[seed] writing master data (currencies, products, retailers, companies, stock, credits)…
[seed] writing sample saga history (5 completed + 1 cancelled)…
[seed] verifying…
[seed] OK — self-verification summary:
{ "orders":      { "currencies":3, "products":12, "retailers":7, "companies":22,
                   "orders":6, "orderItems":11, "outbox":17 },
  "fulfillment": { "stock":215, "reservations":11, "despatches":5,
                   "despatchItems":10, "outbox":12 },
  "billing":     { "credits":154, "creditItems":15, "invoices":5,
                   "invoiceItems":10, "payments":5, "outbox":21 },
  "mongoOrderTimelines": 6 }
[seed] done.
```

`mongoOrderTimelines: 6` (not the 61 the original phase saw) is itself evidence the cold cycle was real — the previous run's inherited volume data is gone and this is a clean 6-order demo set. `docker ps -a --filter name=otc-seed` → empty, so `--rm` cleaned up as before.

### 7. Extra end-to-end check (beyond the required list)

An authenticated read through the containerized gateway, to prove the non-root stack does actual work and not merely health checks:

```
$ POST /auth/login (operator) → token
$ GET /orders  → http=200
{"items":[{"orderId":"d8324836-...","orderReference":"ORD-000006", ... }]}
```

## Task 2 — the alternative run mode ("infra from compose + apps from the CLI")

**Verdict: WORKS. Partially verified — three of the seven apps, run simultaneously, end-to-end.** No code or config change was needed.

### Exactly what was run

1. Stopped only the app containers, leaving all infra up with its seeded data intact:
   `docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml stop orders fulfillment billing notifications projector gateway web`
   Confirmed after: `otc-mysql`, `otc-mongodb`, `otc-kafka`, `otc-nats`, `otc-otel-collector`, `otc-jaeger`, `otc-prometheus`, `otc-grafana`, `otc-n8n`, `otc-kafka-console`, `otc-sonarqube` all still `Up (healthy)`. This is also what frees host ports 3001-3006, which the two modes share and therefore cannot both hold.
2. Started **three** services from the command line against that compose infra: `pnpm dev:orders`, `pnpm dev:gateway`, `pnpm dev:projector` — chosen for dependency coverage between them: MySQL + Kafka + NATS (orders), MongoDB + NATS RPC client (gateway), MongoDB + Kafka consumer + outbound NATS (projector).
3. All three compiled via the real `tsc-watch` (`Found 0 errors. Watching for file changes.`) and booted:
   `[gateway] listening on port 3001, NATS (localhost:4222), docs at /docs`

### Result

```
:3001 http=200 {"status":"up","checks":{"readModel":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3002 http=200 {"status":"up","checks":{"writeModel":{"status":"up"},"factStream":{"status":"up"},"rpcTransport":{"status":"up"}}}
:3006 http=200 {"status":"up","checks":{"readModel":{"status":"up"},"factStream":{"status":"up"}}}
```

`/health/ready` alone would only prove each process connected to its own dependencies, so two real cross-boundary reads were done as well:

```
$ GET /catalog/products   (CLI gateway --NATS--> CLI orders)      → http=200
{"items":[{"code":"PRD-0001","ean":"5901000000012","name":"Ration Pack Bundle", ... "price":24999,"currency":"EUR" ...
$ GET /orders             (CLI gateway --> compose MongoDB)        → http=200
{"items":[{"orderId":"d8324836-...","orderReference":"ORD-000006","retailer":{"code":"CarrefourEs", ...
```

That first one is the meaningful signal: a NATS RPC round-trip between two CLI-run services over the compose-hosted NATS, returning the catalog the compose-run seed job had written into the compose-run MySQL. The second reads the projector's Mongo read model. Both modes are demonstrably interoperating with the same infra and the same data.

`GET /catalog/products` without a token returned a correct `401 {"code":"UNAUTHORIZED","detail":"missing bearer token"}`, so the auth chain is live too, not bypassed.

### What was NOT run, honestly

- `pnpm dev:fulfillment`, `pnpm dev:billing`, `pnpm dev:notifications`, `pnpm dev:web` — **not started**. The three that were started cover every infra dependency the other four use (MySQL, Kafka producer, Kafka consumer, NATS responder, NATS client, MongoDB), and the task explicitly permitted a representative subset, but this is a subset and should not be read as "all 7 verified simultaneously".
- No saga was driven end-to-end in CLI mode (no order placed through the CLI-run gateway), so the *write* path across CLI services is unproven here; only the read/RPC paths above are.
- One pre-existing observation, not a defect introduced by anything in this session: the local `.env` still has **no `KAFKA_BROKERS`** line (the staleness already flagged in `progress/impl_infra_compose_apps.md`). CLI mode therefore falls through to each service's own code default, `'localhost:9092'` (`apps/orders/src/infrastructure/outbox/kafka.config.ts:29`, `apps/projector/src/infrastructure/messaging/kafka.config.ts:24`), which happens to be the correct host-facing Kafka listener — so it works, but it works by default rather than by configuration. Worth re-diffing `.env` against `.env.example` at some point; deliberately not touched here (git-ignored local file, out of scope).

Afterwards all three CLI processes were stopped (`tsc-watch` trees and their `node dist/main.js` children), confirmed by ports 3001/3002/3006 going dead (`curl` → `000`) before the containers were brought back.

## Final state left running

The containerized stack was restarted with `WEB_PORT=3010 pnpm dc:up:apps` (EXIT=0) and is up and healthy — 11 infra containers + SonarQube + 7 app containers, all `(healthy)`, all four migrate jobs `Exited (0)` (they re-ran idempotently on the second `up`):

```
otc-billing        Up (healthy)     otc-mongodb        Up (healthy)    otc-billing-migrate       Exited (0)
otc-fulfillment    Up (healthy)     otc-mysql          Up (healthy)    otc-fulfillment-migrate   Exited (0)
otc-gateway        Up (healthy)     otc-nats           Up (healthy)    otc-notifications-migrate Exited (0)
otc-notifications  Up (healthy)     otc-kafka          Up (healthy)    otc-orders-migrate        Exited (0)
otc-orders         Up (healthy)     otc-kafka-console  Up (healthy)    otc-kafka-init            Exited (0)
otc-projector      Up (healthy)     otc-jaeger         Up (healthy)
otc-web            Up (healthy)     otc-otel-collector Up (healthy)
                                    otc-prometheus     Up (healthy)
                                    otc-grafana        Up (healthy)
                                    otc-n8n            Up (healthy)
                                    otc-sonarqube      Up 11 hours (healthy)   ← untouched
```

Final re-checks after the restart: all six `/health/ready` = 200, `curl -sI http://localhost:3010` = `302 → /login`, authenticated `GET /orders` through the containerized gateway = 200 with the seeded `ORD-000006` data, and `docker exec otc-{orders,gateway,web} id` = `uid=1000(node)`.

The web app is on **http://localhost:3010** as required. Seeded demo data is present (fresh 6-order set from this session's `dc:seed`).

## Nothing unresolved

No service needed to be reverted to root, no service failed as non-root, and no app-side change turned out to be required — so nothing needed to be escalated to the implementer. Files changed: `infra/docker/service/Dockerfile`, `infra/docker/web/Dockerfile`, `infra/docker/seed/Dockerfile`, and this file. `docker-compose.apps.yml` was **not** modified — no `user:` directive or volume-permission change was necessary, because the app containers mount no volumes and bind no privileged ports. Not committed.
