import type { IndicatorOutputsResponse } from '@aia/client-contract';
import { describe, expect, it } from 'vitest';

import { overlayData, overlayFigures, overlayMarkers, overlayRows } from './indicator-overlay.js';

const T = 1_762_790_400;

const response: IndicatorOutputsResponse = {
  indicatorId: 'sma',
  name: 'Simple moving average',
  instrument: 'BTCUSD',
  timeframe: '1h',
  settings: { length: 2, source: 'close' },
  outputs: [
    { key: 'sma', label: 'SMA', kind: 'line' },
    { key: 'long', label: 'Long', kind: 'marker' },
    { key: 'range', label: 'Range', kind: 'band' },
  ],
  points: [
    { time: T, values: { sma: null, long: null, range: null } },
    { time: T + 3_600, values: { sma: 100.5, long: { side: 'below', price: 99, text: 'Long' }, range: { upper: 102, lower: 98 } } },
  ],
  forming: { time: T + 7_200, values: { sma: 101.25, long: null, range: null } },
};

const bars = [T - 3_600, T, T + 3_600, T + 7_200].map((s) => ({ timestamp: s * 1000 }));

describe('indicator overlay', () => {
  it('a line figure per line or level, two per band, none for markers', () => {
    expect(overlayFigures(response.outputs).map((f) => f.key)).toEqual(['sma', 'range.upper', 'range.lower']);
  });

  it('matches the server points to the chart bars by time, the forming point included', () => {
    expect(overlayRows(bars, overlayData(response))).toEqual([{}, {}, { sma: 100.5, 'range.upper': 102, 'range.lower': 98 }, { sma: 101.25 }]);
  });

  it('draws nothing before the points arrive', () => {
    expect(overlayRows(bars, undefined)).toEqual([{}, {}, {}, {}]);
    expect(overlayMarkers(bars, undefined)).toEqual([]);
  });

  it('lists the markers with the bar they belong to', () => {
    expect(overlayMarkers(bars, overlayData(response))).toEqual([{ timestamp: (T + 3_600) * 1000, marker: { side: 'below', price: 99, text: 'Long' } }]);
  });
});
