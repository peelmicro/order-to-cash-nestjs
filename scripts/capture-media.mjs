/**
 * Captures the README's screenshots from the LIVE stack, so the images in
 * docs/screenshots/ are reproducible evidence rather than hand-cropped
 * one-offs nobody can regenerate. Run against a booted, seeded stack:
 *
 *   pnpm dc:up:apps && pnpm dc:seed && pnpm media:capture
 *
 * Deliberately NOT a Playwright *test*: it asserts nothing and gates
 * nothing. Test runs must stay hermetic and repeatable; this one wants the
 * real, messy, already-populated stack precisely because that is what the
 * README is documenting.
 *
 * n8n is absent by design — it authenticates with an owner account whose
 * credentials live in the operator's head, not in `.env` (n8n 2.x dropped
 * N8N_BASIC_AUTH_*). That one screenshot stays manual; see the README.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Resolved out of apps/web rather than imported directly: Playwright is that
// workspace's dev dependency (it owns the e2e suite), and this script lives
// outside it. Adding a second copy at the root just to satisfy a bare
// import would be a duplicate ~150 MB browser-bearing dependency.
const require = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = require('@playwright/test');
const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

// Minimal .env reader — this script is run by hand from the repo root and
// deliberately pulls in no dependency the repo does not already have.
const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* .env is optional if everything is already exported */ }

const WEB = `http://localhost:${env.WEB_PORT ?? 3010}`;
const MAILPIT = `http://localhost:${env.MAILPIT_UI_HOST_PORT ?? 8025}`;
const GRAFANA = `http://localhost:${env.GRAFANA_HOST_PORT ?? 3030}`;
const JAEGER = `http://localhost:${env.JAEGER_UI_HOST_PORT ?? 16686}`;

const shots = [];
async function shot(page, name, opts = {}) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(name);
  console.log(`  captured ${name}.png`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

try {
  // ── Web app ──────────────────────────────────────────────────────────
  console.log('web app…');
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.locator('#username').fill(env.GATEWAY_OPERATOR_USERNAME ?? 'operator');
  await page.locator('#password').fill(env.GATEWAY_OPERATOR_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/orders$/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await shot(page, 'web-order-list');

  await page.goto(`${WEB}/orders/place`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Fill demo order/ }).click().catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, 'web-place-order');

  // Order detail: one completed (happy path) and one cancelled
  // (compensation). Resolved reference -> UUID through the API rather than
  // by clicking the reference in the list: the list is paginated and
  // newest-first, so any burst of new orders silently pushes the intended
  // one off page 1 and the shot is skipped. Asking the API by reference is
  // independent of how many orders exist.
  const gw = `http://localhost:${env.GATEWAY_HOST_PORT ?? 3001}`;
  const tokenRes = await fetch(`${gw}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: env.GATEWAY_OPERATOR_USERNAME ?? 'operator', password: env.GATEWAY_OPERATOR_PASSWORD }),
  });
  const token = (await tokenRes.json()).accessToken;
  // Paginated: `GET /orders` returns a fixed pageSize (25) and ignores any
  // larger `limit`, so a single request only ever sees the newest page.
  // Walk to `page.total` — an unattended demo stack grows past one page
  // within minutes of the n8n order generator being published.
  const auth = { authorization: `Bearer ${token}` };
  const items = [];
  for (let pageNo = 1; ; pageNo += 1) {
    const body = await (await fetch(`${gw}/orders?page=${pageNo}`, { headers: auth })).json();
    const batch = body.items ?? (Array.isArray(body) ? body : []);
    items.push(...batch);
    const total = body.page?.total ?? items.length;
    if (!batch.length || items.length >= total || pageNo > 40) break;
  }
  console.log(`  ${items.length} orders known`);
  const byRef = (r) => items.find((o) => o.orderReference === r);

  for (const [ref, name] of [[env.SHOT_COMPLETED ?? 'ORD-000005', 'web-order-timeline-completed'],
                             [env.SHOT_CANCELLED ?? 'ORD-000006', 'web-order-timeline-compensated']]) {
    const order = byRef(ref);
    const id = order?.orderId ?? order?.id;
    if (!id) { console.log(`  !! ${ref} not found via the API — skipped ${name}`); continue; }
    await page.goto(`${WEB}/orders/${id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900); // let the SSE timeline settle
    await shot(page, name, { fullPage: true });
  }

  for (const [route, name] of [['/billing', 'web-billing'], ['/stock', 'web-stock']]) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await shot(page, name);
  }

  // ── Mailpit ──────────────────────────────────────────────────────────
  console.log('mailpit…');
  await page.goto(MAILPIT, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, 'mailpit-inbox');

  // ── Jaeger ───────────────────────────────────────────────────────────
  console.log('jaeger…');
  // Ranked by DISTINCT SERVICES first, span count second. Querying by
  // `service=gateway` looks like the obvious root-first choice and is a
  // trap: it returns a flood of single-span health-check and SSE traces
  // that outnumber the real ones, and picking "most spans" among those
  // still yields a 1-span picture of nothing. A saga trace is identified
  // by the boundaries it CROSSES, so rank on that directly.
  const candidates = [];
  for (const svc of ['orders', 'gateway', 'billing', 'fulfillment']) {
    const res = await fetch(`${JAEGER}/api/traces?service=${svc}&limit=40&lookback=12h`).catch(() => null);
    if (!res?.ok) continue;
    for (const t of (await res.json()).data ?? []) {
      const services = new Set(Object.values(t.processes ?? {}).map((pr) => pr.serviceName));
      candidates.push({ traceID: t.traceID, spans: t.spans?.length ?? 0, services: services.size, names: [...services].sort() });
    }
  }
  candidates.sort((a, b) => b.services - a.services || b.spans - a.spans);
  const best = candidates[0];
  if (best && best.services > 1) {
    console.log(`  trace ${best.traceID} — ${best.spans} spans across ${best.services} services: ${best.names.join(', ')}`);
    await page.goto(`${JAEGER}/trace/${best.traceID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await shot(page, 'jaeger-single-order-trace', { fullPage: true });
  } else {
    console.log('  !! no multi-service trace in the last 12h — place an order, then re-run');
  }

  // ── Grafana ──────────────────────────────────────────────────────────
  console.log('grafana…');
  await page.goto(`${GRAFANA}/login`, { waitUntil: 'networkidle' });
  if (page.url().includes('/login')) {
    await page.locator('input[name="user"]').fill(env.GRAFANA_ADMIN_USER ?? 'admin');
    await page.locator('input[name="password"]').fill(env.GRAFANA_ADMIN_PASSWORD ?? 'admin');
    await page.getByRole('button', { name: /Log in/i }).click();
    await page.waitForTimeout(3000);
  }
  // A 1h window, not 6h: after a restart the older part of a long window is
  // empty and the lines bunch into the right-hand edge. Note that the "Saga
  // duration" panel reads `otc_saga_completion_ms`, which OTel records ONLY
  // when a saga reaches a terminal state — so it legitimately shows "No
  // data" until an order actually completes or is cancelled in the CURRENT
  // process lifetime. That is the metric behaving correctly, not a broken
  // panel; complete one order before capturing if you want that panel full.
  await page.goto(`${GRAFANA}/d/otc-overview?from=now-1h&to=now&kiosk`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(8000); // panels query Prometheus on load
  await shot(page, 'grafana-overview');

  console.log(`\ncaptured ${shots.length} screenshots into docs/screenshots/`);
} finally {
  await ctx.close();
  await browser.close();
}
