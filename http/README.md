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

### What needs to be running

The containers run detached, but **each service is a watch process that occupies its own terminal**:

```bash
# Terminal 1 — containers, detached; you get your prompt back
pnpm dc:up:infra

# Terminals 2, 3 and 4 — one each, left running.
# Each prints "listening on port 300X (HTTP) and NATS" when ready.
pnpm dev:orders
pnpm dev:fulfillment
pnpm dev:billing
```

`pnpm saga:watch` needs only the containers; placing orders needs the services too.

### Driving the saga

```bash
pnpm order:place --qty 2    # 49 998 — normal order, runs the happy path to despatched
pnpm order:place --qty 1    # 24 999 — ends in .99, so the credit simulator rejects it
pnpm order:over-limit       # 524 979 — genuinely exceeds the credit limit
sleep 3 && pnpm saga:watch  # the saga runs asynchronously — give it a moment
```

Those three cover every path the system has: the happy path, a *simulated* rejection (`reason: simulated_cents_rule`) and a *genuine* one (`reason: over_limit`). Both rejections produce the identical fact and the identical compensation — stock released, order `cancelled`, `credit_rejected` — differing only in the reason, which is requirement **R44** made visible.

`place-order.mjs` speaks NATS through `@nestjs/microservices`'s own client, not hand-rolled JSON: `orders.create` is served by a Nest `@MessagePattern`, and Nest treats an id-less bare-JSON packet as a fire-and-forget event and never replies. Other flags: `--product`, `--retailer`, `--company`, `--currency`.

```bash
pnpm saga:watch         # every order's status, and the saga's command table
```
