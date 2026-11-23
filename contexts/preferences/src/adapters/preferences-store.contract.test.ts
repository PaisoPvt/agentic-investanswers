// The same cases for every preferences store: memory always, and DynamoDB when
// the local one from `docker compose up -d` is reachable (CI runs it).

import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import type { PreferencesStorePort } from '../application/preferences-store-port.js';
import { DynamoPreferencesStore } from './dynamodb-preferences-store.js';
import { MemoryPreferencesStore } from './memory-preferences-store.js';

const TABLE = 'aia-users-test';

/** The users table's shape (pk/sk); access creates the real one. */
async function ensureTable(client: DynamoDBClient): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    await client.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
  }
}

async function dynamoOrUndefined() {
  const client = new DynamoDBClient({
    endpoint: process.env['AIA_DYNAMODB_TEST_URL'] ?? 'http://127.0.0.1:8000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    await ensureTable(client);
    return client;
  } catch {
    client.destroy();
    return undefined;
  }
}

const dynamo = await dynamoOrUndefined();
if (dynamo === undefined) console.warn('DynamoDB unreachable: skipping the DynamoDB preferences tests (run: docker compose up -d)');
afterAll(() => dynamo?.destroy());

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const stores: Array<[string, () => PreferencesStorePort | undefined]> = [
  ['memory', () => new MemoryPreferencesStore()],
  ['dynamodb', () => (dynamo ? new DynamoPreferencesStore(dynamo, TABLE) : undefined)],
];

describe.each(stores)('%s preferences store', (name, make) => {
  const store = make();
  const account = (n: number) => `acc-${name}-${run}-${n}`;

  it.skipIf(store === undefined)('has nothing for an account that never saved', async () => {
    expect(await (store as PreferencesStorePort).get(account(1))).toBeUndefined();
  });

  it.skipIf(store === undefined)('reads back what was saved, per account', async () => {
    const s = store as PreferencesStorePort;
    await s.put(account(2), { instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' });
    await s.put(account(3), { timeframe: '1D' });
    expect(await s.get(account(2))).toEqual({ instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' });
    expect(await s.get(account(3))).toEqual({ timeframe: '1D' });
  });

  it.skipIf(store === undefined)('replaces the whole record on each save', async () => {
    const s = store as PreferencesStorePort;
    await s.put(account(4), { instrument: 'BTCUSD', timeframe: '5m', theme: 'light' });
    await s.put(account(4), { instrument: 'ETHUSD' });
    expect(await s.get(account(4))).toEqual({ instrument: 'ETHUSD' });
  });
});
