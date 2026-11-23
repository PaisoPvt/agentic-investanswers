// What `pnpm live` would announce for made-up minutes (M1-16), for load tests
// and demos: the same forming and stored bar rules (FormingBars, rollUp), so
// a simulated chart behaves like a real one. One per instrument.
//
// For crypto it forms 1D, 1W and 1M too (M1-08a). A bar is rolled up from the
// minutes stored here plus, given `earlier`, the minutes of its period that
// were stored before, so a day or a month is whole, as the real one is.

import type { LiveBarUpdate } from '@aia/market-data';
import { CALENDAR_ROLLUPS, FormingBars, INTRADAY_ROLLUPS, cooksCalendar, rollUp } from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

export class SimulatedLiveFeed {
  private readonly forming: FormingBars;
  private readonly storedMinutes: Bar[] = [];
  private readonly timeframes: readonly Timeframe[];

  constructor(
    readonly instrument: Instrument,
    /** The minutes stored before this feed began, in `[from, until]`; none when left out. */
    private readonly earlier?: (from: BarTime, until: BarTime) => readonly Bar[],
  ) {
    this.timeframes = [...INTRADAY_ROLLUPS, ...(cooksCalendar(instrument) ? CALENDAR_ROLLUPS : [])];
    this.forming = new FormingBars(instrument, this.timeframes);
  }

  /** The minutes not yet stored changed (forming, or closed and being written): the forming updates. */
  unstoredChanged(minutes: readonly Bar[]): LiveBarUpdate[] {
    return this.forming.unstoredChanged(minutes);
  }

  /**
   * A minute was stored and cooked: its stored updates (the 1m bar and each
   * bar it rebuilt), then the forming bars rebuilt on top of them.
   */
  stored(minute: Bar): LiveBarUpdate[] {
    this.forming.stored(minute);
    this.storedMinutes.push(minute);
    const rebuilt = new Map<Timeframe, Bar[]>();
    const first = this.storedMinutes[0]?.time ?? minute.time;
    for (const tf of this.timeframes) {
      const period = alignToTimeframe(this.instrument, tf, minute.time);
      const inPeriod = this.storedMinutes.filter((b) => alignToTimeframe(this.instrument, tf, b.time) === period);
      const before = period !== undefined && period < first && this.earlier !== undefined ? this.earlier(period, (first - 60) as BarTime) : [];
      rebuilt.set(tf, rollUp(this.instrument, tf, [...before, ...inPeriod]));
    }
    return this.forming.cooked(minute, rebuilt);
  }
}
