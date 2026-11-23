import { describe, expect, it } from 'vitest';

import { frameAncestors, frameAncestorsPolicy } from './embed.js';

const config = (lists: unknown) => JSON.stringify({ frameAncestors: lists });

describe('frameAncestors', () => {
  it('reads the checked-in lists', () => {
    expect(frameAncestors('local')).toEqual(['http://127.0.0.1:4175']);
    expect(frameAncestors('dev')).toEqual([]);
  });

  it('is empty for an environment not listed', () => {
    expect(frameAncestors('qa', config({}))).toEqual([]);
  });

  it('refuses anything but plain origins, so a mistake never deploys', () => {
    for (const bad of ['*', 'https://*.example.com', 'example.com', 'https://example.com/', 'https://example.com/page', "'none'", 'javascript:alert(1)']) {
      expect(() => frameAncestors('prod', config({ prod: [bad] }))).toThrow(/not an origin/);
    }
    expect(() => frameAncestors('prod', config({ prod: 'https://example.com' }))).toThrow(/list/);
  });
});

describe('frameAncestorsPolicy', () => {
  it('always allows the chart itself', () => {
    expect(frameAncestorsPolicy([])).toBe("frame-ancestors 'self'");
    expect(frameAncestorsPolicy(['https://www.example.com', 'https://example.com'])).toBe("frame-ancestors 'self' https://www.example.com https://example.com");
  });
});
