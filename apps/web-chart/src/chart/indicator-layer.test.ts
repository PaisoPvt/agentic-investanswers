import type { IndicatorOutputsRequest, IndicatorOutputsResponse } from '@aia/client-contract';
import type { IndicatorCreate } from 'klinecharts';
import { describe, expect, it } from 'vitest';

import type { LayerChart } from './indicator-layer.js';
import { FORMING_REFRESH_MS, IndicatorLayer, NEW_BAR_CHECK_MS } from './indicator-layer.js';
import { overlayPoints } from './indicator-overlay.js';

const T = 1_762_790_400;

class FakeChart {
  created: IndicatorCreate[] = [];
  overrides: IndicatorCreate[] = [];
  removed: string[] = [];
  bars = [{ timestamp: T * 1000, open: 1, high: 1, low: 1, close: 1 }];
  createIndicator = (value: string | IndicatorCreate) => {
    this.created.push(value as IndicatorCreate);
    return (value as IndicatorCreate).id ?? null;
  };
  overrideIndicator = (value: IndicatorCreate) => {
    this.overrides.push(value);
    return true;
  };
  removeIndicator = (filter?: { id?: string }) => {
    this.removed.push(filter?.id ?? '');
    return true;
  };
  getDataList = () => this.bars;
}

function answer(request: IndicatorOutputsRequest, value: number): IndicatorOutputsResponse {
  return {
    indicatorId: 'sma',
    name: 'SMA',
    instrument: request.instrument,
    timeframe: request.timeframe,
    settings: request.settings ?? {},
    outputs: [{ key: 'sma', label: 'SMA', kind: 'line' }],
    points: [{ time: T, values: { sma: value } }],
  };
}

function setup() {
  const chart = new FakeChart();
  const asked: IndicatorOutputsRequest[] = [];
  const pending: ((value: number) => void)[] = [];
  const timers = new Map<number, () => void>();
  const errors: [string, string | undefined][] = [];
  const layer = new IndicatorLayer({
    chart: () => chart as unknown as LayerChart,
    fetch: (_id, request) => {
      asked.push(request);
      return new Promise((resolve) => pending.push((value) => resolve(answer(request, value))));
    },
    onError: (id, message) => errors.push([id, message]),
    every: (ms, run) => {
      timers.set(ms, run);
      return () => timers.delete(ms);
    },
  });
  return { chart, asked, pending, timers, errors, layer };
}

const target = { instrument: 'BTCUSD', timeframe: '1h', pricePrecision: 2 };
const sma = (length: number) => ({ id: 'sma', settings: { length, source: 'close' } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('IndicatorLayer', () => {
  it('adds an indicator on the price pane, asks the server, then draws its points', async () => {
    const { chart, asked, pending, layer } = setup();
    layer.show(target, [sma(20)]);
    expect(chart.created[0]).toMatchObject({ name: 'aia-output', id: 'aia-sma', paneId: 'candle_pane', shortName: 'SMA', calcParams: [20], precision: 2 });
    expect(asked).toEqual([{ instrument: 'BTCUSD', timeframe: '1h', settings: { length: 20, source: 'close' } }]);
    pending[0]?.(100.5);
    await flush();
    const drawn = chart.overrides.at(-1);
    expect(drawn?.figures?.map((f) => f.key)).toEqual(['sma']);
    expect(drawn?.extendData).not.toBe(chart.created[0]?.extendData); // a new revision: KLineChart recalculates
    expect(overlayPoints.get('aia-sma')?.byTime.get(T * 1000)).toEqual({ sma: 100.5 });
  });

  it('a new timeframe clears the old points at once and drops an answer to the old question', async () => {
    const { asked, pending, layer } = setup();
    layer.show(target, [sma(20)]);
    layer.show({ ...target, timeframe: '4h' }, [sma(20)]);
    expect(overlayPoints.has('aia-sma')).toBe(false);
    expect(asked.map((a) => a.timeframe)).toEqual(['1h', '4h']);
    pending[1]?.(400);
    pending[0]?.(100);
    await flush();
    expect(overlayPoints.get('aia-sma')?.byTime.get(T * 1000)).toEqual({ sma: 400 });
  });

  it('new settings ask again; the same settings do not', () => {
    const { asked, layer } = setup();
    layer.show(target, [sma(20)]);
    layer.show(target, [sma(20)]);
    layer.show(target, [sma(50)]);
    expect(asked.map((a) => a.settings?.['length'])).toEqual([20, 50]);
  });

  it('removing an indicator takes it off the chart', () => {
    const { chart, layer } = setup();
    layer.show(target, [sma(20)]);
    layer.show(target, []);
    expect(chart.removed).toEqual(['aia-sma']);
    expect(overlayPoints.has('aia-sma')).toBe(false);
  });

  it('asks again when a new bar appears, and every minute for the forming point', () => {
    const { chart, asked, timers, layer } = setup();
    layer.show(target, [sma(20)]);
    timers.get(NEW_BAR_CHECK_MS)?.();
    expect(asked).toHaveLength(1);
    chart.bars = [...chart.bars, { timestamp: (T + 3_600) * 1000, open: 1, high: 1, low: 1, close: 1 }];
    timers.get(NEW_BAR_CHECK_MS)?.();
    expect(asked).toHaveLength(2);
    timers.get(FORMING_REFRESH_MS)?.();
    expect(asked).toHaveLength(3);
  });

  it('reports a refusal with the server message, and clears it once drawn', async () => {
    const chart = new FakeChart();
    const errors: [string, string | undefined][] = [];
    let fail = true;
    const layer = new IndicatorLayer({
      chart: () => chart as unknown as LayerChart,
      fetch: (_id, request) => (fail ? Promise.reject(new Error('your plan does not include BTCUSD 1h')) : Promise.resolve(answer(request, 1))),
      onError: (id, message) => errors.push([id, message]),
      every: () => () => undefined,
    });
    layer.show(target, [sma(20)]);
    await flush();
    fail = false;
    layer.refreshAll();
    await flush();
    expect(errors).toEqual([
      ['sma', 'your plan does not include BTCUSD 1h'],
      ['sma', undefined],
    ]);
  });
});
