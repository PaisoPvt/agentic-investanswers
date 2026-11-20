// The order of one subject's records: time (zero-padded milliseconds), then
// request id, so the sort key sorts by time and is unique. Also the paging
// cursor handed to clients.

import type { UsageRecord } from '../domain/usage-record.js';

export function sortKey(record: Pick<UsageRecord, 'time' | 'requestId'>): string {
  return `${String(record.time).padStart(15, '0')}#${record.requestId}`;
}

/** True for a cursor this store could have handed out. */
export function isCursor(value: string): boolean {
  return /^\d{15}#[\w.-]{1,64}$/.test(value);
}
