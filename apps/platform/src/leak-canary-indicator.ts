// A canary for the leak test (M3-08): a test-only indicator whose internals
// carry markers no response, message or browser bundle may ever contain
// (CLAUDE.md rule 5). Never registered by main.ts; the e2e server and the
// server leak test register it.
//
// Its state holds a field and values with unmistakable names, a long-decimal
// constant and a string used only inside `step`. It draws one line at the
// close plus the chosen offset and an internal long-decimal one, which the engine must round to the
// instrument's display precision.

import type { IndicatorDefinition } from '@aia/indicators';

/** Strings and numbers from the canary's internals; finding one outside the engine is a leak. */
export const LEAK_CANARY_MARKERS = ['leakCanaryInternalState', 'leakCanaryRunningTotal', 'LEAK-CANARY-SECRET-7f3a', '271828.18'] as const;

interface CanaryState {
  readonly leakCanaryInternalState: { readonly leakCanaryRunningTotal: number; readonly constant: number; readonly secret: string };
}

export const leakCanary: IndicatorDefinition<CanaryState> = {
  id: 'leakCanary',
  version: '1',
  name: 'Leak canary (tests only)',
  inputs: [{ kind: 'float', key: 'offset', label: 'Offset', default: 0, min: 0, max: 10, step: 0.5 }],
  outputs: [{ kind: 'line', key: 'level', label: 'Level' }],
  init: () => ({ leakCanaryInternalState: { leakCanaryRunningTotal: 0, constant: 271828.182845, secret: 'LEAK-CANARY-SECRET-7f3a' } }),
  step: (state, bar, settings) => {
    const inner = state.leakCanaryInternalState;
    return {
      state: { leakCanaryInternalState: { ...inner, leakCanaryRunningTotal: inner.leakCanaryRunningTotal + bar.close + inner.constant / 1e9 } },
      // An internal long-decimal offset: the drawn value must reach clients rounded.
      outputs: { level: bar.close + (settings['offset'] as number) + 0.123456789 },
    };
  },
};
