// The rebuild check (M1-10): re-cook every cooked partition from raw, in
// memory, and compare it with what the cooked store holds. It writes nothing.
//
// CLAUDE.md rule 3 says cooked is always rebuildable from raw; this is the
// check that it still is. It reads raw once per month and rolls it up to every
// intraday timeframe, the same `rollUp` cooking uses. For crypto (M1-08a) the
// same minutes give each month's 1D bars, compared with the year files; 1W
// and 1M are rebuilt from those 1D bars and compared for every week and month
// that lies wholly inside the months checked.
//
// Since M1-15 the store holds settled bars only: those before the
// instrument's watermark. Bars from the watermark on are rolled up from raw
// when read, so the check compares only the settled ones.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

import { tailStart } from '../domain/cooked-tail.js';
import { partitionBounds, partitionOf, partitionsBetween } from '../domain/cooked-partition.js';
import type { RebuildDiff } from '../domain/rebuild-diff.js';
import { diffBars } from '../domain/rebuild-diff.js';
import { rollUp } from '../domain/roll-up.js';
import { CALENDAR_ROLLUPS, INTRADAY_ROLLUPS, cooksCalendar } from './cook-intraday.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { CookedWatermarkPort } from './cooked-watermark-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface RebuildCheckDeps {
  readonly source: OneMinuteBarSourcePort;
  /** Read only: the check never writes. */
  readonly store: Pick<CookedBarStorePort, 'getPartition'>;
  /** Each instrument's watermark, if it has one (M1-15). */
  readonly watermarks?: Pick<CookedWatermarkPort, 'getWatermark'>;
  readonly calendar?: MarketCalendar;
}

export interface PartitionResult {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly partition: string;
  /**
   * - `compared`: raw and a stored file both exist; `diff` says how they agree.
   * - `not-cooked`: raw exists but no stored file: every rebuilt bar is missing.
   * - `no-raw`: a stored file exists with no raw behind it: every stored bar is unrebuildable.
   */
  readonly kind: 'compared' | 'not-cooked' | 'no-raw';
  readonly diff: RebuildDiff;
}

export class RebuildCheck {
  constructor(private readonly deps: RebuildCheckDeps) {}

  /**
   * Check each of the given month partitions for every intraday timeframe,
   * and, when `timeframes` names them, for crypto the calendar timeframes over
   * those months (year files; `pnpm rebuild-check` asks for them).
   * A partition with neither raw nor stored bars is skipped: nothing to rebuild.
   */
  async run(
    instrument: Instrument,
    partitions: readonly string[],
    timeframes: readonly Timeframe[] = INTRADAY_ROLLUPS,
  ): Promise<PartitionResult[]> {
    const results: PartitionResult[] = [];
    const through = await this.deps.watermarks?.getWatermark(instrument.symbol);
    const settled = (timeframe: Timeframe) => {
      if (through === undefined) return () => true;
      const start: BarTime = tailStart(instrument, timeframe, through, this.deps.calendar);
      return (bar: Bar) => bar.time < start;
    };
    const intraday = timeframes.filter((tf) => INTRADAY_ROLLUPS.includes(tf));
    const calendar = cooksCalendar(instrument) ? timeframes.filter((tf) => CALENDAR_ROLLUPS.includes(tf)) : [];
    const days: Bar[] = [];
    let checkedFrom: BarTime | undefined;
    let checkedUntil: BarTime | undefined;
    for (const partition of partitions) {
      const { from, until } = partitionBounds(partition);
      if (through !== undefined && from >= through) continue;
      const minutes = await this.deps.source.read(instrument.symbol, from, until);
      if (calendar.length > 0) {
        days.push(...rollUp(instrument, '1D', minutes, this.deps.calendar));
        checkedFrom = checkedFrom === undefined ? from : (Math.min(checkedFrom, from) as BarTime);
        checkedUntil = checkedUntil === undefined ? until : (Math.max(checkedUntil, until) as BarTime);
      }
      for (const timeframe of intraday) {
        const keep = settled(timeframe);
        const rebuilt = rollUp(instrument, timeframe, minutes, this.deps.calendar).filter(keep);
        const found = await this.deps.store.getPartition(instrument.symbol, timeframe, partition);
        const stored = found?.filter(keep);
        const none = stored === undefined || stored.length === 0;
        if (none && rebuilt.length === 0) continue;
        const kind = none ? 'not-cooked' : rebuilt.length === 0 ? 'no-raw' : 'compared';
        results.push({
          symbol: instrument.symbol,
          timeframe,
          partition,
          kind,
          diff: diffBars(rebuilt, stored ?? []),
        });
      }
    }
    if (checkedFrom !== undefined && checkedUntil !== undefined) {
      results.push(...(await this.calendarResults(instrument, calendar, days.sort((a, b) => a.time - b.time), checkedFrom, checkedUntil, settled)));
    }
    return results;
  }

  /** The calendar timeframes over `[from, until]`: 1D from the minutes, 1W and 1M from those 1D bars, per year file. */
  private async calendarResults(
    instrument: Instrument,
    timeframes: readonly Timeframe[],
    days: readonly Bar[],
    from: BarTime,
    until: BarTime,
    settled: (timeframe: Timeframe) => (bar: Bar) => boolean,
  ): Promise<PartitionResult[]> {
    const results: PartitionResult[] = [];
    for (const timeframe of timeframes) {
      const keep = settled(timeframe);
      // A week or month is compared only if every day of it was rebuilt: it opens at or after `from` and the next one opens by `until`.
      const whole = (bar: Bar, next: Bar | undefined) => bar.time >= from && (timeframe === '1D' || (next !== undefined ? next.time <= until + 1 : false));
      const all = timeframe === '1D' ? [...days] : rollUp(instrument, timeframe, days, this.deps.calendar);
      const rebuilt = all.filter((bar) => keep(bar) && (timeframe === '1D' || whole(bar, nextPeriod(instrument, timeframe, bar, this.deps.calendar))));
      const rebuiltTimes = new Set(rebuilt.map((r) => r.time));
      const inRange = (bar: Bar) => keep(bar) && rebuiltTimes.has(bar.time);
      for (const partition of partitionsBetween(timeframe, from, until)) {
        const ownRebuilt = rebuilt.filter((b) => partitionOf(timeframe, b.time) === partition);
        const found = await this.deps.store.getPartition(instrument.symbol, timeframe, partition);
        // Stored bars of the same periods (for 1D, every settled day inside the range).
        const stored = found?.filter((b) => (timeframe === '1D' ? keep(b) && b.time >= from && b.time <= until : inRange(b)));
        const none = stored === undefined || stored.length === 0;
        if (none && ownRebuilt.length === 0) continue;
        const kind = none ? 'not-cooked' : ownRebuilt.length === 0 ? 'no-raw' : 'compared';
        results.push({ symbol: instrument.symbol, timeframe, partition, kind, diff: diffBars(ownRebuilt, stored ?? []) });
      }
    }
    return results;
  }
}

/** The open of the period after `bar`'s, as a bar time to compare against. */
function nextPeriod(instrument: Instrument, timeframe: Timeframe, bar: Bar, calendar?: MarketCalendar): Bar | undefined {
  // Look a little past the longest week or month and take the first period start after this one.
  for (let days = 1; days <= 32; days++) {
    const open = alignToTimeframe(instrument, timeframe, (bar.time + days * 86_400) as BarTime, calendar);
    if (open !== undefined && open > bar.time) return { ...bar, time: open };
  }
  return undefined;
}
