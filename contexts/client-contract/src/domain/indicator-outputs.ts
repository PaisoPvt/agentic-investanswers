// An indicator's drawn outputs as clients see them (M3-05). Pure.
//
//   POST /indicators/:id/outputs   body { instrument, timeframe, settings?, limit? }
//
// Only drawn outputs cross this boundary (CLAUDE.md rule 5): the outputs an
// indicator declares (lines, bands, markers, levels), one point per bar, every
// price already rounded to the instrument's display precision. Never its state
// or anything it computes on the way.

import type { IndicatorSettings } from './indicator-settings.js';

/** Points returned when the request gives no `limit`. */
export const INDICATOR_OUTPUT_DEFAULT_LIMIT = 500;
/** The most points one request returns. */
export const INDICATOR_OUTPUT_MAX_LIMIT = 2_000;

export type OutputKind = 'line' | 'band' | 'marker' | 'level';

/** One declared output: what the legend shows and how to draw it. */
export interface OutputInfo {
  readonly key: string;
  readonly label: string;
  readonly kind: OutputKind;
}

export interface BandPoint {
  readonly upper: number;
  readonly lower: number;
}

export interface MarkerPoint {
  readonly side: 'above' | 'below';
  readonly price: number;
  readonly text?: string;
}

/** A line or level is a number, a band or marker an object; `null` where nothing is drawn on that bar. */
export type OutputPointValue = number | BandPoint | MarkerPoint | null;

/** One bar's drawn values, keyed by output key; `time` is the bar's open time in UTC seconds. */
export interface OutputPoint {
  readonly time: number;
  readonly values: Readonly<Record<string, OutputPointValue>>;
}

/** The request body of POST /indicators/:id/outputs. */
export interface IndicatorOutputsRequest {
  readonly instrument: string;
  readonly timeframe: string;
  /** Missing keys take their default; checked like POST /indicators/:id/settings. */
  readonly settings?: IndicatorSettings;
  /** Newest closed points to return, 1 to INDICATOR_OUTPUT_MAX_LIMIT. */
  readonly limit?: number;
}

export interface IndicatorOutputsResponse {
  readonly indicatorId: string;
  readonly name: string;
  readonly instrument: string;
  readonly timeframe: string;
  /** The settings the outputs were drawn with: defaults filled, values on their step grid. */
  readonly settings: IndicatorSettings;
  readonly outputs: readonly OutputInfo[];
  /** Closed bars' points, oldest first. */
  readonly points: readonly OutputPoint[];
  /** The point on the bar still forming, when there is one; it changes until the bar closes. */
  readonly forming?: OutputPoint;
}
