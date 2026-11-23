// M3-03: the indicator parity comparison and the export readers, on small
// hand-made samples in the format of OI-30's exports (kept here in the test,
// not with the parity exports). Each check passes on matching data and fails
// at the right place.

import { barTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { StrategyExportError, readChartExport, readSummaryExport, readTradesExport } from '../adapters/tradingview-strategy-export.js';
import type { BacktestTotals, Trade } from './backtest.js';
import type { DrawnBar, IndicatorParityInput } from './indicator-parity.js';
import { compareIndicatorParity, formatIndicatorParity, indicatorParityPassed } from './indicator-parity.js';

const H = 3_600;
const T0 = 1_767_225_600; // 2026-01-01 00:00 UTC

// Six hourly bars; "SMA" is empty for the first two (warm-up). The export's last row (bar 7) was still forming.
const CHART = `time,open,high,low,close,SMA,Volume
${T0},100,101,99,100,NaN,10
${T0 + H},100,102,99,101,,11
${T0 + 2 * H},101,103,100,102.5,101.17,12
${T0 + 3 * H},102,104,101,103,102.17,13
${T0 + 4 * H},103,103,98,99,101.5,14
${T0 + 5 * H},99,100,97,98,100,15
${T0 + 6 * H},98,99,96,97,98,16
`;
// Signals: long on bar 2 (fills at bar 3's open, 102), short on bar 4 (fills at bar 5's open, 99): one closed trade, then an open one.
const TRADES = `Trade #,Type,Signal,Date/Time,Price USD,Contracts,Profit USD,Profit %,Cum. Profit USD
1,Exit long,Short,2026-01-01 05:00,99,1,-3.00,-2.94,-3.00
1,Entry long,Long,2026-01-01 03:00,102,1,-3.00,-2.94,-3.00
2,Exit short,Open,2026-01-01 06:00,98,1,1.00,1.01,-2.00
2,Entry short,Short,2026-01-01 05:00,99,1,1.00,1.01,-2.00
`;
const SUMMARY = `,All USD,All %,Long USD,Long %,Short USD,Short %
Net Profit,-3.00,0.00,-3.00,0.00,0.00,0.00
Gross Profit,0.00,0.00,0.00,0.00,0.00,0.00
Gross Loss,3.00,0.00,3.00,0.00,0.00,0.00
Total Closed Trades,1,,1,,0,
Number Winning Trades,0,,0,,0,
Number Losing Trades,1,,1,,0,
Percent Profitable,0.00,,0.00,,0.00,
Profit Factor,0.000,,0.000,,N/A,
Avg Trade,-3.00,-2.94,-3.00,-2.94,0.00,0.00
`;

const chart = readChartExport('btcusd_1h_sma.csv', CHART);
const kept = chart.bars.slice(0, -1);
const barTimes = kept.map((b) => b.time);
const sma = chart.plots.get('SMA') ?? [];
const marker = (side: string, p: number) => ({ side, price: p });

/** What our indicator draws when it matches TradingView. */
function drawnMatching(): DrawnBar[] {
  return barTimes.map((time, i) => ({
    time,
    values: { sma: sma[i] ?? null, long: i === 2 ? marker('below', 100) : null, short: i === 4 ? marker('above', 103) : null },
  }));
}
const closedTrade: Trade = { side: 'long', quantity: 1, entryTime: barTime(T0 + 3 * H), entryPrice: 102, exitTime: barTime(T0 + 5 * H), exitPrice: 99, exitReason: 'reverse', commission: 0, profit: -3, profitPercent: -2.94 };
const totals: BacktestTotals = { closedTrades: 1, winningTrades: 0, losingTrades: 1, winRate: 0, grossProfit: 0, grossLoss: 3, netProfit: -3, roi: -0.0003, profitFactor: 0, commission: 0, averageTrade: -3 };

function input(overrides: Partial<IndicatorParityInput> = {}): IndicatorParityInput {
  return {
    priceScale: 2,
    barTimes,
    plots: new Map([['SMA', sma.slice(0, -1)]]),
    outputs: [{ key: 'sma', label: 'SMA', kind: 'line' }, { key: 'long', label: 'Long', kind: 'marker' }, { key: 'short', label: 'Short', kind: 'marker' }],
    drawn: drawnMatching(),
    entries: { long: 'long', short: 'short' },
    exportedTrades: readTradesExport('btcusd_1h_sma_trades.csv', TRADES),
    trades: [closedTrade],
    summary: readSummaryExport('btcusd_1h_sma_summary.csv', SUMMARY),
    totals,
    ...overrides,
  };
}

describe('TradingView strategy export readers (M3-03)', () => {
  it('reads the chart data with its plots, empty during warm-up', () => {
    expect(chart.bars).toHaveLength(7);
    expect(chart.bars[2]).toEqual({ time: T0 + 2 * H, open: 101, high: 103, low: 100, close: 102.5, volume: 12 });
    expect(sma.slice(0, 3)).toEqual([null, null, 101.17]);
  });

  it('reads the List of trades: entry and exit per trade, an open trade without an exit', () => {
    expect(readTradesExport('t.csv', TRADES)).toEqual([
      { side: 'long', entryTime: T0 + 3 * H, entryPrice: 102, exitTime: T0 + 5 * H, exitPrice: 99, quantity: 1, profit: -3, profitText: '-3.00' },
      { side: 'short', entryTime: T0 + 5 * H, entryPrice: 99, quantity: 1, profit: 1, profitText: '1.00' },
    ]);
  });

  it('reads the summary\'s "All" values, leaving out what TradingView shows as N/A', () => {
    const summary = readSummaryExport('s.csv', SUMMARY);
    expect(summary.get('netProfit')).toEqual({ value: -3, text: '-3.00' });
    expect(summary.get('profitFactor')).toEqual({ value: 0, text: '0.000' });
    expect(summary.get('closedTrades')?.value).toBe(1);
  });

  it('names a missing column instead of misreading', () => {
    expect(() => readChartExport('c.csv', 'time,open,high,low,SMA\n1,1,1,1,1')).toThrow(StrategyExportError);
    expect(() => readTradesExport('t.csv', 'Trade #,Type,Date/Time,Price USD\n1,Entry long,2026-01-01 00:00,1')).toThrow(/no quantity column/);
  });
});

describe('indicator parity (M3-03)', () => {
  it('passes all four checks when ours matches TradingView', () => {
    const checks = compareIndicatorParity(input());
    expect(checks.map((c) => [c.name, c.passed])).toEqual([
      ['plotted values', true],
      ['signals', true],
      ['trades', true],
      ['totals', true],
    ]);
    expect(indicatorParityPassed(checks)).toBe(true);
    expect(formatIndicatorParity(checks, 'BTCUSD 1h sma')).toContain('INDICATOR PARITY OK: all four checks exact.');
  });

  it('a plotted value one tick off fails at its bar; one within the tick passes', () => {
    const drawn = drawnMatching().map((d, i) => (i === 3 ? { ...d, values: { ...d.values, sma: 102.18 } } : d));
    expect(compareIndicatorParity(input({ drawn }))[0]?.first).toBe('SMA at 2026-01-01 03:00: TradingView 102.17, ours 102.18');
    const close = drawnMatching().map((d, i) => (i === 3 ? { ...d, values: { ...d.values, sma: 102.1666 } } : d));
    expect(compareIndicatorParity(input({ drawn: close }))[0]?.passed).toBe(true);
  });

  it('a value drawn during warm-up fails', () => {
    const drawn = drawnMatching().map((d, i) => (i === 1 ? { ...d, values: { ...d.values, sma: 100.5 } } : d));
    expect(compareIndicatorParity(input({ drawn }))[0]?.first).toBe('SMA at 2026-01-01 01:00: TradingView empty, ours 100.5');
  });

  it('a signal one bar late fails, naming both bars', () => {
    const drawn = drawnMatching().map((d, i) => ({ ...d, values: { ...d.values, long: i === 3 ? marker('below', 101) : null } }));
    expect(compareIndicatorParity(input({ drawn }))[1]?.first).toBe('signal 1: TradingView long at 2026-01-01 02:00, ours long at 2026-01-01 03:00');
  });

  it('a trade at another price fails at that trade and field', () => {
    const trades = [{ ...closedTrade, exitPrice: 99.01, profit: -2.99 }];
    expect(compareIndicatorParity(input({ trades }))[2]?.first).toBe('trade 1 exit price: TradingView 99, ours 99.01');
  });

  it('a total one cent off fails; the count of trades is compared too', () => {
    expect(compareIndicatorParity(input({ totals: { ...totals, netProfit: -3.01 } }))[3]?.first).toBe('netProfit: TradingView -3.00, ours -3.01');
    expect(compareIndicatorParity(input({ trades: [] }))[2]?.first).toBe('trade 1: TradingView has 1 closed trades, ours 0');
  });

  it('a plot with no matching output fails', () => {
    expect(compareIndicatorParity(input({ plots: new Map([['EMA', sma]]) }))[0]?.first).toBe('the export\'s plot "EMA" matches no output of the indicator');
  });
});
