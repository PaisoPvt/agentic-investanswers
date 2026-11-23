// M2-11 done-check, with our own test page standing in for the client's
// (decision record F-05): the chart loads inside a page on an allowed origin
// (config/embed.json `local`: http://127.0.0.1:4175) and the browser refuses
// to show it inside a page on any other origin (here :4176). Both pages are
// embed-test/index.html; see playwright.config.ts.

import { expect, test } from '@playwright/test';

const ALLOWED = 'http://127.0.0.1:4175/';
const OTHER = 'http://127.0.0.1:4176/';

test('the chart loads, compact and on the requested instrument, inside an allowed site', async ({ page }) => {
  await page.goto(ALLOWED);
  const chart = page.frameLocator('[data-testid="embedded-chart"]');
  await expect(chart.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect(chart.getByTestId('status')).toHaveAttribute('data-connection', 'open');
  await expect(chart.getByTestId('instrument')).toHaveValue('ETHUSD');
  await expect(chart.getByTestId('tf-1h')).toHaveAttribute('aria-pressed', 'true');
  // Compact: pickers, chart and status only.
  await expect(chart.locator('[data-embed="true"]')).toHaveCount(1);
  await expect(chart.getByTestId('import-tradingview')).toHaveCount(0);
});

test('the browser refuses to show the chart inside a site that is not allowed', async ({ page }) => {
  await page.goto(OTHER);
  // Chromium replaces a frame refused by frame-ancestors with its own error page.
  await expect.poll(() => page.frames().find((f) => f !== page.mainFrame())?.url()).toMatch(/^chrome-error:/);
  await expect(page.frameLocator('[data-testid="embedded-chart"]').getByTestId('status')).toHaveCount(0);
});

test('the chart opened directly still works, as the full chart', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect(page.locator('[data-embed="false"]')).toHaveCount(1);
});
