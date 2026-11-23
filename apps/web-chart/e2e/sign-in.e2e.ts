// M2-14 done-check: the chart's sign-in screens against a platform running the
// real sign-in (the e2e server with --sign-in, in-memory accounts, every
// account on a plan that includes everything; see playwright.config.ts).

import { expect, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

test('sign up, sign out, a wrong password is refused, sign in again', async ({ page }) => {
  const email = `demo-${Date.now()}@example.com`;
  await page.goto('/');

  // Signed out: the screen, not the chart.
  const form = page.getByTestId('sign-in');
  await expect(form).toBeVisible();
  await expect(page.getByTestId('chart')).toHaveCount(0);

  // Create an account: the chart loads with the session and goes live.
  await page.getByTestId('sign-in-switch').click();
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('account-email')).toHaveText(email);
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect(page.getByTestId('status')).toHaveAttribute('data-connection', 'open');

  // The session survives a reload.
  await page.reload();
  await expect(page.getByTestId('account-email')).toHaveText(email);

  // Sign out: back to the screen.
  await page.getByTestId('sign-out').click();
  await expect(form).toBeVisible();
  await expect(page.getByTestId('account-email')).toHaveCount(0);

  // A wrong password: the server's message, still on the screen.
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('not the password');
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('sign-in-error')).toBeVisible();
  await expect(form).toBeVisible();

  // The right password: the chart again.
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('account-email')).toHaveText(email);
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
});

test('creating an account with a short password shows the server rule', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sign-in-switch').click();
  await page.getByTestId('email').fill(`short-${Date.now()}@example.com`);
  await page.getByTestId('password').fill('short');
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('sign-in-error')).toContainText(/10/);
});

// M2-13 done-check: reload restores preferences per user.
test('the chart reopens on each account’s own last instrument and timeframe', async ({ page, browser }) => {
  const signUp = async (email: string) => {
    await page.goto('/');
    await page.getByTestId('sign-in-switch').click();
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(PASSWORD);
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('account-email')).toHaveText(email);
  };

  // A new account opens on the defaults, then picks ETHUSD 1h.
  await signUp(`prefs-a-${Date.now()}@example.com`);
  await expect(page.getByTestId('instrument')).toHaveValue('BTCUSD');
  await expect(page.getByTestId('tf-1m')).toHaveAttribute('aria-pressed', 'true');
  // Saved once, a second after the last change.
  const saved = page.waitForResponse((r) => r.url().endsWith('/preferences') && r.request().method() === 'PUT');
  await page.getByTestId('instrument').selectOption('ETHUSD');
  await page.getByTestId('tf-1h').click();
  expect((await saved).status()).toBe(204);

  // Reload: the same choice, from the server.
  await page.reload();
  await expect(page.getByTestId('instrument')).toHaveValue('ETHUSD');
  await expect(page.getByTestId('tf-1h')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');

  // Another browser with no local state, same account: still ETHUSD 1h, so it is the server's.
  const token = await page.evaluate(() => localStorage.getItem('aia.session'));
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(page.url());
  await other.evaluate((t) => localStorage.setItem('aia.session', t ?? ''), token);
  await other.reload();
  await expect(other.getByTestId('instrument')).toHaveValue('ETHUSD');
  await expect(other.getByTestId('tf-1h')).toHaveAttribute('aria-pressed', 'true');
  await fresh.close();

  // A second account keeps its own: the defaults.
  await page.getByTestId('sign-out').click();
  await signUp(`prefs-b-${Date.now()}@example.com`);
  await expect(page.getByTestId('instrument')).toHaveValue('BTCUSD');
  await expect(page.getByTestId('tf-1m')).toHaveAttribute('aria-pressed', 'true');
});
