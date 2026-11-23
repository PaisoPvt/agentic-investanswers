// Which instrument and timeframe the chart opens on (M2-13): the saved ones
// when the caller's plan still includes them, else the first instrument open
// to the caller at 1m (or its shortest included timeframe). Pure.

import type { ChartPreferencesDto, InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

export interface Choice {
  readonly symbol: string;
  readonly timeframe: Timeframe | undefined;
}

/** The first choice open to the caller on an instrument: 1m if included, else the shortest included timeframe. */
export function defaultTimeframe(instrument: InstrumentInfo): Timeframe | undefined {
  return instrument.included.includes('1m') ? '1m' : instrument.included[0];
}

export function startingChoice(instruments: readonly InstrumentInfo[], saved: ChartPreferencesDto = {}): Choice | undefined {
  const remembered = instruments.find((i) => i.symbol === saved.instrument && i.included.length > 0);
  if (remembered !== undefined) {
    const timeframe = saved.timeframe !== undefined && remembered.included.includes(saved.timeframe) ? saved.timeframe : defaultTimeframe(remembered);
    return { symbol: remembered.symbol, timeframe };
  }
  const first = instruments.find((i) => i.included.length > 0);
  return first === undefined ? undefined : { symbol: first.symbol, timeframe: defaultTimeframe(first) };
}
