// The indicator engine's bars (M3-05): its port (IndicatorBarSourcePort) over
// the data layer's front door (@aia/data, M1-16). No rules of its own.
//
// The engine wants closed bars only. A stored 5m to 4h bar (and the newest
// day, week or month) may still be forming, so the newest bar is held back
// while the current instant still falls inside it (alignToTimeframe, the same
// bucketing as cooking). That held-back bar is what the run route previews.

import type { DataAccess } from '@aia/data';
import type { ClosedBarsQuery, IndicatorBarSourcePort } from '@aia/indicators';
import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, hasSessions, nyseCalendar } from '@aia/shared-kernel';

export interface IndicatorBarsDeps {
  readonly data: Pick<DataAccess, 'page' | 'bars'>;
  readonly now: () => BarTime;
  /** For instruments with market sessions; NYSE by default. */
  readonly calendar?: MarketCalendar;
}

export class IndicatorBars implements IndicatorBarSourcePort {
  private readonly calendar: MarketCalendar;

  constructor(private readonly deps: IndicatorBarsDeps) {
    this.calendar = deps.calendar ?? nyseCalendar();
  }

  /** True while `now` still falls inside the bar, so it may change. */
  isForming(instrument: Instrument, timeframe: Timeframe, bar: Bar, now: BarTime): boolean {
    return alignToTimeframe(instrument, timeframe, now, hasSessions(instrument) ? this.calendar : undefined) === bar.time;
  }

  async closedBars(instrument: Instrument, timeframe: Timeframe, query: ClosedBarsQuery): Promise<readonly Bar[]> {
    const now = this.deps.now();
    if (query.from === undefined) {
      // One more than asked, in case the newest is held back.
      const { bars } = await this.deps.data.page(instrument, timeframe, { limit: query.limit + 1, now });
      return this.withoutForming(instrument, timeframe, bars, now).slice(-query.limit);
    }
    const bars = await this.deps.data.bars(instrument, timeframe, query.from, now);
    return this.withoutForming(instrument, timeframe, bars, now).slice(0, query.limit);
  }

  /** The newest stored bar if it is still forming, for the engine to preview. */
  async forming(instrument: Instrument, timeframe: Timeframe): Promise<Bar | undefined> {
    const now = this.deps.now();
    const { bars } = await this.deps.data.page(instrument, timeframe, { limit: 1, now });
    const newest = bars.at(-1);
    return newest !== undefined && this.isForming(instrument, timeframe, newest, now) ? newest : undefined;
  }

  private withoutForming(instrument: Instrument, timeframe: Timeframe, bars: readonly Bar[], now: BarTime): readonly Bar[] {
    const newest = bars.at(-1);
    return newest !== undefined && this.isForming(instrument, timeframe, newest, now) ? bars.slice(0, -1) : bars;
  }
}
