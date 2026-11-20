import { describe, expect, it } from 'vitest';

import { ANONYMOUS, detail, subjectKey } from './usage-record.js';

describe('usage records', () => {
  it('keeps each subject\'s records under its own key', () => {
    expect(subjectKey({ kind: 'human', id: 'acc-1' })).toBe('human#acc-1');
    expect(subjectKey({ kind: 'agent', id: 'key-9' })).toBe('agent#key-9');
    expect(subjectKey(ANONYMOUS)).toBe('anonymous#anonymous');
  });

  it('keeps a detail only when it is a short plain string', () => {
    expect(detail('BTCUSD')).toBe('BTCUSD');
    expect(detail(' 1h ')).toBe('1h');
    expect(detail('get_indicator_output')).toBe('get_indicator_output');
    expect(detail(42)).toBeUndefined();
    expect(detail('')).toBeUndefined();
    expect(detail('x'.repeat(65))).toBeUndefined();
    expect(detail('<script>')).toBeUndefined();
    expect(detail('a b')).toBeUndefined();
  });
});
