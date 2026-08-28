# review_infra_compose_apps_nonroot

**Verdict: APPROVED WITH CONCERNS**

The hardening itself is correct and, on the point most likely to be silently incomplete (`--chown` coverage), it is *provably* complete — I verified it by ownership audit inside the built images, not by reading the Dockerfiles. All seven application containers genuinely run as uid 1000, proven from the host process table. No functional regression.

Two things hold this back from a clean APPROVED: one **factual defect in the progress document** (the stated justification for deviating from `pnpm dc:clean:apps` is wrong — the script is *not* dangerous, and I proved it experimentally), and one **non-blocking hardening gap** (the runtime user owns and can rewrite its own compiled code). Task 2 of the builder's brief is not independently verifiable and is recorded as unverified.

Reviewed against `progress/impl_infra_compose_apps_nonroot.md`, with `progress/impl_infra_compose_apps.md` and `progress/review_infra_compose_apps.md` as the baseline for how the deliverable was originally built and approved.

---

## 1. Scope — clean

```
$ git status --porcelain
 M infra/docker/seed/Dockerfile
 M infra/docker/service/Dockerfile
 M infra/docker/web/Dockerfile
?? progress/impl_infra_compose_apps_nonroot.md

$ git diff --name-only -- docker-compose.apps.yml docker-compose.infra.yml feature_list.json apps packages specs
(empty)
```

Exactly the three Dockerfiles plus the new progress doc. `docker-compose.apps.yml` is genuinely untouched, as is `docker-compose.infra.yml`, `feature_list.json`, and everything under `apps/`, `packages/` and `specs/`. `git diff --stat`: 89 insertions, 21 deletions across the three files — and reading the diff, every one of the 21 deletions is a `COPY` line replaced by the same line with `--chown=node:node` prepended. No unrelated edit rode along.

The claim that `docker-compose.apps.yml` needed no change is verified rather than accepted: `grep -E 'volumes:|user:|read_only|tmpfs|cap_|privileged'` over that file returns **zero matches**. The app services mount no volumes at all, so there is no bind-mount ownership problem to solve and no `user:` directive is required.

## 2. `USER node` in every final stage — complete

| Dockerfile | final stage | `USER node` | line |
|---|---|---|---|
| `infra/docker/service/Dockerfile` | `runtime` (`FROM ... AS runtime`, line 89) | yes | 153 |
| `infra/docker/service/Dockerfile` | `migrate` (**separate** `FROM ... AS migrate`, line 170) | yes | 190 |
| `infra/docker/web/Dockerfile` | `runtime` (line 55) | yes | 77 |
| `infra/docker/seed/Dockerfile` | single stage `build` (line 33) | yes | 77 |

The `migrate` trap the task warned about is genuinely avoided: it is its own `FROM`, `USER` does not inherit across it, and it carries its own line 190 with a comment saying exactly why. In each case `USER` sits **after** every `COPY` in that stage, which is the correct ordering (a `USER` before the copies would leave the trees root-owned and would only fail at first read).

Confirmed against the built artefacts rather than only the source — every one of the 12 application images:

```
otc-billing:local               USER=node    otc-billing-migrate:local        USER=node
otc-fulfillment:local           USER=node    otc-fulfillment-migrate:local    USER=node
otc-gateway:local               USER=node    otc-notifications-migrate:local  USER=node
otc-notifications:local         USER=node    otc-orders-migrate:local         USER=node
otc-orders:local                USER=node    otc-seed:local                   USER=node
otc-projector:local             USER=node    otc-web:local                    USER=node
```

(The two non-application images in the stack were already non-root and are unaffected: `otc-kafka-init:4.3.1` → `USER=appuser`, `otc-otel-collector:0.159.0` → `USER=10001:10001`.)

## 3. `--chown` coverage — genuinely complete, verified by ownership audit not by reading

This was flagged as the most likely real defect, so I did not spot-check the diff — I checked the **result** inside the built images, which catches a missed `COPY` regardless of how the Dockerfile reads.

Line count first: `runtime` has 10 `COPY` instructions (6 from `prod-deps`, 3 from `build`, 1 from the build context for `specs/shared/openapi.yaml`) and all 10 carry `--chown=node:node`; `migrate` has 10 (6 + 3 + `apps/${SERVICE}/drizzle`) and all 10 carry it; `web`'s `runtime` has 1 and it carries it.

The decisive evidence:

```
$ docker run --rm --user 0 --entrypoint sh <img> -c 'find /app -user root | wc -l; find /app -user root'
otc-orders:local          1   → /app
otc-gateway:local         1   → /app
otc-orders-migrate:local  1   → /app
otc-web:local             1   → /app
```

In all four final-stage images the **only** root-owned path under `/app` is `/app` itself — the directory `WORKDIR` creates before any `COPY` runs. Every single file and directory inside it is `node:node`. There is no missed `COPY`, and therefore no root-owned-but-world-readable tree quietly passing the runtime tests. `find /app -user root ! -perm -o+r` and `find /app -user root -type d ! -perm -o+x` both return empty, so `/app` remains traversable.

`/app` staying root-owned is the right outcome, not an oversight: it means the app cannot create new files at its own root. Verified live — `docker exec otc-orders sh -c 'touch /app/PROBE'` → `Permission denied`.

### The seed image is deliberately different — checked, and it is defensible

`infra/docker/seed/Dockerfile` is single-stage, so there is no `COPY --from` to hang `--chown` on; root installs and builds, and `USER node` is the last instruction. The builder discloses this explicitly (Dockerfile lines 63–77). Audited:

```
$ docker run --rm --user 0 --entrypoint sh otc-seed:local -c '...'
root-owned under /app:                              39588
node-owned under /app:                                  0
root-owned AND not world-readable:                  (none)
root-owned dirs not world-executable:               (none)
/app/apps/seed/node_modules/.bin/tsx   -rwxr-xr-x 1 root root
```

So uid 1000 can read and execute everything it needs, and nothing is unreadable. This is **not** the "missed COPY" failure mode — it is a documented whole-image choice, and for a read-only CLI it is the *stronger* posture, because the process cannot modify its own code (see concern C1 below, where the other two images can).

## 4. Independent non-root proof — from the host process table, all seven containers

`docker exec ... id` is circular (it reports the user `exec` was given). `docker top` reads the host's process table for the container's actual PIDs, which is not:

```
$ docker top <c> -o user,uid,pid,cmd
otc-orders         1000 1000 97946  /bin/sh -c node ${APP_DIR}/dist/main.js
                   1000 1000 98108  node apps/orders/dist/main.js
otc-gateway        1000 1000 89421  /bin/sh -c node ${APP_DIR}/dist/main.js
                   1000 1000 89600  node apps/gateway/dist/main.js
otc-web            1000 1000 91505  node .output/server/index.mjs
otc-fulfillment    1000 1000 97935 / 98094   (sh wrapper + node child, both 1000)
otc-billing        1000 1000 97905 / 98073
otc-notifications  1000 1000 97859 / 98052
otc-projector      1000 1000 97857 / 98032
```

Note this covers **both** processes in each service container — the `/bin/sh -c` shell-form `CMD` wrapper *and* the real `node` child. A shell wrapper that dropped privilege only for itself would show a root child here; none does. All seven app containers, including the gateway and web, run entirely as uid 1000.

## 5. Cosmetic-hardening probe

**Build-time root is fine and expected** — `corepack`/pnpm install and `tsc`/`nuxt build` run as root in the `deps`/`build`/`prod-deps` stages, which never ship. Not a finding.

**Privileged ports** — verified: `.env` sets 3001–3006 and `WEB_PORT`, the `DEFAULT_PORT` build args in `docker-compose.apps.yml` agree, and the stack is bound on 3010 for web. All >1024, no `cap_add`, no `privileged`, nothing needed.

**Healthchecks** — both are `node -e "require('http').get('http://localhost:'+p+...)"`. An ordinary TCP connect, no privilege. Empirically confirmed by all seven containers reporting `(healthy)` while running as uid 1000.

**The Nuxt/Nitro writable-directory claim — verified against the file, and it is TRUE.** I read `apps/web/nuxt.config.ts` in full. It declares `compatibilityDate`, `devtools`, `devServer`, `css`, `vite`, `components` and `runtimeConfig` — and **no `nitro` key at all**. No `preset`, no `storage`, no `devStorage`. `runtimeConfig.public` is empty; sessions come from `runtimeConfig.sessionPassword` (nuxt-auth-utils sealed cookies), not a server-side on-disk store. Nothing mounts a filesystem storage driver, so nothing lazily creates `.data/` under the cwd. The claim stands.

**The seed `tsx` transform-cache claim — verified TRUE, executed not assumed:**

```
$ docker run --rm otc-seed:local node_modules/.bin/tsx -e \
    'const a: number = 41; console.log("tsx-ok", a+1, process.getuid(), require("os").tmpdir())'
tsx-ok 42 1000 /tmp
```

TypeScript syntax forces a real esbuild transform, it succeeded as uid 1000, and `os.tmpdir()` is `/tmp` (`drwxrwxrwt`), not `/app`. Corroborated by the negative case: `touch /app/apps/seed/PWN` as uid 1000 → `Permission denied`, while `/tmp` is writable.

### Concern C1 (non-blocking) — the runtime user owns, and can rewrite, its own compiled code

`--chown=node:node` grants uid 1000 **ownership**, and the copied files carry mode 664/775. So in the service and web images the application process can modify the very code it is running. Proven live inside the running container:

```
$ docker exec otc-orders sh -c 'echo x >> /app/apps/orders/dist/main.js'   # succeeded
   /app/apps/orders/dist/main.js   6259 bytes  md5 dec9d72b...   (mutated)
```

I restored it immediately and verified byte-for-byte against the pristine copy in the image:

```
image     6257  bc67687699b6a0eb5ec7895b43520022
container 6257  bc67687699b6a0eb5ec7895b43520022   ← identical, restored
```

`otc-web` behaves the same (`touch /app/.output/server/PROBE` succeeded; removed).

Why it matters: dropping to uid 1000 removes the uid-0 capabilities, which is the main prize and is genuinely achieved. But a compromised process can still overwrite `dist/` or `node_modules/` and persist across a container restart in the writable layer, so the hardening is one notch short of "the app cannot alter itself". The `seed` image, by keeping everything root-owned and world-readable, does **not** have this property — the three images are inconsistent with each other, and the seed one is stricter.

Not a blocker: this is strictly better than the previous state (uid 0 owning everything *and* holding all capabilities), and no requirement asked for an immutable filesystem. Two cheap follow-ups, either one closes it:

- add `read_only: true` (plus a `tmpfs: [/tmp]`) to the seven app services in `docker-compose.apps.yml` — nothing writes to disk at runtime, which the builder already established by grep and which my probes corroborate; or
- drop `--chown` and rely on root-owned/world-readable trees, the seed image's model.

Worth recording because the same three Dockerfiles are the template assessments #8 and #9 will mirror.

## 6. No functional regression — re-derived, not trusted

All six services, hit directly from the host just now:

```
:3001 200 {"status":"up","checks":{"readModel":"up","rpcTransport":"up"}}
:3002 200 {"status":"up","checks":{"writeModel":"up","factStream":"up","rpcTransport":"up"}}
:3003 200 {"status":"up","checks":{"writeModel":"up","rpcTransport":"up"}}
:3004 200 {"status":"up","checks":{"writeModel":"up","rpcTransport":"up"}}
:3005 200 {"status":"up","checks":{"writeModel":"up","factStream":"up"}}
:3006 200 {"status":"up","checks":{"readModel":"up","factStream":"up"}}
```

`:3001` returning 200 also re-proves the original phase-23 Finding 1 survives: the gateway still reads `/app/specs/shared/openapi.yaml` at boot, now through a `--chown`ed copy as uid 1000.

Web: `curl -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost:3010/` → `302 http://localhost:3010/login`. Expected unauthenticated response.

Migration jobs, from `docker inspect` rather than from the doc:

```
otc-orders-migrate         exit=0  finished 2026-08-28T15:22:08.307Z
otc-fulfillment-migrate    exit=0  finished 2026-08-28T15:22:08.306Z
otc-billing-migrate        exit=0  finished 2026-08-28T15:22:08.287Z
otc-notifications-migrate  exit=0  finished 2026-08-28T15:22:08.263Z
otc-kafka-init             exit=0  finished 2026-08-28T15:22:39.786Z
```

Beyond the required list, two real reads through the non-root stack, to prove it does work and not merely health checks:

- `POST /auth/login` (operator) → 208-char bearer token; `GET /orders` → `200`, first item `ORD-000006`, `status: "cancelled"`, `cancellationReason: "credit_rejected"`, `totalAmount: 24999` (minor units, as the convention requires).
- `GET /catalog/products` → `200`, `PRD-0001 … price 24999 EUR` — a **NATS RPC round-trip from the non-root gateway container into the non-root orders container**, returning data the non-root seed job wrote into MySQL.

Stack left exactly as found: 18 `otc-*` containers up plus `otc-sonarqube` still `Up 11 hours (healthy)`. Nothing was brought down and no volume was removed.

## 7. Assessment — the cold-cycle deviation

**Question asked: did removing three volumes achieve an equivalent cold-start proof, or did it leave residue?**

**It achieved an equivalent cold state. Verified independently, three ways.**

1. **The three volumes really were recreated this session.** `docker volume inspect -f '{{.CreatedAt}}'`: `otc_mysql_data`, `otc_mongodb_data`, `otc_kafka_data` all `2026-08-28T15:19:07Z`. By contrast `otc_grafana_data` / `otc_prometheus_data` / `otc_n8n_data` are `2026-08-28T08:00:29Z` and `otc_sonarqube_data` is `2026-08-19T14:17:44Z` — untouched, exactly as claimed.
2. **MySQL genuinely bootstrapped an empty datadir**, from its own logs, which is not something a surviving volume can fake:
   ```
   2026-08-28 17:19:08 [Note] [Entrypoint]: Initializing database files
   2026-08-28T15:19:08 [System] [MY-015017] MySQL Server Initialization - start.
   2026-08-28T15:19:12 [System] [MY-015018] MySQL Server Initialization - end.
   2026-08-28 17:19:12 [Note] [Entrypoint]: Database files initialized
   ```
   The four migrate jobs then exited 0 at 15:22:08 — so they did apply against empty databases, which is precisely where a `--chown` mistake on the `drizzle/` SQL tree would have surfaced.
3. **Kafka was genuinely topic-less.** `docker logs otc-kafka-init` shows it deriving 6 topics from the spec, "Ensuring topic exists" for each, and closing with `OK: all 6 spec-derived Kafka topic(s) verified present on the broker with the correct name, partition count (6) and replication factor (1), and no others`.

**Residue: none that matters.** I checked whether any *other* persistent store escaped the three removals. Reading `docker-compose.infra.yml`, the app-relevant stateful mounts are exactly `mysql_data:/var/lib/mysql`, `mongodb_data:/data/db`, `kafka_data:/var/lib/kafka/data`. **NATS declares no volume at all** (lines 189–205: `command: ["-p","4222","-m","8222"]`, no JetStream file store, no `volumes:` key), so there was no NATS state to wipe. The remaining project volumes (`grafana_data`, `prometheus_data`, `n8n_data`, `sonarqube_*`) hold observability and SonarQube state that no application container reads. So the three removals cover 100% of the app-path persistence.

Independently corroborated by outcome: the seeded data now in the system (`ORD-000006`, the 6-order set) *must* have been written after 15:19:07, because the datadir it lives in did not exist before then.

**Verdict on the deviation: sound. The cold-start proof is real.** But see D1 — the *reason given* for it is not.

## 8. Defect D1 (must be corrected) — `pnpm dc:clean:apps` is **NOT** dangerous, and the doc says it is

`progress/impl_infra_compose_apps_nonroot.md` §"Deviation: how the cold cycle was made cold" states, as established fact, that `pnpm dc:clean:apps` "would have destroyed 11 hours of unrelated SonarQube state", because `down` removes all project-labelled containers "including profile-gated ones" and `-v` removes "every volume declared in the two files, which includes `sonarqube_data`/`sonarqube_logs`/`sonarqube_extensions`".

**That is false on this machine, and I tested it rather than reasoning about it.**

Static evidence first — the sonar-profile volumes are not even in the merged model when the profile is off:

```
$ WEB_PORT=3010 docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml config --volumes
grafana_data  mysql_data  n8n_data  prometheus_data  kafka_data  mongodb_data
```

`sonarqube_data`, `sonarqube_logs` and `sonarqube_extensions` are **absent** — Compose prunes top-level volumes whose only referencing service is profile-gated. `config --services` likewise omits `sonarqube` (22 services listed, none of them SonarQube).

Empirical evidence — since I was forbidden from running `down` against the real stack, I reproduced the exact shape in a throwaway isolated project (`-p rvtest`, its own files in the scratchpad, two services + two top-level volumes, one service `profiles: ["gated"]` with its own volume, plus a second compose file to mirror the two-file invocation):

```
$ docker compose -p rvtest -f a.yml -f b.yml config --volumes
normal_data                                  ← gated_data pruned, same as otc

$ docker compose -p rvtest -f a.yml -f b.yml --profile gated up -d
   rvtest-normalsvc-1, rvtest-gatedsvc-1, rvtest-extrasvc-1 started
   volumes rvtest_normal_data, rvtest_gated_data created

$ docker compose -p rvtest -f a.yml -f b.yml down -v          ← NO --profile, exactly as dc:clean:apps
   Container rvtest-extrasvc-1 Removed
   Container rvtest-normalsvc-1 Removed
   Volume rvtest_normal_data Removed
   Network rvtest_default Resource is still in use

SURVIVORS:  container rvtest-gatedsvc-1   volume rvtest_gated_data
```

The profile-gated container kept **running** and its volume was **not** removed. (The throwaway project was fully cleaned up afterwards with `--profile gated down -v`; the otc stack and SonarQube were never touched — reconfirmed after: 18 `otc-*` containers up, `otc-sonarqube` still up.)

**Answer to the question posed: no, `dc:clean:apps` is not dangerous as written.** Docker Compose here is v5.1.4; `docker volume inspect otc_sonarqube_data` shows it carries `com.docker.compose.project=otc`, but the project label is not what `down -v` iterates — it iterates the *loaded model*, and the sonar profile is off. The single real effect of running `pnpm dc:clean:apps` while SonarQube is up would have been a cosmetic `Network otc-net Resource is still in use` message. There is **no defect in the script committed in `b3c6c5e`**, and no fix is required there.

Why this is nonetheless a defect worth blocking the doc on: it is a confident, specific, unverified technical assertion — complete with cited line numbers — presented in a progress document that is process evidence, and `specs/shared/` plus this harness are reused verbatim by assessments #8 and #9. A false "this script will eat your SonarQube data" claim is exactly the sort of thing that gets copied forward and then designed around. The deviation itself was harmless and the cold state it produced was genuine (§7); it is the stated justification that must be corrected before commit.

The correct phrasing would be something like: *"Chose to remove the three app-state volumes directly rather than `dc:clean:apps`, out of caution about the unrelated SonarQube container. Tested afterwards: `down -v` without `--profile sonar` does not in fact touch profile-gated services or their volumes, so `dc:clean:apps` would have been safe. The surgical removal produced an equivalent cold state for every store the app path uses (MySQL, MongoDB, Kafka; NATS is stateless)."*

## 9. Observation O2 (not a defect) — Task 2 is not independently verifiable, and the timeline is tight

Reconstructing from `docker inspect`:

```
containers Created           2026-08-28T15:19:07Z   (cold up begins)
otc-mysql  StartedAt         2026-08-28T15:19:07Z   RestartCount=0  (continuous since)
otc-orders FinishedAt        2026-08-28T15:20:46Z   ← compose stop, Task 2 begins
otc-web    FinishedAt        2026-08-28T15:20:45Z
otc-orders-migrate Started   2026-08-28T15:22:07Z   ← re-run on the restart
otc-web    StartedAt         2026-08-28T15:22:13Z
otc-orders StartedAt         2026-08-28T15:22:40Z
```

That puts the entire Task 2 exercise — stop seven containers, start three services under `tsc-watch` (a real full `tsc` compile each), boot them, hit three `/health/ready`, two authenticated cross-boundary reads, one 401 check, stop all three, confirm the ports are dead, restart the containers — inside the 15:20:46 → 15:22:07 window, **81 seconds**. Likewise the cold-cycle verification steps 3–7 (six health checks, `pnpm dc:seed`, an authenticated `GET /orders`) fit in the roughly 50 seconds the app containers were first up before being stopped. Both are tight; neither is impossible on a fast machine with parallel compiles, and I am not calling either fabricated — the *durable* evidence for the cold cycle all checks out independently (fresh volumes, MySQL init logs, kafka-init log, migrate exit codes, seeded data that could only have been written after 15:19:07).

But CLI-run processes leave no artefact, so **Task 2 ("infra from compose + apps from the CLI") is recorded as UNVERIFIED by this review**. The builder's own "What was NOT run, honestly" section already scopes it correctly to 3 of 7 services with no write path exercised; I am adding only that I could not corroborate it at all after the fact. It is not part of the security change and does not affect this verdict.

## 10. Traceability / CHECKPOINTS / feature_list.json

Not applicable, same as the parent review: this is an infra-only deliverable, not a `feature_list.json`-tracked feature, has no `specs/<feature>/requirements.md` and therefore no `R<n>` items to map to tests. No `CHECKPOINTS.md` box applies to a change of this shape. Per the task's explicit instruction, `feature_list.json` was not read for modification and `progress/history.md` was not appended — there is no tracked feature to close.

## What must change before this is committed

1. **D1 — correct §"Deviation: how the cold cycle was made cold"** in `progress/impl_infra_compose_apps_nonroot.md`. Remove or reverse the claim that `pnpm dc:clean:apps` would have destroyed the SonarQube container and volumes; it does not, on Compose v5.1.4, and the evidence is in §8 above. The deviation itself needs no undoing — the cold state it produced is verified genuine.

## Optional follow-ups (do not block)

2. **C1** — consider `read_only: true` + `tmpfs: [/tmp]` on the seven app services in `docker-compose.apps.yml`, so a non-root process also cannot rewrite its own `dist/`. This would make the three images consistent (the seed image already has the stricter property) and is the natural completion of this pass.
3. The `.dockerignore` gap and the stale local `.env` (missing `KAFKA_BROKERS`) remain open from the parent review; both are pre-existing and out of scope here.

## Defects found

| # | Severity | Where | What |
|---|---|---|---|
| D1 | Must fix (doc) | `progress/impl_infra_compose_apps_nonroot.md`, §"Deviation: how the cold cycle was made cold" | Asserts as fact that `pnpm dc:clean:apps` would destroy `sonarqube_{data,logs,extensions}` and the SonarQube container. Disproved experimentally: `down -v` without `--profile sonar` leaves profile-gated containers running and their volumes intact. Matters because this harness is copied verbatim into assessments #8 and #9. |
| C1 | Concern (non-blocking) | `infra/docker/service/Dockerfile:111-132`, `infra/docker/web/Dockerfile:59` | `--chown=node:node` + mode 664 lets the runtime user rewrite its own compiled code (demonstrated live on `otc-orders` and `otc-web`, then restored). Non-root is achieved; filesystem immutability is not. |
| O2 | Observation | `progress/impl_infra_compose_apps_nonroot.md`, Task 2 | CLI-mode run leaves no artefact and cannot be corroborated after the fact; container timestamps make the claimed 81-second window tight. Not part of the security change. |

**No defect was found in the hardening change itself.** `USER node` is present in all four final stages, `--chown` coverage is provably complete in every stage that uses it, all seven containers run as uid 1000 including their real `node` children, and the stack is functionally intact.
