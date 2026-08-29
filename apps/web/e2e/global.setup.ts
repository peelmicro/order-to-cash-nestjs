import { expect, test as setup } from '@playwright/test';

/**
 * Logs in ONCE, through the real UI (`/login`, the real form, the real
 * `POST /api/auth/login` → Gateway round trip), and saves the resulting
 * sealed session cookie as Playwright's `storageState`. Every other spec
 * file's `chromium` project depends on this project (see
 * `playwright.config.ts`), so the login flow itself is still exercised for
 * real exactly once per suite run, and every scenario spec starts already
 * authenticated rather than re-deriving the same login three times.
 */
const STORAGE_STATE = './e2e/.auth/operator.json';

setup('authenticate as the operator', async ({ page }) => {
  const username = process.env.GATEWAY_OPERATOR_USERNAME ?? 'operator';
  const password = process.env.GATEWAY_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error('GATEWAY_OPERATOR_PASSWORD is not set — run via `pnpm --filter @otc/web run test:e2e` (loads the root .env) or export it directly.');
  }

  await page.goto('/login');

  const usernameField = page.locator('#username');
  const passwordField = page.locator('#password');
  await usernameField.fill(username);
  await passwordField.fill(password);

  const submit = page.getByRole('button', { name: 'Sign in' });
  await expect(submit).toBeEnabled();
  await submit.click();

  // Terminal evidence of a successful login: real navigation away from
  // /login into the authenticated area (the global auth middleware redirects
  // any unauthenticated request straight back to /login otherwise).
  await expect(page).toHaveURL(/\/orders$/);

  await page.context().storageState({ path: STORAGE_STATE });
});
