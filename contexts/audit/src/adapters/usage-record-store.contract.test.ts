// The same cases for every usage record store: memory always, and DynamoDB when
// the local one from `docker compose up -d` is reachable (CI runs it).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import type { UsageRecordStorePort } from '../application/usage-record-store-port.js';
import type { Subject, UsageRecord } from '../domain/usage-record.js';
import { subjectKey } from '../domain/usage-record.js';
import { DynamoUsageRecordStore, ensureAuditTable } from './dynamodb-usage-record-store.js';
import { MemoryUsageRecordStore } from './memory-usage-record-store.js';
import { isCursor } from './sort-key.js';

const TABLE = 'aia-audit-test';

async function dynamoOrUndefined() {
  const client = new DynamoDBClient({
    endpoint: process.env['AIA_DYNAMODB_TEST_URL'] ?? 'http://127.0.0.1:8000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    await ensureAuditTable(client, TABLE);
    return client;
  } catch {
    client.destroy();
    return undefined;
  }
}

const dynamo = await dynamoOrUndefined();
if (dynamo === undefined) console.warn('DynamoDB unreachable: skipping the DynamoDB usage record tests (run: docker compose up -d)');
afterAll(() => dynamo?.destroy());

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const stores: Array<[string, () => UsageRecordStorePort | undefined]> = [
  ['memory', () => new MemoryUsageRecordStore()],
  ['dynamodb', () => (dynamo ? new DynamoUsageRecordStore(dynamo, TABLE) : undefined)],
];

describe.each(stores)('%s usage record store', (name, make) => {
  const store = make();
  const human: Subject = { kind: 'human', id: `acc-${name}-${run}` };
  const agent: Subject = { kind: 'agent', id: `key-${name}-${run}`, owner: human.id };
  const record = (subject: Subject, time: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
    time,
    requestId: `req-${time}`,
    subject,
    method: 'GET',
    route: '/bars',
    status: 200,
    durationMs: 3,
    ...extra,
  });

  it.skipIf(store === undefined)('keeps each subject apart and reads newest first, with every field back', async () => {
    const s = store as UsageRecordStorePort;
    const full = record(agent, 1_000, { method: 'POST', route: '/mcp', status: 403, errorCode: 'forbidden', instrument: 'BTCUSD', timeframe: '1h', tool: 'get_bars', clientAddress: '203.0.113.7' });
    await s.write([record(human, 1_000), record(human, 3_000), full, record(human, 2_000, { indicator: 'sma' })]);
    const mine = await s.page(subjectKey(human), { limit: 10 });
    expect(mine.records.map((r) => r.time)).toEqual([3_000, 2_000, 1_000]);
    expect(mine.records[1]?.indicator).toBe('sma');
    expect(mine.next).toBeNull();
    expect((await s.page(subjectKey(agent), { limit: 10 })).records).toEqual([full]);
  });

  it.skipIf(store === undefined)('pages back with the cursor, without repeating or skipping a record', async () => {
    const s = store as UsageRecordStorePort;
    const subject: Subject = { kind: 'human', id: `pager-${name}-${run}` };
    // Two records in the same millisecond, told apart by request id.
    await s.write([record(subject, 10), record(subject, 20), { ...record(subject, 20), requestId: 'req-20b' }, record(subject, 30), record(subject, 40)]);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await s.page(subjectKey(subject), { limit: 2, ...(before === undefined ? {} : { before }) });
      seen.push(...page.records.map((r) => `${r.time}/${r.requestId}`));
      if (page.next === null) break;
      expect(isCursor(page.next)).toBe(true);
      before = page.next;
    }
    expect(seen).toEqual(['40/req-40', '30/req-30', '20/req-20b', '20/req-20', '10/req-10']);
  });

  it.skipIf(store === undefined)('writes more records than one batch holds', async () => {
    const s = store as UsageRecordStorePort;
    const subject: Subject = { kind: 'human', id: `bulk-${name}-${run}` };
    await s.write(Array.from({ length: 60 }, (_, i) => record(subject, i + 1)));
    expect((await s.page(subjectKey(subject), { limit: 100 })).records).toHaveLength(60);
  });
});
