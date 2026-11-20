// Where usage records are kept (M4-04): DynamoDB on AWS and locally, memory in
// tests and the e2e server.

import type { UsageRecord } from '../domain/usage-record.js';

export interface UsagePage {
  /** Newest first. */
  readonly records: readonly UsageRecord[];
  /** Pass as `before` for the next older page; null when there is none. */
  readonly next: string | null;
}

export interface UsageRecordStorePort {
  /** Writes these records (any number; the store batches as it needs). */
  write(records: readonly UsageRecord[]): Promise<void>;
  /** One subject's records, newest first, older than the `before` cursor when given. */
  page(subjectKey: string, query: { readonly before?: string; readonly limit: number }): Promise<UsagePage>;
}
