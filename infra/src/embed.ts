// Which sites may frame the chart (M2-11): config/embed.json, per environment,
// as the Content-Security-Policy `frame-ancestors` header CloudFront adds to
// the chart's responses. The chart's own address is always allowed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../../config/embed.json', import.meta.url));

/** `https://example.com` or `http://127.0.0.1:4175`: a scheme, a host and maybe a port, nothing else. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** The origins allowed to frame the chart in an environment; throws on a malformed entry, so a bad list never deploys. */
export function frameAncestors(environment: string, text = readFileSync(CONFIG, 'utf8')): readonly string[] {
  const lists = (JSON.parse(text) as { frameAncestors?: Record<string, unknown> }).frameAncestors ?? {};
  const list = lists[environment] ?? [];
  if (!Array.isArray(list)) throw new Error(`config/embed.json: frameAncestors.${environment} must be a list of origins`);
  for (const origin of list) {
    if (typeof origin !== 'string' || !ORIGIN.test(origin)) throw new Error(`config/embed.json: "${String(origin)}" in ${environment} is not an origin such as https://example.com`);
  }
  return list as string[];
}

/** The header's value: the chart itself, then the listed sites. */
export function frameAncestorsPolicy(origins: readonly string[]): string {
  return ["frame-ancestors 'self'", ...origins].join(' ');
}
