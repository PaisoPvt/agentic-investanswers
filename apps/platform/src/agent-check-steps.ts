// The agent check (M4-06, the MVP's fourth check): what a real agent does,
// against a running platform, over MCP with an agent key. Each step passes,
// fails, or does not apply (for example, a plan that includes everything has
// nothing to refuse). Used by `pnpm agent-check`; tested against the server.

import type { HistoryResponse, IndicatorOutputsResponse, IndicatorsResponse, InstrumentListing, UsageResponse } from '@aia/client-contract';

export interface AgentCheckStep {
  readonly name: string;
  /** Undefined when the step does not apply to this environment. */
  readonly ok: boolean | undefined;
  readonly detail: string;
}

export interface AgentCheckDeps {
  readonly url: string;
  readonly key: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the usage record to be written (it is batched). */
  readonly usageWaitMs?: number;
}

interface ToolError {
  readonly code?: string;
  readonly message?: string;
  readonly upgradeUrl?: string;
}
type ToolResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ToolError };

export async function runAgentCheck(deps: AgentCheckDeps): Promise<AgentCheckStep[]> {
  const http = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const auth = { authorization: `Bearer ${deps.key}` };
  const steps: AgentCheckStep[] = [];
  const step = (name: string, ok: boolean | undefined, detail: string) => steps.push({ name, ok, detail });

  let id = 0;
  const tool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await http(`${deps.url}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) return { ok: false, error: { code: `http_${res.status}`, message: await res.text() } };
    const body = (await res.json()) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
    if (body.error !== undefined) return { ok: false, error: { code: 'rpc_error', ...(body.error.message === undefined ? {} : { message: body.error.message }) } };
    const text = body.result?.content?.[0]?.text ?? 'null';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (body.result?.isError !== true) return { ok: true, value: parsed };
    return { ok: false, error: (parsed as { error?: ToolError } | null)?.error ?? { message: text } };
  };

  // 1. What is served, and what this key's plan includes.
  const listed = await tool('list_instruments', {});
  const instruments = listed.ok && Array.isArray(listed.value) ? (listed.value as InstrumentListing[]) : [];
  step('list_instruments', instruments.length > 0, listed.ok ? `${instruments.length} instruments` : `refused: ${listed.error.code ?? ''} ${listed.error.message ?? ''}`);
  const plan = await tool('get_plan', {});
  const planId = plan.ok ? (plan.value as { plan?: { id?: string } }).plan?.id : undefined;
  step('get_plan', planId !== undefined, planId === undefined ? 'no plan in the answer' : `plan "${planId}"`);

  // 2. Bars on something the plan includes (1h if it can).
  const target = instruments.find((i) => i.included.length > 0);
  if (target === undefined) {
    step('get_bars', false, 'the plan includes no instrument');
  } else {
    const tf = target.included.includes('1h') ? '1h' : (target.included[0] as string);
    const bars = await tool('get_bars', { instrument: target.symbol, tf, limit: 5 });
    const count = bars.ok ? ((bars.value as HistoryResponse).bars?.length ?? 0) : 0;
    step('get_bars', count > 0, bars.ok ? `${count} ${target.symbol} ${tf} bars` : `refused: ${bars.error.code ?? ''}`);

    // 3. Indicators: listed, and the first one's drawn output.
    const listedIndicators = await tool('list_indicators', {});
    const indicators = listedIndicators.ok ? ((listedIndicators.value as IndicatorsResponse).indicators ?? []) : [];
    step('list_indicators', listedIndicators.ok, listedIndicators.ok ? `${indicators.length} indicators` : `refused: ${listedIndicators.error.code ?? ''}`);
    const first = indicators[0];
    if (first === undefined) {
      step('get_indicator_output', undefined, 'no indicator is registered here');
    } else {
      const output = await tool('get_indicator_output', { indicator: first.id, instrument: target.symbol, tf });
      const points = output.ok ? ((output.value as IndicatorOutputsResponse).points?.length ?? 0) : 0;
      step('get_indicator_output', output.ok && points > 0, output.ok ? `${first.id}: ${points} points` : `refused: ${output.error.code ?? ''} ${output.error.message ?? ''}`);
    }
  }

  // 4. Plan checks apply to agents: something served but not included is refused, with the upgrade link.
  const outside = instruments.flatMap((i) => i.timeframes.filter((tf) => !i.included.includes(tf)).map((tf) => ({ symbol: i.symbol, tf })))[0];
  if (outside === undefined) {
    step('plan refusal', undefined, 'the plan includes everything served, so nothing to refuse');
  } else {
    const refused = await tool('get_bars', { instrument: outside.symbol, tf: outside.tf, limit: 1 });
    const right = !refused.ok && refused.error.code === 'forbidden' && typeof refused.error.upgradeUrl === 'string';
    step('plan refusal', right, refused.ok ? `${outside.symbol} ${outside.tf} was served, not refused` : `${outside.symbol} ${outside.tf}: ${refused.error.code ?? ''}${refused.error.upgradeUrl === undefined ? ', no upgrade link' : ' with upgrade link'}`);
  }

  // 5. Agents are read-only.
  const write = await http(`${deps.url}/auth/agent-keys`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'should be refused' }) });
  const writeCode = write.status === 403 ? ((await write.json()) as { error?: { code?: string } }).error?.code : undefined;
  step('read-only', write.status === 403 && writeCode === 'read_only', `creating an agent key answered ${write.status}${writeCode === undefined ? '' : ` ${writeCode}`}`);

  // 6. Its requests are recorded (M4-04): GET /usage shows the get_bars call.
  const until = Date.now() + (deps.usageWaitMs ?? 5_000);
  let recorded = false;
  let usageStatus = 0;
  for (;;) {
    const res = await http(`${deps.url}/usage?subject=me&limit=50`, { headers: auth });
    usageStatus = res.status;
    if (res.ok) recorded = ((await res.json()) as UsageResponse).records.some((r) => r.route === '/mcp' && r.tool === 'get_bars');
    if (recorded || res.status === 404 || Date.now() >= until) break;
    await sleep(500);
  }
  if (usageStatus === 404) step('usage recorded', undefined, 'GET /usage is not served here (no audit log)');
  else step('usage recorded', recorded, recorded ? 'the get_bars call is in GET /usage' : `not found in GET /usage (status ${usageStatus})`);

  return steps;
}

/** True when nothing failed (steps that do not apply are fine). */
export function agentCheckPassed(steps: readonly AgentCheckStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.ok !== false);
}

export function agentCheckLines(steps: readonly AgentCheckStep[]): string[] {
  return steps.map((s) => `${s.ok === undefined ? 'n/a ' : s.ok ? 'pass' : 'FAIL'}  ${s.name.padEnd(22)} ${s.detail}`);
}
