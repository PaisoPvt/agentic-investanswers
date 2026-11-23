// Saved chart preferences in DynamoDB (M2-13): one item per account in the
// users table (`aia-<env>-users` on AWS, `aia-users` locally), beside the
// account's own items, so one read by key loads them:
//
//   ACCOUNT#<id> / PREFS    instrument?, timeframe?, theme?
//
// The table and its client are passed in; access creates the table locally
// and CDK on AWS.

import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

import type { PreferencesStorePort } from '../application/preferences-store-port.js';
import type { ChartPreferences } from '../domain/chart-preferences.js';
import { parsePreferences } from '../domain/chart-preferences.js';

const FIELDS = ['instrument', 'timeframe', 'theme'] as const;

const key = (accountId: string): Record<string, AttributeValue> => ({ pk: { S: `ACCOUNT#${accountId}` }, sk: { S: 'PREFS' } });

export class DynamoPreferencesStore implements PreferencesStorePort {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}

  async get(accountId: string): Promise<ChartPreferences | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.table, Key: key(accountId) }));
    const item = result.Item;
    if (item === undefined) return undefined;
    const fields: Record<string, string> = {};
    for (const name of FIELDS) {
      const value = item[name]?.S;
      if (value !== undefined) fields[name] = value;
    }
    // Read back through the same check, so a value no longer valid is dropped, not served.
    const parsed = parsePreferences(fields);
    return parsed.ok ? parsed.value : {};
  }

  async put(accountId: string, preferences: ChartPreferences): Promise<void> {
    const item: Record<string, AttributeValue> = key(accountId);
    for (const name of FIELDS) {
      const value = preferences[name];
      if (value !== undefined) item[name] = { S: value };
    }
    await this.client.send(new PutItemCommand({ TableName: this.table, Item: item }));
  }
}
