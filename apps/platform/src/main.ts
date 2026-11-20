// `pnpm platform`: run the platform process locally (M2-03).
//
// Opens the data layer (@aia/data, M1-16: stores on MinIO locally, the cache
// and live bus on Redis, the feed plan), puts the History API and the live
// gateway (@aia/serving) over it, and listens. Settings, all optional:
//   AIA_PORT (8080), AIA_HOST (127.0.0.1), AIA_TRUSTED_PROXIES (addresses or
//   CIDR ranges of the proxies in front, or their number of hops; 2 on AWS), AIA_REDIS_URL, AIA_S3_* and
//   AIA_*_BUCKET as for the hydration commands, AIA_FEED_PLAN,
//   AIA_DEV_AUTH=1 to treat every request as the local developer; otherwise the
//   app's own sign-in (M2-08) at /auth/*, with accounts and sessions in
//   DynamoDB: AIA_DYNAMODB_ENDPOINT (the local one, http://127.0.0.1:8000;
//   "aws" for AWS itself), AIA_USERS_TABLE (aia-users).
//   AIA_AUDIT_TABLE (aia-audit): the usage and audit records (M4-04), in the
//   same DynamoDB; kept in memory under AIA_DEV_AUTH=1.
//   AIA_INDICATORS: the indicator modules to load (M3-05, load-indicators.ts),
//   for example ../agentic-investanswers-indicators/src/index.ts; none without it.
//
// Exits 2 on a setup error.

import {
  DynamoAccountStore,
  DynamoAgentKeyStore,
  DynamoSessionStore,
  RateLimiter,
  RedisRateCounter,
  accessFromEnv,
  dynamoClient,
  ensureUsersTable,
  loadRateLimits,
} from '@aia/access';
import { AuditLog, DynamoUsageRecordStore, MemoryUsageRecordStore, ensureAuditTable } from '@aia/audit';
import { openLocalDataLayer } from '@aia/data';
import { IndicatorEngine, RedisIndicatorOutputCache } from '@aia/indicators';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';

import { IndicatorBars } from './indicator-bars.js';
import type { IndicatorRunner } from './indicator-outputs.js';
import { indicatorModules, loadIndicators } from './load-indicators.js';
import { buildServer } from './server.js';

/** Account and session stores in DynamoDB; locally the table is created if missing (CDK creates it in AWS). */
async function usersStores(env: NodeJS.ProcessEnv) {
  const table = env['AIA_USERS_TABLE'] ?? 'aia-users';
  const endpoint = env['AIA_DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
  const local = endpoint !== 'aws';
  const client = dynamoClient(local ? { endpoint, table, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : { endpoint, table });
  if (local) await ensureUsersTable(client, table);
  return {
    accounts: new DynamoAccountStore(client, table),
    sessions: new DynamoSessionStore(client, table),
    agentKeys: new DynamoAgentKeyStore(client, table),
  };
}

/** Usage and audit records (M4-04): DynamoDB beside the users table; in memory with developer access. */
async function auditLog(env: NodeJS.ProcessEnv): Promise<AuditLog> {
  const onError = (failure: unknown, dropped: number) =>
    console.error(`audit: ${failure instanceof Error ? failure.message : String(failure)} (${dropped > 0 ? `${dropped} records dropped` : 'retrying with the next batch'})`);
  if (env['AIA_DEV_AUTH'] === '1') return new AuditLog({ store: new MemoryUsageRecordStore(), onError });
  const table = env['AIA_AUDIT_TABLE'] ?? 'aia-audit';
  const endpoint = env['AIA_DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
  const local = endpoint !== 'aws';
  const client = dynamoClient(local ? { endpoint, table, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : { endpoint, table });
  if (local) await ensureAuditTable(client, table);
  return new AuditLog({ store: new DynamoUsageRecordStore(client, table), onError });
}

function trustedProxies(env: NodeJS.ProcessEnv): { trustedProxies?: string | number } {
  const text = env['AIA_TRUSTED_PROXIES']?.trim();
  if (text === undefined || text === '') return {};
  return { trustedProxies: /^\d+$/.test(text) ? Number(text) : text };
}

async function main(): Promise<void> {
  const env = process.env;
  const data = await openLocalDataLayer(env, {
    onError: (what, failure) => console.error(`redis (${what}): ${failure.message} (reads go to the store meanwhile; charts resync once it is back)`),
  });
  const history = new HistoryQuery({ data });
  // One subscription per process; the gateway fans out to every browser.
  const live = new LiveGateway({
    data,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  await data.subscribe(live);

  const access = env['AIA_DEV_AUTH'] === '1' ? accessFromEnv(env) : accessFromEnv(env, await usersStores(env));
  console.log(access.description);
  // Per-user rate limits (M2-10), counted in the same Redis, so every platform process shares them.
  const counter = await RedisRateCounter.connect({
    url: env['AIA_REDIS_URL'],
    reconnect: 'forever',
    onError: (failure) => console.error(`redis (rate limits): ${failure.message} (requests are let through meanwhile)`),
  });
  const limits = new RateLimiter({
    limits: loadRateLimits(env),
    counter,
    now: () => Date.now(),
    onError: (failure) => console.error(`rate limits: ${failure.message} (request let through)`),
  });
  const now = () => barTime(Math.floor(Date.now() / 1000));
  // Indicator source lives outside this repo (CLAUDE.md rule 5); it is loaded from AIA_INDICATORS.
  const indicators = await loadIndicators(indicatorModules(env));
  console.log(`indicators: ${indicators.list().map((d) => `${d.id} v${d.version}`).join(', ') || 'none (set AIA_INDICATORS)'}`);
  const indicatorCache = await RedisIndicatorOutputCache.connect({
    url: env['AIA_REDIS_URL'],
    reconnect: 'forever',
    onError: (failure) => console.error(`redis (indicator outputs): ${failure.message} (indicators are recomputed meanwhile)`),
  });
  const indicatorBars = new IndicatorBars({ data, now });
  const engine = new IndicatorEngine({ registry: indicators, bars: indicatorBars, cache: indicatorCache });
  const indicatorRunner: IndicatorRunner = {
    drawn: (request) => engine.drawn(request),
    forming: (instrument, timeframe) => indicatorBars.forming(instrument, timeframe),
  };
  const audit = await auditLog(env);
  const app = await buildServer({ history, access, live, limits, catalog: data, indicators, indicatorRunner, audit, ...trustedProxies(env), now, logger: true });

  const port = Number(env['AIA_PORT'] ?? 8080);
  const host = env['AIA_HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });

  const shutdown = (): void => {
    live.stop();
    void app
      .close()
      .then(() => data.close())
      .then(() => counter.close())
      .then(() => indicatorCache.close())
      .then(() => audit.close())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main().catch((failure: unknown) => {
  console.error(
    `${failure instanceof Error ? failure.message : String(failure)}\n` +
      'Is the local stack up? Run: docker compose up -d',
  );
  process.exit(2);
});
