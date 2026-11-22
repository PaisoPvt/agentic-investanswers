// M1-08a: crypto 1D, 1W and 1M cooked with the intraday timeframes. 1D comes
// from the minutes, 1W and 1M from the stored 1D bars; each must equal the
// bar rolled up straight from the minutes, including a week across a year end
// and a month end, and a partial day.

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MemoryCookedWatermarks } from '../adapters/memory-cooked-watermarks.js';
import { partitionOf } from '../domain/cooked-partition.js';
import { rebuildPassed, totalDifferences } from '../adapters/rebuild-report.js';
import { rollUp } from '../domain/roll-up.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import { CALENDAR_ROLLUPS, CookIntraday, INTRADAY_ROLLUPS } from './cook-intraday.js';
import { CookedReader } from './cooked-reader.js';
import { RebuildCheck } from './rebuild-check.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const NVDA: Instrument = { symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ', timeZone: 'America/New_York', priceScale: 2, volumeScale: 0 };

/** Minutes with prices that move, so open, high, low and close all differ by day. */
function minutes(from: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const t = from + i * 60;
    const p = 5_000_000 + ((t / 60) * 7_919) % 90_000;
    return { time: barTime(t), open: price(p), high: price(p + 37), low: price(p - 41), close: price(p + 5), volume: volume(10_000_000 + (t % 9_973)) };
  });
}

class Source implements OneMinuteBarSourcePort {
  constructor(private readonly bars: readonly Bar[]) {}
  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

/** S3's semantics: put replaces each touched partition whole. */
class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.files.set(key, group);
    return Promise.resolve();
  }
  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const all = [...this.files].filter(([k]) => k.startsWith(`${symbol}/${timeframe}/`)).flatMap(([, v]) => v);
    return Promise.resolve(all.filter((b) => b.time >= from && b.time <= until).sort((a, b) => a.time - b.time));
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.files.get(`${symbol}/${timeframe}/${partition}`));
  }
}

// 2025-12-15 (a Monday) to 2026-01-14: a month end, a year end inside the week of Monday 2025-12-29.
const START = barTimeFromUtcParts(2025, 12, 15);
const RAW = minutes(START, 31 * 1_440);
const DAY = 86_400;

describe('cooking 1D, 1W and 1M (M1-08a)', () => {
  it('month by month, every calendar bar equals the one rolled up straight from the minutes', async () => {
    const store = new PartitionStore();
    const cook = new CookIntraday({ source: new Source(RAW), store });
    await cook.cookPartition(BTC, '2025-12');
    await cook.cookPartition(BTC, '2026-01');
    for (const tf of CALENDAR_ROLLUPS) {
      const stored = await store.getRange('BTCUSD', tf, barTimeFromUtcParts(2025, 12, 1), barTime(START + 31 * DAY));
      expect(stored, tf).toEqual(rollUp(BTC, tf, RAW));
    }
    // The week of 2025-12-29 straddles the year end and lives in the 2025 file, built from both months.
    const week = (await store.getPartition('BTCUSD', '1W', '2025'))?.find((b) => b.time === barTimeFromUtcParts(2025, 12, 29));
    expect(week).toEqual(rollUp(BTC, '1W', RAW).find((b) => b.time === barTimeFromUtcParts(2025, 12, 29)));
    expect((await store.getPartition('BTCUSD', '1D', '2026'))?.length).toBe(14);
  });

  it('day by day (the compactor), the same bars, and an unfinished week or month is the bar so far', async () => {
    const store = new PartitionStore();
    const cook = new CookIntraday({ source: new Source(RAW), store });
    const days = 20; // up to 2026-01-03
    for (let d = 0; d < days; d++) await cook.cookRangeAll(BTC, barTime(START + d * DAY), barTime(START + (d + 1) * DAY - 1));
    const settled = RAW.filter((b) => b.time < START + days * DAY);
    for (const tf of CALENDAR_ROLLUPS) {
      expect(await store.getRange('BTCUSD', tf, barTimeFromUtcParts(2025, 12, 1), barTime(START + 31 * DAY)), tf).toEqual(rollUp(BTC, tf, settled));
    }
  });

  it('a re-cook of a month replaces its days and keeps the other months', async () => {
    const store = new PartitionStore();
    await new CookIntraday({ source: new Source(RAW), store }).cookPartition(BTC, '2025-12');
    await new CookIntraday({ source: new Source(RAW), store }).cookPartition(BTC, '2026-01');
    // The raw of 2026-01-02 changes (say a backfill brought the full day); re-cook January only.
    const changed = RAW.map((b) => (b.time >= barTimeFromUtcParts(2026, 1, 2) && b.time < barTimeFromUtcParts(2026, 1, 3) ? { ...b, volume: volume(b.volume * 2) } : b));
    await new CookIntraday({ source: new Source(changed), store }).cookPartition(BTC, '2026-01');
    for (const tf of CALENDAR_ROLLUPS) {
      expect(await store.getRange('BTCUSD', tf, barTimeFromUtcParts(2025, 12, 1), barTime(START + 31 * DAY)), tf).toEqual(rollUp(BTC, tf, changed));
    }
  });

  it('cooks no calendar timeframes for a stock yet (M1-08b)', async () => {
    const store = new PartitionStore();
    const written = await new CookIntraday({ source: new Source([]), store }).cookPartition(NVDA, '2026-01');
    expect([...written.keys()].filter((tf) => CALENDAR_ROLLUPS.includes(tf))).toEqual([]);
    expect([...store.files.keys()].filter((k) => /\/1[DWM]\//.test(k))).toEqual([]);
  });
});

describe('reading 1D, 1W and 1M: settled bars plus the tail (M1-08a)', () => {
  it('equals the bars rolled up from every minute, across the watermark, for each range', async () => {
    // 20 settled days to 2026-01-04 00:00, then ten hours of today (the watermark day, unfinished).
    const settledDays = 20;
    const through = barTime(START + settledDays * DAY);
    const raw = RAW.filter((b) => b.time < through + 600 * 60);
    const store = new PartitionStore();
    const cook = new CookIntraday({ source: new Source(raw), store });
    for (let d = 0; d < settledDays; d++) await cook.cookRangeAll(BTC, barTime(START + d * DAY), barTime(START + (d + 1) * DAY - 1));
    const watermarks = new MemoryCookedWatermarks();
    await watermarks.setWatermark('BTCUSD', through);
    const reader = new CookedReader({ store, watermarks, minutes: new Source(raw), instruments: [BTC], nowMs: () => 0 });
    const ranges: Array<[number, number]> = [
      [barTimeFromUtcParts(2025, 12, 1), through + DAY], // everything
      [through - 3 * DAY, through + DAY], // across the watermark
      [START, through - 1], // settled only
      [through, through + DAY], // tail only
    ];
    for (const tf of CALENDAR_ROLLUPS) {
      for (const [from, until] of ranges) {
        const expected = rollUp(BTC, tf, raw).filter((b) => b.time >= from && b.time <= until);
        expect(await reader.getRange('BTCUSD', tf, barTime(from), barTime(until)), `${tf} ${from}-${until}`).toEqual(expected);
      }
    }
  });
});

describe('rebuild check over 1D, 1W and 1M (M1-08a)', () => {
  const months = ['2025-12', '2026-01'];
  const cooked = async () => {
    const store = new PartitionStore();
    const cook = new CookIntraday({ source: new Source(RAW), store });
    for (const m of months) await cook.cookPartition(BTC, m);
    return store;
  };
  const run = async (store: PartitionStore) =>
    new RebuildCheck({ source: new Source(RAW), store }).run(BTC, months, [...INTRADAY_ROLLUPS, ...CALENDAR_ROLLUPS]);

  it('passes after a clean cook, and compares every calendar timeframe', async () => {
    const results = await run(await cooked());
    expect(rebuildPassed(results)).toBe(true);
    expect(new Set(results.map((r) => r.timeframe))).toEqual(new Set([...INTRADAY_ROLLUPS, ...CALENDAR_ROLLUPS]));
  });

  for (const [tf, partition] of [['1D', '2026'], ['1W', '2025'], ['1M', '2025']] as const) {
    it(`finds a wrong stored ${tf} bar`, async () => {
      const store = await cooked();
      const key = `BTCUSD/${tf}/${partition}`;
      const bars = store.files.get(key) ?? [];
      // The newest whole period of that file gets one unit more volume.
      const target = tf === '1D' ? bars[3] : bars.find((b) => b.time === barTimeFromUtcParts(2025, tf === '1W' ? 12 : 12, tf === '1W' ? 22 : 1));
      expect(target, `${tf} bar to tamper with`).toBeDefined();
      store.files.set(key, bars.map((b) => (b === target ? { ...b, volume: volume(b.volume + 1) } : b)));
      const results = await run(store);
      expect(rebuildPassed(results)).toBe(false);
      expect(results.find((r) => r.timeframe === tf && totalDifferences([r]) > 0)?.partition).toBe(partition);
    });
  }
});
