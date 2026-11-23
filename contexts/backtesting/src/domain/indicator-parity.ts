// Indicator parity (M3-03): an indicator and its backtest against
// TradingView's exports of the same strategy, fed TradingView's own bars, so a
// difference can only be in our logic. Four checks, each exact at the
// precision TradingView shows: plotted values to the tick, signals, trades,
// and the Performance summary's totals. Each reports the first difference.
// Pure: the readers and the indicator run are the caller's.

import type { BarTime } from '@aia/shared-kernel';

import type { BacktestTotals, Side, Trade } from './backtest.js';

/** What the indicator drew on one bar (its drawn outputs, as clients get them). */
export interface DrawnBar {
  readonly time: BarTime;
  readonly values: Readonly<Record<string, number | { readonly side: string; readonly price: number } | { readonly upper: number; readonly lower: number } | null>>;
}

export interface ExportedTradeView {
  readonly side: Side;
  readonly entryTime: BarTime;
  readonly entryPrice: number;
  readonly exitTime?: BarTime;
  readonly exitPrice?: number;
  readonly quantity: number;
  readonly profit: number;
  readonly profitText: string;
}

export interface IndicatorParityInput {
  readonly priceScale: number;
  /** The bars compared: the export's, without its last (still forming when saved). */
  readonly barTimes: readonly BarTime[];
  /** The export's plots by name, one value per bar of `barTimes`. */
  readonly plots: ReadonlyMap<string, readonly (number | null)[]>;
  /** The indicator's declared outputs, to match plots by label or key. */
  readonly outputs: readonly { readonly key: string; readonly label: string; readonly kind: string }[];
  /** Ours, one per bar of `barTimes`. */
  readonly drawn: readonly DrawnBar[];
  /** Which marker outputs are entries: marker key to side. */
  readonly entries: Readonly<Record<string, Side>>;
  readonly exportedTrades: readonly ExportedTradeView[];
  readonly trades: readonly Trade[];
  readonly summary: ReadonlyMap<string, { readonly value: number; readonly text: string }>;
  readonly totals: BacktestTotals;
}

export interface ParityCheck {
  readonly name: 'plotted values' | 'signals' | 'trades' | 'totals';
  readonly passed: boolean;
  readonly compared: number;
  /** The first difference, in words, with both values. */
  readonly first?: string;
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const decimals = (text: string) => /\.(\d+)/.exec(text.replace(/[\s,%$]/g, ''))?.[1]?.length ?? 0;
const at = (n: number, places: number) => Math.round(n * 10 ** places);

function plotted(input: IndicatorParityInput): ParityCheck {
  let compared = 0;
  for (const [name, values] of input.plots) {
    const output = input.outputs.find((o) => o.label.toLowerCase() === name.toLowerCase() || o.key.toLowerCase() === name.toLowerCase());
    if (output === undefined) return { name: 'plotted values', passed: false, compared, first: `the export's plot "${name}" matches no output of the indicator` };
    for (let i = 0; i < input.barTimes.length; i++) {
      const theirs = values[i] ?? null;
      const raw = input.drawn[i]?.values[output.key];
      const ours = typeof raw === 'number' ? raw : null;
      compared++;
      const same = theirs === null || ours === null ? theirs === ours : at(theirs, input.priceScale) === at(ours, input.priceScale);
      if (!same) return { name: 'plotted values', passed: false, compared, first: `${name} at ${iso(input.barTimes[i] as number)}: TradingView ${theirs ?? 'empty'}, ours ${ours ?? 'empty'}` };
    }
  }
  return { name: 'plotted values', passed: compared > 0, compared, ...(compared === 0 ? { first: 'nothing to compare: the export has no plots' } : {}) };
}

function signals(input: IndicatorParityInput): ParityCheck {
  const ours: { time: number; side: Side }[] = [];
  for (const bar of input.drawn) {
    for (const [key, side] of Object.entries(input.entries)) if (bar.values[key] !== null && bar.values[key] !== undefined) ours.push({ time: bar.time, side });
  }
  // TradingView fills at the next bar's open: the signal is the bar before each entry.
  const index = new Map(input.barTimes.map((t, i) => [t as number, i]));
  const last = input.barTimes[input.barTimes.length - 1] ?? 0;
  const theirs = input.exportedTrades
    .filter((t) => t.entryTime <= last)
    .map((t) => ({ time: input.barTimes[(index.get(t.entryTime) ?? 0) - 1] ?? -1, side: t.side, fill: t.entryTime }));
  // A signal on the last bar compared fills after it: not in the export's trades.
  const oursFilled = ours.filter((s) => s.time < last);
  const n = Math.max(theirs.length, oursFilled.length);
  for (let i = 0; i < n; i++) {
    const t = theirs[i];
    const o = oursFilled[i];
    if (t === undefined || o === undefined || t.time !== o.time || t.side !== o.side) {
      const say = (x: { time: number; side: Side } | undefined) => (x === undefined ? 'none' : `${x.side} at ${x.time < 0 ? 'before the first bar' : iso(x.time)}`);
      return { name: 'signals', passed: false, compared: i + 1, first: `signal ${i + 1}: TradingView ${say(t)}, ours ${say(o)}` };
    }
  }
  return { name: 'signals', passed: true, compared: n };
}

function trades(input: IndicatorParityInput): ParityCheck {
  const theirs = input.exportedTrades.filter((t) => t.exitTime !== undefined);
  const ours = input.trades;
  const tick = (n: number) => at(n, input.priceScale);
  const n = Math.max(theirs.length, ours.length);
  for (let i = 0; i < n; i++) {
    const t = theirs[i];
    const o = ours[i];
    if (t === undefined || o === undefined) return { name: 'trades', passed: false, compared: i + 1, first: `trade ${i + 1}: TradingView has ${theirs.length} closed trades, ours ${ours.length}` };
    const places = decimals(t.profitText);
    const fields: [string, string | number, string | number, boolean][] = [
      ['side', t.side, o.side, t.side === o.side],
      ['entry time', iso(t.entryTime), iso(o.entryTime), t.entryTime === o.entryTime],
      ['entry price', t.entryPrice, o.entryPrice, tick(t.entryPrice) === tick(o.entryPrice)],
      ['exit time', iso(t.exitTime as number), iso(o.exitTime), t.exitTime === o.exitTime],
      ['exit price', t.exitPrice as number, o.exitPrice, tick(t.exitPrice as number) === tick(o.exitPrice)],
      ['quantity', t.quantity, o.quantity, t.quantity === o.quantity],
      ['profit', t.profitText, o.profit.toFixed(places), at(t.profit, places) === at(o.profit, places)],
    ];
    const bad = fields.find(([, , , same]) => !same);
    if (bad !== undefined) return { name: 'trades', passed: false, compared: i + 1, first: `trade ${i + 1} ${bad[0]}: TradingView ${bad[1]}, ours ${bad[2]}` };
  }
  return { name: 'trades', passed: true, compared: n };
}

const OURS: Readonly<Record<string, (t: BacktestTotals) => number | null>> = {
  netProfit: (t) => t.netProfit,
  grossProfit: (t) => t.grossProfit,
  grossLoss: (t) => t.grossLoss,
  closedTrades: (t) => t.closedTrades,
  winningTrades: (t) => t.winningTrades,
  losingTrades: (t) => t.losingTrades,
  winRate: (t) => t.winRate,
  profitFactor: (t) => t.profitFactor,
  averageTrade: (t) => t.averageTrade,
};

function totals(input: IndicatorParityInput): ParityCheck {
  let compared = 0;
  for (const [key, ours] of Object.entries(OURS)) {
    const theirs = input.summary.get(key);
    if (theirs === undefined) continue;
    compared++;
    const value = ours(input.totals);
    const places = decimals(theirs.text);
    // Gross loss may be shown with a minus sign; ours is positive.
    const same = value !== null && at(key === 'grossLoss' ? Math.abs(theirs.value) : theirs.value, places) === at(value, places);
    if (!same) return { name: 'totals', passed: false, compared, first: `${key}: TradingView ${theirs.text}, ours ${value === null ? 'none' : value.toFixed(places)}` };
  }
  return { name: 'totals', passed: compared > 0, compared, ...(compared === 0 ? { first: 'nothing to compare: no known figure in the summary' } : {}) };
}

export function compareIndicatorParity(input: IndicatorParityInput): ParityCheck[] {
  return [plotted(input), signals(input), trades(input), totals(input)];
}

export function indicatorParityPassed(checks: readonly ParityCheck[]): boolean {
  return checks.length === 4 && checks.every((c) => c.passed);
}

export function formatIndicatorParity(checks: readonly ParityCheck[], title: string): string {
  const lines = [title, ''];
  for (const c of checks) lines.push(`${c.passed ? 'EXACT ' : 'DIFFERS'}  ${c.name.padEnd(15)} ${String(c.compared).padStart(6)} compared${c.first === undefined ? '' : `   first: ${c.first}`}`);
  lines.push('', indicatorParityPassed(checks) ? 'INDICATOR PARITY OK: all four checks exact.' : 'INDICATOR PARITY FAILED.');
  return `${lines.join('\n')}\n`;
}
