// Drawing an indicator's server output on the chart (M3-05). The browser
// never computes an indicator (CLAUDE.md rule 5): the platform sends drawn
// points (POST /indicators/:id/outputs) and this module hands them to
// KLineChart, matched to bars by time.
//
// One KLineChart indicator template, `aia-output` (output-template.ts), draws
// any indicator: its `calc` looks each bar's values up by timestamp (no
// arithmetic), lines and levels become line figures, bands two lines, and
// markers are drawn as arrows. KLineChart's own indicators stay unused.
// This module needs no browser, so it is tested without one.
//
// The points live in `overlayPoints`, by chart indicator id, not in
// KLineChart's `extendData`: KLineChart deep-merges an override into the
// indicator, which would turn a Map into a plain object and could keep an old
// instrument's points. `extendData` only carries a revision number, so a new
// one makes KLineChart recalculate.

import type { IndicatorOutputsResponse, MarkerPoint, OutputInfo, OutputPointValue } from '@aia/client-contract';
import type { IndicatorFigure, KLineData } from 'klinecharts';

export const OUTPUT_TEMPLATE = 'aia-output';

/** One bar's numbers for KLineChart, keyed by figure key; missing where nothing is drawn. */
export type OverlayRow = Partial<Record<string, number>>;

/** What each chart indicator carries: the server's points, by bar open time in milliseconds. */
export interface OverlayData {
  readonly outputs: readonly OutputInfo[];
  readonly byTime: ReadonlyMap<number, Readonly<Record<string, OutputPointValue>>>;
}

/** The points each chart indicator draws, by its KLineChart id; set by IndicatorLayer, read by the template. */
export const overlayPoints = new Map<string, OverlayData>();

const isMarker = (value: OutputPointValue): value is MarkerPoint => typeof value === 'object' && value !== null && 'side' in value;

/** The figures (lines) an indicator's outputs need; markers are drawn separately. */
export function overlayFigures(outputs: readonly OutputInfo[]): IndicatorFigure[] {
  const figures: IndicatorFigure[] = [];
  for (const output of outputs) {
    if (output.kind === 'line' || output.kind === 'level') figures.push({ key: output.key, title: `${output.label}: `, type: 'line' });
    if (output.kind === 'band') {
      figures.push({ key: `${output.key}.upper`, title: `${output.label} upper: `, type: 'line' });
      figures.push({ key: `${output.key}.lower`, title: `${output.label} lower: `, type: 'line' });
    }
  }
  return figures;
}

/** The server's response, closed points and the forming one, indexed by bar time. */
export function overlayData(response: IndicatorOutputsResponse): OverlayData {
  const byTime = new Map<number, Readonly<Record<string, OutputPointValue>>>();
  for (const point of response.points) byTime.set(point.time * 1000, point.values);
  if (response.forming !== undefined) byTime.set(response.forming.time * 1000, response.forming.values);
  return { outputs: response.outputs, byTime };
}

/** One row per chart bar, in the chart's order: the line values the server sent for that bar. */
export function overlayRows(bars: readonly Pick<KLineData, 'timestamp'>[], data: OverlayData | undefined): OverlayRow[] {
  return bars.map((bar) => {
    const values = data?.byTime.get(bar.timestamp);
    const row: OverlayRow = {};
    if (values === undefined || data === undefined) return row;
    for (const output of data.outputs) {
      const value = values[output.key];
      if (typeof value === 'number') row[output.key] = value;
      else if (output.kind === 'band' && typeof value === 'object' && value !== null && 'upper' in value) {
        row[`${output.key}.upper`] = value.upper;
        row[`${output.key}.lower`] = value.lower;
      }
    }
    return row;
  });
}

/** The markers to draw on these bars, with the bar each belongs to. */
export function overlayMarkers(bars: readonly Pick<KLineData, 'timestamp'>[], data: OverlayData | undefined): { timestamp: number; marker: MarkerPoint }[] {
  const markers: { timestamp: number; marker: MarkerPoint }[] = [];
  if (data === undefined) return markers;
  const keys = data.outputs.filter((o) => o.kind === 'marker').map((o) => o.key);
  for (const bar of bars) {
    const values = data.byTime.get(bar.timestamp);
    if (values === undefined) continue;
    for (const key of keys) {
      const value = values[key];
      if (value !== undefined && isMarker(value)) markers.push({ timestamp: bar.timestamp, marker: value });
    }
  }
  return markers;
}
