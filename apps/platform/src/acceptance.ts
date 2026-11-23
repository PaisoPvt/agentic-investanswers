// `pnpm acceptance` (M4-06): the MVP's four checks in one command, and the
// sign-off report. Each check is its own command, run as a separate process;
// this only collects what they did (acceptance-report.ts decides the verdicts).
//
//   AIA_AGENT_KEY=<agent key> pnpm acceptance [--url http://127.0.0.1:8080] [--env local] [--skip-local] [--freshness-minutes 3]
//
// 1. Bar parity: `pnpm parity --build` and `pnpm rebuild-check` (the stores
//    as configured: the local MinIO by default).
// 2. Freshness: `pnpm freshness --url <url>` with the agent key.
// 3. Indicator and backtest parity: `pnpm parity:indicators` once M3-03 adds
//    it; pending (OI-30) until then.
// 4. Agents: `pnpm agent-check --url <url>` and the server leak test.
// Also, unless --skip-local: `pnpm check` and `pnpm e2e`.
//
// Writes reports/acceptance/<time>-<env>.md and .json. Exits 0 only when all
// four checks pass, 1 otherwise, 2 on bad arguments.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { AcceptanceReport, CheckResult, CommandRun } from './acceptance-report.js';
import { acceptanceMarkdown, overallPassed, verdictOf } from './acceptance-report.js';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : (args[at + 1] ?? fallback);
};
const url = value('url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const environment = value('env', new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost' ? 'local' : new URL(url).hostname);
const minutes = value('freshness-minutes', '3');
const skipLocal = args.includes('--skip-local');
const key = process.env['AIA_AGENT_KEY'];
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

/** Runs `pnpm -s <args>` and keeps the exit code, the time and the last lines (never the key). */
function run(label: string, pnpmArgs: readonly string[], env: NodeJS.ProcessEnv = {}): CommandRun {
  const started = Date.now();
  console.log(`… ${label}`);
  const result = spawnSync('pnpm', ['-s', ...pnpmArgs], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((l) => l.trim() !== '');
  const tail = output.slice(-15).map((l) => (key === undefined ? l : l.split(key).join('<agent key>')));
  const exitCode = result.status ?? 2;
  console.log(`  exit ${exitCode}`);
  return { command: label, exitCode, seconds: (Date.now() - started) / 1000, tail };
}

const notRun = (command: string, reason: string): CommandRun => ({ command, reason });
const check = (id: CheckResult['id'], name: string, proves: string, runs: CommandRun[], note?: string): CheckResult => ({
  id,
  name,
  proves,
  verdict: verdictOf(runs),
  runs,
  ...(note === undefined ? {} : { note }),
});

console.log(`Acceptance: ${environment} (${url})${skipLocal ? ', environment checks only' : ''}`);
const checks: CheckResult[] = [];

checks.push(
  check(1, 'Bar parity', 'Every timeframe we build from 1-minute bars equals TradingView, and cooked bars are rebuilt exactly from raw.', [
    run('pnpm parity --build', ['parity', '--build']),
    run('pnpm rebuild-check', ['rebuild-check']),
  ]),
);

checks.push(
  check(
    2,
    'Freshness',
    'A closed minute reaches storage, the History API and an open chart within the agreed delay.',
    key === undefined
      ? [notRun(`pnpm freshness --url ${url}`, 'set AIA_AGENT_KEY to an agent key for this environment')]
      : [run(`pnpm freshness --url ${url} --minutes ${minutes}`, ['freshness', '--url', url, '--minutes', minutes], { AIA_FRESHNESS_KEY: key })],
  ),
);

const indicatorParity: CheckResult =
  scripts['parity:indicators'] === undefined
    ? {
        id: 3,
        name: 'Indicator and backtest parity',
        proves: 'The SMA demo indicator and its backtest match TradingView exactly.',
        verdict: 'pending',
        runs: [notRun('pnpm parity:indicators', 'not built yet (M3-03)')],
        note: 'Waiting on OI-30: the TradingView exports of the SMA demo strategy. The harness (M3-03) is built once they arrive.',
      }
    : (() => {
        const ran = run('pnpm parity:indicators', ['parity:indicators']);
        const proves = 'The SMA demo indicator and its backtest match TradingView exactly.';
        // Exit 2 naming OI-30: the exports are not on this machine yet, so the check is waiting, not broken.
        if (ran.exitCode === 2 && (ran.tail ?? []).some((l) => l.includes('OI-30'))) {
          return { id: 3, name: 'Indicator and backtest parity', proves, verdict: 'pending', runs: [ran], note: 'Waiting on OI-30: the TradingView exports of the SMA demo strategy (docs/bar-rules.md, "Indicator parity").' } satisfies CheckResult;
        }
        return check(3, 'Indicator and backtest parity', proves, [ran]);
      })();
checks.push(indicatorParity);

checks.push(
  check(4, 'Agents', 'An agent reads bars and indicator output through MCP, within its plan, read-only, recorded, and no indicator internals leave the server.', [
    key === undefined ? notRun(`pnpm agent-check --url ${url}`, 'set AIA_AGENT_KEY to an agent key for this environment') : run(`pnpm agent-check --url ${url}`, ['agent-check', '--url', url], { AIA_AGENT_KEY: key }),
    run('leak test (server)', ['--filter', '@aia/app-platform', 'exec', 'vitest', 'run', 'src/leak.test.ts']),
  ]),
);

const hygiene = skipLocal ? [] : [run('pnpm check', ['check']), run('pnpm e2e', ['e2e'])];

const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';
const report: AcceptanceReport = { environment, commit, at: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, checks, hygiene };
const markdown = acceptanceMarkdown(report);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = `reports/acceptance/${stamp}-${environment.replace(/[^\w.-]/g, '_')}`;
mkdirSync('reports/acceptance', { recursive: true });
writeFileSync(`${base}.md`, markdown);
writeFileSync(`${base}.json`, JSON.stringify({ ...report, passed: overallPassed(report) }, null, 2));
console.log(`\n${markdown}\nReport: ${base}.md`);
process.exit(overallPassed(report) ? 0 : 1);
