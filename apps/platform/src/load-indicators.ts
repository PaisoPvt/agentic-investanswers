// Which indicators the platform runs (M3-05). Indicator source never lives in
// this repo (CLAUDE.md rule 5): it is loaded at start-up from the modules
// named in AIA_INDICATORS (paths, comma-separated, relative to the working
// directory), each exporting `indicators`, an array of IndicatorDefinition.
// Locally: AIA_INDICATORS=../agentic-investanswers-indicators/src/index.ts
//
// Without AIA_INDICATORS no indicator is registered. A module that cannot be
// loaded, or exports something else, stops start-up: the registry checks
// every definition (assertValidDefinition), so a drift between the private
// repo's copy of the interface and ours fails here, not on a chart.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { IndicatorDefinition } from '@aia/indicators';
import { IndicatorRegistry } from '@aia/indicators';

export class LoadIndicatorsError extends Error {}

/** The module paths in AIA_INDICATORS, in order. */
export function indicatorModules(env: NodeJS.ProcessEnv): string[] {
  return (env['AIA_INDICATORS'] ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

type Importer = (specifier: string) => Promise<unknown>;

const importFile: Importer = (path) => import(pathToFileURL(resolve(path)).href);

/** Imports each module and registers every indicator it exports. */
export async function loadIndicators(paths: readonly string[], load: Importer = importFile): Promise<IndicatorRegistry> {
  const definitions: IndicatorDefinition<unknown>[] = [];
  for (const path of paths) {
    let loaded: unknown;
    try {
      loaded = await load(path);
    } catch (error) {
      throw new LoadIndicatorsError(`AIA_INDICATORS: cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const exported = typeof loaded === 'object' && loaded !== null ? (loaded as Record<string, unknown>)['indicators'] : undefined;
    if (!Array.isArray(exported)) throw new LoadIndicatorsError(`AIA_INDICATORS: ${path} must export "indicators", an array of indicator definitions`);
    definitions.push(...(exported as IndicatorDefinition<unknown>[]));
  }
  try {
    return new IndicatorRegistry(definitions);
  } catch (error) {
    throw new LoadIndicatorsError(`AIA_INDICATORS: ${error instanceof Error ? error.message : String(error)}`);
  }
}
