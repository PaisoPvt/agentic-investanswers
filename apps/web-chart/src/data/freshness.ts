// How fresh the chart's data looks (UI-02, client UI feedback), from what the
// browser already receives: when the last bar update arrived, and how far the
// newest bar is behind now. The freshness checker (M2-07) will measure each
// step on the server; its numbers can feed the same badge later.
//
// Limits are in FRESHNESS_LIMITS, one place to change them.

import type { Timeframe } from '@aia/shared-kernel';
import { timeframeSeconds } from '@aia/shared-kernel';

import type { SeriesEvent } from './bar-series.js';
import type { ConnectionState } from './live-connection.js';

export interface FreshnessLimits {
  readonly delayedAfterMs: number;
  readonly staleAfterMs: number;
  readonly barLagMs: number;
}

export const FRESHNESS_LIMITS: FreshnessLimits = {
  /** No update for longer than this: delayed. */
  delayedAfterMs: 90_000,
  /** No update for longer than this: stale. */
  staleAfterMs: 300_000,
  /** The newest bar ended longer ago than this: delayed (intraday timeframes only). */
  barLagMs: 120_000,
};

export type FreshnessLevel = 'waiting' | 'live' | 'delayed' | 'stale' | 'offline';

export interface FreshnessInput {
  /** Now, in milliseconds. */
  readonly now: number;
  readonly connection: ConnectionState;
  readonly timeframe: Timeframe;
  /** When the last update (or the first page) arrived, in milliseconds. */
  readonly lastUpdateAt: number | undefined;
  /** The newest bar's start, in UTC seconds. */
  readonly newestBarTime: number | undefined;
}

export interface Freshness {
  readonly level: FreshnessLevel;
  /** A few words for the badge, e.g. "Live · updated 4s ago". */
  readonly label: string;
  /** A longer line for the tooltip. */
  readonly detail: string;
}

const LEVEL_TEXT: Readonly<Record<FreshnessLevel, string>> = {
  waiting: 'Waiting for data',
  live: 'Live',
  delayed: 'Delayed',
  stale: 'Stale',
  offline: 'Offline',
};

/** "4s", "3m", "2h", "5d". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function freshnessOf(input: FreshnessInput, limits: FreshnessLimits = FRESHNESS_LIMITS): Freshness {
  const { now, connection, timeframe, lastUpdateAt, newestBarTime } = input;
  const span = timeframeSeconds(timeframe);
  // How long ago the newest bar ended; undefined for daily and longer, or no bar.
  const barLag = span === undefined || newestBarTime === undefined ? undefined : now - (newestBarTime + span) * 1000;
  const sinceUpdate = lastUpdateAt === undefined ? undefined : now - lastUpdateAt;

  let level: FreshnessLevel;
  if (connection === 'closed' || connection === 'reconnecting') level = 'offline';
  else if (sinceUpdate === undefined) level = 'waiting';
  else if (sinceUpdate > limits.staleAfterMs) level = 'stale';
  else if (sinceUpdate > limits.delayedAfterMs || (barLag !== undefined && barLag > limits.barLagMs)) level = 'delayed';
  else level = 'live';

  const updated = sinceUpdate === undefined ? undefined : `updated ${ago(sinceUpdate)} ago`;
  const label = updated === undefined || level === 'waiting' ? LEVEL_TEXT[level] : `${LEVEL_TEXT[level]} · ${updated}`;
  const parts = [
    connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting' : connection === 'reconnecting' ? 'Reconnecting' : 'Disconnected',
    newestBarTime === undefined ? 'no bars yet' : `newest bar ${utc(newestBarTime)}`,
    ...(barLag !== undefined && barLag > limits.barLagMs ? [`ended ${ago(barLag)} ago`] : []),
    ...(updated === undefined ? [] : [`last update ${ago(sinceUpdate ?? 0)} ago`]),
  ];
  return { level, label, detail: parts.join(' · ') };
}

/** Remembers the last update the chart received, for the badge (useSyncExternalStore). */
export class FreshnessTracker {
  private state: { readonly lastUpdateAt: number | undefined; readonly newestBarTime: number | undefined } = {
    lastUpdateAt: undefined,
    newestBarTime: undefined,
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = () => this.state;

  /** A series event for the shown instrument and timeframe. */
  seen(event: SeriesEvent): void {
    const newest = event.type === 'reset' ? event.bars.at(-1)?.time : event.newest ? event.bar.time : undefined;
    const newestBarTime = newest === undefined ? this.state.newestBarTime : Math.max(newest, this.state.newestBarTime ?? newest);
    this.state = { lastUpdateAt: this.clock(), newestBarTime };
    for (const listener of this.listeners) listener();
  }

  /** Another instrument or timeframe: forget the previous one's. */
  reset(): void {
    if (this.state.lastUpdateAt === undefined && this.state.newestBarTime === undefined) return;
    this.state = { lastUpdateAt: undefined, newestBarTime: undefined };
    for (const listener of this.listeners) listener();
  }
}
