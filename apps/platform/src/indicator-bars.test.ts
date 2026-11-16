// The indicator engine reads closed bars only (M3-05): the newest stored bar is
// held back while the current instant still falls inside it.

import type { BarsPage, PageQuery } from '@aia/data';
import { BTCUSD, NVDA } from '@aia/data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { IndicatorBars } from './indicator-bars.js';

const HOUR = 3_600;
const T0 = 1_762_790_400; // 2025-11-10 16:00 UTC, a whole 4h boundary

const bar = (time: number): Bar => ({ time: barTime(time), open: price(100), high: price(100), low: price(100), close: price(100), volume: volume(1) });

function source(bars: readonly Bar[]) {
  const pages: PageQuery[] = [];
  return {
    pages,
    data: {
      page: (_i: Instrument, _tf: Timeframe, query: PageQuery): Promise<BarsPage> => {
        pages.push(query);
        return Promise.resolve({ bars: bars.slice(-query.limit), next: null });
      },
      bars: (_i: Instrument, _tf: Timeframe, from: BarTime, until: BarTime) => Promise.resolve(bars.filter((b) => b.time >= from && b.time <= until)),
    },
  };
}

const hours = (count: number) => Array.from({ length: count }, (_, i) => bar(T0 + i * HOUR));

describe('IndicatorBars', () => {
  it('holds back the newest bar while it is forming, and still returns `limit` closed bars', async () => {
    const { data, pages } = source(hours(5));
    const bars = new IndicatorBars({ data, now: () => barTime(T0 + 4 * HOUR + 60) });
    expect((await bars.closedBars(BTCUSD, '1h', { limit: 2 })).map((b) => b.time)).toEqual([T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(pages[0]?.limit).toBe(3);
    expect((await bars.forming(BTCUSD, '1h'))?.time).toBe(T0 + 4 * HOUR);
  });

  it('keeps the newest bar once its hour is over', async () => {
    const { data } = source(hours(5));
    const bars = new IndicatorBars({ data, now: () => barTime(T0 + 5 * HOUR) });
    expect((await bars.closedBars(BTCUSD, '1h', { limit: 2 })).map((b) => b.time)).toEqual([T0 + 3 * HOUR, T0 + 4 * HOUR]);
    expect(await bars.forming(BTCUSD, '1h')).toBeUndefined();
  });

  it('a range read also leaves the forming bar out, and keeps the oldest `limit`', async () => {
    const { data } = source(hours(5));
    const bars = new IndicatorBars({ data, now: () => barTime(T0 + 4 * HOUR + 60) });
    expect((await bars.closedBars(BTCUSD, '1h', { from: barTime(T0 + HOUR), limit: 10 })).map((b) => b.time)).toEqual([T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect((await bars.closedBars(BTCUSD, '1h', { from: barTime(T0), limit: 2 })).map((b) => b.time)).toEqual([T0, T0 + HOUR]);
  });

  it('a stock bar cut short by the session close is closed once the session is over', async () => {
    // 2025-11-10 (Monday) NY regular session 09:30-16:00 EST = 14:30-21:00 UTC; the last 1h bar opens 20:30 UTC.
    const lastBar = 1_762_806_600; // 20:30 UTC
    const { data } = source([bar(lastBar - HOUR), bar(lastBar)]);
    const during = new IndicatorBars({ data, now: () => barTime(lastBar + 600) });
    expect((await during.closedBars(NVDA, '1h', { limit: 5 })).map((b) => b.time)).toEqual([lastBar - HOUR]);
    const after = new IndicatorBars({ data, now: () => barTime(lastBar + 1_800 + 60) }); // 21:01 UTC, market closed
    expect((await after.closedBars(NVDA, '1h', { limit: 5 })).map((b) => b.time)).toEqual([lastBar - HOUR, lastBar]);
  });

  it('nothing stored, nothing returned', async () => {
    const bars = new IndicatorBars({ data: source([]).data, now: () => barTime(T0) });
    expect(await bars.closedBars(BTCUSD, '1h', { limit: 1 })).toEqual([]);
    expect(await bars.forming(BTCUSD, '1h')).toBeUndefined();
  });
});
