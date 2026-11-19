// UI-02 (client UI feedback): the data freshness badge. The browser's clock is
// set to just after the e2e server's newest minute, so the made-up bars are
// current; then moved on to show the badge turn to Delayed.

import { expect, test } from '@playwright/test';

/** The e2e server's NOW: minute 0 starts here. */
const NOW_MS = 1_794_312_000_000;

test('the badge says Live with fresh data, and Delayed when updates stop', async ({ page }) => {
  await page.clock.install({ time: NOW_MS + 20_000 });
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');

  const badge = page.getByTestId('freshness');
  await expect(badge).toHaveAttribute('data-level', 'live');
  await expect(badge).toContainText(/Live · updated \ds ago/);
  await expect(badge).toHaveAttribute('title', /Connected · newest bar 2026-11-10 \d\d:\d\d UTC/);

  // No update for 100 s: delayed.
  await page.clock.fastForward(100_000);
  await expect(badge).toHaveAttribute('data-level', 'delayed');
  await expect(badge).toContainText('Delayed · updated 1m ago');
});
