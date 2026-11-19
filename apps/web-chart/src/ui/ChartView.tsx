// The KLineChart canvas. It only binds: bars come from ChartFeed (one
// BarSeries at a time over the shared LiveConnection). KLineChart's built-in
// indicators stay off (none is ever created): indicators are drawn from the
// server's output by IndicatorLayer (M3-05), as overlays on this chart. The
// trader's drawings (UI-01) are KLineChart overlays kept by DrawingLayer.

import type { InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import type { Chart } from 'klinecharts';
import { dispose, init } from 'klinecharts';
import { useEffect, useRef } from 'react';

import { ChartFeed } from '../chart/chart-feed.js';
import type { DrawingLayer } from '../chart/drawing-layer.js';
import { registerDrawingTemplates } from '../chart/drawing-templates.js';
import type { ShownIndicator } from '../chart/indicator-layer.js';
import { IndicatorLayer } from '../chart/indicator-layer.js';
import { registerOutputTemplate } from '../chart/output-template.js';
import { periodOf } from '../chart/periods.js';
import { BarSeries } from '../data/bar-series.js';
import type { SeriesStatus } from '../data/bar-series.js';
import type { LiveConnection } from '../data/live-connection.js';
import type { PlatformClient } from '../data/platform-client.js';

declare global {
  interface Window {
    /** The chart, for the end-to-end tests to read its bars (read-only use). */
    __aiaChart?: Chart;
  }
}

export interface ChartViewProps {
  readonly client: PlatformClient;
  readonly live: LiveConnection;
  readonly instrument: InstrumentInfo;
  readonly timeframe: Timeframe;
  readonly onStatus: (status: SeriesStatus) => void;
  /** The indicators to draw, with their accepted settings. */
  readonly indicators?: readonly ShownIndicator[];
  /** Told when an indicator could not be drawn, and again (undefined) once it is. */
  readonly onIndicatorError?: (indicatorId: string, message: string | undefined) => void;
  /** The trader's drawings (UI-01), attached to this chart while it exists. */
  readonly drawings?: DrawingLayer | undefined;
}

const NONE: readonly ShownIndicator[] = [];

export function ChartView({ client, live, instrument, timeframe, onStatus, indicators = NONE, onIndicatorError, drawings }: ChartViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const layer = useRef<IndicatorLayer | null>(null);
  const status = useRef(onStatus);
  status.current = onStatus;
  const indicatorError = useRef(onIndicatorError);
  indicatorError.current = onIndicatorError;

  useEffect(() => {
    const element = container.current;
    if (element === null) return undefined;
    const created = init(element);
    if (created === null) return undefined;
    chart.current = created;
    const feed = new ChartFeed({
      chart: () => chart.current ?? undefined,
      // Steady under frequent resyncs: one reload per 2 s at most, applying only what changed.
      newSeries: (symbol, tf, handlers) =>
        new BarSeries(symbol, tf, { live, history: (s, t) => client.history(s, t), minReloadGapMs: 2_000, quietReloads: true, ...handlers }),
      onStatus: (s) => status.current(s),
    });
    created.setDataLoader(feed);
    registerOutputTemplate();
    layer.current = new IndicatorLayer({
      chart: () => chart.current ?? undefined,
      fetch: (id, request) => client.indicatorOutputs(id, request),
      onError: (id, message) => indicatorError.current?.(id, message),
    });
    registerDrawingTemplates();
    drawings?.attach(created);
    window.__aiaChart = created;
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(element);
    return () => {
      resize.disconnect();
      drawings?.attach(undefined);
      layer.current?.dispose();
      layer.current = null;
      feed.dispose();
      dispose(element);
      chart.current = null;
      if (window.__aiaChart === created) delete window.__aiaChart;
    };
  }, [client, live, drawings]);

  const { symbol, pricePrecision, volumePrecision } = instrument;
  useEffect(() => {
    chart.current?.setSymbol({ ticker: symbol, pricePrecision, volumePrecision });
    drawings?.show(symbol);
  }, [client, live, drawings, symbol, pricePrecision, volumePrecision]);

  useEffect(() => {
    chart.current?.setPeriod(periodOf(timeframe));
  }, [client, live, timeframe]);

  useEffect(() => {
    layer.current?.show({ instrument: symbol, timeframe, pricePrecision }, indicators);
  }, [client, live, symbol, timeframe, pricePrecision, indicators]);

  return <div ref={container} className="chart" data-testid="chart" />;
}
