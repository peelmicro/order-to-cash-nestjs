/**
 * Records the compensation demo as a GIF for the README: place a `.99`
 * order, watch the saga reserve stock, get the credit rejected, release the
 * stock back and cancel the order — live, in the real UI, over SSE.
 *
 * Two browser contexts on purpose: the first logs in WITHOUT video so the
 * recording does not open on a password field; the second replays that
 * session state and records only the part worth showing.
 *
 * Output: docs/screenshots/demo-compensation.gif (via ffmpeg, which must be
 * on PATH — `sudo apt install ffmpeg`).
 */
import { readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = require('@playwright/test');

const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* optional */ }

const WEB = `http://localhost:${env.WEB_PORT ?? 3000}`;
const OUT = join(ROOT, 'docs', 'screenshots');
const VIDEO_DIR = join(ROOT, '.demo-video');
mkdirSync(OUT, { recursive: true });
rmSync(VIDEO_DIR, { recursive: true, force: true });

const browser = await chromium.launch();

// 1 — log in off-camera
const auth = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lp = await auth.newPage();
await lp.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
await lp.locator('#username').fill(env.GATEWAY_OPERATOR_USERNAME ?? 'operator');
await lp.locator('#password').fill(env.GATEWAY_OPERATOR_PASSWORD ?? '');
await lp.getByRole('button', { name: 'Sign in' }).click();
await lp.waitForURL(/\/orders$/, { timeout: 30_000 });
const state = await auth.storageState();
await auth.close();

// 2 — the demo, on camera
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: state,
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();

console.log('recording the .99 compensation demo…');
await page.goto(`${WEB}/orders/place`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

await page.getByRole('button', { name: /Fill demo order/ }).click();
await page.waitForTimeout(1500);

await page.getByRole('button', { name: 'Place order', exact: true }).click();
const success = page.getByTestId('place-order-success');
await success.waitFor({ timeout: 30_000 });
const ref = (await success.innerText()).match(/Order (ORD-\d+) accepted/)?.[1];
console.log(`  placed ${ref}`);
await page.waitForTimeout(1200);

await page.getByRole('link', { name: 'order list' }).click();
await page.waitForURL(/\/orders$/, { timeout: 30_000 });
const link = page.getByRole('link', { name: ref });
await link.first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(800);
await link.first().click();
await page.waitForURL(/\/orders\/[0-9a-f-]+$/, { timeout: 30_000 });

// The point of the recording: the timeline filling in over SSE and the
// status landing on `cancelled` with the compensation entries visible.
await page.getByTestId('order-detail-status').filter({ hasText: 'cancelled' })
  .waitFor({ timeout: 60_000 })
  .catch(() => console.log('  !! did not reach cancelled in 60s — recording what happened anyway'));
await page.waitForTimeout(3500);

await ctx.close();
await browser.close();

// 3 — webm -> gif
const webm = join(VIDEO_DIR, readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm')));
const gif = join(OUT, 'demo-compensation.gif');
const palette = join(VIDEO_DIR, 'palette.png');
const vf = 'fps=10,scale=960:-1:flags=lanczos';
execFileSync('ffmpeg', ['-y', '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, palette], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-y', '-i', webm, '-i', palette, '-lavfi', `${vf},paletteuse=dither=bayer:bayer_scale=3`, gif], { stdio: 'ignore' });
rmSync(VIDEO_DIR, { recursive: true, force: true });
console.log(`  wrote ${gif}`);
