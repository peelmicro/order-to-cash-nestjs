# Infra fix — MySQL healthcheck must ping over TCP, not the Unix socket

Scope: `docker-compose.infra.yml` only, `mysql.healthcheck.test`. Nothing under `apps/`, `packages/` or any other compose file was touched. Not committed.

## The change

```diff
-test: ["CMD-SHELL", "mysqladmin ping -h localhost -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]
+test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -P 3306 --protocol=TCP -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]
```

`interval`, `timeout`, `retries: 20` and `start_period: 30s` are **unchanged** — see the timing evidence below for why they still fit. A comment recording the reasoning sits above the check so the next person does not "simplify" it back to `-h localhost`.

## Flag verification against the real image

Verified against `mysql:8.4.11` before editing anything, rather than assumed. A throwaway container was polled every ~0.5s from first boot, running the old and the new command side by side:

```
t=7  old=1 new=1     # nothing listening yet
t=8  old=0 new=1     # <-- temp server: socket up, TCP still refusing
t=9  old=0 new=1     # <-- the false-positive window
t=10 old=1 new=1     # temp server shut down again
t=14 old=0 new=0     # real server on 3306; both agree from here on
```

The old check goes green at t=8 while TCP is still refusing. The new one never does. `--protocol=TCP` is accepted by this image's `mysqladmin` and exits 0 once healthy.

## Why it was a coin flip — the cold-start timeline

From the run-3 container (`docker logs otc-mysql` vs `StartedAt`):

| offset | event |
|---|---|
| +0.0s | container started |
| +4.5s | `ready for connections … **port: 0**` — temp server, socket only. **The old check passes here.** |
| +8.4s | `ready for connections … **port: 3306**` — real server, TCP listening |
| +10.8s | the four `*-migrate` containers start |

`port: 0` in the temp-server line is the literal proof it was never listening on TCP. The false-positive window is **~3.9s wide against a 5s healthcheck interval** — so roughly a coin flip whether a tick landed inside it. That matches the observed symptom exactly: intermittent `ECONNREFUSED`, cured by a second `dc:up:apps`.

## `start_period` / `retries` — measured, not guessed

MySQL reaches healthy under the stricter check at **~10.8s** on a cold volume (including the five-database init script), against a `start_period` of 30s. Roughly a third of the budget is used. `retries: 20` is never approached. **No adjustment made** — the stricter check costs about 6 extra seconds, not 30.

## Three cold cycles — `pnpm dc:clean:apps` then `WEB_PORT=3010 pnpm dc:up:apps`

| run | `up` exit | `up` returns | all 6 `/health/ready`=200 | 4 migrate jobs |
|---|---|---|---|---|
| 1 | 0 | 35s | 39s | all exit 0, `RestartCount=0` |
| 2 | 0 | 36s | 40s | all exit 0, `RestartCount=0` |
| 3 | 0 | 36s | 42s | all exit 0, `RestartCount=0` |

**3/3 passed on the first attempt** — no run needed a second `dc:up:apps`. Exit codes read via `docker inspect -f '{{.State.ExitCode}}'`; each job logged its connection, e.g. `[orders] migrations applied against mysql:3306/otc_orders`. Web on 3010 returned 302 (auth redirect) in every run.

## Warm restart — volumes intact

`pnpm dc:down:apps` (12s) then `WEB_PORT=3010 pnpm dc:up:apps` → exit 0 in 36s, all four migrate jobs exit 0, all six services 200, web 302. The stricter check does not harm the warm path. MySQL's log on a populated data dir contains **exactly one** `ready for connections`, already `port: 3306` — no temp server at all, which is precisely why this bug only ever bit cold starts.

## Surprises

- **The "~2 minutes to demoable" claim in the plan document is pessimistic by ~3x.** Stopwatched cold start is **35–42s** from `dc:up:apps` to all six services ready. Caveat, so the number is not read as better than it is: all `otc-*` images were already built. A cold cycle that also has to build them is a different and much larger number.
- **`up -d` returning is not the same as ready.** In run 1 the first readiness poll caught five services at HTTP 000 with `RestartCount=0` — they had started *that second*. `dc:up:apps` returns once containers are started, and the five domain services are gated behind `kafka-init` completing, so they begin ~1s before the command exits. Nothing was wrong; the harness was polling too early. Worth knowing before anyone reads a bare `up` exit code as "the stack is usable".
- `pnpm dc:seed` re-runs the four migrate jobs (its `depends_on: service_completed_successfully`). They are idempotent and re-exit 0, so an `exited (0) N seconds ago` on a migrate container after seeding is expected, not a fault.

## Final state

Stack is **up, healthy and seeded** on `WEB_PORT=3010`. All six NestJS services `/health/ready` = 200; web 302; every long-running container `healthy`; the only exited containers are the one-shot jobs (`kafka-init`, four `*-migrate`), all exit 0. Seed loaded 22 companies, 7 retailers, 12 products, 6 orders, 5 despatches, 5 invoices, 6 Mongo order timelines. Docker context left on `default` (native engine).
