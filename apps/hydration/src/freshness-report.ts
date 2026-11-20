// The freshness report (M2-07): per instrument and step, how long after each
// minute closed it was in storage, in the History API (cache first) and on an
// open chart, against p95 thresholds. Pure.

import { percentile } from '@aia/hydration';

export type FreshnessStep = 'storage' | 'cache' | 'chart';
export const FRESHNESS_STEPS: readonly FreshnessStep[] = ['storage', 'cache', 'chart'];

/** One minute at one step: milliseconds after its close, or undefined if it never arrived while watched. */
export interface Observation {
  readonly symbol: string;
  /** The minute's open time, UTC seconds. */
  readonly minute: number;
  readonly step: FreshnessStep;
  readonly ms: number | undefined;
}

/** p95 per step, in seconds (config/freshness.json). */
export type Thresholds = Readonly<Record<FreshnessStep, number>>;

export interface ReportRow {
  readonly symbol: string;
  readonly step: FreshnessStep;
  readonly count: number;
  readonly missing: number;
  readonly p50?: number;
  readonly p95?: number;
  readonly max?: number;
  readonly thresholdMs: number;
  /** Undefined when the step was not measured at all. */
  readonly pass: boolean | undefined;
}

export interface FreshnessReport {
  readonly rows: readonly ReportRow[];
  readonly pass: boolean;
}

export function freshnessReport(observations: readonly Observation[], thresholds: Thresholds): FreshnessReport {
  const symbols = [...new Set(observations.map((o) => o.symbol))].sort();
  const rows: ReportRow[] = [];
  for (const symbol of symbols) {
    for (const step of FRESHNESS_STEPS) {
      const mine = observations.filter((o) => o.symbol === symbol && o.step === step);
      const thresholdMs = thresholds[step] * 1000;
      if (mine.length === 0) {
        rows.push({ symbol, step, count: 0, missing: 0, thresholdMs, pass: undefined });
        continue;
      }
      const arrived = mine.flatMap((o) => (o.ms === undefined ? [] : [o.ms])).sort((a, b) => a - b);
      const missing = mine.length - arrived.length;
      if (arrived.length === 0) {
        rows.push({ symbol, step, count: 0, missing, thresholdMs, pass: false });
        continue;
      }
      const p95 = percentile(arrived, 95);
      rows.push({
        symbol,
        step,
        count: arrived.length,
        missing,
        p50: percentile(arrived, 50),
        p95,
        max: arrived[arrived.length - 1] as number,
        thresholdMs,
        pass: missing === 0 && p95 <= thresholdMs,
      });
    }
  }
  return { rows, pass: rows.every((r) => r.pass !== false) };
}

const s = (ms: number | undefined) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);
const verdict = (pass: boolean | undefined) => (pass === undefined ? 'not measured' : pass ? 'pass' : 'FAIL');

/** The report as a Markdown table (also readable in a terminal). */
export function reportMarkdown(report: FreshnessReport, heading: string): string {
  const lines = [
    `# ${heading}`,
    '',
    `Overall: **${report.pass ? 'pass' : 'FAIL'}**`,
    '',
    '| Instrument | Step | Minutes | Missing | p50 | p95 | Max | Threshold (p95) | Result |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.rows.map((r) => `| ${r.symbol} | ${r.step} | ${r.count} | ${r.missing} | ${s(r.p50)} | ${s(r.p95)} | ${s(r.max)} | ${s(r.thresholdMs)} | ${verdict(r.pass)} |`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Reads and checks config/freshness.json's thresholds. */
export function parseThresholds(value: unknown): Thresholds {
  const p95 = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['p95Seconds'] : undefined;
  const out: Partial<Record<FreshnessStep, number>> = {};
  for (const step of FRESHNESS_STEPS) {
    const n = typeof p95 === 'object' && p95 !== null ? (p95 as Record<string, unknown>)[step] : undefined;
    if (typeof n !== 'number' || !(n > 0)) throw new Error(`config/freshness.json: p95Seconds.${step} must be a positive number of seconds`);
    out[step] = n;
  }
  return out as Thresholds;
}
