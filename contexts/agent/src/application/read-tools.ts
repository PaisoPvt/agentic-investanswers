// The read-only MCP tools (M4-02): names, descriptions and inputs, each one
// a thin call to the AgentReadPort. Indicator outputs (M3-05) are drawn
// outputs only, the same as the chart gets (CLAUDE.md rule 5).

import { z } from 'zod';

import type { AgentReadPort, ReadResult } from './agent-read-port.js';

export interface ReadTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly run: (read: AgentReadPort, args: Record<string, unknown>) => Promise<ReadResult<unknown>>;
}

export const READ_TOOLS: readonly ReadTool[] = [
  {
    name: 'list_instruments',
    title: 'List instruments',
    description:
      'The instruments this platform serves, the timeframes it serves for each, and which pairs your plan includes. Call this first to know what get_bars accepts.',
    inputSchema: {},
    run: (read) => read.instruments(),
  },
  {
    name: 'get_bars',
    title: 'Get bars',
    description:
      'Bars (open, high, low, close, volume) for one instrument and timeframe, oldest first, times in UTC seconds. At most 1,000 per call; pass the returned "next" as "before" for the page before.',
    inputSchema: {
      instrument: z.string().describe('Instrument symbol, for example BTCUSD'),
      tf: z.string().describe('Timeframe: 1m, 5m, 15m, 1h, 4h, 1D, 1W or 1M'),
      limit: z.number().int().optional().describe('How many bars, 1 to 1000; default 500'),
      before: z.number().int().optional().describe('Only bars that open before this UTC second'),
    },
    run: (read, args) =>
      read.bars({
        instrument: args['instrument'] as string,
        tf: args['tf'] as string,
        limit: args['limit'] as number | undefined,
        before: args['before'] as number | undefined,
      }),
  },
  {
    name: 'get_plan',
    title: 'Get plan',
    description: 'Your plan (that of the user who created your agent key): which instruments and timeframes it includes, and where to upgrade.',
    inputSchema: {},
    run: (read) => read.plan(),
  },
  {
    name: 'list_indicators',
    title: 'List indicators',
    description:
      'The indicators you can draw, each with its settings: key, label, default and limits (number settings) or options. Call this first to know what get_indicator_output accepts.',
    inputSchema: {},
    run: (read) => read.indicators(),
  },
  {
    name: 'get_indicator_output',
    title: 'Get indicator output',
    description:
      'What an indicator draws on one instrument and timeframe: its declared outputs (lines, bands, markers, levels), one point per bar, oldest first, times in UTC seconds, prices at display precision. "forming" is the bar still open and changes until it closes. The same plan checks as get_bars.',
    inputSchema: {
      indicator: z.string().describe('Indicator id from list_indicators, for example sma'),
      instrument: z.string().describe('Instrument symbol, for example BTCUSD'),
      tf: z.string().describe('Timeframe: 1m, 5m, 15m, 1h, 4h, 1D, 1W or 1M'),
      settings: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('Settings by key; missing keys take their default'),
      limit: z.number().int().optional().describe('How many closed bars, 1 to 2000; default 500'),
    },
    run: (read, args) =>
      read.indicatorOutput({
        indicator: args['indicator'] as string,
        instrument: args['instrument'] as string,
        tf: args['tf'] as string,
        settings: args['settings'] as Record<string, unknown> | undefined,
        limit: args['limit'] as number | undefined,
      }),
  },
];
