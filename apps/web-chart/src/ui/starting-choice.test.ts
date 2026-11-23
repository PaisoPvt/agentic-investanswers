import type { InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { startingChoice } from './starting-choice.js';

const info = (symbol: string, included: readonly Timeframe[]): InstrumentInfo => ({
  symbol,
  kind: 'crypto',
  timeframes: ['1m', '5m', '1h', '1D'],
  included,
  pricePrecision: 2,
  volumePrecision: 8,
});

const LIST = [info('NVDA', []), info('BTCUSD', ['1m', '5m', '1h']), info('ETHUSD', ['5m', '1h'])];

describe('startingChoice', () => {
  it('opens on the first instrument open to the caller, at 1m or its shortest included timeframe', () => {
    expect(startingChoice(LIST)).toEqual({ symbol: 'BTCUSD', timeframe: '1m' });
    expect(startingChoice([info('ETHUSD', ['5m', '1h'])])).toEqual({ symbol: 'ETHUSD', timeframe: '5m' });
    expect(startingChoice([info('NVDA', [])])).toBeUndefined();
  });

  it('opens on the saved instrument and timeframe when the plan still includes them', () => {
    expect(startingChoice(LIST, { instrument: 'ETHUSD', timeframe: '1h' })).toEqual({ symbol: 'ETHUSD', timeframe: '1h' });
  });

  it('keeps the saved instrument but falls back on its timeframe when that is no longer included', () => {
    expect(startingChoice(LIST, { instrument: 'ETHUSD', timeframe: '1m' })).toEqual({ symbol: 'ETHUSD', timeframe: '5m' });
    expect(startingChoice(LIST, { instrument: 'ETHUSD' })).toEqual({ symbol: 'ETHUSD', timeframe: '5m' });
  });

  it('ignores a saved instrument that is gone or not on the plan', () => {
    expect(startingChoice(LIST, { instrument: 'DOGEUSD', timeframe: '1h' })).toEqual({ symbol: 'BTCUSD', timeframe: '1m' });
    expect(startingChoice(LIST, { instrument: 'NVDA', timeframe: '1h' })).toEqual({ symbol: 'BTCUSD', timeframe: '1m' });
  });

  it('opens on what an embedding page asked for, ahead of the saved choice, where the plan includes it', () => {
    expect(startingChoice(LIST, { instrument: 'ETHUSD', timeframe: '1h' }, { instrument: 'BTCUSD', timeframe: '5m' })).toEqual({ symbol: 'BTCUSD', timeframe: '5m' });
    expect(startingChoice(LIST, { instrument: 'ETHUSD', timeframe: '1h' }, { instrument: 'NVDA' })).toEqual({ symbol: 'ETHUSD', timeframe: '1h' });
  });
});
