// M1-08a (browser side): crypto 1D and 1W on the chart, from the History API,
// with the newest bar following live trades, as 1m to 4h do. Through the real
// browser and the e2e server's made-up history (apps/platform/src/e2e-server.ts).
//
// The e2e tests share one live feed, in file order. This file is named to run
// after the others in its project: its trades (minutes 30 and 31) become the
// newest bars, which the chart and scroll-back tests would otherwise see.

import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const PLATFORM = 'http://127.0.0.1:8181';
/** The e2e server's NOW: Tuesday 2026-11-10 12:00 UTC. */
const NOW_MS = 1_794_312_000_000;
const DAY_MS = 86_400_000;

const newest = (page: Page) =>
  page.evaluate(() => {
    const bar = window.__aiaChart?.getDataList().at(-1);
    return bar === undefined ? undefined : { time: bar.timestamp, close: bar.close, count: window.__aiaChart?.getDataList().length ?? 0 };
  });

const trade = (request: APIRequestContext, minute: number, close: number) => request.post(`${PLATFORM}/e2e/trade`, { data: { instrument: 'BTCUSD', minute, close } });

test.describe.configure({ mode: 'serial' });

test('1D and 1W load from history and their newest bar follows live trades', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-connection', 'open');

  // 1D: the newest bar is today (00:00 UTC), with days before it.
  await page.getByTestId('tf-1D').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await newest(page))?.time).toBe(NOW_MS - 12 * 3_600_000);
  expect((await newest(page))?.count).toBeGreaterThan(100);
  expect((await trade(request, 30, 93_210.5)).ok()).toBe(true);
  await expect.poll(async () => (await newest(page))?.close).toBe(93_210.5);

  // 1W: the newest bar is this week, from Monday 00:00 UTC.
  await page.getByTestId('tf-1W').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await newest(page))?.time).toBe(NOW_MS - 12 * 3_600_000 - DAY_MS);
  expect((await trade(request, 31, 93_250.25)).ok()).toBe(true);
  await expect.poll(async () => (await newest(page))?.close).toBe(93_250.25);

  // 1M: the newest bar is this month.
  await page.getByTestId('tf-1M').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await newest(page))?.time).toBe(Date.UTC(2026, 10, 1));
});
