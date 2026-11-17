// M3-05 (server side): POST /indicators/:id/outputs through the real Fastify
// server, access rules, settings check and indicator engine, on in-memory
// bars. The plan is checked as for /bars, settings as for the dialog, and
// only declared outputs at display precision come back (CLAUDE.md rule 5).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accessFromEnv } from '@aia/access';
import type { IndicatorOutputsResponse, InvalidSettingsBody } from '@aia/client-contract';
import type { CookedBarsSource } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { IndicatorEngine, IndicatorRegistry, MemoryIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery } from '@aia/serving';
import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { IndicatorBars } from './indicator-bars.js';
import { buildServer } from './server.js';
import { settingsDemo } from './settings-demo-indicator.js';

const T0 = 1_762_790_400; // a whole 4h boundary (2025-11-10 16:00 UTC)
const HOUR = 3_600;
const PASSWORD = 'correct horse battery';

const PLANS = join(mkdtempSync(join(tmpdir(), 'aia-outputs-')), 'plans.json');
writeFileSync(
  PLANS,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [{ id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] }],
    assignments: {},
  }),
);

/** 1h bars from T0, closes 100.00, 101.00, ... (cents), the last one still forming at NOW. */
function hourBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const cents = 10_000 + i * 100;
    return { time: barTime(T0 + i * HOUR), open: price(cents), high: price(cents + 50), low: price(cents - 50), close: price(cents), volume: volume(1) };
  });
}

const BARS = hourBars(30);
/** Ten minutes into the 30th bar, which is therefore forming. */
const NOW = barTime(T0 + 29 * HOUR + 600);

const store: CookedBarsSource = {
  getRange: (_symbol: string, tf: Timeframe, from: BarTime, until: BarTime) =>
    Promise.resolve(tf === '1h' ? BARS.filter((b) => b.time >= from && b.time <= until) : []),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<FastifyInstance> {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], cooked: store, earliest: barTime(T0) });
  const registry = new IndicatorRegistry([settingsDemo]);
  const bars = new IndicatorBars({ data, now: () => NOW });
  const engine = new IndicatorEngine({ registry, bars, cache: new MemoryIndicatorOutputCache() });
  app = await buildServer({
    history: new HistoryQuery({ data }),
    access: accessFromEnv({ AIA_PLANS: PLANS }),
    catalog: data,
    indicators: registry,
    indicatorRunner: { drawn: (r) => engine.drawn(r), forming: (i, t) => bars.forming(i, t) },
    now: () => NOW,
  });
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signedIn(a: FastifyInstance): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'user@example.com', password: PASSWORD } });
  return (res.json() as { token: string }).token;
}

const post = (a: FastifyInstance, token: string | undefined, payload: unknown, id = 'settingsDemo') =>
  a.inject({ method: 'POST', url: `/indicators/${id}/outputs`, headers: token === undefined ? {} : auth(token), payload: payload as object });

describe('POST /indicators/:id/outputs', () => {
  it('draws the closed bars, oldest first, and previews the forming one', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { instrument: 'BTCUSD', timeframe: '1h', settings: { offset: 2.5 }, limit: 3 });

    expect(res.statusCode).toBe(200);
    const body = res.json() as IndicatorOutputsResponse;
    expect(body).toMatchObject({ indicatorId: 'settingsDemo', name: 'Settings demo (tests only)', instrument: 'BTCUSD', timeframe: '1h' });
    expect(body.settings).toEqual({ length: 20, offset: 2.5, showSignals: true, style: 'line', source: 'close' });
    expect(body.outputs).toEqual([{ key: 'value', label: 'Value', kind: 'line' }]);
    // Bars 26..28 closed (closes 126, 127, 128) plus 2.5; bar 29 is forming.
    expect(body.points).toEqual([
      { time: T0 + 26 * HOUR, values: { value: 128.5 } },
      { time: T0 + 27 * HOUR, values: { value: 129.5 } },
      { time: T0 + 28 * HOUR, values: { value: 130.5 } },
    ]);
    expect(body.forming).toEqual({ time: T0 + 29 * HOUR, values: { value: 131.5 } });
  });

  it('a different setting draws a different line', async () => {
    const a = await start();
    const token = await signedIn(a);
    const high = (await post(a, token, { instrument: 'BTCUSD', timeframe: '1h', settings: { source: 'high' }, limit: 1 })).json() as IndicatorOutputsResponse;
    expect(high.points).toEqual([{ time: T0 + 28 * HOUR, values: { value: 128.5 } }]);
  });

  it('sends only what is declared, at display precision', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { instrument: 'BTCUSD', timeframe: '1h', settings: { source: 'hlc3' }, limit: 2 });
    const body = res.json() as IndicatorOutputsResponse;
    expect(Object.keys(body).sort()).toEqual(['forming', 'indicatorId', 'instrument', 'name', 'outputs', 'points', 'settings', 'timeframe']);
    for (const point of body.points) expect(Object.keys(point.values)).toEqual(['value']);
    // hlc3 of 127.50/126.50/127.00 is 127.0 exactly; of a third-cent value it would be cut to 2 places.
    expect(body.points.map((p) => p.values['value'])).toEqual([127, 128]);
  });

  it('refuses without a principal (CLAUDE.md rule 4)', async () => {
    const a = await start();
    expect((await post(a, undefined, { instrument: 'BTCUSD', timeframe: '1h' })).statusCode).toBe(401);
  });

  it('refuses an instrument or timeframe outside the plan, as /bars does, with the upgrade link', async () => {
    const a = await start();
    const token = await signedIn(a);
    for (const payload of [{ instrument: 'ETHUSD', timeframe: '1h' }, { instrument: 'BTCUSD', timeframe: '5m' }]) {
      const res = await post(a, token, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: { code: 'forbidden', message: `your plan does not include ${payload.instrument} ${payload.timeframe}`, upgradeUrl: 'https://example.com/upgrade' },
      });
    }
  });

  it('refuses settings outside the declared limits with the same 400 as the dialog', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { instrument: 'BTCUSD', timeframe: '1h', settings: { length: 501, offset: 0.3 } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as InvalidSettingsBody;
    expect(body.error.code).toBe('invalid_settings');
    expect(body.error.fields.map((f) => [f.key, f.code])).toEqual([
      ['length', 'out_of_range'],
      ['offset', 'off_step'],
    ]);
  });

  it('refuses a bad body, a limit over the cap, an unknown instrument or indicator', async () => {
    const a = await start();
    const token = await signedIn(a);
    const cases: [unknown, number, string, string?][] = [
      [{ timeframe: '1h' }, 400, 'bad_parameter'],
      [{ instrument: 'BTCUSD', timeframe: '2h' }, 400, 'bad_parameter'],
      [{ instrument: 'BTCUSD', timeframe: '1h', limit: 0 }, 400, 'bad_parameter'],
      [{ instrument: 'BTCUSD', timeframe: '1h', limit: '5' }, 400, 'bad_parameter'],
      [{ instrument: 'BTCUSD', timeframe: '1h', extra: 1 }, 400, 'bad_parameter'],
      [{ instrument: 'BTCUSD', timeframe: '1h', limit: 2_001 }, 400, 'limit_too_large'],
      [{ instrument: 'DOGEUSD', timeframe: '1h' }, 404, 'unknown_instrument'],
      [{ instrument: 'BTCUSD', timeframe: '1h' }, 404, 'not_found', 'nope'],
    ];
    for (const [payload, status, code, id] of cases) {
      const res = await post(a, token, payload, id);
      expect([res.statusCode, (res.json() as { error: { code: string } }).error.code]).toEqual([status, code]);
    }
  });

  it('gives an agent the same answers as a human (CLAUDE.md rule 4)', async () => {
    const a = await start();
    const session = await signedIn(a);
    const created = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: { name: 'research agent' } });
    const { key } = created.json() as { key: string };
    const payload = { instrument: 'BTCUSD', timeframe: '1h', limit: 5 };
    const human = await post(a, session, payload);
    const agent = await post(a, key, payload);
    expect(agent.statusCode).toBe(200);
    expect(agent.json()).toEqual(human.json());
    expect((await post(a, key, { instrument: 'ETHUSD', timeframe: '1h' })).statusCode).toBe(403);
  });
});
