// Cooking live minutes in memory (M1-15). For each new minute, the 5m to 4h
// bars it belongs to, rebuilt from every minute of their buckets, as
// `CookIntraday.applyNewMinutes` would, but without touching the cooked store:
// the compactor writes settled days, and readers roll up the rest from raw.
//
// It keeps the minutes of the longest bucket in progress. The first minute,
// or one older than what it holds, reads the bucket's earlier minutes from
// the source once; after that, minutes arrive one by one.
//
// Calendar timeframes (crypto, M1-08a): 1D like the others, from today's
// minutes (so it holds up to a day of them). 1W and 1M are rolled up from 1D
// bars: the earlier days of the week and month, read once a day through
// `days` (the cooked reader, which is right whether or not yesterday is
// compacted yet), plus today's 1D. They are left out without `days`.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, timeframeSeconds } from '@aia/shared-kernel';

import { rollUp } from '../domain/roll-up.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface LiveCookDeps {
  readonly instrument: Instrument;
  /** Intraday timeframes above 1m. */
  readonly timeframes: readonly Timeframe[];
  readonly source: OneMinuteBarSourcePort;
  readonly calendar?: MarketCalendar;
  /** 1D bars in `[from, until]`, for 1W and 1M (the cooked reader's `getRange` on 1D). */
  readonly days?: (symbol: string, from: BarTime, until: BarTime) => Promise<Bar[]>;
}

const DAY = 86_400;
const isWeekOrMonth = (tf: Timeframe) => tf === '1W' || tf === '1M';

export class LiveCook {
  /** Ascending minutes from `from` on. */
  private minutes: Bar[] = [];
  private from: BarTime | undefined;
  /** The days before today in the current week and month, and the day they were read for. */
  private earlierDays: { readonly today: BarTime; readonly bars: readonly Bar[] } | undefined;

  constructor(private readonly deps: LiveCookDeps) {}

  /** A minute was stored: the bars it rebuilt, per timeframe (what `applyNewMinutesToAll` returns). */
  async apply(minute: Bar): Promise<Map<Timeframe, Bar[]>> {
    const { instrument, timeframes, calendar } = this.deps;
    const opens = new Map<Timeframe, BarTime>();
    for (const tf of timeframes) {
      const open = alignToTimeframe(instrument, tf, minute.time, calendar);
      if (open !== undefined) opens.set(tf, open);
    }
    // Minutes are held for the minute timeframes and 1D; 1W and 1M come from 1D bars.
    const held = [...opens].filter(([tf]) => !isWeekOrMonth(tf)).map(([, open]) => open);
    const earliest = Math.min(...held, minute.time);
    if (this.from === undefined || earliest < this.from) {
      const earlier = await this.deps.source.read(instrument.symbol, barTime(earliest), barTime(minute.time - 1));
      this.minutes = merge(earlier, this.minutes.filter((m) => m.time >= minute.time));
      this.from = barTime(earliest);
    }
    this.minutes = merge(this.minutes.filter((m) => m.time >= earliest && m.time !== minute.time), [minute]);
    this.from = barTime(Math.max(this.from, earliest));

    const rebuilt = new Map<Timeframe, Bar[]>();
    for (const tf of timeframes) {
      const open = opens.get(tf);
      if (isWeekOrMonth(tf)) continue;
      const span = tf === '1D' ? DAY : timeframeSeconds(tf);
      if (open === undefined || span === undefined) {
        rebuilt.set(tf, []);
        continue;
      }
      const bucket = this.minutes.filter((m) => m.time >= open && m.time < open + span);
      rebuilt.set(tf, rollUp(instrument, tf, bucket, calendar).filter((b) => b.time === open));
    }
    await this.weeksAndMonths(opens, rebuilt);
    return rebuilt;
  }

  /** 1W and 1M: the earlier days of the period (read once a day) and today's 1D. */
  private async weeksAndMonths(opens: ReadonlyMap<Timeframe, BarTime>, rebuilt: Map<Timeframe, Bar[]>): Promise<void> {
    const { instrument, calendar, days } = this.deps;
    const periods = [...opens].filter(([tf]) => isWeekOrMonth(tf));
    if (periods.length === 0) return;
    const today = rebuilt.get('1D')?.[0];
    const todayOpen = opens.get('1D');
    if (days === undefined || today === undefined || todayOpen === undefined) {
      for (const [tf] of periods) rebuilt.set(tf, []);
      return;
    }
    if (this.earlierDays?.today !== todayOpen) {
      const first = Math.min(...periods.map(([, open]) => open));
      const bars = first < todayOpen ? await days(instrument.symbol, barTime(first), barTime(todayOpen - 1)) : [];
      this.earlierDays = { today: todayOpen, bars: bars.filter((b) => b.time < todayOpen) };
    }
    const dayBars = [...this.earlierDays.bars, today];
    for (const [tf, open] of periods) rebuilt.set(tf, rollUp(instrument, tf, dayBars, calendar).filter((b) => b.time === open));
  }
}

function merge(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of a) byTime.set(bar.time, bar);
  for (const bar of b) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}
