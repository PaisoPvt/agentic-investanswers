// M2-06 done-check: scrolling the chart back loads older history, page by
// page, back 2 years without gaps, and stops at the first stored bar. Through
// the real browser and the e2e server's made-up history (2 years and a month
// before its NOW, apps/platform/src/e2e-server.ts).

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const PLATFORM = 'http://127.0.0.1:8181';
/** The e2e server's NOW, and its first stored bar (2 * 365 + 31 days before). */
const NOW_MS = 1_794_312_000_000;
const FIRST_MS = NOW_MS - (2 * 365 + 31) * 86_400_000;
const HOUR_MS = 3_600_000;
const TWO_YEARS_MS = 2 * 365 * 86_400_000;

/** The open times of the bars the chart holds, oldest first. */
const times = (page: Page) => page.evaluate(() => (window.__aiaChart?.getDataList() ?? []).map((d) => d.timestamp));

test.describe.configure({ mode: 'serial' });

test('scrolling back loads 2 years of BTC 1h history without gaps, then stops at the first stored bar', async ({ page, request }) => {
  test.setTimeout(120_000);
  const older: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/bars?') && r.url().includes('before=')) older.push(r.url());
  });

  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-connection', 'open');
  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await times(page)).length).toBe(500);
  expect(older).toEqual([]);

  // A real drag to the right (into the past) reaches the left edge and loads an older page.
  const box = await page.getByTestId('chart').boundingBox();
  if (box === null) throw new Error('chart not laid out');
  const y = box.y + box.height / 3;
  for (let i = 0; i < 12 && (await times(page)).length === 500; i++) {
    await page.mouse.move(box.x + 50, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 50, y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => (await times(page)).length).toBeGreaterThan(500);
  expect(older[0]).toContain('limit=1000');

  // Then keep showing the oldest bar until history runs out.
  let count = 0;
  for (let i = 0; i < 40; i++) {
    count = (await times(page)).length;
    await page.evaluate(() => window.__aiaChart?.scrollToDataIndex(0, 0));
    try {
      await expect.poll(async () => (await times(page)).length, { timeout: 2_000 }).toBeGreaterThan(count);
    } catch {
      break;
    }
  }

  const held = await times(page);
  const newest = held.at(-1) ?? 0;
  expect(held[0]).toBe(FIRST_MS);
  expect(newest - (held[0] ?? newest)).toBeGreaterThanOrEqual(TWO_YEARS_MS);
  // Every step is exactly one hour: no gap, no bar twice, oldest first.
  const steps = new Set(held.slice(1).map((t, i) => t - (held[i] as number)));
  expect([...steps]).toEqual([HOUR_MS]);
  expect(held).toHaveLength((newest - FIRST_MS) / HOUR_MS + 1);

  // At the first stored bar nothing more is asked for.
  const asked = older.length;
  await page.evaluate(() => window.__aiaChart?.scrollToDataIndex(0, 0));
  await page.waitForTimeout(500);
  expect(older).toHaveLength(asked);

  // Live updates still land on the newest bar.
  expect((await request.post(`${PLATFORM}/e2e/trade`, { data: { instrument: 'BTCUSD', minute: 5, close: 92_345.5 } })).ok()).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__aiaChart?.getDataList().at(-1)?.close))
    .toBe(92_345.5);
  expect((await times(page))[0]).toBe(FIRST_MS);
});
