// UI-03 (client UI feedback): importing TradingView exports. Chart data is
// drawn over our bars with a match report, and a watchlist opens beside the
// chart. The test makes its "TradingView" file from the chart's own 5m bars,
// with one close changed, so the report is known.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
}

function upload(page: Page, name: string, text: string) {
  return page.getByTestId('import-file').setInputFiles({ name, mimeType: name.endsWith('.csv') ? 'text/csv' : 'text/plain', buffer: Buffer.from(text) });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
});

test('chart data is drawn over the bars with a match report, on its instrument and timeframe', async ({ page }) => {
  await open(page);
  await page.getByTestId('tf-5m').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  const bars = await page.evaluate(() => (window.__aiaChart?.getDataList() ?? []).map((b) => [b.timestamp / 1000, b.open, b.high, b.low, b.close, b.volume ?? 0]));
  expect(bars.length).toBeGreaterThan(10);
  const changed = bars.length - 3;
  const csv = [
    'time,open,high,low,close,Plot,Volume',
    ...bars.map(([t, o, h, l, c, v], i) => [t, o, h, l, i === changed ? Number(c) + 1 : c, Number(c) - 5, v].join(',')),
  ].join('\n');

  // Imported from another timeframe: the chart moves to the file's.
  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await upload(page, 'COINBASE_BTCUSD, 5.csv', csv);
  await expect(page.getByTestId('tf-5m')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('import-chip')).toContainText('TradingView BTCUSD 5m');
  await expect(page.getByTestId('import-report')).toContainText(`${bars.length - 1} of ${bars.length} bars match · first difference`);
  await expect(page.getByTestId('import-report')).toContainText('close');

  // Drawn as lines: the file's close and its plot.
  const drawn = await page.evaluate(() => {
    const indicator = window.__aiaChart?.getIndicators({ id: 'tv-import' })[0];
    const rows = (indicator?.result ?? []) as Partial<Record<string, number>>[];
    return { figures: indicator?.figures.map((f) => f.key), last: rows.at(-1) };
  });
  expect(drawn.figures).toEqual(['close', 'plot0']);
  expect(drawn.last?.['close']).toBe(bars.at(-1)?.[4]);

  // Another timeframe hides it, with a way back.
  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('import-goto')).toHaveText('Show on BTCUSD 5m');
  expect(await page.evaluate(() => window.__aiaChart?.getIndicators({ id: 'tv-import' }).length)).toBe(0);
  await page.getByTestId('import-goto').click();
  await expect(page.getByTestId('import-report')).toContainText('bars match');

  await page.getByTestId('import-remove').click();
  await expect(page.getByTestId('import-bar')).toHaveCount(0);
  expect(await page.evaluate(() => window.__aiaChart?.getIndicators({ id: 'tv-import' }).length)).toBe(0);
});

test('a file for an instrument we do not have, or not a TradingView export, is refused with a reason', async ({ page }) => {
  await open(page);
  await upload(page, 'NASDAQ_AAPL, 1D.csv', 'time,open,high,low,close\n1731240000,1,2,0.5,1.5\n');
  await expect(page.getByTestId('import-error')).toContainText('AAPL is not available here');
  await upload(page, 'notes.txt', 'Buy low, sell high!');
  await expect(page.getByTestId('import-error')).toContainText('This is not a TradingView watchlist');
});

test('a watchlist opens beside the chart, opens our instruments, and stays after a reload', async ({ page }) => {
  await open(page);
  await upload(page, 'Crypto and stocks.txt', '###Crypto,COINBASE:BTCUSD,COINBASE:ETHUSD,###Stocks,NASDAQ:NVDA');
  const list = page.getByTestId('watchlist');
  await expect(list).toContainText('Crypto and stocks');
  await expect(list).toContainText('Stocks');
  await expect(page.getByTestId('watch-NASDAQ:NVDA')).toBeDisabled();
  await expect(page.getByTestId('watch-COINBASE:BTCUSD')).toHaveAttribute('aria-current', 'true');

  await page.getByTestId('watch-COINBASE:ETHUSD').click();
  await expect(page.getByTestId('instrument')).toHaveValue('ETHUSD');
  await expect(page.getByTestId('watch-COINBASE:ETHUSD')).toHaveAttribute('aria-current', 'true');

  await page.reload();
  await expect(page.getByTestId('watchlist')).toContainText('Crypto and stocks');
  await page.getByTestId('watchlist-remove').click();
  await expect(page.getByTestId('watchlist')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect(page.getByTestId('watchlist')).toHaveCount(0);
});
