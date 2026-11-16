// The indicators shown on the chart (M3-05): for each one the user applied,
// the server's drawn output on the current instrument and timeframe, kept on
// the chart as an `aia-output` indicator (indicator-overlay.ts; the caller
// registers the template first, output-template.ts).
//
// - A new instrument, timeframe or setting clears that indicator's points at
//   once (so no line from the old instrument is drawn on the new one) and asks
//   the server again; an answer to an older question is dropped.
// - Outputs are asked again when a new bar appears on the chart (the previous
//   one closed), and every minute for the forming bar's point.

import type { IndicatorOutputsRequest, IndicatorOutputsResponse, IndicatorSettings } from '@aia/client-contract';
import type { Chart } from 'klinecharts';

import type { OverlayData } from './indicator-overlay.js';
import { OUTPUT_TEMPLATE, overlayData, overlayFigures, overlayPoints } from './indicator-overlay.js';

/** An indicator the user applied, with the settings the server accepted. */
export interface ShownIndicator {
  readonly id: string;
  readonly settings: IndicatorSettings;
}

export interface LayerTarget {
  readonly instrument: string;
  readonly timeframe: string;
  readonly pricePrecision: number;
}

export type LayerChart = Pick<Chart, 'createIndicator' | 'overrideIndicator' | 'removeIndicator' | 'getDataList'>;

export interface IndicatorLayerDeps {
  readonly chart: () => LayerChart | undefined;
  readonly fetch: (indicatorId: string, request: IndicatorOutputsRequest) => Promise<IndicatorOutputsResponse>;
  /** Told when an indicator's outputs could not be drawn (undefined once they are again). */
  readonly onError?: (indicatorId: string, message: string | undefined) => void;
  /** Starts a repeating timer; returns its stop. Tests drive it by hand. */
  readonly every?: (ms: number, run: () => void) => () => void;
}

/** How often the chart's newest bar is looked at, and how often the forming point is refreshed. */
export const NEW_BAR_CHECK_MS = 5_000;
export const FORMING_REFRESH_MS = 60_000;

interface Entry {
  readonly chartId: string;
  shown: ShownIndicator;
  /** Bumped on every request, so only the newest answer is drawn. */
  asked: number;
}

const defaultEvery = (ms: number, run: () => void) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

/** A legend name: the id in capitals and the number settings, for example "SMA" with calcParams [20] → "SMA(20)". */
function legend(shown: ShownIndicator): { shortName: string; calcParams: number[] } {
  return { shortName: shown.id.toUpperCase(), calcParams: Object.values(shown.settings).filter((v): v is number => typeof v === 'number') };
}

export class IndicatorLayer {
  private readonly entries = new Map<string, Entry>();
  private target: LayerTarget | undefined;
  private newestBar: number | undefined;
  private readonly stops: (() => void)[];
  /** Bumped on every redraw; KLineChart recalculates when `extendData` changes. */
  private revision = 0;

  constructor(private readonly deps: IndicatorLayerDeps) {
    const every = deps.every ?? defaultEvery;
    this.stops = [every(NEW_BAR_CHECK_MS, () => this.checkNewBar()), every(FORMING_REFRESH_MS, () => this.refreshAll())];
  }

  /** Shows exactly these indicators on this instrument and timeframe. */
  show(target: LayerTarget, list: readonly ShownIndicator[]): void {
    const chart = this.deps.chart();
    if (chart === undefined) return;
    const moved = this.target === undefined || this.target.instrument !== target.instrument || this.target.timeframe !== target.timeframe;
    this.target = target;
    if (moved) this.newestBar = undefined;

    const wanted = new Map(list.map((s) => [s.id, s]));
    for (const [id, entry] of this.entries) {
      if (wanted.has(id)) continue;
      chart.removeIndicator({ id: entry.chartId });
      overlayPoints.delete(entry.chartId);
      this.entries.delete(id);
      this.deps.onError?.(id, undefined);
    }
    for (const shown of list) {
      const entry = this.entries.get(shown.id);
      if (entry === undefined) {
        const chartId = chart.createIndicator(
          { name: OUTPUT_TEMPLATE, id: `aia-${shown.id}`, paneId: 'candle_pane', precision: target.pricePrecision, ...legend(shown), figures: [], extendData: ++this.revision },
          true,
        );
        if (chartId === null) continue;
        this.entries.set(shown.id, { chartId, shown, asked: 0 });
        void this.load(shown.id);
      } else if (moved || JSON.stringify(entry.shown.settings) !== JSON.stringify(shown.settings)) {
        entry.shown = shown;
        this.draw(entry, undefined);
        void this.load(shown.id);
      }
    }
  }

  /** Asks the server again for every indicator shown. */
  refreshAll(): void {
    for (const id of this.entries.keys()) void this.load(id);
  }

  dispose(): void {
    for (const stop of this.stops) stop();
    for (const entry of this.entries.values()) overlayPoints.delete(entry.chartId);
    this.entries.clear();
  }

  private checkNewBar(): void {
    const newest = this.deps.chart()?.getDataList().at(-1)?.timestamp;
    if (newest === undefined) return;
    const changed = this.newestBar !== undefined && newest !== this.newestBar;
    this.newestBar = newest;
    if (changed) this.refreshAll();
  }

  private async load(id: string): Promise<void> {
    const entry = this.entries.get(id);
    const target = this.target;
    if (entry === undefined || target === undefined) return;
    const asked = ++entry.asked;
    try {
      const response = await this.deps.fetch(id, { instrument: target.instrument, timeframe: target.timeframe, settings: entry.shown.settings });
      if (this.entries.get(id) !== entry || entry.asked !== asked) return;
      this.draw(entry, overlayData(response));
      this.deps.onError?.(id, undefined);
    } catch (error: unknown) {
      if (this.entries.get(id) !== entry || entry.asked !== asked) return;
      this.deps.onError?.(id, error instanceof Error ? error.message : 'could not draw this indicator');
    }
  }

  /** Draws these points (none: clears the indicator until the next answer). */
  private draw(entry: Entry, data: OverlayData | undefined): void {
    if (data === undefined) overlayPoints.delete(entry.chartId);
    else overlayPoints.set(entry.chartId, data);
    this.deps.chart()?.overrideIndicator({
      id: entry.chartId,
      name: OUTPUT_TEMPLATE,
      ...legend(entry.shown),
      ...(this.target === undefined ? {} : { precision: this.target.pricePrecision }),
      ...(data === undefined ? {} : { figures: overlayFigures(data.outputs) }),
      extendData: ++this.revision,
    });
  }
}
