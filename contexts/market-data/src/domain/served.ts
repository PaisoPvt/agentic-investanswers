// Which instrument and timeframe pairs have bars to serve (M2-03). Pure.
//
// Crypto, every timeframe (1D, 1W and 1M since M1-08a). Stocks are not
// cooked yet: their raw 1m is at the provider's precision, not the
// instrument's, so it cannot be served as it is (M1-08b).

import type { Instrument, Timeframe } from '@aia/shared-kernel';

/** `undefined` when served, otherwise why not, in words a client can show. */
export function whyNotServed(instrument: Instrument, timeframe: Timeframe): string | undefined {
  if (instrument.kind === 'stock') return `${instrument.symbol} ${timeframe} bars are not served yet (stocks arrive with M1-08b)`;
  return undefined;
}
