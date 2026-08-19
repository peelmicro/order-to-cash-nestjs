# review_infra_compose

**Feature:** `infra_compose` (id 4, phase 4) — `sdd: false`
**Reviewer:** reviewer agent
**Date:** 2026-08-19
**Verdict: REJECTED** — 2 blocking defects, 5 minor. Status returned to `in_progress`.

The stack really is up and really is healthy; the acceptance list in
`feature_list.json` is genuinely met. It is rejected on two of the *hard
constraints* the implementer was given, both of which the report asserts as
satisfied and neither of which is: **Kafka persists nothing** (constraint 7) and
**the SonarQube healthcheck does not test readiness** (constraint 6). Both were
found by probing, not by reading.

The stack is left running (ten default services, SonarQube removed).

---

## 1. Verdict on the flagged deviation: `infra/otel-collector/Dockerfile` — ACCEPTED

I verified the premise rather than taking it on trust:

```
$ docker run --rm --entrypoint="" otel/opentelemetry-collector-contrib:0.159.0 /bin/sh -c "echo has-sh"
docker: Error response from daemon: ... exec: "/bin/sh": stat /bin/sh: no such file or directory

$ docker image inspect otel/opentelemetry-collector-contrib:0.159.0 \
    --format '{{json .Config.Entrypoint}} {{json .Config.Healthcheck}} user={{.Config.User}}'
["/otelcol-contrib"] null user=10001:10001
```

The image is distroless, has no shell, no `wget`, no `curl`, ships no upstream
`HEALTHCHECK` and its only executable is `/otelcol-contrib`, which has no health
subcommand. **The reasoning is sound.**

Is it minimal? Yes — two lines, one `COPY` layer, 1.21 MB:

```
$ docker image history otc-otel-collector:0.159.0 --no-trunc --format '{{.CreatedBy}}\t{{.Size}}'
COPY /bin/busybox /bin/busybox # buildkit	1.21MB
EXPOSE [4317/tcp 4318/tcp 55679/tcp]	0B
ENTRYPOINT ["/otelcol-contrib"]	0B
```

The collector binary, its entrypoint and its config are untouched.

Does it undermine the exact-pinning property #8 and #9 depend on? **No.** Both
`FROM otel/opentelemetry-collector-contrib:0.159.0` and
`COPY --from=busybox:1.36.1-musl` are exact tags, so the build is as reproducible
as a pull, and the two-line Dockerfile ports verbatim to the other two
assessments. The thing that *does* need pinning discipline is the local tag —
see defect D4.

Simpler alternatives I checked and reject:
- `CMD-SHELL` — impossible, no shell (proved above).
- Probe via `/otelcol-contrib` — no health subcommand exists.
- Bind-mount a host `wget` — host-architecture dependent, strictly worse.
- Drop the collector's healthcheck and gate Prometheus on `service_started`,
  using the scrape target as the readiness signal — this is the one genuine
  alternative, and it is the one the implementer named and rejected. It
  violates hard constraint 6 outright, so rejecting it was correct.

**This deviation is approved and should stay.** It is not a reason for the
rejection.

---

## 2. CHECKPOINTS walked

C3, C4, C6 do not apply — no application code exists at phase 4. C7's spec/n8n
boxes do not apply yet.

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model (`init.sh` §2 confirms: implementer=sonnet, test_maintainer=haiku, three documented as deliberately unpinned).
- [x] `./init.sh` exits 0 — re-run by me, `exit=0`.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero `in_progress`, one `in_review` (this feature). Counter: `{'pending': 34, 'done': 3, 'in_review': 1}`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — features 1–3 are bootstrap/harness/spec; verification is `init.sh` + the AsyncAPI/OpenAPI validators recorded in `history.md`. No test suite is due until phase 5.
- [ ] **`progress/current.md` describes the active session** — **FAILS.** It still reads `**Feature:** — none active —`, `**Status:** idle`, and *"Next up: feature `infra_compose`"*. That is a leftover from the session that finished `shared_spec`; `infra_compose` has since been built and submitted for review. See defect D7.
- [x] Every `blocked` feature records why it is blocked — none blocked.

### C5 — The session closed cleanly
- [x] No suspicious untracked files. `git status --porcelain` shows exactly the feature's own additions: `docker-compose.infra.yml`, `infra/`, `package.json`, `.env.example`, `progress/impl_infra_compose.md`, and the modified `feature_list.json`. No build output, no `*.tmp`. `.env` is correctly ignored (`git check-ignore -v .env` → `.gitignore:30:.env`) and appears in no tracked path (`git ls-files | grep .env` → empty).
- [ ] **`progress/history.md` has an entry for the feature just finished, including its effort record** — **not present.** This is the expected state on rejection (the entry is written at approval), so it is not itself a defect, but the box is empty and the feature therefore cannot close.
- [x] `feature_list.json` reflects the true state of every feature touched — was `in_review`, correct at submission; I have now set it back to `in_progress`.
- [x] The human has been told what was done and how to test it manually — `progress/impl_infra_compose.md` §"Verification" doubles as a runnable manual-test recipe. (Weakened by D7: `current.md` contradicts it.)
- [x] **Claude did not commit.** `git log --oneline -5` head is still `cf795db docs(spec): ...` from the previous feature. No commit, no push.

---

## 3. Acceptance list from `feature_list.json` — all four met

| Acceptance criterion | Result | Evidence |
|---|---|---|
| all infra containers healthy | **PASS** | 10/10 default services `Up (healthy)`; SonarQube reached `healthy` under `--profile sonar` |
| three MySQL databases created by init script | **PASS** (four, as instructed) | `SHOW DATABASES` → `otc_orders`, `otc_fulfillment`, `otc_billing`, `n8n` |
| NATS runs core-only (no JetStream) | **PASS** | `/jsz` → `"disabled": true`; startup log has no JetStream line |
| `.env.example` complete | **PASS** | every `${VAR}` in the compose file has a key in `.env.example`; zero missing |

The rejection is **not** on the acceptance list. It is on hard constraints 6 and 7.

---

## 4. Independent verification performed (real output)

### 4.1 Stack state — confirmed, not taken on trust
```
$ docker compose -f docker-compose.infra.yml ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
otc-grafana         grafana/grafana:13.2.0                Up (healthy)
otc-jaeger          jaegertracing/jaeger:2.20.0           Up (healthy)
otc-kafka           apache/kafka:4.3.1                    Up (healthy)
otc-kafka-console   redpandadata/console:v3.10.0          Up (healthy)
otc-mongodb         mongo:8.3.8                           Up (healthy)
otc-mysql           mysql:8.4.11                          Up (healthy)
otc-n8n             n8nio/n8n:2.36.2                      Up (healthy)
otc-nats            nats:2.14.5-alpine                    Up (healthy)
otc-otel-collector  otc-otel-collector:0.159.0            Up (healthy)
otc-prometheus      prom/prometheus:v3.14.0               Up (healthy)
```

### 4.2 Image pinning — clean
```
$ grep -rn "latest" docker-compose.infra.yml infra/ package.json
(no matches)
```
All eleven `image:` lines carry exact tags and match the required list exactly:
`mysql:8.4.11`, `mongo:8.3.8`, `apache/kafka:4.3.1`, `redpandadata/console:v3.10.0`,
`nats:2.14.5-alpine`, `jaegertracing/jaeger:2.20.0`, `prom/prometheus:v3.14.0`,
`grafana/grafana:13.2.0`, `n8nio/n8n:2.36.2`, `sonarqube:26.8.0.126808-community`,
plus the derived `otc-otel-collector:0.159.0` whose base is pinned to
`otel/opentelemetry-collector-contrib:0.159.0`.

### 4.3 MySQL — four databases *and* the grants actually applied
```
$ docker exec otc-mysql mysql -uroot -p... -e "SHOW DATABASES;"
information_schema / mysql / n8n / otc_billing / otc_fulfillment / otc_orders / performance_schema / sys

$ docker exec otc-mysql mysql -uroot -p... -e "SHOW GRANTS FOR 'otc_app'@'%';"
GRANT ALL PRIVILEGES ON `n8n`.*            TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_billing`.*    TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_fulfillment`.*TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_orders`.*     TO `otc_app`@`%`

$ docker exec otc-mysql mysql -uotc_app -p... -e "SHOW DATABASES;"
information_schema / n8n / otc_billing / otc_fulfillment / otc_orders / performance_schema
```
The app user genuinely connects and genuinely sees all four. (Harmless artefact:
the image's own `MYSQL_DATABASE` grant produces a duplicate escaped
`` `otc\_orders` `` row alongside the init script's.)

### 4.4 NATS — JetStream genuinely off
```
$ curl -s http://localhost:8222/jsz
{ ..., "disabled": true, "streams": 0, "consumers": 0, ... }

$ docker inspect otc-nats --format '{{json .Config.Cmd}}'
["-p","4222","-m","8222"]

$ docker logs otc-nats | head
[INF] Starting nats-server
[INF] Version: 2.14.5
[INF] Starting http monitor on 0.0.0.0:8222
[INF] Listening for client connections on 0.0.0.0:4222
[INF] Server is ready
```
Three independent confirmations: the API says disabled, the argv has no
`-js`/`--jetstream`, and the startup log has **no** `Starting JetStream` line
(which the server always prints when JetStream is on). Monitoring is on 8222.
`grep -rni jetstream` across the compose file and `infra/` hits only a comment.

### 4.5 Kafka — dual listeners genuinely work from both sides
From the **host** (external listener, advertised as `localhost:9092`):
```
$ docker run --rm --network host apache/kafka:4.3.1 \
    /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092
localhost:9092 (id: 1 rack: null isFenced: false) -> ( Produce(0): 0 to 13 ... )

$ ... kafka-topics.sh --bootstrap-server localhost:9092 --create --topic reviewer-verify ...
Created topic reviewer-verify.
$ ... --list        → reviewer-verify
$ ... --delete --topic reviewer-verify   (clean)
```
From **inside the network** (internal listener):
```
$ docker run --rm --network otc-net apache/kafka:4.3.1 \
    /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server kafka:29092
kafka:29092 (id: 1 rack: null isFenced: false) -> ( Produce(0): 0 to 13 ... )
```
KRaft, single node, no ZooKeeper container anywhere. Constraint 2 is met — but
see D1 for what happens to that topic after a `down`/`up`.

### 4.6 Jaeger v2 — OTLP correctly NOT on the host
```
$ docker inspect otc-jaeger --format '{{json .NetworkSettings.Ports}}'
{"16686/tcp":[{"HostIp":"0.0.0.0","HostPort":"16686"}, ...]}

$ docker inspect otc-otel-collector --format '{{json .NetworkSettings.Ports}}'
{"4317/tcp":[...4317],"4318/tcp":[...4318]}
```
Only 16686 is published from Jaeger; the collector owns 4317/4318 on the host,
exactly as constraint 3 requires.

### 4.7 The telemetry pipeline actually carries a trace end-to-end
This is the check the implementer did not do — it proves the collector →
Jaeger wiring, not just that both containers are up. I posted a synthetic OTLP
span to the collector's host port and looked for it in Jaeger:
```
$ curl -X POST -H 'Content-Type: application/json' -d @span.json \
    http://localhost:4318/v1/traces
200

$ curl -s http://localhost:16686/api/services
{"data":["jaeger","reviewer-probe"],"total":2,...}

$ curl -s "http://localhost:16686/api/traces?service=reviewer-probe&limit=5"
{"data":[{"traceID":"f8566d1ad0382fdf0be2579f1545d170",
  "spans":[{"operationName":"reviewer-verification-span", ...}],
  "processes":{"p1":{"serviceName":"reviewer-probe"}}}], ...}
```
Host → otel-collector:4318 → jaeger:4317 → Jaeger query API. The observability
spine works.

### 4.8 Prometheus and Grafana
```
$ curl -s http://localhost:9090/api/v1/targets | ...
otel-collector  up  http://otel-collector:8889/metrics   (lastError: "")

$ curl -s -u admin:... http://localhost:3030/api/datasources | ...
Jaeger      jaeger      http://jaeger:16686      default=False
Prometheus  prometheus  http://prometheus:9090   default=True

$ curl -s http://localhost:3030/api/health
{"database": "ok", "version": "13.2.0", ...}
```
Datasources provisioned, no dashboards present — constraint 9 met.

### 4.9 HTTP surfaces
```
http://localhost:16686/            200   Jaeger UI
http://localhost:9090/-/healthy    200   Prometheus
http://localhost:3030/api/health   200   Grafana
http://localhost:8080/             200   Redpanda Console
http://localhost:5678/healthz      200   n8n
http://localhost:13133/            000   collector health — correctly NOT host-mapped
$ docker exec otc-otel-collector /bin/busybox wget -qO- http://localhost:13133/
{"status":"Server available","upSince":"...","uptime":"5m43s"}
```

### 4.10 SonarQube is off by default
```
$ docker compose -f docker-compose.infra.yml config --services | sort
grafana jaeger kafka kafka-console mongodb mysql n8n nats otel-collector prometheus   (10 — no sonarqube)

$ docker compose -f docker-compose.infra.yml --profile sonar config --services | sort
... + sonarqube                                                                        (11)
```
Constraint 5 met exactly. I then started it under the profile to test its
healthcheck — that test is defect D2 — and removed it again, restoring the
default ten-service state.

### 4.11 `.env.example` completeness and secret hygiene
Every `${VAR}` referenced by the compose file has a key in `.env.example`
(set difference is empty). Fourteen further keys are forward-declared for later
phases (`CREDIT_FAILURE_RATE`, `MAILTRAP_*`, `JWT_*`, `MYSQL_DB_*`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `COMPOSE_PROJECT_NAME`) — intentional and
requested.
```
$ git check-ignore -v .env          → .gitignore:30:.env
$ git ls-files | grep -i '\.env'    → (empty, .env.example is untracked-new, correctly un-ignored by .gitignore:32)
$ diff .env .env.example            → identical (dev placeholders only)
$ grep -rEi '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN)' ...
  no real secrets found
```
Mailtrap credentials are `replace_me`. **No secret was committed.**

### 4.12 Root `package.json` — constraint 8 met
`"packageManager": "pnpm@11.22.0"` exact at top level, no `^`, no
`devEngines.packageManager`; `"private": true`; scripts only, zero `dependencies`
or `devDependencies`. `init.sh` confirms `pnpm 11.22.0` resolves.

---

## 5. Defects

### D1 — BLOCKING: the Kafka named volume is mounted where Kafka never writes; Kafka persists nothing
**File:** `docker-compose.infra.yml`, line 107 — `- kafka_data:/tmp/kraft-combined-logs`

`/tmp/kraft-combined-logs` is the Confluent `cp-kafka` convention. The
`apache/kafka:4.3.1` image defaults `log.dirs` to **`/tmp/kafka-logs`**, and the
compose file never sets `KAFKA_LOG_DIRS`, so the default stands. Proof from the
running broker:

```
$ docker exec otc-kafka ls -la /tmp/kafka-logs
-rw-r--r-- appuser  .lock
drwxr-xr-x appuser  __cluster_metadata-0        <-- the KRaft metadata log
-rw-r--r-- appuser  bootstrap.checkpoint
-rw-r--r-- appuser  meta.properties
-rw-r--r-- appuser  recovery-point-offset-checkpoint
-rw-r--r-- appuser  replication-offset-checkpoint

$ docker exec otc-kafka find / -name meta.properties -not -path "/proc/*"
/tmp/kafka-logs/meta.properties

$ docker exec otc-kafka ls -la /tmp/kraft-combined-logs
total 8
drwxr-xr-x 2 root root .
drwxrwxrwt 1 root root ..                      <-- EMPTY

$ docker run --rm -v otc_kafka_data:/v busybox:1.36.1-musl ls -la /v
total 8
drwxr-xr-x 2 root root .                       <-- the named volume is EMPTY
```

Every other named volume is correctly placed and non-empty
(`otc_mysql_data` 31 entries, `otc_mongodb_data` 22, `otc_prometheus_data` 4,
`otc_grafana_data` 6, `otc_n8n_data` 8). `otc_kafka_data` is the only one holding
zero bytes, because the broker writes to the container's writable layer instead.

**Why it matters.** This violates hard constraint 7 ("named volumes for stateful
services") in the way that is worst — the volume *looks* present in the file and
in `docker volume ls`, so nobody notices. `docker compose down && up` silently
destroys the cluster id, all topics, all offsets and all consumer group state. It
lands on the very next feature: **feature 5 `messaging_topology`** has acceptance
criterion *"3 fact topics + 3 dlq topics created idempotently"* — idempotence is
untestable and meaningless against a broker that starts empty every time. It also
undermines feature 14 (outbox) and feature 28 (`saga_e2e_verification`, "redelivery
causes no corruption"), and it is inherited verbatim by assessments #8 and #9.
The implementer's own report lists "all volumes named" as verified with no
deviation; it was never probed.

**Required fix (either, prefer the first — explicit beats implicit):**
```yaml
environment:
  KAFKA_LOG_DIRS: /var/lib/kafka/data
volumes:
  - kafka_data:/var/lib/kafka/data
```
or simply `- kafka_data:/tmp/kafka-logs`.

**Required proof on re-submission:** create a topic, `docker compose -f
docker-compose.infra.yml down` (without `-v`), `up -d`, and show
`kafka-topics.sh --list` still returning that topic, plus a non-empty
`docker run --rm -v otc_kafka_data:/v busybox ls /v`.

---

### D2 — BLOCKING: the SonarQube healthcheck reports healthy ~90 s before SonarQube is usable
**File:** `docker-compose.infra.yml`, line 320
```yaml
test: ["CMD", "curl", "-f", "-s", "http://localhost:9000/api/system/status"]
```
`/api/system/status` returns **HTTP 200 with `{"status":"STARTING"}`** as soon as
the web tier binds the port. `curl -f` only checks the status code, so the probe
passes while the application is still booting Elasticsearch and the compute
engine and will reject every request. Measured:

```
t=10s  docker_health=starting
t=50s  docker_health=healthy     <-- Docker says ready
--- then polling the app itself ---
t=+10s docker_health=healthy  sonar_status=STARTING
t=+20s docker_health=healthy  sonar_status=STARTING
t=+30s docker_health=healthy  sonar_status=STARTING
t=+40s docker_health=healthy  sonar_status=UP        <-- actually ready, ~90s later
```

**Why it matters.** This is precisely the failure mode hard constraint 6 names —
*"a healthcheck that genuinely tests readiness, not just process start"*. The
implementer's report reproduces the same `{"status":"STARTING"}` output and
explains it away as *"expected and unrelated to container health"*. It is not
unrelated: it is the definition of not-ready. Today nothing gates on it; from
phase 21 (`sonarqube_quality_gates`) a scanner gated on `service_healthy` will
start against a STARTING server and fail intermittently — the worst class of
CI flake.

**Required fix:**
```yaml
test: ["CMD-SHELL", "curl -sf http://localhost:9000/api/system/status | grep -q '\"status\":\"UP\"'"]
```

---

### D3 — MINOR: two more healthchecks probe liveness where a readiness endpoint exists
**Files:** `docker-compose.infra.yml` line 223 (prometheus), line 294 (n8n)

- Prometheus uses `/-/healthy`, which by Prometheus's own documented contract
  means *the process is alive*. `/-/ready` is the readiness contract and I
  confirmed it returns **200** on this container.
- n8n uses `/healthz` (liveness). `/healthz/readiness` exists and I confirmed it
  returns **200 `{"status":"ok"}`** — it is the one that checks the database
  connection, which for n8n is the MySQL `n8n` database this compose file wires up.

Same class as D2, much lower impact (both reach true readiness in seconds), but
constraint 6 was explicit and these are one-word changes. Grafana
(`/api/health`, reports `"database":"ok"`), MySQL (`mysqladmin ping`), MongoDB
(`db.adminCommand("ping")`), Kafka (`kafka-broker-api-versions.sh`), NATS
(`/healthz`), Jaeger and Redpanda Console (`/admin/health`) are all genuine
readiness probes — those are good.

---

### D4 — MINOR: the custom collector image can go stale silently
**Files:** `docker-compose.infra.yml` lines 163–166; `package.json` `dc:up:infra`

The service declares both `build:` and a fixed `image: otc-otel-collector:0.159.0`,
and `dc:up:infra` is a bare `docker compose ... up -d` with no `--build`. The
first run builds because the tag is absent, but **any later edit to
`infra/otel-collector/Dockerfile` or bump of the pinned `FROM` is silently
ignored** — compose finds the tag locally and reuses it. This is the maintenance
cost of the (otherwise approved) deviation and it needs closing, especially since
#8 and #9 copy this file and will hit it cold. Fix: add `pull_policy: build` to
the service, or `--build` to the `dc:up:infra` script.

---

### D5 — MINOR: the MySQL init script hardcodes the app username; a `.sh` init script would not have to
**File:** `infra/mysql/init/01-create-databases.sql`, lines 26–29

The implementer's stated reason is correct — the MySQL entrypoint pipes `.sql`
files straight into the client with no variable expansion. But the same
entrypoint **also executes `.sh` files in `/docker-entrypoint-initdb.d`, with the
full environment available**. A `01-create-databases.sh` doing
`mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL ... '${MYSQL_USER}'@'%' ... SQL`
removes the coupling entirely. This is the simpler alternative that was missed.
As it stands, changing `MYSQL_USER` in `.env` produces a container that starts
healthy and then fails at first application connect, with the failure a long way
from its cause. Related cosmetic point: `MYSQL_DB_ORDERS`, `MYSQL_DB_FULFILLMENT`
and `MYSQL_DB_BILLING` in `.env.example` are decorative — nothing reads them, the
names are hardcoded in the same SQL file.

---

### D6 — MINOR: the `debug` exporter is wired into both live pipelines
**File:** `infra/otel-collector/otel-collector-config.yaml`, lines 33–34 and 42, 46

`debug` (verbosity `basic`) sits in both the traces and the metrics pipeline. It
is one line of collector stdout per batch today, but from phase 23 that pipeline
carries the telemetry of six services and it becomes pure noise in
`dc:logs:otel-collector`. CHECKPOINTS C3 asks for "no stray debug logging". Keep
it if it is a deliberate phase-4 convenience, but say so in a comment and plan its
removal, or drop it now.

---

### D7 — MINOR (C2 box): `progress/current.md` is a leftover from the previous session
**File:** `progress/current.md`

Reads `**Feature:** — none active —`, `**Status:** idle`, and *"Next up: feature
`infra_compose`"* — describing the state **before** this feature was built. C2
requires it to describe the active session or hold only the template, "never
leftovers from a previous session". Ownership sits with the leader rather than
the implementer, but the box is empty and I have to mark it so.

---

## 6. What must change before re-review

1. **D1** — mount `kafka_data` at Kafka's real log dir (`KAFKA_LOG_DIRS:
   /var/lib/kafka/data` + matching volume, or `kafka_data:/tmp/kafka-logs`).
   Re-submit with the down/up survival proof described in D1.
2. **D2** — make the SonarQube healthcheck assert `"status":"UP"`, not just
   HTTP 200. Re-submit with a timing trace showing `docker_health=healthy`
   arriving no earlier than `sonar_status=UP`.
3. **D3** — Prometheus → `/-/ready`; n8n → `/healthz/readiness`.
4. **D4** — add `pull_policy: build` (or `--build` to `dc:up:infra`) so the
   collector image cannot go stale.
5. **D5** — convert the MySQL init script to `.sh` so `MYSQL_USER` is honoured,
   or remove the unused `MYSQL_DB_*` keys and state the coupling in
   `.env.example` next to `MYSQL_USER` itself.
6. **D6** — comment or remove the `debug` exporter.
7. **D7** — refresh `progress/current.md` to the active session (leader task).

Keep unchanged: every image tag, the KRaft dual-listener block, the NATS
core-only command, the Jaeger port policy, the `sonar` profile, the four MySQL
databases, the Grafana datasource provisioning, `package.json`, `.env.example`,
and `infra/otel-collector/Dockerfile`.

**Status returned to `in_progress`. Stack left running: ten default services,
all healthy; SonarQube removed after its profile test. No commit, no push.**

---

# Second pass — 2026-08-19

**Verdict: APPROVED.** 0 blocking defects, 0 minor defects outstanding, 1
non-blocking observation carried forward (N1, pre-existing, not a regression).

All six implementer-owned defects (D1–D6) are genuinely fixed. D7 (leader-owned)
is fixed. Every claim below was re-derived from the **running system** by me; I
re-ran the two tests the first pass proved were necessary (a real `down`/`up`
cycle, and a timed poll of the SonarQube probe) rather than reading the
implementer's transcript. I also hunted specifically for regressions in the two
places the fixes touch first-boot behaviour — the Kafka log directory and the
MySQL init script — and found none.

---

## 6. D1–D6 re-verified independently

### D1 — FIXED. Kafka now genuinely persists across `down`/`up`

Config, from the broker itself (not from the compose file):
```
$ docker exec otc-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:29092 \
    --entity-type brokers --entity-name 1 --describe --all | grep '^  log.dirs'
log.dirs=/var/lib/kafka/data  sensitive=false  synonyms={STATIC_BROKER_CONFIG:log.dirs=/var/lib/kafka/data}

$ docker exec otc-kafka printenv KAFKA_LOG_DIRS        → /var/lib/kafka/data
$ docker exec otc-kafka ls /tmp/kafka-logs /tmp/kraft-combined-logs
  ls: cannot access '/tmp/kafka-logs': No such file or directory
  ls: cannot access '/tmp/kraft-combined-logs': No such file or directory
```
The effective `log.dirs` is a `STATIC_BROKER_CONFIG` (i.e. it comes from the
explicit `KAFKA_LOG_DIRS`, not from the image default), and **neither** of the
two candidate default paths exists in the container any more — nothing is being
written to the container's writable layer.

**My own survival test** (the first pass's required proof, run by me end to end):
```
$ kafka-topics.sh --create --topic reviewer-d1-survive --partitions 3 --replication-factor 1
Created topic reviewer-d1-survive.
$ printf 'reviewer-msg-1\nreviewer-msg-2\n' | kafka-console-producer.sh --topic reviewer-d1-survive
$ docker exec otc-kafka md5sum-of meta.properties      → b6f56897a522a6792335add2646cc79e
$ docker run --rm -v otc_kafka_data:/v busybox:1.36.1-musl ls /v
  __cluster_metadata-0 bootstrap.checkpoint cleaner-offset-checkpoint log-start-offset-checkpoint
  meta.properties recovery-point-offset-checkpoint replication-offset-checkpoint
  reviewer-d1-survive-0 reviewer-d1-survive-1 reviewer-d1-survive-2   <-- all 3 partitions ON THE VOLUME

$ docker compose -f docker-compose.infra.yml down       # NO -v; all 10 containers + network removed
$ docker ps -a --filter name=otc- --format '{{.Names}}' → (empty — nothing survived as a container)
$ docker compose -f docker-compose.infra.yml up -d      # 18.4s, every dependency gate satisfied

$ kafka-topics.sh --list                                → reviewer-d1-survive
$ kafka-topics.sh --describe --topic reviewer-d1-survive
  PartitionCount: 3  ReplicationFactor: 1  (partitions 0,1,2 — Leader 1, Isr 1)
$ kafka-console-consumer.sh --topic reviewer-d1-survive --from-beginning
  reviewer-msg-1
  reviewer-msg-2
  Processed a total of 2 messages                       <-- the DATA survived, not just the metadata
$ docker exec otc-kafka md5sum-of meta.properties      → b6f56897a522a6792335add2646cc79e (identical)
```
Same cluster id, same topic, same partition count, **and the two records are
still readable from offset 0**. This is stronger than the proof I asked for: it
shows log segments survive, not merely topic metadata. Test topic deleted
afterwards; the broker is back to zero topics, ready for feature 5.

**No first-boot regression.** The named volume was empty at first-pass review
time and now contains a KRaft store whose `meta.properties` was written at
16:32 today — i.e. the broker successfully *formatted a completely empty volume*
at the new path, under uid 1000, with no permission failure. The clean-volume
path is therefore proven, not assumed.

### D2 — FIXED. The SonarQube probe now asserts the body, and I proved it rejects `STARTING`

Definition as materialised in the container (rules out a YAML quoting mistake —
the `\"` sequences resolve to real double quotes inside single quotes):
```
$ docker inspect otc-sonarqube --format '{{json .Config.Healthcheck.Test}}'
["CMD-SHELL","curl -sf http://localhost:9000/api/system/status | grep -q '\"status\":\"UP\"'"]
```
Truth table, executed inside the container, which is the check that matters —
a probe that merely *looks* stricter is worthless:
```
$ echo '{"status":"STARTING"}' | grep -q '"status":"UP"' ; echo $?   → 1   (rejects STARTING)
$ curl -sf .../api/system/status | grep -q '"status":"UP"' ; echo $? → 0   (accepts UP)
$ curl -sf .../nonexistent-endpoint-xyz | grep -q '"status":"UP"'; echo $? → 1 (curl failure propagates —
                                                                            grep is last in the pipe and
                                                                            exits 1 on empty input)
```
The pattern is a literal `"status":"UP"`; it cannot match `STARTING`, `DOWN` or
`DB_MIGRATION_NEEDED`.

**My own timed run** (`--profile sonar up -d sonarqube`, polled every 10 s):
```
t=10s docker_health=starting  app=(not listening)
t=20s docker_health=starting  app=(not listening)
t=30s docker_health=starting  app=(not listening)
t=40s docker_health=starting  app={"version":"26.8.0.126808","status":"STARTING"}
t=50s docker_health=healthy   app={"version":"26.8.0.126808","status":"UP"}
```
Docker stayed `starting` for the whole window in which the app said `STARTING`,
and flipped to `healthy` in the very poll where the app first said `UP`. The
~90 s false-healthy window from the first pass is gone. SonarQube removed
afterwards; the default stack is ten services again.

### D3 — FIXED. Readiness endpoints wired into the real healthcheck blocks
```
$ docker inspect otc-prometheus --format '{{json .Config.Healthcheck.Test}}'
["CMD","wget","--spider","-q","http://localhost:9090/-/ready"]
$ docker inspect otc-n8n --format '{{json .Config.Healthcheck.Test}}'
["CMD","wget","--spider","-q","http://localhost:5678/healthz/readiness"]

$ curl -o /dev/null -w '%{http_code}' http://localhost:9090/-/ready   → 200
$ curl -s http://localhost:5678/healthz/readiness                     → {"status":"ok"}
```
Both containers reach `healthy` on the new probes (confirmed after my full
`down`/`up`). The other eight probes are unchanged and were re-inspected — all
still genuine readiness checks (`mysqladmin ping`, `db.adminCommand("ping")`,
`kafka-broker-api-versions.sh`, `/admin/health`, `/api/health`, `/healthz`,
Jaeger UI, collector `:13133`).

### D4 — FIXED, and `pull_policy: build` does what is claimed
```
$ docker compose -f docker-compose.infra.yml config | grep -A1 pull_policy
    pull_policy: build

$ docker compose -f docker-compose.infra.yml up -d otel-collector   # NO --build, matching dc:up:infra
 Image otc-otel-collector:0.159.0 Building
 #2 [internal] load build definition from Dockerfile ...
```
A bare `up -d` now runs the build every time, so a stale local tag cannot be
reused. I proved change-detection in an **isolated throwaway project** rather
than mutating this repo's Dockerfile (the reviewer does not touch code):
```
compose with pull_policy: build + fixed tag rev-d4-probe:fixed
  up -d           → image id sha256:7bb413cde732...
  edit Dockerfile (RUN touch /marker-v1 → /marker-v2-CHANGED)
  up -d (NO --build) → image id sha256:8e1325e6abb2...  (different)
  ls / in the image → marker-v2-CHANGED
RESULT: pull_policy build DID pick up the change
```
`infra/otel-collector/Dockerfile` is untouched and the live image id is still
`sha256:195eee01258edf36a2e38363f542245a3a7778337d707e83131407eb9aeaf276` — the
approved two-line form.

### D5 — FIXED. `.sh` init, username from the environment, proven on a clean volume
```
$ ls infra/mysql/init/          → 01-create-databases.sh   (executable, 0775)
$ find . -name '*.sql'          → (nothing — no .sql leftover anywhere)
$ git ls-files | grep '\.sql$'  → (nothing)
```
Current volume (root, app user, and the schema catalogue):
```
$ SHOW DATABASES (root)      → n8n  otc_billing  otc_fulfillment  otc_orders  (+ system)
$ SHOW GRANTS FOR 'otc_app'@'%'
  GRANT ALL PRIVILEGES ON `n8n`.*             TO `otc_app`@`%`
  GRANT ALL PRIVILEGES ON `otc_billing`.*     TO `otc_app`@`%`
  GRANT ALL PRIVILEGES ON `otc_fulfillment`.* TO `otc_app`@`%`
  GRANT ALL PRIVILEGES ON `otc_orders`.*      TO `otc_app`@`%`
  (+ the image's own escaped `otc\_orders` duplicate from MYSQL_DATABASE, and USAGE — both harmless)
$ SHOW DATABASES as otc_app  → n8n  otc_billing  otc_fulfillment  otc_orders
```
**The real test of D5 is that changing `MYSQL_USER` is now honoured**, which the
`.sql` version could not do. I ran a throwaway `mysql:8.4.11` on a *fresh* volume,
mounting the same init directory, with `MYSQL_USER=reviewer_probe_user`:
```
$ docker logs rev-mysql-clean | grep 01-create-databases
[Entrypoint]: running /docker-entrypoint-initdb.d/01-create-databases.sh
$ SHOW GRANTS FOR 'reviewer_probe_user'@'%'
  GRANT ALL PRIVILEGES ON `n8n`.*, `otc_billing`.*, `otc_fulfillment`.*, `otc_orders`.*
$ mysql -ureviewer_probe_user -p... -e 'SHOW DATABASES'
  n8n  otc_billing  otc_fulfillment  otc_orders
$ docker logs rev-mysql-clean | grep -E '\[ERROR\]|ERROR 1'   → (none)
```
The grants followed the environment to a username that appears nowhere in the
repository. **No first-boot regression**: the script runs cleanly on an empty
data directory, the heredoc quoting survives the entrypoint, and the container
reaches `ready for connections` with no error line. Throwaway container and
volume removed.

### D6 — FIXED. `debug` gone from both pipelines, telemetry still flows

Running config, read out of the live container:
```
traces:  receivers: [otlp]  processors: [batch]  exporters: [otlp/jaeger]
metrics: receivers: [otlp]  processors: [batch]  exporters: [prometheus]
```
`debug` is still *declared* under `exporters:` with a comment explaining it is
deliberately unwired for local troubleshooting — that is the acceptable form of
the option I offered.

Traces still arrive (synthetic OTLP span, host → collector:4318 → jaeger:4317):
```
$ POST /v1/traces                       → 200
$ GET /api/services                     → ["jaeger","reviewer-pass2-probe"]
$ GET /api/traces?service=reviewer-pass2-probe
  traceID c176e70416f9e9d828c89c5d09e2df8b, operationName "reviewer-pass2-span"
```
Metrics still arrive — and I followed them the whole way, not just to the
scrape target:
```
$ POST /v1/metrics  (counter reviewer_pass2_counter = 42)          → 200
$ collector :8889/metrics
  reviewer_pass2_counter_total{job="reviewer-pass2-probe",...} 42
$ prometheus /api/v1/query?query=reviewer_pass2_counter_total
  {"result":[{"metric":{"__name__":"reviewer_pass2_counter_total","exported_job":"reviewer-pass2-probe",
   "instance":"otel-collector:8889","job":"otel-collector"},"value":[...,"42"]}]}
```
And the collector is genuinely quiet — `grep -c` for `TracesExporter|ResourceSpans|
InstrumentationScope` in its logs returns **0**, so removing `debug` did what it
was supposed to do and nothing else.

### D7 — FIXED (leader). `progress/current.md` now describes the active session

It carries `**Feature:** infra_compose (id 4, phase 4)`, the session date, the
decisions taken, and a summary of the first-pass rejection. No leftovers.
(Cosmetic: it still says `Status: in_progress — fixes in flight` where
`feature_list.json` said `in_review`; it is reset to the template at session
close, so I am not raising it as a defect.)

---

## 7. Everything else re-checked after the substantial compose change

| Check | Result |
|---|---|
| All 10 default services healthy **after a full down/up** | PASS — 10/10 `Up (healthy)` |
| No `latest` tags | PASS — `grep -rn latest docker-compose.infra.yml infra/ package.json .env.example` → no matches |
| NATS core-only, JetStream off | PASS — `/jsz` → `"disabled": true`; `Cmd=["-p","4222","-m","8222"]`; `docker logs otc-nats \| grep -ci jetstream` → **0** |
| Jaeger OTLP not host-mapped | PASS — Jaeger publishes only `16686`; the collector owns host `4317`/`4318` |
| SonarQube excluded by default | PASS — default `config --services` = 10 names, no `sonarqube`; `--profile sonar` = 11 |
| `./init.sh` | PASS — `exit=0`, "environment and state are coherent" |
| `.env.example` completeness | PASS — set difference of `${VAR}` refs minus `.env.example` keys is **empty** |
| Secret hygiene | PASS — `.env` ignored (`.gitignore:30`), no tracked env file, no secret patterns |
| `package.json` | PASS — exact `"packageManager": "pnpm@11.22.0"`, `private: true`, scripts only |
| Claude did not commit | PASS — `git log` head is still `cf795db docs(spec): ...` |

### Regression hunt — nothing found
- Kafka clean-volume format at the new path: **works** (evidence in D1).
- MySQL clean-volume init with the new `.sh`: **works**, including a changed
  `MYSQL_USER` (evidence in D5).
- Dependency gates after the rewrite: the `up -d` transcript shows
  `mysql Healthy → n8n`, `jaeger Healthy → otel-collector`,
  `otel-collector Healthy → prometheus`, `prometheus+jaeger Healthy → grafana`,
  `kafka Healthy → kafka-console`. Whole stack healthy in **18 s**.
- `pull_policy: build` adds a build step to every `up`; measured cost with a warm
  cache is ~1 s. No practical regression.

---

## 8. CHECKPOINTS walked — second pass

C3, C4, C6 do not apply (no application code at phase 4). C7's spec/n8n boxes do
not apply yet.

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model (`init.sh` §2 OK).
- [x] `./init.sh` exits 0 — re-run by me after all fixes.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero; one `in_review` (this feature).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — features 1–3 are
      toolchain/harness/spec; their verification is `init.sh` plus the AsyncAPI and
      OpenAPI validators recorded in `history.md`. No suite is due until phase 5.
- [x] **`progress/current.md` describes the active session** — fixed (D7).
- [x] Every `blocked` feature records why — none blocked.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — `git status --porcelain` shows only this
      feature's own additions; no build output, no `*.tmp`, `.env` correctly ignored.
- [x] `progress/history.md` has an entry for the feature just finished, including
      its effort record — appended at this approval.
- [x] `feature_list.json` reflects the true state — set to `done` by me now.
- [x] The human has been told what was done and how to test it manually —
      `progress/impl_infra_compose.md` doubles as a runnable recipe.
- [x] **Claude did not commit.** `git log` head unchanged; no push.

### C7 — Trilogy reusability (partial, applicable boxes only)
- [x] `progress/history.md` effort records are complete and honest — including the
      two-pass record for this feature.

---

## 9. Non-blocking observation carried forward

### N1 — `otc_orders` has a different collation from the other three databases
**File:** `docker-compose.infra.yml` (`MYSQL_DATABASE: ${MYSQL_DATABASE:-otc_orders}`)
```
otc_orders       utf8mb4   utf8mb4_0900_ai_ci     <-- created by the image, before initdb.d runs
otc_fulfillment  utf8mb4   utf8mb4_unicode_ci
otc_billing      utf8mb4   utf8mb4_unicode_ci
n8n              utf8mb4   utf8mb4_unicode_ci
```
`MYSQL_DATABASE` makes the entrypoint create `otc_orders` with the server default
collation *before* the init script runs, and `CREATE DATABASE IF NOT EXISTS` then
leaves it alone. So one of the four service databases sorts and compares strings
under different rules from the other three.

**Not a regression and not a defect of this fix round** — the same mechanism was
in place at the first submission with the `.sql` script; I did not spot it then,
and I am not moving the goalposts now. Impact today is nil (no schema exists).
Fix when the Orders Drizzle schema lands (feature 8/9): either drop
`MYSQL_DATABASE` from the service and let the init script own all four, or add an
explicit `ALTER DATABASE ... COLLATE`. Worth carrying to #8 and #9, which will
inherit the same compose shape.

---

## 10. Verdict and state

**APPROVED.** `infra_compose` set to `done` in `feature_list.json`; entry with
effort record appended to `progress/history.md`.

Remaining defects: **0**. Non-blocking observations: **1** (N1, deferred to the
Orders schema feature).

**Stack left running:** the ten default services, all `Up (healthy)`; SonarQube
removed after its profile test; the collector image at its approved id; no test
topics, no throwaway containers or volumes left behind. **No commit, no push.**
