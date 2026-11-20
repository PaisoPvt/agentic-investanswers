// Comparing imported TradingView bars with the chart's bars (UI-03): how many
// bars both have agree on open, high, low and close at the instrument's
// display precision, and the first that does not. Volume is not compared:
// venues and vendors count it differently (decision record D20).

import type { ImportedBar } from './tradingview.js';

export interface ChartBar {
  /** Milliseconds, as KLineChart keeps it. */
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface Difference {
  /** UTC seconds. */
  readonly time: number;
  readonly field: 'open' | 'high' | 'low' | 'close';
  readonly ours: number;
  readonly theirs: number;
}

export interface MatchReport {
  /** Bars at times both have. */
  readonly compared: number;
  readonly matched: number;
  readonly firstDifference: Difference | undefined;
}

const FIELDS = ['open', 'high', 'low', 'close'] as const;

export function compareBars(imported: readonly ImportedBar[], chart: readonly ChartBar[], pricePrecision: number): MatchReport {
  const scale = 10 ** pricePrecision;
  const round = (n: number) => Math.round(n * scale);
  const theirs = new Map(imported.map((b) => [b.time, b]));
  let compared = 0;
  let matched = 0;
  let firstDifference: Difference | undefined;
  for (const bar of chart) {
    const time = Math.round(bar.timestamp / 1000);
    const other = theirs.get(time);
    if (other === undefined) continue;
    compared += 1;
    const field = FIELDS.find((f) => round(bar[f]) !== round(other[f]));
    if (field === undefined) matched += 1;
    else if (firstDifference === undefined) firstDifference = { time, field, ours: bar[field], theirs: other[field] };
  }
  return { compared, matched, firstDifference };
}
