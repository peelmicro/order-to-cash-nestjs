# `http/` — manual probing with the REST Client extension

These files are for poking at a running stack by hand, using the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) VS Code extension: open a file and click **Send Request** above any block.

| File | What it reaches |
|---|---|
| [`services.http`](services.http) | Each service's HTTP liveness endpoint |
| [`nats.http`](nats.http) | The NATS monitoring API — including which RPC subjects are currently answered |
| [`kafka.http`](kafka.http) | Topics, consumer groups, and **the domain facts themselves**, via the Redpanda Console API |
| [`observability.http`](observability.http) | Prometheus queries, the Jaeger trace API, Grafana health and datasources |

Start the infrastructure with `pnpm dc:up:infra`, and any service with `pnpm dev:orders` (or `dev:fulfillment`, `dev:billing`).

## Why there are no business requests here yet

The interesting operations of this system — placing an order, reserving stock, holding credit — are **NATS request-reply**, not HTTP. The REST Client extension speaks HTTP only, so it cannot call them.

That is not an oversight: it is the architecture. Commands and synchronous queries travel over NATS, domain facts travel over Kafka, and **HTTP is reserved for the Gateway**, which is the single public entry point for the web app. The Gateway arrives in **feature 25**, and when it does these files gain the requests that actually matter:

- `POST /orders` — place an order
- `GET /orders`, `GET /orders/{id}` — the read model, including the full saga timeline
- `POST /invoices/{id}/payments` — the remittance intake
- `GET /stock`, `GET /credits`, `GET /catalog/...`
- `POST /auth/login` — and the JWT every other request carries

Until then, `kafka.http` is the most useful file here: it shows the facts each saga step publishes, which is the closest thing to watching the system think.

## Placing an order before the Gateway exists

Use the NATS script instead:

```bash
pnpm order:place        # a normal order — should run the happy path
pnpm order:over-limit   # exceeds the credit limit — triggers a real compensation
pnpm saga:watch         # every order's status, and the saga's command table
```
