import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { IndicatorDefinition } from '@aia/indicators';
import { describe, expect, it } from 'vitest';

import { LoadIndicatorsError, indicatorModules, loadIndicators } from './load-indicators.js';

const fake = (id: string): IndicatorDefinition<null> => ({
  id,
  version: '1',
  name: id,
  inputs: [{ kind: 'int', key: 'length', label: 'Length', default: 2, min: 1, max: 10 }],
  outputs: [{ kind: 'line', key: 'value', label: 'Value' }],
  init: () => null,
  step: (state, bar) => ({ state, outputs: { value: bar.close } }),
});

const modules = (map: Record<string, unknown>) => async (path: string) => {
  if (!(path in map)) throw new Error('no such file');
  return map[path];
};

describe('indicatorModules', () => {
  it('splits AIA_INDICATORS on commas and drops blanks', () => {
    expect(indicatorModules({ AIA_INDICATORS: ' a.ts, ,b.ts ' })).toEqual(['a.ts', 'b.ts']);
    expect(indicatorModules({})).toEqual([]);
  });
});

describe('loadIndicators', () => {
  it('registers every indicator from every module, in order', async () => {
    const registry = await loadIndicators(['a', 'b'], modules({ a: { indicators: [fake('one')] }, b: { indicators: [fake('two'), fake('three')] } }));
    expect(registry.list().map((d) => d.id)).toEqual(['one', 'two', 'three']);
  });

  it('no modules, no indicators', async () => {
    expect((await loadIndicators([])).list()).toEqual([]);
  });

  it('stops on a module that cannot be loaded, naming it', async () => {
    await expect(loadIndicators(['missing.ts'], modules({}))).rejects.toThrow(new LoadIndicatorsError('AIA_INDICATORS: cannot load missing.ts: no such file'));
  });

  it('stops on a module without an indicators array', async () => {
    await expect(loadIndicators(['a'], modules({ a: { sma: fake('sma') } }))).rejects.toThrow(/a must export "indicators"/);
  });

  it('stops on an invalid definition or the same id twice', async () => {
    const broken = { ...fake('bad'), inputs: [{ kind: 'int', key: 'length', label: 'L', default: 50, min: 1, max: 10 }] };
    await expect(loadIndicators(['a'], modules({ a: { indicators: [broken] } }))).rejects.toThrow(LoadIndicatorsError);
    await expect(loadIndicators(['a', 'b'], modules({ a: { indicators: [fake('x')] }, b: { indicators: [fake('x')] } }))).rejects.toThrow(/registered twice/);
  });

  it('loads a module from disk, relative to the working directory', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aia-indicators-'));
    const definition = `{ id: 'disk', version: '1', name: 'Disk', inputs: [], outputs: [{ kind: 'line', key: 'v', label: 'V' }], init: () => null, step: (s, b) => ({ state: s, outputs: { v: b.close } }) }`;
    await writeFile(join(folder, 'index.mjs'), `export const indicators = [${definition}];\n`);
    const registry = await loadIndicators([relative(process.cwd(), join(folder, 'index.mjs'))]);
    expect(registry.get('disk')?.name).toBe('Disk');
  });
});
