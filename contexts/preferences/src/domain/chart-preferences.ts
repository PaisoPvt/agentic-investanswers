// A user's saved chart preferences (M2-13): the last instrument and timeframe
// shown, and the theme (applied once M2-12 brings themes). Every field is
// optional: nothing saved yet means the chart's own defaults. Whether a saved
// instrument and timeframe are still on the user's plan is checked by the
// chart at load, not here, since plans change after a save. Pure.

import type { Timeframe } from '@aia/shared-kernel';
import { isTimeframe } from '@aia/shared-kernel';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface ChartPreferences {
  readonly instrument?: string;
  readonly timeframe?: Timeframe;
  readonly theme?: Theme;
}

/** Our instrument symbols (BTCUSD, NVDA): short, letters, digits and a few separators. */
const SYMBOL = /^[A-Za-z0-9._:-]{1,32}$/;

const FIELDS = new Set(['instrument', 'timeframe', 'theme']);

export type PreferencesParse = { readonly ok: true; readonly value: ChartPreferences } | { readonly ok: false; readonly message: string };

const isTheme = (value: string): value is Theme => (THEMES as readonly string[]).includes(value);

/** Checks what a client sent: an object with only the known fields, each well formed. */
export function parsePreferences(input: unknown): PreferencesParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, message: 'send a JSON object' };
  const fields = input as Record<string, unknown>;
  const unknown = Object.keys(fields).find((name) => !FIELDS.has(name));
  if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}"` };

  const { instrument, timeframe, theme } = fields;
  if (instrument !== undefined && (typeof instrument !== 'string' || !SYMBOL.test(instrument))) {
    return { ok: false, message: 'instrument must be a symbol such as BTCUSD' };
  }
  if (timeframe !== undefined && (typeof timeframe !== 'string' || !isTimeframe(timeframe))) {
    return { ok: false, message: 'timeframe must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M' };
  }
  if (theme !== undefined && (typeof theme !== 'string' || !isTheme(theme))) return { ok: false, message: 'theme must be light or dark' };
  return {
    ok: true,
    value: {
      ...(instrument === undefined ? {} : { instrument }),
      ...(timeframe === undefined ? {} : { timeframe }),
      ...(theme === undefined ? {} : { theme }),
    } as ChartPreferences,
  };
}
