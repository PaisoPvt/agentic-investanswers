import { describe, expect, it } from 'vitest';

import type { AcceptanceReport, CheckResult } from './acceptance-report.js';
import { acceptanceMarkdown, overallPassed, verdictOf } from './acceptance-report.js';

describe('acceptance verdicts (M4-06)', () => {
  it('passes only when every command exited 0', () => {
    expect(verdictOf([{ command: 'a', exitCode: 0 }, { command: 'b', exitCode: 0 }])).toBe('pass');
    expect(verdictOf([{ command: 'a', exitCode: 0 }, { command: 'b', exitCode: 1 }])).toBe('fail');
  });

  it('a setup error (exit 2) or a command not run makes the check "not run", unless another failed', () => {
    expect(verdictOf([{ command: 'a', exitCode: 0 }, { command: 'b', exitCode: 2 }])).toBe('not run');
    expect(verdictOf([{ command: 'a', reason: 'no key' }])).toBe('not run');
    expect(verdictOf([{ command: 'a', exitCode: 1 }, { command: 'b', reason: 'no key' }])).toBe('fail');
    expect(verdictOf([])).toBe('not run');
  });
});

describe('acceptance report (M4-06)', () => {
  const check = (id: CheckResult['id'], verdict: CheckResult['verdict']): CheckResult => ({ id, name: `Check ${id}`, proves: `proves ${id}`, verdict, runs: [{ command: `cmd ${id}`, exitCode: verdict === 'pass' ? 0 : 1, seconds: 3, tail: ['line'] }] });
  const report = (verdicts: CheckResult['verdict'][]): AcceptanceReport => ({
    environment: 'local',
    commit: 'abc1234',
    at: '2026-11-21 10:00 UTC',
    checks: verdicts.map((v, i) => check((i + 1) as CheckResult['id'], v)),
    hygiene: [{ command: 'pnpm check', exitCode: 0, seconds: 40 }],
  });

  it('is accepted only when all four checks pass', () => {
    expect(overallPassed(report(['pass', 'pass', 'pass', 'pass']))).toBe(true);
    expect(overallPassed(report(['pass', 'pass', 'pending', 'pass']))).toBe(false);
    expect(overallPassed(report(['pass', 'pass', 'pass']))).toBe(false);
  });

  it('puts the client summary first, then the evidence of each check', () => {
    const md = acceptanceMarkdown({
      ...report(['pass', 'fail', 'pending', 'pass']),
      checks: [
        check(1, 'pass'),
        check(2, 'fail'),
        { id: 3, name: 'Check 3', proves: 'proves 3', verdict: 'pending', runs: [{ command: 'pnpm parity:indicators', reason: 'not built yet (M3-03)' }], note: 'Waiting on OI-30.' },
        check(4, 'pass'),
      ],
    });
    expect(md).toContain('## Result: not yet accepted');
    expect(md).toContain('| 2 | Check 2 | FAIL | proves 2 |');
    expect(md).toContain('| 3 | Check 3 | PENDING | proves 3 |');
    expect(md).toContain('## 3. Check 3: PENDING\n\nWaiting on OI-30.\n\n- `pnpm parity:indicators`: not run (not built yet (M3-03))');
    expect(md).toContain('- `cmd 1`: exit 0 in 3 s\n\n```\nline\n```');
    expect(md).toContain('## Also run (not one of the four)\n\n- `pnpm check`: exit 0 in 40 s');
    expect(md.indexOf('## Result')).toBeLessThan(md.indexOf('## 1. Check 1'));
  });
});
