import { describe, expect, it } from 'vitest';

import { embedOptions } from './embed-options.js';

describe('embedOptions', () => {
  it('is the full chart with nothing requested by default', () => {
    expect(embedOptions('')).toEqual({ compact: false, requested: {} });
  });

  it('reads the compact layout and what to open on', () => {
    expect(embedOptions('?embed=1&symbol=ethusd&timeframe=1h')).toEqual({ compact: true, requested: { instrument: 'ETHUSD', timeframe: '1h' } });
  });

  it('drops a timeframe we do not have, and an empty symbol', () => {
    expect(embedOptions('?symbol=&timeframe=2h&embed=yes')).toEqual({ compact: false, requested: {} });
  });
});
