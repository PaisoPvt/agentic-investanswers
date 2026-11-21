// M1-17: a backfill re-cooks the months it changed. The case found on
// 2026-11-21: `pnpm live` compacted a day from its live minutes (part of the
// day only), then a backfill stored the full day file. Without a re-cook the
// cooked bars stay partial and the rebuild check fails; with it, cooked equals
// a rebuild from raw again.

import type { HistoryProviderPort, RawDayRef } from '@aia/hydration';
import { Backfill, RawDayAlreadyStoredError, RawMinuteSource, dayStart } from '@aia/hydration';
import type { CookedBarStorePort } from '@aia/market-data';
import { BTCUSD, CookIntraday, RebuildCheck, partitionOf, rebuildPassed } from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, nyseCalendar, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { backfillAndRecook } from './backfill-and-recook.js';

const NVDA: Instrument = { symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ', timeZone: 'America/New_York', priceScale: 2, volumeScale: 0 };

function day(date: string): Bar[] {
  const start = dayStart(date);
  return Array.from({ length: 1440 }, (_, i) => {
    const p = price(10_000_00 + (i % 37) * 100);
    return { time: barTime(start + i * 60), open: p, high: p, low: p, close: p, volume: volume(1_000_000 + i) };
  });
}

/** Raw days plus live minutes, as the stores keep them: a day file supersedes the live minutes. */
class MemoryRaw {
  readonly days = new Map<string, Bar[]>();
  readonly live = new Map<string, Bar[]>();
  private key(ref: RawDayRef): string {
    return `${ref.symbol}/${ref.date}`;
  }
  hasDay(ref: RawDayRef): Promise<boolean> {
    return Promise.resolve(this.days.has(this.key(ref)));
  }
  putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    if (this.days.has(this.key(ref))) return Promise.reject(new RawDayAlreadyStoredError(ref));
    this.days.set(this.key(ref), [...bars]);
    return Promise.resolve();
  }
  getDay(ref: RawDayRef): Promise<Bar[] | undefined> {
    return Promise.resolve(this.days.get(this.key(ref)));
  }
  getLiveMinutes(ref: RawDayRef): Promise<Bar[]> {
    return Promise.resolve(this.live.get(this.key(ref)) ?? []);
  }
}

/** Cooked store with S3's semantics: put replaces each touched partition whole. */
class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();
  puts = 0;
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    this.puts++;
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.files.set(key, group);
    return Promise.resolve();
  }
  getRange(): Promise<Bar[]> {
    return Promise.resolve([]);
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.files.get(`${symbol}/${timeframe}/${partition}`));
  }
}

class Provider implements HistoryProviderPort {
  readonly name = 'coinbase';
  fetchDay(_i: Instrument, date: string): Promise<Bar[]> {
    return Promise.resolve(day(date));
  }
}

/** 14 Nov was compacted from live minutes of its second half only; the month is cooked as it stood. */
async function compactedFromLiveMinutes() {
  const raw = new MemoryRaw();
  const minutes = new RawMinuteSource(raw, () => 'coinbase', () => 'coinbase');
  const cooked = new PartitionStore();
  const calendar = nyseCalendar();
  raw.live.set('BTCUSD/2026-11-14', day('2026-11-14').slice(720));
  await new CookIntraday({ source: minutes, store: cooked, calendar }).cookPartition(BTCUSD, '2026-11');
  const range = { from: '2026-11-14', until: '2026-11-14', now: barTimeFromUtcParts(2026, 11, 16, 20, 0) };
  const rebuilt = async () => rebuildPassed(await new RebuildCheck({ source: minutes, store: cooked }).run(BTCUSD, ['2026-11']));
  return { raw, minutes, cooked, calendar, range, rebuilt };
}

describe('backfill re-cooks the months it changed (M1-17)', () => {
  it('without a re-cook, a backfilled day already compacted from live minutes leaves cooked behind raw (the bug)', async () => {
    const { raw, range, rebuilt } = await compactedFromLiveMinutes();
    await new Backfill({ provider: new Provider(), raw }).run(BTCUSD, range);
    expect(await rebuilt()).toBe(false);
  });

  it('with backfillAndRecook, the month is cooked again and equals a rebuild from raw', async () => {
    const { raw, minutes, cooked, calendar, range, rebuilt } = await compactedFromLiveMinutes();
    const fourHourBefore = (await cooked.getPartition('BTCUSD', '4h', '2026-11'))?.find((b) => b.time === barTimeFromUtcParts(2026, 11, 14, 12, 0));
    const { report, recooked } = await backfillAndRecook({ provider: new Provider(), raw, minutes, cooked, calendar }, BTCUSD, range);
    expect(report.stored).toBe(1);
    expect(recooked).toEqual(['2026-11']);
    expect(await rebuilt()).toBe(true);
    // The 00:00 bars, missing before, are there now.
    const midnight = (await cooked.getPartition('BTCUSD', '15m', '2026-11'))?.find((b) => b.time === barTimeFromUtcParts(2026, 11, 14, 0, 0));
    expect(midnight).toBeDefined();
    expect(fourHourBefore).toBeDefined();
  });

  it('re-cooks nothing when every day was already there, and nothing for a stock', async () => {
    const { raw, minutes, cooked, calendar, range } = await compactedFromLiveMinutes();
    await raw.putDay({ provider: 'coinbase', symbol: 'BTCUSD', date: '2026-11-14' }, day('2026-11-14'));
    cooked.puts = 0;
    const skipped = await backfillAndRecook({ provider: new Provider(), raw, minutes, cooked, calendar }, BTCUSD, range);
    expect([skipped.report.skipped, skipped.recooked, cooked.puts]).toEqual([1, [], 0]);
    const stock = await backfillAndRecook({ provider: new Provider(), raw, minutes, cooked, calendar }, NVDA, { ...range, from: '2026-11-13', until: '2026-11-13' });
    expect(stock.recooked).toEqual([]);
    expect(cooked.puts).toBe(0);
  });
});
