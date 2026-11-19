// UI-01 (client UI feedback): the drawing panel. Through the real browser and
// the built chart against the platform's e2e server: a trend line placed with
// two clicks stays through a reload and a timeframe change, belongs to its
// instrument, can be selected and deleted; a text note asks for its text;
// lock and delete all behave.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

interface Drawn {
  readonly name: string;
  readonly points: number;
  readonly lock: boolean;
  readonly visible: boolean;
  readonly text: unknown;
}

/** The trader's drawings on the chart, read from KLineChart. */
function drawings(page: Page): Promise<Drawn[]> {
  return page.evaluate(() =>
    (window.__aiaChart?.getOverlays({ groupId: 'aia-drawings' }) ?? []).map((o) => ({
      name: o.name,
      points: o.points.length,
      lock: o.lock,
      visible: o.visible,
      text: o.extendData,
    })),
  );
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
}

/** Clicks the chart at a fraction of its width and height. */
async function clickChart(page: Page, x: number, y: number): Promise<void> {
  const box = await page.getByTestId('chart').boundingBox();
  if (box === null) throw new Error('no chart');
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

test.beforeEach(async ({ page }) => {
  // Each test starts with no saved drawings.
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
});

test('a trend line is placed with two clicks, stays through reload and timeframes, and belongs to its instrument', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('drawing-panel')).toBeVisible();

  await page.getByTestId('draw-segment').click();
  await expect(page.getByTestId('draw-segment')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('drawing-hint')).toContainText('Trend line: click 2 points');
  await clickChart(page, 0.3, 0.4);
  await clickChart(page, 0.6, 0.6);
  await expect(page.getByTestId('draw-segment')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('drawing-hint')).toHaveCount(0);
  await expect.poll(() => drawings(page)).toEqual([{ name: 'segment', points: 2, lock: false, visible: true, text: undefined }]);

  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(async () => (await drawings(page)).map((d) => d.name)).toEqual(['segment']);

  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  expect((await drawings(page)).map((d) => d.name)).toEqual(['segment']);

  await page.getByTestId('instrument').selectOption('ETHUSD');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  expect(await drawings(page)).toEqual([]);

  await page.getByTestId('instrument').selectOption('BTCUSD');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  expect((await drawings(page)).map((d) => d.name)).toEqual(['segment']);
});

test('Esc cancels a drawing being placed', async ({ page }) => {
  await open(page);
  await page.getByTestId('draw-aiaRectangle').click();
  await clickChart(page, 0.3, 0.3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('draw-aiaRectangle')).toHaveAttribute('aria-pressed', 'false');
  expect(await drawings(page)).toEqual([]);
});

test('a selected drawing is deleted with Delete, but not while drawings are locked', async ({ page }) => {
  await open(page);
  await page.getByTestId('draw-horizontalStraightLine').click();
  await clickChart(page, 0.5, 0.5);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);

  // Select it by clicking on the line.
  await clickChart(page, 0.4, 0.5);
  await page.getByTestId('draw-lock').click();
  await expect.poll(async () => (await drawings(page))[0]?.lock).toBe(true);
  await expect(page.getByTestId('draw-clear')).toBeDisabled();
  await page.keyboard.press('Delete');
  expect(await drawings(page)).toHaveLength(1);

  await page.getByTestId('draw-lock').click();
  await clickChart(page, 0.4, 0.5);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
});

test('a text note asks for its text; hide and delete all work', async ({ page }) => {
  await open(page);
  await page.getByTestId('draw-aiaNote').click();
  await clickChart(page, 0.5, 0.4);
  await expect(page.getByTestId('note-dialog')).toBeVisible();
  await page.getByTestId('note-text').fill('Breakout');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('note-dialog')).toHaveCount(0);
  await expect.poll(() => drawings(page)).toEqual([{ name: 'aiaNote', points: 1, lock: false, visible: true, text: 'Breakout' }]);

  await page.getByTestId('draw-fibonacciLine').click();
  await clickChart(page, 0.2, 0.7);
  await clickChart(page, 0.7, 0.3);
  await expect.poll(async () => (await drawings(page)).map((d) => d.name)).toEqual(['aiaNote', 'fibonacciLine']);

  await page.getByTestId('draw-hide').click();
  await expect.poll(async () => (await drawings(page)).every((d) => !d.visible)).toBe(true);
  await page.getByTestId('draw-hide').click();

  await page.getByTestId('draw-clear').click();
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  expect(await drawings(page)).toEqual([]);
});
