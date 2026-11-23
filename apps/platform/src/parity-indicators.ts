// `pnpm parity:indicators` (M3-03): an indicator and its backtest against
// TradingView's exports of the same strategy (OI-30 for the SMA demo). Our
// indicator, loaded from AIA_INDICATORS as the platform does (rule 5: only
// its drawn outputs are compared), and our backtest (M3-06) are fed
// TradingView's own exported bars, so any difference is in our logic.
//
//   AIA_INDICATORS=../agentic-investanswers-indicators/src/index.ts pnpm parity:indicators [--indicator sma] [--symbol BTCUSD] [--tf 1h] [--fixtures DIR]
//
// Looks beside the bar exports for <symbol>_<tf>_<indicator>.csv (chart data
// with the plots, UNIX time), …_trades.csv (List of trades) and
// …_summary.csv (Performance summary), exported with the chart in UTC. The
// indicator runs at its default settings, as the exported script does; its
// "long" and "short" markers are its entries.
//
// Exits 0 when plotted values, signals, trades and totals are all exact, 1
// when one differs, 2 when an export or the indicator is missing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DrawnBar, Signal } from '@aia/backtesting';
import { TRADINGVIEW_DEFAULTS, backtest, compareIndicatorParity, formatIndicatorParity, indicatorParityPassed, readChartExport, readSummaryExport, readTradesExport, scaledBars } from '@aia/backtesting';
import { KNOWN_INSTRUMENTS } from '@aia/data';
import { defaultSettings, runAll } from '@aia/indicators';

import { indicatorModules, loadIndicators } from './load-indicators.js';

/** Where the bar exports live (docs/bar-rules.md); the strategy exports go beside them. */
const DEFAULT_DIR = ['fixtures', 'parity', 'tradingview'].join('/');
/** Which marker outputs are entries, by key. */
const ENTRIES = { long: 'long', short: 'short' } as const;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function option(args: readonly string[], name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : (args[at + 1] ?? fail(`--${name} needs a value`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = option(args, 'indicator', 'sma');
  const symbol = option(args, 'symbol', 'BTCUSD');
  const tf = option(args, 'tf', '1h');
  const dir = option(args, 'fixtures', DEFAULT_DIR);

  const instrument = KNOWN_INSTRUMENTS.find((i) => i.symbol === symbol) ?? fail(`Unknown symbol ${symbol}`);
  const base = join(dir, `${symbol.toLowerCase()}_${tf.toLowerCase()}_${id}`);
  const files = { chart: `${base}.csv`, trades: `${base}_trades.csv`, summary: `${base}_summary.csv` };
  const missing = Object.values(files).filter((f) => !existsSync(f));
  if (missing.length > 0) fail(`Missing TradingView exports (OI-30): ${missing.join(', ')}\nExport them as docs/bar-rules.md ("Indicator parity") describes.`);

  const registry = await loadIndicators(indicatorModules(process.env));
  const definition = registry.get(id) ?? fail(`No indicator "${id}" loaded; set AIA_INDICATORS (loaded: ${registry.list().map((d) => d.id).join(', ') || 'none'})`);

  const chart = readChartExport(files.chart, readFileSync(files.chart, 'utf8'));
  // The export's last bar was still forming when saved (docs/bar-rules.md).
  const bars = scaledBars(chart, instrument.priceScale, instrument.volumeScale).slice(0, -1);
  const plots = new Map([...chart.plots].map(([name, values]) => [name, values.slice(0, bars.length)]));

  const { points } = runAll(definition, defaultSettings(definition.inputs), instrument, bars);
  const byTime = new Map(points.map((p) => [p.time as number, p.values]));
  const drawn: DrawnBar[] = bars.map((b) => ({ time: b.time, values: byTime.get(b.time) ?? {} }));
  const signals: Signal[] = drawn.flatMap((d) =>
    Object.entries(ENTRIES)
      .filter(([key]) => d.values[key] !== null && d.values[key] !== undefined)
      .map(([, side]) => ({ time: d.time, kind: 'enter' as const, side })),
  );
  const result = backtest(instrument, bars, signals, TRADINGVIEW_DEFAULTS);

  const checks = compareIndicatorParity({
    priceScale: instrument.priceScale,
    barTimes: bars.map((b) => b.time),
    plots,
    outputs: definition.outputs,
    drawn,
    entries: ENTRIES,
    exportedTrades: readTradesExport(files.trades, readFileSync(files.trades, 'utf8')),
    trades: result.trades,
    summary: readSummaryExport(files.summary, readFileSync(files.summary, 'utf8')),
    totals: result.totals,
  });
  console.log(formatIndicatorParity(checks, `INDICATOR PARITY: ${definition.name} v${definition.version} on ${symbol} ${tf}, ${bars.length} bars from ${files.chart}`));
  process.exit(indicatorParityPassed(checks) ? 0 : 1);
}

await main().catch((failure: unknown) => fail(failure instanceof Error ? failure.message : String(failure)));
