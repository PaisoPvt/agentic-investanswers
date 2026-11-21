// A backfill, then re-cooking the months it changed (M1-17), as gap repair
// does (repair-and-recook.ts, M1-09). A day `pnpm live` already compacted from
// its live minutes, which may cover only part of the day, is cooked again
// once its full day file is stored, so cooked keeps equal to a rebuild from
// raw (CLAUDE.md rule 3). Composition only: Backfill lives in @aia/hydration
// and CookIntraday in @aia/market-data.

import type { BackfillDeps, BackfillRange, BackfillReport, DayOutcome } from '@aia/hydration';
import { Backfill } from '@aia/hydration';
import type { CookedBarStorePort, OneMinuteBarSourcePort } from '@aia/market-data';
import { CookIntraday } from '@aia/market-data';
import type { Instrument, MarketCalendar } from '@aia/shared-kernel';

export interface BackfillAndRecookDeps extends BackfillDeps {
  /** The raw store seen as market-data's 1m source, for re-cooking. */
  readonly minutes: OneMinuteBarSourcePort;
  readonly cooked: CookedBarStorePort;
  readonly calendar?: MarketCalendar;
}

export interface BackfillAndRecookResult {
  readonly report: BackfillReport;
  /** Months re-cooked (YYYY-MM): those with a day stored by this run; empty for stocks until M1-08 cooks them. */
  readonly recooked: readonly string[];
}

export async function backfillAndRecook(deps: BackfillAndRecookDeps, instrument: Instrument, range: BackfillRange): Promise<BackfillAndRecookResult> {
  const months = new Set<string>();
  const onDay = (i: Instrument, outcome: DayOutcome) => {
    if (outcome.kind === 'stored') months.add(outcome.date.slice(0, 7));
    deps.onDay?.(i, outcome);
  };
  const report = await new Backfill({ ...deps, onDay }).run(instrument, range);
  // Raw stock bars keep Massive's precision; cooking stocks is M1-08.
  if (instrument.kind === 'stock' || months.size === 0) return { report, recooked: [] };
  const cook = new CookIntraday({ source: deps.minutes, store: deps.cooked, ...(deps.calendar === undefined ? {} : { calendar: deps.calendar }) });
  const recooked = [...months].sort();
  for (const month of recooked) await cook.cookPartition(instrument, month);
  return { report, recooked };
}
