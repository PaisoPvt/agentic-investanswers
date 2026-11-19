// Usage records in DynamoDB (M4-04): table `aia-<env>-audit` on AWS (CDK),
// `aia-audit` locally (created on start-up). One partition per subject
// (`pk` = subjectKey), sorted by time (`sk`, sort-key.ts); `ttl` expires a
// record after the retention period (decision record T-11).

import type { AttributeValue, DynamoDBClient, WriteRequest } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  QueryCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

import type { UsagePage, UsageRecordStorePort } from '../application/usage-record-store-port.js';
import type { Subject, UsageRecord } from '../domain/usage-record.js';
import { DEFAULT_RETENTION_DAYS, subjectKey } from '../domain/usage-record.js';
import { sortKey } from './sort-key.js';

/** DynamoDB takes at most 25 items per batch write. */
const BATCH = 25;

const OPTIONAL_TEXT = ['errorCode', 'instrument', 'timeframe', 'indicator', 'tool', 'clientAddress'] as const;

export interface DynamoUsageRecordStoreOptions {
  readonly retentionDays?: number;
}

export class DynamoUsageRecordStore implements UsageRecordStorePort {
  private readonly retentionDays: number;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
    options: DynamoUsageRecordStoreOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  async write(records: readonly UsageRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += BATCH) {
      let requests: WriteRequest[] = records.slice(i, i + BATCH).map((r) => ({ PutRequest: { Item: this.item(r) } }));
      // Items DynamoDB throttled come back unprocessed: sent once more, then given up.
      for (let attempt = 0; attempt < 2 && requests.length > 0; attempt++) {
        const result = await this.client.send(new BatchWriteItemCommand({ RequestItems: { [this.table]: requests } }));
        requests = result.UnprocessedItems?.[this.table] ?? [];
      }
      if (requests.length > 0) throw new Error(`${requests.length} usage records were not written (throttled)`);
    }
  }

  async page(key: string, query: { readonly before?: string; readonly limit: number }): Promise<UsagePage> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: query.before === undefined ? 'pk = :pk' : 'pk = :pk AND sk < :before',
        ExpressionAttributeValues: { ':pk': { S: key }, ...(query.before === undefined ? {} : { ':before': { S: query.before } }) },
        ScanIndexForward: false,
        Limit: query.limit,
      }),
    );
    const records = (result.Items ?? []).map(fromItem);
    const last = records.at(-1);
    return { records, next: result.LastEvaluatedKey !== undefined && last !== undefined ? sortKey(last) : null };
  }

  private item(record: UsageRecord): Record<string, AttributeValue> {
    const item: Record<string, AttributeValue> = {
      pk: { S: subjectKey(record.subject) },
      sk: { S: sortKey(record) },
      time: { N: String(record.time) },
      requestId: { S: record.requestId },
      kind: { S: record.subject.kind },
      subject: { S: record.subject.id },
      method: { S: record.method },
      route: { S: record.route },
      status: { N: String(record.status) },
      durationMs: { N: String(record.durationMs) },
      ttl: { N: String(Math.floor(record.time / 1000) + this.retentionDays * 86_400) },
    };
    if (record.subject.owner !== undefined) item['owner'] = { S: record.subject.owner };
    for (const name of OPTIONAL_TEXT) {
      const value = record[name];
      if (value !== undefined) item[name] = { S: value };
    }
    return item;
  }
}

function fromItem(item: Record<string, AttributeValue>): UsageRecord {
  const text = (name: string) => item[name]?.S;
  const number = (name: string) => Number(item[name]?.N ?? 0);
  const owner = text('owner');
  const subject: Subject = { kind: (text('kind') ?? 'anonymous') as Subject['kind'], id: text('subject') ?? '', ...(owner === undefined ? {} : { owner }) };
  const record: Record<string, unknown> = {
    time: number('time'),
    requestId: text('requestId') ?? '',
    subject,
    method: text('method') ?? '',
    route: text('route') ?? '',
    status: number('status'),
    durationMs: number('durationMs'),
  };
  for (const name of OPTIONAL_TEXT) {
    const value = text(name);
    if (value !== undefined) record[name] = value;
  }
  return record as unknown as UsageRecord;
}

/** Creates the audit table if it does not exist (local runs and tests; CDK creates it in AWS). */
export async function ensureAuditTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  await client.send(
    new CreateTableCommand({
      TableName: table,
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
  await client.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }));
}
