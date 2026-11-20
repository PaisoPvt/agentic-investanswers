import { describe, expect, it } from 'vitest';

import type { Observation } from './freshness-report.js';
import { freshnessReport, parseThresholds, reportMarkdown } from './freshness-report.js';
import type { FreshnessProbes } from './freshness-watch.js';
import { watchFreshness } from './freshness-watch.js';

const THRESHOLDS = { storage: 5, cache: 5, chart: 5 };

describe('freshness report (M2-07)', () => {
  it('gives p50, p95 and max per instrument and step, and fails over the threshold or on a missing minute', () => {
    const obs: Observation[] = [
      ...[800, 1_200, 900].map((ms, i) => ({ symbol: 'BTCUSD', minute: i * 60, step: 'cache' as const, ms })),
      ...[2_000, 6_500].map((ms, i) => ({ symbol: 'BTCUSD', minute: i * 60, step: 'chart' as const, ms })),
      { symbol: 'ETHUSD', minute: 0, step: 'cache', ms: 700 },
      { symbol: 'ETHUSD', minute: 60, step: 'cache', ms: undefined },
    ];
    const report = freshnessReport(obs, THRESHOLDS);
    expect(report.rows.map((r) => [r.symbol, r.step, r.count, r.missing, r.p50 ?? null, r.p95 ?? null, r.pass ?? null])).toEqual([
      ['BTCUSD', 'storage', 0, 0, null, null, null],
      ['BTCUSD', 'cache', 3, 0, 900, 1_200, true],
      ['BTCUSD', 'chart', 2, 0, 2_000, 6_500, false],
      ['ETHUSD', 'storage', 0, 0, null, null, null],
      ['ETHUSD', 'cache', 1, 1, 700, 700, false],
      ['ETHUSD', 'chart', 0, 0, null, null, null],
    ]);
    expect(report.pass).toBe(false);
    const md = reportMarkdown(report, 'Freshness, local');
    expect(md).toContain('Overall: **FAIL**');
    expect(md).toContain('| BTCUSD | chart | 2 | 0 | 2.0 s | 6.5 s | 6.5 s | 5.0 s | FAIL |');
    expect(md).toContain('| BTCUSD | storage | 0 | 0 | - | - | - | 5.0 s | not measured |');
  });

  it('passes when every measured step is within its threshold', () => {
    expect(freshnessReport([{ symbol: 'BTCUSD', minute: 0, step: 'cache', ms: 400 }], THRESHOLDS).pass).toBe(true);
  });

  it('reads the thresholds and refuses bad ones', () => {
    expect(parseThresholds({ p95Seconds: { storage: 5, cache: 4, chart: 3 } })).toEqual({ storage: 5, cache: 4, chart: 3 });
    expect(() => parseThresholds({ p95Seconds: { storage: 5, cache: 0, chart: 3 } })).toThrow('p95Seconds.cache');
    expect(() => parseThresholds({})).toThrow();
  });
});

describe('watching freshness (M2-07)', () => {
  /** A fake clock for concurrent loops: time jumps to the next sleeper once everything is waiting; events fire as time passes them. */
  function clock(startMs: number) {
    let now = startMs;
    const sleepers: { at: number; wake: () => void }[] = [];
    const events: { at: number; run: () => void }[] = [];
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    return {
      nowMs: () => now,
      sleep: (ms: number) => new Promise<void>((wake) => sleepers.push({ at: now + Math.max(1, ms), wake })),
      // An event is also a moment time stops at, as a real message arrives exactly then.
      at: (ms: number, run: () => void) => {
        events.push({ at: ms, run });
        sleepers.push({ at: ms, wake: () => undefined });
      },
      async run<T>(work: Promise<T>): Promise<T> {
        let done = false;
        let result: T | undefined;
        void work.then((value) => ((done = true), (result = value)));
        for (;;) {
          await flush();
          if (done) return result as T;
          sleepers.sort((a, b) => a.at - b.at);
          const next = sleepers.shift();
          if (next === undefined) continue;
          now = next.at;
          for (const e of events.filter((e) => e.at <= now)) {
            events.splice(events.indexOf(e), 1);
            e.run();
          }
          next.wake();
          // Everyone due at the same time wakes together.
          while (sleepers[0] !== undefined && sleepers[0].at <= now) sleepers.shift()?.wake();
        }
      },
    };
  }

  it('times each step from the minute\'s close, and counts a minute that never comes as missing', async () => {
    // Start 10 s into a minute: the first watched minute opens at 60 s (it closes at 120 s); the second at 120 s.
    const c = clock(70_000);
    const stored = new Map<number, number>([[60, 120_800], [120, 180_900]]);
    const cached = new Map<number, number>([[60, 121_000]]); // minute 120 never reaches the cache
    let seen: ((symbol: string, minute: number) => void) | undefined;
    const probes: FreshnessProbes = {
      chart: (s) => ((seen = s), Promise.resolve(() => undefined)),
      cache: (_symbol, minute) => Promise.resolve((cached.get(minute) ?? Infinity) <= c.nowMs()),
      storage: (_symbol, minute) => Promise.resolve((stored.get(minute) ?? Infinity) <= c.nowMs()),
    };
    c.at(121_500, () => seen?.('BTCUSD', 60));
    c.at(181_200, () => seen?.('BTCUSD', 120));
    const obs = await c.run(watchFreshness(probes, { symbols: ['BTCUSD'], minutes: 2, nowMs: c.nowMs, sleep: c.sleep, pollMs: { cache: 250, storage: 1_000 }, giveUpMs: 10_000 }));
    const by = (step: string, minute: number) => obs.find((o) => o.step === step && o.minute === minute)?.ms;
    expect(by('storage', 60)).toBe(1_000);
    expect(by('cache', 60)).toBe(1_000);
    expect(by('chart', 60)).toBe(1_500);
    expect(by('storage', 120)).toBe(1_000);
    expect(by('cache', 120)).toBeUndefined();
    expect(by('chart', 120)).toBe(1_200);
  });

  it('ignores live bars of minutes it is not watching, and keeps the first arrival', async () => {
    const c = clock(70_000);
    let seen: ((symbol: string, minute: number) => void) | undefined;
    const probes: FreshnessProbes = {
      chart: (s) => ((seen = s), Promise.resolve(() => undefined)),
      cache: () => Promise.resolve(true),
    };
    c.at(119_000, () => seen?.('BTCUSD', 0));
    c.at(120_400, () => seen?.('BTCUSD', 60));
    c.at(125_000, () => seen?.('BTCUSD', 60));
    const obs = await c.run(watchFreshness(probes, { symbols: ['BTCUSD'], minutes: 1, nowMs: c.nowMs, sleep: c.sleep, giveUpMs: 10_000 }));
    expect(obs.filter((o) => o.step === 'chart')).toEqual([{ symbol: 'BTCUSD', minute: 60, step: 'chart', ms: 400 }]);
    expect(obs.some((o) => o.step === 'storage')).toBe(false);
  });
});
