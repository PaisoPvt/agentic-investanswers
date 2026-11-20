import { describe, expect, it } from 'vitest';

import { LatencyProbe, percentile } from './latency-probe.js';

describe('percentile (nearest rank)', () => {
  it('picks the value at the rank', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(twenty, 50)).toBe(1_000);
    expect(percentile(twenty, 95)).toBe(1_900);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('LatencyProbe', () => {
  it('summarises each instrument and stage, then starts a new period', () => {
    const probe = new LatencyProbe();
    for (const ms of [900, 800, 1_000, 700]) probe.record('ETHUSD', 'stored', ms);
    probe.record('BTCUSD', 'stored', 500);
    probe.record('BTCUSD', 'served', 650);
    probe.record('BTCUSD', 'stored', -20);
    expect(probe.summary()).toEqual([
      { symbol: 'BTCUSD', stored: { count: 2, p50: 0, p95: 500, max: 500 }, served: { count: 1, p50: 650, p95: 650, max: 650 } },
      { symbol: 'ETHUSD', stored: { count: 4, p50: 800, p95: 1_000, max: 1_000 } },
    ]);
    expect(probe.summary()).toEqual([]);
  });
});
