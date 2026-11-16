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
