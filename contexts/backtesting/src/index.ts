// Public entry of the backtesting context. Other packages import only from here.

export type {
  BacktestConfig,
  BacktestState,
  BacktestResult,
  BacktestTotals,
  ExitReason,
  OpenPosition,
  Side,
  Signal,
  Sizing,
  Trade,
} from './domain/backtest.js';
export { BacktestError, TRADINGVIEW_DEFAULTS, backtest, startBacktest, stepBacktest, summarise } from './domain/backtest.js';
export type { DrawnBar, ExportedTradeView, IndicatorParityInput, ParityCheck } from './domain/indicator-parity.js';
export { compareIndicatorParity, formatIndicatorParity, indicatorParityPassed } from './domain/indicator-parity.js';
export type { ChartExport, ExportedTrade, SummaryKey } from './adapters/tradingview-strategy-export.js';
export { StrategyExportError, decimalsOf, readChartExport, readSummaryExport, readTradesExport, scaledBars } from './adapters/tradingview-strategy-export.js';
