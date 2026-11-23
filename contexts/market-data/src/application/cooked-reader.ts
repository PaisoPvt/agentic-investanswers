// Reading cooked bars as settled store plus tail (M1-15).
//
// Bars before the instrument's watermark come from the cooked store; bars
// from it on are rolled up from raw 1-minute bars here, with the same
// `rollUp` cooking uses. Live cooking therefore never writes the store every
// minute, yet readers always see every stored minute. An instrument with no
// watermark yet is read from the store alone, as before M1-15.
//
// Calendar timeframes (crypto, M1-08a): 1D works like intraday, with today's
// bar rolled up from its minutes. The tail of 1W and 1M is rolled up from 1D
// bars (settled ones from the store, today's from its minutes), so a 1M read
// costs a year file and today's minutes, never a month of minutes.
//
// It has the cooked store's read shape, so RecentBars and the History API use
// it unchanged.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

import { tailStart } from '../domain/cooked-tail.js';
import { rollUp } from '../domain/roll-up.js';
import { cooksCalendar } from './cook-intraday.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { CookedWatermarkPort } from './cooked-watermark-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface CookedReaderDeps {
  readonly store: Pick<CookedBarStorePort, 'getRange'>;
  readonly watermarks: Pick<CookedWatermarkPort, 'getWatermark'>;
  readonly minutes: OneMinuteBarSourcePort;
  readonly instruments: readonly Instrument[];
  readonly calendar?: MarketCalendar;
  /** Epoch milliseconds, for how long a watermark read is reused. */
  readonly nowMs: () => number;
  /** Default 30 s. A stale watermark only makes the tail longer, never wrong. */
  readonly watermarkTtlMs?: number;
}

const DAY = 86_400;
/** Longer than any week or month. */
const LONGEST_CALENDAR_BAR = 32 * DAY;

export class CookedReader implements Pick<CookedBarStorePort, 'getRange'> {
  private readonly instruments: ReadonlyMap<string, Instrument>;
  private readonly marks = new Map<string, { through: BarTime | undefined; at: number }>();

  constructor(private readonly deps: CookedReaderDeps) {
    this.instruments = new Map(deps.instruments.map((i) => [i.symbol, i]));
  }

  /** Bars in `[from, until]` inclusive, ascending: stored before the tail, rolled up from raw after. */
  async getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = this.instruments.get(symbol);
    const calendarTf = timeframe === '1D' || timeframe === '1W' || timeframe === '1M';
    // 1D spans a UTC day for crypto, whose calendar timeframes are cooked; a stock's are read from the store alone until M1-08b.
    const span = timeframe === '1D' ? DAY : timeframeSeconds(timeframe);
    if (instrument === undefined || (calendarTf && !cooksCalendar(instrument))) return this.deps.store.getRange(symbol, timeframe, from, until);
    const through = await this.watermark(symbol);
    if (through === undefined) return this.deps.store.getRange(symbol, timeframe, from, until);
    if (span === undefined) return this.weeksOrMonths(instrument, timeframe, from, until, through);

    const start = tailStart(instrument, timeframe, through, this.deps.calendar);
    const stored = from < start ? await this.deps.store.getRange(symbol, timeframe, from, barTime(Math.min(until, start - 1))) : [];
    if (until < start) return stored;
    const tailFrom = barTime(Math.max(from, start));
    const minutes = await this.deps.minutes.read(symbol, tailFrom, barTime(until + span - 1));
    const tail = rollUp(instrument, timeframe, minutes, this.deps.calendar).filter((b) => b.time >= tailFrom && b.time <= until);
    return [...stored, ...tail];
  }

  /** 1W or 1M: stored before the bar holding the watermark, then rolled up from 1D bars (stored plus today's). */
  private async weeksOrMonths(instrument: Instrument, timeframe: Timeframe, from: BarTime, until: BarTime, through: BarTime): Promise<Bar[]> {
    const symbol = instrument.symbol;
    const start = tailStart(instrument, timeframe, through, this.deps.calendar);
    const stored = from < start ? await this.deps.store.getRange(symbol, timeframe, from, barTime(Math.min(until, start - 1))) : [];
    if (until < start) return stored;
    const tailFrom = barTime(Math.max(from, start));
    // The 1D bars of every week or month in the tail, through the end of the last one.
    const days = await this.getRange(symbol, '1D', start, barTime(until + LONGEST_CALENDAR_BAR));
    const tail = rollUp(instrument, timeframe, days, this.deps.calendar).filter((b) => b.time >= tailFrom && b.time <= until);
    return [...stored, ...tail];
  }

  private async watermark(symbol: string): Promise<BarTime | undefined> {
    const now = this.deps.nowMs();
    const known = this.marks.get(symbol);
    if (known !== undefined && now - known.at < (this.deps.watermarkTtlMs ?? 30_000)) return known.through;
    const through = await this.deps.watermarks.getWatermark(symbol);
    this.marks.set(symbol, { through, at: now });
    return through;
  }
}
