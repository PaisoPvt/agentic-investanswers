// The acceptance report (M4-06): the MVP's four checks, each pass, fail,
// pending (its command does not exist yet, waiting on an owner input) or not
// run (a setting is missing, or the environment cannot be reached), with the
// evidence. Pure: the runner (acceptance.ts) hands in what each command did.

export type Verdict = 'pass' | 'fail' | 'pending' | 'not run';

/** One command the runner ran, or could not run. */
export interface CommandRun {
  readonly command: string;
  /** Undefined when the command was not run (see `reason`). */
  readonly exitCode?: number;
  readonly seconds?: number;
  /** The last lines it printed. */
  readonly tail?: readonly string[];
  readonly reason?: string;
}

export interface CheckResult {
  readonly id: 1 | 2 | 3 | 4;
  readonly name: string;
  /** What passing proves, in the client's words. */
  readonly proves: string;
  readonly verdict: Verdict;
  readonly runs: readonly CommandRun[];
  readonly note?: string;
}

/**
 * A check's verdict from its commands: pass only when every one exited 0; a
 * command that exited 2 (a setup error, by this repo's convention) or was not
 * run makes it "not run"; any other non-zero exit is a failure.
 */
export function verdictOf(runs: readonly CommandRun[]): Verdict {
  if (runs.length === 0) return 'not run';
  if (runs.some((r) => r.exitCode !== undefined && r.exitCode !== 0 && r.exitCode !== 2)) return 'fail';
  if (runs.some((r) => r.exitCode === undefined || r.exitCode === 2)) return 'not run';
  return 'pass';
}

export interface AcceptanceReport {
  readonly environment: string;
  readonly commit: string;
  readonly at: string;
  readonly checks: readonly CheckResult[];
  /** Also run, not one of the four: `pnpm check`, `pnpm e2e`. */
  readonly hygiene: readonly CommandRun[];
}

export function overallPassed(report: Pick<AcceptanceReport, 'checks'>): boolean {
  return report.checks.length === 4 && report.checks.every((c) => c.verdict === 'pass');
}

const MARK: Readonly<Record<Verdict, string>> = { pass: 'PASS', fail: 'FAIL', pending: 'PENDING', 'not run': 'NOT RUN' };

function runLine(run: CommandRun): string {
  if (run.exitCode === undefined) return `- \`${run.command}\`: not run (${run.reason ?? 'no reason given'})`;
  return `- \`${run.command}\`: exit ${run.exitCode}${run.seconds === undefined ? '' : ` in ${run.seconds.toFixed(0)} s`}`;
}

/** The sign-off report as Markdown: a summary for the client on top, the evidence below. */
export function acceptanceMarkdown(report: AcceptanceReport): string {
  const passed = overallPassed(report);
  const lines = [
    '# MVP acceptance report',
    '',
    `Environment: ${report.environment} · commit \`${report.commit}\` · ${report.at}`,
    '',
    `## Result: ${passed ? 'all four checks pass' : 'not yet accepted'}`,
    '',
    '| # | Check | Result | What it proves |',
    '|---|---|---|---|',
    ...report.checks.map((c) => `| ${c.id} | ${c.name} | ${MARK[c.verdict]} | ${c.proves} |`),
    '',
  ];
  for (const c of report.checks) {
    lines.push(`## ${c.id}. ${c.name}: ${MARK[c.verdict]}`, '');
    if (c.note !== undefined) lines.push(c.note, '');
    for (const run of c.runs) {
      lines.push(runLine(run));
      if (run.tail !== undefined && run.tail.length > 0) lines.push('', '```', ...run.tail, '```', '');
    }
    lines.push('');
  }
  if (report.hygiene.length > 0) {
    lines.push('## Also run (not one of the four)', '', ...report.hygiene.map(runLine), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
