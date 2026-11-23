// M3-03: `pnpm parity:indicators` end to end, as a separate process. A
// test-only stand-in indicator (not the SMA, which lives in the private
// repository) is loaded through AIA_INDICATORS like the real one, and the
// three exports are written in TradingView's format from a known run: exact
// passes (exit 0), one plotted value changed fails at its bar (exit 1), and
// missing exports say so (exit 2).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const H = 3_600;
const T0 = 1_767_225_600; // 2026-01-01 00:00 UTC

/** The stand-in: draws "Level" at each close; enters long on an up bar after a down bar, short on the reverse. */
const STAND_IN = `export const indicators = [{
  id: 'crossDemo',
  version: '1',
  name: 'Cross demo (tests only)',
  inputs: [],
  outputs: [
    { kind: 'line', key: 'level', label: 'Level' },
    { kind: 'marker', key: 'long', label: 'Long' },
    { kind: 'marker', key: 'short', label: 'Short' },
  ],
  init: () => ({ previousUp: null }),
  step: (state, bar) => {
    const up = bar.close > bar.open;
    const turned = state.previousUp !== null && up !== state.previousUp;
    return {
      state: { previousUp: up },
      outputs: {
        level: bar.close,
        long: turned && up ? { side: 'below', price: bar.low, text: 'Long' } : null,
        short: turned && !up ? { side: 'above', price: bar.high, text: 'Short' } : null,
      },
    };
  },
}];
`;

// Bars: up, up, down (short), down, up (long), down (short), up, and a last one still forming.
const BARS = [
  [100, 102, 99, 101],
  [101, 104, 100, 103],
  [103, 104, 99, 100],
  [100, 101, 97, 98],
  [98, 103, 97, 102],
  [102, 103, 98, 99],
  [99, 105, 98, 104],
  [104, 106, 103, 105],
];
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

function writeExports(dir: string, levelAt3 = 98): void {
  const rows = BARS.map(([o, h, l, c], i) => `${T0 + i * H},${o},${h},${l},${c},${i === 3 ? levelAt3 : c},1`);
  writeFileSync(join(dir, 'btcusd_1h_crossdemo.csv'), `time,open,high,low,close,Level,Volume\n${rows.join('\n')}\n`);
  // Short signalled on bar 2 fills at bar 3's open (100); long on bar 4 fills at bar 5's open (102), closing the short (-2);
  // short on bar 5 fills at bar 6's open (99), closing the long (-3); still open at the end.
  writeFileSync(
    join(dir, 'btcusd_1h_crossdemo_trades.csv'),
    `Trade #,Type,Signal,Date/Time,Price USD,Contracts,Profit USD
1,Exit short,Long,${iso(T0 + 5 * H)},102,1,-2.00
1,Entry short,Short,${iso(T0 + 3 * H)},100,1,-2.00
2,Exit long,Short,${iso(T0 + 6 * H)},99,1,-3.00
2,Entry long,Long,${iso(T0 + 5 * H)},102,1,-3.00
3,Exit short,Open,${iso(T0 + 7 * H)},104,1,-5.00
3,Entry short,Short,${iso(T0 + 6 * H)},99,1,-5.00
`,
  );
  writeFileSync(
    join(dir, 'btcusd_1h_crossdemo_summary.csv'),
    `,All USD,All %
Net Profit,-5.00,0.00
Gross Profit,0.00,0.00
Gross Loss,5.00,0.00
Total Closed Trades,2,
Number Winning Trades,0,
Number Losing Trades,2,
Percent Profitable,0.00,
Avg Trade,-2.50,0.00
`,
  );
}

function run(dir: string) {
  const work = mkdtempSync(join(tmpdir(), 'aia-parity-ind-'));
  const module = join(work, 'stand-in.mjs');
  writeFileSync(module, STAND_IN);
  const result = spawnSync('pnpm', ['exec', 'tsx', 'src/parity-indicators.ts', '--indicator', 'crossDemo', '--fixtures', dir], {
    env: { ...process.env, AIA_INDICATORS: module },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('pnpm parity:indicators (M3-03)', () => {
  it('passes when every check is exact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aia-exports-'));
    writeExports(dir);
    const { status, output } = run(dir);
    expect(output).toContain('INDICATOR PARITY OK: all four checks exact.');
    expect(status).toBe(0);
  }, 60_000);

  it('fails at the bar where a plotted value differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aia-exports-'));
    writeExports(dir, 98.01);
    const { status, output } = run(dir);
    expect(output).toContain('first: Level at 2026-01-01 03:00: TradingView 98.01, ours 98');
    expect(status).toBe(1);
  }, 60_000);

  it('says which exports are missing', () => {
    const { status, output } = run(mkdtempSync(join(tmpdir(), 'aia-empty-')));
    expect(output).toContain('Missing TradingView exports (OI-30)');
    expect(status).toBe(2);
  }, 60_000);
});
