// Totals over usage records (M4-04), for the operator's `pnpm usage`: requests
// per route and per UTC day, and how many were refused. Pure.

import type { UsageRecord } from './usage-record.js';

export interface UsageTotals {
  readonly requests: number;
  /** Answered with 400 or above. */
  readonly refused: number;
}

export interface UsageSummary extends UsageTotals {
  /** By route pattern, most used first. */
  readonly byRoute: readonly (UsageTotals & { readonly route: string })[];
  /** By UTC day (YYYY-MM-DD), oldest first. */
  readonly byDay: readonly (UsageTotals & { readonly day: string })[];
}

function tally<K extends string>(records: readonly UsageRecord[], keyOf: (r: UsageRecord) => K): Map<K, { requests: number; refused: number }> {
  const totals = new Map<K, { requests: number; refused: number }>();
  for (const record of records) {
    const key = keyOf(record);
    const total = totals.get(key) ?? { requests: 0, refused: 0 };
    total.requests += 1;
    if (record.status >= 400) total.refused += 1;
    totals.set(key, total);
  }
  return totals;
}

export function summarise(records: readonly UsageRecord[]): UsageSummary {
  const byRoute = [...tally(records, (r) => r.route)].map(([route, t]) => ({ route, ...t })).sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));
  const byDay = [...tally(records, (r) => new Date(r.time).toISOString().slice(0, 10))].map(([day, t]) => ({ day, ...t })).sort((a, b) => a.day.localeCompare(b.day));
  return { requests: records.length, refused: records.filter((r) => r.status >= 400).length, byRoute, byDay };
}
