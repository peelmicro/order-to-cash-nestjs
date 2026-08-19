# impl_infra_compose

**Feature:** `infra_compose` (id 4, phase 4)
**Status set to:** `in_review` (second submission — first was rejected, see
`progress/review_infra_compose.md`)

## What this is

`docker-compose.infra.yml` brings up the ten infrastructure services needed by
every later phase (MySQL, MongoDB, Kafka, Redpanda Console, NATS, OTel
Collector, Jaeger, Prometheus, Grafana, n8n), plus SonarQube behind an opt-in
`sonar` profile. No application containers here — those arrive in phase 23.

This report supersedes the first-submission report in full; it is not an
appendix. It documents the seven defects (D1–D7) the reviewer found and, for
each, the fix and the evidence gathered **from the running system**, which is
exactly what the first pass failed to do for D1 and D2.

## Why the first pass missed D1 and D2

- **D1:** I verified the Kafka volume was *declared* (`kafka_data:` in the
  `volumes:` top-level block, mounted in the service) and that the broker
  worked functionally (created/listed/deleted a topic). I never actually
  looked at what was *inside* the named volume versus the container's
  writable layer, and I copied the `/tmp/kraft-combined-logs` path from
  memory of the Confluent `cp-kafka` convention without checking it against
  `apache/kafka:4.3.1`'s actual default (`/tmp/kafka-logs`). A `down`/`up`
  cycle — the one test that would have caught it — was never performed.
- **D2:** I did read the SonarQube response body and saw `"status":"STARTING"`,
  but reasoned it was "expected and unrelated to container health" instead of
  recognizing that STARTING *is* not-ready by definition, and that the
  healthcheck (`curl -f`, status-code only) would report healthy long before
  that. I never timed the two signals against each other.

Both are now fixed and re-verified by forcing the actual failure scenario
(restart-and-check, timed-poll-until-flip) rather than a single functional
smoke test.

## Fixes, one per defect

### D1 (BLOCKING) — Kafka volume now mounted where the broker actually writes

**File:** `docker-compose.infra.yml`

```yaml
kafka:
  environment:
    # ...
    KAFKA_LOG_DIRS: /var/lib/kafka/data   # declared explicitly, not inherited
  volumes:
    - kafka_data:/var/lib/kafka/data
```

`KAFKA_LOG_DIRS` is set explicitly (per the reviewer's preferred fix) so the
path is visible in the compose file and can't silently change with a future
image bump; the volume mount matches it exactly.

**Evidence — down/up survival, real broker restart, not a volume swap:**
```
$ docker exec otc-kafka printenv KAFKA_LOG_DIRS
/var/lib/kafka/data

$ docker run --rm --network host apache/kafka:4.3.1 \
    kafka-topics.sh --bootstrap-server localhost:9092 --create \
    --topic d1-persistence-verify --partitions 1 --replication-factor 1
Created topic d1-persistence-verify.

$ docker run --rm -v otc_kafka_data:/v busybox:1.36.1-musl ls -la /v
... .lock  __cluster_metadata-0  bootstrap.checkpoint  cleaner-offset-checkpoint
    d1-persistence-verify-0  log-start-offset-checkpoint  meta.properties
    recovery-point-offset-checkpoint  replication-offset-checkpoint

$ docker compose -f docker-compose.infra.yml down          # NO -v
$ docker compose -f docker-compose.infra.yml up -d
$ docker inspect --format='{{.State.Health.Status}}' otc-kafka
healthy   (within seconds)

$ docker run --rm --network host apache/kafka:4.3.1 \
    kafka-topics.sh --bootstrap-server localhost:9092 --list
d1-persistence-verify        <-- survived the restart

$ docker run --rm -v otc_kafka_data:/v busybox:1.36.1-musl ls -la /v
... same files, non-empty, meta.properties (cluster id) unchanged
```
The `meta.properties` file (which carries the KRaft cluster id) had the same
content/timestamp across the restart, proving the same cluster identity — not
just a coincidentally-recreated topic. Topic deleted afterwards for cleanup.

### D2 (BLOCKING) — SonarQube healthcheck now asserts the body, not just HTTP 200

**File:** `docker-compose.infra.yml`
```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -sf http://localhost:9000/api/system/status | grep -q '\"status\":\"UP\"'"]
```

**Evidence — timed trace, docker health vs. app-reported status, polled every 10s:**
```
$ docker compose -f docker-compose.infra.yml --profile sonar up -d sonarqube
t=10s docker_health=starting
t=20s docker_health=starting
t=30s docker_health=starting
t=40s docker_health=starting   sonar_status="STARTING"
t=50s docker_health=healthy    sonar_status="UP"
>>> docker reports healthy at t=50s, sonar status was: "status":"UP"
```
Docker's health status stayed `starting` through the entire window where the
app reported `STARTING`, and only flipped to `healthy` in the same poll where
the app first reported `UP` — the false-healthy window from the first
submission is gone. Stopped/removed SonarQube afterwards (off by default).

### D3 (MINOR) — Prometheus and n8n healthchecks now use their readiness endpoints

**File:** `docker-compose.infra.yml`
```yaml
# prometheus
test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090/-/ready"]
# n8n
test: ["CMD", "wget", "--spider", "-q", "http://localhost:5678/healthz/readiness"]
```

**Evidence:**
```
$ curl -s -o /dev/null -w "http=%{http_code}\n" http://localhost:9090/-/ready
http=200
$ curl -s http://localhost:5678/healthz/readiness
{"status":"ok"}
$ docker inspect otc-prometheus --format '{{json .Config.Healthcheck.Test}}'
["CMD","wget","--spider","-q","http://localhost:9090/-/ready"]
$ docker inspect otc-n8n --format '{{json .Config.Healthcheck.Test}}'
["CMD","wget","--spider","-q","http://localhost:5678/healthz/readiness"]
```
Both containers report `healthy` using the new probes.

### D4 (MINOR) — the collector image can no longer go stale silently

**File:** `docker-compose.infra.yml`
```yaml
otel-collector:
  build: { context: ./infra/otel-collector, dockerfile: Dockerfile }
  image: otc-otel-collector:0.159.0
  pull_policy: build
```

**Evidence — a real Dockerfile edit, `up -d` with NO `--build` flag (matching
the bare `dc:up:infra` script), image genuinely rebuilt:**
```
$ echo 'COPY --from=busybox:1.36.1-musl /bin/busybox /d4-marker' >> Dockerfile
$ docker compose -f docker-compose.infra.yml up -d
 Image otc-otel-collector:0.159.0 Building     <-- triggered without --build
 ...
 Container otc-otel-collector Recreated
$ docker run --rm --entrypoint="" otc-otel-collector:0.159.0 \
    /bin/busybox test -f /d4-marker && echo "MARKER PRESENT"
MARKER PRESENT (rebuild was picked up)
$ docker image inspect otc-otel-collector:0.159.0 --format '{{.Id}}'
sha256:5a36072c...   (new id, different from before the edit)
```
Reverted the Dockerfile to its approved two-line form immediately afterwards
and rebuilt again — confirmed the marker is gone and the image id is back to
`sha256:195eee01258edf36a2e38363f542245a3a7778337d707e83131407eb9aeaf276`
(the original), container healthy.

### D5 (MINOR) — MySQL init converted from `.sql` to `.sh`, username sourced from the environment

**Files:**
- Deleted `infra/mysql/init/01-create-databases.sql`
- Added `infra/mysql/init/01-create-databases.sh` (executable, `set -eu`,
  reads `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_DB_ORDERS`,
  `MYSQL_DB_FULFILLMENT`, `MYSQL_DB_BILLING`, `MYSQL_DB_N8N` straight from the
  container environment; heredoc into `mysql -uroot`)
- `docker-compose.infra.yml`: added `MYSQL_DB_ORDERS`/`MYSQL_DB_FULFILLMENT`/
  `MYSQL_DB_BILLING`/`MYSQL_DB_N8N` to the `mysql` service's `environment:` so
  the `.sh` script can read them (closing the reviewer's related cosmetic
  point — these vars are no longer decorative, the init script is now the
  single source of truth for both the username and the four database names).
- `.env.example`: updated the two comments that referenced the removed
  `.sql` file and the drift risk that no longer exists.

**Evidence — clean-volume proof (removed only `otc_mysql_data`, not the whole
stack), showing the `.sh` script actually ran and the grants/databases came
out right with the username taken from the environment:**
```
$ docker compose -f docker-compose.infra.yml stop mysql
$ docker compose -f docker-compose.infra.yml rm -f mysql
$ docker volume rm otc_mysql_data
$ docker compose -f docker-compose.infra.yml up -d mysql
... becomes healthy at t≈12s

$ docker logs otc-mysql | grep 01-create-databases
[Note] [Entrypoint]: running /docker-entrypoint-initdb.d/01-create-databases.sh

$ docker exec otc-mysql mysql -uroot -p... -e "SHOW DATABASES;"
information_schema / mysql / n8n / otc_billing / otc_fulfillment / otc_orders
/ performance_schema / sys

$ docker exec otc-mysql mysql -uroot -p... -e "SHOW GRANTS FOR 'otc_app'@'%';"
GRANT ALL PRIVILEGES ON `n8n`.*            TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_billing`.*    TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_fulfillment`.*TO `otc_app`@`%`
GRANT ALL PRIVILEGES ON `otc_orders`.*     TO `otc_app`@`%`

$ docker exec otc-mysql mysql -uotc_app -p... -e "SHOW DATABASES;"
information_schema / n8n / otc_billing / otc_fulfillment / otc_orders
/ performance_schema
```
`otc_app` is never hardcoded in `.sh` — it comes from `MYSQL_USER` in the
container's environment, sourced from `.env`.

### D6 (MINOR) — `debug` exporter removed from both live pipelines

**File:** `infra/otel-collector/otel-collector-config.yaml`
```yaml
exporters:
  debug:
    verbosity: basic   # declared, kept for local troubleshooting, NOT wired in
service:
  pipelines:
    traces:
      exporters: [otlp/jaeger]     # was [otlp/jaeger, debug]
    metrics:
      exporters: [prometheus]      # was [prometheus, debug]
```

**Evidence — traces and metrics still flow end-to-end with `debug` gone:**
```
$ docker exec otc-otel-collector /bin/busybox cat /etc/otelcol-contrib/config.yaml \
    | grep -A3 pipelines:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      # exporters: [otlp/jaeger]   (confirmed in the running config)

$ curl -X POST http://localhost:4318/v1/traces -d @span.json   # synthetic OTLP span
200
$ curl -s "http://localhost:16686/api/traces?service=d6-verify-probe-2"
{"data":[{"traceID":"f72258d6...","spans":[{"operationName":"d6-verify-span-2",...}],
  "processes":{"p1":{"serviceName":"d6-verify-probe-2"}}}], ...}   <-- arrived

$ curl -s http://localhost:9090/api/v1/targets
otel-collector  up  http://otel-collector:8889/metrics   <-- still scraped
```
Collector startup logs show only the `otlp/jaeger` exporter warning (deprecated
alias name, unrelated), no `debug` output.

### D7 — already fixed by the leader before this session; not touched

`progress/current.md` was left untouched per instruction.

## Re-verification of everything else (unchanged, re-confirmed after all fixes)

```
$ docker compose -f docker-compose.infra.yml ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
otc-grafana          grafana/grafana:13.2.0                Up (healthy)
otc-jaeger           jaegertracing/jaeger:2.20.0            Up (healthy)
otc-kafka            apache/kafka:4.3.1                     Up (healthy)
otc-kafka-console    redpandadata/console:v3.10.0           Up (healthy)
otc-mongodb          mongo:8.3.8                            Up (healthy)
otc-mysql            mysql:8.4.11                           Up (healthy)
otc-n8n              n8nio/n8n:2.36.2                       Up (healthy)
otc-nats             nats:2.14.5-alpine                     Up (healthy)
otc-otel-collector   otc-otel-collector:0.159.0              Up (healthy)
otc-prometheus       prom/prometheus:v3.14.0                Up (healthy)

$ grep -rn "latest" docker-compose.infra.yml infra/ package.json
(no matches)

$ docker compose -f docker-compose.infra.yml config --services | sort
grafana jaeger kafka kafka-console mongodb mysql n8n nats otel-collector prometheus
(10 — sonarqube correctly absent from the default stack)

$ ./init.sh
... exit=0
```

## Files touched this session

- `docker-compose.infra.yml` — Kafka `KAFKA_LOG_DIRS` + volume mount path
  (D1), SonarQube healthcheck body assertion (D2), Prometheus/n8n readiness
  endpoints (D3), `pull_policy: build` on `otel-collector` (D4), MySQL
  service gained `MYSQL_DB_*` env vars for the new init script (D5).
- `infra/mysql/init/01-create-databases.sh` — new, replaces the deleted
  `01-create-databases.sql` (D5).
- `infra/otel-collector/otel-collector-config.yaml` — `debug` exporter
  removed from both pipelines, kept declared (D6).
- `.env.example` — two comments updated to match the `.sh` init script and
  its env-driven database names (D5).
- `feature_list.json` — `infra_compose` status `in_progress` → `in_review`.

No changes to: image tags, KRaft dual-listener block, NATS core-only command,
Jaeger port policy, the `sonar` profile, the four MySQL database names, the
Grafana datasource provisioning, `package.json`, or
`infra/otel-collector/Dockerfile` (its approved two-line form — reverted back
to exactly this after the D4 rebuild-proof edit).

## What I could not verify / did not do

Same as the first submission — no application code exists at phase 4, so
`pnpm quality` has nothing to lint/typecheck/test yet; Kafka topic creation is
feature 5's job; no Grafana dashboards (phase 22).

## State left running

The default ten-service stack is up and healthy (see `ps` output above).
SonarQube was started under `--profile sonar` twice during D2/re-verification
and stopped/removed both times, restoring the correct off-by-default state.
No commit, no push.
