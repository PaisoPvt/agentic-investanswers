// Reading files exported from TradingView (UI-03, client UI feedback). Pure:
// no browser needed, so it is tested on its own.
//
// TradingView exports (its help centre, 2026-11): chart data as CSV, a
// watchlist as .txt, strategy reports and trading history. Drawings, layouts
// and Pine scripts cannot be exported. We read two:
//
// - Chart data ("Export chart data…"): `time,open,high,low,close[,Volume][,<plot>...]`,
//   time as Unix seconds or ISO 8601; the file is named like
//   "COINBASE_BTCUSD, 60.csv" (exchange_symbol, resolution).
// - Watchlist ("Export list"): one line of comma-separated `EXCHANGE:SYMBOL`,
//   with `###Section` entries starting sections.
//
// Imported data is only shown in the browser: it is never written to our
// stored bars (raw data comes only from the feed plan, CLAUDE.md rule 3).

import type { Timeframe } from '@aia/shared-kernel';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 250_000;

export interface ImportedBar {
  /** Bar open time, UTC seconds. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
  /** The file's other columns (indicator plots), where they have a number. */
  readonly plots: Readonly<Record<string, number>>;
}

export interface ImportedChart {
  readonly kind: 'chart';
  readonly fileName: string;
  /** The TradingView symbol without its exchange, from the file name ("BTCUSD"). */
  readonly symbol: string | undefined;
  readonly exchange: string | undefined;
  readonly timeframe: Timeframe | undefined;
  readonly plotNames: readonly string[];
  /** Oldest first, one per time. */
  readonly bars: readonly ImportedBar[];
}

export interface WatchlistSection {
  readonly title: string | undefined;
  /** TradingView symbols as exported, e.g. "COINBASE:BTCUSD". */
  readonly symbols: readonly string[];
}

export interface ImportedWatchlist {
  readonly kind: 'watchlist';
  readonly name: string;
  readonly sections: readonly WatchlistSection[];
}

export type ImportResult = { readonly ok: true; readonly value: ImportedChart | ImportedWatchlist } | { readonly ok: false; readonly message: string };

const RESOLUTIONS: Readonly<Record<string, Timeframe>> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  D: '1D',
  '1D': '1D',
  W: '1W',
  '1W': '1W',
  M: '1M',
  '1M': '1M',
};

/** Our timeframe for a typical spacing between bars, in seconds. */
const SPACINGS: readonly [number, Timeframe][] = [
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [3_600, '1h'],
  [14_400, '4h'],
];

/** "COINBASE_BTCUSD, 60.csv", "BATS_NVDA, 1D_a1b2c.csv", "BTCUSD, 240 (1).csv". */
export function parseChartFileName(fileName: string): { exchange?: string; symbol?: string; timeframe?: Timeframe } {
  const match = /^(.+?), ?([0-9]*[DWM]?)(?:_[0-9a-z]+)?(?: \(\d+\))?\.csv$/i.exec(fileName.trim());
  if (match === null) return {};
  const [, ticker = '', resolution = ''] = match;
  const cut = ticker.indexOf('_');
  const timeframe = RESOLUTIONS[resolution.toUpperCase()];
  return {
    ...(cut > 0 ? { exchange: ticker.slice(0, cut), symbol: ticker.slice(cut + 1) } : { symbol: ticker }),
    ...(timeframe === undefined ? {} : { timeframe }),
  };
}

/** Splits CSV text into rows of fields; handles quoted fields. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** A time cell as UTC seconds: Unix seconds, Unix milliseconds or ISO 8601. */
export function parseTime(cell: string): number | undefined {
  const text = cell.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Math.round(n > 1e12 ? n / 1000 : n);
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
}

function number(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const text = cell.trim();
  if (text === '' || /^nan$/i.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function inferTimeframe(bars: readonly ImportedBar[]): Timeframe | undefined {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length && gaps.length < 500; i++) gaps.push((bars[i]?.time ?? 0) - (bars[i - 1]?.time ?? 0));
  if (gaps.length === 0) return undefined;
  gaps.sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const intraday = SPACINGS.find(([s]) => s === typical)?.[1];
  if (intraday !== undefined) return intraday;
  if (typical >= 86_400 && typical < 4 * 86_400) return '1D';
  if (typical >= 6 * 86_400 && typical <= 8 * 86_400) return '1W';
  if (typical >= 28 * 86_400 && typical <= 31 * 86_400) return '1M';
  return undefined;
}

export function parseChartCsv(text: string, fileName: string): ImportResult {
  const rows = csvRows(text);
  const header = rows[0]?.map((h) => h.trim());
  if (header === undefined) return { ok: false, message: 'The file is empty.' };
  const lower = header.map((h) => h.toLowerCase());
  const at = (name: string) => lower.indexOf(name);
  const [iTime, iOpen, iHigh, iLow, iClose] = ['time', 'open', 'high', 'low', 'close'].map(at);
  if ([iTime, iOpen, iHigh, iLow, iClose].some((i) => i === undefined || i < 0)) {
    return { ok: false, message: 'This is not TradingView chart data: it needs time, open, high, low and close columns.' };
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { ok: false, message: `The file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} bars.` };
  const iVolume = at('volume');
  const known = new Set([iTime, iOpen, iHigh, iLow, iClose, iVolume]);
  // The other columns are indicator plots; repeated names get a number.
  const plotColumns: [number, string][] = [];
  const used = new Map<string, number>();
  header.forEach((name, index) => {
    if (known.has(index)) return;
    const base = name === '' ? `Column ${index + 1}` : name;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    plotColumns.push([index, seen === 1 ? base : `${base} ${seen}`]);
  });

  const byTime = new Map<number, ImportedBar>();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const time = parseTime(row[iTime as number] ?? '');
    const open = number(row[iOpen as number]);
    const high = number(row[iHigh as number]);
    const low = number(row[iLow as number]);
    const close = number(row[iClose as number]);
    if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
      skipped += 1;
      continue;
    }
    const plots: Record<string, number> = {};
    for (const [index, name] of plotColumns) {
      const value = number(row[index]);
      if (value !== undefined) plots[name] = value;
    }
    const volume = iVolume < 0 ? undefined : number(row[iVolume]);
    byTime.set(time, { time, open, high, low, close, ...(volume === undefined ? {} : { volume }), plots });
  }
  if (byTime.size === 0) return { ok: false, message: skipped > 0 ? 'No row has a valid time and prices.' : 'The file has no bars.' };
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  const named = parseChartFileName(fileName);
  return {
    ok: true,
    value: {
      kind: 'chart',
      fileName,
      symbol: named.symbol,
      exchange: named.exchange,
      timeframe: named.timeframe ?? inferTimeframe(bars),
      plotNames: plotColumns.map(([, name]) => name).filter((name) => bars.some((b) => b.plots[name] !== undefined)),
      bars,
    },
  };
}

export function parseWatchlist(text: string, fileName: string): ImportResult {
  const entries = text
    .split(/[,\r\n]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const sections: { title: string | undefined; symbols: string[] }[] = [];
  let current: { title: string | undefined; symbols: string[] } | undefined;
  for (const entry of entries) {
    if (entry.startsWith('###')) {
      current = { title: entry.slice(3).trim() || undefined, symbols: [] };
      sections.push(current);
    } else if (/^[A-Za-z0-9_.!:\-/]+$/.test(entry)) {
      if (current === undefined) {
        current = { title: undefined, symbols: [] };
        sections.push(current);
      }
      if (!current.symbols.includes(entry)) current.symbols.push(entry);
    } else {
      return { ok: false, message: `This is not a TradingView watchlist: "${entry.slice(0, 40)}" is not a symbol.` };
    }
  }
  const kept = sections.filter((s) => s.symbols.length > 0);
  if (kept.length === 0) return { ok: false, message: 'The watchlist has no symbols.' };
  return { ok: true, value: { kind: 'watchlist', name: fileName.replace(/\.txt$/i, ''), sections: kept } };
}

/** Reads a TradingView export: chart data when it has a price header, otherwise a watchlist. */
export function parseTradingViewFile(text: string, fileName: string): ImportResult {
  const firstLine = text.slice(0, 2_000).split(/\r?\n/)[0]?.toLowerCase() ?? '';
  const looksLikeChart = /(^|,)\s*"?time"?\s*(,|$)/.test(firstLine) && firstLine.includes('close');
  return looksLikeChart || /\.csv$/i.test(fileName) ? parseChartCsv(text, fileName) : parseWatchlist(text, fileName);
}

/** Our instrument for a TradingView symbol ("COINBASE:BTCUSD" or "BTCUSD"), if we have it. */
export function matchInstrument(tvSymbol: string | undefined, ours: readonly string[]): string | undefined {
  if (tvSymbol === undefined) return undefined;
  const bare = (tvSymbol.includes(':') ? tvSymbol.slice(tvSymbol.indexOf(':') + 1) : tvSymbol).toUpperCase();
  return ours.find((s) => s.toUpperCase() === bare);
}
