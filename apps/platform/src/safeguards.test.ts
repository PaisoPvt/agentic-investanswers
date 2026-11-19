// M2-10: every rate limit through the real server: each is hit, then 429
// with Retry-After. Limits are tiny here; config/safeguards.json holds the
// real ones.

import { MemoryAccountStore, MemorySessionStore, MemoryRateCounter, RateLimiter, accessFromEnv, parseRateLimits } from '@aia/access';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const NOW_MS = 1_763_000_080_000; // 40 s into a minute, 880 s into a 900 s or 3600 s window
const PASSWORD = 'correct horse battery';

const LIMITS = parseRateLimits({
  rateLimits: {
    humanReads: { limit: 3, windowSeconds: 60 },
    agentReads: { limit: 2, windowSeconds: 60 },
    signIn: { limit: 2, windowSeconds: 900 },
    signUp: { limit: 3, windowSeconds: 3600 },
    agentKeyChanges: { limit: 1, windowSeconds: 3600 },
  },
});

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start(trustedProxies?: string | number) {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], earliest: barTime(T0) });
  const history = new HistoryQuery({ data });
  gateway = new LiveGateway({ data, every: () => () => undefined });
  const access = accessFromEnv({}, { accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() });
  const limits = new RateLimiter({ limits: LIMITS, counter: new MemoryRateCounter(() => NOW_MS), now: () => NOW_MS });
  app = await buildServer({ history, access, live: gateway, limits, now: () => barTime(T0), ...(trustedProxies === undefined ? {} : { trustedProxies }) });
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

function expectLimited(res: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }, retryAfter: number) {
  expect(res.statusCode).toBe(429);
  expect(res.headers['retry-after']).toBe(String(retryAfter));
  expect(res.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String), retryAfterSeconds: retryAfter } });
}

describe('rate limits', () => {
  it('reads per user: /bars and /plan share the limit, then 429; another user is unaffected', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const kim = await signUp(a, 'kim@example.com');
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) })).statusCode).toBe(200);
    expectLimited(await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) }), 20);
    expectLimited(await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) }), 20);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(kim) })).statusCode).toBe(200);
  });

  it('live connections count as reads: over the limit the upgrade gets 429', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const upgrade = () =>
      a.inject({
        method: 'GET',
        url: `/live?token=${sam}`,
        headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
    for (let i = 0; i < 3; i += 1) await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) });
    expectLimited(await upgrade(), 20);
  });

  it('reads per agent key, with the agent limit', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const { key } = (await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(sam), payload: { name: 'bot' } })).json() as { key: string };
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(key) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(key) })).statusCode).toBe(200);
    expectLimited(await a.inject({ method: 'GET', url: '/plan', headers: auth(key) }), 20);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) })).statusCode).toBe(200);
  });

  it('sign-in attempts per client address, right or wrong password', async () => {
    const a = await start();
    await signUp(a, 'sam@example.com');
    const attempt = (password: string) => a.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: 'sam@example.com', password } });
    expect((await attempt('wrong password!!')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    expectLimited(await attempt(PASSWORD), 20);
  });

  it('behind the ALB and CloudFront, the client address is the first entry from outside the VPC; one a client adds is ignored (M2-01)', async () => {
    // The test's own connection comes from 127.0.0.1, standing in for the ALB.
    const a = await start('127.0.0.1, 10.0.0.0/16');
    await signUp(a, 'sam@example.com');
    // X-Forwarded-For as the ALB passes it on: anything the client sent, the
    // client (added by CloudFront), CloudFront's VPC origin (added by the ALB).
    const attempt = (forwarded: string) =>
      a.inject({ method: 'POST', url: '/auth/sign-in', headers: { 'x-forwarded-for': forwarded }, payload: { email: 'sam@example.com', password: PASSWORD } });
    expect((await attempt('203.0.113.7, 10.0.5.9')).statusCode).toBe(200);
    expect((await attempt('1.2.3.4, 203.0.113.7, 10.0.5.9')).statusCode).toBe(200);
    expectLimited(await attempt('5.6.7.8, 203.0.113.7, 10.0.5.9'), 20);
    // Another client has its own count.
    expect((await attempt('198.51.100.9, 10.0.7.1')).statusCode).toBe(200);
  });

  it('with 2 hops trusted (AWS: the ALB, then CloudFront from its public addresses), the client is the entry CloudFront added (M2-01)', async () => {
    const a = await start(2);
    await signUp(a, 'sam@example.com');
    const attempt = (forwarded: string) =>
      a.inject({ method: 'POST', url: '/auth/sign-in', headers: { 'x-forwarded-for': forwarded }, payload: { email: 'sam@example.com', password: PASSWORD } });
    expect((await attempt('203.0.113.7, 130.176.1.1')).statusCode).toBe(200);
    expect((await attempt('1.2.3.4, 203.0.113.7, 130.176.9.9')).statusCode).toBe(200);
    expectLimited(await attempt('5.6.7.8, 203.0.113.7, 130.176.1.1'), 20);
    expect((await attempt('198.51.100.9, 130.176.1.1')).statusCode).toBe(200);
  });

  it('sign-ups per client address', async () => {
    const a = await start();
    for (let i = 0; i < 3; i += 1) await signUp(a, `u${i}@example.com`);
    expectLimited(await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'u9@example.com', password: PASSWORD } }), 2_720);
  });

  it('agent key changes per account', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const create = () => a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(sam), payload: { name: 'bot' } });
    const first = await create();
    expect(first.statusCode).toBe(201);
    expectLimited(await create(), 2_720);
    const id = (first.json() as { agentKey: { id: string } }).agentKey.id;
    expectLimited(await a.inject({ method: 'DELETE', url: `/auth/agent-keys/${id}`, headers: auth(sam) }), 2_720);
    // Listing is not a change.
    expect((await a.inject({ method: 'GET', url: '/auth/agent-keys', headers: auth(sam) })).statusCode).toBe(200);
  });
});
