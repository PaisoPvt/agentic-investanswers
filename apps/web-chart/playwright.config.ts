// End-to-end tests for the chart (M2-05): the built chart, served by Vite's
// preview server, against the platform's e2e server (made-up bars, a live
// feed the tests drive; apps/platform/src/e2e-server.ts). No Redis, S3,
// DynamoDB or provider needed.
//
//   pnpm e2e

import { defineConfig, devices } from '@playwright/test';

const PLATFORM_PORT = 8181;
const CHART_PORT = 4173;
// A second platform with the real sign-in, and the chart in front of it (M2-14).
const SIGN_IN_PLATFORM_PORT = 8182;
const SIGN_IN_CHART_PORT = 4174;
const SIGN_IN_OUT_DIR = 'node_modules/.cache/e2e-sign-in';
// The embed test page (M2-11) on an origin config/embed.json allows, and on one it does not.
const EMBED_ALLOWED_PORT = 4175;
const EMBED_OTHER_PORT = 4176;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // The tests share one live feed, in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${CHART_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: ['**/sign-in.e2e.ts', '**/embed.e2e.ts'] },
    { name: 'sign-in', use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${SIGN_IN_CHART_PORT}` }, testMatch: '**/sign-in.e2e.ts' },
    { name: 'embed', use: { ...devices['Desktop Chrome'] }, testMatch: '**/embed.e2e.ts' },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx ../platform/src/e2e-server.ts',
      url: `http://127.0.0.1:${PLATFORM_PORT}/health`,
      env: { AIA_PORT: String(PLATFORM_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${CHART_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${CHART_PORT}`,
      env: { AIA_PLATFORM_URL: `http://127.0.0.1:${PLATFORM_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec tsx ../platform/src/e2e-server.ts --sign-in',
      url: `http://127.0.0.1:${SIGN_IN_PLATFORM_PORT}/health`,
      env: { AIA_PORT: String(SIGN_IN_PLATFORM_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite build --outDir ${SIGN_IN_OUT_DIR} && pnpm exec vite preview --outDir ${SIGN_IN_OUT_DIR} --port ${SIGN_IN_CHART_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${SIGN_IN_CHART_PORT}`,
      env: { AIA_PLATFORM_URL: `http://127.0.0.1:${SIGN_IN_PLATFORM_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    ...[EMBED_ALLOWED_PORT, EMBED_OTHER_PORT].map((port) => ({
      command: `node embed-test/serve.mjs ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
    })),
  ],
});
