// M4-04: usage and audit records through the real server. Every request
// leaves one record (who, what, the outcome), humans, agents and requests
// before sign-in alike, and GET /usage reads them back per user and per agent.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accessFromEnv } from '@aia/access';
import type { UsageRecord } from '@aia/audit';
import { AuditLog, MemoryUsageRecordStore } from '@aia/audit';
import type { UsageResponse } from '@aia/client-contract';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const PASSWORD = 'correct horse battery';

const dir = mkdtempSync(join(tmpdir(), 'aia-audit-'));
const PLANS = join(dir, 'plans.json');
writeFileSync(
  PLANS,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [{ id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] }],
    assignments: {},
  }),
);

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
let log: AuditLog | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  await log?.close();
  app = undefined;
});

async function start() {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], earliest: barTime(T0) });
  const history = new HistoryQuery({ data });
  gateway = new LiveGateway({ data, every: () => () => undefined });
  const store = new MemoryUsageRecordStore();
  log = new AuditLog({ store, every: () => () => undefined });
  let clock = 1_000_000;
  app = await buildServer({ history, access: accessFromEnv({ AIA_PLANS: PLANS }), live: gateway, now: () => barTime(T0), audit: log, nowMs: () => (clock += 5) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  /** Every record written so far. */
  const records = async (): Promise<UsageRecord[]> => {
    await log?.flush();
    return store.written;
  };
  return { a: app, port, records };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(a: FastifyInstance, email: string): Promise<{ token: string; id: string }> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const token = (res.json() as { token: string }).token;
  const me = await a.inject({ method: 'GET', url: '/auth/me', headers: auth(token) });
  return { token, id: (me.json() as { id: string }).id };
}

async function newKey(a: FastifyInstance, session: string): Promise<{ key: string; id: string }> {
  const res = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: { name: 'bot' } });
  const body = res.json() as { key: string; agentKey: { id: string } };
  return { key: body.key, id: body.agentKey.id };
}

describe('usage and audit records (M4-04)', () => {
  it('records each request of a signed-in user, refusals included, without tokens or passwords', async () => {
    const { a, records } = await start();
    const sam = await signUp(a, 'sam@example.com');
    await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam.token) });
    await a.inject({ method: 'GET', url: '/bars?instrument=ETHUSD&tf=1h', headers: auth(sam.token) });
    await a.inject({ method: 'GET', url: '/plan', headers: auth(sam.token) });
    await a.inject({ method: 'GET', url: '/health' });

    const all = await records();
    const mine = all.filter((r) => r.subject.id === sam.id);
    expect(mine.map((r) => [r.method, r.route, r.status, r.errorCode ?? null, r.instrument ?? null, r.timeframe ?? null])).toEqual([
      ['POST', '/auth/sign-up', 201, null, null, null],
      ['GET', '/auth/me', 200, null, null, null],
      ['GET', '/bars', 200, null, 'BTCUSD', '1h'],
      ['GET', '/bars', 403, 'forbidden', 'ETHUSD', '1h'],
      ['GET', '/plan', 200, null, null, null],
    ]);
    for (const r of mine) {
      expect(r.subject).toEqual({ kind: 'human', id: sam.id });
      expect(r.clientAddress).toBe('127.0.0.1');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(all.some((r) => r.route === '/health')).toBe(false);
    // A refused sign-in has no account to file it under.
    await a.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: 'sam@example.com', password: 'wrong password!!' } });
    expect((await records()).at(-1)).toMatchObject({ route: '/auth/sign-in', status: 401, errorCode: 'invalid_credentials', subject: { kind: 'anonymous', id: 'anonymous' } });
    const text = JSON.stringify(all);
    expect(text).not.toContain(sam.token);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('sam@example.com');
  });

  it('records an agent\'s MCP tool calls and live connection under its key, with the account it acts for', async () => {
    const { a, port, records } = await start();
    const sam = await signUp(a, 'sam@example.com');
    const agent = await newKey(a, sam.token);

    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { ...auth(agent.key), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      await res.text();
    };
    await tool('get_bars', { instrument: 'BTCUSD', tf: '1h' });
    // No indicators on this server, so the tool refuses; the record still says what was asked.
    await tool('get_indicator_output', { indicator: 'sma', instrument: 'BTCUSD', tf: '1h' });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${encodeURIComponent(agent.key)}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not connect')));
    });
    ws.close();
    await expect.poll(async () => (await records()).some((r) => r.route === '/live')).toBe(true);
    const refused = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await new Promise((resolve) => {
      refused.addEventListener('close', resolve);
      refused.addEventListener('error', resolve);
    });
    await expect.poll(async () => (await records()).filter((r) => r.route === '/live')).toHaveLength(2);

    const all = await records();
    const agents = all.filter((r) => r.subject.kind === 'agent');
    expect(agents.map((r) => [r.route, r.status, r.tool ?? null, r.indicator ?? null, r.instrument ?? null, r.timeframe ?? null])).toEqual([
      ['/mcp', 200, 'get_bars', null, 'BTCUSD', '1h'],
      ['/mcp', 200, 'get_indicator_output', 'sma', 'BTCUSD', '1h'],
      ['/live', 101, null, null, null, null],
    ]);
    for (const r of agents) expect(r.subject).toEqual({ kind: 'agent', id: agent.id, owner: sam.id });
    expect(all.find((r) => r.route === '/live' && r.status === 401)?.subject.kind).toBe('anonymous');
    expect(JSON.stringify(all)).not.toContain(agent.key);
  });

  it('GET /usage: your own records, your agent key\'s, never anyone else\'s', async () => {
    const { a } = await start();
    const sam = await signUp(a, 'sam@example.com');
    const kim = await signUp(a, 'kim@example.com');
    const samsAgent = await newKey(a, sam.token);
    const kimsAgent = await newKey(a, kim.token);
    await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(samsAgent.key) });
    await log?.flush();

    const usage = async (token: string, query: string) => {
      const res = await a.inject({ method: 'GET', url: `/usage${query}`, headers: auth(token) });
      return { status: res.statusCode, body: res.json() as UsageResponse & { error?: { code: string } } };
    };
    const mine = await usage(sam.token, '');
    expect(mine.status).toBe(200);
    expect(mine.body.subject).toEqual({ kind: 'human', id: sam.id });
    // Newest first: the agent key creation, then /auth/me and the sign-up.
    expect(mine.body.records.map((r) => r.route)).toEqual(['/auth/agent-keys', '/auth/me', '/auth/sign-up']);
    expect(mine.body.records[0]?.time).toMatch(/^\d{4}-\d\d-\d\dT/);

    const agentsUsage = await usage(sam.token, `?subject=${samsAgent.id}`);
    expect(agentsUsage.body.subject).toEqual({ kind: 'agent', id: samsAgent.id });
    expect(agentsUsage.body.records.map((r) => [r.route, r.instrument])).toEqual([['/bars', 'BTCUSD']]);

    expect((await usage(sam.token, `?subject=${kimsAgent.id}`)).status).toBe(404);
    expect((await usage(sam.token, `?subject=${kim.id}`)).status).toBe(404);
    // An agent reads its own records, not its owner's.
    expect((await usage(samsAgent.key, '?subject=me')).body.subject).toEqual({ kind: 'agent', id: samsAgent.id });
    expect((await usage(samsAgent.key, `?subject=${sam.id}`)).status).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/usage' })).statusCode).toBe(401);
  });

  it('GET /usage pages back with `before` and checks its parameters', async () => {
    const { a } = await start();
    const sam = await signUp(a, 'sam@example.com');
    for (let i = 0; i < 4; i++) await a.inject({ method: 'GET', url: '/plan', headers: auth(sam.token) });
    await log?.flush();
    const page = async (query: string) => (await a.inject({ method: 'GET', url: `/usage${query}`, headers: auth(sam.token) })).json() as UsageResponse;
    const first = await page('?limit=3');
    expect(first.records).toHaveLength(3);
    expect(first.next).not.toBeNull();
    const second = await page(`?limit=3&before=${encodeURIComponent(first.next as string)}`);
    // 6 records before these reads: sign-up, /auth/me and 4 × /plan; the /usage reads themselves come after.
    expect(second.records.map((r) => r.route)).toEqual(['/plan', '/auth/me', '/auth/sign-up']);
    expect(second.next).toBeNull();

    for (const bad of ['?limit=0', '?limit=201', '?limit=x', '?before=nope', '?who=me']) {
      const res = await a.inject({ method: 'GET', url: `/usage${bad}`, headers: auth(sam.token) });
      expect([bad, res.statusCode, (res.json() as { error: { code: string } }).error.code]).toEqual([bad, 400, 'bad_parameter']);
    }
  });
});
