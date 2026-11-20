// M3-08 (server side): no indicator internals in any answer (CLAUDE.md rule
// 5). A canary indicator (leak-canary-indicator.ts) carries markers in its
// state and code; every indicator route, the MCP tools an agent uses and a
// live connection are checked for them, outputs for numbers finer than the
// instrument's display precision, and outputs responses for any field the
// contract does not declare.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accessFromEnv } from '@aia/access';
import type { IndicatorOutputsResponse } from '@aia/client-contract';
import type { CookedBarsSource } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { IndicatorEngine, IndicatorRegistry, MemoryIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { IndicatorBars } from './indicator-bars.js';
import { LEAK_CANARY_MARKERS, leakCanary } from './leak-canary-indicator.js';
import { buildServer } from './server.js';

const T0 = 1_762_790_400;
const HOUR = 3_600;
const PASSWORD = 'correct horse battery';
const PLANS = join(mkdtempSync(join(tmpdir(), 'aia-leak-')), 'plans.json');
writeFileSync(PLANS, JSON.stringify({ upgradeUrl: 'https://example.com/upgrade', defaultPlan: 'pro', plans: [{ id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' }], assignments: {} }));

/** 1h bars with cents in their closes, the last one still forming at NOW. */
const BARS: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const cents = 1_000_037 + i * 113;
  return { time: barTime(T0 + i * HOUR), open: price(cents), high: price(cents + 50), low: price(cents - 50), close: price(cents), volume: volume(1) };
});
const NOW = barTime(T0 + 39 * HOUR + 600);
const store: CookedBarsSource = {
  getRange: (_s: string, tf: Timeframe, from: BarTime, until: BarTime) => Promise.resolve(tf === '1h' ? BARS.filter((b) => b.time >= from && b.time <= until) : []),
};

/** What an outputs response may hold: the contract's fields, and the indicator's declared output keys in values. */
const TOP = ['indicatorId', 'name', 'instrument', 'timeframe', 'settings', 'outputs', 'points', 'forming'];
const OUTPUT_INFO = ['key', 'label', 'kind'];
const POINT = ['time', 'values'];

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start() {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], cooked: store, earliest: barTime(T0) });
  const registry = new IndicatorRegistry([leakCanary]);
  const bars = new IndicatorBars({ data, now: () => NOW });
  const engine = new IndicatorEngine({ registry, bars, cache: new MemoryIndicatorOutputCache() });
  gateway = new LiveGateway({ data, every: () => () => undefined });
  app = await buildServer({
    history: new HistoryQuery({ data }),
    access: accessFromEnv({ AIA_PLANS: PLANS }),
    live: gateway,
    catalog: data,
    indicators: registry,
    indicatorRunner: { drawn: (r) => engine.drawn(r), forming: (i, t) => bars.forming(i, t) },
    now: () => NOW,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const signUp = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'sam@example.com', password: PASSWORD } });
  const token = (signUp.json() as { token: string }).token;
  const keyRes = await app.inject({ method: 'POST', url: '/auth/agent-keys', headers: { authorization: `Bearer ${token}` }, payload: { name: 'bot' } });
  return { a: app, port, token, agentKey: (keyRes.json() as { key: string }).key };
}

function expectNoMarkers(where: string, text: string): void {
  for (const marker of LEAK_CANARY_MARKERS) expect(text.includes(marker), `${where} contains "${marker}"`).toBe(false);
}

/** Every number in the drawn points has at most `precision` decimals. */
function expectDisplayPrecision(response: IndicatorOutputsResponse, precision: number): void {
  const points = [...response.points, ...(response.forming === undefined ? [] : [response.forming])];
  const numbers = points.flatMap((p) => Object.values(p.values)).filter((v): v is number => typeof v === 'number');
  expect(numbers.length).toBeGreaterThan(0);
  for (const n of numbers) expect(Math.abs(n * 10 ** precision - Math.round(n * 10 ** precision)), `${n} is finer than ${precision} decimals`).toBeLessThan(1e-6);
}

function expectOnlyContractFields(response: IndicatorOutputsResponse): void {
  expect(Object.keys(response).filter((k) => !TOP.includes(k))).toEqual([]);
  for (const o of response.outputs) expect(Object.keys(o).filter((k) => !OUTPUT_INFO.includes(k))).toEqual([]);
  const declared = response.outputs.map((o) => o.key);
  for (const p of [...response.points, ...(response.forming === undefined ? [] : [response.forming])]) {
    expect(Object.keys(p).filter((k) => !POINT.includes(k))).toEqual([]);
    expect(Object.keys(p.values).filter((k) => !declared.includes(k))).toEqual([]);
  }
}

describe('no indicator internals leave the engine (M3-08)', () => {
  it('REST: the listing, the settings check and the outputs carry no internals, only declared fields at display precision', async () => {
    const { a, token } = await start();
    const headers = { authorization: `Bearer ${token}` };
    const listing = await a.inject({ method: 'GET', url: '/indicators', headers });
    expect(listing.statusCode).toBe(200);
    expectNoMarkers('GET /indicators', listing.body);
    const settings = await a.inject({ method: 'POST', url: '/indicators/leakCanary/settings', headers, payload: { settings: { offset: 1.5 } } });
    expect(settings.statusCode).toBe(200);
    expectNoMarkers('POST settings', settings.body);

    const outputs = await a.inject({ method: 'POST', url: '/indicators/leakCanary/outputs', headers, payload: { instrument: 'BTCUSD', timeframe: '1h', settings: { offset: 1.5 } } });
    expect(outputs.statusCode).toBe(200);
    const body = outputs.json() as IndicatorOutputsResponse;
    expect(body.forming).toBeDefined();
    expectNoMarkers('POST outputs', outputs.body);
    expectDisplayPrecision(body, BTCUSD.priceScale);
    expectOnlyContractFields(body);
    // The same request again comes from the engine's cache, where the state is kept: still nothing of it.
    const cached = await a.inject({ method: 'POST', url: '/indicators/leakCanary/outputs', headers, payload: { instrument: 'BTCUSD', timeframe: '1h', settings: { offset: 1.5 } } });
    expect(cached.body).toBe(outputs.body);
  });

  it('MCP: list_indicators and get_indicator_output carry no internals', async () => {
    const { port, agentKey } = await start();
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      return res.text();
    };
    expectNoMarkers('list_indicators', await call('list_indicators', {}));
    const output = await call('get_indicator_output', { indicator: 'leakCanary', instrument: 'BTCUSD', tf: '1h' });
    expect(output).toContain('level');
    expectNoMarkers('get_indicator_output', output);
  });

  it('WebSocket: a live connection carries no internals', async () => {
    const { port, token } = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${encodeURIComponent(token)}`);
    const frames: string[] = [];
    ws.addEventListener('message', (event) => frames.push(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not connect')));
    });
    ws.send(JSON.stringify({ op: 'subscribe', instrument: 'BTCUSD', tf: '1h' }));
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    ws.close();
    expectNoMarkers('live frames', frames.join('\n'));
  });
});
