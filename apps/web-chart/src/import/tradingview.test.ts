import { describe, expect, it } from 'vitest';

import { compareBars } from './compare.js';
import { csvRows, matchInstrument, parseChartFileName, parseTime, parseTradingViewFile } from './tradingview.js';

describe('parseChartFileName', () => {
  it('reads exchange, symbol and resolution from TradingView export names', () => {
    expect(parseChartFileName('COINBASE_BTCUSD, 60.csv')).toEqual({ exchange: 'COINBASE', symbol: 'BTCUSD', timeframe: '1h' });
    expect(parseChartFileName('BATS_NVDA, 1D_a1b2c.csv')).toEqual({ exchange: 'BATS', symbol: 'NVDA', timeframe: '1D' });
    expect(parseChartFileName('BTCUSD, 240 (1).csv')).toEqual({ symbol: 'BTCUSD', timeframe: '4h' });
    expect(parseChartFileName('COINBASE_ETHUSD, 1W.csv').timeframe).toBe('1W');
    expect(parseChartFileName('COINBASE_ETHUSD, 3.csv')).toEqual({ exchange: 'COINBASE', symbol: 'ETHUSD' });
    expect(parseChartFileName('prices.csv')).toEqual({});
  });
});

describe('csvRows and parseTime', () => {
  it('splits quoted fields and line endings', () => {
    expect(csvRows('a,"b, c","d ""e"""\r\n1,2,3\n\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('reads Unix seconds, milliseconds and ISO times', () => {
    expect(parseTime('1731240000')).toBe(1_731_240_000);
    expect(parseTime('1731240000000')).toBe(1_731_240_000);
    expect(parseTime('2024-11-10T09:30:00-05:00')).toBe(1_731_249_000);
    expect(parseTime('2024-11-10T14:30:00Z')).toBe(1_731_249_000);
    expect(parseTime('yesterday')).toBeUndefined();
  });
});

describe('parseTradingViewFile: chart data', () => {
  const csv = [
    'time,open,high,low,close,MA,MA,Volume',
    '1731243600,100,110,95,105,101.5,NaN,12',
    '1731240000,90,100,85,95,99,98,10',
    'bad,1,2,3,4,,,',
  ].join('\n');

  it('reads bars oldest first, volume, and plot columns (repeated names numbered, empty ones dropped)', () => {
    const result = parseTradingViewFile(csv, 'COINBASE_BTCUSD, 60.csv');
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'chart') return;
    const chart = result.value;
    expect(chart).toMatchObject({ symbol: 'BTCUSD', exchange: 'COINBASE', timeframe: '1h', plotNames: ['MA', 'MA 2'] });
    expect(chart.bars).toEqual([
      { time: 1_731_240_000, open: 90, high: 100, low: 85, close: 95, volume: 10, plots: { MA: 99, 'MA 2': 98 } },
      { time: 1_731_243_600, open: 100, high: 110, low: 95, close: 105, volume: 12, plots: { MA: 101.5 } },
    ]);
  });

  it('infers the timeframe from the spacing when the file name does not say', () => {
    const result = parseTradingViewFile(csv, 'export.csv');
    expect(result.ok && result.value.kind === 'chart' && result.value.timeframe).toBe('1h');
  });

  it('refuses a CSV without prices', () => {
    expect(parseTradingViewFile('date,amount\n2024-01-01,5', 'trades.csv')).toEqual({
      ok: false,
      message: 'This is not TradingView chart data: it needs time, open, high, low and close columns.',
    });
    expect(parseTradingViewFile('time,open,high,low,close\n', 'x.csv')).toMatchObject({ ok: false });
  });
});

describe('parseTradingViewFile: watchlist', () => {
  it('reads sections and symbols', () => {
    const result = parseTradingViewFile('###Crypto,COINBASE:BTCUSD,COINBASE:ETHUSD,###Stocks,NASDAQ:NVDA,NASDAQ:NVDA,NASDAQ:TSLA', 'My list.txt');
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'watchlist',
        name: 'My list',
        sections: [
          { title: 'Crypto', symbols: ['COINBASE:BTCUSD', 'COINBASE:ETHUSD'] },
          { title: 'Stocks', symbols: ['NASDAQ:NVDA', 'NASDAQ:TSLA'] },
        ],
      },
    });
  });

  it('reads a list with no sections, one symbol per line', () => {
    const result = parseTradingViewFile('BTCUSD\nNASDAQ:NVDA\n', 'list.txt');
    expect(result.ok && result.value.kind === 'watchlist' && result.value.sections).toEqual([{ title: undefined, symbols: ['BTCUSD', 'NASDAQ:NVDA'] }]);
  });

  it('refuses text that is not symbols', () => {
    expect(parseTradingViewFile('Dear trader, hello there', 'note.txt')).toMatchObject({ ok: false });
    expect(parseTradingViewFile('###Empty', 'x.txt')).toEqual({ ok: false, message: 'The watchlist has no symbols.' });
  });
});

describe('matchInstrument', () => {
  it('drops the exchange and matches our symbols', () => {
    expect(matchInstrument('COINBASE:BTCUSD', ['BTCUSD', 'ETHUSD'])).toBe('BTCUSD');
    expect(matchInstrument('ethusd', ['BTCUSD', 'ETHUSD'])).toBe('ETHUSD');
    expect(matchInstrument('NASDAQ:AAPL', ['BTCUSD'])).toBeUndefined();
    expect(matchInstrument(undefined, ['BTCUSD'])).toBeUndefined();
  });
});

describe('compareBars', () => {
  const imported = [
    { time: 60, open: 1.001, high: 2, low: 0.5, close: 1.5, plots: {} },
    { time: 120, open: 1.5, high: 2.2, low: 1.4, close: 2.0, plots: {} },
    { time: 180, open: 2, high: 3, low: 1, close: 2.5, plots: {} },
  ];
  const chart = [
    { timestamp: 0, open: 1, high: 1, low: 1, close: 1 },
    { timestamp: 60_000, open: 1.0, high: 2, low: 0.5, close: 1.5 },
    { timestamp: 120_000, open: 1.5, high: 2.2, low: 1.4, close: 2.01 },
    { timestamp: 180_000, open: 2, high: 3.1, low: 1, close: 2.5 },
  ];

  it('compares bars at shared times at display precision, and names the first difference', () => {
    expect(compareBars(imported, chart, 2)).toEqual({
      compared: 3,
      matched: 1,
      firstDifference: { time: 120, field: 'close', ours: 2.01, theirs: 2.0 },
    });
  });

  it('reports nothing compared when no time is shared', () => {
    expect(compareBars(imported, [{ timestamp: 999_000, open: 1, high: 1, low: 1, close: 1 }], 2)).toEqual({ compared: 0, matched: 0, firstDifference: undefined });
  });
});
