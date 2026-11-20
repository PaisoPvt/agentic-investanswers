// Imported TradingView chart data on the chart (UI-03): its close, and any
// indicator plots in the file, drawn as lines over our bars by the same
// template that draws server output (`aia-output`, which only looks values up
// by bar time). Shown only when the chart is on the file's instrument and
// timeframe. After each load of the chart's bars it reports how many match.

import type { OutputInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

import type { MatchReport } from '../import/compare.js';
import { compareBars } from '../import/compare.js';
import type { ImportedChart } from '../import/tradingview.js';
import type { LayerChart } from './indicator-layer.js';
import { OUTPUT_TEMPLATE, overlayFigures, overlayPoints } from './indicator-overlay.js';

// Not `aia-<id>`, which server indicators use.
export const IMPORT_ID = 'tv-import';

export interface ImportTarget {
  readonly instrument: string;
  readonly timeframe: Timeframe;
  readonly pricePrecision: number;
}

/** What the import is matched to: our instrument and timeframe for the file. */
export interface ShownImport {
  readonly data: ImportedChart;
  readonly instrument: string | undefined;
  readonly timeframe: Timeframe | undefined;
}

export interface ImportLayerDeps {
  readonly chart: () => LayerChart | undefined;
  /** The match report, or undefined while the import is not on this chart. */
  readonly onReport: (report: MatchReport | undefined) => void;
}

/** Plot keys are made safe for KLineChart figure keys. */
const plotKey = (index: number) => `plot${index}`;

export class ImportLayer {
  private target: ImportTarget | undefined;
  private shown: ShownImport | undefined;
  private onChart = false;
  private revision = 0;

  constructor(private readonly deps: ImportLayerDeps) {}

  show(target: ImportTarget, shown: ShownImport | undefined): void {
    this.target = target;
    this.shown = shown;
    const matches = shown !== undefined && shown.instrument === target.instrument && shown.timeframe === target.timeframe;
    const chart = this.deps.chart();
    if (!matches || chart === undefined) {
      this.remove();
      this.deps.onReport(undefined);
      return;
    }
    const outputs: OutputInfo[] = [
      { key: 'close', label: 'TradingView close', kind: 'line' },
      ...shown.data.plotNames.map((name, i) => ({ key: plotKey(i), label: name, kind: 'line' as const })),
    ];
    const byTime = new Map<number, Record<string, number>>();
    for (const bar of shown.data.bars) {
      const values: Record<string, number> = { close: bar.close };
      shown.data.plotNames.forEach((name, i) => {
        const value = bar.plots[name];
        if (value !== undefined) values[plotKey(i)] = value;
      });
      byTime.set(bar.time * 1000, values);
    }
    overlayPoints.set(IMPORT_ID, { outputs, byTime });
    const indicator = {
      name: OUTPUT_TEMPLATE,
      id: IMPORT_ID,
      paneId: 'candle_pane',
      shortName: 'TradingView',
      precision: target.pricePrecision,
      figures: overlayFigures(outputs),
      styles: { lines: [{ color: '#f59e0b', size: 2 }, { color: '#8b5cf6' }, { color: '#0ea5e9' }, { color: '#ec4899' }] },
      extendData: ++this.revision,
    };
    if (this.onChart) chart.overrideIndicator(indicator);
    else {
      chart.createIndicator(indicator, true);
      this.onChart = true;
    }
    this.report();
  }

  /** The chart's bars were (re)loaded: report again. */
  refresh(): void {
    if (this.onChart) this.report();
  }

  private report(): void {
    const chart = this.deps.chart();
    const { shown, target } = this;
    if (chart === undefined || shown === undefined || target === undefined) return;
    this.deps.onReport(compareBars(shown.data.bars, chart.getDataList(), target.pricePrecision));
  }

  private remove(): void {
    if (this.onChart) this.deps.chart()?.removeIndicator({ id: IMPORT_ID });
    this.onChart = false;
    overlayPoints.delete(IMPORT_ID);
  }

  dispose(): void {
    this.remove();
  }
}
