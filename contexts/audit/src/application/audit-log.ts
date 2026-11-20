// The audit log (M4-04): takes one record per request and writes them in
// batches, so a request never waits on the store. A failed batch is tried once
// more on the next flush and then dropped with a log line: the requests it
// describes have already been answered, and the platform must keep serving.

import type { Subject, UsageRecord } from '../domain/usage-record.js';
import { USAGE_DEFAULT_LIMIT, USAGE_MAX_LIMIT, subjectKey } from '../domain/usage-record.js';
import type { UsagePage, UsageRecordStorePort } from './usage-record-store-port.js';

export interface AuditLogDeps {
  readonly store: UsageRecordStorePort;
  /** Starts a repeating timer; returns its stop. Tests drive it by hand. */
  readonly every?: (ms: number, run: () => void) => () => void;
  /** Told when a batch could not be written, and whether it is dropped. */
  readonly onError?: (failure: unknown, dropped: number) => void;
  /** Writes at least this often (default 1 s), or as soon as a batch is full. */
  readonly flushMs?: number;
  readonly batchSize?: number;
}

const defaultEvery = (ms: number, run: () => void) => {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export class AuditLog {
  private pending: UsageRecord[] = [];
  /** A batch that failed once, tried again with the next flush. */
  private retry: UsageRecord[] = [];
  private flushing: Promise<void> | undefined;
  private readonly stop: () => void;

  constructor(private readonly deps: AuditLogDeps) {
    this.stop = (deps.every ?? defaultEvery)(deps.flushMs ?? 1_000, () => void this.flush());
  }

  record(record: UsageRecord): void {
    this.pending.push(record);
    if (this.pending.length >= (this.deps.batchSize ?? 25)) void this.flush();
  }

  /** Writes what is waiting; one flush at a time, a call meanwhile shares it. */
  flush(): Promise<void> {
    this.flushing ??= this.write().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  /** One subject's records, newest first. */
  page(subject: Pick<Subject, 'kind' | 'id'>, query: { readonly before?: string; readonly limit?: number } = {}): Promise<UsagePage> {
    const limit = Math.min(USAGE_MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? USAGE_DEFAULT_LIMIT)));
    return this.deps.store.page(subjectKey(subject), { limit, ...(query.before === undefined ? {} : { before: query.before }) });
  }

  /** Stops the timer and writes what is left. */
  async close(): Promise<void> {
    this.stop();
    await this.flush();
    if (this.pending.length > 0 || this.retry.length > 0) await this.write();
  }

  private async write(): Promise<void> {
    const retry = this.retry;
    const fresh = this.pending;
    this.retry = [];
    this.pending = [];
    if (retry.length > 0) {
      try {
        await this.deps.store.write(retry);
      } catch (failure) {
        this.deps.onError?.(failure, retry.length);
      }
    }
    if (fresh.length === 0) return;
    try {
      await this.deps.store.write(fresh);
    } catch (failure) {
      this.retry = fresh;
      this.deps.onError?.(failure, 0);
    }
  }
}
