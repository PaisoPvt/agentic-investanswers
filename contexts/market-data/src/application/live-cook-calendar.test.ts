// M1-08a: live 1D, 1W and 1M. Each stored minute rebuilds today's 1D from
// today's minutes, and the week's and month's bars from their earlier days
// (read once a day) plus today's; checked against rolling up every minute so
// far, across a month start (Sun 2026-03-01) and a week start (Mon 2026-03-02).

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { rollUp } from '../domain/roll-up.js';
import { CALENDAR_ROLLUPS, INTRADAY_ROLLUPS } from './cook-intraday.js';
import { LiveCook } from './live-cook.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const START = barTimeFromUtcParts(2026, 2, 25); // a Wednesday: the week and month both started earlier
const ALL: Bar[] = Array.from({ length: 6 * 1_440 }, (_, i) => {
  const t = START + i * 60;
  const p = 6_000_000 + ((t / 60) * 7_919) % 80_000;
  return { time: barTime(t), open: price(p), high: price(p + 29), low: price(p - 31), close: price(p + 3), volume: volume(20_000_000 + (t % 8_191)) };
});

describe('live 1D, 1W and 1M (M1-08a)', () => {
  it('matches the bars rolled up from every minute so far, across a month start and a week start', async () => {
    // Live starts on 2026-02-27 12:00; what came before is stored.
    const liveFrom = barTimeFromUtcParts(2026, 2, 27, 12, 0);
    const stored = (until: number) => ALL.filter((b) => b.time <= until);
    let storedThrough = liveFrom - 60;
    let dayReads = 0;
    const cook = new LiveCook({
      instrument: BTC,
      timeframes: [...INTRADAY_ROLLUPS, ...CALENDAR_ROLLUPS],
      source: { read: (_s: string, from: BarTime, until: BarTime) => Promise.resolve(stored(storedThrough).filter((b) => b.time >= from && b.time <= until)) },
      days: (_s, from, until) => {
        dayReads++;
        return Promise.resolve(rollUp(BTC, '1D', stored(storedThrough)).filter((b) => b.time >= from && b.time <= until));
      },
    });
    const checkAt = new Set([liveFrom, barTimeFromUtcParts(2026, 2, 28, 23, 59), barTimeFromUtcParts(2026, 3, 1, 0, 0), barTimeFromUtcParts(2026, 3, 1, 17, 3), barTimeFromUtcParts(2026, 3, 2, 0, 0), barTimeFromUtcParts(2026, 3, 2, 9, 41)]);
    for (const minute of ALL.filter((b) => b.time >= liveFrom && b.time <= barTimeFromUtcParts(2026, 3, 2, 9, 41))) {
      storedThrough = minute.time;
      const rebuilt = await cook.apply(minute);
      if (!checkAt.has(minute.time)) continue;
      for (const tf of CALENDAR_ROLLUPS) {
        const open = alignToTimeframe(BTC, tf, minute.time);
        const truth = rollUp(BTC, tf, stored(minute.time)).filter((b) => b.time === open);
        expect(rebuilt.get(tf), `${tf} at ${minute.time}`).toEqual(truth);
      }
    }
    // The earlier days are read once per day, not once per minute: 4 days live.
    expect(dayReads).toBe(4);
  });

  it('leaves 1W and 1M out without a way to read the earlier days', async () => {
    const cook = new LiveCook({ instrument: BTC, timeframes: ['1D', '1W', '1M'], source: { read: () => Promise.resolve([]) } });
    const rebuilt = await cook.apply(ALL[0] as Bar);
    expect(rebuilt.get('1D')).toHaveLength(1);
    expect([rebuilt.get('1W'), rebuilt.get('1M')]).toEqual([[], []]);
  });
});
