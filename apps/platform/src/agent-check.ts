// `pnpm agent-check` (M4-06): the MVP's agent check against a running
// platform, over MCP with an agent key, as a real agent would use it.
//
//   AIA_AGENT_KEY=<agent key> pnpm agent-check [--url http://127.0.0.1:8080]
//
// Lists instruments and the plan, reads bars and an indicator's drawn output,
// is refused outside its plan (with the upgrade link) and when it tries to
// write, and finds its own request in GET /usage. Exits 0 when nothing fails,
// 1 when a step fails, 2 on a setup error.

import { agentCheckLines, agentCheckPassed, runAgentCheck } from './agent-check-steps.js';

const args = process.argv.slice(2);
const at = args.indexOf('--url');
const url = (at < 0 ? 'http://127.0.0.1:8080' : (args[at + 1] ?? '')).replace(/\/$/, '');
const key = process.env['AIA_AGENT_KEY'];
if (key === undefined || key === '' || url === '') {
  console.error('Usage: AIA_AGENT_KEY=<agent key> pnpm agent-check [--url URL]');
  process.exit(2);
}

try {
  const steps = await runAgentCheck({ url, key });
  console.log(`Agent check against ${url}`);
  for (const line of agentCheckLines(steps)) console.log(`  ${line}`);
  const passed = agentCheckPassed(steps);
  console.log(passed ? 'Agent check: pass' : 'Agent check: FAIL');
  process.exit(passed ? 0 : 1);
} catch (failure: unknown) {
  console.error(`Cannot run the agent check against ${url}: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(2);
}
