// How long live minutes take to land (M1-11): per instrument, from a minute's
// close to it being stored in raw (`stored`), and to its bars being cooked,
// cached and announced to charts (`served`). Collects over a period, then
// summarises and starts over. Pure: times are given in milliseconds.

export type LatencyStage = 'stored' | 'served';

export interface LatencyStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface InstrumentLatency {
  readonly symbol: string;
  readonly stored?: LatencyStats;
  readonly served?: LatencyStats;
}

/** The nearest-rank percentile of sorted values (`p` from 0 to 100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

function stats(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] as number };
}

export class LatencyProbe {
  private readonly samples = new Map<string, Record<LatencyStage, number[]>>();

  /** One minute's latency at one stage. */
  record(symbol: string, stage: LatencyStage, ms: number): void {
    let entry = this.samples.get(symbol);
    if (entry === undefined) {
      entry = { stored: [], served: [] };
      this.samples.set(symbol, entry);
    }
    entry[stage].push(Math.max(0, ms));
  }

  /** The period's figures per instrument, alphabetical, then starts a new period. */
  summary(): InstrumentLatency[] {
    const out = [...this.samples]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, s]) => ({
        symbol,
        ...(s.stored.length === 0 ? {} : { stored: stats(s.stored) }),
        ...(s.served.length === 0 ? {} : { served: stats(s.served) }),
      }));
    this.samples.clear();
    return out;
  }
}
