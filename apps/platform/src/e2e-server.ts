// The platform for the chart's end-to-end tests (M2-05): the real server,
// History API and live gateway over the in-memory data layer, so a browser
// test needs no Redis, S3, DynamoDB or provider. Never used in production.
//
// - History: made-up 1-minute bars for BTCUSD and ETHUSD, the same on every
//   run, for the 2 years and a month before NOW (so the chart can scroll back 2
//   years, M2-06), and 5m to 4h bars rolled up from them
//   (first open, highest high, lowest low, last close, summed volume).
// - Live: the data layer's simulated feed (the same forming and stored bar
//   rules as `pnpm live`), driven by the test through two routes:
//     POST /e2e/trade  { instrument, minute, close }   a trade in minute
//                      `minute` (0 is the minute starting at NOW), at
//                      `close` in display units: its forming bars are announced
//     POST /e2e/store  { instrument, minute, close? }  that minute is stored
//                      (with `close`, a last trade changed it): its stored
//                      bars are announced
// - Access: local developer mode, everything allowed; or, with --sign-in
//   (M2-14), the app's own sign-in on in-memory accounts, every account on a
//   plan that includes everything.
// - Indicators: the test-only settingsDemo and leakCanary (never real indicators, rule 5),
//   run by the real engine with a memory cache.
//
//   tsx apps/platform/src/e2e-server.ts             (AIA_PORT, default 8181)
//   tsx apps/platform/src/e2e-server.ts --sign-in

import { accessFromEnv, parsePlanBook } from '@aia/access';
import { AuditLog, MemoryUsageRecordStore } from '@aia/audit';
import type { LiveBarUpdate } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer, SimulatedLiveFeed } from '@aia/data';
import { IndicatorEngine, IndicatorRegistry, MemoryIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';

import { IndicatorBars } from './indicator-bars.js';
import { buildServer } from './server.js';
import { leakCanary } from './leak-canary-indicator.js';
import { settingsDemo } from './settings-demo-indicator.js';

/** 2026-11-10 12:00 UTC: a 4h boundary, so every timeframe's bar starts here. */
export const E2E_NOW = 1_794_312_000;
const HISTORY_DAYS = 2 * 365 + 31;
const INSTRUMENTS = [BTCUSD, ETHUSD];
/** Where each instrument's made-up prices hover, in display units. */
const BASE_PRICE: Readonly<Record<string, number>> = { BTCUSD: 90_000, ETHUSD: 3_000 };

/** A price in display units as the instrument's scaled whole number. */
const scaled = (instrument: Instrument, value: number) => Math.round(value * 10 ** instrument.priceScale);

/** A made-up minute: a slow wave plus a wiggle. */
function madeUpMinute(instrument: Instrument, time: number): Bar {
  const base = BASE_PRICE[instrument.symbol] ?? 1_000;
  const at = (t: number) => scaled(instrument, base * (1 + 0.02 * Math.sin(t / 21_600) + 0.002 * Math.sin(t / 420)));
  const open = at(time);
  const close = at(time + 60);
  const spread = scaled(instrument, base * 0.0005);
  return {
    time: barTime(time),
    open: price(open),
    high: price(Math.max(open, close) + spread),
    low: price(Math.min(open, close) - spread),
    close: price(close),
    volume: volume(100_000_000 + (time % 7_919) * 1_000),
  };
}

/** The made-up minutes in `[from, until]` before NOW (synchronously, for the live feed's whole days and months). */
function madeUpMinutes(instrument: Instrument, from: number, until: number): Bar[] {
  const bars: Bar[] = [];
  const start = Math.max(from, E2E_NOW - HISTORY_DAYS * 86_400);
  for (let t = Math.ceil(start / 60) * 60; t <= until && t < E2E_NOW; t += 60) bars.push(madeUpMinute(instrument, t));
  return bars;
}

/** Made-up history before NOW, plus the minutes the test stored. */
class E2EMinutes {
  readonly stored = new Map<string, Map<number, Bar>>();

  read(symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = INSTRUMENTS.find((i) => i.symbol === symbol);
    if (instrument === undefined) return Promise.resolve([]);
    const bars = madeUpMinutes(instrument, from, until);
    for (const [t, bar] of [...(this.stored.get(symbol) ?? new Map<number, Bar>())].sort(([a], [b]) => a - b)) {
      if (t >= from && t <= until) bars.push(bar);
    }
    return Promise.resolve(bars);
  }
}

const SPAN_SECONDS: Partial<Record<Timeframe, number>> = { '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400 };
const DAY = 86_400;
/** The day NOW falls in: days before it are made-up history only; it also holds the minutes the test stores. */
const TODAY = Math.floor(E2E_NOW / DAY) * DAY;

/** Bars rolled up into `timeframe`'s buckets, keeping those that open in `[from, until]` (first open, extremes, last close, summed volume). */
function aggregate(instrument: Instrument, timeframe: Timeframe, parts: readonly Bar[], from: number, until: number): Bar[] {
  const bars: Bar[] = [];
  for (const part of parts) {
    const time = alignToTimeframe(instrument, timeframe, part.time);
    if (time === undefined || time < from || time > until) continue;
    const last = bars[bars.length - 1];
    if (last === undefined || last.time !== time) {
      bars.push({ ...part, time });
      continue;
    }
    bars[bars.length - 1] = {
      time,
      open: last.open,
      high: price(Math.max(last.high, part.high)),
      low: price(Math.min(last.low, part.low)),
      close: part.close,
      volume: volume(last.volume + part.volume),
    };
  }
  return bars;
}

/**
 * 5m to 4h bars rolled up from the minutes, and 1D, 1W and 1M as the real
 * store keeps them (M1-08a): the made-up days are rolled up once and kept,
 * today is rolled up from its minutes, and weeks and months from days.
 * `[from, until]` by bar time.
 */
class E2ECooked {
  private readonly pastDays = new Map<string, Bar[]>();

  constructor(private readonly minutes: E2EMinutes) {}

  async getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = INSTRUMENTS.find((i) => i.symbol === symbol);
    if (instrument === undefined) return [];
    if (timeframe === '1D' || timeframe === '1W' || timeframe === '1M') {
      const days = await this.days(instrument);
      return timeframe === '1D' ? days.filter((d) => d.time >= from && d.time <= until) : aggregate(instrument, timeframe, days, from, until);
    }
    const span = SPAN_SECONDS[timeframe];
    if (span === undefined) return [];
    return aggregate(instrument, timeframe, await this.minutes.read(symbol, from, barTime(until + span - 60)), from, until);
  }

  /** Every day: the made-up past (rolled up once), then today from its minutes. */
  private async days(instrument: Instrument): Promise<Bar[]> {
    let past = this.pastDays.get(instrument.symbol);
    if (past === undefined) {
      past = aggregate(instrument, '1D', madeUpMinutes(instrument, E2E_NOW - HISTORY_DAYS * DAY, TODAY - 60), 0, TODAY - 1);
      this.pastDays.set(instrument.symbol, past);
    }
    const today = aggregate(instrument, '1D', await this.minutes.read(instrument.symbol, barTime(TODAY), barTime(TODAY + DAY - 60)), TODAY, TODAY);
    return [...past, ...today];
  }
}

/** One instrument's live minutes, as the test trades and stores them. */
class E2ELive {
  private readonly feed: SimulatedLiveFeed;
  private readonly unstored = new Map<number, Bar>();

  constructor(readonly instrument: Instrument) {
    this.feed = new SimulatedLiveFeed(instrument, (from, until) => madeUpMinutes(instrument, from, until));
    // As `pnpm live` after its first minute: the minute before NOW is cooked, so every timeframe forms.
    this.feed.stored(madeUpMinute(instrument, E2E_NOW - 60));
  }

  trade(minute: number, closePrice: number): LiveBarUpdate[] {
    const time = E2E_NOW + minute * 60;
    const was = this.unstored.get(time);
    const value = scaled(this.instrument, closePrice);
    const close = price(value);
    this.unstored.set(time, {
      time: barTime(time),
      open: was?.open ?? close,
      high: price(Math.max(was?.high ?? value, value)),
      low: price(Math.min(was?.low ?? value, value)),
      close,
      volume: volume((was?.volume ?? 0) + 1_000_000),
    });
    return this.feed.unstoredChanged([...this.unstored.values()].sort((a, b) => a.time - b.time));
  }

  store(minute: number, closePrice: number | undefined): { bar: Bar; updates: LiveBarUpdate[] } | undefined {
    const time = E2E_NOW + minute * 60;
    const was = this.unstored.get(time);
    if (was === undefined) return undefined;
    this.unstored.delete(time);
    const value = closePrice === undefined ? undefined : scaled(this.instrument, closePrice);
    const bar: Bar =
      value === undefined ? was : { ...was, close: price(value), high: price(Math.max(was.high, value)), low: price(Math.min(was.low, value)) };
    return { bar, updates: this.feed.stored(bar) };
  }
}

/** Every account on one plan that includes everything, for the sign-in tests. */
const OPEN_PLANS = parsePlanBook({
  upgradeUrl: 'https://investanswers.example/upgrade',
  defaultPlan: 'pro',
  plans: [{ id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' }],
  assignments: {},
});

export async function startE2EServer(port: number, options: { readonly signIn?: boolean } = {}): Promise<FastifyInstance> {
  const minutes = new E2EMinutes();
  const data = new MemoryDataLayer({
    instruments: INSTRUMENTS,
    minutes,
    cooked: new E2ECooked(minutes),
    earliest: barTime(E2E_NOW - HISTORY_DAYS * 86_400),
    nowMs: () => E2E_NOW * 1000,
  });
  const history = new HistoryQuery({ data });
  const live = new LiveGateway({
    data,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  await data.subscribe(live);
  const announcer = data.announcer('e2e');
  const feeds = new Map(INSTRUMENTS.map((i) => [i.symbol, new E2ELive(i)]));

  // The leak canary (M3-08): internals the leak test looks for everywhere outside the engine.
  const indicators = new IndicatorRegistry([settingsDemo, leakCanary]);
  const indicatorBars = new IndicatorBars({ data, now: () => barTime(E2E_NOW) });
  const engine = new IndicatorEngine({ registry: indicators, bars: indicatorBars, cache: new MemoryIndicatorOutputCache() });

  const app = await buildServer({
    history,
    access: options.signIn === true ? accessFromEnv({}, undefined, OPEN_PLANS) : accessFromEnv({ AIA_DEV_AUTH: '1' }),
    live,
    catalog: data,
    indicators,
    indicatorRunner: { drawn: (r) => engine.drawn(r), forming: (i, t) => indicatorBars.forming(i, t) },
    now: () => barTime(E2E_NOW),
    // Usage and audit records in memory (M4-04), so every route runs as on AWS.
    audit: new AuditLog({ store: new MemoryUsageRecordStore() }),
    logger: false,
  });

  const body = (request: { body: unknown }) => request.body as { instrument?: string; minute?: number; close?: number };
  app.post('/e2e/trade', async (request, reply) => {
    const { instrument = '', minute = 0, close } = body(request);
    const feed = feeds.get(instrument);
    if (feed === undefined || typeof close !== 'number') return reply.code(400).send({ error: 'instrument and close are required' });
    await announcer.publish(feed.trade(minute, close));
    return { ok: true };
  });
  app.post('/e2e/store', async (request, reply) => {
    const { instrument = '', minute = 0, close } = body(request);
    const feed = feeds.get(instrument);
    const stored = feed?.store(minute, close);
    if (stored === undefined) return reply.code(400).send({ error: 'trade in that minute first' });
    let byTime = minutes.stored.get(instrument);
    if (byTime === undefined) minutes.stored.set(instrument, (byTime = new Map()));
    byTime.set(stored.bar.time, stored.bar);
    await announcer.publish(stored.updates);
    return { ok: true };
  });
  app.addHook('onClose', () => {
    live.stop();
  });

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['AIA_PORT'] ?? 8181);
  const signIn = process.argv.includes('--sign-in');
  const app = await startE2EServer(port, { signIn });
  console.log(`e2e platform on http://127.0.0.1:${port} (made-up bars, ${signIn ? 'sign-in' : 'AIA_DEV_AUTH'})`);
  const shutdown = () => void app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
