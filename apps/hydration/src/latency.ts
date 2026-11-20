// Live minute latency in `pnpm live` (M1-11): each stored minute is timed
// from its close (bar time + 60 s, on this process's clock) to raw stored and
// to served (cooked, cached and announced). Every period, one line per
// instrument with p50 and p95; with `AIA_METRICS=emf`, each minute is also a
// CloudWatch metric through the embedded metric format, so CloudWatch computes
// percentiles over any period (namespace `AIA/<env>`, dimension Instrument).

import type { InstrumentLatency, LatencyStage, LatencyStats } from '@aia/hydration';
import { LatencyProbe } from '@aia/hydration';

const METRIC: Readonly<Record<LatencyStage, string>> = { stored: 'MinuteStoredMs', served: 'MinuteServedMs' };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const part = (stage: LatencyStage, s: LatencyStats | undefined) => (s === undefined ? `${stage} -` : `${stage} p50 ${seconds(s.p50)} p95 ${seconds(s.p95)}`);

/** One instrument's period, for example `latency BTCUSD stored p50 0.8 s p95 1.4 s · served p50 0.9 s p95 1.6 s (15 minutes)`. */
export function latencyLine(latency: InstrumentLatency): string {
  const count = Math.max(latency.stored?.count ?? 0, latency.served?.count ?? 0);
  return `latency ${latency.symbol} ${part('stored', latency.stored)} · ${part('served', latency.served)} (${count} minute${count === 1 ? '' : 's'})`;
}

/** One minute at one stage as a CloudWatch embedded-metric-format log line. */
export function emfLine(namespace: string, symbol: string, stage: LatencyStage, ms: number, atMs: number): string {
  const name = METRIC[stage];
  return JSON.stringify({
    _aws: { Timestamp: atMs, CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [['Instrument']], Metrics: [{ Name: name, Unit: 'Milliseconds' }] }] },
    Instrument: symbol,
    [name]: Math.round(ms),
  });
}

export interface LatencyReporterOptions {
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
  /** Writes each minute as an EMF line under this namespace; none when left out. */
  readonly emfNamespace?: string;
}

export class LatencyReporter {
  private readonly probe = new LatencyProbe();

  constructor(private readonly options: LatencyReporterOptions) {}

  /** A minute (open time in UTC seconds) reached this stage now. */
  reached(symbol: string, stage: LatencyStage, barTime: number): void {
    const now = this.options.nowMs();
    const ms = now - (barTime + 60) * 1000;
    this.probe.record(symbol, stage, ms);
    const namespace = this.options.emfNamespace;
    if (namespace !== undefined) this.options.log(emfLine(namespace, symbol, stage, Math.max(0, ms), now));
  }

  /** Prints the period's figures and starts a new period. */
  report(): void {
    for (const latency of this.probe.summary()) this.options.log(latencyLine(latency));
  }
}
