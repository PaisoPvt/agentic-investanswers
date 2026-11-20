import { describe, expect, it } from 'vitest';

import { MemoryUsageRecordStore } from '../adapters/memory-usage-record-store.js';
import type { UsageRecord } from '../domain/usage-record.js';
import { AuditLog } from './audit-log.js';
import type { UsagePage, UsageRecordStorePort } from './usage-record-store-port.js';

const record = (time: number): UsageRecord => ({ time, requestId: `r${time}`, subject: { kind: 'human', id: 'acc-1' }, method: 'GET', route: '/bars', status: 200, durationMs: 1 });

function setup(store: UsageRecordStorePort = new MemoryUsageRecordStore()) {
  const timers: (() => void)[] = [];
  const errors: [unknown, number][] = [];
  const log = new AuditLog({ store, every: (_ms, run) => (timers.push(run), () => undefined), onError: (f, d) => errors.push([f, d]), batchSize: 3 });
  return { log, timers, errors };
}

/** A store that fails the first `failures` writes. */
class FlakyStore extends MemoryUsageRecordStore {
  constructor(private failures: number) {
    super();
  }
  override write(records: readonly UsageRecord[]): Promise<void> {
    if (this.failures-- > 0) return Promise.reject(new Error('throttled'));
    return super.write(records);
  }
}

describe('AuditLog', () => {
  it('writes on the timer, not while the request is answered', async () => {
    const store = new MemoryUsageRecordStore();
    const { log, timers } = setup(store);
    log.record(record(1));
    expect(store.written).toEqual([]);
    timers[0]?.();
    await log.flush();
    expect(store.written).toEqual([record(1)]);
  });

  it('writes at once when a batch is full', async () => {
    const store = new MemoryUsageRecordStore();
    const { log } = setup(store);
    for (const t of [1, 2, 3]) log.record(record(t));
    await log.flush();
    expect(store.written.map((r) => r.time)).toEqual([1, 2, 3]);
  });

  it('tries a failed batch once more, then drops it and says so', async () => {
    const store = new FlakyStore(2);
    const { log, errors } = setup(store);
    log.record(record(1));
    await log.flush();
    expect(errors).toEqual([[expect.any(Error), 0]]);
    log.record(record(2));
    await log.flush();
    expect(errors).toEqual([
      [expect.any(Error), 0],
      [expect.any(Error), 1],
    ]);
    expect(store.written).toEqual([record(2)]);
  });

  it('a failed batch that succeeds on the retry is kept', async () => {
    const store = new FlakyStore(1);
    const { log } = setup(store);
    log.record(record(1));
    await log.flush();
    await log.flush();
    expect(store.written).toEqual([record(1)]);
  });

  it('writes what is left on close', async () => {
    const store = new MemoryUsageRecordStore();
    const { log } = setup(store);
    log.record(record(1));
    await log.close();
    expect(store.written).toEqual([record(1)]);
  });

  it('pages a subject within the limits', async () => {
    const asked: number[] = [];
    const store: UsageRecordStorePort = {
      write: () => Promise.resolve(),
      page: (_key, query): Promise<UsagePage> => (asked.push(query.limit), Promise.resolve({ records: [], next: null })),
    };
    const { log } = setup(store);
    await log.page({ kind: 'human', id: 'a' });
    await log.page({ kind: 'human', id: 'a' }, { limit: 10_000 });
    await log.page({ kind: 'human', id: 'a' }, { limit: 0 });
    expect(asked).toEqual([50, 200, 1]);
  });
});
