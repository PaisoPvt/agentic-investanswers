// M4-02: an MCP client (the official SDK's) calls each read-only tool through
// the real server, with an agent key; plan checks and rate limits apply as on
// the REST routes.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRateCounter, RateLimiter, accessFromEnv, parseRateLimits } from '@aia/access';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BTCUSD, ETHUSD, MemoryDataLayer, NVDA } from '@aia/data';
import { IndicatorEngine, IndicatorRegistry, MemoryIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { IndicatorBars } from './indicator-bars.js';
import { buildServer } from './server.js';
import { settingsDemo } from './settings-demo-indicator.js';

const T0 = 1_762_800_000;
const PASSWORD = 'correct horse battery';

const dir = mkdtempSync(join(tmpdir(), 'aia-mcp-'));
const PLANS = join(dir, 'plans.json');
writeFileSync(
  PLANS,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [
      { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h', '4h'] },
      { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
    ],
    assignments: {},
  }),
);

let app: FastifyInstance | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await app?.close();
  app = undefined;
});

async function start(options: { readsPerMinute?: number } = {}) {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD, NVDA], earliest: barTime(T0) });
  const history = new HistoryQuery({ data });
  const rule = { limit: options.readsPerMinute ?? 1_000, windowSeconds: 60 };
  const limits = new RateLimiter({
    limits: parseRateLimits({ rateLimits: { humanReads: rule, agentReads: rule, signIn: rule, signUp: rule, agentKeyChanges: rule } }),
    counter: new MemoryRateCounter(() => 1_763_000_080_000),
    now: () => 1_763_000_080_000,
  });
  const registry = new IndicatorRegistry([settingsDemo]);
  const bars = new IndicatorBars({ data, now: () => barTime(T0) });
  const engine = new IndicatorEngine({ registry, bars, cache: new MemoryIndicatorOutputCache() });
  app = await buildServer({
    history,
    access: accessFromEnv({ AIA_PLANS: PLANS }),
    catalog: data,
    indicators: registry,
    indicatorRunner: { drawn: (r) => engine.drawn(r), forming: (i, t) => bars.forming(i, t) },
    limits,
    now: () => barTime(T0),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // A user signs up and creates a key for their agent.
  const signedUp = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'sam@example.com', password: PASSWORD } });
  const session = (signedUp.json() as { token: string }).token;
  const created = await app.inject({ method: 'POST', url: '/auth/agent-keys', headers: { authorization: `Bearer ${session}` }, payload: { name: 'bot' } });
  return { port, key: (created.json() as { key: string }).key };
}

async function connect(port: number, key: string): Promise<Client> {
  const client = new Client({ name: 'aia-test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const json = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content)[0]!.text) as unknown;

describe('MCP tools', () => {
  it('lists the read-only tools (three since M4-02; the indicator pair since M3-05)', async () => {
    const { port, key } = await start();
    const client = await connect(port, key);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_bars', 'get_indicator_output', 'get_plan', 'list_indicators', 'list_instruments']);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('list_instruments: what is served, and what the owner’s plan includes', async () => {
    const { port, key } = await start();
    const result = await (await connect(port, key)).callTool({ name: 'list_instruments', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(json(result)).toEqual([
      { symbol: 'BTCUSD', kind: 'crypto', timeframes: ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'], included: ['1h', '4h'] },
      { symbol: 'ETHUSD', kind: 'crypto', timeframes: ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'], included: [] },
      { symbol: 'NVDA', kind: 'stock', timeframes: [], included: [] },
    ]);
  });

  it('get_bars: the same answer as GET /bars for a pair in the plan', async () => {
    const { port, key } = await start();
    const result = await (await connect(port, key)).callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 10 } });
    expect(result.isError).toBeFalsy();
    const rest = await app!.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h&limit=10', headers: { authorization: `Bearer ${key}` } });
    expect(json(result)).toEqual(rest.json());
  });

  it('get_bars: plan checks and the API’s errors apply', async () => {
    const { port, key } = await start();
    const client = await connect(port, key);
    const forbidden = await client.callTool({ name: 'get_bars', arguments: { instrument: 'ETHUSD', tf: '1h' } });
    expect(forbidden.isError).toBe(true);
    expect(json(forbidden)).toEqual({
      error: { code: 'forbidden', message: 'your plan does not include ETHUSD 1h', upgradeUrl: 'https://example.com/upgrade' },
    });
    const tooMany = await client.callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 5_000 } });
    expect(json(tooMany)).toMatchObject({ error: { code: 'limit_too_large' } });
    const unknown = await client.callTool({ name: 'get_bars', arguments: { instrument: 'XYZ', tf: '1h' } });
    expect(json(unknown)).toMatchObject({ error: { code: 'unknown_instrument' } });
  });

  it('list_indicators and get_indicator_output: the same answers as the REST routes, with the same plan check', async () => {
    const { port, key } = await start();
    const client = await connect(port, key);
    const headers = { authorization: `Bearer ${key}` };
    const listed = await client.callTool({ name: 'list_indicators', arguments: {} });
    expect(json(listed)).toEqual((await app!.inject({ method: 'GET', url: '/indicators', headers })).json());

    const args = { indicator: 'settingsDemo', instrument: 'BTCUSD', tf: '1h', settings: { offset: 1 }, limit: 5 };
    const drawn = await client.callTool({ name: 'get_indicator_output', arguments: args });
    expect(drawn.isError).toBeFalsy();
    const rest = await app!.inject({ method: 'POST', url: '/indicators/settingsDemo/outputs', headers, payload: { instrument: 'BTCUSD', timeframe: '1h', settings: { offset: 1 }, limit: 5 } });
    expect(json(drawn)).toEqual(rest.json());

    const forbidden = await client.callTool({ name: 'get_indicator_output', arguments: { ...args, instrument: 'ETHUSD' } });
    expect(json(forbidden)).toMatchObject({ error: { code: 'forbidden', upgradeUrl: 'https://example.com/upgrade' } });
    const refused = await client.callTool({ name: 'get_indicator_output', arguments: { ...args, settings: { length: 501 } } });
    expect(json(refused)).toMatchObject({ error: { code: 'invalid_settings', fields: [{ key: 'length', code: 'out_of_range' }] } });
  });

  it('get_plan: the owner’s plan', async () => {
    const { port, key } = await start();
    const result = await (await connect(port, key)).callTool({ name: 'get_plan', arguments: {} });
    expect(json(result)).toMatchObject({ plan: { id: 'free', name: 'Free' }, instruments: ['BTCUSD'] });
  });

  it('refuses a request without a principal, and only POST is served', async () => {
    await start();
    const res = await app!.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(res.statusCode).toBe(401);
    expect((await app!.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
  });

  it('refuses a JSON-RPC batch, so one request cannot carry many tool calls for one read', async () => {
    const { key } = await start({ readsPerMinute: 1 });
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_plan', arguments: {} } });
    const res = await app!.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
      payload: [call(1), call(2)],
    });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'batch_not_supported']);
  });

  it('counts each MCP request against the agent’s read limit', async () => {
    const { port, key } = await start({ readsPerMinute: 3 });
    const client = await connect(port, key); // initialize and its notification: 2 requests
    await client.callTool({ name: 'get_plan', arguments: {} }); // 3rd
    await expect(client.callTool({ name: 'get_plan', arguments: {} })).rejects.toThrow(/429|rate/i);
  });
});
