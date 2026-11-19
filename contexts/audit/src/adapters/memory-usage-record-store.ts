// Usage records in memory (tests and the e2e server).

import type { UsagePage, UsageRecordStorePort } from '../application/usage-record-store-port.js';
import type { UsageRecord } from '../domain/usage-record.js';
import { subjectKey } from '../domain/usage-record.js';
import { sortKey } from './sort-key.js';

export class MemoryUsageRecordStore implements UsageRecordStorePort {
  /** Every record written, in the order written. */
  readonly written: UsageRecord[] = [];

  write(records: readonly UsageRecord[]): Promise<void> {
    this.written.push(...records);
    return Promise.resolve();
  }

  page(key: string, query: { readonly before?: string; readonly limit: number }): Promise<UsagePage> {
    const before = query.before;
    const older = this.written
      .filter((r) => subjectKey(r.subject) === key && (before === undefined || sortKey(r) < before))
      .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
    const records = older.slice(0, query.limit);
    const last = records.at(-1);
    return Promise.resolve({ records, next: older.length > query.limit && last !== undefined ? sortKey(last) : null });
  }
}
