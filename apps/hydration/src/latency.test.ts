import { describe, expect, it } from 'vitest';

import { LatencyReporter, emfLine, latencyLine } from './latency.js';

describe('live minute latency (M1-11)', () => {
  it('prints p50 and p95 per stage', () => {
    expect(
      latencyLine({ symbol: 'BTCUSD', stored: { count: 15, p50: 820, p95: 1_440, max: 2_000 }, served: { count: 15, p50: 910, p95: 1_600, max: 2_100 } }),
    ).toBe('latency BTCUSD stored p50 0.8 s p95 1.4 s · served p50 0.9 s p95 1.6 s (15 minutes)');
    expect(latencyLine({ symbol: 'NVDA', stored: { count: 1, p50: 3_000, p95: 3_000, max: 3_000 } })).toBe('latency NVDA stored p50 3.0 s p95 3.0 s · served - (1 minute)');
  });

  it('writes a CloudWatch embedded metric line', () => {
    const line = JSON.parse(emfLine('AIA/dev', 'ETHUSD', 'served', 1_234.6, 1_794_312_061_234)) as Record<string, unknown>;
    expect(line).toEqual({
      _aws: { Timestamp: 1_794_312_061_234, CloudWatchMetrics: [{ Namespace: 'AIA/dev', Dimensions: [['Instrument']], Metrics: [{ Name: 'MinuteServedMs', Unit: 'Milliseconds' }] }] },
      Instrument: 'ETHUSD',
      MinuteServedMs: 1_235,
    });
  });

  it('times each minute from its close, and reports per period', () => {
    let now = 0;
    const lines: string[] = [];
    const reporter = new LatencyReporter({ nowMs: () => now, log: (l) => lines.push(l), emfNamespace: 'AIA/dev' });
    // The minute opening at 1,000 s closes at 1,060 s.
    now = 1_060_700;
    reporter.reached('BTCUSD', 'stored', 1_000);
    now = 1_061_200;
    reporter.reached('BTCUSD', 'served', 1_000);
    expect(lines.map((l) => (JSON.parse(l) as Record<string, number>)['MinuteStoredMs'] ?? (JSON.parse(l) as Record<string, number>)['MinuteServedMs'])).toEqual([700, 1_200]);
    lines.length = 0;
    reporter.report();
    expect(lines).toEqual(['latency BTCUSD stored p50 0.7 s p95 0.7 s · served p50 1.2 s p95 1.2 s (1 minute)']);
    lines.length = 0;
    reporter.report();
    expect(lines).toEqual([]);
  });

  it('writes no metric lines without a namespace', () => {
    const lines: string[] = [];
    const reporter = new LatencyReporter({ nowMs: () => 61_000, log: (l) => lines.push(l) });
    reporter.reached('BTCUSD', 'stored', 0);
    expect(lines).toEqual([]);
  });
});
