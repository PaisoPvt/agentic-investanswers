// Cook the intraday timeframes (5m, 15m, 1h, 4h) from stored 1-minute bars,
// and for crypto the calendar timeframes too (M1-08a): 1D from the same
// minutes, then 1W and 1M rolled up from the stored 1D bars. For crypto a UTC
// day never crosses a week or month start, so this equals rolling them up
// from minutes, for the cost of a year file instead of up to 31 days of
// minutes. Stocks' calendar timeframes need their sessions (M1-08b), so they
// are not cooked here yet.

import type {
  Bar,
  BarTime,
  Instrument,
  MarketCalendar,
  Timeframe,
} from '@aia/shared-kernel';
import { alignToTimeframe, barTime, isIntraday, timeframeSeconds } from '@aia/shared-kernel';

import { partitionBounds, partitionOf, partitionsBetween } from '../domain/cooked-partition.js';
import { affectedBarTimes, rollUp } from '../domain/roll-up.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export class CookIntradayError extends Error {}

/** The intraday timeframes built from 1-minute bars, shortest first. */
export const INTRADAY_ROLLUPS: readonly Timeframe[] = ['5m', '15m', '1h', '4h'];

/** The calendar timeframes: 1D from 1-minute bars, 1W and 1M from 1D (M1-08a). */
export const CALENDAR_ROLLUPS: readonly Timeframe[] = ['1D', '1W', '1M'];

/** Whether an instrument's calendar timeframes are cooked: crypto now; stocks with their sessions (M1-08b). */
export function cooksCalendar(instrument: Instrument): boolean {
  return instrument.kind === 'crypto';
}

const DAY = 86_400;
/** Longer than any week or month: how far past a range the 1D bars of its last week or month can reach. */
const LONGEST_CALENDAR_BAR = 32 * DAY;

function spanOf(timeframe: Timeframe): number {
  if (!isIntraday(timeframe)) {
    throw new CookIntradayError(
      `${timeframe} is a calendar timeframe; cooking it is M1-08's job, not this one`,
    );
  }
  const seconds = timeframeSeconds(timeframe);
  if (seconds === undefined) {
    throw new CookIntradayError(`${timeframe} has no fixed length`);
  }
  return seconds;
}

export interface CookIntradayDeps {
  readonly source: OneMinuteBarSourcePort;
  readonly store: CookedBarStorePort;
  /** Required for instruments with sessions, ignored otherwise. */
  readonly calendar?: MarketCalendar;
}

export class CookIntraday {
  constructor(private readonly deps: CookIntradayDeps) {}

  /**
   * Rebuild one timeframe across a range, from the 1-minute bars in it.
   *
   * The first and last bars can be partial if the range cuts through a bucket,
   * so callers rebuilding a partition should pass whole bucket boundaries.
   * M1-10's rebuild check does exactly this over a whole partition.
   */
  async cookRange(
    instrument: Instrument,
    timeframe: Timeframe,
    from: BarTime,
    until: BarTime,
  ): Promise<Bar[]> {
    spanOf(timeframe);
    const minutes = await this.deps.source.read(instrument.symbol, from, until);
    const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
    await this.writeMerged(instrument.symbol, timeframe, bars, (time) => time >= from && time <= until);
    return bars;
  }

  /**
   * Apply newly arrived 1-minute bars, touching only the bars they affect.
   *
   * This is the requirement in the backlog row: "one new 1m updates only the
   * affected bars". For each affected bucket the full bucket is re-read from
   * the source and rebuilt, so a late-arriving minute inside an already-cooked
   * bucket produces the same bar as a full re-cook would — which is the
   * property M1-10 later asserts across the whole store.
   */
  async applyNewMinutes(
    instrument: Instrument,
    timeframe: Timeframe,
    newMinutes: readonly Bar[],
  ): Promise<Bar[]> {
    const span = spanOf(timeframe);
    const affected = affectedBarTimes(instrument, timeframe, newMinutes, this.deps.calendar);
    if (affected.length === 0) return [];

    const rebuilt: Bar[] = [];
    for (const open of affected) {
      // The whole bucket, not just the new minutes: a bar is only correct if
      // built from every minute it covers.
      const minutes = await this.deps.source.read(
        instrument.symbol,
        open,
        barTime(open + span - 1),
      );
      const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
      const bar = bars.find((b) => b.time === open);
      if (bar !== undefined) rebuilt.push(bar);
    }

    const replaced = new Set(affected);
    await this.writeMerged(instrument.symbol, timeframe, rebuilt, (time) => replaced.has(time));
    return rebuilt;
  }

  /**
   * Write `bars` without losing the rest of their partitions.
   *
   * The store's `put` replaces each partition it touches whole (a month for
   * intraday), so writing only the rebuilt bars would delete every other bar
   * of that month. For each touched partition this reads what is stored,
   * drops the bars `replaces` covers, adds `bars`, and writes it all back.
   */
  private async writeMerged(
    symbol: string,
    timeframe: Timeframe,
    bars: readonly Bar[],
    replaces: (time: BarTime) => boolean,
  ): Promise<void> {
    const byPartition = new Map<string, Bar[]>();
    for (const bar of bars) {
      const partition = partitionOf(timeframe, bar.time);
      const group = byPartition.get(partition);
      if (group === undefined) byPartition.set(partition, [bar]);
      else group.push(bar);
    }
    for (const [partition, fresh] of byPartition) {
      const stored = (await this.deps.store.getPartition(symbol, timeframe, partition)) ?? [];
      const kept = stored.filter((bar) => !replaces(bar.time));
      const merged = [...kept, ...fresh].sort((a, b) => a.time - b.time);
      await this.deps.store.put(symbol, timeframe, merged);
    }
  }

  /**
   * Cook one whole month partition of every intraday timeframe, reading its
   * raw minutes once. The partition is rebuilt entirely from raw, so what was
   * stored for it is replaced. This is what `pnpm cook` runs, month by month.
   * Returns the bars written per timeframe.
   */
  async cookPartition(instrument: Instrument, partition: string): Promise<Map<Timeframe, number>> {
    const { from, until } = partitionBounds(partition);
    const minutes = await this.deps.source.read(instrument.symbol, from, until);
    const written = new Map<Timeframe, number>();
    for (const timeframe of INTRADAY_ROLLUPS) {
      const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
      await this.writeMerged(instrument.symbol, timeframe, bars, (time) => time >= from && time <= until);
      written.set(timeframe, bars.length);
    }
    for (const [timeframe, count] of await this.cookCalendar(instrument, minutes, from, until)) written.set(timeframe, count);
    return written;
  }

  /**
   * Rebuild every intraday timeframe across `[from, until]` from one read of
   * raw, replacing what is stored there. The compactor (M1-15) runs it per
   * settled day, so `from` and `until` should be whole bucket boundaries.
   */
  async cookRangeAll(instrument: Instrument, from: BarTime, until: BarTime): Promise<void> {
    const minutes = await this.deps.source.read(instrument.symbol, from, until);
    for (const timeframe of INTRADAY_ROLLUPS) {
      const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
      await this.writeMerged(instrument.symbol, timeframe, bars, (time) => time >= from && time <= until);
    }
    await this.cookCalendar(instrument, minutes, from, until);
  }

  /**
   * The calendar timeframes for `[from, until]` (whole UTC days), from its
   * minutes: the 1D bars of those days, then every 1W and 1M bar containing
   * one of them, rebuilt from the stored 1D bars. Returns the bars written per
   * timeframe; nothing for an instrument whose calendar timeframes are not
   * cooked yet.
   */
  private async cookCalendar(instrument: Instrument, minutes: readonly Bar[], from: BarTime, until: BarTime): Promise<Map<Timeframe, number>> {
    const written = new Map<Timeframe, number>();
    if (!cooksCalendar(instrument)) return written;
    const days = rollUp(instrument, '1D', minutes, this.deps.calendar);
    await this.writeMerged(instrument.symbol, '1D', days, (time) => time >= from && time <= until);
    written.set('1D', days.length);
    for (const timeframe of ['1W', '1M'] as const) {
      const first = alignToTimeframe(instrument, timeframe, from, this.deps.calendar) ?? from;
      const last = alignToTimeframe(instrument, timeframe, until, this.deps.calendar) ?? until;
      const stored = await this.storedBars(instrument.symbol, '1D', first, barTime(until + LONGEST_CALENDAR_BAR));
      const bars = rollUp(instrument, timeframe, stored, this.deps.calendar).filter((b) => b.time >= first && b.time <= last);
      await this.writeMerged(instrument.symbol, timeframe, bars, (time) => time >= first && time <= last);
      written.set(timeframe, bars.length);
    }
    return written;
  }

  /** Stored bars in `[from, until]`, read partition by partition (one GET each). */
  private async storedBars(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const bars: Bar[] = [];
    for (const partition of partitionsBetween(timeframe, from, until)) {
      for (const bar of (await this.deps.store.getPartition(symbol, timeframe, partition)) ?? []) if (bar.time >= from && bar.time <= until) bars.push(bar);
    }
    return bars.sort((a, b) => a.time - b.time);
  }

  /** Apply new minutes to every intraday timeframe, shortest first. */
  async applyNewMinutesToAll(
    instrument: Instrument,
    newMinutes: readonly Bar[],
  ): Promise<Map<Timeframe, Bar[]>> {
    const result = new Map<Timeframe, Bar[]>();
    for (const timeframe of INTRADAY_ROLLUPS) {
      result.set(timeframe, await this.applyNewMinutes(instrument, timeframe, newMinutes));
    }
    return result;
  }
}
