// The data freshness badge in the status line (UI-02): a coloured dot and a
// few words ("Live · updated 4s ago"), with the details on hover. It ticks
// once a second on its own, so the rest of the app does not re-render.

import type { Timeframe } from '@aia/shared-kernel';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { FreshnessTracker } from '../data/freshness.js';
import { freshnessOf } from '../data/freshness.js';
import type { ConnectionState } from '../data/live-connection.js';

export interface FreshnessBadgeProps {
  readonly tracker: FreshnessTracker;
  readonly connection: ConnectionState;
  readonly timeframe: Timeframe;
  readonly clock?: () => number;
}

export function FreshnessBadge({ tracker, connection, timeframe, clock = Date.now }: FreshnessBadgeProps) {
  const { lastUpdateAt, newestBarTime } = useSyncExternalStore(tracker.subscribe, tracker.get);
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(clock()), 1_000);
    return () => window.clearInterval(timer);
  }, [clock]);
  const freshness = freshnessOf({ now: Math.max(now, lastUpdateAt ?? 0), connection, timeframe, lastUpdateAt, newestBarTime });
  return (
    <span className="freshness" data-testid="freshness" data-level={freshness.level} title={freshness.detail} role="status">
      <span className="dot" aria-hidden="true" />
      {freshness.label}
    </span>
  );
}
