// Readers for TradingView's exports of a strategy (M3-03; the three files of
// OI-30): the chart data with the strategy's plots, the Strategy Tester's
// List of trades, and its Performance summary. Columns are found by their
// names, so a renamed or missing column is a clear error, never a misread.
// The exports are made with the chart's time zone set to UTC; times without a
// zone are read as UTC.

import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';

import type { Side } from '../domain/backtest.js';

export class StrategyExportError extends Error {}

/** One row per line, cells split on commas outside double quotes. */
function rows(text: string): string[][] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.map((line) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cell.trim());
        cell = '';
      } else cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  });
}

function column(file: string, header: readonly string[], what: string, test: (name: string) => boolean): number {
  const at = header.findIndex((h) => test(h.toLowerCase()));
  if (at < 0) throw new StrategyExportError(`${file}: no ${what} column (columns: ${header.join(', ')})`);
  return at;
}

const number = (file: string, text: string | undefined, what: string): number => {
  const cleaned = (text ?? '').replace(/[\s,%$]/g, '').replace(/^[−–]/, '-');
  const n = Number(cleaned);
  if (cleaned === '' || !Number.isFinite(n)) throw new StrategyExportError(`${file}: ${what} is not a number: "${text ?? ''}"`);
  return n;
};

/** A UNIX time in seconds or milliseconds, or "YYYY-MM-DD HH:MM[:SS]" in UTC. */
function time(file: string, text: string | undefined): BarTime {
  const t = (text ?? '').trim();
  if (/^\d{9,13}$/.test(t)) return barTime(t.length > 10 ? Math.floor(Number(t) / 1000) : Number(t));
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m === null) throw new StrategyExportError(`${file}: not a time: "${t}"`);
  return barTime(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) / 1000);
}

/** Digits after the decimal point, as the export shows them. */
export function decimalsOf(text: string): number {
  return /\.(\d+)/.exec(text.replace(/[\s,%$]/g, ''))?.[1]?.length ?? 0;
}

export interface ChartExport {
  readonly file: string;
  /** OHLCV, oldest first, in display units (not scaled). */
  readonly bars: readonly { readonly time: BarTime; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number }[];
  /** Each plot column by its name, one value per bar; null where the plot is empty (warm-up). */
  readonly plots: ReadonlyMap<string, readonly (number | null)[]>;
}

const OHLCV = ['time', 'open', 'high', 'low', 'close', 'volume'];

/** The chart data export: time, OHLC, volume, then the plots (for example "SMA"). */
export function readChartExport(file: string, text: string): ChartExport {
  const [header, ...body] = rows(text);
  if (header === undefined) throw new StrategyExportError(`${file}: empty`);
  const at = Object.fromEntries(OHLCV.filter((c) => c !== 'volume').map((c) => [c, column(file, header, c, (h) => h === c)]));
  const volumeAt = header.findIndex((h) => h.toLowerCase() === 'volume');
  const plotAt = header.map((h, i) => [h, i] as const).filter(([h]) => !OHLCV.includes(h.toLowerCase()));
  const bars = body.map((r) => ({
    time: time(file, r[at['time'] as number]),
    open: number(file, r[at['open'] as number], 'open'),
    high: number(file, r[at['high'] as number], 'high'),
    low: number(file, r[at['low'] as number], 'low'),
    close: number(file, r[at['close'] as number], 'close'),
    volume: volumeAt < 0 ? 0 : number(file, r[volumeAt], 'volume'),
  }));
  const plots = new Map<string, (number | null)[]>();
  for (const [name, i] of plotAt) plots.set(name, body.map((r) => (r[i] === undefined || r[i] === '' || /^nan$/i.test(r[i] ?? '') ? null : number(file, r[i], name))));
  return { file, bars, plots };
}

/** The export's bars as ours, at the instrument's scales. */
export function scaledBars(chart: ChartExport, priceScale: number, volumeScale: number): Bar[] {
  const p = (n: number) => price(Math.round(n * 10 ** priceScale));
  return chart.bars.map((b) => ({ time: b.time, open: p(b.open), high: p(b.high), low: p(b.low), close: p(b.close), volume: volume(Math.round(b.volume * 10 ** volumeScale)) }));
}

export interface ExportedTrade {
  readonly side: Side;
  readonly entryTime: BarTime;
  readonly entryPrice: number;
  /** Undefined while the trade is still open at the end of the export. */
  readonly exitTime?: BarTime;
  readonly exitPrice?: number;
  readonly quantity: number;
  readonly profit: number;
  /** As the export shows them, for comparing at its precision. */
  readonly profitText: string;
}

/** The List of trades: an Entry and an Exit row per trade (an open trade's exit row says "Open"). */
export function readTradesExport(file: string, text: string): ExportedTrade[] {
  const [header, ...body] = rows(text);
  if (header === undefined) throw new StrategyExportError(`${file}: empty`);
  const numberAt = column(file, header, 'trade number', (h) => h.startsWith('trade'));
  const typeAt = column(file, header, 'type', (h) => h === 'type');
  const timeAt = column(file, header, 'date/time', (h) => h.includes('date'));
  const signalAt = header.findIndex((h) => h.toLowerCase() === 'signal');
  const priceAt = column(file, header, 'price', (h) => h.startsWith('price'));
  const qtyAt = column(file, header, 'quantity', (h) => h === 'contracts' || h.startsWith('position size (qty') || h === 'quantity' || h === 'qty');
  const profitAt = column(file, header, 'profit', (h) => (h.startsWith('net p&l') || h.startsWith('profit')) && !h.includes('%'));
  const byNumber = new Map<string, { entry?: string[]; exit?: string[] }>();
  for (const r of body) {
    const n = r[numberAt] ?? '';
    const entry = byNumber.get(n) ?? {};
    const type = (r[typeAt] ?? '').toLowerCase();
    if (type.startsWith('entry')) entry.entry = r;
    else if (type.startsWith('exit')) entry.exit = r;
    else throw new StrategyExportError(`${file}: trade ${n}: unknown type "${r[typeAt] ?? ''}"`);
    byNumber.set(n, entry);
  }
  const trades: ExportedTrade[] = [];
  for (const [n, { entry, exit }] of [...byNumber].sort(([a], [b]) => Number(a) - Number(b))) {
    if (entry === undefined) throw new StrategyExportError(`${file}: trade ${n} has no entry row`);
    const side: Side = (entry[typeAt] ?? '').toLowerCase().includes('short') ? 'short' : 'long';
    const open = exit === undefined || (signalAt >= 0 && /^open$/i.test(exit[signalAt] ?? ''));
    const profitText = (exit ?? entry)[profitAt] ?? '';
    trades.push({
      side,
      entryTime: time(file, entry[timeAt]),
      entryPrice: number(file, entry[priceAt], `trade ${n} entry price`),
      ...(open || exit === undefined ? {} : { exitTime: time(file, exit[timeAt]), exitPrice: number(file, exit[priceAt], `trade ${n} exit price`) }),
      quantity: number(file, entry[qtyAt], `trade ${n} quantity`),
      profit: profitText === '' ? 0 : number(file, profitText, `trade ${n} profit`),
      profitText,
    });
  }
  return trades;
}

/** The Performance summary figures we compare, each with the text the export shows. */
export type SummaryKey = 'netProfit' | 'grossProfit' | 'grossLoss' | 'closedTrades' | 'winningTrades' | 'losingTrades' | 'winRate' | 'profitFactor' | 'averageTrade';

const SUMMARY_NAMES: Readonly<Record<SummaryKey, readonly string[]>> = {
  netProfit: ['net profit', 'net p&l'],
  grossProfit: ['gross profit'],
  grossLoss: ['gross loss'],
  closedTrades: ['total closed trades', 'total trades'],
  winningTrades: ['number winning trades', 'winning trades'],
  losingTrades: ['number losing trades', 'losing trades'],
  winRate: ['percent profitable', 'profitable trades'],
  profitFactor: ['profit factor'],
  averageTrade: ['avg trade', 'average trade', 'avg p&l'],
};

/** The Performance summary: one row per figure, its "All" value in the first column after the name. */
export function readSummaryExport(file: string, text: string): Map<SummaryKey, { value: number; text: string }> {
  const out = new Map<SummaryKey, { value: number; text: string }>();
  const [, ...body] = rows(text);
  for (const r of body) {
    const name = (r[0] ?? '').toLowerCase();
    const key = (Object.keys(SUMMARY_NAMES) as SummaryKey[]).find((k) => SUMMARY_NAMES[k].includes(name));
    if (key === undefined || out.has(key)) continue;
    const cell = r.slice(1).find((c) => c !== '') ?? '';
    // A figure TradingView cannot give (for example a profit factor with no losing trade, "N/A") is left out.
    if (!/\d/.test(cell)) continue;
    out.set(key, { value: number(file, cell, r[0] ?? ''), text: cell });
  }
  for (const key of ['netProfit', 'closedTrades'] as const) {
    if (!out.has(key)) throw new StrategyExportError(`${file}: no "${SUMMARY_NAMES[key][0]}" row`);
  }
  return out;
}
