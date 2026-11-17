import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { AgentReadPort, BarsArgs, IndicatorOutputArgs } from '../application/agent-read-port.js';
import { createMcpServer } from './mcp-server.js';

const NO_INDICATORS: Pick<AgentReadPort, 'indicators' | 'indicatorOutput'> = {
  indicators: () => Promise.resolve({ ok: true, value: { indicators: [] } }),
  indicatorOutput: () => Promise.resolve({ ok: false, code: 'not_found', message: 'no indicator' }),
};

const NO_BARS: Pick<AgentReadPort, 'bars' | 'instruments' | 'plan'> = {
  bars: () => Promise.resolve({ ok: true, value: { bars: [], next: null } }),
  instruments: () => Promise.resolve({ ok: true, value: [] }),
  plan: () => Promise.resolve({ ok: true, value: {} }),
};

async function connected(read: AgentReadPort) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(read).connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

describe('createMcpServer', () => {
  it('passes tool arguments to the read port unchanged and returns its value as JSON', async () => {
    const calls: BarsArgs[] = [];
    const client = await connected({
      bars: (args) => {
        calls.push(args);
        return Promise.resolve({ ok: true, value: { bars: [], next: null } });
      },
      instruments: () => Promise.resolve({ ok: true, value: [] }),
      plan: () => Promise.resolve({ ok: true, value: { plan: { id: 'free' } } }),
      ...NO_INDICATORS,
    });
    const result = await client.callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 5 } });
    expect(calls).toEqual([{ instrument: 'BTCUSD', tf: '1h', limit: 5, before: undefined }]);
    expect(result.structuredContent).toEqual({ result: { bars: [], next: null } });
    await client.close();
  });

  it('turns a refusal into a tool error with its code, message and upgrade link', async () => {
    const refusal = { ok: false as const, code: 'forbidden', message: 'no', upgradeUrl: 'https://example.com/up' };
    const client = await connected({
      bars: () => Promise.resolve(refusal),
      instruments: () => Promise.resolve(refusal),
      plan: () => Promise.resolve(refusal),
      indicators: () => Promise.resolve(refusal),
      indicatorOutput: () => Promise.resolve(refusal),
    });
    const result = await client.callTool({ name: 'get_plan', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({
      error: { code: 'forbidden', message: 'no', upgradeUrl: 'https://example.com/up' },
    });
    await client.close();
  });

  it('rejects arguments of the wrong type before reaching the port', async () => {
    let reached = false;
    const client = await connected({
      bars: () => {
        reached = true;
        return Promise.resolve({ ok: true, value: {} });
      },
      instruments: () => Promise.resolve({ ok: true, value: [] }),
      plan: () => Promise.resolve({ ok: true, value: {} }),
      ...NO_INDICATORS,
    });
    const result = await client.callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 'many' } });
    expect(result.isError).toBe(true);
    expect(reached).toBe(false);
    await client.close();
  });

  it('get_indicator_output passes its arguments on, and a settings refusal keeps each field', async () => {
    const calls: IndicatorOutputArgs[] = [];
    const fields = [{ key: 'length', code: 'out_of_range', message: 'must be 1 to 500' }];
    const client = await connected({
      ...NO_BARS,
      ...NO_INDICATORS,
      indicatorOutput: (args) => {
        calls.push(args);
        return Promise.resolve({ ok: false, code: 'invalid_settings', message: 'one setting is not allowed', fields });
      },
    });
    const result = await client.callTool({ name: 'get_indicator_output', arguments: { indicator: 'sma', instrument: 'BTCUSD', tf: '1h', settings: { length: 900 } } });
    expect(calls).toEqual([{ indicator: 'sma', instrument: 'BTCUSD', tf: '1h', settings: { length: 900 }, limit: undefined }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: { code: 'invalid_settings', message: 'one setting is not allowed', fields } });
    await client.close();
  });
});
