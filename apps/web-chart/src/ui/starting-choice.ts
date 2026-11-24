// Which instrument and timeframe the chart opens on: what an embedding page
// asked for (M2-11), else the saved ones (M2-13), each only where the
// caller's plan includes it; else the first instrument open to the caller at
// 1m (or its shortest included timeframe). Pure.

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

export function startingChoice(instruments: readonly InstrumentInfo[], saved: ChartPreferencesDto = {}, requested: ChartPreferencesDto = {}): Choice | undefined {
  for (const wanted of [requested, saved]) {
    const found = instruments.find((i) => i.symbol === wanted.instrument && i.included.length > 0);
    if (found === undefined) continue;
    const timeframe = wanted.timeframe !== undefined && found.included.includes(wanted.timeframe) ? wanted.timeframe : defaultTimeframe(found);
    return { symbol: found.symbol, timeframe };
  }
  const first = instruments.find((i) => i.included.length > 0);
  return first === undefined ? undefined : { symbol: first.symbol, timeframe: defaultTimeframe(first) };
}
