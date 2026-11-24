// The chart's dev server and build (M2-05). REST and the live WebSocket are
// proxied to the platform, so the browser sees one origin (no CORS), as it
// will behind one host on staging (M2-01). AIA_PLATFORM_URL picks the
// platform (default http://127.0.0.1:8080, `pnpm platform`).
// Pages carry the same frame-ancestors header CloudFront adds (M2-11), from
// config/embed.json's `local` list, so the embed e2e tests the real rule.

import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const platform = process.env['AIA_PLATFORM_URL'] ?? 'http://127.0.0.1:8080';
const proxy = {
  '/bars': platform,
  '/instruments': platform,
  '/plan': platform,
  '/indicators': platform,
  '/auth': platform,
  '/preferences': platform,
  '/live': { target: platform, ws: true },
};

const embed = JSON.parse(readFileSync(new URL('../../config/embed.json', import.meta.url), 'utf8')) as { frameAncestors: { local: string[] } };
const headers = { 'Content-Security-Policy': ["frame-ancestors 'self'", ...embed.frameAncestors.local].join(' ') };

export default defineConfig({
  plugins: [react()],
  server: { proxy, headers },
  preview: { proxy, headers },
});
