// `pnpm freshness` (M2-07): how fresh a running environment is, as a customer
// sees it. For a few minutes it watches each instrument and reports how long
// after each minute closes it is in storage (raw), in the History API (cache
// first) and on an open chart (the live connection), against the p95
// thresholds in config/freshness.json. Run it after each staging release.
//
//   AIA_FRESHNESS_KEY=<agent key> pnpm freshness [--url http://127.0.0.1:8080] [--minutes 5] [--symbol BTCUSD]... [--storage]
//
// --storage also times raw storage, through the stores (local MinIO, or AWS
// with AIA_S3_ENDPOINT=aws and a profile that may read the raw bucket).
// Without it the storage step is "not measured". Times are taken on this
// machine's clock; its offset from the server's is printed.
//
// Writes the report to reports/freshness/ (Markdown and JSON). Exits 0 when
// every measured step passes, 1 when one fails, 2 on a setup error.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { HistoryResponse, InstrumentsResponse, LiveServerMessage } from '@aia/client-contract';
import { liveProviderOf, loadFeedPlan } from '@aia/hydration';
import { zonedDateKey } from '@aia/shared-kernel';

import { freshnessReport, parseThresholds, reportMarkdown } from './freshness-report.js';
import type { FreshnessProbes } from './freshness-watch.js';
import { watchFreshness } from './freshness-watch.js';
import { localStores } from './stores.js';

function usage(message: string): never {
  console.error(`${message}\nUsage: AIA_FRESHNESS_KEY=<agent key> pnpm freshness [--url URL] [--minutes N] [--symbol S]... [--storage]`);
  process.exit(2);
}

function options(args: readonly string[]) {
  const value = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : (args[at + 1] ?? usage(`--${name} needs a value`));
  };
  const symbols = args.flatMap((a, i) => (a === '--symbol' ? [args[i + 1] ?? usage('--symbol needs a value')] : []));
  const minutes = Number(value('minutes') ?? 5);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) usage('--minutes must be a whole number from 1 to 60');
  return { url: (value('url') ?? 'http://127.0.0.1:8080').replace(/\/$/, ''), minutes, symbols, storage: args.includes('--storage') };
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const key = process.env['AIA_FRESHNESS_KEY'] ?? usage('Set AIA_FRESHNESS_KEY to an agent key (create one in the chart or with POST /auth/agent-keys)');
  const thresholds = parseThresholds(JSON.parse(readFileSync(new URL('../../../config/freshness.json', import.meta.url), 'utf8')));
  const headers = { authorization: `Bearer ${key}` };
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${opts.url}${path}`, { headers });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  // The instruments to watch: those asked for, or every one whose 1m bars the key's plan includes.
  const listing = await get<InstrumentsResponse>('/instruments').catch((e: unknown) => usage(`Cannot list instruments at ${opts.url}: ${String(e)}`));
  const includes1m = listing.instruments.filter((i) => i.included.includes('1m')).map((i) => i.symbol);
  const symbols = opts.symbols.length > 0 ? opts.symbols : includes1m;
  const refused = symbols.filter((s) => !includes1m.includes(s));
  if (refused.length > 0) usage(`Not served at 1m on this key's plan: ${refused.join(', ')}`);
  if (symbols.length === 0) usage('No instrument is served at 1m on this key\'s plan');

  const health = await fetch(`${opts.url}/health`);
  const serverMs = Date.parse(health.headers.get('date') ?? '');
  const offset = Number.isNaN(serverMs) ? undefined : Date.now() - serverMs;

  /** With --storage: true once raw holds the minute, from the live day's index (one listing per ask). */
  const storage = (() => {
    if (!opts.storage) return undefined;
    const plan = loadFeedPlan();
    const stores = localStores(plan);
    const providerOf = liveProviderOf(plan);
    return async (symbol: string, minute: number): Promise<boolean> => {
      const date = zonedDateKey(minute, 'UTC');
      const provider = providerOf(symbol, date);
      if (provider === undefined) return false;
      const index = await stores.raw.liveDayIndex({ provider, symbol, date });
      return index.minuteTimes.some((time) => time === minute);
    };
  })();

  const live = `${opts.url.replace(/^http/, 'ws')}/live?token=${encodeURIComponent(key)}`;
  const probes: FreshnessProbes = {
    chart: (seen) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(live);
        ws.addEventListener('error', () => reject(new Error(`cannot open ${opts.url}/live`)));
        ws.addEventListener('open', () => {
          for (const instrument of symbols) ws.send(JSON.stringify({ op: 'subscribe', instrument, tf: '1m' }));
          resolve(() => ws.close());
        });
        ws.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as LiveServerMessage;
          if (message.type === 'error') console.error(`live: ${message.code}: ${message.message}`);
          if (message.type !== 'bars') return;
          for (const update of message.updates) if (!update.forming && update.timeframe === '1m') seen(update.instrument, update.bar.time);
        });
      }),
    cache: async (symbol, minute) => {
      const page = await get<HistoryResponse>(`/bars?instrument=${encodeURIComponent(symbol)}&tf=1m&limit=1`);
      return (page.bars.at(-1)?.time ?? 0) >= minute;
    },
    ...(storage === undefined ? {} : { storage }),
  };

  console.log(`Watching ${symbols.join(', ')} at ${opts.url} for ${opts.minutes} minute closes${opts.storage ? ', with storage' : ''}…`);
  if (offset !== undefined) console.log(`This clock is ${(offset / 1000).toFixed(1)} s ${offset >= 0 ? 'ahead of' : 'behind'} the server's (±1 s, from its Date header).`);
  const observations = await watchFreshness(probes, { symbols, minutes: opts.minutes, nowMs: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const report = freshnessReport(observations, thresholds);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const host = new URL(opts.url).host.replace(/[^\w.-]/g, '_');
  const markdown = reportMarkdown(report, `Freshness, ${opts.url}, ${new Date().toISOString().slice(0, 16)} UTC`);
  mkdirSync('reports/freshness', { recursive: true });
  writeFileSync(`reports/freshness/${stamp}-${host}.md`, markdown);
  writeFileSync(`reports/freshness/${stamp}-${host}.json`, JSON.stringify({ url: opts.url, clockOffsetMs: offset ?? null, thresholds, ...report, observations }, null, 2));
  console.log(`\n${markdown}\nReport: reports/freshness/${stamp}-${host}.md`);
  process.exit(report.pass ? 0 : 1);
}

await main().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(2);
});
