// Saved chart preferences as clients see them (M2-13). The rules are the
// preferences context's (parsePreferences). Pure.
//
//   GET /preferences   200 ChartPreferencesDto (empty when nothing saved) · 401 · 404 for an agent key
//   PUT /preferences   ChartPreferencesDto, the whole record  204 · 400 invalid_preferences · 401 · 403 read_only
//
// Only a signed-in person has preferences; agent keys are read-only.

import type { Timeframe } from '@aia/shared-kernel';

export interface ChartPreferencesDto {
  /** The last instrument shown, for example BTCUSD. */
  readonly instrument?: string;
  readonly timeframe?: Timeframe;
  /** Saved now, applied once the chart has themes (M2-12). */
  readonly theme?: 'light' | 'dark';
}
