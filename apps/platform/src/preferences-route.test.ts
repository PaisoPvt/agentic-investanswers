// M2-13: saved chart preferences through the real server and access wiring.
// Each person reads and saves only their own; agent keys have none.

import { accessFromEnv } from '@aia/access';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { ChartPreferencesBook, MemoryPreferencesStore } from '@aia/preferences';
import { HistoryQuery } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const PASSWORD = 'correct horse battery';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<FastifyInstance> {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], earliest: barTime(T0) });
  app = await buildServer({
    history: new HistoryQuery({ data }),
    access: accessFromEnv({}),
    preferences: new ChartPreferencesBook(new MemoryPreferencesStore()),
    now: () => barTime(T0),
  });
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

describe('GET and PUT /preferences', () => {
  it('is empty before the first save, then gives back what the person saved, and only to them', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const kim = await signUp(a, 'kim@example.com');

    expect((await a.inject({ method: 'GET', url: '/preferences', headers: auth(sam) })).json()).toEqual({});
    const saved = await a.inject({ method: 'PUT', url: '/preferences', headers: auth(sam), payload: { instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' } });
    expect(saved.statusCode).toBe(204);

    const mine = await a.inject({ method: 'GET', url: '/preferences', headers: auth(sam) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' });
    expect((await a.inject({ method: 'GET', url: '/preferences', headers: auth(kim) })).json()).toEqual({});
  });

  it('needs a signed-in person', async () => {
    const a = await start();
    expect((await a.inject({ method: 'GET', url: '/preferences' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'PUT', url: '/preferences', payload: { timeframe: '1h' } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/preferences', headers: auth('not-a-token') })).statusCode).toBe(401);
  });

  it('refuses a malformed record and keeps the saved one', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    await a.inject({ method: 'PUT', url: '/preferences', headers: auth(sam), payload: { timeframe: '4h' } });

    const bad = await a.inject({ method: 'PUT', url: '/preferences', headers: auth(sam), payload: { timeframe: '4h', colour: 'red' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: { code: 'invalid_preferences', message: 'unknown field "colour"' } });
    expect((await a.inject({ method: 'PUT', url: '/preferences', headers: auth(sam), payload: { timeframe: '2h' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/preferences', headers: auth(sam), payload: { instrument: 'X'.repeat(2_000) } })).statusCode).toBe(413);
    expect((await a.inject({ method: 'GET', url: '/preferences', headers: auth(sam) })).json()).toEqual({ timeframe: '4h' });
  });

  it('gives an agent key no preferences and refuses its saves', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const created = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(sam), payload: { name: 'research agent' } });
    const key = (created.json() as { key: string }).key;

    const read = await a.inject({ method: 'GET', url: '/preferences', headers: auth(key) });
    expect(read.statusCode).toBe(404);
    const save = await a.inject({ method: 'PUT', url: '/preferences', headers: auth(key), payload: { timeframe: '1h' } });
    expect(save.statusCode).toBe(403);
    expect((save.json() as { error: { code: string } }).error.code).toBe('read_only');
  });
});
