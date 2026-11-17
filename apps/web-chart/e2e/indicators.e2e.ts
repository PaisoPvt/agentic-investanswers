// M3-05 (browser side): an indicator chosen in the menu is drawn on the chart
// from the server's output, follows its settings, and can be removed. Through
// the real browser, the built chart and the platform's e2e server, whose
// test-only indicator draws the chosen source price plus `offset`
// (settings-demo-indicator.ts); the real SMA lives in the private indicators
// repo (CLAUDE.md rule 5) and is tested there.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/** The chart's newest bar close and the drawn value on that bar, read from KLineChart. */
function lastDrawn(page: Page) {
  return page.evaluate(() => {
    const chart = window.__aiaChart;
    const indicator = chart?.getIndicators({ name: 'aia-output' })[0];
    const bars = chart?.getDataList() ?? [];
    const rows = (indicator?.result ?? []) as Partial<Record<string, number>>[];
    return {
      shown: chart?.getIndicators({ name: 'aia-output' }).length ?? 0,
      close: bars.at(-1)?.close,
      value: rows.at(-1)?.['value'],
      drawnBars: rows.filter((r) => r['value'] !== undefined).length,
    };
  });
}

test('an indicator is drawn from the server output, follows its settings and can be removed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  expect((await lastDrawn(page)).shown).toBe(0);

  // Add it: the line sits on each bar's close (offset 0), for the newest 500 bars.
  await page.getByTestId('indicators').selectOption('settingsDemo');
  await page.getByTestId('settings-apply').click();
  await expect(page.getByTestId('indicator-chip-settingsDemo')).toContainText('Settings demo (tests only) (20, 0)');
  await expect.poll(async () => (await lastDrawn(page)).drawnBars).toBe(500);
  const added = await lastDrawn(page);
  expect(added.value).toBe(added.close);

  // Change a setting from the chip: the server draws the line 2.5 higher.
  await page.getByTestId('edit-indicator-settingsDemo').click();
  await page.getByTestId('setting-offset').fill('2.5');
  await page.getByTestId('settings-apply').click();
  await expect(page.getByTestId('indicator-chip-settingsDemo')).toContainText('(20, 2.5)');
  await expect.poll(async () => {
    const { value, close } = await lastDrawn(page);
    return value !== undefined && close !== undefined ? Math.round((value - close) * 100) / 100 : undefined;
  }).toBe(2.5);

  // Another timeframe: drawn again from that timeframe's output.
  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => {
    const { value, close } = await lastDrawn(page);
    return value !== undefined && close !== undefined ? Math.round((value - close) * 100) / 100 : undefined;
  }).toBe(2.5);

  // Remove it: off the chart and out of the bar.
  await page.getByTestId('remove-indicator-settingsDemo').click();
  await expect(page.getByTestId('indicator-chip-settingsDemo')).toHaveCount(0);
  await expect.poll(async () => (await lastDrawn(page)).shown).toBe(0);
});
