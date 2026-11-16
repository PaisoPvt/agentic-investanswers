// A stand-in indicator for the platform tests and the e2e server (M3-02,
// M3-05): not a real indicator and never registered by main.ts. Real
// indicator source lives in agentic-investanswers-indicators (CLAUDE.md
// rule 5) and is loaded from AIA_INDICATORS.
//
// It declares one input of each kind so the settings dialog and the server
// check can be exercised end to end, and draws a line at the chosen source
// price plus `offset`, so a test can see a setting move it.

import type { IndicatorDefinition } from '@aia/indicators';
import { priceFromSource } from '@aia/indicators';
import type { PriceSource } from '@aia/indicators';

export const settingsDemo: IndicatorDefinition<null> = {
  id: 'settingsDemo',
  version: '2',
  name: 'Settings demo (tests only)',
  inputs: [
    { kind: 'int', key: 'length', label: 'Length', help: 'Bars in the window', default: 20, min: 1, max: 500 },
    { kind: 'float', key: 'offset', label: 'Offset', default: 0, min: 0, max: 10, step: 0.5 },
    { kind: 'bool', key: 'showSignals', label: 'Show signals', default: true },
    { kind: 'choice', key: 'style', label: 'Style', options: ['line', 'steps'], default: 'line' },
    { kind: 'source', key: 'source', label: 'Source', default: 'close' },
  ],
  outputs: [{ kind: 'line', key: 'value', label: 'Value' }],
  init: () => null,
  step: (state, bar, settings) => ({
    state,
    outputs: { value: priceFromSource(bar, settings['source'] as PriceSource) + (settings['offset'] as number) },
  }),
};
