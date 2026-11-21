// M4-06: the agent check against the real server. On a plan with something
// to refuse, an indicator and the audit log, every step passes; without
// indicators or audit, those steps do not apply; a broken refusal fails.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accessFromEnv } from '@aia/access';
import { AuditLog, MemoryUsageRecordStore } from '@aia/audit';
import type { CookedBarsSource } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer } from '@aia/data';
import { IndicatorEngine, IndicatorRegistry, MemoryIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery } from '@aia/serving';
import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { agentCheckLines, agentCheckPassed, runAgentCheck } from './agent-check-steps.js';
import { IndicatorBars } from './indicator-bars.js';
import { buildServer } from './server.js';
import { settingsDemo } from './settings-demo-indicator.js';

const T0 = 1_762_790_400;
const HOUR = 3_600;
const NOW = barTime(T0 + 29 * HOUR + 600);
const BARS: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: barTime(T0 + i * HOUR), open: price(10_000), high: price(10_050), low: price(9_950), close: price(10_000 + i), volume: volume(1) }));
const store: CookedBarsSource = { getRange: (_s: string, tf: Timeframe, from: BarTime, until: BarTime) => Promise.resolve(tf === '1h' ? BARS.filter((b) => b.time >= from && b.time <= until) : []) };

function plans(body: object): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aia-agent-check-')), 'plans.json');
  writeFileSync(path, JSON.stringify({ upgradeUrl: 'https://example.com/upgrade', defaultPlan: 'free', assignments: {}, ...body }));
  return path;
}
const FREE = plans({ plans: [{ id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] }] });
const ALL = plans({ plans: [{ id: 'free', name: 'Free', instruments: 'all', timeframes: 'all' }] });

let app: FastifyInstance | undefined;
let log: AuditLog | undefined;
afterEach(async () => {
  await app?.close();
  await log?.close();
  app = undefined;
  log = undefined;
});

async function start(options: { plansFile: string; indicators: boolean; audit: boolean }) {
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD], cooked: store, earliest: barTime(T0) });
  const registry = new IndicatorRegistry(options.indicators ? [settingsDemo] : []);
  const bars = new IndicatorBars({ data, now: () => NOW });
  const engine = new IndicatorEngine({ registry, bars, cache: new MemoryIndicatorOutputCache() });
  if (options.audit) log = new AuditLog({ store: new MemoryUsageRecordStore(), flushMs: 50 });
  app = await buildServer({
    history: new HistoryQuery({ data }),
    access: accessFromEnv({ AIA_PLANS: options.plansFile }),
    catalog: data,
    indicators: registry,
    indicatorRunner: { drawn: (r) => engine.drawn(r), forming: (i, t) => bars.forming(i, t) },
    now: () => NOW,
    ...(log === undefined ? {} : { audit: log }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const signUp = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'sam@example.com', password: 'correct horse battery' } });
  const token = (signUp.json() as { token: string }).token;
  const created = await app.inject({ method: 'POST', url: '/auth/agent-keys', headers: { authorization: `Bearer ${token}` }, payload: { name: 'checker' } });
  return { url, key: (created.json() as { key: string }).key };
}

describe('agent check (M4-06)', () => {
  it('passes every step on a plan with something to refuse, an indicator and the audit log', async () => {
    const { url, key } = await start({ plansFile: FREE, indicators: true, audit: true });
    const steps = await runAgentCheck({ url, key });
    expect(steps.map((s) => [s.name, s.ok])).toEqual([
      ['list_instruments', true],
      ['get_plan', true],
      ['get_bars', true],
      ['list_indicators', true],
      ['get_indicator_output', true],
      ['plan refusal', true],
      ['read-only', true],
      ['usage recorded', true],
    ]);
    expect(agentCheckPassed(steps)).toBe(true);
    expect(agentCheckLines(steps)[5]).toMatch(/^pass {2}plan refusal +\w+ \w+: forbidden with upgrade link$/);
  });

  it('marks steps that do not apply, and still passes', async () => {
    const { url, key } = await start({ plansFile: ALL, indicators: false, audit: false });
    const steps = await runAgentCheck({ url, key });
    expect(steps.filter((s) => s.ok === undefined).map((s) => s.name)).toEqual(['get_indicator_output', 'plan refusal', 'usage recorded']);
    expect(agentCheckPassed(steps)).toBe(true);
  });

  it('fails when a step fails', () => {
    expect(agentCheckPassed([{ name: 'get_bars', ok: true, detail: '' }, { name: 'plan refusal', ok: false, detail: '' }])).toBe(false);
    expect(agentCheckPassed([])).toBe(false);
  });
});
