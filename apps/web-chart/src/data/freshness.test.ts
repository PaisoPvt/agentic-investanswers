import { describe, expect, it } from 'vitest';

import { FreshnessTracker, ago, freshnessOf } from './freshness.js';

const NOW = 1_794_312_000_000; // 2026-11-10 12:00 UTC, in ms
const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

const base = {
  now: NOW,
  connection: 'open' as const,
  timeframe: '1m' as const,
  lastUpdateAt: NOW - 4_000,
  // The forming minute: started 30 s ago.
  newestBarTime: NOW / 1000 - 30,
};

describe('freshnessOf', () => {
  it('is live while updates arrive and the newest bar is current', () => {
    expect(freshnessOf(base)).toMatchObject({ level: 'live', label: 'Live · updated 4s ago' });
  });

  it('is delayed after 90 s without an update, stale after 5 minutes', () => {
    expect(freshnessOf({ ...base, lastUpdateAt: NOW - 91_000 })).toMatchObject({ level: 'delayed', label: 'Delayed · updated 1m ago' });
    expect(freshnessOf({ ...base, lastUpdateAt: NOW - 301_000 }).level).toBe('stale');
  });

  it('is delayed when the newest bar ended more than 2 minutes ago, even with recent updates', () => {
    const lagging = freshnessOf({ ...base, newestBarTime: NOW / 1000 - 60 - 121 });
    expect(lagging.level).toBe('delayed');
    expect(lagging.detail).toContain('ended 2m ago');
    // 1h bars: the forming hour started 50 minutes ago, which is current.
    expect(freshnessOf({ ...base, timeframe: '1h', newestBarTime: NOW / 1000 - 3_000 }).level).toBe('live');
  });

  it('does not judge daily and longer bars by their time', () => {
    expect(freshnessOf({ ...base, timeframe: '1D', newestBarTime: NOW / 1000 - 5 * 86_400 }).level).toBe('live');
  });

  it('is offline while disconnected, and waiting before any data', () => {
    expect(freshnessOf({ ...base, connection: 'reconnecting' }).level).toBe('offline');
    expect(freshnessOf({ ...base, connection: 'closed' }).level).toBe('offline');
    expect(freshnessOf({ ...base, lastUpdateAt: undefined, newestBarTime: undefined })).toMatchObject({ level: 'waiting', label: 'Waiting for data' });
  });

  it('says in the detail when the newest bar is', () => {
    expect(freshnessOf(base).detail).toBe('Connected · newest bar 2026-11-10 11:59 UTC · last update 4s ago');
  });

  it('takes other limits', () => {
    expect(freshnessOf({ ...base, lastUpdateAt: NOW - 20_000 }, { delayedAfterMs: 10_000, staleAfterMs: 60_000, barLagMs: 120_000 }).level).toBe('delayed');
  });
});

describe('ago', () => {
  it('rounds down to the largest unit', () => {
    expect([ago(-5), ago(59_999), ago(60_000), ago(3_599_000), ago(7_200_000), ago(3 * 86_400_000)]).toEqual(['0s', '59s', '1m', '59m', '2h', '3d']);
  });
});

describe('FreshnessTracker', () => {
  it('remembers when the last event arrived and the newest bar, and forgets on reset', () => {
    let now = 1_000;
    const tracker = new FreshnessTracker(() => now);
    let calls = 0;
    tracker.subscribe(() => (calls += 1));

    tracker.seen({ type: 'reset', bars: [bar(60), bar(120)] });
    expect(tracker.get()).toEqual({ lastUpdateAt: 1_000, newestBarTime: 120 });

    now = 2_000;
    // A revision of an older bar still counts as an update, but does not move the newest bar back.
    tracker.seen({ type: 'bar', bar: bar(60), index: 0, newest: false });
    expect(tracker.get()).toEqual({ lastUpdateAt: 2_000, newestBarTime: 120 });

    tracker.seen({ type: 'bar', bar: bar(180), index: 2, newest: true });
    expect(tracker.get().newestBarTime).toBe(180);

    tracker.reset();
    expect(tracker.get()).toEqual({ lastUpdateAt: undefined, newestBarTime: undefined });
    expect(calls).toBe(4);
    tracker.reset();
    expect(calls).toBe(4);
  });
});
