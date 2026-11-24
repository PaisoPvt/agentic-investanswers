// The chart inside another site's page (M2-11): `?embed=1` gives a compact
// layout (pickers, chart and status only), and `?symbol=` / `?timeframe=` say
// what to open on. Which sites may frame the chart is CloudFront's
// `frame-ancestors` header (config/embed.json), not this. Pure.

import type { ChartPreferencesDto } from '@aia/client-contract';
import { isTimeframe } from '@aia/shared-kernel';

export interface EmbedOptions {
  /** Pickers, chart and status only: no drawing panel, watchlist or import. */
  readonly compact: boolean;
  /** What the page asked to open on; ignored where the plan does not include it. */
  readonly requested: ChartPreferencesDto;
}

export function embedOptions(search: string): EmbedOptions {
  const query = new URLSearchParams(search);
  const symbol = query.get('symbol') ?? undefined;
  const timeframe = query.get('timeframe') ?? undefined;
  return {
    compact: query.get('embed') === '1',
    requested: {
      ...(symbol === undefined || symbol === '' ? {} : { instrument: symbol.toUpperCase() }),
      ...(timeframe !== undefined && isTimeframe(timeframe) ? { timeframe } : {}),
    },
  };
}
