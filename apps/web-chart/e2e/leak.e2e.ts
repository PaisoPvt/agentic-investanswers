// M3-08 done-check (browser side): no indicator internals reach the browser
// (CLAUDE.md rule 5). The chart uses the e2e server's canary indicator
// (apps/platform/src/leak-canary-indicator.ts) while every HTTP response and
// WebSocket frame is recorded; then every script and stylesheet the chart
// loads is fetched. None may hold the canary's internal markers, the names of
// the indicator engine's internals, or the private indicators repository's name.

import { expect, test } from '@playwright/test';

/** From the canary's state and code (kept in step with LEAK_CANARY_MARKERS). */
const CANARY = ['leakCanaryInternalState', 'leakCanaryRunningTotal', 'LEAK-CANARY-SECRET-7f3a', '271828.18'];
/** The engine's own names; string literals survive minification, identifiers may not, so the canary is the strong check. */
const ENGINE = ['IndicatorEngine', 'IndicatorRegistry', 'state-codec', 'StateCodec', 'stepping', 'priceFromSource', 'assertValidDefinition', 'OutputCache'];
const PRIVATE_REPO = 'agentic-investanswers-indicators';

test('no indicator internals in any response, WebSocket frame or the chart bundle', async ({ page, request }) => {
  const seen: { where: string; text: string }[] = [];
  page.on('response', async (response) => {
    try {
      seen.push({ where: `${response.request().method()} ${response.url()}`, text: await response.text() });
    } catch {
      // Redirects and aborted requests have no body.
    }
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => seen.push({ where: `ws in ${ws.url()}`, text: String(frame.payload) }));
    ws.on('framesent', (frame) => seen.push({ where: `ws out ${ws.url()}`, text: String(frame.payload) }));
  });

  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await page.getByTestId('indicators').selectOption('leakCanary');
  await page.getByTestId('settings-apply').click();
  await expect(page.getByTestId('indicator-chip-leakCanary')).toBeVisible();
  await page.getByTestId('edit-indicator-leakCanary').click();
  await page.getByTestId('setting-offset').fill('1.5');
  await page.getByTestId('settings-apply').click();
  await expect(page.getByTestId('indicator-chip-leakCanary')).toContainText('1.5');
  await page.getByTestId('tf-1h').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');
  await expect.poll(() => seen.filter((s) => s.where.includes('/indicators/leakCanary/outputs')).length).toBeGreaterThanOrEqual(2);
  expect(seen.some((s) => s.where.startsWith('ws in'))).toBe(true);

  // Every script and stylesheet the page loaded, fetched again in full.
  const assets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"], link[rel="modulepreload"]')].map((e) =>
      'src' in e ? e.src : e.href,
    ),
  );
  expect(assets.length).toBeGreaterThan(0);
  for (const url of assets) seen.push({ where: `bundle ${url}`, text: await (await request.get(url)).text() });

  const found: string[] = [];
  for (const { where, text } of seen) {
    for (const marker of CANARY) if (text.includes(marker)) found.push(`${where}: canary "${marker}"`);
    if (text.includes(PRIVATE_REPO)) found.push(`${where}: "${PRIVATE_REPO}"`);
    if (where.startsWith('bundle')) for (const name of ENGINE) if (text.includes(name)) found.push(`${where}: engine "${name}"`);
  }
  expect(found).toEqual([]);
});
