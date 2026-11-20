import { describe, expect, it } from 'vitest';

import type { UsageRecord } from './usage-record.js';
import { summarise } from './usage-summary.js';

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 18, 23, 0);
const record = (time: number, route: string, status = 200): UsageRecord => ({ time, requestId: `r${time}${route}`, subject: { kind: 'human', id: 'a' }, method: 'GET', route, status, durationMs: 1 });

describe('summarise', () => {
  it('totals requests and refusals per route (most used first) and per UTC day (oldest first)', () => {
    const summary = summarise([record(T, '/bars'), record(T + 1, '/plan', 403), record(T + 2 * 3_600_000, '/bars', 429), record(T + DAY, '/bars')]);
    expect(summary).toEqual({
      requests: 4,
      refused: 2,
      byRoute: [
        { route: '/bars', requests: 3, refused: 1 },
        { route: '/plan', requests: 1, refused: 1 },
      ],
      byDay: [
        { day: '2026-11-18', requests: 2, refused: 1 },
        { day: '2026-11-19', requests: 2, refused: 1 },
      ],
    });
  });

  it('is empty for no records', () => {
    expect(summarise([])).toEqual({ requests: 0, refused: 0, byRoute: [], byDay: [] });
  });
});
